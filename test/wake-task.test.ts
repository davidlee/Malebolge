// VT-1 to VT-3 of `satan.wake` v1, end to end: the fire and submit phases driven
// through a harness over a store that outlives a close, a stopped clock, and
// scripted satan-mcp answers (SL-034 design § The wake task, § Fire composition;
// PHASE-01 VT-1, VT-2 (W1), VT-3).

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";

import { localIso } from "../src/wake/local-time.ts";
import { SATAN_CALL_DEADLINE_MS } from "../src/task-support.ts";
import { wakeRequestId } from "../src/wake/task.ts";
import { createConversation, FAUX_MODEL } from "./harness-fixture.ts";
import {
  HOUR,
  FLOOR,
  CEILING,
  WAIT,
  local,
  START,
  TYPING,
  IDLE,
  PERCEPT,
  FRAGMENT,
  wakeWorld,
  wakeInput,
  createWake,
  waitSleeping,
  waitSettled,
  waitTerminal,
  firedResult,
  submissionOf,
  wakeEntries,
  dataOf,
  only,
  wakeInputs,
  wakeUserMessages,
  expectScheduled,
  recording,
  holdFirstTurn,
  waitPlaced,
  heldGate,
} from "./wake-fixture.ts";

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
      wakeInput(session.root.id, {
        at: START,
        intent: "keep the room",
        recurring: true,
      }),
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
    // The journal names the defer in local time with its offset, not UTC.
    expect(
      world.lines.some((line) => line.endsWith(`defer presence until ${localIso(deferred.until)}`)),
    ).toBe(true);
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
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "spend cap reached",
      });
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
