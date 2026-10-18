// Closed vocabularies shared by the pure runner modules (design §5.3 `jobs`
// columns). Data only; the rules over them live in jobs.ts and classify.ts.

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

export const isJobState = (value: string): value is JobState =>
  JOB_STATES.some((state) => state === value);

export const END_REASONS = [
  "completed",
  "ceiling_exceeded",
  "usage_unavailable",
  "cancelled",
  "room_unavailable",
  "error",
] as const;

export type EndReason = (typeof END_REASONS)[number];

export const JOB_CLASSES = [
  "complete",
  "partial",
  "no_changes",
  "path_violation",
  "error",
] as const;

export type JobClass = (typeof JOB_CLASSES)[number];
