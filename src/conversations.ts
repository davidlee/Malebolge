// Which conversation a wire reference names: `root`, the one an id names, a new
// one carrying the daemon's creation defaults, or the latest in a named topic.
// `runner/durable-ids.ts` answers the other half of the id question (recover the
// branded id from the runner's TEXT column); this module answers the daemon's,
// from the attach frame.
//
// Invariants (design sec-1, sec-3): a non-root conversation's model and cwd are
// the daemon's creation-time defaults, and its stored agent settings are never
// rewritten; a conversation id names a conversation only inside this profile's
// store; a topic's directory is read once, at creation, and written only into
// that conversation (D1); no frame ever creates a topic implicitly (DEC-016);
// `cwd` is an opaque string handed to pi, confinement being the jail's (DEC-107,
// CON-005).

import {
  type AgentChange,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationInit,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { Profile } from "./config.ts";
import { context } from "./context.ts";
import type { AttachTarget, ListQuery } from "./protocol.ts";
import type { Session } from "./session.ts";
import {
  assignTopic,
  idsIn,
  type IndexDoc,
  latestIn,
  type NamedTopic,
  readIndex,
  isKnownTopic,
  storedTopic,
  topicsOf,
  writeTopicRecord,
} from "./topics.ts";

/** The daemon's creation defaults; `cwd` is required so the fallback is always a string. */
export type ConversationDefaults = AgentChange & { cwd: string };

/** What a `topic` write names: the name, and the directory to set, leave, or clear. */
export interface TopicWrite {
  name: string;
  cwd?: string | null;
}

export interface Conversations {
  root: Conversation;
  /** The daemon's own execution profile: the path space a topic's `cwd` lives in (design sec-4). */
  readonly profile: Profile;
  /** The conversation `target` names, or created; rejects with a client-facing message. */
  open(target: AttachTarget): Promise<Conversation>;
  /** The event stream of `conversation`: the transport's only route to the Harness. */
  watch(conversation: Conversation): Promise<AgentEventStream>;
  /**
   * One page of this store's conversations, `all` or one `topic`'s; a plain
   * value, never a wire reply (design sec-4, EX-8).
   */
  list(query: PageQuery): Promise<ConversationPage>;
  /** Every topic, `default` first, then by name (design sec-4, EX-8). */
  topics(): Promise<readonly NamedTopic[]>;
  /** Create one topic, set its directory, or leave it unchanged; the record written. */
  setTopic(topic: TopicWrite): Promise<NamedTopic>;
}

/** A listing that answers with one page of ids; `topics` answers with records instead. */
export type PageQuery = Exclude<ListQuery, { kind: "topics" }>;

/** Conversations read per listing page: small, so a listing never stalls the turn chain. */
export const LIST_PAGE = 50;

/** One page of a listing: the ids newest first, and whether the page was cut. */
export interface ConversationPage {
  ids: number[];
  truncated: boolean;
}

/** The safe positive integer the wire parser accepts, as pi's branded id. */
export function isConversationKey(n: number): n is ConversationId {
  return Number.isSafeInteger(n) && n > 0;
}

/** A target no conversation in this store answers to. */
const noConversation = (id: number): Error => new Error(`no conversation ${String(id)}`);

/** A topic no write ever made: attaching to one starts nothing (DEC-016). */
const noTopic = (name: string): Error => new Error(`no topic ${name}`);

/** One read, then ownership: pi's record is the only source of the id kept. */
async function resolveExisting(session: Session, id: ConversationId): Promise<Conversation> {
  const record = await session.harness.commit((tx) => tx.conversation(id), context);
  if (record === undefined) {
    throw noConversation(id);
  }
  if (record.owner !== undefined) {
    throw new Error(`conversation ${String(id)} belongs to a task`);
  }
  const conversation = await session.harness.conversation(record.id, context);
  if (conversation === undefined) {
    throw noConversation(id);
  }
  return conversation;
}

/** A new ownerless conversation: model, cwd and the topic entry land in one commit. */
function create(
  session: Session,
  defaults: ConversationDefaults,
  cwd: string,
  init?: ConversationInit,
): Promise<Conversation> {
  return session.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { ...defaults, cwd },
      ...(init === undefined ? {} : { init }),
    },
    context,
  );
}

