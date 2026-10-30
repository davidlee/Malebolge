// The bridge listener (SL-009 design sec-2, sec-3; DEC-064, DEC-065): pi's one
// socket into a conversation, bound by a first line that pairs or resumes, then a
// bound row per message. The bridge parser knows no attach verb and no durable.sock
// verb, so the durable socket's protocol is unreachable here; every reply is one
// daemon frame on one line. The socket is private (servePrivateUnix: a 0700
// directory, a 0600 socket) and the token is never stored or logged, only its hash.

import type { Socket } from "node:net";
import type {
  Conversation,
  ConversationId,
  ConversationInit,
  DocumentWatch,
  SubmissionId,
} from "@earendil-works/pi-durable";
import {
  BOUND_FRAMES,
  type BoundFrame,
  BRIDGE_LINE_MAX_BYTES,
  FIRST_LINE_FRAMES,
  type FirstLineFrame,
  type PairedFrame,
  type Posture,
  parseFrame,
  type RefusedFrame,
} from "../../pi-bridge/wire.ts";
import type { Profile } from "../config.ts";
import { finish, write } from "../connection-reply.ts";
import { context } from "../context.ts";
import {
  type ConversationDefaults,
  type Conversations,
  create,
  isConversationKey,
  topicCwd,
  topicInit,
} from "../conversations.ts";
import { messageOf } from "../message-of.ts";
import type { ModelCatalog } from "../models.ts";
import { boundedLineSplitter } from "../ndjson.ts";
import { topicNameOf } from "../protocol.ts";
import type { Log, SatanTools } from "../satan-tools.ts";
import type { Session } from "../session.ts";
import type { DaemonToolset } from "../toolsets.ts";
import { isKnownTopic, readIndex } from "../topics.ts";
import { servePrivateUnix, type UnixServer } from "../unix-socket.ts";
import { refillBridged, submitInbound } from "./inbound.ts";
import {
  ackEntry,
  type Check,
  checkToken,
  endPairing,
  mintToken,
  openPairing,
  type PairingDoc,
  pairingDoc,
  pairingSnapshot,
  watchPairing,
} from "./pairing.ts";

/** What the listener serves over: resolved in `beforeResume`, as the daemon socket's own host is. */
export interface BridgeHost {
  /** The daemon's one session: its harness, the read and the commits. */
  session: Session;
  /** The one topic write a `pair` makes; the conversations' other rows are not the bridge's. */
  conversations: Pick<Conversations, "setTopic">;
  /** The daemon's creation defaults: its model and cwd (DEC-092). */
  defaults: ConversationDefaults;
  profile: Profile;
  catalog: ModelCatalog;
  /** The daemon's satan-mcp port: `notifyBestEffort`'s, for a notice that cannot be appended. */
  satan: Pick<SatanTools, "call">;
  /** The daemon's log: one line per failure the bridge swallows rather than refuses. */
  log: Log;
  /** The harness clock: a note's model timestamp. */
  now: () => number;
  /** The conversations operator clients are attached to right now (SL-011, DEC-104). */
  attached: () => readonly ConversationId[];
}

export interface BridgeListenerOptions {
  /** `config.bridgeSocket`: the room profile's private bridge path. */
  path: string;
  host: Promise<BridgeHost>;
}

/** The listener's own state: the host every connection awaits, and the one binding per pairing. */
interface Listener {
  host: Promise<BridgeHost>;
  /** One binding per pairing (conversation id): the newest connection wins (DEC-065). */
  bindings: Map<ConversationId, Connection>;
  /**
   * One withdrawal watch per posted submission, for the listener's life: a resend on a
   * newer connection joins the original's watch, so it never adds a second notice. Never
   * pruned: the turn budget bounds it, and the listener outlives every connection.
   */
  watches: Map<SubmissionId, Promise<void>>;
}

