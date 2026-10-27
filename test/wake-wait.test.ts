// VT-1 to VT-3 of `satan.wake` v1's bounded wait and abort handler (SL-034
// PHASE-05; design § Fire composition (Bounded wait), § The wake task (abort
// handler)): a submit that waits at most one ceiling, and an abort that owns the
// input it prepared. The world, clock and harness timers are the wake fixture's.

import type { Message } from "@earendil-works/pi-ai";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import type { WakeDeps } from "../src/wake/extension.ts";
import { type WakeResult, wakeRequestId } from "../src/wake/task.ts";
import {
  CEILING,
  HOUR,
  START,
  WAIT,
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
  wakeWorld,
} from "./wake-fixture.ts";

/** The request id of the plain input submitted behind the wake: findable after a reopen. */
const SECOND = "manual:second";

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

interface StuckOptions {
  readonly recurring: boolean;
  /** `same`: reopen with the wake still able to submit; `disabled`: the switch is off, so it defers. */
  readonly reopen: "none" | "same" | "disabled";
}

/** A wake stuck behind a failed run, and the world it is stuck in. */
interface BehindFailure {
  readonly world: WakeWorld;
  readonly session: WakeSession;
  readonly taskId: TaskId<WakeResult>;
  /** What the model saw, oldest first; the failed foreground turn is not among them. */
  readonly seen: Message[][];
}

/**
 * The failed-run recipe: a held foreground turn fails, `afterFailedRun: keep` leaves
 * the wake's input queued behind it, and a "second" input queues behind the wake's.
 */
async function behindFailure(options: StuckOptions): Promise<BehindFailure> {
  const world = wakeWorld();
  let session = await world.open();
  const failing = failingOnce();
  const records = recordedTurn();
  world.faux.setResponses([failing.step, ...Array.from({ length: 6 }, () => records.step)]);
  const foreground = await session.root.submit({ type: "input", content: "foreground" }, context);
  await failing.reached;
  const taskId = await createWake(
    session,
    world.task,
    wakeInput(session.root.id, options.recurring ? { at: START, recurring: true } : { at: START }),
  );
  await waitQueued(session, taskId);
  await session.root.submit(
    { type: "input", content: "second", whenBusy: "followUp", requestId: SECOND },
    context,
  );

  failing.release();
  const answered = await foreground.wait(context);
  expect(answered.status).toBe("unanswered");
  expect(answered.reason).toBe("model_error");
  // Keep: the wake's input stays queued behind the failed run.
  expect(
    (await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 0)))?.status,
  ).toBe("queued");

  if (options.reopen === "disabled") {
    world.setEnabled(false);
  }
  expect((await submissionOf(session.harness, session.root.id, SECOND))?.status).toBe("queued");
  if (options.reopen !== "none") {
    // Half a ceiling passes before the crash: the reopened wait's bound is a full ceiling from the reopen.
    world.advance(CEILING / 2);
    await session.harness.close(context);
    session = await world.open();
  }
  return { world, session, taskId, seen: records.seen };
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

describe("VT-1: a heartbeat whose input is stuck behind a failed run", () => {
  it("VT-1 the bound withdraws it, then its next occurrence runs with the queued input", async () => {
    const { world, session, taskId, seen } = await behindFailure({
      recurring: true,
      reopen: "none",
    });

    await passBound(world);
    const sleep = await expectHeartbeatWithdrawn(world, session, taskId);
    // The withdrawn occurrence never reached the model.
    expect(wakeInputs(seen)).toEqual([]);

    // Occurrence 1 fires one ceiling on, with the "second" input still queued: both settle done.
    world.advance(sleep.until - world.clock.now());
    session.harness.resume();
    await vi.waitFor(async () => {
      expect(await occurrenceOf(session.harness, taskId)).toBe(2);
    }, WAIT);

    const fired = await submissionOf(session.harness, session.root.id, wakeRequestId(taskId, 1));
    expect(fired?.status).toBe("done");
    const second = await submissionOf(session.harness, session.root.id, SECOND);
    expect(second?.status).toBe("done");

    // Exactly one wake input was ever put before the model, and it is occurrence 1's.
    const text = only(wakeInputs(seen));
    expect(text).toContain(`fired_at="${new Date(sleep.until).toISOString()}"`);
    const entry = only(await wakeEntries(session.root));
    expect(dataOf(entry)["n"]).toBe(1);
  });

  it("VT-1 the same withdrawal holds across a close and reopen while stuck", async () => {
    const { world, session, taskId, seen } = await behindFailure({
      recurring: true,
      reopen: "same",
    });

    await passBound(world);
    const sleep = await expectHeartbeatWithdrawn(world, session, taskId);
    expect(wakeInputs(seen)).toEqual([]);

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

describe("VT-2: a one-shot whose input is stuck behind a failed run", () => {
  it("VT-2 the bound withdraws it and the wake fails", async () => {
    const { world, session, taskId, seen } = await behindFailure({
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
    const { world, session, taskId, seen } = await behindFailure({
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

describe("VT-3: the abort handler owns the input", () => {
  it("VT-3a abort withdraws a queued input, and neither the failed run nor time revives it", async () => {
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

    // The foreground run failing afterwards starts no wake turn, notifies nobody, and fails no wake.
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

  it("VT-3b abort withdraws an input admitted before a crash", async () => {
    const { world, session, taskId } = await behindFailure({
      recurring: false,
      reopen: "disabled",
    });

    // Back from the crash with the switch off: the submit phase defers, prepared, keeping the admission.
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
    const { world, session, taskId } = await behindFailure({
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
    const { world, session, taskId } = await behindFailure({
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
});
