// satan.wake v1 (SL-034 design § The wake task, § Fire composition): one task
// definition for one-shot wakes and the heartbeat. `fire` gates and composes the
// occurrence's input; `submit` re-checks the host's bounds, submits it once
// (W1: its request id carries the occurrence counter `n`) and waits for its turn.

import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  defineTask,
  type JsonObject,
  type RunningTask,
  type Task,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { contextOf } from "../conversation-context.ts";
import { messageOf } from "../message-of.ts";
import type { PoolKey } from "../satan-pool.ts";
import type { WakeDeps } from "./extension.ts";
import type { EpisodeClass, Gate, WakeEnv } from "./policy.ts";
import { presenceOf } from "./presence.ts";

export type { EpisodeClass };

/** Any JSON value (pi-durable exports only its object form). */
type JsonValue = JsonObject[string];

/** The task kind, and the entry kind its input is placed as. */
export const WAKE_KIND = "satan.wake";

/** How long each scheduled satan-mcp call (presence, percept, notify) may take. */
export const SATAN_CALL_DEADLINE_MS = 10_000;

export interface WakeInput {
  /** The target, fixed at schedule (W8). */
  conversationId: ConversationId;
  /** SATAN's own words: why it wants to wake. */
  intent: string;
  /** Optional structured notes for the wake turn. */
  payload?: JsonValue;
  episodeClass: EpisodeClass;
  /** Decided by `WakePolicy.schedule` (ms, harness clock). */
  at: number;
  /** What SATAN asked for, kept for audit. */
  requestedAt?: number;
  /** The scheduling tool's conversation. */
  scheduledBy: ConversationId;
  /** The heartbeat only. */
  recurring?: true;
}

export type WakeState =
  // `prepared`: an earlier `submit` of this occurrence may have admitted its input.
  | { phase: "fire"; at: number; n: number; prepared?: true }
  | { phase: "submit"; at: number; n: number; firedAt: number; content: string };

export interface WakeResult {
  fired: boolean;
}

type FireState = Extract<WakeState, { phase: "fire" }>;
type SubmitState = Extract<WakeState, { phase: "submit" }>;
type Runtime = TaskRuntime<WakeInput, WakeState, WakeResult, object>;
type Wake<S extends WakeState> = RunningTask<WakeInput, S, WakeResult>;

/** The request id of occurrence `n` of task `taskId`: pi-durable dedupes it per conversation (W1). */
export const wakeRequestId = (taskId: number, n: number): string =>
  `wake:${String(taskId)}:${String(n)}`;

/** Where the occurrence's scheduled satan-mcp calls go: the target's own connection of that kind. */
const scheduledKey = (input: WakeInput): PoolKey => ({
  conversation: input.conversationId,
  kind: "scheduled",
});

/** The text items of a satan-mcp result, joined. */
const textOf = (result: CallToolResult): string =>
  result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

/** The policy's env for this wake: the harness clock, the dice, presence over the scheduled connection. */
const envOf = (deps: WakeDeps, input: WakeInput): WakeEnv => ({
  now: () => deps.now(),
  random: () => deps.random(),
  presence: async () =>
    presenceOf(
      await deps.satan.call(
        scheduledKey(input),
        "activity_read",
        { scope: "current" },
        SATAN_CALL_DEADLINE_MS,
      ),
    ),
});

/**
 * The host's own bounds, the switch and the quiet window, without presence: the
 * policy's gate over an env whose presence is `unknown`, which fires with no dice.
 */
const hostGate = (deps: WakeDeps, input: WakeInput): Promise<Gate> =>
  deps.policy.gate(input, { ...envOf(deps, input), presence: () => Promise.resolve("unknown") });

/** The percept (satan_boot_context), or why there is none: a wake fires without a percept rather than not at all. */
const perceptOf = async (deps: WakeDeps, input: WakeInput): Promise<string> => {
  try {
    const result = await deps.satan.call(
      scheduledKey(input),
      "satan_boot_context",
      { refresh: true },
      SATAN_CALL_DEADLINE_MS,
    );
    return result.isError === true ? `percept unavailable: ${textOf(result)}` : textOf(result);
  } catch (error) {
    return `percept unavailable: ${messageOf(error)}`;
  }
};

const MINUTE = 60_000;