/** One connection: its socket, the listener it belongs to, the pairing it bound, and its line chain. */
interface Connection {
  socket: Socket;
  listener: Listener;
  /** The conversation this connection bound; `undefined` until a pair or resume. */
  bound?: ConversationId;
  /** Set when this connection takes no further line: a refusal that closes, or a supersede. */
  ended: boolean;
  /** Every line's turn, one after the previous one. */
  queue: Promise<void>;
  /** The bind's watch on the pairing document: how the outbox reaches pi; stopped when this connection ends. */
  watch?: DocumentWatch<PairingDoc>;
  /** The highest seq delivered on this connection: a change sends only what is above it. */
  sent: number;
}

/** What a first-line row acts on: the connection and the host its line waited for. */
interface FirstTurn {
  state: Connection;
  host: BridgeHost;
}

/** What a bound row acts on: the connection, the host, and the pairing it bound. */
interface BoundTurn {
  state: Connection;
  host: BridgeHost;
  conversation: ConversationId;
}

// --- replies -----------------------------------------------------------------

/** The refusal `reason`, carrying `id` when the frame that earned it had one (post's own id). */
const refused = (reason: string, id?: string): RefusedFrame =>
  id === undefined ? { type: "refused", reason } : { type: "refused", id, reason };

/** The one reply `pair` (with its token) and `resume` (without one) make. */
const paired = (conversation: ConversationId, token?: string): PairedFrame =>
  token === undefined
    ? { type: "paired", conversation: String(conversation) }
    : { type: "paired", conversation: String(conversation), token };

/** The refusal an ended pairing gives: post's own id echoes back, no other bound frame has one. */
const endedRefusal = (frame: BoundFrame): RefusedFrame =>
  frame.type === "post" ? refused("pairing ended", frame.id) : refused("pairing ended");

// --- bindings (DEC-065) ------------------------------------------------------

/** Record `state` as `conversation`'s connection, telling and closing the one it supersedes. */
function bind(state: Connection, conversation: ConversationId): void {
  const { bindings } = state.listener;
  const previous = bindings.get(conversation);
  if (previous !== undefined && previous !== state) {
    finish(previous, refused("superseded by a newer connection"));
  }
  state.bound = conversation;
  bindings.set(conversation, state);
}

/** Drop this connection's binding, unless a newer connection holds it now. */
function unbind(state: Connection): void {
  const { bindings } = state.listener;
  const { bound } = state;
  if (bound !== undefined && bindings.get(bound) === state) {
    bindings.delete(bound);
  }
}

/**
 * Bind `state` to `conversation`, answer `paired`, then follow its pairing: deliver
 * what the outbox already holds, and every entry a later commit appends. A pairing
 * no commit ever wrote is not watched.
 */
async function bindAndFollow(
  state: Connection,
  host: BridgeHost,
  conversation: ConversationId,
  token?: string,
): Promise<void> {
  bind(state, conversation);
  state.sent = 0;
  write(state, paired(conversation, token));
  const watch = await watchPairing(host.session.harness, conversation);
  if (watch === undefined) {
    return;
  }
  if (state.socket.destroyed || state.ended) {
    void watch.stop();
    return;
  }
  state.watch = watch;
  deliver(state, watch.value);
  watch.start((value) => {
    deliver(state, value);
    return Promise.resolve();
  });
}

/** Send every outbox entry `state` has not yet sent, in seq order; an ended connection takes nothing. */
function deliver(state: Connection, value: Readonly<PairingDoc> | null): void {
  if (state.ended) {
    return;
  }
  for (const entry of value?.outbox ?? []) {
    if (entry.seq <= state.sent) {
      continue;
    }
    write(state, { type: "deliver", seq: entry.seq, kind: entry.kind, text: entry.text });
    state.sent = entry.seq;
  }
}

// --- the pairing document, read without a commit ------------------------------

/**
 * Whether `token` resumes `conversation`: read from the committed snapshot, so a
 * refusal writes nothing. No document (a plain conversation, or none at all) reads
 * as not bridged.
 */
