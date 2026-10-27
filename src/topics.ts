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
  type ConversationInit,
  type ConversationRecord,
  type Cursor,
  defineDoc,
  type Session,
  type Tx,
} from "@earendil-works/pi-durable";
import { context } from "./context.ts";
import { DEFAULT_TOPIC } from "./protocol.ts";

/** One conversation's place in the index; `parent` is the conversation it was forked from. */
export type IndexEntry = { topic: string; parent?: number };

/** What a topic carries: its directory, when it has one (D3). */
export type TopicRecord = { cwd?: string };

/** The whole index, one session-scoped document. */
export type IndexDoc = {
  topics: Record<string, TopicRecord>;
  conversations: Record<string, IndexEntry>;
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

/**
 * Set conversation `id`'s topic, keeping every other key its entry carries, so
 * a field a later slice writes (D4's titles, archive flags) survives.
 */
function writeTopic(
  index: IndexDoc,
  id: ConversationId,
  topic: string,
  parent?: ConversationId,
): void {
  const key = String(id);
  index.conversations[key] = {
    ...index.conversations[key],
    topic,
    ...(parent === undefined ? {} : { parent }),
  };
}

/**
 * The `conversationCreated` hook (DEC-012): the entry every commit that creates
 * or forks a conversation writes. It reads documents only, never a table, so
 * `ReadAfterWrite` cannot fire; a throw fails the creating commit.
 */
export async function indexConversation(tx: Tx, record: ConversationRecord): Promise<void> {
  if (record.owner !== undefined) {
    // Task-owned: refused at attach, so it is no topic's conversation.
    return;
  }
  const index = await tx.doc(IndexDocument);
  const parent = record.parent;
  const topic =
    parent === undefined
      ? DEFAULT_TOPIC
      : (index.conversations[String(parent.conversationId)]?.topic ?? DEFAULT_TOPIC);
  writeTopic(index, record.id, topic, parent?.conversationId);
}

/** The `init` a caller naming a topic passes: it runs after the hook and overwrites the topic. */
export function assignTopic(name: string): ConversationInit {
  return async (tx, conversationId) => {
    writeTopic(await tx.doc(IndexDocument), conversationId, name);
  };
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

/** `name`'s stored record, or undefined when nobody wrote it. */
export function storedTopic(index: IndexDoc, name: string): TopicRecord | undefined {
  return ownKey(index.topics, name);
}

/**
 * `id`'s index entry, or undefined when nobody wrote one: a task-owned
 * conversation, which is no topic's (DEC-012).
 */
export function storedEntry(index: IndexDoc, id: ConversationId): IndexEntry | undefined {
  return ownKey(index.conversations, String(id));
}

/**
 * The one read of the document. `snapshot` does not apply `initial()`, so an
 * absent index — a store no hook ever wrote — reads as the initial document
 * here, once, for every topic listing.
 */
export async function readIndex(session: IndexReader): Promise<IndexDoc> {
  return (await session.snapshot(IndexDocument, context)) ?? IndexDocument.definition.initial();
}

/** `record` with its directory removed: what a cleared topic keeps. */
function withoutCwd(record: TopicRecord): TopicRecord {
  const rest = { ...record };
  delete rest.cwd;
  return rest;
}

/** `current` after a write of `cwd`: unchanged, cleared, or carrying the new directory. */
function writtenRecord(current: TopicRecord, cwd: string | null | undefined): TopicRecord {
  if (cwd === undefined) {
    return current;
  }
  return cwd === null ? withoutCwd(current) : { ...current, cwd };
}

/**
 * Write `name`'s record in one commit (design sec-4's `topic` frame): absent
 * `cwd` creates the topic or leaves its record as it is, a string sets its
 * directory, `null` clears it. Merged, never replaced, so a key a later slice
 * adds survives; the name is the caller's, already checked by the parser.
 */
export async function writeTopicRecord(
  session: Pick<Session, "commit">,
  name: string,
  cwd: string | null | undefined,
): Promise<NamedTopic> {
  if (name === DEFAULT_TOPIC) {
    // DEC-015 restated where the write lands, not only in the parser.
    throw new Error("topic: default is reserved");
  }
  return session.commit(async (tx) => {
    const index = await tx.doc(IndexDocument);
    const record = writtenRecord(storedTopic(index, name) ?? {}, cwd);
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
      writeTopic(index, record.id, topic, record.parent?.conversationId);
    }
  }, context);
}

/** Whether `record`'s entry is missing, or lacks the parent the record carries. */
function needsBackfill(index: IndexDoc, record: ConversationRecord): boolean {
  const entry = index.conversations[String(record.id)];
  return entry === undefined || (record.parent !== undefined && entry.parent === undefined);
}

/** Every ownerless conversation whose entry the backfill must write, oldest first. */
async function unbackfilled(tx: Tx, index: IndexDoc): Promise<readonly ConversationRecord[]> {
  const waiting: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  // The cursor loop of `runner/durable-ids.ts`: page until `next` is undefined.
  do {
    const page = await tx.scanConversations({ order: "ascending" }, BACKFILL_PAGE, cursor);
    waiting.push(
      ...page.items.filter((record) => record.owner === undefined && needsBackfill(index, record)),
    );
    cursor = page.next;
  } while (cursor !== undefined);
  return waiting;
}

/** Topic names in code-unit order, so a listing never depends on a locale. */
function byName(a: NamedTopic, b: NamedTopic): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

/** Every topic a listing shows: `default` first, then by name. */
export function topicsOf(index: IndexDoc): readonly NamedTopic[] {
  const stored = Object.entries(index.topics)
    .map(([name, record]): NamedTopic => ({ name, ...record }))
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

/** The highest id in `topic`: its latest conversation, since pi mints ids in creation order (DEC-015). */
export function latestIn(index: IndexDoc, topic: string): number | undefined {
  return idsIn(index, topic)[0];
}
