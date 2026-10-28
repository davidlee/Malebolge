// VT-1 to VT-3 of `satan.wake` v1's bounded wait and abort handler (SL-034
// PHASE-05; design § Fire composition (Bounded wait), § The wake task (abort
// handler)): a submit that waits at most one ceiling, and an abort that owns the
// input it prepared. DEC-042 changed the premise of the cases that needed an input
// stuck in the queue: a failed run now starts the next run with the inputs queued
// behind it, so those cases hold a foreground run instead. The world, clock and
// harness timers are the wake fixture's.

import type { Message } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { Harness, Submission, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { context } from "../src/context.ts";
import type { WakeDeps } from "../src/wake/extension.ts";
import { localIso } from "../src/wake/local-time.ts";
import { type WakeResult, wakeRequestId } from "../src/wake/task.ts";
import {
  CEILING,
  HOUR,
  START,
  WAIT,
  type GatedTurn,
  type RecordedTurn,
  type Sleeping,
  type WakeSession,
  type WakeWorld,
  checkpointOf,
  createWake,
  dataOf,
  failingOnce,
  firedResult,
  heldGate,
  heldTurn,
  heldUntilCutOff,
  notifyCalls,
  only,
  recordedTurn,
  recording,
  submissionOf,
  turn,
  waitPlaced,
  waitQueued,
  waitSleeping,
  waitTerminal,
  wakeEntries,
  wakeInput,
  wakeInputs,
  wakeUserMessages,
  wakeWorld,
} from "./wake-fixture.ts";

/** The request id of the plain input submitted behind the wake: findable after a reopen. */
const SECOND = "manual:second";

/** The request id of the foreground input: readable after the close that cut its run off. */
const FOREGROUND = "manual:foreground";

/**
 * Lets exactly one ceiling pass on the bounded wait: first waits until the wait
 * has armed its timer, due one ceiling from now, then moves the clock to it.
 */
async function passBound(world: WakeWorld): Promise<void> {
  await vi.waitFor(() => {
    expect(world.pending()).toContain(world.clock.now() + CEILING);
  }, WAIT);
  world.advance(CEILING);
  await turn();
}

/** The task's stored occurrence, whatever state it is in. */
async function occurrenceOf(
  harness: Harness,
  taskId: TaskId<WakeResult>,
): Promise<number | undefined> {
  const record = await harness.getTask(taskId, context);
  if (record === undefined) {
    return undefined;
  }
  const n = checkpointOf(record)["n"];
  return typeof n === "number" ? n : undefined;
}

/** A cancelled task's result, once it is terminal. */
async function abortedResult(
  harness: Harness,
  taskId: TaskId<WakeResult>,
): Promise<WakeResult | undefined> {
  const outcome = await waitTerminal(harness, taskId);
  expect(outcome.status).toBe("aborted");
  return outcome.result;
}

/** `harness`, with its withdrawing call answered by `abortSubmission`: what pi-durable may answer, on demand. */
function withdrawingBy(
  harness: Harness,
  abortSubmission: WakeDeps["harness"]["abortSubmission"],
): WakeDeps["harness"] {
  return {
    inspect: (ctx) => harness.inspect(ctx),
    abortTask: (id, ctx) => harness.abortTask(id, ctx),
    abortSubmission,
  };
}

/** `count` plain answers: the turns of the runs that follow a hold or a failure. */
const plains = (records: RecordedTurn, count = 6): FauxResponseStep[] =>
  Array.from({ length: count }, () => records.step);

/** A held turn's request has started: what `heldUntilCutOff` cannot tell a test itself. */
async function waitHeld(world: WakeWorld): Promise<void> {
  await vi.waitFor(() => {
    expect(world.faux.state.callCount).toBe(1);
  }, WAIT);
}

interface StuckOptions {
  readonly recurring: boolean;
  /** `same`: reopen with the wake still able to submit; `disabled`: the switch is off, so it defers. */
  readonly reopen: "none" | "same" | "disabled";
}

/** A wake stuck behind a held run, and the world it is stuck in. */
interface BehindHeldRun {
  readonly world: WakeWorld;
  readonly session: WakeSession;
  readonly taskId: TaskId<WakeResult>;
  /** What the model saw, oldest first; the held foreground turn is not among them. */
  readonly seen: Message[][];
  /** The held foreground turn as the session being tested holds it: releasing it ends the run. */
  readonly held: GatedTurn;
  /** The foreground input's submission, for the case that waits for its turn to end. */
  readonly foreground: Submission;
}

/** What a foreground run held in flight has queued behind it, before any reopen. */
interface Stuck {
  readonly world: WakeWorld;
  readonly session: WakeSession;
  readonly taskId: TaskId<WakeResult>;
  readonly seen: Message[][];
  readonly records: RecordedTurn;
  /** The foreground input's submission, for the case that waits for its turn to end. */
  readonly foreground: Submission;
}

/**
 * Holds a foreground run in flight, then queues the wake's input behind it and a
 * "second" input behind the wake's, and proves both are still queued: the run,
 * not a failure, is what holds them.
 */
async function stuckBehind(step: FauxResponseStep, recurring: boolean): Promise<Stuck> {
  const world = wakeWorld();
  const session = await world.open();
  const records = recordedTurn();
  world.faux.setResponses([step, ...plains(records)]);
  const foreground = await session.root.submit(
    { type: "input", content: "foreground", requestId: FOREGROUND },
    context,
  );
  await waitHeld(world);
  const taskId = await createWake(
    session,
    world.task,
    wakeInput(session.root.id, recurring ? { at: START, recurring: true } : { at: START }),
  );
  await waitQueued(session, taskId);
  await session.root.submit(
    { type: "input", content: "second", whenBusy: "followUp", requestId: SECOND },
    context,
  );
  expect(
    (await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)))?.status,
  ).toBe("queued");
  expect((await submissionOf(session.harness, session.root.id, SECOND))?.status).toBe("queued");
  return { world, session, taskId, seen: records.seen, records, foreground };
}

