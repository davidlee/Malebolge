// SATAN's wake tools (SL-034 design § Tools): wake_schedule, wake_cancel and
// wake_list, native to the `tasks` extension, so they work with Emacs absent.
// They need the harness, which the tool api does not expose, so they read it
// from the late-bound deps at each call (design § Daemon wiring).

import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineTool,
  type JsonObject,
  type Task,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { contextOf } from "../conversation-context.ts";
import { isConversationKey } from "../conversations.ts";
import { isRecord } from "../json.ts";
import { isKnownTopic, latestIn, readIndex } from "../topics.ts";
import type { WakeDeps } from "./extension.ts";
import {
  createWakeTask,
  liveWakes,
  type WakeInput,
  type WakeResult,
  type WakeState,
} from "./task.ts";

type WakeTask = Task<WakeInput, WakeState, WakeResult, object>;

const MINUTE = 60_000;

/** `ms` as ISO-8601 local time with its offset: the zone the quiet window is read in. */
export const localIso = (ms: number): string => {
  const date = new Date(ms);
  const pad = (n: number, width = 2): string =>
    String(Math.trunc(Math.abs(n))).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const zone =
    offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${zone}`
  );
};

/** A result the model reads as JSON. */
const answer = (value: object): ToolExecutionResult => ({
  output: [{ type: "text", text: JSON.stringify(value) }],
});

/** A refusal: the call did nothing. */
const refusal = (text: string): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  isError: true,
});

/** The conversation a wake goes to, or why there is none: the caller, or a known topic's latest now (W8). */
const targetOf = async (
  api: ToolExecutionApi,
  topic: string | undefined,
): Promise<ConversationId | string> => {
  if (topic === undefined) {
    return api.conversationId;
  }
  const index = await readIndex(api);
  if (!isKnownTopic(index, topic)) {
    return `unknown topic: ${topic}`;
  }
  const latest = latestIn(index, topic);
  return latest !== undefined && isConversationKey(latest)
    ? latest
    : `topic ${topic} has no conversation`;
};

const scheduleParameters = Type.Object({
  intent: Type.String({ description: "Why you want to wake: shown to you when it fires" }),
  episode_class: Type.Union([Type.Literal("attend"), Type.Literal("seclude")], {
    description: "attend: wants the user present; seclude: self-work, wants the user away",
  }),
  after_minutes: Type.Optional(
    Type.Number({ description: "How long from now (default: the host's ceiling)" }),
  ),
  topic: Type.Optional(
    Type.String({
      description: "Wake in this topic's latest conversation (default: this conversation)",
    }),
  ),
  payload: Type.Optional(
    Type.Unsafe<JsonObject>({ type: "object", description: "Notes for the wake turn" }),
  ),
});

export const wakeSchedule = (
  deps: () => WakeDeps,
  task: WakeTask,
): ToolRegistration<typeof scheduleParameters> =>
  defineTool({
    name: "wake_schedule",
    description:
      "Ask to be woken later: the daemon starts a turn in a conversation at about the time asked, " +
      "inside the host's bounds (clamped and jittered; the quiet window and the user's presence may defer it). " +
      "Returns the decided time and whether wakes are enabled.",
    parameters: scheduleParameters,
    execute: async (args, api, ctx) => {
      const target = await targetOf(api, args.topic);
      if (typeof target === "string") {
        return refusal(target);
      }
      const wake = deps();
      const now = api.now();
      const requestedAt =
        args.after_minutes === undefined ? undefined : now + args.after_minutes * MINUTE;
      const at = wake.policy.schedule(requestedAt, {
        now: () => now,
        random: () => wake.random(),
        presence: () => Promise.resolve("unknown"),
      });
      const input: WakeInput = {
        conversationId: target,
        intent: args.intent,
        ...(args.payload === undefined ? {} : { payload: args.payload }),
        episodeClass: args.episode_class,
        at,
        ...(requestedAt === undefined ? {} : { requestedAt }),
        scheduledBy: api.conversationId,
      };
      const id = await api.commit((tx) => createWakeTask(tx, task, input), ctx);
      return answer({
        id,
        at: localIso(at),
        conversation: target,
        enabled: wake.settings.enabled,
      });
    },
  });

const cancelParameters = Type.Object({ id: Type.Number({ description: "The wake's id" }) });

export const wakeCancel = (deps: () => WakeDeps): ToolRegistration<typeof cancelParameters> =>
  defineTool({
    name: "wake_cancel",
    description:
      "Cancel a wake you scheduled, by id. Answers cancelled only when its turn will not run; " +
      "a wake that has already fired cannot be cancelled, nor can the heartbeat.",
    parameters: cancelParameters,
    execute: async (args, api, ctx) => {
      const wake = deps();
      const found = (await liveWakes(wake.harness, ctx)).find(({ id }) => id === args.id);
      if (found === undefined) {
        return refusal(`no live wake ${String(args.id)}`);
      }
      const { id } = found;
      if (found.input.recurring === true) {
        return refusal(`wake ${String(id)} is the heartbeat; it cannot be cancelled`);
      }
      // W9: only a settled {fired:false} means no turn; anything else may have run one.
      let cancelled = false;
      if (found.until !== undefined) {
        await wake.harness.abortTask(id, ctx);
        const { result } = (await api.waitForTask(id, ctx)).state.outcome;
        cancelled = isRecord(result) && result["fired"] === false;
      }
      wake.log(`wake ${String(id)} ${cancelled ? "cancelled" : "cancel: already fired"}`);
      return answer(cancelled ? { id, cancelled } : { id, cancelled, reason: "already fired" });
    },
  });

const listParameters = Type.Object({});

export const wakeList = (deps: () => WakeDeps): ToolRegistration<typeof listParameters> =>
  defineTool({
    name: "wake_list",
    description:
      "List your pending wakes, the heartbeat included (recurring), and whether wakes are enabled.",
    parameters: listParameters,
    execute: async (_args, api, ctx) => {
      const wake = deps();
      const sleeping = (await liveWakes(wake.harness, ctx)).flatMap(({ id, input, until }) =>
        until === undefined ? [] : [{ id, input, until }],
      );
      const wakes = await Promise.all(
        sleeping.map(
          async ({ id, input, until }): Promise<JsonObject> => ({
            id,
            at: localIso(until),
            topic: (await contextOf(api, input.conversationId)).entry?.topic ?? null,
            conversation: input.conversationId,
            intent: input.intent,
            episode_class: input.episodeClass,
            ...(input.recurring === undefined ? {} : { recurring: true }),
          }),
        ),
      );
      return answer({ enabled: wake.settings.enabled, wakes });
    },
  });
