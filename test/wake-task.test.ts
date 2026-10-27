// VT-1 to VT-3 of `satan.wake` v1, end to end: the fire and submit phases driven
// through a harness over a store that outlives a close, a stopped clock, and
// scripted satan-mcp answers (SL-034 design § The wake task, § Fire composition;
// PHASE-01 VT-1, VT-2 (W1), VT-3).

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxProviderHandle,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import {
  type Conversation,
  type ConversationId,
  defineExtension,
  type EntryRecord,
  type Harness,
  MemoryStorage,
  type Storage,
  type SubmissionRecord,
  type Task,
  type TaskId,
  type TaskInspection,
  type TaskOutcome,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import { isRecord, type JsonRecord } from "../src/json.ts";
import { registryOf } from "../src/registry.ts";
import type { PoolKey } from "../src/satan-pool.ts";
import type { Log, SatanTools } from "../src/satan-tools.ts";
import { openSession } from "../src/session.ts";
import type { WakeDeps } from "../src/wake/extension.ts";
import {
  type Gate,
  type QuietWindow,
  type WakePolicy,
  type WakeSettings,
  v0Policy,
} from "../src/wake/policy.ts";
import {
  SATAN_CALL_DEADLINE_MS,
  WAKE_KIND,
  type WakeInput,
  type WakeResult,
  type WakeState,
  wakeRequestId,
  wakeTask,
} from "../src/wake/task.ts";
import {
  closing,
  createConversation,
  FAUX_MODEL,
  fakeClock,
  type FakeClock,
  nodeEnv,
} from "./harness-fixture.ts";

const HOUR = 3_600_000;
const FLOOR = 300_000;
const CEILING = 7_200_000;
/** 23:20-07:00: the default quiet window (VT-1). */
const QUIET: QuietWindow = { startMin: 23 * 60 + 20, endMin: 7 * 60 };
/** How long a poll waits: a phase's commit lands asynchronously, so nothing is read once. */
const WAIT = { timeout: 3_000, interval: 10 };

/** A local wall-clock instant on the wake's day (October 2026), built locally so the tests hold in any zone. */
const local = (day: number, hour: number, minute: number): number =>
  new Date(2026, 9, day, hour, minute).getTime();

/** Noon on the wake's day: well outside the quiet window. */
const START = local(28, 12, 0);

/** The fact satan-mcp prints for a current window whose user is `presence` (wake-presence.test.ts' fixture). */
const printed = (presence: string): string =>
  String.raw`(:scope "current" :status "ok" :window (:app_id "firefox" :title "x :presence \"idle\" y" :since "2026-10-28T10:00:00+11:00") :presence (:status "ok" :window_minutes 10 :key_seconds 41 :pointer_seconds 12 :presence "${presence}"))`;

/** The room user typing: present. */
const TYPING = printed("typing");
/** The room user idle: away. */
const IDLE = printed("idle");
/** What satan-mcp answers a percept request. */
const PERCEPT = "PERCEPT TEXT";
/** What wake.md holds in these tests. */
const FRAGMENT = "FRAGMENT TEXT";

/** A satan-mcp tool result whose only content is `text`. */
const result = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

/** One satan-mcp call the wake made. */
interface SatanCall {
  readonly key: PoolKey;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly deadlineMs: number;
}

/** What the fake satan-mcp answers; a test turns these between phases. */
interface SatanScript {
  /** The presence `activity_read` prints. */
  presence: string;
  /** Every call rejects: a satan-mcp that is down. */
  unreachable: boolean;
  /** `fragment()` throws: wake.md is missing. */
  fragmentThrows: boolean;
}

/** The result of one scripted satan-mcp call. */
function answer(tool: string, presence: string): CallToolResult {
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
interface WakeSession {
  readonly harness: Harness;
  readonly root: Conversation;
}

/** Memory storage that survives its close: a crash leaves the store behind for the next process. */
class ReopenableMemory extends MemoryStorage {
  /** MemoryStorage.close() only sets a flag, so leaving it clear keeps the store the same store. */
  override close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A wake under test: the clock, the dependencies a test scripts, and one store two sessions share. */
interface WakeWorld {
  readonly clock: FakeClock;
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
  /** The next session over the world's one store, closed when the test ends. */
  open(): Promise<WakeSession>;
}

interface OpenWakeOptions {
  readonly clock: FakeClock;
  readonly storage: Storage;
  readonly faux: FauxProviderHandle;
  readonly task: Task<WakeInput, WakeState, WakeResult, object>;
}

/** A session whose registry holds the wake task; the same `now` the wake's env reads. */
async function openWake(options: OpenWakeOptions): Promise<WakeSession> {
  const models = createModels();
  models.setProvider(options.faux.provider);
  const session = await openSession(options.storage, {
    models,
    registry: registryOf([defineExtension({ name: "tasks", tasks: [options.task] })]),
    agent: { model: FAUX_MODEL },
    env: nodeEnv,
    now: options.clock.now,
  });
  closing(session.harness);
  return session;
}

/** A world on a clock stopped at noon, with every dependency the phases read. */
function wakeWorld(): WakeWorld {
  const clock = fakeClock(START);
  const calls: SatanCall[] = [];
  const lines: string[] = [];
  const script: SatanScript = { presence: TYPING, unreachable: false, fragmentThrows: false };
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
    // The fire and submit phases reach satan-mcp and the target conversation, never these.
    harness: {
      inspect: (): Promise<never> => Promise.reject(new Error("the wake phases never inspect")),
      abortTask: (): Promise<never> =>
        Promise.reject(new Error("the wake phases never abort a task")),
      abortSubmission: (): Promise<never> =>
        Promise.reject(new Error("the wake phases never abort a submission")),
    },
    conversations: {
      setTopic: (): Promise<never> =>
        Promise.reject(new Error("the wake phases never set a topic")),
      open: (): Promise<never> =>
        Promise.reject(new Error("the wake phases never open a conversation")),
    },
  };
  const storage = new ReopenableMemory();
  const task = wakeTask(() => wake);
  const faux = fauxProvider();
  return {
    clock,
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
    open: (): Promise<WakeSession> => openWake({ clock, storage, faux, task }),
  };
}

/** One wake's input: the target's own conversation scheduled it, an hour on by default. */
function wakeInput(
  conversationId: ConversationId,
  changes: { readonly at?: number; readonly intent?: string; readonly recurring?: true } = {},
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
async function createWake(
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
async function inspection(harness: Harness, id: TaskId): Promise<TaskInspection> {
  const { tasks } = await harness.inspect(context);
  const seen = tasks.find((task) => task.record.id === id);
  if (seen === undefined) {
    throw new Error(`task ${String(id)} is not live`);
  }
  return seen;
}

/** A live task record's checkpoint, as the object a test reads (pi-durable erases its type here). */
const checkpointOf = (record: { readonly state: { readonly checkpoint?: unknown } }): JsonRecord =>
  isRecord(record.state.checkpoint) ? record.state.checkpoint : {};

/** A task's stored sleep and checkpoint. */
interface Sleeping {
  readonly until: number;
  readonly checkpoint: JsonRecord;
}

/** The task's sleep, once the scheduler has committed it. */
async function waitSleeping(harness: Harness, id: TaskId): Promise<Sleeping> {
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
async function waitSettled(harness: Harness): Promise<void> {
  await vi.waitFor(async () => {
    const { tasks } = await harness.inspect(context);
    expect(tasks.filter((task) => task.state.kind !== "sleeping")).toEqual([]);
  }, WAIT);
}

/** The task's outcome, once it is terminal. */
async function outcomeOf(
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
async function waitTerminal(
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
async function firedResult(harness: Harness, id: TaskId<WakeResult>): Promise<WakeResult> {
  const outcome = await waitTerminal(harness, id);
  if (outcome.status !== "completed") {
    throw new Error(`task ${String(id)} ended ${outcome.status}`);
  }
  return outcome.result;
}

/** The submission the wake's request id already identifies, when one was admitted (W1). */
function submissionOf(
  harness: Harness,
  conversationId: ConversationId,
  requestId: string,
): Promise<SubmissionRecord | undefined> {
  return harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), context);
}

/** The entries of `conversation`, oldest first. */
async function entriesOf(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 100, undefined, context);
  return [...page.items].reverse();
}

/** The `satan.wake` entries of `conversation`, oldest first. */
async function wakeEntries(conversation: Conversation): Promise<EntryRecord[]> {
  return (await entriesOf(conversation)).filter((entry) => entry.kind === WAKE_KIND);
}

/** An entry's data as an object, or an empty one. */
const dataOf = (entry: EntryRecord): JsonRecord => (isRecord(entry.data) ? entry.data : {});

/** The one item of `items`; fails unless there is exactly one. */
function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [first] = items;
  if (first === undefined) {
    throw new Error("expected exactly one item");
  }
  return first;
}

/** The text of a message, when it is the user's: one string, or text blocks. */
function userText(message: Message): string {
  if (message.role !== "user") {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** The wake inputs among `requests`: the user messages that carry a `<wake` element. */
const wakeInputs = (requests: readonly (readonly Message[])[]): string[] =>
  requests.flatMap((messages) => messages.map(userText)).filter((text) => text.includes("<wake"));

/** How many wake inputs `conversation`'s context holds: the turns a wake started there. */
async function wakeUserMessages(conversation: Conversation): Promise<number> {
  const { messages } = await conversation.context(context);
  return messages.map(userText).filter((text) => text.includes("<wake")).length;
}

/** Every call the wake made went over the wake path's own connection. */
function expectScheduled(calls: readonly SatanCall[], target: ConversationId): void {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.key).toEqual({ conversation: target, kind: "scheduled" });
  }
}

/** What the faux model saw, and the script that answers it. */
interface Requests {
  /** Each request's messages, oldest first: the context the model was given. */
  readonly seen: Message[][];
  /** Queues `count` plain answers on the world's faux handle. */
  script(count?: number): void;
}

/** A recording script for the world's faux model: the model turns the wake's inputs cause. */
function recording(world: WakeWorld): Requests {
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

/**
 * The first model turn holds until its run is cut off, then plain answers follow:
 * a crash while the occurrence's input is admitted and its turn unfinished.
 */
function holdFirstTurn(world: WakeWorld): void {
  const held: FauxResponseFactory = (_context, options) =>
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
  world.faux.setResponses([
    held,
    ...Array.from({ length: 8 }, () => fauxAssistantMessage([fauxText("ok")])),
  ]);
}

/** Waits until an input of wake `taskId` is placed in a running turn, whatever its occurrence. */
async function waitPlaced(session: WakeSession, taskId: TaskId): Promise<void> {
  await vi.waitFor(async () => {
    const { submissions } = await session.harness.inspect(context);
    const ofWake = submissions.filter((submission) =>
      (submission.requestId ?? "").startsWith(`wake:${String(taskId)}:`),
    );
    expect(ofWake.map((submission) => submission.status)).toEqual(["placed"]);
  }, WAIT);
}

/** A gate whose second call waits for the test: a crash between the checkpoint and admission. */
interface HeldGate {
  readonly policy: WakePolicy;
  /** Resolves when the submit phase asks its gate. */
  readonly secondSeen: Promise<undefined>;
  /** Answers that call. */
  readonly release: (gate: Gate) => void;
}

/** `inner`, except that the second gate call waits for `release`. */
function heldGate(inner: WakePolicy): HeldGate {
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

describe("VT-1: a wake sleeps to its time, fires one composed turn, and completes", () => {
  it("VT-1 schedule → fire", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const requests = recording(world);
    requests.script();
    const intent = "the window is worth a look";
    const payload = { focus: "window" };
    const at = START + HOUR;
    const taskId = await createWake(session, world.task, {
      conversationId: session.root.id,
      intent,
      payload,
      episodeClass: "attend",
      at,
      scheduledBy: session.root.id,
    });

    // Not yet: the fire phase stores the same occurrence one sleep further on, and no turn runs.
    const sleep = await waitSleeping(session.harness, taskId);
    expect(sleep.until).toBe(at);
    expect(sleep.checkpoint["phase"]).toBe("fire");
    expect(sleep.checkpoint["n"]).toBe(0);
    expect(sleep.checkpoint["at"]).toBe(at);
    expect(requests.seen).toEqual([]);
    expect(await wakeEntries(session.root)).toEqual([]);

    world.clock.advance(HOUR);
    session.harness.resume();

    // Exactly one model turn, and it is the wake's.
    expect(await firedResult(session.harness, taskId)).toEqual({ fired: true });
    expect(requests.seen).toHaveLength(1);
    const text = only(wakeInputs(requests.seen));
    expect(text).toContain('<wake fired_at="');
    expect(text).toContain('late_by="');
    expect(text).toContain('class="attend"');
    expect(text).toContain(`scheduled_by="${String(session.root.id)}"`);
    expect(text).toContain(FRAGMENT);
    expect(text).toContain(`<intent>${intent}</intent>`);
    expect(text).toContain(`<payload>${JSON.stringify(payload)}</payload>`);
    expect(text).toContain(`<percept>${PERCEPT}</percept>`);
    expect(text.trimEnd().endsWith("</wake>")).toBe(true);

    // One entry, of the wake's own kind, holding what the turn was told.
    const entry = only(await wakeEntries(session.root));
    const data = dataOf(entry);
    expect(data["taskId"]).toBe(taskId);
    expect(data["n"]).toBe(0);
    expect(data["at"]).toBe(at);
    expect(data["firedAt"]).toBe(world.clock.now());
    expect(data["intent"]).toBe(intent);
    expect(data["payload"]).toEqual(payload);
    expect(data["episodeClass"]).toBe("attend");
    expect(data["scheduledBy"]).toBe(session.root.id);

    // The request id is the occurrence's, and the input was answered.
    const submission = await submissionOf(
      session.harness,
      session.root.id,
      wakeRequestId(taskId, 0),
    );
    expect(submission?.requestId).toBe(wakeRequestId(taskId, 0));
    expect(submission?.status).toBe("done");

    // Every satan-mcp call ran on the wake path's own connection, against the clock's budget.
    expectScheduled(world.calls, session.root.id);
    const boot = world.calls.find((call) => call.tool === "satan_boot_context");
    expect(boot?.args).toEqual({ refresh: true });
    expect(boot?.deadlineMs).toBe(SATAN_CALL_DEADLINE_MS);
    expect(world.calls.some((call) => call.tool === "activity_read")).toBe(true);
    // The journal names the wake, its occurrence and its topic (W7).
    expect(world.lines).toEqual([
      `wake ${String(taskId)} n=0 (default) fire`,
      `wake ${String(taskId)} n=0 (default) done`,
    ]);
  });

  it("VT-1 a heartbeat fires, then sleeps one ceiling on with the next occurrence", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const requests = recording(world);
    requests.script();
    const taskId = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at: START, intent: "keep the room", recurring: true }),
    );

    // Never terminal: the same task sleeps towards occurrence 1.
    const sleep = await waitSleeping(session.harness, taskId);
    expect(sleep.until).toBe(START + CEILING);
    expect(sleep.checkpoint["phase"]).toBe("fire");
    expect(sleep.checkpoint["n"]).toBe(1);
    expect(sleep.checkpoint["at"]).toBe(START + CEILING);
    expect(requests.seen).toHaveLength(1);
    expect(await wakeEntries(session.root)).toHaveLength(1);
    expect(dataOf(only(await wakeEntries(session.root)))["n"]).toBe(0);

    // Occurrence 1 is a distinct turn under its own request id, and carries no lateness.
    world.clock.advance(CEILING);
    session.harness.resume();
    await vi.waitFor(async () => {
      expect((await waitSleeping(session.harness, taskId)).checkpoint["n"]).toBe(2);
    }, WAIT);
    expect(requests.seen).toHaveLength(2);
    expect((await wakeEntries(session.root)).map((entry) => dataOf(entry)["n"])).toEqual([0, 1]);
    const submission = await submissionOf(
      session.harness,
      session.root.id,
      wakeRequestId(taskId, 1),
    );
    expect(submission?.status).toBe("done");
    // Each request's newest wake input: the one that started its turn.
    const [first, second] = requests.seen.map((messages) => wakeInputs([messages]).at(-1));
    expect(first).toContain('late_by="0"');
    expect(second).not.toContain("late_by");
  });
});

