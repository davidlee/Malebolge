// Which conversation a wire reference names: `root`, the one an id names, a new
// one carrying the daemon's creation defaults, or the latest in a named topic.
// `runner/durable-ids.ts` answers the other half of the id question (recover the
// branded id from the runner's TEXT column); this module answers the daemon's,
// from the attach frame.
//
// Invariants (design sec-1, sec-3, sec-4): a non-root conversation's model and cwd
// are its topic's, else the daemon's creation-time defaults, and its stored agent
// settings are never rewritten; a conversation id names a conversation only inside
// this profile's store; a topic's directory and model are read once, at creation,
// and written only into that conversation (D1, DEC-083); no frame ever creates a
// topic implicitly (DEC-016);
// `cwd` is an opaque string handed to pi, confinement being the jail's (DEC-107,
// CON-005).

import {
  type AgentChange,
  AgentDoc,
  type AgentEventStream,
  type Conversation,
  configure,
  type ConversationId,
  type ConversationInit,
  type Tx,
  watchEvents,
} from "@earendil-works/pi-durable";
import type { Profile } from "./config.ts";
import { context } from "./context.ts";
import { creationModel, type ModelCatalog, type ModelRef, refOf } from "./models.ts";
import {
  type AttachTarget,
  type ConversationSummary,
  type ListQuery,
  type ThreadMark,
} from "./protocol.ts";
import type { Session } from "./session.ts";
import {
  idsIn,
  type IndexDoc,
  isKnownTopic,
  latestIn,
  markOf,
  type NamedTopic,
  readIndex,
  readIndexDoc,
  storedTopic,
  topicsOf,
  writeCreated,
  writeTopicRecord,
} from "./topics.ts";
import {
  type DaemonToolset,
  PROFILE_TOOLSETS,
  requireAllowed,
  selectionOf,
  toolsetList,
} from "./toolsets.ts";

/** The daemon's creation defaults; `cwd` and `model` are required, so neither fallback is a cast. */
export type ConversationDefaults = AgentChange & { cwd: string; model: ModelRef };

