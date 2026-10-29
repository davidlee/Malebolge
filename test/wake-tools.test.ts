// The three tools SATAN schedules wakes with (SL-034 design sec-13, PHASE-06):
// wake_schedule, wake_cancel and wake_list. Every tool answers JSON text, so a
// test parses the tool result's output. The world, clock, harness and scripted
// satan-mcp answers are the wake fixture's.

import type { Context } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type ConversationId,
  type ConversationInit,
  defineExtension,
  defineTask,
  type Extension,
  type Harness,
  type HarnessInspection,
  type JsonObject,
  type SubmissionId,
  type TaskId,
  type TaskInspection,
} from "@earendil-works/pi-durable";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { describe, expect, it, vi } from "vitest";
import { topicInit } from "../src/conversations.ts";
import { context } from "../src/context.ts";
import { isRecord, type JsonRecord } from "../src/json.ts";
import { DEFAULT_TOPIC } from "../src/protocol.ts";
import { writeTopicRecord } from "../src/topics.ts";
import type { WakeDeps } from "../src/wake/extension.ts";
import { wakeRequestId } from "../src/wake/task.ts";
import { wakeCancel, wakeList, wakeSchedule } from "../src/wake/tools.ts";
import {
  callThenAnswer,
  FAUX_CATALOG,
  FAUX_MODEL,
  indexOf,
  startThread,
  textOf,
  toolResults,
} from "./harness-fixture.ts";
import {
  HOUR,
  START,
  WAIT,
  type Sleeping,
  type WakeSession,
  type WakeWorld,
  createWake,
  submissionOf,
  waitPlaced,
  waitSleeping,
  waitTerminal,
  wakeInput,
  wakeUserMessages,
  wakeWorld,
} from "./wake-fixture.ts";

/** One tool call's answer: the harness's error flag, and the JSON its output text held. */
interface ToolResult {
  readonly isError: boolean;
  readonly json: JsonRecord;
  readonly text: string;
}

/** An error result's text is a message, not JSON: it parses as the empty object. */
const parseToolText = (text: string): JsonRecord => {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
};

/**
 * One model turn of `conversation` calling `tool` with `args`: that call's result.
 * `during` answers model requests made while the tool runs (another turn the call causes).
 */
const callTool = async (
  world: WakeWorld,
  session: WakeSession,
  conversation: Conversation,
  tool: string,
  args: JsonObject,
  during: readonly FauxResponseStep[] = [],
): Promise<ToolResult> => {
  const [call, answer] = callThenAnswer(tool, args, "done");
  world.faux.setResponses([call, ...during, answer]);
  const settled = await (await conversation.submit({ type: "input", content: "go" }, context)).wait(
    context,
  );
  expect(settled.status).toBe("done");
  const message = (await toolResults(session.harness, conversation)).at(-1);
  if (message === undefined) {
    throw new Error("the turn made no tool call");
  }
  const text = textOf(message);
  return { isError: message.isError, json: parseToolText(text), text };
};

/** A conversation of the session that runs the faux model, as the root does. */
const talking = (session: WakeSession, init?: ConversationInit): Promise<Conversation> =>
  session.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: FAUX_MODEL },
      ...(init === undefined ? {} : { init }),
    },
    context,
  );

/** `value` as a JSON object. */
const objectOf = (value: unknown, what: string): JsonRecord => {
  if (!isRecord(value)) {
    throw new Error(`${what} is not an object: ${JSON.stringify(value)}`);
  }
  return value;
};

const numberOf = (json: JsonRecord, key: string): number => {
  const value = json[key];
  if (typeof value !== "number") {
    throw new Error(`${key} is not a number: ${JSON.stringify(value)}`);
  }
  return value;
};

const stringOf = (json: JsonRecord, key: string): string => {
  const value = json[key];
  if (typeof value !== "string") {
    throw new Error(`${key} is not a string: ${JSON.stringify(value)}`);
  }
  return value;
};

const booleanOf = (json: JsonRecord, key: string): boolean => {
  const value = json[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} is not a boolean: ${JSON.stringify(value)}`);
  }
  return value;
};

/** A field that a listing prints as `null` when the target is no topic's. */
const maybeStringOf = (json: JsonRecord, key: string): string | null => {
  const value = json[key];
  return typeof value === "string" ? value : null;
};

const recordsOf = (json: JsonRecord, key: string): JsonRecord[] => {
  const value = json[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} is not an array: ${JSON.stringify(value)}`);
  }
  return value.filter(isRecord);
};

