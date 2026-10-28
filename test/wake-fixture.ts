// The wake task's test world (SL-034 PHASE-04/05): a harness over a store that
// outlives a close, a stopped clock that also drives the harness timer, and
// scripted satan-mcp answers, shared by wake-task.test.ts and wake-wait.test.ts.

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import {
  type Conversation,
  type ConversationId,
  defineExtension,
  type EntryRecord,
  type Extension,
  type Harness,
  MemoryStorage,
  type Storage,
  type SubmissionRecord,
  type Task,
  type TaskId,
  type TaskInspection,
  type TaskOutcome,
} from "@earendil-works/pi-durable";
import { expect, vi } from "vitest";
import { context } from "../src/context.ts";
import { conversations } from "../src/conversations.ts";
import { isRecord, type JsonRecord } from "../src/json.ts";
import { registryOf } from "../src/registry.ts";
import type { PoolKey } from "../src/satan-pool.ts";
import type { Log, SatanTools } from "../src/satan-tools.ts";
import { openSession } from "../src/session.ts";
import { tasksExtension, type WakeDeps } from "../src/wake/extension.ts";
import {
  type Gate,
  type QuietWindow,
  type WakePolicy,
  type WakeSettings,
  v0Policy,
} from "../src/wake/policy.ts";
import {
  WAKE_KIND,
  type WakeInput,
  type WakeResult,
  type WakeState,
  wakeRequestId,
  wakeTask,
} from "../src/wake/task.ts";
import {
  closing,
  FAUX_MODEL,
  fakeClock,
  type FakeClock,
  fakeTimers,
  type FakeTimers,
  nodeEnv,
} from "./harness-fixture.ts";

export const HOUR = 3_600_000;
export const FLOOR = 300_000;
export const CEILING = 7_200_000;
/** 23:20-07:00: the default quiet window (VT-1). */
export const QUIET: QuietWindow = { startMin: 23 * 60 + 20, endMin: 7 * 60 };
/** How long a poll waits: a phase's commit lands asynchronously, so nothing is read once. */
export const WAIT = { timeout: 3_000, interval: 10 };

/** A local wall-clock instant on the wake's day (October 2026), built locally so the tests hold in any zone. */
export const local = (day: number, hour: number, minute: number): number =>
  new Date(2026, 9, day, hour, minute).getTime();

/** Noon on the wake's day: well outside the quiet window. */
export const START = local(28, 12, 0);

/** The fact satan-mcp prints for a current window whose user is `presence` (wake-presence.test.ts' fixture). */
export const printed = (presence: string): string =>
  String.raw`(:scope "current" :status "ok" :window (:app_id "firefox" :title "x :presence \"idle\" y" :since "2026-10-28T10:00:00+11:00") :presence (:status "ok" :window_minutes 10 :key_seconds 41 :pointer_seconds 12 :presence "${presence}"))`;

/** The room user typing: present. */
export const TYPING = printed("typing");
/** The room user idle: away. */
export const IDLE = printed("idle");
/** What satan-mcp answers a percept request. */
export const PERCEPT = "PERCEPT TEXT";
/** What wake.md holds in these tests. */
export const FRAGMENT = "FRAGMENT TEXT";

/** A satan-mcp tool result whose only content is `text`. */
export const result = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
});

/** One satan-mcp call the wake made. */
export interface SatanCall {
  readonly key: PoolKey;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly deadlineMs: number;
}

/** What the fake satan-mcp answers; a test turns these between phases. */
export interface SatanScript {
  /** The presence `activity_read` prints. */
  presence: string;
  /** Every call rejects: a satan-mcp that is down. */
  unreachable: boolean;
  /** `fragment()` throws: wake.md is missing. */
  fragmentThrows: boolean;
}

/** The result of one scripted satan-mcp call. */
export function answer(tool: string, presence: string): CallToolResult {
  switch (tool) {
    case "activity_read":
      return result(presence);
    case "satan_boot_context":
      return result(PERCEPT);
    case "notify_send":
      return result("sent");
    default:
      throw new Error(`unexpected satan-mcp tool: ${tool}`);
  }
}

/** One opened session and the conversation the wakes target. */
export interface WakeSession {
  readonly harness: Harness;
  readonly root: Conversation;
}

