// SL-009 design sec-7, DEC-075: malebolge-bridge send [--turn] | tee [--turn].
// One post-once per run, never retried. Node-only, erasable TypeScript, no
// pi packages: the jail's node runs it outside pi.
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type LineConnection, openConnection } from "./connection.ts";
import {
  type Ends,
  type NotifyDesktop,
  OUTAGE_SUMMARY,
  outageText,
  unknownText,
} from "./notices.ts";
import {
  BRIDGE_BODY_MAX_BYTES,
  BRIDGE_POST_WAIT_MS,
  bridgeSocketPath,
  capHeadTail,
  type MessageKind,
  type PostOnceFrame,
} from "./wire.ts";

/** Exit statuses (design sec-7). */
export const EXIT = { accepted: 0, connectFailure: 1, refused: 2, unknown: 3 } as const;

export interface CommandIo {
  argv: readonly string[];
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  notifyDesktop: NotifyDesktop;
}

/** What the command was asked to do: the verb, and whether the post asks for a turn. */
interface Invocation {
  readonly mode: "send" | "tee";
  readonly kind: MessageKind;
}

/** The one usage line, on stderr: the command names itself and nothing more. */
const USAGE = "usage: malebolge-bridge send [--turn] | tee [--turn]";

/** `argv` as a verb and a kind, or undefined when it is not an accepted run. */
function invocationOf(argv: readonly string[]): Invocation | undefined {
  const [mode, flag, ...extra] = argv;
  if ((mode !== "send" && mode !== "tee") || extra.length > 0) {
    return undefined;
  }
  if (flag !== undefined && flag !== "--turn") {
    return undefined;
  }
  return { mode, kind: flag === "--turn" ? "turn" : "note" };
}

/** `error`'s message, whatever was thrown: a reason is always a string. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The socket path, or why it cannot be known: `bridgeSocketPath` may throw. */
type SocketTarget =
  | { readonly known: true; readonly path: string }
  | {
      readonly known: false;
      readonly reason: string;
    };

/** `env`'s bridge socket, keeping a throw as the outage it is rather than the path. */
function socketTarget(env: Readonly<Record<string, string | undefined>>): SocketTarget {
  try {
    return { known: true, path: bridgeSocketPath(env) };
  } catch (error) {
    return { known: false, reason: reasonOf(error) };
  }
}

/** All of stdin as one string, and with `tee`, each chunk on stdout as it arrives. */
async function readStdin(io: CommandIo, mode: "send" | "tee"): Promise<string> {
  const decoder = new StringDecoder("utf8");
  let text = "";
  for await (const chunk of io.stdin) {
    const part = typeof chunk === "string" ? chunk : decoder.write(chunk);
    text += part;
    if (mode === "tee") {
      io.stdout.write(part);
    }
  }
  const last = decoder.end();
  if (last !== "") {
    text += last;
    if (mode === "tee") {
      io.stdout.write(last);
    }
  }
  return text;
}

/** One post-once, one reply: the run's exit status. */
function postOnce(
  io: CommandIo,
  path: string,
  frame: PostOnceFrame,
  ends: Ends,
  mode: "send" | "tee",
): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    // The connection lives in a holder so `finish` can close it and the one
    // synchronous throw `openConnection` could make still reports an outage.
    const link: { connection?: LineConnection } = {};

    /** The one outcome of the run: clear the deadline, close the socket, report `status`. */
    function finish(status: number): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      link.connection?.close();
      resolve(status);
    }

    /** Put `line` on stderr and exit `status`. */
    const fail = (status: number, line: string): void => {
      io.stderr.write(`${line}\n`);
      finish(status);
    };

    /** A connection that never got out of the process is the loudest failure: the operator is told. */
    const outage = (reason: string): void => {
      const text = outageText(ends, reason);
      io.notifyDesktop(OUTAGE_SUMMARY, text);
      fail(EXIT.connectFailure, text);
    };

    const timer = setTimeout(() => {
      fail(EXIT.unknown, unknownText(ends));
    }, BRIDGE_POST_WAIT_MS);

    try {
      link.connection = openConnection(path, frame, {
        onFrame: (reply) => {
          switch (reply.type) {
            case "accepted":
              if (mode === "send") {
                io.stdout.write("accepted\n");
              }
              finish(EXIT.accepted);
              return;
            case "refused":
              fail(EXIT.refused, reply.reason);
              return;
            // Neither answers a post-once: the real reply is still to come.
            case "paired":
            case "deliver":
              return;
          }
        },
        onClose: (reason, connected) => {
          if (connected) {
            fail(EXIT.unknown, unknownText(ends));
            return;
          }
          outage(reason);
        },
      });
    } catch (error) {
      outage(reasonOf(error));
    }
  });
}

/** Run one command; resolves the exit status. */
export async function runCommand(io: CommandIo): Promise<number> {
  const invocation = invocationOf(io.argv);
  if (invocation === undefined) {
    io.stderr.write(`${USAGE}\n`);
    return EXIT.refused;
  }
  const conversation = io.env["MALEBOLGE_BRIDGE_CONVERSATION"];
  const token = io.env["MALEBOLGE_BRIDGE_TOKEN"];
  if (conversation === undefined || conversation === "" || token === undefined || token === "") {
    io.stderr.write("not paired: run /bridge pair delegate or /bridge pair consult in pi first\n");
    return EXIT.refused;
  }
  const target = socketTarget(io.env);
  const ends: Ends = {
    project: basename(io.cwd),
    conversation,
    socket: target.known ? target.path : "unknown",
  };
  if (!target.known) {
    const text = outageText(ends, target.reason);
    io.notifyDesktop(OUTAGE_SUMMARY, text);
    io.stderr.write(`${text}\n`);
    return EXIT.connectFailure;
  }
  const text = capHeadTail(await readStdin(io, invocation.mode), BRIDGE_BODY_MAX_BYTES);
  const frame: PostOnceFrame = {
    type: "post-once",
    conversation,
    token,
    kind: invocation.kind,
    text,
  };
  return postOnce(io, target.path, frame, ends, invocation.mode);
}
