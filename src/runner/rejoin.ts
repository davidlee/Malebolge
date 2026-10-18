// Restart recovery, the rejoin (design §5.4 "Restart recovery", DEC-054,
// DEC-065): the in-flight job a restart left, seated again by the scheduler of
// an enabled runner (never a disabled one: I14). Its plan is the one table's
// (`recoveryPlan`), read again now that startup's phase A is done. The rejoin
// runs, in order: the room-touching rest of phase A, the job's one harness act
// (phase B), then `resume()` (R1). run.ts's segment loop then supervises it as
// any run. Nothing asks the harness for progress before the job's room work
// completes, and a cancel during that work is honoured. A job that ends before
// a segment, or that has nothing to continue (collection), never calls
// `resume()` (R2).
//
// A reacquired submission is reopened by its record's branded id
// (`Harness.submission`), never by parsing a stored id.

import type { Harness, Submission, SubmissionRecord } from "@earendil-works/pi-durable";
import type { Connection } from "@earendil-works/pi-env";
import { context } from "../context.ts";
import { collectJob } from "./collect.ts";
import { jobConversation } from "./conversations.ts";
import {
  type HarnessAction,
  type HostAction,
  type RecoveryPlan,
  recoveryPlan,
  splitPhaseA,
} from "./jobs.ts";
import { configEntry, recordedPolicy, resolvePolicy } from "./policy.ts";
import { type JobRecovery, type RecoverDeps, readSnapshot } from "./recover.ts";
import {
  armed,
  awaitResume,
  endUnrun,
  type Entered,
  openRun,
  prepareAndAdmit,
  type Resolved,
  type Run,
  type RunDeps,
  type Seated,
  type Stops,
  superviseRun,
  unarmed,
  type WarningTrail,
} from "./run.ts";
import type { RunControl } from "./scheduler.ts";
import type { Job } from "./store.ts";

export interface RejoinDeps extends RunDeps {
  /** The run's harness, plus the read-only views and `resume()`. */
  harness: RunDeps["harness"] & Pick<Harness, "snapshot" | "submission" | "resume">;
  limitsOf: RecoverDeps["limitsOf"];
}

/** What one rejoin works from: the job as held, what was read of it, its plan, its run's shell. */
interface Rejoining {
  deps: RejoinDeps;
  job: Job;
  read: JobRecovery;
  plan: RecoveryPlan;
  resolved: Resolved;
  connection: Connection;
  stops: Stops;
}

type Entry = (rejoining: Rejoining) => Promise<Entered>;

/** The submission `record` names, reopened read-only. */
const reopened = (
  deps: RejoinDeps,
  record: SubmissionRecord | undefined,
): Promise<Submission | undefined> =>
  record === undefined ? Promise.resolve(undefined) : deps.harness.submission(record.id, context);

/** The run over the job's conversation, not yet seated. */
async function openRejoined({ deps, job, resolved, connection, stops }: Rejoining): Promise<Run> {
  const { conversationId } = job;
  const conversation =
    conversationId === undefined ? undefined : await jobConversation(deps.harness, conversationId);
  if (conversationId === undefined || conversation === undefined) {
    throw new Error(`job ${job.id}: its conversation is missing`);
  }
  return openRun(deps, { ...job, conversationId }, resolved, conversation, connection, stops);
}

/** The run over the running segment's submission, reopened, and the job seated over it. */
async function rejoinSegment(
  rejoining: Rejoining,
): Promise<{ run: Run; seated: Seated; submission: Submission }> {
  const submission = await reopened(rejoining.deps, rejoining.read.segment);
  if (submission === undefined) {
    throw new Error(`job ${rejoining.job.id}: its running segment's submission is missing`);
  }
  const run = await openRejoined(rejoining);
  return { run, seated: run.seat(), submission };
}

/** The warning as the job's events and pi left it (AS-4): due, and its latest carrier. */
const trailOf = async ({ deps, read }: Rejoining): Promise<WarningTrail> => ({
  due: read.snapshot.warningThresholdPassed,
  carrier: await reopened(deps, read.carrier),
});

/** Rows 3 and 4: the room readied (the base, the job branch), then the prompt admitted and `running`. */
const prepare: Entry = ({ deps, job, resolved, connection, stops }) =>
  prepareAndAdmit(deps, job, resolved, connection, stops);