describe("VT-2 (W1): one occurrence is admitted once, whatever a crash cuts short", () => {
  it("VT-2a a crash after admission wakes nobody twice", async () => {
    const world = wakeWorld();
    let session = await world.open();
    holdFirstTurn(world);
    const taskId = await createWake(session, world.task, wakeInput(session.root.id));
    expect((await waitSleeping(session.harness, taskId)).until).toBe(START + HOUR);

    world.clock.advance(HOUR);
    session.harness.resume();
    // The input is admitted and its turn running: from here the request id dedupes it.
    await waitPlaced(session, taskId);

    // The process dies with the wake's own bookkeeping unfinished.
    await session.harness.close(context);

    // Inside the quiet window nothing may fire, and the occurrence must not be admitted again.
    world.clock.set(local(28, 23, 30));
    session = await world.open();
    // The re-run submit defers back to fire, keeping the occurrence; the admitted turn still runs (W4).
    const quiet = await waitSleeping(session.harness, taskId);
    expect(quiet.checkpoint["prepared"]).toBe(true);
    expect(quiet.checkpoint["n"]).toBe(0);
    expect(world.lines.some((line) => line.includes("defer quiet until"))).toBe(true);
    await waitSettled(session.harness);
    expect(await wakeEntries(session.root)).toHaveLength(1);

    // Past the quiet window and one floor on, the same occurrence finishes.
    world.clock.set(local(29, 7, 6));
    session.harness.resume();
    expect(await firedResult(session.harness, taskId)).toEqual({ fired: true });
    expect(await wakeEntries(session.root)).toHaveLength(1);
    expect(await wakeUserMessages(session.root)).toBe(1);
  });

  it("VT-2b a crash after admission survives a presence defer", async () => {
    const world = wakeWorld();
    let session = await world.open();
    holdFirstTurn(world);
    const taskId = await createWake(session, world.task, wakeInput(session.root.id));
    expect((await waitSleeping(session.harness, taskId)).until).toBe(START + HOUR);

    world.clock.advance(HOUR);
    session.harness.resume();
    await waitPlaced(session, taskId);
    await session.harness.close(context);

    // The room user is away and the dice are cold: after the quiet window, presence defers the fire.
    world.wake.random = (): number => 0.99;
    world.script.presence = IDLE;
    world.clock.set(local(28, 23, 30));
    session = await world.open();
    expect((await waitSleeping(session.harness, taskId)).checkpoint["prepared"]).toBe(true);
    await waitSettled(session.harness);
    world.clock.set(local(29, 7, 6));
    session.harness.resume();
    const deferred = await waitSleeping(session.harness, taskId);
    expect(deferred.checkpoint["phase"]).toBe("fire");
    expect(deferred.checkpoint["n"]).toBe(0);
    expect(deferred.checkpoint["prepared"]).toBe(true);
    expect(world.lines.some((line) => line.includes("defer presence until"))).toBe(true);
    expect(await wakeEntries(session.root)).toHaveLength(1);

    // A present room user lets the same occurrence finish, and it is still one entry.
    world.wake.random = (): number => 0;
    world.script.presence = TYPING;
    world.clock.advance(2 * FLOOR);
    session.harness.resume();
    expect(await firedResult(session.harness, taskId)).toEqual({ fired: true });
    expect(await wakeEntries(session.root)).toHaveLength(1);
    expect(await wakeUserMessages(session.root)).toBe(1);
  });

  it("VT-2c a crash between the submit checkpoint and admission re-runs fire, prepared", async () => {
    const world = wakeWorld();
    let session = await world.open();
    recording(world).script();
    // The submit phase's gate hangs until the close is under way: a crash with nothing admitted.
    const held = heldGate(world.wake.policy);
    world.wake.policy = held.policy;

    const taskId = await createWake(session, world.task, wakeInput(session.root.id, { at: START }));
    await held.secondSeen;
    const shutdown = session.harness.close(context);
    held.release({ kind: "fire" });
    await shutdown;

    // Disabled: the phase defers, and the occurrence keeps both itself and what fire prepared.
    world.setEnabled(false);
    session = await world.open();
    const off = await waitSleeping(session.harness, taskId);
    expect(off.checkpoint["phase"]).toBe("fire");
    expect(off.checkpoint["n"]).toBe(0);
    expect(off.checkpoint["prepared"]).toBe(true);
    expect(
      await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)),
    ).toBeUndefined();
    expect(await wakeEntries(session.root)).toEqual([]);

    // The same in the quiet window.
    await session.harness.close(context);
    world.setEnabled(true);
    world.clock.set(local(28, 23, 30));
    session = await world.open();
    const quiet = await waitSleeping(session.harness, taskId);
    expect(quiet.checkpoint["phase"]).toBe("fire");
    expect(quiet.checkpoint["n"]).toBe(0);
    expect(quiet.checkpoint["prepared"]).toBe(true);
    expect(world.lines.some((line) => line.includes("defer quiet until"))).toBe(true);
    expect(
      await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)),
    ).toBeUndefined();

    // A presence defer keeps the occurrence prepared too.
    await session.harness.close(context);
    world.wake.random = (): number => 0.99;
    world.script.presence = IDLE;
    world.clock.set(local(29, 7, 6));
    session = await world.open();
    const away = await waitSleeping(session.harness, taskId);
    expect(away.checkpoint["phase"]).toBe("fire");
    expect(away.checkpoint["n"]).toBe(0);
    expect(away.checkpoint["prepared"]).toBe(true);
    expect(world.lines.some((line) => line.includes("defer presence until"))).toBe(true);
    expect(
      await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)),
    ).toBeUndefined();

    // Daytime, enabled, room user present: the occurrence fires, exactly once.
    await session.harness.close(context);
    world.wake.random = (): number => 0;
    world.script.presence = TYPING;
    world.clock.advance(2 * FLOOR);
    session = await world.open();
    expect(await firedResult(session.harness, taskId)).toEqual({ fired: true });
    expect(await wakeEntries(session.root)).toHaveLength(1);
    expect(await wakeUserMessages(session.root)).toBe(1);
    expect(world.calls.some((call) => call.tool === "satan_boot_context")).toBe(true);
  });
});

