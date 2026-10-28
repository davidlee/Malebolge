// VT-1 and VT-2 of the heartbeat and the start sweep (SL-034 PHASE-07; design
// § Heartbeat): exactly one viable recurring satan.wake after every daemon start,
// and a live wake that cannot run here journalled, its queued inputs withdrawn,
// and aborted last. The world, clock and harness timers are the wake fixture's.

import {
  type Conversation,
  defineExtension,
  type Harness,
  type HarnessInspection,
  type JsonObject,
  type SubmissionId,
  type SubmissionRecord,
  type TaskId,
  type TaskInspection,
} from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { context } from "../src/context.ts";
import { sweepBlockedTasks } from "../src/task-sweep.ts";
import type { IndexReader } from "../src/topics.ts";
import { type WakeDeps, wakeBinding } from "../src/wake/extension.ts";
import { ensureHeartbeat, HEARTBEAT_INTENT } from "../src/wake/heartbeat.ts";
import { wakeSweptKind } from "../src/wake/sweep.ts";
import {
  type LiveWake,
  liveWakes,
  WAKE_KIND,
  type WakeInput,
  type WakeResult,
  wakeRequestId,
} from "../src/wake/task.ts";
import {
  CEILING,
  createWake,
  firedResult,
  HOUR,
  heldTurn,
  heldUntilCutOff,
  inspection,
  notifyCalls,
  only,
  recordedTurn,
  recording,
  type Sleeping,
  START,
  submissionOf,
  WAIT,
  type WakeSession,
  type WakeWorld,
  waitPlaced,
  waitQueued,
  waitSleeping,
  waitTerminal,
  wakeInput,
  wakeInputs,
  wakeUserMessages,
  wakeWorld,
} from "./wake-fixture.ts";

const TOPIC = "room";

/** The request id of the plain input submitted behind the wake: it must survive a sweep. */
const SECOND = "manual:second";

type Heartbeat = TaskId<WakeResult>;

/** The heartbeat's task, or a failure: the call under test created none. */
function created(id: Heartbeat | undefined): Heartbeat {
  if (id === undefined) {
    throw new Error("no heartbeat was created");
  }
  return id;
}

/** The task definition at a lower version than the world's: a registry that cannot run what it stored. */
function tooOld(world: WakeWorld): WakeWorld["task"] {
  return { definition: { ...world.task.definition, version: 0 } };
}

/** The room's topic and its latest conversation (made if the topic has none yet). */
async function topicConversation(world: WakeWorld): Promise<Conversation> {
  await world.wake.conversations.setTopic({ name: TOPIC });
  return world.wake.conversations.open({
    kind: "topic",
    name: TOPIC,
    new: false,
  });
}

/** A heartbeat made the way ensure makes it, so that a test's setup does not run the code under test. */
function createHeartbeat(
  world: WakeWorld,
  session: WakeSession,
  conversation: Conversation,
): Promise<Heartbeat> {
  return createWake(
    session,
    world.task,
    wakeInput(conversation.id, { at: world.clock.now() + CEILING, recurring: true }),
  );
}

/** The daemon start's sweep, with wake as its one row. */
const sweepWakes = (wake: WakeDeps, read: IndexReader): Promise<void> =>
  sweepBlockedTasks(wake.harness, [wakeSweptKind(wake, read)], wake.log, context);

/** The daemon start's two calls, after `resume()`: sweep, then ensure the heartbeat. */
async function sweepAndEnsure(
  world: WakeWorld,
  session: WakeSession,
  task = world.task,
): Promise<Heartbeat | undefined> {
  await sweepWakes(world.wake, session.harness);
  return ensureHeartbeat(world.wake, task, context);
}

/** A session started the daemon's way: opened, swept, the heartbeat ensured. */
async function start(
  world: WakeWorld,
  extension?: Parameters<WakeWorld["open"]>[0],
  task = world.task,
): Promise<{ session: WakeSession; heartbeat: Heartbeat | undefined }> {
  const session = await world.open(extension);
  return { session, heartbeat: await sweepAndEnsure(world, session, task) };
}

