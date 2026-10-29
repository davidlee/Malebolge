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
import { type DaemonToolset, requireSameTalkSet } from "../toolsets.ts";
import { type IndexDoc, isKnownTopic, readIndexDoc, storedEntry } from "../topics.ts";
import { WAKE_KIND } from "../wake/task.ts";
import { isEpisodeClass, isOrigin, type Origin } from "./origin.ts";
import { POST_KIND } from "./task.ts";
import { isReaped, reapedRefusal, threadsDoc } from "./tombstones.ts";

/** K: conversations an origin's active posts reach — its fan-out (DEC-036). */
export const FAMILY_CONVERSATION_CAP = 8;

/** P: active posts per origin, however few conversations they reach (DEC-036). */
export const FAMILY_POST_CAP = 32;

/** N: active posts daemon-wide (DEC-036). */
export const GLOBAL_POST_CAP = 48;

/** A call refused with a text the model reads. */
export class Refusal extends Error {}

/**
 * Refuse a toolset outside the caller's talk set (design § The thread tools): a start's
 * topic and a post's target are judged the same way, and both read the same refusal.
 */
export function refuseOutsideTalkSet(
  profile: Profile,
  caller: DaemonToolset,
  target: DaemonToolset,
  targetLabel: string,
): void {
  try {
    requireSameTalkSet(profile, caller, target, targetLabel);
  } catch (error) {
    throw new Refusal(error instanceof Error ? error.message : String(error));
  }
}

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
 * What a caller's admission yields: what a post's holds, plus the caller's own toolset —
 * which a started thread's toolset is judged against — and the index it read.
 */
export interface CallerAdmission extends PostAdmission {
  /** The caller's toolset, read from its index entry. */
  toolset: DaemonToolset;
  /** The index the admission read, so the caller's commit needs no second read of it. */
  index: IndexDoc;
}

/**
 * The caller's half of every admission (design § The thread tools, shared step 1):
 * the index and the caller's entry in it, its turn's origin, and its tombstone. Every
 * read, so the caller's one commit may follow. A caller that no topic indexes, or whose
 * turn has no input to take an origin from, is refused; so is a reaped origin.
 */
export async function admitCaller(tx: Tx, caller: ConversationId): Promise<CallerAdmission> {
  const index = await readIndexDoc(tx);
  const callerEntry = storedEntry(index, caller);
  if (callerEntry === undefined) {
    throw new Refusal("this conversation has no index entry");
  }
  const origin = await callerOrigin(tx, caller);
  const doc = await threadsDoc(tx);
  if (isReaped(doc, origin)) {
    throw new Refusal(reapedRefusal(origin));
  }
  return {
    topic: callerEntry.topic,
    origin,
    toolset: callerEntry.toolset,
    index,
    reaped: new Set(Object.keys(doc.reaped)),
  };
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
  const admitted = await admitCaller(tx, caller);
  if ((await tx.conversation(to)) === undefined) {
    throw new Refusal(`no conversation ${String(to)}`);
  }
  const target = storedEntry(admitted.index, to);
  if (target === undefined) {
    throw new Refusal(`conversation ${String(to)} is not in a topic (a task's conversation)`);
  }
  refuseOutsideTalkSet(profile, admitted.toolset, target.toolset, `conversation ${String(to)}`);
  return admitted;
}

/** A thread start's admission: the caller's admission, plus the topic its child is born in. */
export interface StartAdmission extends CallerAdmission {
  /** The topic the started conversation takes: the call's, else the caller's. */
  childTopic: string;
}

/**
 * A thread start's admission (design § The thread tools): the caller's, then the topic
 * its child is born in — the call's, else the caller's. Threads never create topics, so
 * a name no index entry knows is refused. Every read, so the creating commit may follow.
 * The toolset the topic resolves to is judged inside that commit, not here.
 */
export async function admitStart(
  tx: Tx,
  caller: ConversationId,
  topic?: string,
): Promise<StartAdmission> {
  const admitted = await admitCaller(tx, caller);
  const childTopic = topic ?? admitted.topic;
  if (!isKnownTopic(admitted.index, childTopic)) {
    throw new Refusal(`unknown topic: ${childTopic}`);
  }
  return { ...admitted, childTopic };
}
