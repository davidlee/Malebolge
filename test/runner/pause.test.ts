// Room down: pause (EX-1, EX-4, EX-5; VT-1 pause half, VT-2). A lost
// connection is recognised by type at the job's `Connection` (`info`,
// `session`, `request`); `pause_requested` and one `pause` event are durable
// before the failure is rethrown, idempotent across the two lost failures one
// stop raises (EVD-010); the same text without the type does not pause.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Harness, Submission } from "@earendil-works/pi-durable";
import { type Connection, RemoteError } from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { JobConnection } from "../../src/runner/env.ts";
import { PAUSED_RESULT_TEXT } from "../../src/runner/guard.ts";
import { pausingObserver } from "../../src/runner/pause.ts";
import type { RunDeps } from "../../src/runner/run.ts";
import type { Job, JobStore } from "../../src/runner/store.ts";
import { textOf } from "../harness-fixture.ts";
import { FailingConnection, type FailWhen, LOST_TEXT, lostError } from "./env-fixture.ts";
import {
  answer,
  call,
  eventOf,
  jobToolResults,
  kinds,
  type RunWorld,
  runWorld,
  SETTLE_MS,
  settled,
  until,
} from "./run-fixture.ts";
import { within } from "./runner-fixture.ts";
import { NEW_JOB, openTestStore, T0 } from "./store-fixture.ts";

/** A `running` job and its connection, observed by the pausing observer; `failWhen` picks the failures. */
async function runningConnection(failWhen: FailWhen): Promise<{
  jobs: JobStore;
  job: Job;
  connection: JobConnection;
}> {
  const { jobs } = await openTestStore();
  const { job: queued } = await jobs.submit(NEW_JOB, T0);
  await jobs.transition(queued.id, "preparing", T0 + 1);
  const job = await jobs.transition(queued.id, "running", T0 + 2);
  let clock = T0 + 10;
  const connection = new JobConnection(
    new FailingConnection(failWhen),
    pausingObserver({ jobs, now: () => ++clock }, job.id),
  );
  return { jobs, job, connection };
}

const pauseEvents = async (jobs: JobStore, id: string): Promise<unknown[]> =>
  (await jobs.events(id)).filter((event) => event.kind === "pause").map((event) => event.payload);

describe("the pausing observer: a lost Connection marks the job (VT-2, EX-5)", () => {
  const calls: [string, (connection: JobConnection) => Promise<unknown>][] = [
    ["info", (connection): Promise<unknown> => connection.info()],
    ["session", (connection): Promise<unknown> => connection.session()],
    ["exec", (connection): Promise<unknown> => connection.request("exec", { command: "true" })],
  ];

  it.each(calls)(
    "lost from %s: pause_requested and one pause event, durable before the rethrow",
    async (op, use) => {
      const world = await runningConnection((call) => (call.op === op ? lostError() : undefined));

      const rethrown = await use(world.connection).then(
        () => undefined,
        async (error: unknown) => ({ error, row: await world.jobs.get(world.job.id) }),
      );

      expect(rethrown?.error).toBeInstanceOf(RemoteError);
      expect(rethrown?.row?.pauseRequested).toBe(true);
      expect(await pauseEvents(world.jobs, world.job.id)).toEqual([
        { op, name: "RemoteError", code: "unknown", lost: true },
      ]);
    },
  );

  it("is idempotent: one stop's two concurrent lost failures make one mark and one event", async () => {
    const codes = ["unknown", "spawn_error"];
    let next = 0;
    const world = await runningConnection(({ op }) =>
      op === "exec" ? lostError(codes[next++]) : undefined,
    );

    const settled = await Promise.allSettled([
      world.connection.request("exec", { command: "a" }),
      world.connection.request("exec", { command: "b" }),
    ]);

    expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect((await world.jobs.get(world.job.id))?.pauseRequested).toBe(true);
    expect(await pauseEvents(world.jobs, world.job.id)).toEqual([
      { op: "exec", name: "RemoteError", code: "unknown", lost: true },
    ]);
  });

  it.each([
    ["an ordinary Error", new Error(LOST_TEXT)],
    ["a RemoteError without lost", new RemoteError({ code: "unknown", message: LOST_TEXT })],
  ])("%s with the same text does not pause (EX-4)", async (_name, failure) => {
    const world = await runningConnection(({ op }) => (op === "exec" ? failure : undefined));

    await expect(world.connection.request("exec", { command: "true" })).rejects.toBe(failure);

    expect((await world.jobs.get(world.job.id))?.pauseRequested).toBe(false);
    expect(await pauseEvents(world.jobs, world.job.id)).toEqual([]);
  });
});

// --- the run: lost mid-bash → waiting_room (VT-1 pause half, EX-1, EX-4) ----------

/** In a bash command, the marker that makes the room's daemon connection lost. */
const ROOM_DOWN = "ROOM-DOWN";

/** The local daemon, except an exec carrying `ROOM_DOWN` fails as `failure` (default: lost). */
const roomGoesDown =
  (failure: () => Error = lostError) =>
  (local: Connection): Connection =>
    new FailingConnection(
      ({ op, json }) =>
        op === "exec" && JSON.stringify(json).includes(ROOM_DOWN) ? failure() : undefined,
      local,
    );

/**
 * The run's harness, its conversations' `abort` held until the run's first
 * submission settles on its own: the widest race between the pause trigger
 * and the abort (STOP-1). Without the gate's pause refusal, the next model
 * request reaches the provider.
 */