/** Moves the clock and lets the sleepers there due run. */
function pass(world: WakeWorld, session: WakeSession, ms: number): void {
  world.advance(ms);
  session.harness.resume();
}

/** The live wakes that can run: recurring, not abort-marked, not blocked. */
async function viableHeartbeats(harness: Harness): Promise<LiveWake[]> {
  return (await liveWakes(harness, context)).filter(
    (wake) => wake.input.recurring === true && !wake.blocked && !wake.abortRequested,
  );
}

/** The task's sleep once its checkpoint holds occurrence `n`, polled: a sleep commits asynchronously. */
function sleepingAt(harness: Harness, id: TaskId, n: number, until?: number): Promise<Sleeping> {
  return vi.waitFor(async () => {
    const sleep = await waitSleeping(harness, id);
    expect(sleep.checkpoint["n"]).toBe(n);
    if (until !== undefined) {
      expect(sleep.until).toBe(until);
    }
    return sleep;
  }, WAIT);
}

/** `harness` as the sweep sees it, recording what pi-durable answered each withdrawal. */
interface RecordingHarness {
  readonly deps: WakeDeps["harness"];
  readonly answers: string[];
  readonly aborted: TaskId[];
}

/** `abortTask` rejects once when `crashOnAbort` is set: a process that dies after withdrawing. */
function recordingHarness(harness: Harness, crashOnAbort = false): RecordingHarness {
  const answers: string[] = [];
  const aborted: TaskId[] = [];
  let crash = crashOnAbort;
  return {
    answers,
    aborted,
    deps: {
      inspect: (ctx) => harness.inspect(ctx),
      abortTask: (id, ctx): ReturnType<Harness["abortTask"]> => {
        aborted.push(id);
        if (crash) {
          crash = false;
          return Promise.reject(new Error("the process died"));
        }
        return harness.abortTask(id, ctx);
      },
      abortSubmission: async (
        id: SubmissionId,
        ctx,
        conversationId,
      ): ReturnType<Harness["abortSubmission"]> => {
        const answer = await harness.abortSubmission(id, ctx, conversationId);
        answers.push(answer);
        return answer;
      },
    },
  };
}

/** Any JSON value (pi-durable exports only its object form): what an untyped record's id carries. */
type JsonValue = JsonObject[string];

/** pi-durable's branded task id for `n`, through a guard: no case here needs a cast. */
const isTaskId = (n: number): n is TaskId<JsonValue> => Number.isSafeInteger(n) && n > 0;

/** `n` as a task id, or a failure: pi-durable's ids are opaque numbers to a test. */
function taskIdOf(n: number): TaskId<JsonValue> {
  if (!isTaskId(n)) {
    throw new Error(`test id ${String(n)} is no task id`);
  }
  return n;
}

/** pi-durable's branded submission id for `n`, through a guard, as above. */
const isSubmissionId = (n: number): n is SubmissionId => Number.isSafeInteger(n) && n > 0;

/** `n` as a submission id, or a failure. */
function submissionIdOf(n: number): SubmissionId {
  if (!isSubmissionId(n)) {
    throw new Error(`test id ${String(n)} is no submission id`);
  }
  return n;
}

/** A wake's input as pi-durable hands it back to an inspector: plain JSON, not a test type. */
const storedInput = (input: WakeInput): JsonObject => ({
  conversationId: input.conversationId,
  intent: input.intent,
  episodeClass: input.episodeClass,
  at: input.at,
  scheduledBy: input.scheduledBy,
  ...(input.recurring === undefined ? {} : { recurring: input.recurring }),
});

/** A promise a test opens: what waits on it resumes only once the test has seen what it needed. */
interface Gate {
  readonly open: () => void;
  readonly wait: Promise<unknown>;
}

function gate(): Gate {
  const opened = Promise.withResolvers<undefined>();
  return {
    open: (): void => {
      opened.resolve(undefined);
    },
    wait: opened.promise,
  };
}

/**
 * `harness`, with every withdrawal after the sweep's own first one held until `gate`
 * opens: the abort handler's withdrawal, so an abort-marked task stays live while
 * `ensureHeartbeat` decides.
 */
