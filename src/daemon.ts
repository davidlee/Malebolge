// The daemon socket: at most one conversation per connection, bound by its
// first line — the one an `attach` frame names, root for any other line; a
// connection that sends nothing is never bound (design sec-1, DEC-108). The
// Harness and its storage stay with this one process; `beforeInput` is one
// daemon-wide gate shared by every conversation (DEC-086).

import type { Socket } from "node:net";
import type { AgentEventStream, Conversation, ConversationId } from "@earendil-works/pi-durable";
import { answer, errorMessage, fail, write, writeError } from "./connection-reply.ts";
import { context } from "./context.ts";
import { type ConversationPage, type Conversations } from "./conversations.ts";
import { lineSplitter } from "./ndjson.ts";
import {
  type AttachMessage,
  type ClientMessage,
  type ConversationsMessage,
  type ErrorMessage,
  type FirstLineFrame,
  FrameRefused,
  type ListQuery,
  type ModelsMessage,
  parseConnectionMessage,
  type TopicSummary,
  type TopicsMessage,
} from "./protocol.ts";
import { serveUnix, type UnixServer } from "./unix-socket.ts";

export type Daemon = UnixServer;

export interface ServeOptions {
  socketPath: string;
  /** The daemon's conversations; every line's turn waits for it before binding. */
  conversations: Promise<Conversations>;
  /** One daemon-wide gate, shared by every conversation, before each input. */
  beforeInput: () => Promise<void>;
  /** The input an `orient` line submits to `conversation`: its fresh SATAN context (IMP-016). */
  orientation: (conversation: ConversationId) => Promise<string>;
  /** The catalogue's chat-model refs, for a `models` listing: the store is never asked. */
  modelRefs: () => string[];
}

/** One connection: its socket, the chain that orders its lines, and its one binding. */
interface Connection {
  socket: Socket;
  conversations: Promise<Conversations>;
  beforeInput: () => Promise<void>;
  orientation: (conversation: ConversationId) => Promise<string>;
  /** The catalogue's chat-model refs, for a `models` listing (SL-010 PHASE-06). */
  modelRefs: () => string[];
  /** The conversation the first line bound; `undefined` until then. */
  bound?: Conversation;
  /** The bound conversation's event stream, once acquired. */
  stream?: AgentEventStream;
  /** Set when this connection takes no further line: a failed attach, a listing, or a departure. */
  ended: boolean;
  /** Every line's turn, one after the previous one. */
  queue: Promise<void>;
}

const alreadyAttached = (conversation: Conversation): ErrorMessage => ({
  type: "error",
  message: `already attached to conversation ${String(conversation.id)}`,
});

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

/** What a line asks the bound conversation to do; only an input or an orient runs `beforeInput`. */
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
    case "orient":
      await submitInput(state, conversation, {
        type: "input",
        content: await state.orientation(conversation.id),
      });
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
  // Read before the watch: nothing awaits between binding and streaming.
  const summary = ack ? await conversations.summaryOf(conversation) : undefined;
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
    // `exactOptionalPropertyTypes`: an unindexed conversation's reply has no summary key.
    const attached = { type: "attached", conversation: conversation.id } as const;
    write(state, summary === undefined ? attached : { ...attached, summary });
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

/** The `list` frame's reply: one page of this store's ids, its threads' marks and its summaries. */
const listReply = (page: ConversationPage): ConversationsMessage => ({
  type: "conversations",
  conversations: page.ids,
  truncated: page.truncated,
  // Absent when the page holds no thread, so an unmarked reply is unchanged on the wire.
  ...(page.marks === undefined ? {} : { marks: page.marks }),
  // Always sent, `{}` for an empty page: the line every id prints is `id<TAB>topic<TAB>model`.
  summaries: page.summaries,
});