/** What a `topic` write names: the name, and the directory, toolset and model to set, leave, or clear. */
export interface TopicWrite {
  name: string;
  cwd?: string | null;
  /** A name is checked against the profile's policy; `null` clears it; absent leaves it. */
  toolset?: string | null;
  /** A ref the gateway catalog judges; `null` clears it; absent leaves it (DEC-086). */
  model?: string | null;
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

/** A listing that answers with one page of ids; `topics` and `models` answer with records instead. */
export type PageQuery = Exclude<ListQuery, { kind: "topics" } | { kind: "models" }>;

/** Conversations read per listing page: small, so a listing never stalls the turn chain. */
export const LIST_PAGE = 50;

/** One page of a listing: the ids newest first, the cut, the threads' marks and every id's summary. */
export interface ConversationPage {
  ids: number[];
  truncated: boolean;
  /** Present when an id on the page is a thread: its mark, by id. */
  marks?: Record<string, ThreadMark>;
  /** Every listed id's topic and, when it has one, its model ref. */
  summaries: Record<string, ConversationSummary>;
}

/**
 * The marks of a page's `ids`, read from an index: absent when no id is a thread, so a
 * page with none keeps the frame's shape (DEC-007).
 */
function marksOf(index: IndexDoc, ids: readonly number[]): Record<string, ThreadMark> | undefined {
  const marks: Record<string, ThreadMark> = {};
  for (const id of ids) {
    const entry = index.conversations[String(id)];
    const mark = entry === undefined ? undefined : markOf(entry);
    if (mark !== undefined) {
      marks[String(id)] = mark;
    }
  }
  return Object.keys(marks).length === 0 ? undefined : marks;
}

/**
 * The summaries of a page's `ids`, read in its commit: each id's topic from the index,
 * and the model ref its agent document stores, when it stores one. An id the index does
 * not know gets no summary at all.
 */
async function summariesOf(
  tx: Tx,
  index: IndexDoc,
  ids: readonly number[],
): Promise<Record<string, ConversationSummary>> {
  const summaries: Record<string, ConversationSummary> = {};
  for (const id of ids) {
    const topic = index.conversations[String(id)]?.topic;
    if (topic === undefined || !isConversationKey(id)) {
      continue;
    }
    const { model } = await tx.doc(AgentDoc, id);
    // `exactOptionalPropertyTypes`: an unset model is no key, not `model: undefined`.
    const ref = model === undefined ? undefined : refOf(model);
    summaries[String(id)] = ref === undefined ? { topic } : { topic, model: ref };
  }
  return summaries;
}

/** `ids` as a page, carrying `marks` only when there are any. */
function pageOf(
  ids: number[],
  truncated: boolean,
  marks: ConversationPage["marks"],
  summaries: Record<string, ConversationSummary>,
): ConversationPage {
  return marks === undefined ? { ids, truncated, summaries } : { ids, truncated, marks, summaries };
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

/**
 * The `thread_start` caller's standing (design sec-12): the conversation whose
 * thread_start created the one being made, and the judgement on the toolset the
 * creating commit chose.
 */
export interface StartedThread {
  /** The calling conversation, written as the entry's startedBy. */
  startedBy: ConversationId;
  /** Refuses a chosen toolset outside the caller's talk set, inside the creating commit. */
  require: (toolset: DaemonToolset) => void;
}

/**
 * The `init` every create passes (design sec-3, sec-4): the topic's toolset and model,
 * else the profile's and the daemon's defaults, checked against `policy` and selected in
 * the creating commit — the entry it writes and the model and selection it configures
 * are one read. A `thread` makes it a thread_start's child: its `require` judges the
 * toolset chosen inside the commit, so a refusal throws there and nothing is created.
 */
export function topicInit(
  profile: Profile,
  topic: string | undefined,
  catalog: ModelCatalog,
  fallback: ModelRef,
  thread?: StartedThread,
): ConversationInit {
  const policy = PROFILE_TOOLSETS[profile];
  return async (tx, conversationId) => {
    const { toolset, record } = await writeCreated(
      tx,
      conversationId,
      topic,
      (record) => {
        const chosen = record?.toolset ?? policy.default;
        requireAllowed(chosen, profile, policy);
        thread?.require(chosen);
        return chosen;
      },
      thread?.startedBy,
    );
    await configure(tx, conversationId, {
      extensions: selectionOf(toolsetList(toolset, profile)),
      // The creating commit's own read of the topic's model, else the default (DEC-083).
      model: creationModel({ topic: record?.model, fallback }, catalog.require),
    });
  };
}

/** A new ownerless conversation: model, cwd, the topic entry and its selection in one commit. */
function create(
  session: Session,
  defaults: ConversationDefaults,
  cwd: string,
  init: ConversationInit,
): Promise<Conversation> {
  return session.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { ...defaults, cwd }, init },
    context,
  );
}

/** `index`, with `name` known in it: `default` always is, a topic nobody wrote is refused. */
function knownTopicIn(index: IndexDoc, name: string): IndexDoc {
  if (!isKnownTopic(index, name)) {
    throw noTopic(name);
  }
  return index;
}

/** The index, with `name` known: `default` always is, a topic nobody wrote is refused. */
async function indexOfTopic(session: Session, name: string): Promise<IndexDoc> {
  return knownTopicIn(await readIndex(session.harness), name);
}

/**
 * The directory a conversation born in `topic` starts in: the client's when it asked
 * for one, else the topic's, else the daemon's (D1, EX-2). Thread tools take it too.
 */
export function topicCwd(
  index: IndexDoc,
  topic: string,
  defaults: ConversationDefaults,
  requested?: string,
): string {
  return requested ?? storedTopic(index, topic)?.cwd ?? defaults.cwd;
}