async function checkPairing(
  host: BridgeHost,
  conversation: ConversationId,
  token: string,
): Promise<Check> {
  const doc = await pairingSnapshot(host.session.harness, conversation);
  return doc === undefined
    ? { ok: false, reason: "not a bridged conversation" }
    : checkToken(doc, token);
}

/** A frame's `conversation` as a conversation key: strict decimal digits, no trailing text. */
const conversationKeyOf = (text: string): ConversationId | undefined => {
  const id = Number(text);
  return /^[0-9]+$/.test(text) && isConversationKey(id) ? id : undefined;
};

// --- pair (DEC-065, DEC-092, DEC-093) ----------------------------------------

/** The `require` hook `pair` hands `topicInit`: the topic's chosen toolset must be the bridge's. */
const requireBridge =
  (name: string) =>
  (toolset: DaemonToolset): void => {
    if (toolset !== "bridge") {
      throw new Error(`topic ${name} has toolset ${toolset}, not bridge`);
    }
  };

/**
 * pair's creating init: the topic's conversation (its stored model, else the daemon
 * default, and no `startedBy`), then the pairing, in the one creating commit — so a
 * refusal throws there and nothing is created.
 */
function bridgedInit(
  host: BridgeHost,
  name: string,
  posture: Posture,
  project: string,
  token: string,
): ConversationInit {
  const topic = topicInit(host.profile, name, host.catalog, host.defaults.model, {
    require: requireBridge(name),
  });
  return async (tx, conversation) => {
    await topic(tx, conversation);
    openPairing(await pairingDoc(tx, conversation), posture, project, token);
  };
}

/**
 * The conversation `pair` creates: its `<project>-bridge` topic written first if the
 * index lacks it (its own commit, no cwd and no model, and an existing topic is never
 * rewritten), then one ownerless conversation in it, in the topic's directory.
 */
async function createBridged(
  host: BridgeHost,
  name: string,
  posture: Posture,
  project: string,
  token: string,
): Promise<Conversation> {
  const index = await readIndex(host.session.harness);
  if (!isKnownTopic(index, name)) {
    await host.conversations.setTopic({ name, toolset: "bridge" });
  }
  const cwd = topicCwd(index, name, host.defaults);
  return create(host.session, host.defaults, cwd, bridgedInit(host, name, posture, project, token));
}

/** pair: name the project's topic, create the conversation, bind it, answer with its one token. */
async function pairRow(
  turn: FirstTurn,
  frame: Extract<FirstLineFrame, { type: "pair" }>,
): Promise<void> {
  const { state, host } = turn;
  // Minted before the commit, so a refused pair creates nothing and tells nothing.
  const token = mintToken();
  let conversation: Conversation;
  try {
    const name = topicNameOf(`${frame.project}-bridge`);
    conversation = await createBridged(host, name, frame.posture, frame.project, token);
  } catch (error) {
    finish(state, refused(messageOf(error)));
    return;
  }
  await bindAndFollow(state, host, conversation.id, token);
}

// --- resume and end (DEC-065) ------------------------------------------------

/** resume: the conversation key, then its token, then bind; a refusal closes the connection. */
async function resumeRow(
  turn: FirstTurn,
  frame: Extract<FirstLineFrame, { type: "resume" }>,
): Promise<void> {
  const { state, host } = turn;
  const conversation = conversationKeyOf(frame.conversation);
  if (conversation === undefined) {
    finish(state, refused("not a bridged conversation"));
    return;
  }
  const check = await checkPairing(host, conversation, frame.token);
  if (!check.ok) {
    finish(state, refused(check.reason));
    return;
  }
  await bindAndFollow(state, host, conversation);
}

/** ack: forget the entry with exactly `seq`; no reply, either way (an unknown or repeated seq is a no-op). */
async function ackRow(turn: BoundTurn, frame: Extract<BoundFrame, { type: "ack" }>): Promise<void> {
  await turn.host.session.harness.commit(async (tx) => {
    ackEntry(await pairingDoc(tx, turn.conversation), frame.seq);
  }, context);
}

