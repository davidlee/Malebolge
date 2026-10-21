// A line-oriented client of the daemon: typed lines become messages, events
// become text. Used directly in a terminal and under Emacs comint.

import type { Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { messageOf } from "./message-of.ts";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import type { AttachTarget, ClientMessage, ErrorMessage } from "./protocol.ts";
import { createRenderer, type Printable, toPrintable } from "./render.ts";
import { type ConnectWait, codeOf, connectUnixWaiting } from "./unix-socket.ts";

/** A refused command line: `attach-main` prints the usage and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A connection the daemon never confirmed as attached; `attach-main` exits 1. */
export class NotAttachedError extends Error {
  readonly code = "NOT_ATTACHED";

  constructor(message: string) {
    super(message);
    this.name = "NotAttachedError";
  }
}

/** The flags as parsed, before their combination is checked. */
interface AttachArgs {
  conversation?: string;
  cwd?: string;
  isNew: boolean;
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
      },
      strict: true,
      allowPositionals: false,
    });
    const parsed: AttachArgs = { isNew: values.new === true };
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

/** The conversation the command line names; every refusal is a `UsageError`. */
export function attachTargetOf(args: string[]): AttachTarget {
  const { conversation, cwd, isNew } = parseAttachArgs(args);
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

/** What a typed line asks for; `undefined` for a blank line. */
export function commandOf(typed: string): ClientMessage | "quit" | undefined {
  const text = typed.trim();
  if (text === "") {
    return undefined;
  }
  if (text === "/quit") {
    return "quit";
  }
  if (text === "/abort") {
    return { type: "abort" };
  }
  if (text === "/compact") {
    return { type: "compact" };
  }
  if (text.startsWith("/compact ")) {
    return { type: "compact", instructions: text.slice("/compact ".length).trim() };
  }
  return { type: "input", content: typed };
}

/** The target the client attaches to and how long to wait for the daemon. */
export interface AttachOptions {
  target?: AttachTarget;
  wait?: ConnectWait;
}

const ROOT: AttachTarget = { kind: "root" };
const DEFAULT_WAIT: ConnectWait = { intervalMs: 200, timeoutMs: 10_000 };
const CLOSED_BEFORE_ATTACH = "the daemon closed before attach completed";
const SKEW = 'unknown message type "attach"';
const SKEW_HINT = "the daemon predates attach: restart it (malebolge-stop, then malebolge-start)";

/** The first line's frame: the conversation this connection asks for. */
function frameOf(target: AttachTarget): unknown {
  switch (target.kind) {
    case "root":
      return { type: "attach" };
    case "existing":
      return { type: "attach", conversation: target.id };
    case "new":
      return target.cwd === undefined
        ? { type: "attach", new: true }
        : { type: "attach", new: true, cwd: target.cwd };
  }
}

/** One connection's state: the socket, what to print, and what the next line may do. */
interface AttachState {
  socket: Socket;
  output: Writable;
  render: (event: Printable) => string;
  attached: boolean;
  leaving: boolean;
  failure?: NotAttachedError;
  held: string[];
  resolve: (value: undefined) => void;
  reject: (error: Error) => void;
}

/** Connect, or say on `output` why not and rethrow the connect error. */
async function connectOrExplain(
  socketPath: string,
  output: Writable,
  wait: ConnectWait,
): Promise<Socket> {
  try {
    return await connectUnixWaiting(socketPath, wait);
  } catch (error) {
    const cause = String(codeOf(error) ?? error);
    output.write(`[cannot connect to ${socketPath}: ${cause}]\n`);
    throw error;
  }
}

/** Send the lines the user typed before the daemon confirmed the attach. */
function flushHeld(state: AttachState): void {
  for (const line of state.held) {
    state.socket.write(line);
  }
  state.held = [];
}

/** The daemon refused or failed the attach: show it, drop held lines, and leave. */
function failBeforeAttach(state: AttachState, event: ErrorMessage): void {
  state.output.write(state.render(event));
  if (event.message === SKEW) {
    state.output.write(`[${SKEW_HINT}]\n`);
  }
  state.failure = new NotAttachedError(event.message);
  state.held = [];
  state.socket.end();
}

/** Print an event as it arrives; only `attached` starts the held lines flowing. */
function handleEvent(state: AttachState, event: Printable): void {
  if (state.failure !== undefined) {
    return;
  }
  if (!state.attached && event.type === "error") {
    failBeforeAttach(state, event);
    return;
  }
  state.output.write(state.render(event));
  if (event.type === "attached") {
    state.attached = true;
    flushHeld(state);
  }
}

/** The user is leaving: end the connection, which finishes normally. */
function leave(state: AttachState): void {
  state.leaving = true;
  state.socket.end();
}

/** One typed line: `/quit` leaves, a blank line is ignored, the rest is held or sent. */
function handleTyped(state: AttachState, command: ClientMessage | "quit" | undefined): void {
  if (state.failure !== undefined) {
    return;
  }
  if (command === "quit") {
    leave(state);
    return;
  }
  if (command === undefined) {
    return;
  }
  const line = encodeLine(command);
  if (state.attached) {
    state.socket.write(line);
  } else {
    state.held.push(line);
  }
}

/** The socket's events and end: a failure rejects, a normal detach resolves. */
function settle(state: AttachState): void {
  if (state.failure !== undefined) {
    state.reject(state.failure);
    return;
  }
  if (!state.attached && !state.leaving) {
    state.output.write(`[${CLOSED_BEFORE_ATTACH}]\n`);
    state.reject(new NotAttachedError(CLOSED_BEFORE_ATTACH));
    return;
  }
  state.resolve(undefined);
}

/** Wire the socket: a reset destroys it; each event renders; close settles the promise. */
function wire(state: AttachState): void {
  state.socket.on("error", () => {
    state.socket.destroy();
  });
  state.socket.on(
    "data",
    lineSplitter((line) => {
      handleEvent(state, toPrintable(JSON.parse(line)));
    }),
  );
  state.socket.on("close", () => {
    settle(state);
  });
}

/** Read the user's lines; end of input leaves like `/quit` does. */
function startTyping(state: AttachState, input: Readable): Interface {
  const lines = createInterface({ input, terminal: false });
  lines.on("line", (typed) => {
    handleTyped(state, commandOf(typed));
  });
  lines.on("close", () => {
    leave(state);
  });
  return lines;
}

/**
 * Attach until `input` ends, `/quit`, or the daemon closes the connection.
 * Waits for the daemon to start listening (design §4.2), for `wait`'s bound;
 * if none answers, says so on `output` and rejects with the connect error.
 */
export async function attach(
  socketPath: string,
  input: Readable,
  output: Writable,
  options: AttachOptions = {},
): Promise<void> {
  const target = options.target ?? ROOT;
  const wait = options.wait ?? DEFAULT_WAIT;
  const socket = await connectOrExplain(socketPath, output, wait);
  // The daemon binds this connection by its first line: root, until flags name another.
  socket.write(encodeLine(frameOf(target)));
  output.write("[connected]\n");
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const state: AttachState = {
    socket,
    output,
    render: createRenderer(),
    attached: false,
    leaving: false,
    held: [],
    resolve,
    reject,
  };
  wire(state);
  const lines = startTyping(state, input);
  try {
    await promise;
  } finally {
    lines.close();
  }
  output.write("[detached]\n");
}
