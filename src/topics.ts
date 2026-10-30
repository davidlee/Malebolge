// The conversation index: which topic each ownerless conversation belongs to,
// and which conversation a fork came from. This module is the index's only
// owner — nothing else names `IndexDocument` — so "the index and the store
// diverge" stays a one-file question.
//
// Invariants (design sec-2, sec-3; DEC-012, DEC-013, DEC-015):
//
// - The creating commit writes the entry: `conversationCreated` runs in every
//   commit that creates or forks a conversation, so an unindexed ownerless
//   conversation cannot exist.
// - An entry is merged, never replaced, so keys a later slice adds survive
//   every index write.
// - `default` always exists and is never stored in `topics`.
// - `cwd` is an opaque string (DEC-107); this module never resolves a path.

/* eslint-disable @typescript-eslint/consistent-type-definitions -- index values are JSON:
   `defineDoc` constrains the document to `JsonObject`, which only a type alias with an implicit
   index signature satisfies. */
import {
  type ConversationId,
  type ConversationRecord,
  type Cursor,
  defineDoc,
  type Session,
  type Tx,
} from "@earendil-works/pi-durable";
import { context } from "./context.ts";
import { DEFAULT_TOPIC, type ThreadMark } from "./protocol.ts";
import type { DaemonToolset } from "./toolsets.ts";

/**
 * What storage may hold for a toolset: a daemon toolset, or the `bridge` toolset SL-009
 * stored, which SL-011's reconcile retires to `interactive` (design sec-3; DEC-101).
 */
export type StoredToolset = DaemonToolset | "bridge";

/**
 * One conversation's place in the index; `parent` is the conversation it was forked
 * from, `startedBy` the one whose `thread_start` created it, and `toolset` the set its
 * extensions are derived from (design sec-3, sec-12).
 */
export type IndexEntry = {
  topic: string;
  parent?: number;
  startedBy?: number;
  toolset: DaemonToolset;
};

/**
 * What storage holds before the reconcile backfills it: an entry the hook wrote,
 * which carries no toolset, or one written before this slice. The reconcile's
 * step 1 writes the toolset; every reader after it sees an `IndexEntry`.
 */
type StoredEntry = Omit<IndexEntry, "toolset"> & { toolset?: StoredToolset };

/**
 * What a topic carries: its directory (D3), the toolset its conversations take, and the
 * model they take (design sec-3).
 */
export type TopicRecord = { cwd?: string; toolset?: DaemonToolset; model?: string };

/** A topic as storage holds it: as `TopicRecord`, with the toolset the reconcile retires. */
export type StoredTopicRecord = Omit<TopicRecord, "toolset"> & { toolset?: StoredToolset };

/** A topic write: an absent key is unchanged, `null` clears it, a value sets it. */
export type TopicChange = {
  cwd?: string | null | undefined;
  toolset?: DaemonToolset | null | undefined;
  /** A ref the catalog judges before the write lands; stored exactly as given. */
  model?: string | null | undefined;
};

/** The whole index, one session-scoped document. */
export type IndexDoc = {
  topics: Record<string, StoredTopicRecord>;
  conversations: Record<string, StoredEntry>;
};

/** A topic as a listing shows it: the name it is filed under, and its directory. */
export type NamedTopic = TopicRecord & { name: string };

/** Conversations per backfill read: bounds each storage read, not the commit, which reads every page. */
export const BACKFILL_PAGE = 64;