/**
 * post: submit the message, then answer `accepted` with its id — or the refusal; the
 * connection stays open. The notification of a withdrawal is detached from this line.
 */
async function postRow(
  turn: BoundTurn,
  frame: Extract<BoundFrame, { type: "post" }>,
): Promise<void> {
  const check = await submitInbound(
    { host: turn.host, watches: turn.state.listener.watches },
    turn.conversation,
    { kind: frame.kind, text: frame.text, id: frame.id },
  );
  write(
    turn.state,
    check.ok ? { type: "accepted", id: frame.id } : refused(check.reason, frame.id),
  );
}

/** refill: restore the loop budget; no reply on success (design sec-2). */
async function refillRow(turn: BoundTurn): Promise<void> {
  await refillBridged(turn.host, turn.conversation);
}

/**
 * post-once: one message, its own first line, then closed. Nothing is bound, so the
 * conversation is named by the frame, and its token is judged before its ended state.
 */
async function postOnceRow(
  turn: FirstTurn,
  frame: Extract<FirstLineFrame, { type: "post-once" }>,
): Promise<void> {
  const conversation = conversationKeyOf(frame.conversation);
  if (conversation === undefined) {
    finish(turn.state, refused("not a bridged conversation"));
    return;
  }
  const check = await checkPairing(turn.host, conversation, frame.token);
  if (!check.ok) {
    finish(turn.state, refused(check.reason));
    return;
  }
  const submitted = await submitInbound(
    { host: turn.host, watches: turn.state.listener.watches },
    conversation,
    { kind: frame.kind, text: frame.text },
  );
  finish(turn.state, submitted.ok ? { type: "accepted" } : refused(submitted.reason));
}

/** end: commit `ended`, tell pi, close; the close drops the binding, and the conversation stays attachable. */
async function endRow(turn: BoundTurn): Promise<void> {
  await turn.host.session.harness.commit(async (tx) => {
    endPairing(await pairingDoc(tx, turn.conversation));
  }, context);
  finish(turn.state, refused("pairing ended"));
}

// --- the two dispatch tables -------------------------------------------------

/** One row of `BRIDGE_FIRST_LINE`: what one first-line frame does to this connection. */
type FirstLineHandler<K extends FirstLineFrame["type"]> = (
  turn: FirstTurn,
  frame: Extract<FirstLineFrame, { type: K }>,
) => Promise<void>;

/** One row of `BRIDGE_BOUND`: what one bound frame does, its pairing known unended. */
type BoundHandler<K extends BoundFrame["type"]> = (
  turn: BoundTurn,
  frame: Extract<BoundFrame, { type: K }>,
) => Promise<void>;

/**
 * The first line's dispatch: a new first-line frame costs one parser case in
 * `pi-bridge/wire.ts` and one row here, and the mapped type makes a frame without
 * a row a compile error. Each row stays thin.
 */
const BRIDGE_FIRST_LINE: { [K in FirstLineFrame["type"]]: FirstLineHandler<K> } = {
  pair: pairRow,
  resume: resumeRow,
  "post-once": postOnceRow,
};

/**
 * The bound connection's dispatch, separate from `src/daemon.ts`'s tables: post submits
 * one inbound message, ack forgets one delivered entry, refill restores the loop budget
 * and end ends the pairing. The mapped type keeps every frame of the union represented.
 */
const BRIDGE_BOUND: { [K in BoundFrame["type"]]: BoundHandler<K> } = {
  post: postRow,
  ack: ackRow,
  refill: refillRow,
  end: endRow,
};

/** The row that settles `frame`, looked up by its own `type`, so handler and frame agree. */
const firstLineHandlerOf = <K extends FirstLineFrame["type"]>(
  frame: Extract<FirstLineFrame, { type: K }>,
): FirstLineHandler<K> => BRIDGE_FIRST_LINE[frame.type];

