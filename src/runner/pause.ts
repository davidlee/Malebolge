// Room down: the pause, the waiting episode and the resume (design §5.4,
// amended DEC-055). The pause is recognised at the job's connection; the run
// (run.ts) then waits here for the room, bounded by `max_room_wait` from the
// row's `state_entered_at`, and resumes the conversation with one message.
// Restart recovery (PHASE-10) reuses `awaitRoom` and `submitResume`.

import type { Conversation, Submission } from "@earendil-works/pi-durable";
import { context } from "../context.ts";
import { pausedForRetry, roomWaitDeadline, type Sleep } from "./backoff.ts";
import type { RepoConfig, RunnerConfig } from "./config.ts";
import type { ConnectionObserver } from "./env.ts";
import type { ChannelFailed, GitChannel } from "./room.ts";
import type { Job, JobStore } from "./store.ts";
import { recordWarning, WARNING_TEXT, type WarningDeps } from "./warning.ts";

export interface PauseDeps {
  jobs: Pick<JobStore, "markPause">;
  now: () => number;
}

/**
 * The running job's connection observer: a lost connection marks the job
 * `pause_requested` with a `pause` event, settled before the failure is
 * rethrown. Idempotent in the store (one stop raises two lost failures). A
 * trust failure is no pause: it marks nothing and calls `untrusted`, the
 * run's stop (EX-5).
 */
export function pausingObserver(
  deps: PauseDeps,
  jobId: string,
  untrusted: () => void,
): ConnectionObserver {
  return {
    lost: async (failure): Promise<void> => {
      await deps.jobs.markPause(jobId, deps.now(), { ...failure });
    },
    untrusted,
  };
}

// --- the waiting episode -------------------------------------------------------

/** How a waiting episode ends. */
export type RoomWait = "reachable" | "timed_out" | "cancelled";

export interface AwaitRoomDeps {
  channel: Pick<GitChannel, "reachable">;
  config: Pick<RunnerConfig, "maxima">;
  now: () => number;
  sleep: Sleep;
}

/**
 * Probes the room for `job` (in `repo`) with backoff until it is reachable;
 * `timed_out` once `max_room_wait` from `state_entered_at` has passed (so a
 * restart does not reset the bound); `cancelled` once `signal` aborts. A probe
 * `ChannelFailed` is rethrown: a trust failure is never downtime (DEC-060).
 */
export async function awaitRoom(
  deps: AwaitRoomDeps,
  repo: RepoConfig,
  job: Pick<Job, "id" | "stateEnteredAt">,
  signal: AbortSignal,
): Promise<RoomWait> {
  const deadline = roomWaitDeadline(job.stateEnteredAt, deps.config.maxima.maxRoomWaitS);
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) {
      return "cancelled";
    }
    if (await deps.channel.reachable(repo, job.id)) {
      return "reachable";
    }
    if (!(await pausedForRetry(deps, attempt, deadline, signal))) {
      return "timed_out";
    }
  }
}

/** Waited out: `pending_collection`, `end_reason = room_unavailable` (DEC-060 collects it). */
export const roomWaitedOut = (
  deps: { jobs: Pick<JobStore, "transition">; now: () => number },
  id: string,
): Promise<Job> =>
  deps.jobs.transition(
    id,
    "pending_collection",
    deps.now(),
    { reason: "room_unavailable" },
    { endReason: "room_unavailable" },
  );

/** A probe `ChannelFailed` ends the wait: `collecting`, `end_reason = error` (DEC-060). */
export const roomProbeFailed = (
  deps: { jobs: Pick<JobStore, "transition">; now: () => number },
  id: string,
  error: ChannelFailed,
): Promise<Job> =>
  deps.jobs.transition(
    id,
    "collecting",
    deps.now(),
    { reason: error.reason, message: error.message },
    { endReason: "error" },
  );

// --- the resume -----------------------------------------------------------------

/** The resume message (design §5.4). */
export const RESUME_TEXT =
  "The environment restarted. Your last call may not have completed. Check state and continue.";

/** The resume message's `requestId`: the one spelling of `resume-<job id>-<pause_count>`. */
export const resumeRequestId = (jobId: string, pauseCount: number): string =>
  `resume-${jobId}-${String(pauseCount)}`;

/**
 * The `requestId` of the running segment's submission: the initial prompt's
 * (the job id) before any pause, else waiting episode `pause_count`'s resume.
 */
export const segmentRequestId = (job: Pick<Job, "id" | "pauseCount">): string =>
  job.pauseCount === 0 ? job.id : resumeRequestId(job.id, job.pauseCount);

export interface ResumeDeps extends WarningDeps {
  conversation: Pick<Conversation, "submit">;
}

/**
 * Submits waiting episode `pauseCount`'s resume message, carrying the warning
 * text when `withWarning` (`warningOwed`); a carried warning is then receipted
 * as the run's warning (trigger `resume`). Resubmitting the same episode
 * returns the admitted submission. `running` is the caller's to record, after.
 */
export async function submitResume(
  deps: ResumeDeps,
  { pauseCount, withWarning }: { pauseCount: number; withWarning: boolean },
): Promise<Submission> {
  const requestId = resumeRequestId(deps.jobId, pauseCount);
  const content = withWarning ? `${RESUME_TEXT}\n\n${WARNING_TEXT}` : RESUME_TEXT;
  const submission = await deps.conversation.submit({ type: "input", content, requestId }, context);
  if (withWarning) {
    await recordWarning(deps, requestId, submission, "resume");
  }
  return submission;
}
