// What the control socket says about a job (design §5.2): the summary of
// `status`, `list` and watch frames, the `result` body, and which jobs a watch
// replays. Pure. One module, so a change to the wire shapes is one edit.

import { optionalRecord, optionalString, setDefined } from "../fields.ts";
import type { JsonRecord } from "../json.ts";
import { isoTime, type Job } from "./rows.ts";
import type { JobState } from "./vocab.ts";

const optionalTime = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : isoTime(ms);

/** A job's identity, state and times; outcome fields (and why it failed) once set. */
export function summary(job: Job): JsonRecord {
  return setDefined<JsonRecord>(
    {
      jobId: job.id,
      state: job.state,
      submissionId: job.submissionId,
      mode: job.mode,
      repo: job.repo,
      baseRef: job.baseRef,
      createdAt: isoTime(job.createdAt),
      updatedAt: isoTime(job.updatedAt),
    },
    {
      endReason: job.endReason,
      class: job.class,
      reviewedOid: job.reviewedOid,
      announcedAt: optionalTime(job.announcedAt),
      failure: job.failure,
    },
  );
}

/**
 * The `result` body: what the row holds now, and what the job's latest
 * `collected` event recorded (quarantine path, commits, diffstat), and the
 * real repo's configured path (where a promotion writes its branch) when the
 * caller knows it. Fields not yet known (before collection) are absent; later
 * phases add fields, never rename them.
 */
export function resultBody(job: Job, collected: JsonRecord = {}, repoPath?: string): JsonRecord {
  return setDefined<JsonRecord>(
    { jobId: job.id, state: job.state, usage: { modelRequests: job.modelRequests } },
    {
      class: job.class,
      endReason: job.endReason,
      baseOid: job.baseOid,
      reviewedOid: job.reviewedOid,
      quarantineRef: job.quarantineRef,
      quarantine: optionalString(collected, "quarantine"),
      commits: Array.isArray(collected["commits"]) ? collected["commits"] : undefined,
      diffstat: optionalRecord(collected, "diffstat"),
      repoPath,
    },
  );
}

/** The one watch frame kind, for replays and live transitions alike. */
export const jobChangedFrame = (job: Job): JsonRecord => ({
  event: "job_changed",
  job: summary(job),
});

/** The states a watch may replay; `isReplayed` decides per job. */
export const REPLAY_STATES: readonly JobState[] = ["needs_review", "failed", "cancelled"];

/** A watch replays every job awaiting review and every failure notice not yet acked. */
export const isReplayed = (job: Job): boolean =>
  job.state === "needs_review" ||
  ((job.state === "failed" || job.state === "cancelled") && job.announcedAt === undefined);