/** Memory storage that survives its close: a crash leaves the store behind for the next process. */
export class ReopenableMemory extends MemoryStorage {
  /** While set, every commit fails: a process that dies before it can record anything. */
  crashed = false;

  override commit(
    ...args: Parameters<MemoryStorage["commit"]>
  ): ReturnType<MemoryStorage["commit"]> {
    return this.crashed ? Promise.reject(new Error("the process died")) : super.commit(...args);
  }

  /** MemoryStorage.close() only sets a flag, so leaving it clear keeps the store the same store. */
  override close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A wake under test: the clock, the dependencies a test scripts, and one store two sessions share. */
export interface WakeWorld {
  readonly clock: FakeClock;
  /** Moves the clock by `ms` and fires the harness timers then due: the bounded wait's among them. */
  readonly advance: (ms: number) => void;
  /** When each armed harness timer is due: a sleeping task's, the bounded wait's. */
  readonly pending: () => number[];
  /** The object every phase entry reads; a test swaps members of it between sessions. */
  readonly wake: WakeDeps;
  readonly task: Task<WakeInput, WakeState, WakeResult, object>;
  /** Every satan-mcp call the wake made, in order. */
  readonly calls: SatanCall[];
  /** What the wake logged, in order. */
  readonly lines: string[];
  readonly script: SatanScript;
  /** The one faux handle every session of the world shares, so requests count across a reopen. */
  readonly faux: FauxProviderHandle;
  /** Sets the wake switch, rebuilding the policy the next phase entry reads. */
  setEnabled(enabled: boolean): void;
  /**
   * The next session over the world's one store, closed when the test ends; it binds
   * `wake.harness` before resuming. `extension` replaces the tasks extension it
   * installs by default: a test registering a task of its own passes one.
   */
  open(extension?: Extension): Promise<WakeSession>;
  /**
   * Ends `session` as a crash does: its close writes nothing, so a task it was
   * running stays `running` and the next open counts a restart for it.
   */
  crash(session: WakeSession): Promise<void>;
}

export interface OpenWakeOptions {
  readonly clock: FakeClock;
  readonly storage: Storage;
  readonly faux: FauxProviderHandle;
  readonly task: Task<WakeInput, WakeState, WakeResult, object>;
  readonly setTimer: FakeTimers["setTimer"];
  /** Called with the session before any task runs: the daemon's second binding step. */
  readonly bind: (session: WakeSession) => void;
  /** The extension to install in place of the default one holding only `task`. */
  readonly extension?: Extension;
}

/** A session whose registry holds the wake task; the same `now` and timer the wake's env reads. */
export async function openWake(options: OpenWakeOptions): Promise<WakeSession> {
  const models = createModels();
  models.setProvider(options.faux.provider);
  const session = await openSession(options.storage, {
    models,
    registry: registryOf([
      options.extension ?? defineExtension({ name: "tasks", tasks: [options.task] }),
    ]),
    agent: { model: FAUX_MODEL },
    profile: "room",
    log: () => undefined,
    env: nodeEnv,
    now: options.clock.now,
    setTimer: options.setTimer,
    beforeResume: options.bind,
  });
  closing(session.harness);
  return session;
}

/** A world on a clock stopped at noon, with every dependency the phases read. */
export function wakeWorld(): WakeWorld {
  const clock = fakeClock(START);
  const calls: SatanCall[] = [];
  const lines: string[] = [];
  const script: SatanScript = {
    presence: TYPING,
    unreachable: false,
    fragmentThrows: false,
  };
  let settings: WakeSettings = {
    enabled: true,
    floorMs: FLOOR,
    ceilingMs: CEILING,
    quiet: QUIET,
    topic: "room",
  };
  const log: Log = (text): void => {
    lines.push(text);
  };
  const satan: Pick<SatanTools, "call" | "refresh"> = {
    refresh: (): Promise<void> => Promise.resolve(),
    call: (key, tool, args, deadlineMs): Promise<CallToolResult> => {
      calls.push({ key, tool, args, deadlineMs });
      if (script.unreachable) {
        return Promise.reject(new Error("satan-mcp is unreachable"));
      }
      return Promise.resolve(answer(tool, script.presence));
    },
  };
  const wake: WakeDeps = {
    settings,
    policy: v0Policy(settings),
    now: clock.now,
    random: () => 0,
    satan,
    fragment: (): string => {
      if (script.fragmentThrows) {
        throw new Error("wake.md is missing");
      }
      return FRAGMENT;
    },
    log,
    // Bound to each session as it opens.
    harness: {
      inspect: (): Promise<never> => Promise.reject(new Error("no session is open")),
      abortTask: (): Promise<never> => Promise.reject(new Error("no session is open")),
      abortSubmission: (): Promise<never> => Promise.reject(new Error("no session is open")),
    },
    // Bound to each session as it opens; the heartbeat's ensure reads them.
    conversations: {
      setTopic: (): Promise<never> => Promise.reject(new Error("no session is open")),
      open: (): Promise<never> => Promise.reject(new Error("no session is open")),
    },
  };
  const storage = new ReopenableMemory();
  const task = wakeTask(() => wake);
  /** The session's registry: the wake task and the three tools SATAN schedules it with. */
  const extension = tasksExtension(() => wake, task);
  const faux = fauxProvider();
  const timers = fakeTimers(clock);
  // The daemon's second binding step: the session's harness and its one Conversations.
  const bind = (session: WakeSession): void => {
    wake.harness = session.harness;
    wake.conversations = conversations(session, { model: FAUX_MODEL, cwd: process.cwd() }, "room");
  };
  return {
    clock,
    advance: timers.advance,
    pending: timers.pending,
    wake,
    task,
    calls,
    lines,
    script,
    faux,
    setEnabled(enabled: boolean): void {
      settings = { ...settings, enabled };
      wake.settings = settings;
      wake.policy = v0Policy(settings);
    },
    crash: async (session: WakeSession): Promise<void> => {
      storage.crashed = true;
      await session.harness.close(context).catch(() => undefined);
      storage.crashed = false;
    },
    open: (chosen?: Extension): Promise<WakeSession> =>
      openWake({
        clock,
        storage,
        faux,
        task,
        setTimer: timers.setTimer,
        bind,
        extension: chosen ?? extension,
      }),
  };
}

/** One wake's input: the target's own conversation scheduled it, an hour on by default. */
export function wakeInput(
  conversationId: ConversationId,
  changes: {
    readonly at?: number;
    readonly intent?: string;
    readonly recurring?: true;
  } = {},
): WakeInput {
  return {
    conversationId,
    intent: changes.intent ?? "look at the window",
    episodeClass: "attend",
    at: changes.at ?? START + HOUR,
    scheduledBy: conversationId,
    ...(changes.recurring === undefined ? {} : { recurring: changes.recurring }),
  };
}

/** Creates one wake task for `input`, as the scheduling tool does: conversation-owned, background. */
export async function createWake(
  session: WakeSession,
  task: Task<WakeInput, WakeState, WakeResult, object>,
  input: WakeInput,
): Promise<TaskId<WakeResult>> {
  const id = await session.harness.commit(
    (tx) =>
      tx.createTask(task, input, {
        ownership: { kind: "conversation" },
        conversationId: input.conversationId,
        background: true,
      }),
    context,
  );
  session.harness.resume();
  return id;
}

/** The live task `id`, as the scheduler shows it; fails while it is not live. */
export async function inspection(harness: Harness, id: TaskId): Promise<TaskInspection> {
  const { tasks } = await harness.inspect(context);
  const seen = tasks.find((task) => task.record.id === id);
  if (seen === undefined) {
    throw new Error(`task ${String(id)} is not live`);
  }
  return seen;
}

/** A live task record's checkpoint, as the object a test reads (pi-durable erases its type here). */
export const checkpointOf = (record: {
  readonly state: { readonly checkpoint?: unknown };
}): JsonRecord => (isRecord(record.state.checkpoint) ? record.state.checkpoint : {});

/** A task's stored sleep and checkpoint. */
export interface Sleeping {
  readonly until: number;
  readonly checkpoint: JsonRecord;
}

/** The task's sleep, once the scheduler has committed it. */
export async function waitSleeping(harness: Harness, id: TaskId): Promise<Sleeping> {
  await vi.waitFor(async () => {
    const { state } = await inspection(harness, id);
    expect(state.kind).toBe("sleeping");
  }, WAIT);
  const { record } = await inspection(harness, id);
  if (record.state.status !== "sleeping") {
    throw new Error(`task ${String(id)} is not sleeping`);
  }
  return { until: record.state.until, checkpoint: checkpointOf(record) };
}

/** Waits until every live task of `harness` sleeps: no task can run any more. */
export async function waitSettled(harness: Harness): Promise<void> {
  await vi.waitFor(async () => {
    const { tasks } = await harness.inspect(context);
    expect(tasks.filter((task) => task.state.kind !== "sleeping")).toEqual([]);
  }, WAIT);
}

/** The task's outcome, once it is terminal. */
export async function outcomeOf(
  harness: Harness,
  id: TaskId<WakeResult>,
): Promise<TaskOutcome<WakeResult>> {
  const record = await harness.getTask(id, context);
  if (record?.state.status !== "terminal") {
    throw new Error(`task ${String(id)} is not terminal`);
  }
  return record.state.outcome;
}

/** The task's outcome, polled: a phase commits its outcome asynchronously. */
export async function waitTerminal(
  harness: Harness,
  id: TaskId<WakeResult>,
): Promise<TaskOutcome<WakeResult>> {
  await vi.waitFor(async () => {
    const record = await harness.getTask(id, context);
    expect(record?.state.status).toBe("terminal");
  }, WAIT);
  return outcomeOf(harness, id);
}

/** The result of a wake that completed. */
export async function firedResult(harness: Harness, id: TaskId<WakeResult>): Promise<WakeResult> {
  const outcome = await waitTerminal(harness, id);
  if (outcome.status !== "completed") {
    throw new Error(`task ${String(id)} ended ${outcome.status}`);
  }
  return outcome.result;
}

/** The submission the wake's request id already identifies, when one was admitted (W1). */
export function submissionOf(
  harness: Harness,
  conversationId: ConversationId,
  requestId: string,
): Promise<SubmissionRecord | undefined> {
  return harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), context);
}