/**
 * Closes the world with the foreground run in flight and reopens it, holding the
 * resumed run: the close cuts the turn off, so the run re-requests on reopen. Half
 * a ceiling passes first, so the reopened wait's bound is a full ceiling.
 */
async function reopenHeld(stuck: Stuck): Promise<{ session: WakeSession; held: GatedTurn }> {
  stuck.world.advance(CEILING / 2);
  await stuck.session.harness.close(context);
  const held = heldTurn();
  stuck.world.faux.setResponses([held.step, ...plains(stuck.records)]);
  const session = await stuck.world.open();
  await held.reached;
  return { session, held };
}

/**
 * The held-run recipe (DEC-042): a foreground turn held in flight, the wake's input
 * queued behind it. A held run keeps an input queued; a failed one now starts the
 * next run with it.
 */
async function behindHeldRun(options: StuckOptions): Promise<BehindHeldRun> {
  // Across a close the turn must answer its cut-off; otherwise the test holds it itself.
  const held = options.reopen === "none" ? heldTurn() : undefined;
  const stuck = await stuckBehind(
    held === undefined ? heldUntilCutOff : held.step,
    options.recurring,
  );
  if (options.reopen === "disabled") {
    stuck.world.setEnabled(false);
  }
  if (held !== undefined) {
    onTestFinished(held.release);
    return { ...stuck, held };
  }
  const resumed = await reopenHeld(stuck);
  onTestFinished(resumed.held.release);
  return { ...stuck, session: resumed.session, held: resumed.held };
}

interface FailedOptions {
  readonly recurring: boolean;
  /** `same`: the run is cut off by a close and fails after the reopen, with the wake's input still queued. */
  readonly reopen: "none" | "same";
}

/** A failed run that placed the wake's queued input, and the world it placed it in. */
interface BehindFailedRun {
  readonly world: WakeWorld;
  readonly session: WakeSession;
  readonly taskId: TaskId<WakeResult>;
  /** What the model saw, oldest first; the failed turn is not among them. */
  readonly seen: Message[][];
}

/**
 * The failed-run recipe (DEC-042): with `afterFailedRun: continue` a foreground run
 * that fails starts the next run with the wake's input queued behind it, and that
 * run answers, with nothing else submitting.
 */