function withdrawalHeld(harness: Harness, held: Gate): WakeDeps["harness"] {
  let withdrawals = 0;
  return {
    inspect: (ctx) => harness.inspect(ctx),
    abortTask: (id, ctx) => harness.abortTask(id, ctx),
    abortSubmission: async (
      id: SubmissionId,
      ctx,
      conversationId,
    ): ReturnType<Harness["abortSubmission"]> => {
      withdrawals += 1;
      const answer = await harness.abortSubmission(id, ctx, conversationId);
      if (withdrawals > 1) {
        await held.wait;
      }
      return answer;
    },
  };
}

/** A wake stuck behind a held foreground run in the room topic's conversation. */
interface Stuck {
  readonly world: WakeWorld;
  readonly session: WakeSession;
  readonly conversation: Conversation;
  readonly taskId: Heartbeat;
}

/**
 * How many held turns the recipe scripts: the first foreground turn, then one per
 * reopen, whose cut-off turn the reopened session re-runs and holds again.
 */
const HELD_TURNS = 12;

/**
 * The held-run recipe: a foreground turn that no answer ends, so the wake's input stays
 * queued behind it (and a plain "second" input behind that). A heartbeat is ensured and
 * fired; a one-shot is scheduled for now. The turn is held until its run is signalled —
 * a close or a crash — so no close waits on it, and a reopen re-runs it held again.
 */
async function behindHeldRun(kind: "heartbeat" | "one-shot"): Promise<Stuck> {
  const world = wakeWorld();
  const session = await world.open();
  const conversation = await topicConversation(world);
  world.faux.setResponses(Array.from({ length: HELD_TURNS }, () => heldUntilCutOff));
  const foreground = await conversation.submit({ type: "input", content: "foreground" }, context);
  // Placed: the conversation holds a run, which every input below must queue behind.
  await vi.waitFor(async () => {
    expect((await foreground.status(context)).status).toBe("placed");
  }, WAIT);

  let taskId: Heartbeat;
  if (kind === "heartbeat") {
    taskId = await createHeartbeat(world, session, conversation);
    pass(world, session, CEILING);
  } else {
    taskId = await createWake(session, world.task, wakeInput(conversation.id, { at: START }));
  }
  await waitQueued(session, taskId, conversation.id);
  await conversation.submit(
    {
      type: "input",
      content: "second",
      whenBusy: "followUp",
      requestId: SECOND,
    },
    context,
  );

  // The wake's input is still behind the held run: nothing places it and nothing withdrew it.
  expect(
    (await submissionOf(session.harness, conversation.id, wakeRequestId(taskId, 0)))?.status,
  ).toBe("queued");
  return { world, session, conversation, taskId };
}

/** The wake's own input, as pi-durable records it. */
const inputOf = (stuck: Stuck, session: WakeSession, n = 0): ReturnType<typeof submissionOf> =>
  submissionOf(session.harness, stuck.conversation.id, wakeRequestId(stuck.taskId, n));

/** `closing` closed and reopened under a registry whose satan.wake is too old to run what it stored. */
async function reopenedTooOld(
  world: WakeWorld,
  closing: WakeSession,
): Promise<{ session: WakeSession; old: WakeWorld["task"] }> {
  await closing.harness.close(context);
  const old = tooOld(world);
  const session = await world.open(defineExtension({ name: "tasks", tasks: [old] }));
  return { session, old };
}

/** `stuck` crashed until pi-durable's `restartLimit` parks its task, then the session that shows it parked. */
async function reopenedParked(stuck: Stuck): Promise<WakeSession> {
  let session = stuck.session;
  for (let restart = 0; restart < 5; restart += 1) {
    await stuck.world.crash(session);
    session = await stuck.world.open();
    // A restart is counted only for a task that was running when the process died.
    await vi.waitFor(async () => {
      const record = await session.harness.getTask(stuck.taskId, context);
      expect(record?.restarts).toBe(restart + 1);
      expect(record?.state.status).toBe(restart < 4 ? "running" : "pending");
    }, WAIT);
  }
  await vi.waitFor(async () => {
    const { state } = await inspection(session.harness, stuck.taskId);
    expect(state).toMatchObject({ kind: "blocked", reason: "restart_limit" });
  }, WAIT);
  return session;
}