/** The bound row that settles `frame`, looked up by its own `type`. */
const boundHandlerOf = <K extends BoundFrame["type"]>(
  frame: Extract<BoundFrame, { type: K }>,
): BoundHandler<K> => BRIDGE_BOUND[frame.type];

// --- one line at a time ------------------------------------------------------

/**
 * A first line: parse the first-line vocabulary, then its row. A refusal (unknown
 * type, `attach`, a durable.sock verb, a malformed line) is written and the
 * connection closed; an unbound connection never sees a bound row.
 */
async function firstLine(state: Connection, host: BridgeHost, line: string): Promise<void> {
  const parsed = parseFrame(FIRST_LINE_FRAMES, line);
  if (!parsed.ok) {
    finish(state, parsed.refused);
    return;
  }
  await firstLineHandlerOf(parsed.frame)({ state, host }, parsed.frame);
}

/**
 * A bound line: parse the bound vocabulary (a refusal is written and the connection
 * STAYS open), re-read the pairing — an ended one refuses every row — then dispatch.
 */
async function boundLine(
  state: Connection,
  host: BridgeHost,
  conversation: ConversationId,
  line: string,
): Promise<void> {
  const parsed = parseFrame(BOUND_FRAMES, line);
  if (!parsed.ok) {
    write(state, parsed.refused);
    return;
  }
  const frame = parsed.frame;
  const doc = await pairingSnapshot(host.session.harness, conversation);
  if (doc?.ended === true && frame.type !== "end") {
    write(state, endedRefusal(frame));
    return;
  }
  await boundHandlerOf(frame)({ state, host, conversation }, frame);
}

/** One line's turn: wait for the host, then let the binding take the line. */
async function handleLine(state: Connection, line: string): Promise<void> {
  let host: BridgeHost;
  try {
    host = await state.listener.host;
  } catch (error) {
    finish(state, refused(messageOf(error)));
    return;
  }
  // A turn that starts after the socket is gone drops this line and every line behind it.
  if (state.socket.destroyed || state.ended) {
    state.ended = true;
    return;
  }
  const { bound } = state;
  if (bound === undefined) {
    await firstLine(state, host, line);
  } else {
    await boundLine(state, host, bound, line);
  }
}

/** One line's turn in the chain: its failure is written as a refusal, and the chain continues. */
async function actOn(state: Connection, line: string): Promise<void> {
  try {
    await handleLine(state, line);
  } catch (error) {
    write(state, refused(messageOf(error)));
  }
}

function enqueue(state: Connection, line: string): void {
  state.queue = state.queue.then(() => actOn(state, line));
}

/**
 * One connection: the close handler and the one bounded line splitter are installed
 * here, at connect, before `host` resolves, so nothing is lost or reordered while the
 * daemon waits. An over-cap line is refused and the connection closed.
 */
function startConnection(listener: Listener, socket: Socket): void {
  const state: Connection = {
    socket,
    listener,
    ended: false,
    queue: Promise.resolve(),
    sent: 0,
  };
  socket.on("close", () => {
    void state.watch?.stop();
    unbind(state);
  });
  socket.on(
    "data",
    boundedLineSplitter({
      maxBytes: BRIDGE_LINE_MAX_BYTES,
      onLine: (line) => {
        enqueue(state, line);
      },
      onOversize: () => {
        finish(state, refused(`line over ${String(BRIDGE_LINE_MAX_BYTES)} bytes`));
      },
    }).push,
  );
}

/**
 * Serve the bridge socket privately: the directory 0700 and owner-checked, the
 * socket 0600, never relaxed. Each connection binds one pairing by its first line;
 * a newer pair or resume supersedes the previous connection for it (DEC-065).
 */
export function serveBridge(options: BridgeListenerOptions): Promise<UnixServer> {
  const listener: Listener = { host: options.host, bindings: new Map(), watches: new Map() };
  return servePrivateUnix(options.path, (socket) => {
    startConnection(listener, socket);
  });
}