/** The entries of `conversation`, oldest first. */
export async function entriesOf(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 100, undefined, context);
  return [...page.items].reverse();
}

/** The `satan.wake` entries of `conversation`, oldest first. */
export async function wakeEntries(conversation: Conversation): Promise<EntryRecord[]> {
  return (await entriesOf(conversation)).filter((entry) => entry.kind === WAKE_KIND);
}

/** An entry's data as an object, or an empty one. */
export const dataOf = (entry: EntryRecord): JsonRecord => (isRecord(entry.data) ? entry.data : {});

/** The one item of `items`; fails unless there is exactly one. */
export function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [first] = items;
  if (first === undefined) {
    throw new Error("expected exactly one item");
  }
  return first;
}

/** The text of a message, when it is the user's: one string, or text blocks. */
export function userText(message: Message): string {
  if (message.role !== "user") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** The wake inputs among `requests`: the user messages that carry a `<wake` element. */
export const wakeInputs = (requests: readonly (readonly Message[])[]): string[] =>
  requests.flatMap((messages) => messages.map(userText)).filter((text) => text.includes("<wake"));

/** How many wake inputs `conversation`'s context holds: the turns a wake started there. */
export async function wakeUserMessages(conversation: Conversation): Promise<number> {
  const { messages } = await conversation.context(context);
  return messages.map(userText).filter((text) => text.includes("<wake")).length;
}

/** Every call the wake made went over the wake path's own connection. */
export function expectScheduled(calls: readonly SatanCall[], target: ConversationId): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.key).toEqual({ conversation: target, kind: "scheduled" });
  }
}

