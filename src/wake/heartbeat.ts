// The heartbeat (SL-034 design § Heartbeat, DEC-131): exactly one viable
// recurring satan.wake after every daemon start (W5), so SATAN gets a turn about
// every ceiling even when it schedules nothing.

import type { Context } from "@earendil-works/chord/context";
import type { Task, TaskId } from "@earendil-works/pi-durable";
import type { WakeDeps } from "./extension.ts";
import {
  createWakeTask,
  liveWakes,
  type WakeInput,
  type WakeResult,
  type WakeState,
} from "./task.ts";

/** The heartbeat's fixed intent: host words, not SATAN's. */
export const HEARTBEAT_INTENT = "heartbeat: nothing else is scheduled";

/**
 * Creates the heartbeat in the topic's latest (or first) conversation unless a
 * viable one is live: recurring, not abort-marked, not blocked. After the start
 * sweep, whose aborts are abort-marked or terminal, so a restart between the
 * sweep's abort and this create still ends with one. Its id when created.
 */
export const ensureHeartbeat = async (
  deps: WakeDeps,
  task: Task<WakeInput, WakeState, WakeResult, object>,
  ctx: Context,
): Promise<TaskId<WakeResult> | undefined> => {
  const { topic, ceilingMs } = deps.settings;
  await deps.conversations.setTopic({ name: topic });
  const viable = (await liveWakes(deps.harness, ctx)).some(
    ({ input, blocked, abortRequested }) => input.recurring === true && !blocked && !abortRequested,
  );
  if (viable) {
    return undefined;
  }
  const target = await deps.conversations.open({
    kind: "topic",
    name: topic,
    new: false,
  });
  const input: WakeInput = {
    conversationId: target.id,
    intent: HEARTBEAT_INTENT,
    episodeClass: "seclude",
    at: deps.now() + ceilingMs,
    scheduledBy: target.id,
    recurring: true,
  };
  const id = await target.commit((tx) => createWakeTask(tx, task, input), ctx);
  deps.log(`wake heartbeat ${String(id)} created in ${topic}`);
  return id;
};