describe("VT-3: the wake's edges", () => {
  it("VT-3a two overdue wakes in two conversations each fire once", async () => {
    const world = wakeWorld();
    let session = await world.open();
    const requests = recording(world);
    requests.script();
    const second = await createConversation(session.harness);
    await second.configure({ model: FAUX_MODEL }, context);
    const at = START + HOUR;
    const first = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at, intent: "the first window" }),
    );
    const other = await createWake(
      session,
      world.task,
      wakeInput(second.id, { at, intent: "the other window" }),
    );
    await waitSleeping(session.harness, first);
    await waitSleeping(session.harness, other);
    await session.harness.close(context);

    // Both are overdue when the process comes back.
    world.clock.advance(2 * HOUR);
    session = await world.open();
    expect(await firedResult(session.harness, first)).toEqual({ fired: true });
    expect(await firedResult(session.harness, other)).toEqual({ fired: true });
    expect(await wakeEntries(session.root)).toHaveLength(1);
    const reopened = await session.harness.conversation(second.id, context);
    if (reopened === undefined) {
      throw new Error("the second conversation is gone");
    }
    expect(await wakeEntries(reopened)).toHaveLength(1);
    expect(wakeInputs(requests.seen)).toHaveLength(2);
  });

  it("VT-3b an unreachable satan-mcp fires with an unknown percept", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const requests = recording(world);
    requests.script();
    world.script.unreachable = true;
    // Cold dice: only an unknown presence fires now.
    world.wake.random = (): number => 0.99;
    const taskId = await createWake(session, world.task, wakeInput(session.root.id, { at: START }));

    expect(await firedResult(session.harness, taskId)).toEqual({ fired: true });
    expectScheduled(world.calls, session.root.id);
    const text = only(wakeInputs(requests.seen));
    expect(text).toContain("percept unavailable");
    expect(text).not.toContain("<payload>");
    expect(text).toContain(FRAGMENT);
    expect(await wakeEntries(session.root)).toHaveLength(1);
  });

  it("VT-3c a missing wake.md fails a one-shot wake and tells SATAN", async () => {
    const world = wakeWorld();
    const session = await world.open();
    recording(world).script();
    world.script.fragmentThrows = true;
    const taskId = await createWake(session, world.task, wakeInput(session.root.id, { at: START }));

    const outcome = await waitTerminal(session.harness, taskId);
    expect(outcome.status).toBe("failed");
    expect(world.lines.some((line) => line.includes("failed: "))).toBe(true);
    const notes = world.calls.filter((call) => call.tool === "notify_send");
    expect(notes).toHaveLength(1);
    expect(only(notes).args["title"]).toBe("SATAN wake failed");
    expect(typeof only(notes).args["body"]).toBe("string");
    expect(await wakeEntries(session.root)).toEqual([]);
  });

  it("VT-3c a missing wake.md leaves the heartbeat alive, one occurrence on", async () => {
    const world = wakeWorld();
    const session = await world.open();
    recording(world).script();
    world.script.fragmentThrows = true;
    const taskId = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at: START, recurring: true }),
    );

    const sleep = await waitSleeping(session.harness, taskId);
    expect(sleep.until).toBe(START + CEILING);
    expect(sleep.checkpoint["phase"]).toBe("fire");
    expect(sleep.checkpoint["n"]).toBe(1);
    expect(world.lines.some((line) => line.includes("failed: "))).toBe(true);
    expect(world.calls.some((call) => call.tool === "notify_send")).toBe(true);
    expect(await wakeEntries(session.root)).toEqual([]);
  });

  it("EX-4 an unanswered input fails a one-shot wake, and the heartbeat moves on", async () => {
    const world = wakeWorld();
    const session = await world.open();
    // A model error pi-durable does not retry: the run fails and its input settles unanswered.
    const failing = (): AssistantMessage =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "spend cap reached" });
    world.faux.setResponses([failing(), failing()]);
    const oneShot = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at: START }),
    );

    const outcome = await waitTerminal(session.harness, oneShot);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("unanswered (model_error)");
    expect(world.lines.some((line) => line.includes("failed: unanswered"))).toBe(true);

    const heartbeat = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at: START, recurring: true }),
    );
    const sleep = await waitSleeping(session.harness, heartbeat);
    expect(sleep.checkpoint["n"]).toBe(1);
    expect(sleep.until).toBe(START + CEILING);
    expect(world.calls.filter((call) => call.tool === "notify_send")).toHaveLength(2);
  });

  it("EX-4 a failure report survives satan-mcp being down too", async () => {
    const world = wakeWorld();
    const session = await world.open();
    recording(world).script();
    world.script.unreachable = true;
    world.script.fragmentThrows = true;
    const oneShot = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at: START }),
    );
    const heartbeat = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at: START, recurring: true }),
    );

    expect((await waitTerminal(session.harness, oneShot)).status).toBe("failed");
    const sleep = await waitSleeping(session.harness, heartbeat);
    expect(sleep.checkpoint["n"]).toBe(1);
    expect(sleep.until).toBe(START + CEILING);
    expect(world.calls.filter((call) => call.tool === "notify_send")).toHaveLength(2);
    expect(world.lines).toContain(
      `wake ${String(oneShot)} n=0 (default) failed: wake.md is missing`,
    );
  });
});