const twoDigits = (value: number): string => String(value).padStart(2, "0");

/**
 * `text` is the local ISO-8601 spelling of `ms`: a numeric offset (`Z` only where
 * the zone is UTC), the same wall clock, and an instant `Date.parse` recovers.
 */
const expectLocalInstant = (text: string, ms: number): void => {
  const at = new Date(ms);
  const wall = `${String(at.getFullYear())}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}T${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
  expect(text).toMatch(/(?:[+-]\d{2}:\d{2}|Z)$/);
  expect(text.startsWith(wall)).toBe(true);
  expect(Date.parse(text)).toBe(ms);
  if (text.endsWith("Z")) {
    expect(at.getTimezoneOffset()).toBe(0);
  }
};

/** The fire time the policy decides for `requested` at `now`, over the world's own dice. */
const decided = (world: WakeWorld, now: number, requested: number | undefined): number =>
  world.wake.policy.schedule(requested, {
    now: () => now,
    random: () => world.wake.random(),
    presence: () => Promise.reject(new Error("scheduling never probes presence")),
  });

/** The live inspection of task `id`, whatever its state. */
const taskById = async (harness: Harness, id: number): Promise<TaskInspection> => {
  const { tasks } = await harness.inspect(context);
  const seen = tasks.find((task) => task.record.id === id);
  if (seen === undefined) {
    throw new Error(`task ${String(id)} is not live`);
  }
  return seen;
};

/** The sleep of the wake the tool named as a number. */
const asleepById = async (harness: Harness, id: number): Promise<Sleeping> =>
  waitSleeping(harness, (await taskById(harness, id)).record.id);

/** A model turn that holds until the test releases it, then answers once. */
interface GatedTurn {
  readonly step: FauxResponseStep;
  /** Resolves when the turn has started and the model is waiting on the test. */
  readonly reached: Promise<undefined>;
  readonly release: () => void;
}

const gatedTurn = (): GatedTurn => {
  const gate = Promise.withResolvers<undefined>();
  const reached = Promise.withResolvers<undefined>();
  const step: FauxResponseStep = async () => {
    reached.resolve(undefined);
    await gate.promise;
    return fauxAssistantMessage([fauxText("ok")]);
  };
  return {
    step,
    reached: reached.promise,
    release: (): void => {
      gate.resolve(undefined);
    },
  };
};

/** Runs `body`, releasing the held turn however it ends: an unreleased turn hangs the close. */
const holding = async (turn: GatedTurn, body: () => Promise<void>): Promise<void> => {
  try {
    await body();
  } finally {
    turn.release();
  }
};

/**
 * The tools' harness with the cancel's read made stale: the first `inspect`
 * takes its snapshot, then fires the timer and runs `meanwhile` before handing
 * that snapshot back — the timer winning while the cancel holds its read.
 * `marked`, when given, runs once the cancel's abort mark is committed.
 */
const staleRead = (
  world: WakeWorld,
  session: WakeSession,
  meanwhile: () => Promise<unknown>,
  marked?: () => void,
): void => {
  const real = world.wake.harness;
  let stale = true;
  const harness: WakeDeps["harness"] = {
    inspect: async (ctx: Context): Promise<HarnessInspection> => {
      const seen = await real.inspect(ctx);
      if (stale) {
        stale = false;
        world.advance(HOUR);
        await meanwhile();
      }
      return seen;
    },
    abortTask: async (taskId: TaskId, ctx: Context): Promise<"marked" | "terminal"> => {
      const marking = real.abortTask(taskId, ctx);
      if (marked !== undefined) {
        await vi.waitFor(async () => {
          expect((await session.harness.getTask(taskId, context))?.abortRequested).toBe(true);
        }, WAIT);
        marked();
      }
      return marking;
    },
    abortSubmission: (
      submissionId: SubmissionId,
      ctx: Context,
      conversationId?: ConversationId,
    ): Promise<"aborted" | "already_placed" | "settled" | "not_found"> =>
      real.abortSubmission(submissionId, ctx, conversationId),
  };
  world.wake.harness = harness;
};

/** A stale read (staleRead) that hands back its snapshot once the wake's input is `status`. */
const staleWhileFiring = (
  world: WakeWorld,
  session: WakeSession,
  id: TaskId,
  status: "queued" | "placed",
): void => {
  staleRead(world, session, () =>
    vi.waitFor(async () => {
      const record = await submissionOf(session.harness, session.root.id, wakeRequestId(id, 0));
      expect(record?.status).toBe(status);
    }, WAIT),
  );
};

/** A real turn of the event loop: a phase commits on microtasks and short timers. */
const aTurn = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, WAIT.interval);
  });

/** A task that is not a wake, sleeping far ahead: live when a cancel reads it. */
const sleeper = defineTask({
  name: "test.sleeper",
  version: 1,
  initial: (input: { readonly until: number }) => ({
    phase: "sleep" as const,
    until: input.until,
  }),
  phases: {
    sleep: (task, runtime, ctx) =>
      runtime.sleepUntil(task.state.checkpoint.until, task.state.checkpoint, ctx),
  },
  abort: () => Promise.resolve(),
});

describe("wake tools (SL-034 sec-13)", () => {
  it("VT-1a wake_schedule stores the policy's decided time and a sleeping wake", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const result = await callTool(world, session, session.root, "wake_schedule", {
      intent: "look at the window",
      episode_class: "attend",
      after_minutes: 60,
    });
    expect(result.isError).toBe(false);
    const id = numberOf(result.json, "id");
    expect(numberOf(result.json, "conversation")).toBe(session.root.id);
    expect(booleanOf(result.json, "enabled")).toBe(true);
    const expected = decided(world, START, START + HOUR);
    expectLocalInstant(stringOf(result.json, "at"), expected);
    const sleeping = await asleepById(session.harness, id);
    expect(sleeping.until).toBe(expected);
    const { record } = await taskById(session.harness, id);
    expect(record.kind).toBe("satan.wake");
    const input = objectOf(record.input, "the wake's input");
    expect(numberOf(input, "conversationId")).toBe(session.root.id);
    expect(numberOf(input, "scheduledBy")).toBe(session.root.id);
    expect(numberOf(input, "requestedAt")).toBe(START + HOUR);
    expect(numberOf(input, "at")).toBe(expected);
    expect(stringOf(input, "intent")).toBe("look at the window");
    expect(stringOf(input, "episodeClass")).toBe("attend");

    // Without after_minutes the policy decides, and nothing asked-for is stored.
    const later = await callTool(world, session, session.root, "wake_schedule", {
      intent: "later",
      episode_class: "seclude",
      payload: { note: "kept for the wake turn" },
    });
    expect(later.isError).toBe(false);
    const laterId = numberOf(later.json, "id");
    expectLocalInstant(stringOf(later.json, "at"), decided(world, START, undefined));
    await asleepById(session.harness, laterId);
    const laterInput = objectOf(
      (await taskById(session.harness, laterId)).record.input,
      "the wake's input",
    );
    expect(laterInput["requestedAt"]).toBeUndefined();
    expect(laterInput["payload"]).toEqual({ note: "kept for the wake turn" });
    expect(laterInput["episodeClass"]).toBe("seclude");
  });

  it("VT-1b a topic target is its latest conversation when scheduled (W8)", async () => {
    const world = wakeWorld();
    const session = await world.open();
    await writeTopicRecord(session.harness, "work", {});
    const earlier = await talking(session, topicInit("room", "work", FAUX_CATALOG, FAUX_MODEL));
    const later = await talking(session, topicInit("room", "work", FAUX_CATALOG, FAUX_MODEL));
    expect(later.id).toBeGreaterThan(earlier.id);
    const result = await callTool(world, session, session.root, "wake_schedule", {
      intent: "the work topic",
      episode_class: "attend",
      topic: "work",
      after_minutes: 30,
    });
    expect(result.isError).toBe(false);
    expect(numberOf(result.json, "conversation")).toBe(later.id);
    const id = numberOf(result.json, "id");
    await asleepById(session.harness, id);
    const newer = await talking(session, topicInit("room", "work", FAUX_CATALOG, FAUX_MODEL));
    expect(newer.id).toBeGreaterThan(later.id);
    const input = objectOf((await taskById(session.harness, id)).record.input, "the wake's input");
    expect(numberOf(input, "conversationId")).toBe(later.id);
  });

  // PHASE-02: a topic target is the operator's conversation, never a thread (DEC-037).
  it("wake_schedule {topic} lands on the operator-created conversation", async () => {
    const world = wakeWorld();
    const session = await world.open();
    await writeTopicRecord(session.harness, "work", {});
    const operator = await talking(session, topicInit("room", "work", FAUX_CATALOG, FAUX_MODEL));
    const thread = await startThread(session.harness, operator, "work", "room");
    expect(thread.id).toBeGreaterThan(operator.id);
    const result = await callTool(world, session, session.root, "wake_schedule", {
      intent: "the work topic",
      episode_class: "attend",
      topic: "work",
      after_minutes: 30,
    });
    expect(result.isError).toBe(false);
    expect(numberOf(result.json, "conversation")).toBe(operator.id);
  });

  it("VT-1c an unknown topic is refused, and writes no topic and no wake", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const before = await indexOf(session.harness);
    const result = await callTool(world, session, session.root, "wake_schedule", {
      intent: "nowhere",
      episode_class: "attend",
      topic: "nowhere",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("unknown topic: nowhere");
    const { tasks } = await session.harness.inspect(context);
    expect(tasks.filter((task) => task.record.kind === "satan.wake")).toEqual([]);
    expect((await indexOf(session.harness)).topics).toEqual(before.topics);
    // Written but empty: known, yet nothing to wake in.
    await writeTopicRecord(session.harness, "empty", {});
    const empty = await callTool(world, session, session.root, "wake_schedule", {
      intent: "nobody here",
      episode_class: "attend",
      topic: "empty",
    });
    expect(empty.isError).toBe(true);
    expect(empty.text).toBe("topic empty has no conversation");
    const after = await session.harness.inspect(context);
    expect(after.tasks.filter((task) => task.record.kind === "satan.wake")).toEqual([]);
  });

  it("VT-1b default is always a topic: its latest conversation is the target", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const asker = await talking(session, topicInit("room", "work", FAUX_CATALOG, FAUX_MODEL));
    const result = await callTool(world, session, asker, "wake_schedule", {
      intent: "the default topic",
      episode_class: "seclude",
      topic: DEFAULT_TOPIC,
    });
    expect(result.isError).toBe(false);
    expect(numberOf(result.json, "conversation")).toBe(session.root.id);
  });

  it("VT-1d with wakes off the wake is created, sleeping, and enabled is false", async () => {
    const world = wakeWorld();
    world.setEnabled(false);
    const session = await world.open();
    const result = await callTool(world, session, session.root, "wake_schedule", {
      intent: "off",
      episode_class: "attend",
      after_minutes: 45,
    });
    expect(result.isError).toBe(false);
    expect(booleanOf(result.json, "enabled")).toBe(false);
    const id = numberOf(result.json, "id");
    const expected = decided(world, START, START + 45 * 60_000);
    const sleeping = await asleepById(session.harness, id);
    expect(sleeping.until).toBe(expected);
    expectLocalInstant(stringOf(result.json, "at"), expected);
  });

  it("VT-2a a sleeping wake is cancelled, and no turn ever runs", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const id = await createWake(session, world.task, wakeInput(session.root.id));
    await waitSleeping(session.harness, id);
    const result = await callTool(world, session, session.root, "wake_cancel", { id });
    expect(result.isError).toBe(false);
    expect(numberOf(result.json, "id")).toBe(id);
    expect(booleanOf(result.json, "cancelled")).toBe(true);
    expect(await waitTerminal(session.harness, id)).toEqual({
      status: "aborted",
      result: { fired: false },
    });
    await vi.waitFor(() => {
      expect(world.lines).toContain(`wake ${String(id)} cancelled`);
    }, WAIT);
    // Past the wake's time nothing wakes: the task is terminal, no input was admitted.
    world.advance(HOUR);
    await aTurn();
    expect(await wakeUserMessages(session.root)).toBe(0);
    expect(
      await submissionOf(session.harness, session.root.id, wakeRequestId(id, 0)),
    ).toBeUndefined();
  });

  it("VT-2b a wake whose turn is placed is already fired, and is left alone", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const other = await talking(session);
    const id = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at: START, intent: "now" }),
    );
    const turn = gatedTurn();
    world.faux.setResponses([turn.step]);
    await waitPlaced(session, id);
    await turn.reached;
    await holding(turn, async () => {
      const result = await callTool(world, session, other, "wake_cancel", { id });
      expect(result.isError).toBe(false);
      expect(numberOf(result.json, "id")).toBe(id);
      expect(booleanOf(result.json, "cancelled")).toBe(false);
      expect(stringOf(result.json, "reason")).toBe("already fired");
      // Not abort-marked: the turn it waits for still completes the occurrence.
      expect((await session.harness.getTask(id, context))?.state.status).toBe("running");
      await vi.waitFor(() => {
        expect(world.lines).toContain(`wake ${String(id)} cancel: already fired`);
      }, WAIT);
    });
    expect(await waitTerminal(session.harness, id)).toEqual({
      status: "completed",
      result: { fired: true },
    });
  });

  it("VT-2c abort first: a cancel that lands mid-fire leaves no submission", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const id = await createWake(session, world.task, wakeInput(session.root.id));
    await waitSleeping(session.harness, id);
    // The fire phase holds in its presence probe until the abort mark is committed.
    const probing = Promise.withResolvers<undefined>();
    const probe = Promise.withResolvers<undefined>();
    const satan = world.wake.satan;
    world.wake.satan = {
      refresh: (): Promise<void> => satan.refresh(),
      call: async (key, tool, args, deadlineMs): Promise<CallToolResult> => {
        if (tool === "activity_read") {
          probing.resolve(undefined);
          await probe.promise;
        }
        return satan.call(key, tool, args, deadlineMs);
      },
    };
    // The cancel reads the wake sleeping; its timer fires while the cancel holds that read.
    staleRead(
      world,
      session,
      () => probing.promise,
      () => {
        probe.resolve(undefined);
      },
    );
    try {
      const other = await talking(session);
      const result = await callTool(world, session, other, "wake_cancel", { id });
      expect(result.isError).toBe(false);
      expect(booleanOf(result.json, "cancelled")).toBe(true);
    } finally {
      probe.resolve(undefined);
    }
    expect(await waitTerminal(session.harness, id)).toEqual({
      status: "aborted",
      result: { fired: false },
    });
    expect(
      await submissionOf(session.harness, session.root.id, wakeRequestId(id, 0)),
    ).toBeUndefined();
    expect(await wakeUserMessages(session.root)).toBe(0);
  });

  it("VT-2d a cancel that lands while the input queues still withdraws it", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const other = await talking(session);
    const id = await createWake(session, world.task, wakeInput(session.root.id));
    await waitSleeping(session.harness, id);
    const turn = gatedTurn();
    world.faux.setResponses([turn.step]);
    const busy = (await session.root.submit({ type: "input", content: "busy" }, context)).wait(
      context,
    );
    await turn.reached;
    // The cancel reads the wake sleeping; the timer fires while it holds that read.
    staleWhileFiring(world, session, id, "queued");
    await holding(turn, async () => {
      const result = await callTool(world, session, other, "wake_cancel", { id });
      expect(result.isError).toBe(false);
      expect(booleanOf(result.json, "cancelled")).toBe(true);
      const withdrawn = await submissionOf(session.harness, session.root.id, wakeRequestId(id, 0));
      expect(withdrawn?.status).toBe("unanswered");
    });
    expect((await busy).status).toBe("done");
    await vi.waitFor(() => {
      expect(world.lines).toContain(`wake ${String(id)} cancelled`);
    }, WAIT);
    expect(await wakeUserMessages(session.root)).toBe(0);
  });

  it("VT-2h timer first with the turn placed: already fired, and the turn completes", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const other = await talking(session);
    const id = await createWake(session, world.task, wakeInput(session.root.id));
    await waitSleeping(session.harness, id);
    const turn = gatedTurn();
    // The cancel reads the wake sleeping; the timer fires and its turn starts meanwhile.
    staleWhileFiring(world, session, id, "placed");
    await holding(turn, async () => {
      const cancelling = callTool(world, session, other, "wake_cancel", { id }, [turn.step]);
      await turn.reached;
      // The cancel answers while the wake's turn still runs: its abort ends the wake's wait, not the turn.
      const result = await cancelling;
      expect(result.isError).toBe(false);
      expect(booleanOf(result.json, "cancelled")).toBe(false);
      expect(stringOf(result.json, "reason")).toBe("already fired");
    });
    expect(await waitTerminal(session.harness, id)).toEqual({
      status: "aborted",
      result: { fired: true },
    });
    await vi.waitFor(() => {
      expect(world.lines).toContain(`wake ${String(id)} cancel: already fired`);
    }, WAIT);
    expect(await wakeUserMessages(session.root)).toBe(1);
  });

  it("VT-2e the heartbeat cannot be cancelled, and stays sleeping", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const id = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { recurring: true }),
    );
    await waitSleeping(session.harness, id);
    const result = await callTool(world, session, session.root, "wake_cancel", { id });
    expect(result.isError).toBe(true);
    const sleeping = await waitSleeping(session.harness, id);
    expect(sleeping.until).toBe(START + HOUR);
  });

  it("VT-2f an unknown id is refused", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const result = await callTool(world, session, session.root, "wake_cancel", { id: 99_999 });
    expect(result.isError).toBe(true);
  });

  it("VT-2g a live task that is not a wake is refused", async () => {
    const world = wakeWorld();
    const extension: Extension = defineExtension({
      name: "tasks",
      tasks: [world.task, sleeper],
      tools: [
        wakeSchedule(() => world.wake, world.task),
        wakeCancel(() => world.wake),
        wakeList(() => world.wake),
      ],
    });
    const session = await world.open(extension);
    const id = await session.harness.commit(
      (tx) =>
        tx.createTask(
          sleeper,
          { until: START + 10 * HOUR },
          {
            ownership: { kind: "conversation" },
            conversationId: session.root.id,
            background: true,
          },
        ),
      context,
    );
    session.harness.resume();
    await waitSleeping(session.harness, id);
    const result = await callTool(world, session, session.root, "wake_cancel", { id });
    expect(result.isError).toBe(true);
    const sleeping = await waitSleeping(session.harness, id);
    expect(sleeping.until).toBe(START + 10 * HOUR);
    expect((await session.harness.getTask(id, context))?.abortRequested).toBe(false);
  });

  it("VT-3 wake_list names each sleeping wake's topic, target and class", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const work = await talking(session, topicInit("room", "work", FAUX_CATALOG, FAUX_MODEL));
    const asker = await talking(session);
    const heart = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { recurring: true, intent: "heartbeat" }),
    );
    const rootWake = await callTool(world, session, session.root, "wake_schedule", {
      intent: "root wake",
      episode_class: "attend",
      after_minutes: 60,
    });
    const workWake = await callTool(world, session, work, "wake_schedule", {
      intent: "work wake",
      episode_class: "seclude",
      after_minutes: 90,
    });
    const rootId = numberOf(rootWake.json, "id");
    const workId = numberOf(workWake.json, "id");
    // Fired and waiting for its turn: not a sleeping wake, so not listed.
    const held = await createWake(
      session,
      world.task,
      wakeInput(work.id, { at: START, intent: "held" }),
    );
    const turn = gatedTurn();
    world.faux.setResponses([turn.step]);
    await waitPlaced(session, held);
    await turn.reached;
    await holding(turn, async () => {
      const listed = await callTool(world, session, asker, "wake_list", {});
      expect(listed.isError).toBe(false);
      expect(booleanOf(listed.json, "enabled")).toBe(true);
      const wakes = recordsOf(listed.json, "wakes");
      const ids = wakes.map((wake) => numberOf(wake, "id"));
      expect(ids.sort((a, b) => a - b)).toEqual([rootId, workId, heart].sort((a, b) => a - b));
      const entry = (id: number): JsonRecord => {
        const found = wakes.find((wake) => numberOf(wake, "id") === id);
        if (found === undefined) {
          throw new Error(`wake ${String(id)} is not listed`);
        }
        return found;
      };
      const forRoot = entry(rootId);
      expectLocalInstant(
        stringOf(forRoot, "at"),
        (await asleepById(session.harness, rootId)).until,
      );
      expect(numberOf(forRoot, "conversation")).toBe(session.root.id);
      expect(maybeStringOf(forRoot, "topic")).toBe(DEFAULT_TOPIC);
      expect(stringOf(forRoot, "intent")).toBe("root wake");
      expect(stringOf(forRoot, "episode_class")).toBe("attend");
      expect(forRoot["recurring"]).toBeUndefined();
      const forWork = entry(workId);
      expectLocalInstant(
        stringOf(forWork, "at"),
        (await asleepById(session.harness, workId)).until,
      );
      expect(numberOf(forWork, "conversation")).toBe(work.id);
      expect(maybeStringOf(forWork, "topic")).toBe("work");
      expect(stringOf(forWork, "intent")).toBe("work wake");
      expect(stringOf(forWork, "episode_class")).toBe("seclude");
      expect(forWork["recurring"]).toBeUndefined();
      const forHeart = entry(heart);
      expect(numberOf(forHeart, "conversation")).toBe(session.root.id);
      expect(maybeStringOf(forHeart, "topic")).toBe(DEFAULT_TOPIC);
      expect(stringOf(forHeart, "intent")).toBe("heartbeat");
      expect(forHeart["recurring"]).toBe(true);
    });
    expect(await waitTerminal(session.harness, held)).toEqual({
      status: "completed",
      result: { fired: true },
    });
    world.setEnabled(false);
    const off = await callTool(world, session, asker, "wake_list", {});
    expect(booleanOf(off.json, "enabled")).toBe(false);
  });
});
