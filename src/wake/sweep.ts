// The start sweep (SL-034 design § Heartbeat): a live satan.wake that cannot run
// here is journalled, its still-queued inputs withdrawn, a one-shot reported as
// failed, and the task aborted last: the abort can end the task's visibility (a
// definition-blocked task settles `orphaned` in the abort's own commit), so a
// crash before it leaves the task live and the next start repeats the sweep.

import type { Context } from "@earendil-works/chord/context";
import type {
  BlockedReason,
  JsonObject,
  SubmissionRecord,
  TaskId,
} from "@earendil-works/pi-durable";
import type { IndexReader } from "../topics.ts";
import type { WakeDeps } from "./extension.ts";
import { isWakeInput, reportFailure, WAKE_KIND, wakeRequestPrefix } from "./task.ts";

/** A wake no definition here can run, or that the restart limit parked. */
interface BlockedWake {
  readonly id: TaskId;
  /** As stored: read only to tell a one-shot from the heartbeat. */
  readonly input: JsonObject[string];
  readonly reason: BlockedReason;
  /** Cancelled before it could run here: no failure to report. */
  readonly abortRequested: boolean;
}

/**
 * Withdraws `wake`'s queued inputs, by request id (W1's namespace, whatever the
 * checkpoint's version); placed ones are left to run. How many it withdrew.
 */
const withdrawQueued = async (
  deps: WakeDeps,
  wake: BlockedWake,
  submissions: readonly SubmissionRecord[],
  ctx: Context,
): Promise<number> => {
  const prefix = wakeRequestPrefix(wake.id);
  let withdrawn = 0;
  for (const submission of submissions) {
    if (submission.status === "queued" && submission.requestId?.startsWith(prefix) === true) {
      const answer = await deps.harness.abortSubmission(
        submission.id,
        ctx,
        submission.conversationId,
      );
      withdrawn += answer === "aborted" ? 1 : 0;
    }
  }
  return withdrawn;
};

const sweep = async (
  deps: WakeDeps,
  read: IndexReader,
  wake: BlockedWake,
  submissions: readonly SubmissionRecord[],
  ctx: Context,
): Promise<void> => {
  const { id, input, reason, abortRequested } = wake;
  deps.log(`wake ${String(id)} blocked (${reason}); aborting`);
  const withdrawn = await withdrawQueued(deps, wake, submissions, ctx);
  deps.log(`wake ${String(id)} withdrew ${String(withdrawn)} queued input(s)`);
  // A heartbeat is replaced by `ensureHeartbeat` instead; a cancelled wake did not fail.
  if (isWakeInput(input) && input.recurring !== true && !abortRequested) {
    await reportFailure(deps, read, id, input, undefined, `blocked (${reason})`);
  }
  await deps.harness.abortTask(id, ctx);
};

/**
 * Room profile, after `resume()` and before `ensureHeartbeat`, under the instance
 * lock. `read` names a one-shot's topic in its failure report.
 */
export const sweepBlockedWakes = async (
  deps: WakeDeps,
  read: IndexReader,
  ctx: Context,
): Promise<void> => {
  const { tasks, submissions } = await deps.harness.inspect(ctx);
  for (const { record, state } of tasks) {
    if (record.kind === WAKE_KIND && state.kind === "blocked") {
      const { id, input, abortRequested } = record;
      const wake = { id, input, reason: state.reason, abortRequested };
      await sweep(deps, read, wake, submissions, ctx);
    }
  }
};