/** The conversation a `topic` target binds: its latest, or a first one in that topic. */
async function openTopic(
  session: Session,
  profile: Profile,
  defaults: ConversationDefaults,
  target: Extract<AttachTarget, { kind: "topic" }>,
  catalog: ModelCatalog,
): Promise<Conversation> {
  const index = await indexOfTopic(session, target.name);
  const latest = target.new ? undefined : latestIn(index, target.name);
  if (latest !== undefined) {
    if (!isConversationKey(latest)) {
      throw noConversation(latest);
    }
    return resolveExisting(session, latest);
  }
  const cwd = topicCwd(index, target.name, defaults, target.cwd);
  return create(session, defaults, cwd, topicInit(profile, target.name, catalog, defaults.model));
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
  // The index is read in the same commit, so its marks and summaries describe exactly
  // the ids this page holds.
  const { ids, marks, summaries, truncated } = await session.harness.commit(async (tx) => {
    const page = await tx.scanConversations({ order: "descending" }, LIST_PAGE);
    // A task-owned conversation is refused at attach, so listing one would be noise.
    const pageIds = page.items
      .filter((record) => record.owner === undefined)
      .map((record) => record.id);
    const index = await readIndexDoc(tx);
    return {
      ids: pageIds,
      marks: marksOf(index, pageIds),
      summaries: await summariesOf(tx, index, pageIds),
      truncated: page.next !== undefined,
    };
  }, context);
  return pageOf(ids, truncated, marks, summaries);
}

/** One topic's conversations, newest first, cut at `LIST_PAGE` like every page. */
async function topicPage(session: Session, name: string): Promise<ConversationPage> {
  // One commit: the refused-or-known index, the ids it yields and their summaries are
  // one read, so a topic written mid-listing cannot split the page from its summaries.
  const { ids, marks, summaries, truncated } = await session.harness.commit(async (tx) => {
    const index = knownTopicIn(await readIndexDoc(tx), name);
    const all = idsIn(index, name);
    const page = all.slice(0, LIST_PAGE);
    return {
      ids: page,
      marks: marksOf(index, page),
      summaries: await summariesOf(tx, index, page),
      truncated: all.length > LIST_PAGE,
    };
  }, context);
  return pageOf(ids, truncated, marks, summaries);
}

/** `write`'s toolset as the index stores it: absent leaves it, `null` clears it, a name is judged. */
function toolsetChange(write: TopicWrite, profile: Profile): DaemonToolset | null | undefined {
  const { toolset } = write;
  if (toolset === undefined || toolset === null) {
    return toolset;
  }
  // The profile's policy, not the frame, decides which names a topic may take.
  return requireAllowed(toolset, profile);
}

/**
 * `write`'s model as the index stores it: absent leaves it, `null` clears it, a ref is
 * judged by the catalog. A refusal throws before the write, so nothing is written.
 */
function modelChange(write: TopicWrite, catalog: ModelCatalog): string | null | undefined {
  const { model } = write;
  if (model === undefined || model === null) {
    return model;
  }
  // The catalog owns which refs exist; the ref is stored as given, not as its pieces.
  catalog.require(model);
  return model;
}

export function conversations(
  session: Session,
  defaults: ConversationDefaults,
  profile: Profile,
  catalog: ModelCatalog,
): Conversations {
  // The find and the create are two commits: two attaches to an empty topic must
  // not each find it empty. One daemon owns the store, so in-process order suffices.
  const openTopicSerially = serially(
    (target: Extract<AttachTarget, { kind: "topic" }>): Promise<Conversation> =>
      openTopic(session, profile, defaults, target, catalog),
  );
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
          return create(
            session,
            defaults,
            target.cwd ?? defaults.cwd,
            topicInit(profile, undefined, catalog, defaults.model),
          );
        case "topic":
          return openTopicSerially(target);
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
    setTopic: (topic) =>
      writeTopicRecord(session.harness, topic.name, {
        cwd: topic.cwd,
        toolset: toolsetChange(topic, profile),
        model: modelChange(topic, catalog),
      }),
  };
}