/** What the faux model saw, and the script that answers it. */
export interface Requests {
  /** Each request's messages, oldest first: the context the model was given. */
  readonly seen: Message[][];
  /** Queues `count` plain answers on the world's faux handle. */
  script(count?: number): void;
}

/** A recording script for the world's faux model: the model turns the wake's inputs cause. */
export function recording(world: WakeWorld): Requests {
  const seen: Message[][] = [];
  const step: FauxResponseFactory = (request): AssistantMessage => {
    seen.push([...request.messages]);
    return fauxAssistantMessage([fauxText("ok")]);
  };
  return {
    seen,
    script(count = 8): void {
      world.faux.setResponses(Array.from({ length: count }, () => step));
    },
  };
}

/** A model turn that holds until its run is cut off (a close or a crash), then answers. */
export const heldUntilCutOff: FauxResponseFactory = (_context, options) =>
  new Promise<AssistantMessage>((resolve) => {
    const cutOff = (): void => {
      resolve(fauxAssistantMessage([fauxText("cut off")]));
    };
    const signal = options?.signal;
    if (signal === undefined || signal.aborted) {
      cutOff();
      return;
    }
    signal.addEventListener("abort", cutOff, { once: true });
  });

/**
 * The first model turn holds until its run is cut off, then plain answers follow:
 * a crash while the occurrence's input is admitted and its turn unfinished.
 */
