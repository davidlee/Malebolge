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
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { contextOf } from "../conversation-context.ts";
import { isConversationKey } from "../conversations.ts";
import type { Profile } from "../config.ts";
import { isRecord } from "../json.ts";
import { messageOf } from "../message-of.ts";
import { answer, refusal } from "../tool-results.ts";
import { requireSameTalkSet } from "../toolsets.ts";
import { type IndexDoc, isKnownTopic, latestIn, readIndex, storedEntry } from "../topics.ts";
import type { WakeDeps } from "./extension.ts";
import { localIso } from "./local-time.ts";
import {
  createWakeTask,
  liveWakes,
  type WakeInput,
  type WakeResult,
  type WakeState,
} from "./task.ts";

type WakeTask = Task<WakeInput, WakeState, WakeResult, object>;

const MINUTE = 60_000;

/**
 * A wake's destination (W8): the caller itself, or a topic's latest conversation and
 * the one index read that resolved it. The reach check reads entries from that index;
 * a self-wake skips the check, so it needs none (design sec-6; DEC-076).
 */
type Target =
  | { readonly kind: "self"; readonly id: ConversationId }
  | {
      readonly kind: "topic";
      readonly id: ConversationId;
      readonly topic: string;
      readonly index: IndexDoc;
    };

/** The conversation a wake goes to, or why there is none: the caller, or a known topic's latest now (W8). */
const targetOf = async (
  api: ToolExecutionApi,
  topic: string | undefined,
): Promise<Target | string> => {
  if (topic === undefined) {
    return { kind: "self", id: api.conversationId };
  }
  const index = await readIndex(api);
  if (!isKnownTopic(index, topic)) {
    return `unknown topic: ${topic}`;
  }
  const latest = latestIn(index, topic);
  return latest !== undefined && isConversationKey(latest)
    ? { kind: "topic", id: latest, topic, index }
    : `topic ${topic} has no conversation`;
};

/**
 * Why a wake from `caller` may not reach `target`, or undefined when it may: the two
 * conversations' index entries, then the talk set they must share (design sec-6;
 * DEC-076). An entry nobody wrote — a conversation the reconcile has not backfilled —
 * is refused rather than given a toolset it did not state.
 */
const reachRefusal = (
  profile: Profile,
  index: IndexDoc,
  caller: ConversationId,
  target: ConversationId,
  topic: string,
): string | undefined => {
  const noEntry = (id: ConversationId): string =>
    `topic ${topic}: conversation ${String(id)} has no index entry`;
  const callerEntry = storedEntry(index, caller);
  if (callerEntry === undefined) {
    return noEntry(caller);
  }
  const targetEntry = storedEntry(index, target);
  if (targetEntry === undefined) {
    return noEntry(target);
  }
  try {
    requireSameTalkSet(profile, callerEntry.toolset, targetEntry.toolset, `topic ${topic}`);
    return undefined;
  } catch (error) {
    return messageOf(error);
  }
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
      const caller = api.conversationId;
      // A self-wake reaches only itself, whatever the toolset; a topic target must share
      // the caller's talk set, so bridge wakes only bridge and nothing wakes into it.
      if (target.kind === "topic" && target.id !== caller) {
        const refused = reachRefusal(wake.profile, target.index, caller, target.id, target.topic);
        if (refused !== undefined) {
          return refusal(refused);
        }
      }
      const now = api.now();
      const requestedAt =
        args.after_minutes === undefined ? undefined : now + args.after_minutes * MINUTE;
      const at = wake.policy.schedule(requestedAt, {
        now: () => now,
        random: () => wake.random(),
        presence: () => Promise.resolve("unknown"),
      });
      const input: WakeInput = {
        conversationId: target.id,
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
        conversation: target.id,
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