/** A withdrawn input: unanswered, because aborted. */
async function expectWithdrawn(stuck: Stuck, session: WakeSession): Promise<void> {
  const record = await inputOf(stuck, session);
  expect(record?.status).toBe("unanswered");
  expect(record?.reason).toBe("aborted");
}

/** The wake's journal lines that mention `taskId`, in order. */
const linesOf = (world: WakeWorld, taskId: TaskId): string[] =>
  world.lines.filter((line) => line.startsWith(`wake ${String(taskId)} `));

/** The sweep's own lines about `taskId`: its journal lines of occurrences (`n=`) left out. */
const sweepLines = (world: WakeWorld, taskId: TaskId): string[] =>
  linesOf(world, taskId).filter((line) => !line.startsWith(`wake ${String(taskId)} n=`));

describe("VT-1: the heartbeat", () => {
  it("VT-1a exactly one heartbeat after three starts", async () => {
    const world = wakeWorld();
    const first = await start(world);
    const heartbeat = created(first.heartbeat);

    const conversation = await topicConversation(world);
    const live = only(await viableHeartbeats(first.session.harness));
    expect(live.id).toBe(heartbeat);
    expect(live.input).toEqual({
      conversationId: conversation.id,
      scheduledBy: conversation.id,
      intent: HEARTBEAT_INTENT,
      episodeClass: "seclude",
      at: START + CEILING,
      recurring: true,
    });
    expect((await waitSleeping(first.session.harness, heartbeat)).until).toBe(START + CEILING);

    await first.session.harness.close(context);
    const second = await start(world);
    expect(second.heartbeat).toBeUndefined();
    await second.session.harness.close(context);
    const third = await start(world);
    expect(third.heartbeat).toBeUndefined();

    const lived = await liveWakes(third.session.harness, context);
    expect(lived.map((wake) => wake.id)).toEqual([heartbeat]);
    expect(world.lines.filter((line) => line.includes("heartbeat"))).toEqual([
      `wake heartbeat ${String(heartbeat)} created in ${TOPIC}`,
    ]);
  });

  it("VT-1b a parked heartbeat is replaced", async () => {
    const stuck = await behindHeldRun("heartbeat");
    const { world, taskId: parked } = stuck;
    const session = await reopenedParked(stuck);

    // The abort handler's withdrawal waits for this test, so the abort-marked task is
    // still live while `ensureHeartbeat` decides: the `!abortRequested` filter shows
    // whatever the scheduler's timing.
    const held = gate();
    // Opened however the test ends: a held withdrawal would hang the session's close.
    onTestFinished(held.open);
    world.wake.harness = withdrawalHeld(session.harness, held);

    const replacement = created(await sweepAndEnsure(world, session));
    const live = await liveWakes(session.harness, context);
    expect(live.map((wake) => wake.id)).toContain(replacement);
    const marked = only(live.filter((wake) => wake.abortRequested));
    expect(marked.id).toBe(parked);
    // Abort-marked, not blocked: the mark alone is why `ensureHeartbeat` must not count it.
    expect(marked.blocked).toBe(false);

    held.open();
    world.wake.harness = session.harness;
    expect((await waitTerminal(session.harness, parked)).status).toBe("aborted");

    expect((await viableHeartbeats(session.harness)).map((wake) => wake.id)).toEqual([replacement]);
    expect((await liveWakes(session.harness, context)).map((wake) => wake.id)).toEqual([
      replacement,
    ]);
    expect(world.lines).toContain(`wake heartbeat ${String(replacement)} created in ${TOPIC}`);
    await expectWithdrawn(stuck, session);
  });

  it("VT-1c a restart between the abort and the replacement still yields one heartbeat that fires", async () => {
    const world = wakeWorld();
    const first = await start(world);
    const old = created(first.heartbeat);
    await first.session.harness.close(context);

    // The restart whose registry cannot run it: swept and aborted, no replacement yet.
    const oldTask = tooOld(world);
    const crashed = await world.open(defineExtension({ name: "tasks", tasks: [oldTask] }));
    await sweepWakes(world.wake, crashed.harness);
    await waitTerminal(crashed.harness, old);
    expect(await liveWakes(crashed.harness, context)).toEqual([]);
    await crashed.harness.close(context);

    const { session, heartbeat } = await start(world);
    const replacement = created(heartbeat);
    expect(replacement).not.toBe(old);
    expect((await viableHeartbeats(session.harness)).map((wake) => wake.id)).toEqual([replacement]);

    const requests = recording(world);
    requests.script();
    pass(world, session, CEILING);
    await sleepingAt(session.harness, replacement, 1);
    expect(linesOf(world, replacement).some((line) => line.endsWith(" fire"))).toBe(true);
    expect(wakeInputs(requests.seen)).toHaveLength(1);
    expect(await wakeUserMessages(await topicConversation(world))).toBe(1);
  });

  it("VT-1d the heartbeat is suppressed while another wake sleeps", async () => {
    const world = wakeWorld();
    const { session, heartbeat } = await start(world);
    const beat = created(heartbeat);
    const conversation = await topicConversation(world);
    const oneShot = await createWake(
      session,
      world.task,
      wakeInput(conversation.id, { at: START + CEILING + HOUR }),
    );
    await waitSleeping(session.harness, oneShot);

    // A minute past the heartbeat's due time: the suppression sleep is timed from now,
    // not from the occurrence's `state.at` (which would sleep until START + 2 * CEILING).
    pass(world, session, CEILING + 60_000);
    expect(world.clock.now()).toBe(START + CEILING + 60_000);

    const line = `wake ${String(beat)} heartbeat suppressed: 1 pending`;
    await vi.waitFor(() => {
      expect(world.lines).toContain(line);
    }, WAIT);
    const sleep = await sleepingAt(session.harness, beat, 0, world.clock.now() + CEILING);
    expect(sleep.until).not.toBe(START + 2 * CEILING);
    expect(sleep.checkpoint["phase"]).toBe("fire");
    expect(
      await submissionOf(session.harness, conversation.id, wakeRequestId(beat, 0)),
    ).toBeUndefined();
    expect(linesOf(world, beat).some((text) => text.endsWith(" fire"))).toBe(false);
  });

  it("VT-1e a wake that has fired and awaits its turn does not suppress the heartbeat", async () => {
    const world = wakeWorld();
    const { session, heartbeat } = await start(world);
    const beat = created(heartbeat);
    const conversation = await topicConversation(world);
    const held = heldTurn();
    // Released however the test ends: a held turn would hang the harness close.
    onTestFinished(held.release);
    const records = recordedTurn();
    world.faux.setResponses([held.step, ...Array.from({ length: 6 }, () => records.step)]);

    // The one-shot fires an hour in and queues behind the held foreground turn.
    pass(world, session, HOUR);
    await conversation.submit({ type: "input", content: "foreground" }, context);
    await held.reached;
    const oneShot = await createWake(
      session,
      world.task,
      wakeInput(conversation.id, { at: world.clock.now() }),
    );
    await waitQueued(session, oneShot, conversation.id);

    // The heartbeat is due, and nobody sleeps: it fires, queued behind the same turn.
    pass(world, session, CEILING - HOUR);
    await waitQueued(session, beat, conversation.id);
    expect(world.lines.filter((line) => line.includes("suppressed"))).toEqual([]);
    expect(linesOf(world, beat).some((text) => text.endsWith(" fire"))).toBe(true);

    held.release();
    expect(await firedResult(session.harness, oneShot)).toEqual({
      fired: true,
    });
    await vi.waitFor(async () => {
      expect(
        (await submissionOf(session.harness, conversation.id, wakeRequestId(beat, 0)))?.status,
      ).toBe("done");
    }, WAIT);
  });

  it("VT-1f each fire is its own turn: n counts 0, 1, 2", async () => {
    const world = wakeWorld();
    const { session, heartbeat } = await start(world);
    const beat = created(heartbeat);
    const conversation = await topicConversation(world);
    const requests = recording(world);
    requests.script();
    expect((await waitSleeping(session.harness, beat)).checkpoint["n"]).toBe(0);

    pass(world, session, CEILING);
    const first = await sleepingAt(session.harness, beat, 1);
    pass(world, session, first.until - world.clock.now());
    await sleepingAt(session.harness, beat, 2);

    const firstTurn = await submissionOf(session.harness, conversation.id, wakeRequestId(beat, 0));
    const secondTurn = await submissionOf(session.harness, conversation.id, wakeRequestId(beat, 1));
    expect(firstTurn?.status).toBe("done");
    expect(secondTurn?.status).toBe("done");
    expect(firstTurn?.id).not.toBe(secondTurn?.id);
    expect(requests.seen).toHaveLength(2);
    // Each request carries the wake inputs so far: one, then both.
    expect(requests.seen.map((messages) => wakeInputs([messages]).length)).toEqual([1, 2]);
    expect(await wakeUserMessages(conversation)).toBe(2);
  });
});

