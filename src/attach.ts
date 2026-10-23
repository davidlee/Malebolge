// A line-oriented client of the daemon: typed lines become messages, events
// become text. Used directly in a terminal and under Emacs comint.

import type { Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { messageOf } from "./message-of.ts";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import { isRecord } from "./json.ts";
import {
  type AttachTarget,
  type ClientMessage,
  type ErrorMessage,
  parseClientMessage,
} from "./protocol.ts";
import {
  type ClientNotice,
  createRenderer,
  type Presentation,
  type Printable,
  toPrintable,
} from "./render.ts";
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
  emacs: boolean;
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
      },
      strict: true,
      allowPositionals: false,
    });
    const parsed: AttachArgs = { isNew: values.new === true, emacs: values.emacs === true };
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

/** What a frame-mode stdin line asks for: a command, `quit`, or a refusal. */
type FrameOutcome = ClientMessage | "quit" | "refused";

/** How a client reads its input: typed lines, or one private JSON frame per line. */
export type InputMode = "lines" | "frames";

/** A parsed command line: where to attach, and how to read input and print. */
export interface AttachInvocation {
  target: AttachTarget;
  inputMode: InputMode;
  presentation: Presentation;
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
  return targetFrom(parseAttachArgs(args));
}

/** The one parse of a command line: target, input mode and presentation. */
export function attachInvocationOf(args: string[]): AttachInvocation {
  const parsed = parseAttachArgs(args);
  const target = targetFrom(parsed);
  return parsed.emacs
    ? { target, inputMode: "frames", presentation: "emacs" }
    : { target, inputMode: "lines", presentation: "terminal" };
}

/** The frame fields each command accepts; a frame with any other field is refused. */
const FRAME_FIELDS: ReadonlyMap<unknown, readonly string[]> = new Map([
  ["input", ["type", "content"]],
  ["abort", ["type"]],
  ["compact", ["type", "instructions"]],
  ["quit", ["type"]],
]);

/** Whether `frame` carries only the fields its declared type allows. */
function hasAllowedFields(frame: Record<string, unknown>): boolean {
  const allowed = FRAME_FIELDS.get(frame["type"]);
  return allowed !== undefined && Object.keys(frame).every((key) => allowed.includes(key));
}

/** The commands a frame carries; the daemon's own parser decides every refusal. */
function frameOf(line: string): FrameOutcome {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "refused";
  }
  if (!isRecord(value)) {
    return "refused";
  }
  if (!hasAllowedFields(value)) {
    return "refused";
  }
  if (value["type"] === "quit") {
    return "quit";
  }
  try {
    return parseClientMessage(line);
  } catch {
    return "refused";
  }
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

/** The target the client attaches to, how it reads input, and how long to wait. */
export interface AttachOptions {
  target?: AttachTarget;
  wait?: ConnectWait;
  inputMode?: InputMode;
  presentation?: Presentation;
}

const ROOT: AttachTarget = { kind: "root" };
const REFUSED_FRAME = "the client refused that frame";
const DEFAULT_WAIT: ConnectWait = { intervalMs: 200, timeoutMs: 10_000 };
const CLOSED_BEFORE_ATTACH = "the daemon closed before attach completed";
const SKEW = 'unknown message type "attach"';
const SKEW_HINT = "the daemon predates attach: restart it (malebolge-stop, then malebolge-start)";

/** The first line's frame: the conversation this connection asks for. */
function attachFrameOf(target: AttachTarget): unknown {
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
  inputMode: InputMode;
  attached: boolean;
  leaving: boolean;
  failure?: NotAttachedError;
  held: string[];
  resolve: (value: undefined) => void;
  reject: (error: Error) => void;
}

/** A client-local notice as `render` prints it: the one path every notice takes. */
function noticeText(render: AttachState["render"], text: string): string {
  const event: ClientNotice = { type: "client_notice", text };
  return render(event);
}

function notice(state: AttachState, text: string): void {
  state.output.write(noticeText(state.render, text));
}

/** Connect, or say on `output` why not and rethrow the connect error. */
async function connectOrExplain(
  socketPath: string,
  output: Writable,
  render: AttachState["render"],
  wait: ConnectWait,
): Promise<Socket> {
  try {
    return await connectUnixWaiting(socketPath, wait);
  } catch (error) {
    const cause = String(codeOf(error) ?? error);
    output.write(noticeText(render, `cannot connect to ${socketPath}: ${cause}`));
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
    notice(state, SKEW_HINT);
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

/** One input command: `quit` leaves, none (a blank line) is ignored, a refusal is noticed, the rest is held or sent. */
function handleLine(state: AttachState, command: FrameOutcome | undefined): void {
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
  if (command === "refused") {
    notice(state, REFUSED_FRAME);
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
    notice(state, CLOSED_BEFORE_ATTACH);
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
    handleLine(state, state.inputMode === "frames" ? frameOf(typed) : commandOf(typed));
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
 * Until the daemon confirms with `attached`, a refusal or a close rejects with
 * a `code: "NOT_ATTACHED"` error after it has printed why.
 */
export async function attach(
  socketPath: string,
  input: Readable,
  output: Writable,
  options: AttachOptions = {},
): Promise<void> {
  const target = options.target ?? ROOT;
  const wait = options.wait ?? DEFAULT_WAIT;
  // Made before connecting, so a connect failure is told in the same voice.
  const render = createRenderer({ presentation: options.presentation ?? "terminal" });
  const socket = await connectOrExplain(socketPath, output, render, wait);
  // The daemon binds this connection by its first line: root, until flags name another.
  socket.write(encodeLine(attachFrameOf(target)));
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const state: AttachState = {
    socket,
    output,
    render,
    inputMode: options.inputMode ?? "lines",
    attached: false,
    leaving: false,
    held: [],
    resolve,
    reject,
  };
  notice(state, "connected");
  wire(state);
  const lines = startTyping(state, input);
  try {
    await promise;
  } finally {
    lines.close();
  }
  notice(state, "detached");
}
