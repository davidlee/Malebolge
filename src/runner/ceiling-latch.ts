// A run's ceiling stop (DEC-057): the model gate's refusal (and, from batch B,
// the deadline) trips it; the run loop, outside any pi task, sees its signal,
// aborts the conversation and ends the run with the first trip's reason. The
// gate never aborts: it runs inside a pi task, and an abort from there would
// join that task (self-join, hang).

import type { Exhaustion } from "./ceilings.ts";

export interface CeilingLatch {
  /** Aborted at the first trip. */
  readonly signal: AbortSignal;
  /** The first trip's reason; `undefined` until tripped. */
  reason: () => Exhaustion | undefined;
  /** Trips the latch; later trips change nothing. */
  trip: (reason: Exhaustion) => void;
}

export function ceilingLatch(): CeilingLatch {
  const tripped = new AbortController();
  let first: Exhaustion | undefined;
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
