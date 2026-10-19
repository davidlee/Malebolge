// Readying the room for a preparing job (design §5.2, §5.4): the base
// refreshed into the room's clone and recorded as `base_oid`, then `job/<id>`
// made there at that oid through the job's environment. The room being down
// is retried with backoff, bounded by `max_room_wait` from when the job
// entered `preparing`; nothing here touches the conversation.

import type { JsonRecord } from "../json.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  notOverflowed,
  type RoomShell,
  succeeded,
} from "../room/shell.ts";
import { pausedForRetry, roomWaitDeadline, type Sleep } from "./backoff.ts";
import type { RepoConfig, RunnerConfig } from "./config.ts";
import { isRunnerError, messageOf } from "./errors.ts";
import { type GitChannel, jobBranch, PREPARE_LIMITS } from "./door.ts";
import type { Job, JobStore } from "./store.ts";
import type { EndReason } from "./vocab.ts";

/** Preparing cannot go on; `failure` is the row's reason. */
export class PrepareFailed extends Error {
  readonly failure: JsonRecord;
  readonly endReason: EndReason;

  constructor(failure: JsonRecord & { reason: string }, endReason: EndReason = "error") {
    super(failure.reason);
    this.name = "PrepareFailed";
    this.failure = failure;
    this.endReason = endReason;
  }
}

/** What a failed preparing step records: why, and the end reason. */
export function preparingFailure(error: unknown): { failure: JsonRecord; endReason: EndReason } {
  if (error instanceof PrepareFailed) {
    return { failure: error.failure, endReason: error.endReason };
  }
  return {
    failure: { reason: failureReason(error), message: messageOf(error) },
    endReason: "error",
  };
}

function failureReason(error: unknown): string {
  if (isRunnerError(error)) {
    return error.code;
  }
  if (error instanceof ChannelFailed) {
    return error.reason;
  }
  return "prepare_failed";
}

/**
 * `job/<jobId>` checked out at `baseOid` in the room's clone: made when absent,
 * switched to when already there (a redo after restart). At another oid it is
 * never moved: PrepareFailed `job_branch_moved`.
 */
export async function ensureJobBranch(
  shell: RoomShell,
  jobId: string,
  baseOid: string,
  signal: AbortSignal,
): Promise<void> {
  const branch = jobBranch(jobId);
  const lookup = ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`];
  const found = notOverflowed(lookup, await shell(lookup, signal, undefined, PREPARE_LIMITS));
  if (found.code === 1) {
    await succeeded(
      shell,
      ["git", "switch", "--quiet", "-c", branch, baseOid],
      signal,
      PREPARE_LIMITS,
    );
    return;
  }
  if (found.code !== 0) {
    throw new ChannelFailed(`git rev-parse ${branch} exited ${String(found.code)}`);
  }
  const oid = found.stdout.trim();
  if (oid !== baseOid) {
    throw new PrepareFailed({ reason: "job_branch_moved", branch, baseOid, found: oid });
  }
  await succeeded(shell, ["git", "switch", "--quiet", branch], signal, PREPARE_LIMITS);
}

// --- readying, with backoff ------------------------------------------------------

export interface ReadyDeps {
  jobs: JobStore;
  channel: GitChannel;
  config: RunnerConfig;
  now: () => number;
  sleep: Sleep;
}

/** Refreshes the base into the room and records it, audited `refreshed`. */
async function recordBase(deps: ReadyDeps, job: Job, repo: RepoConfig): Promise<string> {
  const baseOid = await deps.channel.refresh(repo, job.baseRef);
  await deps.jobs.change(job.id, deps.now(), () => ({
    update: { baseOid },
    event: { kind: "refreshed", payload: { baseRef: job.baseRef, baseOid } },
  }));
  return baseOid;
}

/**
 * The last step of readying (design §4.2): run with the loop's shell and
 * signal once the job branch is at the base. A ChannelUnavailable from it
 * retries the whole attempt, so whatever it gathers belongs to its own call.
 */
export type FinalStep<T> = (shell: RoomShell, signal: AbortSignal) => Promise<T>;

/**
 * The room ready for preparing `job`: its base refreshed (once; a recorded
 * `base_oid` is kept), its clone checked (never cleaned: a defect is
 * PrepareFailed with it, design §5.2), the job branch at the base, then
 * `finalStep`. Returns the base oid and the step's value. A room that is down
 * is retried until `max_room_wait` from `state_entered_at`, then PrepareFailed
 * `room_unavailable`. Stops early, rethrowing, once `signal` aborts.
 */
export async function readyRoom<T>(
  deps: ReadyDeps,
  job: Job,
  repo: RepoConfig,
  shell: RoomShell,
  signal: AbortSignal,
  finalStep: FinalStep<T>,
): Promise<{ baseOid: string; value: T }> {
  const deadline = roomWaitDeadline(job.stateEnteredAt, deps.config.maxima.maxRoomWaitS);
  let baseOid = job.baseOid;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      baseOid ??= await recordBase(deps, job, repo);
      const defect = await deps.channel.checkClone(shell, repo, signal);
      if (defect !== undefined) {
        throw new PrepareFailed(defect);
      }
      await ensureJobBranch(shell, job.id, baseOid, signal);
      return { baseOid, value: await finalStep(shell, signal) };
    } catch (error) {
      if (!(error instanceof ChannelUnavailable)) {
        throw error;
      }
      if (!(await pausedForRetry(deps, attempt, deadline, signal))) {
        throw new PrepareFailed(
          { reason: "room_unavailable", channel: error.reason, message: error.message },
          "room_unavailable",
        );
      }
    }
  }
}