/** The index document: session scope, so a fork never copies it, and one checkpoint every 50 deltas. */
export const IndexDocument = defineDoc<IndexDoc>({
  kind: "malebolge.index",
  version: 1,
  scope: "session",
  initial: () => ({ topics: {}, conversations: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** The keys a create writes into `id`'s entry; a key it leaves out keeps the entry's own. */
export type EntryChange = {
  topic: string;
  parent?: ConversationId;
  startedBy?: ConversationId;
  toolset?: DaemonToolset;
};

/**
 * Set `change`'s keys on conversation `id`'s entry, keeping every other key it
 * carries, so a field a later slice writes (D4's titles, archive flags) survives.
 */
export function writeEntry(index: IndexDoc, id: ConversationId, change: EntryChange): void {
  const key = String(id);
  index.conversations[key] = { ...index.conversations[key], ...change };
}

/**
 * The `conversationCreated` hook (DEC-012): the entry every commit that creates
 * or forks a conversation writes. A fork copies its parent entry's topic and
 * toolset, so it runs on its parent's set; a parent with no entry or no toolset
 * throws, which fails the forking commit, so a fork without a toolset is never
 * written (design sec-3). It reads documents only, never a table, so
 * `ReadAfterWrite` cannot fire; a throw fails the creating commit.
 */
export async function indexConversation(tx: Tx, record: ConversationRecord): Promise<void> {
  if (record.owner !== undefined) {
    // Task-owned: refused at attach, so it is no topic's conversation.
    return;
  }
  const index = await tx.doc(IndexDocument);
  const parent = record.parent;
  if (parent === undefined) {
    writeEntry(index, record.id, { topic: DEFAULT_TOPIC });
    return;
  }
  const entry = ownKey(index.conversations, String(parent.conversationId));
  if (entry?.toolset === undefined) {
    throw new Error(
      `conversation ${String(record.id)}: fork of ${String(parent.conversationId)}, which has no toolset`,
    );
  }
  writeEntry(index, record.id, {
    topic: entry.topic,
    parent: parent.conversationId,
    toolset: liveToolset(entry.toolset),
  });
}

/**
 * Write what a create puts in `id`'s entry: its topic, its `startedBy` when a thread
 * tool started it, and the toolset `choose` picks from the topic's record — read here,
 * in the creating commit, never before it (design sec-3, sec-4, sec-12). Returns the
 * toolset it wrote, for the selection, and the record it read, so the creating commit
 * also takes the topic's model from that one read.
 */
export async function writeCreated(
  tx: Tx,
  id: ConversationId,
  topic: string | undefined,
  choose: (record: TopicRecord | undefined) => DaemonToolset,
  startedBy?: ConversationId,
): Promise<{ toolset: DaemonToolset; record: TopicRecord | undefined }> {
  const index = await tx.doc(IndexDocument);
  const record = topic === undefined ? undefined : storedTopic(index, topic);
  const toolset = choose(record);
  writeEntry(index, id, {
    topic: topic ?? DEFAULT_TOPIC,
    toolset,
    ...(startedBy === undefined ? {} : { startedBy }),
  });
  return { toolset, record };
}

/**
 * `t` as the live daemon toolset it is: the `bridge` toolset SL-009 stored is retired
 * to `interactive`, every other one is itself (design sec-3; DEC-101). The comparison
 * narrows the union, so no cast is needed (VA-1).
 */
export function liveToolset(t: StoredToolset): DaemonToolset {
  return t === "bridge" ? "interactive" : t;
}

/**
 * `record` as a live topic record: a retired toolset reads as its live one, and every
 * other key it carries is kept (design sec-3; DEC-101).
 */
function liveTopic(record: StoredTopicRecord): TopicRecord {
  const { toolset, ...rest } = record;
  return toolset === undefined ? rest : { ...rest, toolset: liveToolset(toolset) };
}

/**
 * What every read of the index needs: a session's snapshots, unchanged, so an
 * `EnvTarget`'s reader (or a stub) passes as it is.
 */
export type IndexReader = Pick<Session, "snapshot">;

/**
 * `record[key]` when `record` owns the key. An own-key read, not an inherited
 * one: `constructor` is a valid topic name, and every object literal inherits
 * it.
 */
function ownKey<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Whether `name` is a topic: `default` always is; another only once someone wrote it. */
export function isKnownTopic(index: IndexDoc, name: string): boolean {
  return name === DEFAULT_TOPIC || storedTopic(index, name) !== undefined;
}

/** `name`'s stored record, or undefined when nobody wrote it; a retired toolset reads live. */
export function storedTopic(index: IndexDoc, name: string): TopicRecord | undefined {
  const record = ownKey(index.topics, name);
  return record === undefined ? undefined : liveTopic(record);
}

/**
 * `id`'s reconciled index entry, or undefined when nobody wrote one (a task-owned
 * conversation, which is no topic's, DEC-012) or when its toolset is missing —
 * which the reconcile's backfill makes unreachable after startup, so a reader
 * that runs later never sees the second case.
 */
export function storedEntry(index: IndexDoc, id: ConversationId): IndexEntry | undefined {
  const entry = ownKey(index.conversations, String(id));
  const toolset = entry?.toolset;
  if (entry === undefined || toolset === undefined) {
    return undefined;
  }
  return { ...entry, toolset: liveToolset(toolset) };
}

/**
 * The one read of the document. `snapshot` does not apply `initial()`, so an
 * absent index — a store no hook ever wrote — reads as the initial document
 * here, once, for every topic listing.
 */
export async function readIndex(session: IndexReader): Promise<IndexDoc> {
  return (await session.snapshot(IndexDocument, context)) ?? IndexDocument.definition.initial();
}

/**
 * The index as a commit reads it, for a caller that must read it before any table
 * write (the reconcile's step 0). The module stays `IndexDocument`'s only owner.
 */
export function readIndexDoc(tx: Tx): Promise<IndexDoc> {
  return tx.doc(IndexDocument);
}

/** The keys a topic record carries, in write order. */
const KEYS = ["cwd", "toolset", "model"] as const;

/** `record` with `key` removed: what a cleared key leaves. */
function without(record: TopicRecord, key: keyof TopicRecord): TopicRecord {
  const rest = { ...record };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the record's own keys, every one optional
  delete rest[key];
  return rest;
}

/** `current` after a write of `value` to `key`: unchanged, cleared, or carrying the new value. */
function written(
  current: TopicRecord,
  key: keyof TopicRecord,
  value: string | null | undefined,
): TopicRecord {
  if (value === undefined) {
    return current;
  }
  return value === null ? without(current, key) : { ...current, [key]: value };
}

/** `current` with every key `change` names merged as `written` does. */
function merged(current: TopicRecord, change: TopicChange): TopicRecord {
  let record = current;
  for (const key of KEYS) {
    record = written(record, key, change[key]);
  }
  return record;
}

/**
 * Write `name`'s record in one commit (design sec-4's `topic` frame): absent keys
 * create the topic or leave its record as it is, a value sets one, `null` clears
 * it. Merged, never replaced, so a key a later slice adds survives; the name is
 * the caller's, already checked by the parser.
 */
export async function writeTopicRecord(
  session: Pick<Session, "commit">,
  name: string,
  change: TopicChange,
): Promise<NamedTopic> {
  if (name === DEFAULT_TOPIC) {
    // DEC-015 restated where the write lands, not only in the parser.
    throw new Error("topic: default is reserved");
  }
  return session.commit(async (tx) => {
    const index = await tx.doc(IndexDocument);
    const record = merged(storedTopic(index, name) ?? {}, change);
    index.topics[name] = record;
    return { name, ...record };
  }, context);
}

/**
 * Index the conversations created before this slice (D7), root included: one
 * commit, paged reads, and every read before the first write. A fork's entry
 * carries its parent; an entry an earlier backfill wrote without one gets it,
 * merged, so its topic and every other key survive.
 */
export async function backfillIndex(session: Pick<Session, "commit">): Promise<void> {
  await session.commit(async (tx) => {
    const index = await tx.doc(IndexDocument);
    for (const record of await unbackfilled(tx, index)) {
      const topic = index.conversations[String(record.id)]?.topic ?? DEFAULT_TOPIC;
      const parent = record.parent?.conversationId;
      writeEntry(index, record.id, {
        topic,
        ...(parent === undefined ? {} : { parent }),
      });
    }
  }, context);
}

/** Whether `record`'s entry is missing, or lacks the parent the record carries. */
function needsBackfill(index: IndexDoc, record: ConversationRecord): boolean {
  const entry = index.conversations[String(record.id)];
  return entry === undefined || (record.parent !== undefined && entry.parent === undefined);
}

/**
 * Every conversation in the store, oldest first: the one paged read the backfill
 * and the reconcile share (design sec-3).
 */
export async function scanAll(tx: Tx): Promise<ConversationRecord[]> {
  const records: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  // The cursor loop of `runner/durable-ids.ts`: page until `next` is undefined.
  do {
    const page = await tx.scanConversations({ order: "ascending" }, BACKFILL_PAGE, cursor);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return records;
}

/** Every ownerless conversation whose entry the backfill must write, oldest first. */
async function unbackfilled(tx: Tx, index: IndexDoc): Promise<readonly ConversationRecord[]> {
  return (await scanAll(tx)).filter(
    (record) => record.owner === undefined && needsBackfill(index, record),
  );
}

/**
 * The reconcile's read of the entries `ids` name (design sec-3, steps 1-2): an
 * entry that carries no toolset takes `fallback`, written here — the backfill of
 * a store written before this slice — and a stored `bridge` toolset is retired to
 * the live one it reads as, on entries and topics alike (DEC-101). Both rewrites
 * land in this commit. Every id's toolset comes back with every stored topic and
 * the names of the topics it retired, in name order; a missing entry is an
 * invariant breach (an ownerless conversation is indexed by its creating commit),
 * and the allowed checks are the caller's.
 */
export async function entryToolsets(
  tx: Tx,
  ids: readonly ConversationId[],
  fallback: DaemonToolset,
): Promise<{
  entries: readonly { id: ConversationId; toolset: DaemonToolset }[];
  topics: readonly NamedTopic[];
  retired: readonly string[];
}> {
  const index = await tx.doc(IndexDocument);
  const entries = ids.map((id) => {
    const entry = ownKey(index.conversations, String(id));
    if (entry === undefined) {
      throw new Error(`conversation ${String(id)} has no index entry`);
    }
    const stored = entry.toolset;
    const toolset = stored === undefined ? fallback : liveToolset(stored);
    if (toolset !== stored) {
      writeEntry(index, id, { topic: entry.topic, toolset });
    }
    return { id, toolset };
  });
  // Retire first, so the topics read below already see the live toolsets as written.
  const retired = retireTopics(index);
  return { entries, topics: topicsOf(index).slice(1), retired };
}

/**
 * The same retirement for the stored topics (design sec-3; DEC-101): each one whose
 * toolset is retired takes the live toolset, written back beside the keys it already
 * carries, and comes back by name, so the caller's log follows no insertion order.
 */
function retireTopics(index: IndexDoc): readonly string[] {
  const retired: string[] = [];
  for (const [name, record] of Object.entries(index.topics)) {
    const stored = record.toolset;
    if (stored === undefined || liveToolset(stored) === stored) {
      continue;
    }
    index.topics[name] = { ...record, toolset: liveToolset(stored) };
    retired.push(name);
  }
  // Code-unit order, as `byName` compares: never a locale's.
  return retired.sort();
}

/** Topic names in code-unit order, so a listing never depends on a locale. */
function byName(a: NamedTopic, b: NamedTopic): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

/** Every topic a listing shows: `default` first, then by name; a retired toolset reads live. */
export function topicsOf(index: IndexDoc): readonly NamedTopic[] {
  const stored = Object.entries(index.topics)
    .map(([name, record]): NamedTopic => ({ name, ...liveTopic(record) }))
    .sort(byName);
  return [{ name: DEFAULT_TOPIC }, ...stored];
}

/** The ids in `topic`, newest first. */
export function idsIn(index: IndexDoc, topic: string): number[] {
  return Object.keys(index.conversations)
    .filter((key) => index.conversations[key]?.topic === topic)
    .map((key) => Number(key))
    .sort((a, b) => b - a);
}

/**
 * What created a conversation a thread tool made — its fork's parent, or the
 * conversation whose `thread_start` started it — and nothing for an operator's own
 * entry (DEC-037).
 */
export function markOf(entry: StoredEntry): ThreadMark | undefined {
  if (entry.parent !== undefined) {
    return { forkOf: entry.parent };
  }
  return entry.startedBy === undefined ? undefined : { startedBy: entry.startedBy };
}

/** A conversation a thread tool created: a fork, or a thread_start's child (DEC-037). */
export const isThread = (entry: StoredEntry): boolean => markOf(entry) !== undefined;

/** The highest id in `topic` that no thread tool created: its latest (DEC-015, DEC-037). */
export function latestIn(index: IndexDoc, topic: string): number | undefined {
  return idsIn(index, topic).find((id) => {
    const entry = ownKey(index.conversations, String(id));
    return entry !== undefined && !isThread(entry);
  });
}
