// Backoff for retrying a room that is down: the pause between attempts, and
// a sleep that a stop cuts short. Shared by preparing (`readyRoom`) and the
// scheduler's `pending_collection` retries.

import { setTimeout as delay } from "node:timers/promises";

/** Waits `ms`, or less once `signal` aborts; never rejects. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const abortableSleep: Sleep = (ms, signal) =>
  delay(ms, undefined, { signal }).catch(() => undefined);

/** The pause before room retry `attempt` (0-based): doubling from 1 s, at most a minute. */
export const roomRetryDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, 60_000);