/** The input text the model sees (design § Fire composition). */
/**
 * ` late_by="<minutes>"`: how far defers pushed the occurrence past `input.at`.
 * Only occurrence 0 was due then; a heartbeat's later occurrences carry none,
 * since the checkpoint's `at` moves with every defer and keeps no due time.
 */
const lateBy = (input: WakeInput, n: number, firedAt: number): string =>
  n === 0 ? ` late_by="${String(Math.round((firedAt - input.at) / MINUTE))}"` : "";

const contentOf = (
  input: WakeInput,
  n: number,
  firedAt: number,
  fragment: string,
  percept: string,
): string =>
  [
    `<wake fired_at="${new Date(firedAt).toISOString()}"${lateBy(input, n, firedAt)} class="${input.episodeClass}" scheduled_by="${String(input.scheduledBy)}">`,
    fragment,
    `<intent>${input.intent}</intent>`,
    ...(input.payload === undefined ? [] : [`<payload>${JSON.stringify(input.payload)}</payload>`]),
    `<percept>${percept}</percept>`,
    "</wake>",
  ].join("\n");

/** How the journal names a wake's target: its topic, or the conversation when it is no topic's. */
const topicOf = async (runtime: Runtime, input: WakeInput): Promise<string> =>
  (await contextOf(runtime, input.conversationId)).entry?.topic ??
  `conversation ${String(input.conversationId)}`;

/** One journal line about occurrence `n` (W7). */
const journal = async (
  deps: WakeDeps,
  runtime: Runtime,
  input: WakeInput,
  n: number,
  event: string,
): Promise<void> => {
  deps.log(
    `wake ${String(runtime.taskId)} n=${String(n)} (${await topicOf(runtime, input)}) ${event}`,
  );
};

/** A defer: back to `fire` at `until`, keeping `n` and anything else the checkpoint holds. */
const defer = async (
  deps: WakeDeps,
  task: Wake<WakeState>,
  runtime: Runtime,
  ctx: Context,
  gate: Extract<Gate, { kind: "defer" }>,
  next: FireState,
): Promise<void> => {
  await journal(
    deps,
    runtime,
    task.input,
    next.n,
    `defer ${gate.reason} until ${new Date(gate.until).toISOString()}`,
  );
  await runtime.sleepUntil(gate.until, next, ctx);
};

/** The heartbeat's next occurrence: one ceiling on, `n + 1`, in the one sleep commit. */
const nextBeat = (deps: WakeDeps, runtime: Runtime, n: number, ctx: Context): Promise<void> => {
  const at = deps.now() + deps.settings.ceilingMs;
  return runtime.sleepUntil(at, { phase: "fire", at, n: n + 1 }, ctx);
};

/**
 * DEC-134: journal, notify (best effort), then a one-shot fails and the
 * heartbeat moves on to its next occurrence.
 */
const failed = async (
  deps: WakeDeps,
  task: Wake<WakeState>,
  runtime: Runtime,
  ctx: Context,
  n: number,
  reason: string,
): Promise<void> => {
  const input = task.input;
  await journal(deps, runtime, input, n, `failed: ${reason}`);
  const body = `wake ${String(runtime.taskId)} (${await topicOf(runtime, input)}): ${reason}`;
  await deps.satan
    .call(
      scheduledKey(input),
      "notify_send",
      { title: "SATAN wake failed", body },
      SATAN_CALL_DEADLINE_MS,
    )
    .catch(() => undefined);
  if (input.recurring === true) {
    await nextBeat(deps, runtime, n, ctx);
    return;
  }
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "failed", error: { message: reason } } }),
    ctx,
  );
};

/**
 * `work`'s failure as a reason, or rethrown when the invocation ended: a close
 * is not a failure, and the phase re-runs on reopen (W1).
 */
const reasonOf = (runtime: Runtime, error: unknown): string => {
  if (runtime.signal.aborted) {
    throw error;
  }
  return messageOf(error);
};

