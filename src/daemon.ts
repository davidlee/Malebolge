// The daemon socket: at most one conversation per connection, bound by its
// first line — the one an `attach` frame names, root for any other line; a
// connection that sends nothing is never bound (design sec-1, DEC-108). The
// Harness and its storage stay with this one process; `beforeInput` is one
// daemon-wide gate shared by every conversation (DEC-086).

import type { Socket } from "node:net";
import type { AgentEventStream, Conversation } from "@earendil-works/pi-durable";
import { context } from "./context.ts";
import type { Conversations } from "./conversations.ts";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import {
  type AttachMessage,
  AttachRefused,
  type ClientMessage,
  type ErrorMessage,
  parseConnectionMessage,
} from "./protocol.ts";
import { serveUnix, type UnixServer } from "./unix-socket.ts";

export type Daemon = UnixServer;

export interface ServeOptions {
  socketPath: string;
  /** The daemon's conversations; every line's turn waits for it before binding. */
  conversations: Promise<Conversations>;
  /** One daemon-wide gate, shared by every conversation, before each input. */
  beforeInput: () => Promise<void>;
}

/** One connection: its socket, the chain that orders its lines, and its one binding. */
interface Connection {
  socket: Socket;
  conversations: Promise<Conversations>;
  beforeInput: () => Promise<void>;
  /** The conversation the first line bound; `undefined` until then. */
  bound?: Conversation;
  /** The bound conversation's event stream, once acquired. */
  stream?: AgentEventStream;
  /** Set when this connection takes no further line: a failed attach, or a departure. */
  ended: boolean;
  /** Every line's turn, one after the previous one. */
  queue: Promise<void>;
}

const errorMessage = (error: unknown): ErrorMessage => ({
  type: "error",
  message: error instanceof Error ? error.message : String(error),
});

const alreadyAttached = (conversation: Conversation): ErrorMessage => ({
  type: "error",
  message: `already attached to conversation ${String(conversation.id)}`,
});

function write(state: Connection, value: unknown): void {
  if (state.socket.writable) {
    state.socket.write(encodeLine(value));
  }
}

function writeError(state: Connection, error: unknown): void {
  write(state, errorMessage(error));
}

/** This connection is over: one error, the socket ended, the lines queued behind it dropped. */
function fail(state: Connection, error: unknown): void {
  if (state.ended) {
    return;
  }
  state.ended = true;
  writeError(state, error);
  state.socket.end();
}

/** One input's turn: the daemon's gate, then the draft built from the validated fields. */
async function submitInput(
  state: Connection,
  conversation: Conversation,
  message: Extract<ClientMessage, { type: "input" }>,
): Promise<void> {
  const draft: Extract<ClientMessage, { type: "input" }> = {
    type: "input",
    content: message.content,
    ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
  };
  await state.beforeInput();
  await conversation.submit(draft, context);
}

/** What a line asks the bound conversation to do; only an input runs `beforeInput`. */
async function act(
  state: Connection,
  conversation: Conversation,
  message: ClientMessage,
): Promise<void> {
  switch (message.type) {
    case "input":
      await submitInput(state, conversation, message);
      return;
    case "abort":
      await conversation.abort(context);
      return;
    case "compact":
      await conversation.compact(message.instructions, context);
      return;
  }
}

/**
 * Watch `conversation`, say which one this is (when asked), show it, and stream
 * it. False when the connection ended instead — a failed watch, or a client that
 * left — so the caller does not act on a binding that was never announced.
 */
async function bind(
  state: Connection,
  conversations: Conversations,
  conversation: Conversation,
  ack: boolean,
): Promise<boolean> {
  let stream: AgentEventStream;
  try {
    stream = await conversations.watch(conversation);
  } catch (error) {
    fail(state, error);
    return false;
  }
  state.stream = stream;
  if (state.socket.destroyed) {
    // The client left while the conversation was being opened: nothing will stop this later.
    await stream.stop();
    state.ended = true;
    return false;
  }
  state.bound = conversation;
  if (ack) {
    write(state, { type: "attached", conversation: conversation.id });
  }
  write(state, stream.snapshot);
  stream.start((events) => {
    for (const event of events) {
      write(state, event);
    }
    return Promise.resolve();
  });
  return true;
}

