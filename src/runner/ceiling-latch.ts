// A run's ceiling stop (DEC-057): the model gate's refusal (and, from batch B,
// the deadline) trips it, and so does a trust failure at the job's connection
// (EX-5: the room's host key unknown or changed, never a pause). The run
// loop, outside any pi task, sees its signal, aborts the conversation and ends
// the run with the first trip's reason. Neither the gate nor the connection
// aborts: both run inside a pi task, and an abort from there would join that
// task (self-join, hang).

import type { Exhaustion } from "./ceilings.ts";

/** Why the latch tripped: a ceiling, or the room's host key failing trust (EX-5). */
export type LatchReason = Exhaustion | "host_key";

export interface CeilingLatch {
  /** Aborted at the first trip. */
  readonly signal: AbortSignal;
  /** The first trip's reason; `undefined` until tripped. */
  reason: () => LatchReason | undefined;
  /** Trips the latch; later trips change nothing. */
  trip: (reason: LatchReason) => void;
}

export function ceilingLatch(): CeilingLatch {
  const tripped = new AbortController();
  let first: LatchReason | undefined;
  return {
    signal: tripped.signal,
    reason: () => first,
    trip: (reason): void => {
      if (first === undefined) {
        first = reason;
        tripped.abort();
      }
    },
  };
}
