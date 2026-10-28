// Admission's data (SL-006 design § The origin and § The tombstone record): the
// origin a post carries, how journals, tombstones and envelopes name it, the
// caller's-origin read, and the refusal a reaped origin's post reads. It answers the
// reaped keys it read, which the caller's count uses (PHASE-06 EX-4..EX-7).

import {
  type ConversationId,
  type Cursor,
  type EntryRecord,
  ResetEntry,
  type Tx,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { Profile } from "../config.ts";
import { isRecord } from "../json.ts";
import { requireSameTalkSet } from "../toolsets.ts";
import { IndexDocument, storedEntry } from "../topics.ts";
import { WAKE_KIND } from "../wake/task.ts";
import { isEpisodeClass, isOrigin, type Origin } from "./origin.ts";
import { POST_KIND } from "./task.ts";
import { isReaped, reapedRefusal, threadsDoc } from "./tombstones.ts";

/** K: active posts per origin (DEC-036). */
export const FAMILY_CAP = 4;

/** N: active posts daemon-wide (DEC-036). */
export const GLOBAL_CAP = 12;

/** A call refused with a text the model reads. */
export class Refusal extends Error {}

/** Entries read per scan page: a turn's tail is short, so a couple of pages reach its input. */
const PAGE = 16;

/** `entry.data[key]`, checked by `is`; an input entry lacking it is malformed. */
const dataOf = <T>(entry: EntryRecord, key: string, is: (value: unknown) => value is T): T => {
  const value = isRecord(entry.data) ? entry.data[key] : undefined;
  if (!is(value)) {
    throw new Error(`entry ${String(entry.id)} (${entry.kind}) carries no ${key}`);
  }
  return value;
};

/** The origin `entry` opens, or `undefined` when it is not an input entry. */
const originOf = (entry: EntryRecord, caller: ConversationId): Origin | undefined => {
  if (UserEntry.is(entry) || ResetEntry.is(entry)) {
    return { conversation: caller, entry: entry.id, kind: "human" };
  }
  if (entry.kind === WAKE_KIND) {
    const episodeClass = dataOf(entry, "episodeClass", isEpisodeClass);
    return { conversation: caller, entry: entry.id, kind: "wake", episodeClass };
  }
  return entry.kind === POST_KIND ? dataOf(entry, "origin", isOrigin) : undefined;
};

/**
 * The origin of `caller`'s turn: its newest input entry's origin (design § The
 * origin). Scans newest first, paged, skipping assistant, tool-result and notice
 * entries; a conversation with no input entry refuses.
 */
export async function callerOrigin(tx: Tx, caller: ConversationId): Promise<Origin> {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries(
      { conversationId: caller, order: "descending" },
      PAGE,
      cursor,
    );
    for (const entry of page.items) {
      const origin = originOf(entry, caller);
      if (origin !== undefined) {
        return origin;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  throw new Refusal("no input entry to take an origin from");
}

/** What a post's admission yields: the caller's topic, the origin the post carries, and the reaped origins it read. */
export interface PostAdmission {
  topic: string;
  origin: Origin;
  /** Every reaped origin key the admission read, so counting needs no second read. */
  reaped: ReadonlySet<string>;
}

/**
 * A post's admission (design § The thread tools, shared steps 1-2): the caller is
 * indexed, the target exists and is indexed, the two share a talk set, and the
 * caller's turn has an origin, and that origin has not been reaped. Every read, so
 * the caller's one commit may follow. The reaped keys it read are returned for the
 * count the caller makes next.
 */
export async function admitPost(
  tx: Tx,
  profile: Profile,
  caller: ConversationId,
  to: ConversationId,
): Promise<PostAdmission> {
  if (to === caller) {
    throw new Refusal("a conversation cannot post to itself");
  }
  const index = await tx.doc(IndexDocument);
  const callerEntry = storedEntry(index, caller);
  if (callerEntry === undefined) {
    throw new Refusal("this conversation has no index entry");
  }
  const target = await tx.conversation(to);
  if (target === undefined) {
    throw new Refusal(`no conversation ${String(to)}`);
  }
  const targetEntry = storedEntry(index, to);
  if (targetEntry === undefined) {
    throw new Refusal(`conversation ${String(to)} is not in a topic (a task's conversation)`);
  }
  try {
    requireSameTalkSet(
      profile,
      callerEntry.toolset,
      targetEntry.toolset,
      `conversation ${String(to)}`,
    );
  } catch (error) {
    throw new Refusal(error instanceof Error ? error.message : String(error));
  }
  const origin = await callerOrigin(tx, caller);
  const doc = await threadsDoc(tx);
  if (isReaped(doc, origin)) {
    throw new Refusal(reapedRefusal(origin));
  }
  return { topic: callerEntry.topic, origin, reaped: new Set(Object.keys(doc.reaped)) };
}
