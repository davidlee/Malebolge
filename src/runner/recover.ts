// Restart recovery, phase A (design §5.4 "Restart recovery"; DEC-054, DEC-065).
// Startup reads every non-terminal job's row and the harness's read-only
// views into a `RecoverySnapshot`, asks the one table (`recoveryPlan`) what
// to do, and does the part of phase A that needs neither the room nor a
// timer, before the control socket serves (R1). The rest of phase A (room
// work, the re-armed deadline) and phase B (the one harness act, then
// `resume()`) belong to the in-flight job's rejoined run.
//
// First the parked time: a disabled startup parks every live job; the first
// enabled one re-bases their bounds, before any bound is judged (EX-7).
//
// I14/I15: nothing here asks pi for progress. The harness is typed down to
// `commit` (a read transaction) and `snapshot` (the usage read); neither
// enables scheduling. EVD-008: pi is read outside every store transaction.

import {
  type ConversationId,
  type Harness,
  type SettledSubmissionRecord,
  type SubmissionRecord,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { context } from "../context.ts";
import { setDefined } from "../fields.ts";
import { type Budget, type ModelLimits, shouldWarn } from "./ceilings.ts";
import type { RunnerConfig } from "./config.ts";
import { conversationIdOf, submissionRecordOf } from "./durable-ids.ts";
import { ceilingEnding, enterCollecting, settledEnding } from "./ending.ts";
import { messageOf } from "./errors.ts";
import {
  type HostAction,
  JOB_STATES,
  type RecoverySnapshot,
  recoveryPlan,
  splitPhaseA,
  TERMINAL,
} from "./jobs.ts";
import { spendOf } from "./model-gate.ts";
import { segmentRequestId } from "./pause.ts";
import { recordedPolicy } from "./policy.ts";
import type { Job, JobEvent, JobStore } from "./store.ts";
import { isEndReason } from "./vocab.ts";
import { type DueTrigger, warningRequestId } from "./warning.ts";

export interface RecoverDeps {
  jobs: JobStore;
  /** Read-only views only (I15): nothing that asks pi for progress. */
  harness: Pick<Harness, "commit" | "snapshot">;
  config: Pick<RunnerConfig, "maxima">;
  /** What one request to a policy's model can cost at most; `undefined` for a model the catalog lacks. */
  limitsOf: (model: string) => ModelLimits | undefined;
  now: () => number;
  log: (text: string) => void;
}

/** A model the catalog lacks: only the soft-threshold fractions can make the warning due. */
const NO_LIMITS: ModelLimits = { maxOutputTokens: 0, outputCostPerToken: 0 };

/** What startup read of one job. */
export interface JobRecovery {
  snapshot: RecoverySnapshot;
  /** The running segment's submission record (`segmentRequestId`), if pi admitted it. */
  segment?: SubmissionRecord;
  /** The last warning receipt's submission record: the warning's latest carrier. */
  carrier?: SubmissionRecord;
  /**
   * What made the warning due, when its threshold passed (AS-4). An admitted
   * `warn-<id>` with neither threshold passing now was usage's: active
   * wall-clock only grows (R3).
   */
  dueTrigger?: DueTrigger;
}

const isSettled = (record: SubmissionRecord): record is SettledSubmissionRecord =>
  record.status === "done" || record.status === "unanswered";

/** The last warning receipt's `requestId`: the latest carrier, as the run's trail keeps it. */
function lastReceipt(events: readonly JobEvent[]): string | undefined {
  const requestId = events.findLast((event) => event.kind === "warning")?.payload["requestId"];
  return typeof requestId === "string" ? requestId : undefined;
}

/**
 * What made the job's warning due by now (AS-4), by the gate's own rule:
 * active wall-clock (as re-based), else usage read from `pi.usage`.
 * Unreadable usage counts wall-clock only; no recorded policy, nothing.
 */
async function dueTrigger(
  deps: RecoverDeps,
  job: Job,
  conversation: ConversationId | undefined,
): Promise<DueTrigger | undefined> {
  if (job.policy === undefined) {
    return undefined;
  }
  const policy = recordedPolicy(job.policy);
  const spend =
    conversation === undefined
      ? undefined
      : await deps.harness.snapshot(UsageDoc, conversation, context).then(spendOf, () => undefined);
  const budget = setDefined<Budget>(
    {
      ceilings: policy.ceilings,
      softThreshold: deps.config.maxima.softThreshold,
      used: spend === undefined ? undefined : { ...spend, modelRequests: job.modelRequests },
      activeMs: job.activeMs,
      now: deps.now(),
      model: deps.limitsOf(policy.model) ?? NO_LIMITS,
    },
    { runningSince: job.runningSince },
  );
  if (shouldWarn({ ...budget, used: undefined })) {
    return "wall_clock";
  }
  return shouldWarn(budget) ? "usage" : undefined;
}

/**
 * `job`'s row and read-only views as the recovery table reads them. The
 * submission records are found by `requestId`, never by parsing a stored id:
 * the running segment's, the initial prompt's (EX-8), the warning's (an
 * admitted `warn-<id>` proves its threshold passed, R3) and the last
 * receipt's (its placement).
 */
export async function readSnapshot(deps: RecoverDeps, job: Job): Promise<JobRecovery> {
  const conversation =
    job.conversationId === undefined
      ? undefined
      : await conversationIdOf(deps.harness, job.conversationId);
  const record = (requestId: string): Promise<SubmissionRecord | undefined> =>
    conversation === undefined
      ? Promise.resolve(undefined)
      : submissionRecordOf(deps.harness, conversation, requestId);
  const segment = await record(segmentRequestId(job));
  const receipt = lastReceipt(await deps.jobs.events(job.id));
  const receiptRecord = receipt === undefined ? undefined : await record(receipt);
  const warned = (await record(warningRequestId(job.id))) !== undefined;
  const trigger =
    (await dueTrigger(deps, job, conversation)) ?? (warned ? ("usage" as const) : undefined);
  const snapshot = setDefined<RecoverySnapshot>(
    {
      jobId: job.id,
      state: job.state,
      pauseRequested: job.pauseRequested,
      pauseCount: job.pauseCount,
      conversationSettled: segment !== undefined && isSettled(segment),
      initialSubmission: (await record(job.id)) !== undefined,
      warningThresholdPassed: trigger !== undefined,
    },
    {
      conversationId: job.conversationId,
      baseOid: job.baseOid,
      warningReceipt:
        receipt === undefined ? undefined : { placed: receiptRecord?.entry !== undefined },
    },
  );
  return setDefined<JobRecovery>(
    { snapshot },
    { segment, carrier: receiptRecord, dueTrigger: trigger },
  );
}

/** The ceiling that stopped the run, from its `ceiling` event: the in-memory latch died with it (AS-3). */
async function recordedCeiling(jobs: JobStore, id: string): Promise<string | undefined> {
  const reason = (await jobs.events(id)).find((event) => event.kind === "ceiling")?.payload[
    "reason"
  ];
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Row 7: the run settled, its `collecting` never written. The ending is the
 * settlement's, unless a recorded ceiling stopped it.
 */
async function recoverToCollecting(
  deps: RecoverDeps,
  job: Job,
  segment: SubmissionRecord | undefined,
): Promise<void> {
  if (segment === undefined || !isSettled(segment)) {
    throw new Error("to_collecting without a settled segment");
  }
  const ceiling = await recordedCeiling(deps.jobs, job.id);
  const ending = ceilingEnding(
    settledEnding(segment),
    ceiling !== undefined && isEndReason(ceiling) ? ceiling : undefined,
  );
  await enterCollecting(deps, job.id, {
    ...ending,
    payload: { ...ending.payload, reason: "recovered" },
  });
}

/** Runs one of startup's actions (`STARTUP_ACTIONS`): job tables only. */
function runStartupAction(
  deps: RecoverDeps,
  job: Job,
  read: JobRecovery,
  action: HostAction,
): Promise<void> {
  if (action.kind !== "to_collecting") {
    throw new Error(`${action.kind} is not a startup action`);
  }
  return recoverToCollecting(deps, job, read.segment);
}

const LIVE = JOB_STATES.filter((state) => !TERMINAL.includes(state));

/**
 * Startup's phase A: the parked time settled first (EX-7), then every live
 * job's startup actions, read and planned one job at a time. A job whose
 * views cannot be read is logged and left as it is.
 */
export async function recoverHost(deps: RecoverDeps, enabled: boolean): Promise<void> {
  const now = deps.now();
  await (enabled ? deps.jobs.unparkAll(now) : deps.jobs.parkAll(now));
  for (const job of await deps.jobs.list({ states: LIVE })) {
    try {
      const read = await readSnapshot(deps, job);
      const { atStartup } = splitPhaseA(recoveryPlan(read.snapshot, enabled));
      for (const action of atStartup) {
        await runStartupAction(deps, job, read, action);
      }
    } catch (error) {
      deps.log(`job ${job.id}: not recovered at startup: ${messageOf(error)}`);
    }
  }
}
