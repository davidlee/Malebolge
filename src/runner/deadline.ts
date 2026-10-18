// The run's ceiling timers (design §5.4 "Deadline timer", "One warning";
// DEC-057): the deadline, independent of the model gate, and the soft timer
// that makes the wall-clock warning due. Both are armed from the job row as it
// stands — `active_ms` plus the open running segment, so a crash interval is
// charged (fail closed) and waiting is not — and both are stopped together.
// PHASE-09/10 re-arm them from a fresh row after a pause or a restart.

import { activeWallClockMs } from "./ceilings.ts";
import type { Ceilings } from "./config.ts";
import type { Job } from "./store.ts";

/** Calls `fire` once `ms` pass, unless cancelled first. */
export type Timer = (ms: number, fire: () => void) => { cancel: () => void };

export const systemTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return {
    cancel: (): void => {
      clearTimeout(handle);
    },
  };
};

export interface CeilingTimersArm {
  /** The row as committed: never a cached copy. */
  job: Pick<Job, "activeMs" | "runningSince">;
  ceilings: Pick<Ceilings, "active_wall_clock_s">;
  /** `[maxima].soft_threshold`. */
  softThreshold: number;
  now: number;
  timer: Timer;
  /** The deadline passed: active wall-clock is spent. */
  expire: () => void;
  /** The soft threshold of active wall-clock passed. */
  warn: () => void;
}

export interface CeilingTimers {
  /** Cancels both; neither fires afterwards, even from a callback already queued. */
  stop: () => void;
}

/**
 * The deadline and the soft timer for `job`'s active wall-clock. A timer whose
 * moment has already passed fires at once, during this call; past the
 * deadline, the warning is moot and is not given.
 */
export function armCeilingTimers(arm: CeilingTimersArm): CeilingTimers {
  const limitMs = arm.ceilings.active_wall_clock_s * 1000;
  const spentMs = activeWallClockMs(arm.job.activeMs, arm.job.runningSince, arm.now);
  let stopped = false;
  const cancels: (() => void)[] = [];
  function at(ms: number, fire: () => void): void {
    const guarded = (): void => {
      if (!stopped) {
        fire();
      }
    };
    if (ms <= spentMs) {
      guarded();
    } else {
      cancels.push(arm.timer(ms - spentMs, guarded).cancel);
    }
  }
  if (spentMs >= limitMs) {
    arm.expire();
    return { stop: () => undefined };
  }
  at(limitMs, arm.expire);
  at(arm.softThreshold * limitMs, arm.warn);
  return {
    stop: (): void => {
      stopped = true;
      for (const cancel of cancels) {
        cancel();
      }
    },
  };
}