/** Gate, then compose the occurrence's input and checkpoint it for `submit`. */
const fire = async (
  deps: WakeDeps,
  task: Wake<FireState>,
  runtime: Runtime,
  ctx: Context,
): Promise<void> => {
  const state = task.state.checkpoint;
  const input = task.input;
  if (deps.now() < state.at) {
    // `resume()` re-runs a phase cut off mid-run, whatever its time.
    await runtime.sleepUntil(state.at, state, ctx);
    return;
  }
  const gate = await deps.policy.gate(input, envOf(deps, input));
  if (gate.kind === "defer") {
    await defer(deps, task, runtime, ctx, gate, { ...state, at: gate.until });
    return;
  }
  await journal(deps, runtime, input, state.n, "fire");
  let fragment: string;
  try {
    fragment = deps.fragment();
  } catch (error) {
    await failed(deps, task, runtime, ctx, state.n, reasonOf(runtime, error));
    return;
  }
  // A stale tool list is no reason to skip the turn: the refresh only reports its own failures.
  await deps.satan.refresh().catch(() => undefined);
  const percept = await perceptOf(deps, input);
  const firedAt = deps.now();
  await runtime.commit(
    () => ({
      status: "running",
      checkpoint: {
        phase: "submit",
        at: state.at,
        n: state.n,
        firedAt,
        content: contentOf(input, state.n, firedAt, fragment, percept),
      },
    }),
    ctx,
  );
};

/** The entry the input is placed as: the wake's facts, for the transcript. */
const entryOf = (runtime: Runtime, input: WakeInput, state: SubmitState): JsonObject => ({
  taskId: runtime.taskId,
  n: state.n,
  at: state.at,
  firedAt: state.firedAt,
  intent: input.intent,
  ...(input.payload === undefined ? {} : { payload: input.payload }),
  episodeClass: input.episodeClass,
  scheduledBy: input.scheduledBy,
});

/**
 * Submit the composed input once and wait for its turn: `undefined` when it was
 * answered, else why not. The host's bounds are checked first by the caller.
 */
const placed = async (
  runtime: Runtime,
  input: WakeInput,
  state: SubmitState,
  ctx: Context,
): Promise<string | undefined> => {
  try {
    const target = await runtime.conversation(input.conversationId, ctx);
    if (target === undefined) {
      return "target unreachable";
    }
    const submission = await target.submit(
      {
        type: "input",
        whenBusy: "followUp",
        requestId: wakeRequestId(runtime.taskId, state.n),
        entry: { kind: WAKE_KIND, data: entryOf(runtime, input, state) },
        content: state.content,
      },
      ctx,
    );
    const settled = await submission.wait(ctx);
    return settled.status === "done" ? undefined : `unanswered (${settled.reason})`;
  } catch (error) {
    return reasonOf(runtime, error);
  }
};

/** Re-check the host's bounds, submit, wait, then end the occurrence. */
const submit = async (
  deps: WakeDeps,
  task: Wake<SubmitState>,
  runtime: Runtime,
  ctx: Context,
): Promise<void> => {
  const state = task.state.checkpoint;
  const input = task.input;
  // W3: a restart between this checkpoint and admission must not bypass the switch or the window.
  const gate = await hostGate(deps, input);
  if (gate.kind === "defer") {
    await defer(deps, task, runtime, ctx, gate, {
      phase: "fire",
      at: gate.until,
      n: state.n,
      prepared: true,
    });
    return;
  }
  const reason = await placed(runtime, input, state, ctx);
  if (reason !== undefined) {
    await failed(deps, task, runtime, ctx, state.n, reason);
    return;
  }
  await journal(deps, runtime, input, state.n, "done");
  if (input.recurring === true) {
    await nextBeat(deps, runtime, state.n, ctx);
    return;
  }
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "completed", result: { fired: true } } }),
    ctx,
  );
};

/** satan.wake v1 over the late-bound `deps`, read at every phase entry. */
export const wakeTask = (deps: () => WakeDeps): Task<WakeInput, WakeState, WakeResult, object> =>
  defineTask<WakeInput, WakeState, WakeResult>({
    name: WAKE_KIND,
    version: 1,
    initial: (input) => ({ phase: "fire", at: input.at, n: 0 }),
    phases: {
      fire: (task, runtime, ctx) => fire(deps(), task, runtime, ctx),
      submit: (task, runtime, ctx) => submit(deps(), task, runtime, ctx),
    },
    // Until PHASE-05's withdraw: an occurrence that may be admitted reports fired,
    // never the reverse (W9's permitted overstatement).
    abort: (task, runtime, ctx) => {
      const state = task.state.checkpoint;
      const fired = state.phase === "submit" || state.prepared === true;
      return runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result: { fired } } }),
        ctx,
      );
    },
  });
