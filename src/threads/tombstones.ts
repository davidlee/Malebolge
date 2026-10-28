// The tombstone record (SL-006 design § The tombstone record): reaped origins, the
// one write a reap makes before it tells the originator, and the read every post
// and thread start makes before it acts. Session scope, so a fork never copies it.

import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { type Origin, originKey } from "./origin.ts";

/* eslint-disable @typescript-eslint/consistent-type-definitions -- document values are JSON: a type alias, as IndexDoc's, satisfies defineDoc's JsonObject bound */
/** What a session's tombstones hold: reaped origins, when, and why. */
export type ThreadsDoc = {
  /** Reaped origins by origin key. */
  reaped: Record<string, { at: number; reason: string }>;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

/**
 * The tombstone document. Not exported: `threadsDoc` is the only accessor, so
 * nothing outside this module names the document (EX-1). Session scope, and one
 * checkpoint every 50 deltas, as `IndexDocument`.
 */
const ThreadsDocument = defineDoc<ThreadsDoc>({
  kind: "malebolge.threads",
  version: 1,
  scope: "session",
  initial: () => ({ reaped: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** The session's tombstones, read in the caller's commit. */
export const threadsDoc = (tx: Tx): Promise<ThreadsDoc> => tx.doc(ThreadsDocument);

/** Whether `origin` was reaped: its posts and thread starts are refused. */
export const isReaped = (doc: ThreadsDoc, origin: Origin): boolean =>
  doc.reaped[originKey(origin)] !== undefined;

/**
 * Write `origin`'s tombstone; false when it already existed, so the caller creates
 * no second `family-reaped` notice (EX-1).
 */
export function tombstone(doc: ThreadsDoc, origin: Origin, reason: string, now: number): boolean {
  const key = originKey(origin);
  if (doc.reaped[key] !== undefined) {
    return false;
  }
  doc.reaped[key] = { at: now, reason };
  return true;
}

/**
 * The refusal a post or thread start from a reaped origin reads (EX-3): with the reason
 * when the refuse follows this call's own reap, without one when another conversation
 * reaped the family first.
 */
export const reapedRefusal = (origin: Origin, reason?: string): string => {
  const why = reason === undefined ? "" : `: ${reason}`;
  return `origin ${originKey(origin)} was reaped for fan-out${why}; posts and thread starts from it are refused`;
};
