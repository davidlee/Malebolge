// Backoff for retrying a room that is down: the pause between attempts, and
// a sleep that a stop cuts short. Shared by preparing (`readyRoom`), the
// waiting episode (`awaitRoom`) and the scheduler's `pending_collection`
// retries.

import { setTimeout as delay } from "node:timers/promises";

/** Waits `ms`, or less once `signal` aborts; never rejects. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const abortableSleep: Sleep = (ms, signal) =>
  delay(ms, undefined, { signal }).catch(() => undefined);

/** The pause before room retry `attempt` (0-based): doubling from 1 s, at most a minute. */
export const roomRetryDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 60_000);

/** When a wait for the room that began at `since` (a row's `state_entered_at`) gives up. */
export const roomWaitDeadline = (since: number, maxRoomWaitS: number): number =>
  since + maxRoomWaitS * 1000;

/**
 * The pause before room retry `attempt`, cut short at `deadline` or once
 * `signal` aborts. False, without sleeping, once `deadline` has passed.
 */
export async function pausedForRetry(
  deps: { now: () => number; sleep: Sleep },
  attempt: number,
  deadline: number,
  signal: AbortSignal,
): Promise<boolean> {
  const left = deadline - deps.now();
  if (left <= 0) {
    return false;
  }
  await deps.sleep(Math.min(roomRetryDelay(attempt), left), signal);
  return true;
}