function abortHeldUntilSettled(harness: Harness): RunDeps["harness"] {
  const held = (conversation: Conversation): Conversation => {
    let first: Promise<unknown> | undefined;
    return new Proxy(conversation, {
      get(target, key): unknown {
        if (key === "submit") {
          return async (...args: Parameters<Conversation["submit"]>): Promise<Submission> => {
            const submission = await target.submit(...args);
            first ??= submission.wait(context);
            return submission;
          };
        }
        if (key === "abort") {
          return async (...args: Parameters<Conversation["abort"]>): Promise<void> => {
            await first;
            await target.abort(...args);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
  };
  return {
    commit: harness.commit.bind(harness),
    conversation: async (...args): Promise<Conversation | undefined> => {
      const opened = await harness.conversation(...args);
      return opened === undefined ? undefined : held(opened);
    },
  };
}

describe("the run: a lost room mid-bash pauses the job (VT-1, EX-1)", () => {
  it("pause_requested and its event, the result replaced, aborted before another model request, waiting_room", async () => {
    const w = await runWorld({ connection: roomGoesDown() });
    w.faux.setResponses([call("bash", { command: `echo ${ROOM_DOWN}` }), answer("never")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    // STOP-1: no provider request between the pause trigger and the abort.
    expect(w.faux.state.callCount).toBe(1);
    expect(job).toMatchObject({ state: "waiting_room", pauseRequested: false, pauseCount: 1 });
    expect(job.endReason).toBeUndefined();
    const events = await w.events(job.id);
    expect(kinds(events).slice(-2)).toEqual(["pause", "transition:waiting_room"]);
    expect(eventOf(events, "pause")?.payload).toEqual({
      op: "exec",
      name: "RemoteError",
      code: "unknown",
      lost: true,
    });
    expect(eventOf(events, "transition:waiting_room")?.payload).toMatchObject({
      from: "running",
      submission: "unanswered",
      submissionReason: "aborted",
    });
    // A pause is not an exhaustion: no ceiling event, the run not ended as one.
    expect(kinds(events)).not.toContain("ceiling");
    const [result] = await jobToolResults(w, job);
    expect(result === undefined ? "" : textOf(result)).toBe(PAUSED_RESULT_TEXT);
    expect(result?.isError).toBe(true);
    // The deadline and soft timers armed at running are stopped.
    expect(w.timers.armed.length).toBeGreaterThan(0);
    expect(w.timers.armed.every((timer) => timer.cancelled)).toBe(true);
    // Batch A ends here: nothing collected; the job holds the seat.
    expect(w.verbs()).not.toContain("collect");
  });

  it("a model request racing the abort is refused by the gate (STOP-1): no provider call, no count, no ceiling", async () => {
    const w = await runWorld({ connection: roomGoesDown(), harness: abortHeldUntilSettled });
    w.faux.setResponses([call("bash", { command: `echo ${ROOM_DOWN}` }), answer("never")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(w.faux.state.callCount).toBe(1);
    expect(job).toMatchObject({ state: "waiting_room", modelRequests: 1, pauseCount: 1 });
    expect(job.endReason).toBeUndefined();
    expect(kinds(await w.events(job.id))).not.toContain("ceiling");
  });

  it.each([
    [
      "a cancel",
      async (w: RunWorld, id: string): Promise<unknown> => w.scheduler.cancel(id, "stop", T0),
      "cancelled",
    ],
    [
      "a ceiling",
      (w: RunWorld): Promise<unknown> => {
        w.timers.fire("longest");
        return Promise.resolve();
      },
      "ceiling_exceeded",
    ],
  ])(
    "%s wins over a pending pause: collecting, the leftover mark inert",
    async (_stop, stop, endReason) => {
      const w = await runWorld({ connection: roomGoesDown() });
      // One round: the room goes down under bash while `wait` holds the round open.
      w.faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("bash", { command: `echo ${ROOM_DOWN}` }, { id: "lost" }),
            fauxToolCall("wait", {}, { id: "held" }),
          ],
          { stopReason: "toolUse" },
        ),
        answer("never"),
      ]);
      const started = w.blocking.started();
      const queued = await w.submit();
      await within(SETTLE_MS, "wait", started);
      await until("pause mark", async () => (await w.job(queued.id)).pauseRequested);

      await within(SETTLE_MS, "stop", stop(w, queued.id));
      const job = await settled(w, queued.id);

      expect(job).toMatchObject({ endReason, pauseCount: 0, pauseRequested: true });
      const events = await w.events(job.id);
      expect(kinds(events)).toContain("transition:collecting");
      expect(kinds(events)).not.toContain("transition:waiting_room");
      expect(w.verbs()).toContain("collect");
    },
  );

  it("the same text as an ordinary failure does not pause: the model sees it and the run goes on (EX-4)", async () => {
    const w = await runWorld({ connection: roomGoesDown(() => new Error(LOST_TEXT)) });
    w.faux.setResponses([call("bash", { command: `echo ${ROOM_DOWN}` }), answer("carried on")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(w.faux.state.callCount).toBe(2);
    expect(job).toMatchObject({ pauseRequested: false, pauseCount: 0 });
    expect(job.state).not.toBe("waiting_room");
    expect(kinds(await w.events(job.id))).not.toContain("pause");
    const [result] = await jobToolResults(w, job);
    expect(result === undefined ? "" : textOf(result)).toContain(LOST_TEXT);
  });
});
