// The bridge listener's world (SL-009 PHASE-05 EX-6): a room-profile session on
// memory storage, the literal catalog stub, the real `serveBridge` on a private
// socket, and a fake pi client that speaks the wire. Tests read state back
// through the same accessors production uses (the index, the pairing document).

import { join } from "node:path";
import {
  AgentDoc,
  type Conversation,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { onTestFinished } from "vitest";
import { DAEMON_FRAMES, type DaemonFrame, type Posture, parseFrame } from "../pi-bridge/wire.ts";
import { type PairingDoc, pairingDoc, pairingSnapshot } from "../src/bridge/pairing.ts";
import { type BridgeHost, serveBridge } from "../src/bridge/listener.ts";
import { context } from "../src/context.ts";
import {
  type ConversationDefaults,
  type Conversations,
  conversations,
  isConversationKey,
} from "../src/conversations.ts";
import { refOf } from "../src/models.ts";
import {
  type IndexEntry,
  idsIn,
  readIndex,
  storedEntry,
  storedTopic,
  type TopicRecord,
} from "../src/topics.ts";
import { type LineClient, lineClient, tempDir } from "./fixtures.ts";
import { FAUX_MODEL, openIndexedHarness, type TestHarness } from "./harness-fixture.ts";
import { catalogOf, FLASH_REF } from "./model-fixture.ts";

/** The daemon default model's ref: what a conversation takes when its topic names none. */
export const DEFAULT_REF = refOf(FAUX_MODEL);

/** The refs the catalog stub knows; any other is `unknown model <ref>`. */
export const BRIDGE_CATALOG = catalogOf(DEFAULT_REF, FLASH_REF);

/** A ref the catalog stub lacks. */
export const GHOST_REF = "gateway/ghost";

const DEFAULTS: ConversationDefaults = { model: FAUX_MODEL, cwd: process.cwd() };

/** The pieces a bridge listener serves over, before any socket exists. */
export interface BridgeHostWorld {
  test: TestHarness;
  conversations: Conversations;
  host: BridgeHost;
}

/** A room session with its conversations and the host record `serveBridge` takes. */
export async function bridgeHost(): Promise<BridgeHostWorld> {
  const test = await openIndexedHarness([]);
  const made = conversations(test, DEFAULTS, "room", BRIDGE_CATALOG);
  const host: BridgeHost = {
    session: test,
    conversations: made,
    defaults: DEFAULTS,
    profile: "room",
    catalog: BRIDGE_CATALOG,
  };
  return { test, conversations: made, host };
}

/** A fake pi: frames out, daemon frames in (each checked against the daemon vocabulary). */
export interface PiClient {
  /** One frame as a JSON line, or a string as the raw line it is (a newline is appended). */
  send: (frame: object | string) => Promise<void>;
  /** The next daemon frame not yet read, in arrival order. */
  next: () => Promise<DaemonFrame>;
  /** Every daemon frame that has arrived. */
  received: () => readonly DaemonFrame[];
  /** Resolves once the daemon has closed this connection (or it was closed here). */
  closed: Promise<void>;
  close: () => void;
}

/** What a daemon frame must be, or the test fails loudly: the wire's own parser judges it. */
function daemonFrameOf(value: unknown): DaemonFrame {
  const parsed = parseFrame(DAEMON_FRAMES, JSON.stringify(value));
  if (!parsed.ok) {
    throw new Error(`daemon sent a frame outside the wire: ${parsed.refused.reason}`);
  }
  return parsed.frame;
}

/** `client` as a pi client: `next` walks the received frames one by one. */
function piClientOf(client: LineClient<DaemonFrame>): PiClient {
  let read = 0;
  const closed = client.closed();
  return {
    send: (frame) => client.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`),
    // Frames already received win over the close, so a refusal and its close read in order.
    next: (): Promise<DaemonFrame> => {
      const want = read++;
      return Promise.race([
        client.next((frame) => client.received().indexOf(frame) === want),
        closed.then(() => Promise.reject(new Error("connection closed before the next frame"))),
      ]);
    },
    received: client.received,
    closed,
    close: client.close,
  };
}

/** A `paired` reply that carries a token, with the connection it came on. */
export interface Pairing {
  client: PiClient;
  conversation: string;
  token: string;
}

/** A first line sent, the daemon's first answer, and the connection both rode. */
export interface FirstReply {
  client: PiClient;
  reply: DaemonFrame;
}

export interface BridgeWorld extends BridgeHostWorld {
  /** `<tmp>/room/bridge/bridge.sock`: the daemon creates the two directories. */
  socketPath: string;
  /** A new connection, closed when the test ends. */
  connect: () => Promise<PiClient>;
  /** Connect, send `frame` as the first line, and read the first answer. */
  firstLine: (frame: object | string) => Promise<FirstReply>;
  /** A successful `pair`: the connection, the conversation id and the token. */
  pair: (posture?: Posture, project?: string) => Promise<Pairing>;
  /** A `resume` first line and its answer. */
  resume: (conversation: string, token: string) => Promise<FirstReply>;
  /** The pairing document of `conversation`, read in a commit. */
  pairingOf: (conversation: string) => Promise<PairingDoc>;
  /** The committed pairing document, read without a commit: undefined when none was ever written. */
  storedPairing: (conversation: string) => Promise<Readonly<PairingDoc> | undefined>;
  /** Mutates `conversation`'s pairing document in its own commit, as a later phase's rules would. */
  updatePairing: (conversation: string, change: (doc: PairingDoc) => void) => Promise<void>;
  /** The model ref the conversation's agent document stores, if it stores one. */
  modelOf: (conversation: string) => Promise<string | undefined>;
  /** The conversation's index entry (topic, toolset). */
  entryOf: (conversation: string) => Promise<IndexEntry | undefined>;
  /** The topic's stored record, or undefined when nobody wrote it. */
  topicRecord: (name: string) => Promise<TopicRecord | undefined>;
  /** The conversations the index lists in `topic`, newest first. */
  idsInTopic: (topic: string) => Promise<number[]>;
  /** Every ownerless conversation's id: how a test sees that a refusal created none. */
  allIds: () => Promise<number[]>;
  /** The topics' names, `default` first. */
  topicNames: () => Promise<string[]>;
  /** The conversation through the durable `open` path: whether it stays attachable. */
  openDurable: (conversation: string) => Promise<Conversation>;
  /** A conversation with no pairing: a plain one from the durable `open`. */
  plainConversation: () => Promise<string>;
}

function conversationIdOf(conversation: string): ConversationId {
  const id = Number(conversation);
  if (!isConversationKey(id)) {
    throw new Error(`not a conversation id: ${conversation}`);
  }
  return id;
}

/** The listener on a fresh private socket, with inspection helpers; all closed when the test ends. */
export async function bridgeWorld(): Promise<BridgeWorld> {
  const base = await bridgeHost();
  const { test, host } = base;
  const { dir, cleanup } = await tempDir();
  onTestFinished(cleanup);
  const socketPath = join(dir, "room", "bridge", "bridge.sock");
  const server = await serveBridge({ path: socketPath, host: Promise.resolve(host) });
  onTestFinished(server.close);

  const commit = <T>(run: (tx: Tx) => Promise<T>): Promise<T> => test.harness.commit(run, context);
  const connect = async (): Promise<PiClient> => {
    const client = piClientOf(await lineClient(socketPath, daemonFrameOf));
    onTestFinished(client.close);
    return client;
  };
  const firstLine = async (frame: object | string): Promise<FirstReply> => {
    const client = await connect();
    await client.send(frame);
    return { client, reply: await client.next() };
  };
  return {
    ...base,
    socketPath,
    connect,
    firstLine,
    pair: async (posture = "delegate", project = "proj"): Promise<Pairing> => {
      const { client, reply } = await firstLine({ type: "pair", posture, project });
      if (reply.type !== "paired" || reply.token === undefined) {
        throw new Error(`pair was not answered with a token: ${JSON.stringify(reply)}`);
      }
      return { client, conversation: reply.conversation, token: reply.token };
    },
    resume: (conversation, token) => firstLine({ type: "resume", conversation, token }),
    // A copy: the document a commit hands out is a draft that is dead once the commit ends.
    pairingOf: (conversation) =>
      commit(async (tx): Promise<PairingDoc> => {
        const doc = await pairingDoc(tx, conversationIdOf(conversation));
        return { ...doc, outbox: doc.outbox.map((entry) => ({ ...entry })) };
      }),
    storedPairing: (conversation) => pairingSnapshot(test.harness, conversationIdOf(conversation)),
    updatePairing: (conversation, change) =>
      commit(async (tx) => {
        change(await pairingDoc(tx, conversationIdOf(conversation)));
      }),
    modelOf: (conversation) =>
      commit(async (tx) => {
        const { model } = await tx.doc(AgentDoc, conversationIdOf(conversation));
        return model === undefined ? undefined : refOf(model);
      }),
    entryOf: async (conversation) =>
      storedEntry(await readIndex(test.harness), conversationIdOf(conversation)),
    topicRecord: async (name) => storedTopic(await readIndex(test.harness), name),
    idsInTopic: async (topic) => idsIn(await readIndex(test.harness), topic),
    allIds: async () => (await base.conversations.list({ kind: "all" })).ids,
    topicNames: async () => (await base.conversations.topics()).map((topic) => topic.name),
    openDurable: (conversation) =>
      base.conversations.open({ kind: "existing", id: conversationIdOf(conversation) }),
    plainConversation: async () => String((await base.conversations.open({ kind: "new" })).id),
  };
}