/** The index, with `name` known: `default` always is, a topic nobody wrote is refused. */
async function indexOfTopic(session: Session, name: string): Promise<IndexDoc> {
  const index = await readIndex(session.harness);
  if (!isKnownTopic(index, name)) {
    throw noTopic(name);
  }
  return index;
}

/** The directory a conversation born in `target`'s topic starts in: client, topic, daemon. */
function creationCwd(
  index: IndexDoc,
  target: Extract<AttachTarget, { kind: "topic" }>,
  defaults: ConversationDefaults,
): string {
  return target.cwd ?? storedTopic(index, target.name)?.cwd ?? defaults.cwd;
}

/** The conversation a `topic` target binds: its latest, or a first one in that topic. */
async function openTopic(
  session: Session,
  defaults: ConversationDefaults,
  target: Extract<AttachTarget, { kind: "topic" }>,
): Promise<Conversation> {
  const index = await indexOfTopic(session, target.name);
  const latest = target.new ? undefined : latestIn(index, target.name);
  if (latest !== undefined) {
    if (!isConversationKey(latest)) {
      throw noConversation(latest);
    }
    return resolveExisting(session, latest);
  }
  return create(session, defaults, creationCwd(index, target, defaults), assignTopic(target.name));
}

/** `run`, one call at a time: each starts once the one before it settles, failed or not. */
function serially<A extends readonly unknown[], R>(
  run: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args) => {
    const result = tail.then(() => run(...args));
    tail = result.catch(() => undefined);
    return result;
  };
}

/** One page of this store's ownerless conversations, newest first (the SL-002 read). */
async function scanPage(session: Session): Promise<ConversationPage> {
  // One read, one page, no cursor kept: `next` means the page was cut, not "keep going".
  const page = await session.harness.commit(
    (tx) => tx.scanConversations({ order: "descending" }, LIST_PAGE),
    context,
  );
  return {
    // A task-owned conversation is refused at attach, so listing one would be noise.
    ids: page.items.filter((record) => record.owner === undefined).map((record) => record.id),
    truncated: page.next !== undefined,
  };
}

/** One topic's conversations, newest first, cut at `LIST_PAGE` like every page. */
async function topicPage(session: Session, name: string): Promise<ConversationPage> {
  const ids = idsIn(await indexOfTopic(session, name), name);
  return { ids: ids.slice(0, LIST_PAGE), truncated: ids.length > LIST_PAGE };
}

export function conversations(
  session: Session,
  defaults: ConversationDefaults,
  profile: Profile,
): Conversations {
  // The find and the create are two commits: two attaches to an empty topic must
  // not each find it empty. One daemon owns the store, so in-process order suffices.
  const openTopicSerially = serially(openTopic);
  return {
    root: session.root,
    profile,
    open: async (target): Promise<Conversation> => {
      switch (target.kind) {
        case "root":
          return session.root;
        case "existing": {
          const { id } = target;
          if (!isConversationKey(id)) {
            throw noConversation(id);
          }
          return resolveExisting(session, id);
        }
        case "new":
          return create(session, defaults, target.cwd ?? defaults.cwd);
        case "topic":
          return openTopicSerially(session, defaults, target);
      }
    },
    watch: (conversation) => watchEvents(session.harness, conversation.id, context),
    list: async (query): Promise<ConversationPage> => {
      switch (query.kind) {
        case "all":
          return scanPage(session);
        case "topic":
          return topicPage(session, query.name);
      }
    },
    topics: async () => topicsOf(await readIndex(session.harness)),
    setTopic: (topic) => writeTopicRecord(session.harness, topic.name, topic.cwd),
  };
}