async function behindFailedRun(options: FailedOptions): Promise<BehindFailedRun> {
  const world = wakeWorld();
  let session = await world.open();
  const records = recordedTurn();
  const failing = failingOnce();
  const input = wakeInput(
    session.root.id,
    options.recurring ? { at: START, recurring: true } : { at: START },
  );
  let taskId: TaskId<WakeResult>;

  if (options.reopen === "none") {
    world.faux.setResponses([failing.step, ...plains(records)]);
    const foreground = await session.root.submit(
      { type: "input", content: "foreground", requestId: FOREGROUND },
      context,
    );
    await failing.reached;
    taskId = await createWake(session, world.task, input);
    await waitQueued(session, taskId);
    failing.release();
    const answered = await foreground.wait(context);
    expect(answered.status).toBe("unanswered");
    expect(answered.reason).toBe("model_error");
  } else {
    // Held through the close, so the wake's input is still queued when the reopened run fails.
    world.faux.setResponses([heldUntilCutOff]);
    await session.root.submit(
      { type: "input", content: "foreground", requestId: FOREGROUND },
      context,
    );
    await waitHeld(world);
    taskId = await createWake(session, world.task, input);
    await waitQueued(session, taskId);
    await session.harness.close(context);

    world.faux.setResponses([failing.step, ...plains(records)]);
    session = await world.open();
    await failing.reached;
    failing.release();
    await vi.waitFor(async () => {
      const settled = await submissionOf(session.harness, session.root.id, FOREGROUND);
      expect(settled?.status).toBe("unanswered");
    }, WAIT);
  }
  return { world, session, taskId, seen: records.seen };
}

/**
 * The wake's occurrence 0 was answered by the run the failure started: settled
 * done, journaled done, with `calls` model requests in all — no submit, heartbeat
 * or reopen nudged it — and nothing failed or notified.
 */
