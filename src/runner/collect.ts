// Collection and classification (design §5.4, DEC-060): an ended job's
// commits fetched into quarantine, checked there (ancestry from `base_oid`,
// every path of every commit, I6), classified, and the job moved on. Steps
// for the scheduler and restart recovery (`redo_collect`,
// `resume_collection_retry`); no timer lives here.
//
// Two writes, one event each: `collected` records `reviewed_oid` (I7), then a
// transition records the class. A crash between them leaves `collecting` with
// `reviewed_oid` set; the redo collects again, and only the same oid passes.

import { setDefined } from "../fields.ts";
import type { JsonRecord } from "../json.ts";
import { type Classification, type ClassifyInput, classify } from "./classify.ts";
import type { RunnerConfig } from "./config.ts";
import { isRunnerError, RunnerError } from "./errors.ts";
import type { QuarantineFacts, QuarantineReader } from "./git.ts";
import { pendingCollectionExpired, recordReviewed } from "./jobs.ts";
import { ChannelUnavailable, type Collected, type GitChannel } from "./room.ts";
import { isoTime } from "./rows.ts";
import type { Job, JobStore, JobUpdate } from "./store.ts";
import type { EndReason, JobState } from "./vocab.ts";

export interface CollectDeps {
  /** The instance the control server observes. */
  jobs: JobStore;
  channel: GitChannel;
  quarantine: QuarantineReader;
  config: RunnerConfig;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Job `id`, which must be in `state`. */
async function jobIn(jobs: JobStore, id: string, state: JobState): Promise<Job> {
  const job = await jobs.get(id);
  if (job === undefined) {
    throw new RunnerError("unknown_job", `no job ${id}`);
  }
  if (job.state !== state) {
    throw new RunnerError("invalid_transition", `job ${id} is ${job.state}, not ${state}`);
  }
  return job;
}

/** Moves the job to where `classification` says, recording its class and any failure. */
function settle(
  deps: CollectDeps,
  id: string,
  now: number,
  classification: Classification,
  failure?: JsonRecord,
): Promise<Job> {
  const { class: jobClass, state, flagged, offending } = classification;
  const byClass =
    state === "failed"
      ? setDefined<JsonRecord>(
          { reason: jobClass },
          { offending: offending.length > 0 ? offending : undefined },
        )
      : undefined;
  return deps.jobs.transition(
    id,
    state,
    now,
    { class: jobClass, flagged, offending },
    setDefined<JobUpdate>({ class: jobClass }, { failure: failure ?? byClass }),
  );
}

/** Collection or a check failed: class `error`, by how execution ended. */
const settleError = (
  deps: CollectDeps,
  id: string,
  now: number,
  endReason: EndReason,
  failure: JsonRecord,
): Promise<Job> =>
  settle(
    deps,
    id,
    now,
    classify({ endReason, collection: { ok: false }, allowedPaths: [] }),
    failure,
  );

/** A row that cannot be collected at all: failed, class `error`, no classification. */
const failOutright = (
  deps: CollectDeps,
  id: string,
  now: number,
  failure: JsonRecord,
): Promise<Job> => deps.jobs.transition(id, "failed", now, failure, { class: "error", failure });

/** The facts, or why they could not be read. */
async function inspect(
  deps: CollectDeps,
  collected: Collected,
  baseOid: string,
): Promise<QuarantineFacts | { error: string }> {
  try {
    return await deps.quarantine.inspect(collected.quarantine, baseOid, collected.oid);
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** The `collected` event: where the commits are and what they are (A6). */
const collectedPayload = (
  collected: Collected,
  facts: QuarantineFacts | { error: string },
): JsonRecord => ({
  quarantine: collected.quarantine,
  quarantineRef: collected.ref,
  reviewedOid: collected.oid,
  ...("error" in facts ? {} : { commits: facts.commits, diffstat: facts.diffstat }),
});

/**
 * Records `reviewed_oid` and the ref (I7: the same oid again writes nothing).
 * Returns the refusal when the job already holds a different oid.
 */
async function recordCollected(
  deps: CollectDeps,
  id: string,
  now: number,
  collected: Collected,
  payload: JsonRecord,
): Promise<RunnerError | undefined> {
  try {
    await deps.jobs.change(id, now, (job) => {
      const update = recordReviewed(job, collected.oid);
      return update === undefined
        ? undefined
        : {
            update: { ...update, quarantineRef: collected.ref },
            event: { kind: "collected", payload },
          };
    });
    return undefined;
  } catch (error) {
    if (isRunnerError(error) && error.code === "reviewed_oid_mismatch") {
      return error;
    }
    throw error;
  }
}

/** Steps 2-5 of design §5.4, once the job branch is in quarantine. */
async function checkAndClassify(
  deps: CollectDeps,
  job: Job & { baseOid: string; endReason: EndReason },
  now: number,
  collected: Collected,
): Promise<Job> {
  const facts = await inspect(deps, collected, job.baseOid);
  const mismatch = await recordCollected(
    deps,
    job.id,
    now,
    collected,
    collectedPayload(collected, facts),
  );
  if (mismatch !== undefined) {
    return settleError(deps, job.id, now, job.endReason, {
      reason: "reviewed_oid_mismatch",
      recorded: job.reviewedOid ?? null,
      collected: collected.oid,
    });
  }
  if ("error" in facts) {
    return settleError(deps, job.id, now, job.endReason, {
      reason: "check_failed",
      message: facts.error,
    });
  }
  const collection: ClassifyInput["collection"] = {
    ok: true,
    ancestryOk: facts.ancestryOk,
    changedPaths: facts.changedPaths,
    commitCount: facts.commits.length,
  };
  return settle(
    deps,
    job.id,
    now,
    classify({ endReason: job.endReason, collection, allowedPaths: job.allowedPaths }),
  );
}

/**
 * Collects job `id`, which must be `collecting`, and moves it on: to
 * `pending_collection` when the room is down, else by its classification.
 */
export async function collectJob(deps: CollectDeps, id: string, now: number): Promise<Job> {
  const job = await jobIn(deps.jobs, id, "collecting");
  const repo = deps.config.repos.get(job.repo);
  if (repo === undefined) {
    return failOutright(deps, id, now, { reason: "repo_not_configured", repo: job.repo });
  }
  const { baseOid, endReason } = job;
  if (baseOid === undefined || endReason === undefined) {
    return failOutright(deps, id, now, {
      reason: "corrupt_job",
      message: "collecting without base_oid or end_reason",
    });
  }
  let collected: Collected;
  try {
    collected = await deps.channel.collect(repo, id);
  } catch (error) {
    if (error instanceof ChannelUnavailable) {
      return deps.jobs.transition(id, "pending_collection", now, {
        reason: "channel_unavailable",
        message: error.message,
      });
    }
    return settleError(deps, id, now, endReason, {
      reason: "collection_failed",
      message: messageOf(error),
    });
  }
  return checkAndClassify(deps, { ...job, baseOid, endReason }, now, collected);
}

/**
 * One retry of job `id`, which must be `pending_collection`: abandoned at
 * `max_pending_collection` (no further probe), collected when the room is
 * reachable, else left as it is (no write).
 */
export async function retryPendingCollection(
  deps: CollectDeps,
  id: string,
  now: number,
): Promise<Job> {
  const job = await jobIn(deps.jobs, id, "pending_collection");
  if (pendingCollectionExpired(job, now, deps.config.maxima.maxPendingCollectionS * 1000)) {
    return failOutright(deps, id, now, {
      reason: "collection_abandoned",
      pendingSince: isoTime(job.stateEnteredAt),
    });
  }
  if (!(await deps.channel.reachable())) {
    return job;
  }
  await deps.jobs.transition(id, "collecting", now, { reason: "reachable" });
  return collectJob(deps, id, now);
}