/** Bind root: a first line that names no conversation, or one that does not parse. */
const bindRoot = (state: Connection, conversations: Conversations): Promise<boolean> =>
  bind(state, conversations, conversations.root, false);

/** Open the attach target, then bind it with the ack; a refusal ends the connection. */
async function bindTarget(
  state: Connection,
  conversations: Conversations,
  target: AttachMessage["target"],
): Promise<void> {
  try {
    const conversation = await conversations.open(target);
    await bind(state, conversations, conversation, true);
  } catch (error) {
    fail(state, error);
  }
}

/** The first line binds: an attach frame's target, root for any other valid line. */
async function firstLine(
  state: Connection,
  conversations: Conversations,
  line: string,
): Promise<void> {
  let message: AttachMessage | ClientMessage;
  try {
    message = parseConnectionMessage(line);
  } catch (error) {
    if (error instanceof AttachRefused) {
      fail(state, error);
      return;
    }
    // Not an attach and not a valid command: root, then that error, and stay open.
    if (await bindRoot(state, conversations)) {
      writeError(state, error);
    }
    return;
  }
  if (message.type !== "attach") {
    if (await bindRoot(state, conversations)) {
      await act(state, conversations.root, message);
    }
    return;
  }
  await bindTarget(state, conversations, message.target);
}

/** A bound connection: an attach frame is refused, anything else acts on the binding. */
async function laterLine(
  state: Connection,
  conversation: Conversation,
  line: string,
): Promise<void> {
  let message: AttachMessage | ClientMessage;
  try {
    message = parseConnectionMessage(line);
  } catch (error) {
    // A well-formed attach frame is still refused here: this connection is bound already.
    write(
      state,
      error instanceof AttachRefused ? alreadyAttached(conversation) : errorMessage(error),
    );
    return;
  }
  if (message.type === "attach") {
    write(state, alreadyAttached(conversation));
    return;
  }
  await act(state, conversation, message);
}

/** One line's turn: wait for the conversations, then let the binding take it. */
async function handleLine(state: Connection, line: string): Promise<void> {
  let conversations: Conversations;
  try {
    conversations = await state.conversations;
  } catch (error) {
    fail(state, error);
    return;
  }
  // A turn that starts after the socket is gone drops this line and every line behind it.
  if (state.socket.destroyed || state.ended) {
    state.ended = true;
    return;
  }
  const { bound } = state;
  if (bound === undefined) {
    await firstLine(state, conversations, line);
  } else {
    await laterLine(state, bound, line);
  }
}

/** One line's turn in the chain: its failure is written, and the chain continues. */
async function actOn(state: Connection, line: string): Promise<void> {
  try {
    await handleLine(state, line);
  } catch (error) {
    writeError(state, error);
  }
}

function enqueue(state: Connection, line: string): void {
  state.queue = state.queue.then(() => actOn(state, line));
}

/**
 * One connection: the close handler and the one line splitter are installed
 * here, at connect, before `conversations` resolves, so nothing is lost or
 * reordered while the daemon waits.
 */
function startConnection(options: ServeOptions, socket: Socket): void {
  const state: Connection = {
    socket,
    conversations: options.conversations,
    beforeInput: options.beforeInput,
    ended: false,
    queue: Promise.resolve(),
  };
  // Registered before any await: a close emitted while `conversations` opens is not replayed.
  socket.on("close", () => void state.stream?.stop());
  socket.on(
    "data",
    lineSplitter((line) => {
      enqueue(state, line);
    }),
  );
}

/**
 * Serve on a unix socket at `socketPath`: SocketInUse if a server answers there,
 * a stale socket replaced (serveUnix). Each connection waits for `conversations`
 * and binds one conversation by its first line; every input runs `beforeInput`.
 */
export function serve(options: ServeOptions): Promise<Daemon> {
  return serveUnix(options.socketPath, (socket) => {
    startConnection(options, socket);
  });
}