/** Row 5: the admitted prompt recorded `running` (EX-8: nothing judged), armed from that row. */
const recordRunning: Entry = async (rejoining) => {
  const { deps, job } = rejoining;
  const { run, seated, submission } = await rejoinSegment(rejoining);
  const running = await deps.jobs.transition(job.id, "running", deps.now(), {
    submissionId: String(submission.id),
    requestId: job.id,
  });
  return {
    segment: armed(deps, run, seated, running, submission),
    trail: await trailOf(rejoining),
  };
};

/**
 * Row 6: the recorded pause acted on. The conversation is aborted; the
 * segment, with no timers, settles and the durable mark sends it to
 * `waiting_room`.
 */
const abortPaused: Entry = async (rejoining) => {
  const { run, seated, submission } = await rejoinSegment(rejoining);
  await run.conversation.abort(context);
  return {
    segment: unarmed(run, seated, rejoining.job, submission),
    trail: await trailOf(rejoining),
  };
};

/**
 * Rows 8 and 9: the deadline re-armed from the re-based row; then, if the
 * warning has no receipt, the segment's one warning given and awaited: its
 * `requestId` returns the admitted steer, and the receipt is written once,
 * however soon the re-armed soft timer also makes it due.
 */
const continueRunning: Entry = async (rejoining) => {
  const { deps, job, read, plan } = rejoining;
  const { run, seated, submission } = await rejoinSegment(rejoining);
  const segment = armed(deps, run, seated, job, submission);
  if (
    read.dueTrigger !== undefined &&
    plan.phaseB.some((action) => action.kind === "resubmit_warning")
  ) {
    seated.warning.due(read.dueTrigger);
    await seated.warning.given();
  }
  return { segment, trail: await trailOf(rejoining) };
};

/** Rows 10 and 11: the waiting episode resumed: probing, then the resume message, carrying the warning when owed. */
const resumeWaiting: Entry = async (rejoining) => {
  const resume = rejoining.plan.phaseB.find((action) => action.kind === "submit_resume");
  const run = await openRejoined(rejoining);
  return awaitResume(
    rejoining.deps,
    run,
    rejoining.job,
    await trailOf(rejoining),
    resume?.withWarning ?? false,
  );
};

/** How each plan is entered, by the first of its actions listed here. */
const ENTRIES: readonly (readonly [(HostAction | HarnessAction)["kind"], Entry])[] = [
  ["redo_refresh", prepare],
  ["ensure_job_branch", prepare],
  ["record_running", recordRunning],
  ["abort_then_waiting_room", abortPaused],
  ["rearm_deadline", continueRunning],
  ["resume_probing", resumeWaiting],
];

/** The entry `plan` names; `undefined` when it has nothing to rejoin. */
function entryOf(plan: RecoveryPlan): Entry | undefined {
  const kinds = new Set<string>([...plan.phaseA, ...plan.phaseB].map((action) => action.kind));
  return ENTRIES.find(([kind]) => kinds.has(kind))?.[1];
}

/** The policy the job was bound to at `preparing` (AS-2); none recorded, resolved anew. */
const recordedResolved = (deps: RunDeps, job: Job): Resolved => ({
  policy: job.policy === undefined ? resolvePolicy(deps.config, job) : recordedPolicy(job.policy),
  repo: configEntry(deps.config.repos, "repo", job.repo),
});

/** Rejoins `held`, the in-flight job a restart left, and runs it to a resting state. */
export async function rejoinJob(deps: RejoinDeps, held: Job, control: RunControl): Promise<Job> {
  const read = await readSnapshot(deps, held);
  const plan = recoveryPlan(read.snapshot, true);
  // Row 12: collection redone; nothing of the conversation to continue (R2).
  if (splitPhaseA(plan).inRejoin.some((action) => action.kind === "redo_collect")) {
    return collectJob(deps, held.id, deps.now());
  }
  const entry = entryOf(plan);
  if (entry === undefined) {
    throw new Error(`job ${held.id}: nothing to rejoin in ${held.state}`);
  }
  let resolved: Resolved;
  try {
    resolved = recordedResolved(deps, held);
  } catch (error) {
    if (held.state !== "preparing") {
      throw error;
    }
    return endUnrun(deps, held, control, error);
  }
  return superviseRun(deps, held, resolved, control, async (connection, stops) => {
    const entered = await entry({ deps, job: held, read, plan, resolved, connection, stops });
    if ("segment" in entered) {
      deps.harness.resume();
    }
    return entered;
  });
}