async function expectAnsweredInNextRun(failed: BehindFailedRun, calls: number): Promise<void> {
  const { world, session, taskId, seen } = failed;
  await vi.waitFor(async () => {
    const answered = await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0));
    expect(answered?.status).toBe("done");
  }, WAIT);
  expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) done`);
  expect(world.lines.filter((line) => line.includes("failed:"))).toEqual([]);
  expect(notifyCalls(world)).toEqual([]);
  expect(world.faux.state.callCount).toBe(calls);
  // The queued input itself started the run that answered it.
  expect(await wakeUserMessages(session.root)).toBe(1);
  expect(only(wakeInputs(seen))).toContain("<intent>look at the window</intent>");
}

/** The bound expired on a heartbeat's queued input: withdrawn, notified, the next occurrence asleep. */
async function expectHeartbeatWithdrawn(
  world: WakeWorld,
  session: WakeSession,
  taskId: TaskId<WakeResult>,
): Promise<Sleeping> {
  const sleep = await waitSleeping(session.harness, taskId);
  expect(sleep.checkpoint["phase"]).toBe("fire");
  expect(sleep.checkpoint["n"]).toBe(1);
  expect(sleep.checkpoint["at"]).toBe(sleep.until);
  expect(sleep.until).toBe(world.clock.now() + CEILING);

  expect(world.lines).toContain(
    `wake ${String(taskId)} n=0 heartbeat unanswered after 2h; withdrawn`,
  );
  expect(world.lines.filter((line) => line.includes("failed:"))).toEqual([]);

  const notify = only(notifyCalls(world));
  expect(notify.args["title"]).toBe("SATAN wake unanswered");
  expect(String(notify.args["body"])).toContain(
    "heartbeat unanswered (queued behind a failed run?)",
  );

  const withdrawn = await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0));
  expect(withdrawn?.status).toBe("unanswered");
  expect(withdrawn?.reason).toBe("aborted");
  return sleep;
}

/** The bound expired on a one-shot's queued input: withdrawn, notified, the task failed. */
async function expectOneShotWithdrawn(
  world: WakeWorld,
  session: WakeSession,
  taskId: TaskId<WakeResult>,
): Promise<void> {
  const outcome = await waitTerminal(session.harness, taskId);
  expect(outcome.status).toBe("failed");
  expect(outcome.error?.message).toBe("not answered within 2h; withdrawn");

  expect(world.lines).toContain(
    `wake ${String(taskId)} n=0 (default) failed: not answered within 2h; withdrawn`,
  );

  const notify = only(notifyCalls(world));
  expect(notify.args["title"]).toBe("SATAN wake failed");

  const withdrawn = await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0));
  expect(withdrawn?.status).toBe("unanswered");
  expect(withdrawn?.reason).toBe("aborted");
}

describe("VT-1: a heartbeat whose input is stuck behind a held run", () => {
  it("VT-1 the bound withdraws it, then its next occurrence runs with the queued input", async () => {
    const { world, session, taskId, seen, held, foreground } = await behindHeldRun({
      recurring: true,
      reopen: "none",
    });

    await passBound(world);
    const sleep = await expectHeartbeatWithdrawn(world, session, taskId);
    // The withdrawn occurrence never reached the model.
    expect(wakeInputs(seen)).toEqual([]);

    // The run ends normally and revives nothing: the "second" input, still queued, is answered.
    held.release();
    expect((await foreground.wait(context)).status).toBe("done");
    await session.harness.waitForIdle(context);
    expect((await submissionOf(session.harness, session.root.id, SECOND))?.status).toBe("done");

    // Occurrence 1 fires one ceiling on, and its input starts the conversation's next run.
    world.advance(sleep.until - world.clock.now());
    session.harness.resume();
    await vi.waitFor(async () => {
      expect(await occurrenceOf(session.harness, taskId)).toBe(2);
    }, WAIT);

    const fired = await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 1));
    expect(fired?.status).toBe("done");

    // Exactly one wake input was ever put before the model, and it is occurrence 1's.
    const text = only(wakeInputs(seen));
    expect(text).toContain(`fired_at="${localIso(sleep.until)}"`);
    const entry = only(await wakeEntries(session.root));
    expect(dataOf(entry)["n"]).toBe(1);
  });

  it("VT-1 the same withdrawal holds across a close and reopen while stuck", async () => {
    const { world, session, taskId, seen, held } = await behindHeldRun({
      recurring: true,
      reopen: "same",
    });

    await passBound(world);
    const sleep = await expectHeartbeatWithdrawn(world, session, taskId);
    expect(wakeInputs(seen)).toEqual([]);

    // The resumed run is held too: releasing it lets occurrence 1's input start a run.
    held.release();
    await session.harness.waitForIdle(context);
    world.advance(sleep.until - world.clock.now());
    session.harness.resume();
    await vi.waitFor(async () => {
      expect(await occurrenceOf(session.harness, taskId)).toBe(2);
    }, WAIT);
    const fired = await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 1));
    expect(fired?.status).toBe("done");
    expect(dataOf(only(await wakeEntries(session.root)))["n"]).toBe(1);
  });
});

describe("VT-2: a one-shot whose input is stuck behind a held run", () => {
  it("VT-2 the bound withdraws it and the wake fails", async () => {
    const { world, session, taskId, seen } = await behindHeldRun({
      recurring: false,
      reopen: "none",
    });

    await passBound(world);
    await expectOneShotWithdrawn(world, session, taskId);

    // No turn ever ran the withdrawn input.
    expect(wakeInputs(seen)).toEqual([]);
    expect(await wakeEntries(session.root)).toEqual([]);
  });

  it("VT-2 the same failure across a close and reopen while stuck", async () => {
    const { world, session, taskId, seen } = await behindHeldRun({
      recurring: false,
      reopen: "same",
    });

    await passBound(world);
    await expectOneShotWithdrawn(world, session, taskId);
    expect(wakeInputs(seen)).toEqual([]);
    expect(await wakeEntries(session.root)).toEqual([]);
  });

  it("VT-2 placed at the bound: the wait keeps going and the turn's answer completes the wake", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const held = heldTurn();
    world.faux.setResponses([held.step]);
    const taskId = await createWake(session, world.task, wakeInput(session.root.id, { at: START }));

    await held.reached;
    await waitPlaced(session, taskId);

    // The bound passes while the input is placed: no withdrawal, no failure, no notification.
    await passBound(world);
    expect((await session.harness.getTask(taskId, context))?.state.status).toBe("running");
    expect(
      (await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)))?.status,
    ).toBe("placed");
    expect(world.lines.filter((line) => line.includes("failed:"))).toEqual([]);
    expect(notifyCalls(world)).toEqual([]);

    held.release();
    expect(await firedResult(session.harness, taskId)).toEqual({ fired: true });
    expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) done`);
  });
});

