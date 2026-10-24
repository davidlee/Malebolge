// The command line: what malebolge-attach was asked to do, and what it refuses
// before any socket exists. Parsing only: no connection, no resolution.

import { parseArgs } from "node:util";
import { messageOf } from "./message-of.ts";
import type { AttachTarget } from "./protocol.ts";
import type { Presentation } from "./render.ts";
import type { ConnectWait } from "./unix-socket.ts";

/** A refused command line: `attach-main` prints the usage and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The flags as parsed, before their combination is checked. */
interface AttachArgs {
  conversation?: string;
  cwd?: string;
  isNew: boolean;
  emacs: boolean;
  list: boolean;
}

/** `parseArgs`, strict, with every one of its throws turned into a `UsageError`. */
function parseAttachArgs(args: string[]): AttachArgs {
  try {
    const { values } = parseArgs({
      args,
      options: {
        conversation: { type: "string" },
        new: { type: "boolean" },
        cwd: { type: "string" },
        emacs: { type: "boolean" },
        list: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    const parsed: AttachArgs = {
      isNew: values.new === true,
      emacs: values.emacs === true,
      list: values.list === true,
    };
    if (values.conversation !== undefined) {
      parsed.conversation = values.conversation;
    }
    if (values.cwd !== undefined) {
      parsed.cwd = values.cwd;
    }
    return parsed;
  } catch (error) {
    throw new UsageError(messageOf(error));
  }
}

/** The id `--conversation` names: digits only, no leading zeros, safe. */
function conversationOf(text: string): number {
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new UsageError("conversation must be a positive integer");
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id)) {
    throw new UsageError("conversation must be a positive integer");
  }
  return id;
}

/** How a client reads its input: typed lines, or one private JSON frame per line. */
export type InputMode = "lines" | "frames";

/** A parsed command line that attaches: where to attach, and how to read input and print. */
export interface AttachCommand {
  /** Absent: the untagged arm of `AttachInvocation`, so the shipped shapes parse unchanged. */
  mode?: undefined;
  target: AttachTarget;
  inputMode: InputMode;
  presentation: Presentation;
}

/** A listing: one `list` frame, and how long to wait for its reply (DEC-008). */
export interface ListInvocation {
  mode: "list";
  wait: ConnectWait;
}

/** What a command line asks for: attach to a target, or read the store's ids. */
export type AttachInvocation = AttachCommand | ListInvocation;

/** `--list` answers a question about the store, so it takes no attach flag. */
function checkListAlone({ conversation, cwd, isNew, emacs }: AttachArgs): void {
  const flags: readonly [boolean, string][] = [
    [conversation !== undefined, "conversation"],
    [isNew, "new"],
    [cwd !== undefined, "cwd"],
    [emacs, "emacs"],
  ];
  const other = flags.find(([given]) => given)?.[1];
  if (other !== undefined) {
    throw new UsageError(`list and ${other} are exclusive`);
  }
}

/** The target the parsed flags name; every refusal is a `UsageError`. */
function targetFrom({ conversation, cwd, isNew }: AttachArgs): AttachTarget {
  if (isNew) {
    if (conversation !== undefined) {
      throw new UsageError("conversation and new are exclusive");
    }
    return cwd === undefined ? { kind: "new" } : { kind: "new", cwd };
  }
  if (cwd !== undefined) {
    throw new UsageError("cwd needs new");
  }
  return conversation === undefined
    ? { kind: "root" }
    : { kind: "existing", id: conversationOf(conversation) };
}

/** The conversation the command line names; every refusal is a `UsageError`. */
export function attachTargetOf(args: string[]): AttachTarget {
  const invocation = attachInvocationOf(args);
  if (invocation.mode === "list") {
    throw new UsageError("list names no attach target");
  }
  return invocation.target;
}

/** The one parse of a command line: a listing, or the target it attaches to. */
export function attachInvocationOf(args: string[]): AttachInvocation {
  const parsed = parseAttachArgs(args);
  if (!parsed.list) {
    const target = targetFrom(parsed);
    return parsed.emacs
      ? { target, inputMode: "frames", presentation: "emacs" }
      : { target, inputMode: "lines", presentation: "terminal" };
  }
  checkListAlone(parsed);
  return { mode: "list", wait: LIST_WAIT };
}

/** A listing runs against a daemon that is already up, and Emacs calls it synchronously. */
const LIST_WAIT: ConnectWait = { intervalMs: 200, timeoutMs: 1_000 };
