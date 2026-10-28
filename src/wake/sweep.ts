// The wake's row in the start sweep (SL-034 design § Heartbeat; SL-006 design
// § Components and boundaries): a live satan.wake that cannot run here is
// reported failed unless it is the heartbeat (replaced by `ensureHeartbeat`) or
// was cancelled before it could run. The sweep itself is src/task-sweep.ts.

import type { BlockedReason, TaskInspection } from "@earendil-works/pi-durable";
import type { SweptKind } from "../task-sweep.ts";
import type { IndexReader } from "../topics.ts";
import type { WakeDeps } from "./extension.ts";
import { isWakeInput, reportFailure, WAKE_KIND, wakeRequestPrefix } from "./task.ts";

/** A one-shot's failure report, which `read` names the topic of. */
const report = async (
  deps: WakeDeps,
  read: IndexReader,
  task: TaskInspection,
  reason: BlockedReason,
): Promise<void> => {
  // A heartbeat is replaced by `ensureHeartbeat` instead; a cancelled wake did not fail.
  const { id, input, abortRequested } = task.record;
  if (isWakeInput(input) && input.recurring !== true && !abortRequested) {
    await reportFailure(deps, read, id, input, undefined, `blocked (${reason})`);
  }
};

/** The wake's sweep row: the kind, its own request namespace, and its report rule. */
export const wakeSweptKind = (deps: WakeDeps, read: IndexReader): SweptKind => ({
  kind: WAKE_KIND,
  noun: "wake",
  requestPrefix: wakeRequestPrefix,
  report: (task, reason) => report(deps, read, task, reason),
});
