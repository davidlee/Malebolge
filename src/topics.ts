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

/** The topic every conversation starts in: it always exists, and is never stored (DEC-015). */
export const DEFAULT_TOPIC = "default";

/** Conversations read per backfill page: small, so one commit never reads the whole store at once. */
const BACKFILL_PAGE = 64;

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
 * The one read of the document. `snapshot` does not apply `initial()`, so an
 * absent index — a store no hook ever wrote — reads as the initial document
 * here, once, for every topic listing.
 */
export async function readIndex(session: Pick<Session, "snapshot">): Promise<IndexDoc> {
  return (await session.snapshot(IndexDocument, context)) ?? IndexDocument.definition.initial();
}

/**
 * Index the conversations created before this slice (D7), root included: one
 * commit, paged reads, and every read before the first write.
 */
export async function backfillIndex(session: Pick<Session, "commit">): Promise<void> {
  await session.commit(async (tx) => {
    const index = await tx.doc(IndexDocument);
    const waiting = await unindexed(tx, index);
    for (const record of waiting) {
      writeTopic(index, record.id, DEFAULT_TOPIC);
    }
  }, context);
}

/** Every ownerless conversation the index does not know yet, oldest first. */
async function unindexed(tx: Tx, index: IndexDoc): Promise<readonly ConversationRecord[]> {
  const waiting: ConversationRecord[] = [];
  let cursor: Cursor | undefined;
  // The cursor loop of `runner/durable-ids.ts`: page until `next` is undefined.
  do {
    const page = await tx.scanConversations({ order: "ascending" }, BACKFILL_PAGE, cursor);
    waiting.push(
      ...page.items.filter(
        (record) =>
          record.owner === undefined && index.conversations[String(record.id)] === undefined,
      ),
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