/** The `topics` reply, for a listing or a write: the records, and whose path space they are in. */
const topicsReply = (
  conversations: Conversations,
  topics: readonly TopicSummary[],
): TopicsMessage => ({
  type: "topics",
  profile: conversations.profile,
  topics: [...topics],
});

/**
 * The `models` reply: the catalogue's chat-model refs, read from the daemon's own
 * port. No `Conversations` method is called (the turn still awaits the resumed session).
 */
const modelsReply = (state: Connection): ModelsMessage => ({
  type: "models",
  models: state.modelRefs(),
});

/** The `list` frame's one reply, by the question it asked (design sec-4, sec-5). */
async function listAnswer(
  state: Connection,
  conversations: Conversations,
  query: ListQuery,
): Promise<ConversationsMessage | ModelsMessage | TopicsMessage> {
  if (query.kind === "models") {
    return modelsReply(state);
  }
  if (query.kind === "topics") {
    return topicsReply(conversations, await conversations.topics());
  }
  return listReply(await conversations.list(query));
}

/** One row of `FIRST_LINE`: what one first-line frame does to this connection. */
type FrameHandler<K extends FirstLineFrame["type"]> = (
  state: Connection,
  conversations: Conversations,
  frame: Extract<FirstLineFrame, { type: K }>,
) => Promise<void>;

/**
 * The one per-verb dispatch: a new first-line frame costs one parser case in
 * `src/protocol.ts` and one row here, and the mapped type makes a frame without a
 * row a compile error. Each row stays thin; `answer` settles.
 */
const FIRST_LINE: { [K in FirstLineFrame["type"]]: FrameHandler<K> } = {
  attach: (state, conversations, frame) => bindTarget(state, conversations, frame.target),
  list: (state, conversations, frame) =>
    answer(state, () => listAnswer(state, conversations, frame.query)),
  // One write, one record back, the same reply shape a topics listing uses.
  topic: (state, conversations, frame) =>
    answer(state, async () => topicsReply(conversations, [await conversations.setTopic(frame)])),
};

/** Whether `message` is a first-line frame: the table's keys answer it, so a row is a frame. */
const isFirstLineFrame = (message: FirstLineFrame | ClientMessage): message is FirstLineFrame =>
  Object.hasOwn(FIRST_LINE, message.type);

/** The row that settles `frame`, looked up by its own `type`, so handler and frame agree. */
const handlerOf = <K extends FirstLineFrame["type"]>(
  frame: Extract<FirstLineFrame, { type: K }>,
): FrameHandler<K> => FIRST_LINE[frame.type];

/** The first line binds: a first-line frame's row, root for any other valid line. */
async function firstLine(
  state: Connection,
  conversations: Conversations,
  line: string,
): Promise<void> {
  let message: FirstLineFrame | ClientMessage;
  try {
    message = parseConnectionMessage(line);
  } catch (error) {
    if (error instanceof FrameRefused) {
      fail(state, error);
      return;
    }
    // Not a first-line frame and not a valid command: root, then that error, and stay open.
    if (await bindRoot(state, conversations)) {
      writeError(state, error);
    }
    return;
  }
  if (!isFirstLineFrame(message)) {
    if (await bindRoot(state, conversations)) {
      await act(state, conversations.root, message);
    }
    return;
  }
  await handlerOf(message)(state, conversations, message);
}

/** A bound connection: a first-line frame is refused, anything else acts on the binding. */
async function laterLine(
  state: Connection,
  conversation: Conversation,
  line: string,
): Promise<void> {
  let message: FirstLineFrame | ClientMessage;
  try {
    message = parseConnectionMessage(line);
  } catch (error) {
    // A well-formed first-line frame is still refused here: this connection is bound already.
    write(
      state,
      error instanceof FrameRefused ? alreadyAttached(conversation) : errorMessage(error),
    );
    return;
  }
  if (isFirstLineFrame(message)) {
    // No frame is actionable for the bound conversation, so none reaches `act`.
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
    orientation: options.orientation,
    modelRefs: options.modelRefs,
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
