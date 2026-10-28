// The start sweep (SL-034 design § Heartbeat; SL-006 design § Components and
// boundaries): a live task of a swept kind that cannot run here is journalled,
// its still-queued inputs withdrawn, the kind's own failure reported, and the
// task aborted last: the abort can end the task's visibility (a definition-
// blocked task settles `orphaned` in the abort's own commit), so a crash before
// it leaves the task live and the next start repeats the sweep. The sweep knows
// no kind: each one exports its row from its own module.

import type { Context } from "@earendil-works/chord/context";
import type {
  BlockedReason,
  Harness,
  SubmissionRecord,
  TaskId,
  TaskInspection,
} from "@earendil-works/pi-durable";
import type { Log } from "./satan-tools.ts";

/** One kind the start sweeps: what it is called, whose inputs it owns, how it fails. */
export interface SweptKind {
  kind: string;
  /** The journal's name for a task of this kind: `wake 7 blocked (...)`. */
  noun: string;
  /** Whose queued inputs to withdraw. */
  requestPrefix: (taskId: TaskId) => string;
  /** The kind's own failure report for a blocked task (journal, best-effort notify). */
  report: (task: TaskInspection, reason: BlockedReason, ctx: Context) => Promise<void>;
}

/** The harness parts the sweep reads and calls. */
type SweepHarness = Pick<Harness, "inspect" | "abortSubmission" | "abortTask">;

/**
 * Withdraws the task's queued inputs, by request id (the kind's own namespace,
 * whatever the checkpoint's version); placed ones are left to run. How many it withdrew.
 */
const withdrawQueued = async (
  harness: SweepHarness,
  submissions: readonly SubmissionRecord[],
  task: TaskId,
  row: SweptKind,
  ctx: Context,
): Promise<number> => {
  const prefix = row.requestPrefix(task);
  let withdrawn = 0;
  for (const submission of submissions) {
    if (submission.status === "queued" && submission.requestId?.startsWith(prefix) === true) {
      const answer = await harness.abortSubmission(submission.id, ctx, submission.conversationId);
      withdrawn += answer === "aborted" ? 1 : 0;
    }
  }
  return withdrawn;
};

/** One blocked task of a listed kind: log, withdraw, log, report, and abort last. */
const sweepBlocked = async (
  harness: SweepHarness,
  row: SweptKind,
  task: TaskInspection,
  reason: BlockedReason,
  submissions: readonly SubmissionRecord[],
  log: Log,
  ctx: Context,
): Promise<void> => {
  const id = task.record.id;
  const name = `${row.noun} ${String(id)}`;
  log(`${name} blocked (${reason}); aborting`);
  const withdrawn = await withdrawQueued(harness, submissions, id, row, ctx);
  log(`${name} withdrew ${String(withdrawn)} queued input(s)`);
  await row.report(task, reason, ctx);
  await harness.abortTask(id, ctx);
};

/** At start, for each blocked task of a listed kind: withdraw its queued inputs, report, abort it. */
export const sweepBlockedTasks = async (
  harness: SweepHarness,
  kinds: readonly SweptKind[],
  log: Log,
  ctx: Context,
): Promise<void> => {
  const { tasks, submissions } = await harness.inspect(ctx);
  for (const task of tasks) {
    const { record, state } = task;
    if (state.kind !== "blocked") {
      continue;
    }
    const row = kinds.find((candidate) => candidate.kind === record.kind);
    if (row === undefined) {
      continue;
    }
    await sweepBlocked(harness, row, task, state.reason, submissions, log, ctx);
  }
};