export function holdFirstTurn(world: WakeWorld): void {
  world.faux.setResponses([
    heldUntilCutOff,
    ...Array.from({ length: 8 }, () => fauxAssistantMessage([fauxText("ok")])),
  ]);
}

/** Waits until an input of wake `taskId` is placed in a running turn, whatever its occurrence. */
export async function waitPlaced(session: WakeSession, taskId: TaskId): Promise<void> {
  await vi.waitFor(async () => {
    const { submissions } = await session.harness.inspect(context);
    const ofWake = submissions.filter((submission) =>
      (submission.requestId ?? "").startsWith(`wake:${String(taskId)}:`),
    );
    expect(ofWake.map((submission) => submission.status)).toEqual(["placed"]);
  }, WAIT);
}

/** A gate whose second call waits for the test: a crash between the checkpoint and admission. */
export interface HeldGate {
  readonly policy: WakePolicy;
  /** Resolves when the submit phase asks its gate. */
  readonly secondSeen: Promise<undefined>;
  /** Answers that call. */
  readonly release: (gate: Gate) => void;
}

/** `inner`, except that the second gate call waits for `release`. */
export function heldGate(inner: WakePolicy): HeldGate {
  let calls = 0;
  const held = Promise.withResolvers<Gate>();
  const second = Promise.withResolvers<undefined>();
  const policy: WakePolicy = {
    schedule: (requested, env): number => inner.schedule(requested, env),
    gate: async (wake, env): Promise<Gate> => {
      calls += 1;
      if (calls !== 2) {
        return inner.gate(wake, env);
      }
      second.resolve(undefined);
      return held.promise;
    },
  };
  return { policy, secondSeen: second.promise, release: held.resolve };
}

/** A model turn that holds until the test releases it, then answers once. */
export interface GatedTurn {
  readonly step: FauxResponseStep;
  /** Resolves when the turn has started and the model is waiting. */
  readonly reached: Promise<undefined>;
  readonly release: () => void;
}

export function gatedTurn(answer: () => AssistantMessage): GatedTurn {
  const gate = Promise.withResolvers<undefined>();
  const reached = Promise.withResolvers<undefined>();
  const step: FauxResponseStep = async () => {
    reached.resolve(undefined);
    await gate.promise;
    return answer();
  };
  return {
    step,
    reached: reached.promise,
    release: (): void => {
      gate.resolve(undefined);
    },
  };
}

/** The model error pi-durable does not retry: the run fails and its input settles unanswered. */
export const failingOnce = (): GatedTurn =>
  gatedTurn(() =>
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" }),
  );

/** A turn held mid-run, then successful: a wake input placed in a turn that is still going. */
export const heldTurn = (): GatedTurn => gatedTurn(() => fauxAssistantMessage([fauxText("ok")]));

/** Every notification the wake sent, in order. */
export const notifyCalls = (world: WakeWorld): SatanCall[] =>
  world.calls.filter((call) => call.tool === "notify_send");

/** A model turn that records what the model saw, then answers plainly. */
export interface RecordedTurn {
  readonly step: FauxResponseFactory;
  readonly seen: Message[][];
}

export function recordedTurn(): RecordedTurn {
  const seen: Message[][] = [];
  const step: FauxResponseFactory = (request) => {
    seen.push([...request.messages]);
    return fauxAssistantMessage([fauxText("ok")]);
  };
  return { step, seen };
}

/** A real turn of the event loop: the phases commit on microtasks and short timers. */
export const turn = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, WAIT.interval);
  });

/** Waits until occurrence 0's input is admitted and queued behind the busy run. */
export async function waitQueued(
  session: WakeSession,
  taskId: TaskId<WakeResult>,
  conversationId: ConversationId = session.root.id,
): Promise<void> {
  await vi.waitFor(async () => {
    const record = await submissionOf(session.harness, conversationId, wakeRequestId(taskId, 0));
    expect(record?.status).toBe("queued");
  }, WAIT);
}