describe("VT-2: the start sweep", () => {
  it("VT-2a a task_too_old heartbeat's queued input is withdrawn before it is aborted and replaced", async () => {
    const stuck = await behindHeldRun("heartbeat");
    const { world, taskId } = stuck;
    const { session, old } = await reopenedTooOld(world, stuck.session);

    const replacement = created(await sweepAndEnsure(world, session, old));

    const lines = sweepLines(world, taskId);
    expect(lines).toEqual([
      `wake ${String(taskId)} blocked (task_too_old); aborting`,
      `wake ${String(taskId)} withdrew 1 queued input(s)`,
    ]);
    await expectWithdrawn(stuck, session);
    const record = await session.harness.getTask(taskId, context);
    expect(record?.state.status).toBe("terminal");
    expect(record?.state.status === "terminal" && record.state.outcome.status).toBe("orphaned");
    // The handler never ran: nothing journalled it as cancelled.
    expect(world.lines.filter((line) => line.includes("cancelled"))).toEqual([]);
    expect(notifyCalls(world)).toEqual([]);

    expect(replacement).not.toBe(taskId);
    expect((await viableHeartbeats(session.harness)).map((wake) => wake.id)).toEqual([replacement]);
    expect((await liveWakes(session.harness, context)).map((wake) => wake.id)).toEqual([
      replacement,
    ]);
    expect((await submissionOf(session.harness, stuck.conversation.id, SECOND))?.status).toBe(
      "queued",
    );
  });

  it("VT-2b the replacement targets the newer conversation", async () => {
    const stuck = await behindHeldRun("heartbeat");
    const { world } = stuck;
    const newer = await world.wake.conversations.open({
      kind: "topic",
      name: TOPIC,
      new: true,
    });
    expect(newer.id).not.toBe(stuck.conversation.id);
    const { session, old } = await reopenedTooOld(world, stuck.session);

    const replacement = created(await sweepAndEnsure(world, session, old));

    const live = await viableHeartbeats(session.harness);
    expect(live.map((wake) => wake.id)).toEqual([replacement]);
    expect(only(live).input.conversationId).toBe(newer.id);
    expect(only(live).input.scheduledBy).toBe(newer.id);
    await expectWithdrawn(stuck, session);
  });

  it("VT-2c a restart after the withdrawal and before the abort finishes the job", async () => {
    const stuck = await behindHeldRun("heartbeat");
    const { world, taskId } = stuck;
    const { session: crashed } = await reopenedTooOld(world, stuck.session);

    // The process dies as it is about to abort: the input is already withdrawn.
    const dying = recordingHarness(crashed.harness, true);
    world.wake.harness = dying.deps;
    await expect(sweepWakes(world.wake, crashed.harness)).rejects.toThrow("the process died");
    expect(dying.aborted).toEqual([taskId]);
    await expectWithdrawn(stuck, crashed);
    expect((await crashed.harness.getTask(taskId, context))?.state.status).not.toBe("terminal");

    const { session, old } = await reopenedTooOld(world, crashed);
    const replacement = created(await sweepAndEnsure(world, session, old));

    await waitTerminal(session.harness, taskId);
    await expectWithdrawn(stuck, session);
    expect(replacement).not.toBe(taskId);
    expect((await viableHeartbeats(session.harness)).map((wake) => wake.id)).toEqual([replacement]);
    expect((await liveWakes(session.harness, context)).map((wake) => wake.id)).toEqual([
      replacement,
    ]);
  });

  it("VT-2c-one-shot a blocked one-shot's failure report lands before the abort a crash interrupts", async () => {
    const stuck = await behindHeldRun("one-shot");
    const { world, taskId } = stuck;
    const { session: crashed } = await reopenedTooOld(world, stuck.session);

    // The process dies as it is about to abort: a report moved after the abort would be lost.
    const dying = recordingHarness(crashed.harness, true);
    world.wake.harness = dying.deps;
    await expect(sweepWakes(world.wake, crashed.harness)).rejects.toThrow("the process died");
    expect(dying.aborted).toEqual([taskId]);
    const failed = (lines: readonly string[]): string[] =>
      lines.filter((line) => line.includes("failed: blocked (task_too_old)"));
    expect(failed(world.lines)).toHaveLength(1);
    expect(notifyCalls(world)).toHaveLength(1);
    await expectWithdrawn(stuck, crashed);
    expect((await crashed.harness.getTask(taskId, context))?.state.status).not.toBe("terminal");

    const { session, old } = await reopenedTooOld(world, crashed);
    const heartbeat = created(await sweepAndEnsure(world, session, old));

    expect((await waitTerminal(session.harness, taskId)).status).toBe("orphaned");
    await expectWithdrawn(stuck, session);
    expect((await liveWakes(session.harness, context)).map((wake) => wake.id)).toEqual([heartbeat]);
    // The repeat sweeps reporting what the crash cut short an abort of: once more at most.
    expect(failed(world.lines).length).toBeGreaterThanOrEqual(1);
    expect(failed(world.lines).length).toBeLessThanOrEqual(2);
  });

  it("VT-2d a blocked one-shot is withdrawn, reported as failed, aborted, and not replaced", async () => {
    const stuck = await behindHeldRun("one-shot");
    const { world, taskId } = stuck;
    const { session, old } = await reopenedTooOld(world, stuck.session);

    const heartbeat = created(await sweepAndEnsure(world, session, old));

    await expectWithdrawn(stuck, session);
    const lines = sweepLines(world, taskId);
    expect(lines[0]).toBe(`wake ${String(taskId)} blocked (task_too_old); aborting`);
    expect(lines[1]).toBe(`wake ${String(taskId)} withdrew 1 queued input(s)`);
    expect(lines.filter((line) => line.includes("failed: blocked (task_too_old)"))).toHaveLength(1);
    const notify = only(notifyCalls(world));
    expect(notify.args["title"]).toBe("SATAN wake failed");
    expect(String(notify.args["body"])).toContain("blocked (task_too_old)");

    expect((await waitTerminal(session.harness, taskId)).status).toBe("orphaned");
    const live = await liveWakes(session.harness, context);
    expect(live.map((wake) => wake.id)).toEqual([heartbeat]);
    expect(live.filter((wake) => wake.input.recurring !== true)).toEqual([]);
  });

  it("VT-2e a parked heartbeat's input is withdrawn once, and its abort handler does not reject", async () => {
    const stuck = await behindHeldRun("heartbeat");
    const { world, taskId } = stuck;
    const session = await reopenedParked(stuck);

    const recorder = recordingHarness(session.harness);
    world.wake.harness = recorder.deps;
    await sweepWakes(world.wake, session.harness);

    await waitTerminal(session.harness, taskId);
    await expectWithdrawn(stuck, session);
    expect(recorder.answers.filter((answer) => answer === "aborted")).toHaveLength(1);
    expect(world.lines.filter((line) => line.includes("withdraw failed"))).toEqual([]);
    expect(sweepLines(world, taskId)[0]).toBe(
      `wake ${String(taskId)} blocked (restart_limit); aborting`,
    );
    expect(notifyCalls(world)).toEqual([]);
  });

  it("VT-2f an input already placed is left to run", async () => {
    const world = wakeWorld();
    const first = await world.open();
    const conversation = await topicConversation(world);
    const held = heldTurn();
    const records = recordedTurn();
    // Occurrence 0's turn is cut off by the close and resumed, held, after the reopen.
    world.faux.setResponses([
      heldUntilCutOff,
      held.step,
      ...Array.from({ length: 6 }, () => records.step),
    ]);
    const beat = await createHeartbeat(world, first, conversation);
    pass(world, first, CEILING);
    await waitPlaced(first, beat);
    await first.harness.close(context);

    const old = tooOld(world);
    const session = await world.open(defineExtension({ name: "tasks", tasks: [old] }));
    // Released however the test ends, and before the session closes: a held turn would hang the close.
    onTestFinished(held.release);
    await held.reached;
    await waitPlaced(session, beat);

    const recorder = recordingHarness(session.harness);
    world.wake.harness = recorder.deps;
    await sweepWakes(world.wake, session.harness);

    expect(recorder.answers).toEqual([]);
    expect(linesOf(world, beat)).toContain(`wake ${String(beat)} withdrew 0 queued input(s)`);
    expect((await waitTerminal(session.harness, beat)).status).toBe("orphaned");
    expect(
      (await submissionOf(session.harness, conversation.id, wakeRequestId(beat, 0)))?.status,
    ).toBe("placed");

    held.release();
    await vi.waitFor(async () => {
      expect(
        (await submissionOf(session.harness, conversation.id, wakeRequestId(beat, 0)))?.status,
      ).toBe("done");
    }, WAIT);
  });
  it("VT-2g an abort-marked blocked wake is withdrawn and aborted but not reported as failed", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const conversation = await topicConversation(world);
    const id = taskIdOf(7);
    const submission: SubmissionRecord = {
      id: submissionIdOf(1),
      conversationId: conversation.id,
      // `wake:7:0`: the request id of the wake's occurrence 0.
      requestId: wakeRequestId(id, 0),
      type: "input",
      status: "queued",
    };
    const tasks: readonly TaskInspection[] = [
      {
        record: {
          id,
          conversationId: conversation.id,
          kind: WAKE_KIND,
          version: 1,
          input: storedInput(wakeInput(conversation.id, { at: START })),
          background: true,
          // An abort mark already stands: the wake was cancelled, not failed.
          abortRequested: true,
          state: { status: "pending", checkpoint: { phase: "fire", at: START, n: 0 } },
        },
        state: { kind: "blocked", reason: "missing_task" },
      },
    ];
    const calls: string[] = [];
    const harness: WakeDeps["harness"] = {
      inspect: (): Promise<HarnessInspection> =>
        Promise.resolve({ scheduling: "running", tasks, submissions: [submission] }),
      abortSubmission: (submissionId): Promise<"aborted"> => {
        calls.push(`withdraw ${String(submissionId)}`);
        return Promise.resolve("aborted");
      },
      abortTask: (taskId): Promise<"terminal"> => {
        calls.push(`abort ${String(taskId)}`);
        return Promise.resolve("terminal");
      },
    };

    await sweepWakes({ ...world.wake, harness }, session.harness);

    // Withdrawn first, then aborted: a cancelled wake gets no failure report.
    expect(calls).toEqual([`withdraw ${String(submission.id)}`, `abort ${String(id)}`]);
    expect(world.lines).toEqual([
      `wake ${String(id)} blocked (missing_task); aborting`,
      `wake ${String(id)} withdrew 1 queued input(s)`,
    ]);
    expect(world.lines.filter((line) => line.includes("failed:"))).toEqual([]);
    expect(notifyCalls(world)).toEqual([]);
  });
});

describe("wakeBinding", () => {
  it("refuses a read until both steps have bound, then reads both", () => {
    const world = wakeWorld();
    const { harness, conversations, ...early } = world.wake;
    const binding = wakeBinding();
    expect(() => binding.deps()).toThrow("wake dependencies read before the daemon bound them");
    binding.bindEarly(early);
    expect(() => binding.deps()).toThrow("wake dependencies read before the daemon bound them");
    binding.bindLate({ harness, conversations });
    expect(binding.deps()).toEqual(world.wake);
  });
});
