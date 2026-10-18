// Closed vocabularies shared by the pure runner modules (design §5.3 `jobs`
// columns). Data only; the rules over them live in jobs.ts and classify.ts.

/** A guard admitting exactly the members of `values`. */
const memberOf =
  <T extends string>(values: readonly T[]): ((value: string) => value is T) =>
  (value): value is T =>
    values.some((member) => member === value);

export const JOB_STATES = [
  "queued",
  "preparing",
  "running",
  "waiting_room",
  "collecting",
  "pending_collection",
  "needs_review",
  "promoted",
  "rejected",
  "cancelled",
  "failed",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const isJobState = memberOf(JOB_STATES);

export const END_REASONS = [
  "completed",
  "ceiling_exceeded",
  "usage_unavailable",
  "cancelled",
  "room_unavailable",
  "error",
] as const;

export type EndReason = (typeof END_REASONS)[number];

export const isEndReason = memberOf(END_REASONS);

export const JOB_CLASSES = [
  "complete",
  "partial",
  "no_changes",
  "path_violation",
  "error",
] as const;

export type JobClass = (typeof JOB_CLASSES)[number];

export const isJobClass = memberOf(JOB_CLASSES);

/** What `job_events` records (design §5.3 "What is audited"); append, never rename. */
export const EVENT_KINDS = [
  "submitted",
  "transition",
  "policy",
  "blocked_tool",
  "warning",
  "ceiling",
  "pause",
  "resume",
  "collected",
  "classified",
  "disposition",
  "conversation",
  "announced",
  "refreshed",
  "parked",
  "unparked",
  "clean_failed",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const isEventKind = memberOf(EVENT_KINDS);
