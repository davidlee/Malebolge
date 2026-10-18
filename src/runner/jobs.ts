// The job state machine and restart-recovery table (design §5.4; DEC-054,
// DEC-055, DEC-059, DEC-060), as data. Pure: each function returns the field
// patch or plan the store and scheduler enact. Times are epoch milliseconds;
// the store maps them to its text columns.

import { closeSegment } from "./ceilings.ts";
import { RunnerError } from "./errors.ts";
import { resumeRequestId } from "./pause.ts";
import { type EndReason, isJobState, type JobState } from "./vocab.ts";
import { warningOwed, warningRequestId } from "./warning.ts";

export {
  END_REASONS,
  type EndReason,
  isJobState,
  JOB_STATES,
  type JobState,
} from "./vocab.ts";

/** Legal moves out of each state (the §5.4 diagram). */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["preparing", "cancelled"],
  preparing: ["running", "failed", "cancelled"],
  running: ["waiting_room", "collecting"],
  waiting_room: ["running", "pending_collection"],
  collecting: ["pending_collection", "needs_review", "failed", "cancelled"],
  pending_collection: ["collecting", "failed"],
  needs_review: ["promoted", "rejected"],
  promoted: [],
  rejected: [],
  cancelled: [],
  failed: [],
};

export const TERMINAL: readonly JobState[] = ["promoted", "rejected", "cancelled", "failed"];

/** The job fields the state machine reads. */
export interface JobRecord {
  state: JobState;
  /** `active_ms`: closed running segments. */
  activeMs: number;
  /** Start of the current running segment. */
  runningSince?: number;
  pauseRequested: boolean;
  pauseCount: number;
}

/** The fields one transition writes; absent fields are unchanged. */
export interface JobPatch {
  state: JobState;
  stateEnteredAt: number;
  /** `null` clears it. */
  runningSince?: number | null;
  activeMs?: number;
  pauseRequested?: boolean;
  pauseCount?: number;
  startedAt?: number;
  finishedAt?: number;
  endReason?: EndReason;
}

/** `value` as a job state; a row holding anything else is corrupt. */
export function parseJobState(value: string): JobState {
  if (!isJobState(value)) {
    throw new Error(`unknown job state ${JSON.stringify(value)}`);
  }
  return value;
}

type Effect = (job: JobRecord, to: JobState, now: number) => Partial<JobPatch>;

function leaveRunning(job: JobRecord, _to: JobState, now: number): Partial<JobPatch> {
  return job.state === "running"
    ? { activeMs: closeSegment(job.activeMs, job.runningSince ?? now, now), runningSince: null }
    : {};
}

function enterRunning(job: JobRecord, to: JobState, now: number): Partial<JobPatch> {
  if (to !== "running") {
    return {};
  }
  return job.state === "preparing" ? { runningSince: now, startedAt: now } : { runningSince: now };
}

/** One waiting episode begins: the mark is consumed and the episode counted (DEC-055). */
function enterWaitingRoom(job: JobRecord, to: JobState): Partial<JobPatch> {
  return to === "waiting_room" ? { pauseRequested: false, pauseCount: job.pauseCount + 1 } : {};
}

function enterTerminal(_job: JobRecord, to: JobState, now: number): Partial<JobPatch> {
  return TERMINAL.includes(to) ? { finishedAt: now } : {};
}

const EFFECTS: readonly Effect[] = [leaveRunning, enterRunning, enterWaitingRoom, enterTerminal];

/** The patch moving `job` to `to` at `now`; `invalid_transition` if the diagram forbids it. */
export function transition(job: JobRecord, to: JobState, now: number): JobPatch {
  if (!TRANSITIONS[job.state].includes(to)) {
    throw new RunnerError("invalid_transition", `${job.state} cannot move to ${to}`);
  }
  let patch: JobPatch = { state: to, stateEnteredAt: now };
  for (const effect of EFFECTS) {
    patch = { ...patch, ...effect(job, to, now) };
  }
  return patch;
}

/**
 * Where `cancel` takes each state. A job that has run ends through
 * collection; once execution has ended (collecting onward) cancel is refused.
 */
const CANCEL_TO: Partial<Record<JobState, JobState>> = {
  queued: "cancelled",
  preparing: "cancelled",
  running: "collecting",
  waiting_room: "pending_collection",
};

/** The patch cancelling `job` at `now`. */
export function cancel(job: JobRecord, now: number): JobPatch {
  const to = CANCEL_TO[job.state];
  if (to === undefined) {
    throw new RunnerError("invalid_transition", `a ${job.state} job cannot be cancelled`);
  }
  return { ...transition(job, to, now), endReason: "cancelled" };
}

/**
 * The patch recording a room-down pause request; `undefined` when there is
 * nothing to write. Idempotent (one stop can raise several lost failures) and
 * meaningful only while running.
 */
export function markPauseRequested(job: JobRecord): { pauseRequested: true } | undefined {
  return job.state === "running" && !job.pauseRequested ? { pauseRequested: true } : undefined;
}

// --- collection (DEC-060) ---------------------------------------------------------

/**
 * The patch recording the collected `oid`; `undefined` when it is already
 * recorded. `reviewed_oid` is immutable once set (I7): a different oid is
 * refused, never written.
 */
export function recordReviewed(
  job: { reviewedOid?: string },
  oid: string,
): { reviewedOid: string } | undefined {
  if (job.reviewedOid === undefined) {
    return { reviewedOid: oid };
  }
  if (job.reviewedOid !== oid) {
    throw new RunnerError(
      "reviewed_oid_mismatch",
      `reviewed_oid is ${job.reviewedOid}; collection found ${oid}`,
    );
  }
  return undefined;
}