describe("VT-3: the abort handler owns the input; a failed run continues without it (DEC-042)", () => {
  it("VT-3a abort withdraws a queued input, and neither the failed run that continues nor time revives it", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const failing = failingOnce();
    const records = recordedTurn();
    world.faux.setResponses([failing.step, ...Array.from({ length: 4 }, () => records.step)]);
    const foreground = await session.root.submit({ type: "input", content: "foreground" }, context);
    await failing.reached;
    const taskId = await createWake(session, world.task, wakeInput(session.root.id, { at: START }));
    await waitQueued(session, taskId);

    // The queued input is withdrawn at once, and the task says nothing fired.
    expect(await session.harness.abortTask(taskId, context)).toBe("marked");
    expect(await abortedResult(session.harness, taskId)).toEqual({ fired: false });
    const withdrawn = await submissionOf(
      session.harness,
      session.root.id,
      wakeRequestId(taskId, 0),
    );
    expect(withdrawn?.status).toBe("unanswered");
    expect(withdrawn?.reason).toBe("aborted");

    // The foreground run failing afterwards continues (DEC-042) but starts no wake turn,
    // notifies nobody, and fails no wake.
    failing.release();
    expect((await foreground.wait(context)).status).toBe("unanswered");
    world.advance(CEILING);
    await turn();
    expect(
      (await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)))?.reason,
    ).toBe("aborted");
    expect(wakeInputs(records.seen)).toEqual([]);
    expect(notifyCalls(world)).toEqual([]);
    expect(world.lines.filter((line) => line.includes("failed:"))).toEqual([]);
    expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) cancelled`);
  });

  it("VT-3b abort withdraws an input admitted before a restart", async () => {
    const { world, session, taskId } = await behindHeldRun({
      recurring: false,
      reopen: "disabled",
    });

    // Back from the restart with the switch off: the submit phase defers, prepared, keeping the admission.
    const sleep = await waitSleeping(session.harness, taskId);
    expect(sleep.checkpoint["phase"]).toBe("fire");
    expect(sleep.checkpoint["n"]).toBe(0);
    expect(sleep.checkpoint["prepared"]).toBe(true);
    expect(
      (await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)))?.status,
    ).toBe("queued");

    expect(await session.harness.abortTask(taskId, context)).toBe("marked");
    expect(await abortedResult(session.harness, taskId)).toEqual({ fired: false });
    const withdrawn = await submissionOf(
      session.harness,
      session.root.id,
      wakeRequestId(taskId, 0),
    );
    expect(withdrawn?.status).toBe("unanswered");
    expect(withdrawn?.reason).toBe("aborted");
    expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) cancelled`);
  });

  it("VT-3c abort of a prepared input that was never admitted reports nothing fired", async () => {
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

    world.setEnabled(false);
    session = await world.open();
    const sleep = await waitSleeping(session.harness, taskId);
    expect(sleep.checkpoint["phase"]).toBe("fire");
    expect(sleep.checkpoint["prepared"]).toBe(true);
    expect(
      await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)),
    ).toBeUndefined();

    expect(await session.harness.abortTask(taskId, context)).toBe("marked");
    expect(await abortedResult(session.harness, taskId)).toEqual({ fired: false });
    expect(
      await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)),
    ).toBeUndefined();
    expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) cancelled`);
  });

  it("VT-3d abort of a placed input reports fired and leaves its turn to finish", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const held = heldTurn();
    world.faux.setResponses([held.step]);
    const taskId = await createWake(session, world.task, wakeInput(session.root.id, { at: START }));

    await held.reached;
    await waitPlaced(session, taskId);

    expect(await session.harness.abortTask(taskId, context)).toBe("marked");
    expect(await abortedResult(session.harness, taskId)).toEqual({ fired: true });
    expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) cancelled: already fired`);

    // A placed input is never withdrawn: its turn finishes on its own.
    held.release();
    await vi.waitFor(async () => {
      const record = await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0));
      expect(record?.status).toBe("done");
    }, WAIT);
  });

  it("VT-3e abort of a wake that never fired reports nothing fired", async () => {
    const world = wakeWorld();
    const session = await world.open();
    const taskId = await createWake(
      session,
      world.task,
      wakeInput(session.root.id, { at: START + HOUR }),
    );
    const sleep = await waitSleeping(session.harness, taskId);
    expect(sleep.checkpoint["phase"]).toBe("fire");
    expect(sleep.checkpoint["n"]).toBe(0);
    expect(sleep.checkpoint["prepared"]).toBeUndefined();

    expect(await session.harness.abortTask(taskId, context)).toBe("marked");
    expect(await abortedResult(session.harness, taskId)).toEqual({ fired: false });
    expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) cancelled`);
    expect(world.lines.some((line) => line.includes("withdraw failed"))).toBe(false);
  });

  it("VT-3f a settled input reports fired: its turn ran", async () => {
    const { world, session, taskId } = await behindHeldRun({
      recurring: false,
      reopen: "disabled",
    });
    await waitSleeping(session.harness, taskId);

    // What pi-durable answers when the input settled between the lookup and the withdrawal.
    world.wake.harness = withdrawingBy(session.harness, () => Promise.resolve("settled"));
    expect(await session.harness.abortTask(taskId, context)).toBe("marked");
    expect(await abortedResult(session.harness, taskId)).toEqual({ fired: true });
    expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) cancelled: already fired`);
  });

  it("VT-3f a withdrawal that throws reports fired and journals why", async () => {
    const { world, session, taskId } = await behindHeldRun({
      recurring: false,
      reopen: "disabled",
    });
    await waitSleeping(session.harness, taskId);

    // The admitted input cannot be withdrawn: the task reports fired (W9's overstatement) and says why.
    world.wake.harness = withdrawingBy(session.harness, () => Promise.reject(new Error("boom")));
    expect(await session.harness.abortTask(taskId, context)).toBe("marked");
    expect(await abortedResult(session.harness, taskId)).toEqual({ fired: true });
    expect(world.lines).toContain(`wake ${String(taskId)} n=0 (default) withdraw failed: boom`);
  });

  it("VT-3g a wake's input queued behind a failed run is placed in the next run, with no further input", async () => {
    const failed = await behindFailedRun({ recurring: false, reopen: "none" });

    await expectAnsweredInNextRun(failed, 2);

    // The one-shot completes, and the input that answered it is its only entry.
    expect(await firedResult(failed.session.harness, failed.taskId)).toEqual({ fired: true });
    expect(dataOf(only(await wakeEntries(failed.session.root)))["n"]).toBe(0);
  });

  it("VT-3h a heartbeat's input queued behind a failed run is placed in the next run, with no further input", async () => {
    const failed = await behindFailedRun({ recurring: true, reopen: "none" });

    await expectAnsweredInNextRun(failed, 2);

    // The occurrence is done and the heartbeat sleeps one ceiling on for its next one.
    const sleep = await waitSleeping(failed.session.harness, failed.taskId);
    expect(sleep.checkpoint["n"]).toBe(1);
    expect(sleep.until).toBe(failed.world.clock.now() + CEILING);
  });

  it("VT-3i a wake's input queued behind a run failed after a reopen is placed in the next run, with no further input", async () => {
    const failed = await behindFailedRun({ recurring: false, reopen: "same" });

    // The close cut the first attempt off, and the reopened run is the one that fails.
    await expectAnsweredInNextRun(failed, 3);
    expect(await firedResult(failed.session.harness, failed.taskId)).toEqual({ fired: true });
  });
});