/**
 * Whether a `pending_collection` job has waited `maxPendingMs` since it
 * entered the state; counted from `state_entered_at`, so a restart does not
 * reset it. At the bound the job is abandoned without another probe.
 */
export const pendingCollectionExpired = (
  job: { stateEnteredAt: number },
  now: number,
  maxPendingMs: number,
): boolean => now - job.stateEnteredAt >= maxPendingMs;

// --- restart recovery (DEC-054) ----------------------------------------------

/** What recovery reads of a job: its row plus read-only harness views. */
export interface RecoverySnapshot {
  jobId: string;
  state: JobState;
  conversationId?: string;
  baseOid?: string;
  pauseRequested: boolean;
  pauseCount: number;
  /** The conversation's read-only view shows its run settled. */
  conversationSettled: boolean;
  warningThresholdPassed: boolean;
  /** The warning's `job_events` receipt; `placed` read from its submission record. */
  warningReceipt?: { placed: boolean };
}

/** Phase A: host only; never asks the harness for progress. */
export type HostAction =
  | { kind: "redo_refresh" }
  | { kind: "ensure_job_branch" }
  | { kind: "to_collecting" }
  | { kind: "rearm_deadline" }
  | { kind: "resume_probing" }
  | { kind: "redo_collect" }
  | { kind: "resume_collection_retry" };

/** Phase B: the one harness act, enabled runners only; `resume()` follows it. */
export type HarnessAction =
  | { kind: "create_conversation" }
  | { kind: "submit_initial_prompt"; requestId: string }
  | { kind: "abort_then_waiting_room" }
  | { kind: "resubmit_warning"; requestId: string }
  | { kind: "submit_resume"; requestId: string; withWarning: boolean };

export interface RecoveryPlan {
  phaseA: HostAction[];
  phaseB: HarnessAction[];
}

interface RecoveryRow {
  /** Rows of one concern are alternatives: the first match wins. */
  concern: "state" | "warning";
  matches: (job: RecoverySnapshot) => boolean;
  plan: (job: RecoverySnapshot) => RecoveryPlan;
}

const NOTHING: RecoveryPlan = { phaseA: [], phaseB: [] };

const host = (...phaseA: HostAction[]): RecoveryPlan => ({ phaseA, phaseB: [] });

const isState =
  (state: JobState): ((job: RecoverySnapshot) => boolean) =>
  (job) =>
    job.state === state;

/** The §5.4 restart-recovery table, in row order. */
const RECOVERY_TABLE: readonly RecoveryRow[] = [
  {
    concern: "state",
    matches: (job) => job.state === "queued" && job.conversationId === undefined,
    plan: () => ({ phaseA: [], phaseB: [{ kind: "create_conversation" }] }),
  },
  {
    concern: "state",
    matches: (job) => job.state === "preparing" && job.baseOid === undefined,
    plan: () => host({ kind: "redo_refresh" }),
  },
  {
    concern: "state",
    matches: isState("preparing"),
    plan: (job) => ({
      phaseA: [{ kind: "ensure_job_branch" }],
      phaseB: [{ kind: "submit_initial_prompt", requestId: job.jobId }],
    }),
  },
  // A recorded pause precedes a settled conversation: a crash after the abort
  // and before the waiting_room tx leaves exactly both, and the job must wait
  // for the room, not end (DEC-055). The abort is then a no-op act.
  {
    concern: "state",
    matches: (job) => job.state === "running" && job.pauseRequested,
    plan: () => ({ phaseA: [], phaseB: [{ kind: "abort_then_waiting_room" }] }),
  },
  {
    concern: "state",
    matches: (job) => job.state === "running" && job.conversationSettled,
    plan: () => host({ kind: "to_collecting" }),
  },
  { concern: "state", matches: isState("running"), plan: () => host({ kind: "rearm_deadline" }) },
  {
    concern: "warning",
    matches: (job) =>
      job.state === "running" &&
      !job.conversationSettled &&
      !job.pauseRequested &&
      job.warningThresholdPassed &&
      job.warningReceipt === undefined,
    plan: (job) => ({
      phaseA: [],
      phaseB: [{ kind: "resubmit_warning", requestId: warningRequestId(job.jobId) }],
    }),
  },
  {
    concern: "state",
    matches: isState("waiting_room"),
    plan: (job) => ({
      phaseA: [{ kind: "resume_probing" }],
      phaseB: [
        {
          kind: "submit_resume",
          requestId: resumeRequestId(job.jobId, job.pauseCount),
          withWarning: warningOwed(job.warningThresholdPassed, job.warningReceipt),
        },
      ],
    }),
  },
  { concern: "state", matches: isState("collecting"), plan: () => host({ kind: "redo_collect" }) },
  {
    concern: "state",
    matches: isState("pending_collection"),
    plan: () => host({ kind: "resume_collection_retry" }),
  },
];

/**
 * What restart does for `job`. With the runner disabled, phase B is empty
 * (I14): nothing asks the harness for progress, and a recorded pause stays
 * recorded.
 */
export function recoveryPlan(job: RecoverySnapshot, enabled: boolean): RecoveryPlan {
  const plans = (["state", "warning"] as const).map(
    (concern) =>
      RECOVERY_TABLE.find((row) => row.concern === concern && row.matches(job))?.plan(job) ??
      NOTHING,
  );
  return {
    phaseA: plans.flatMap((plan) => plan.phaseA),
    phaseB: enabled ? plans.flatMap((plan) => plan.phaseB) : [],
  };
}
