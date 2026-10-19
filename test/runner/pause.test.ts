// Room down: pause (EX-1, EX-4, EX-5; VT-1 pause half, VT-2). A lost
// connection is recognised by type at the job's `Connection` (`info`,
// `session`, `request`); `pause_requested` and one `pause` event are durable
// before the failure is rethrown, idempotent across the two lost failures one
// stop raises (EVD-010); the same text without the type does not pause.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type Harness,
  MemoryStorage,
  type Submission,
} from "@earendil-works/pi-durable";
import { HostKeyChangedError, HostKeyUnknownError, RemoteError } from "@earendil-works/pi-env";
import { describe, expect, it, onTestFinished } from "vitest";
import { context } from "../../src/context.ts";
import type { JsonRecord } from "../../src/json.ts";
import { collectJob, retryPendingCollection } from "../../src/runner/collect.ts";
import { ObservedConnection } from "../../src/room/connection.ts";
import { configEntry } from "../../src/runner/policy.ts";
import { PAUSED_RESULT_TEXT } from "../../src/runner/guard.ts";
import {
  type AwaitRoomDeps,
  awaitRoom,
  pausingObserver,
  RESUME_TEXT,
  resumeRequestId,
  submitResume,
} from "../../src/runner/pause.ts";
import { ChannelFailed, type GitChannel } from "../../src/runner/room.ts";
import type { RunDeps } from "../../src/runner/run.ts";
import type { Job, JobEvent, JobStore } from "../../src/runner/store.ts";
import { WARNING_TEXT, warningOwed } from "../../src/runner/warning.ts";
import { openFauxHarness, textOf } from "../harness-fixture.ts";
import {
  FailingConnection,
  type FailWhen,
  LOST_TEXT,
  lostError,
} from "../room/connection-fixture.ts";
import { exampleConfig } from "./config-fixture.ts";
import {
  answer,
  type ArmedTimer,
  call,
  eventOf,
  jobToolResults,
  kinds,
  lostBash,
  ROOM_DOWN,
  roomGoesDown,
  roomRebuilt,
  roomUntrusted,
  type RunWorld,
  runWorld,
  SETTLE_MS,
  settled,
  until,
  userTexts,
  warned,
  warningEvents,
  writeAndCommit,
} from "./run-fixture.ts";
import { ROOM, roomKindCollectWorld } from "./room-fixture.ts";
import { closeHarness, within } from "./runner-fixture.ts";
import { NEW_JOB, openTestStore, T0 } from "./store-fixture.ts";

/** A `running` job and its connection, observed by the pausing observer; `failWhen` picks the failures. */
async function runningConnection(failWhen: FailWhen): Promise<{
  jobs: JobStore;
  job: Job;
  connection: ObservedConnection;
}> {
  const { jobs } = await openTestStore();
  const { job: queued } = await jobs.submit(NEW_JOB, T0);
  await jobs.transition(queued.id, "preparing", T0 + 1);
  const job = await jobs.transition(queued.id, "running", T0 + 2);
  let clock = T0 + 10;
  const connection = new ObservedConnection(
    new FailingConnection(failWhen),
    pausingObserver({ jobs, now: () => ++clock }, job.id, () => {
      throw new Error("no trust failure here");
    }),
  );
  return { jobs, job, connection };
}

const pauseEvents = async (jobs: JobStore, id: string): Promise<unknown[]> =>
  (await jobs.events(id)).filter((event) => event.kind === "pause").map((event) => event.payload);

describe("the pausing observer: a lost Connection marks the job (VT-2, EX-5)", () => {
  const calls: [string, (connection: ObservedConnection) => Promise<unknown>][] = [
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

/** The room's reachability probe as the test answers it; every other verb is the slot's. */
interface Probe {
  answer: () => boolean | Promise<boolean>;
}

const probed =
  (probe: Probe) =>
  (channel: GitChannel): GitChannel => ({
    ...channel,
    reachable: async () => probe.answer(),
  });

/** What the run had done when the room was first probed: the provider's calls, the waiting row. */
interface AtProbe {
  callCount: number;
  waiting: Job | undefined;
}

/** Makes `probe` answer reachable, noting first what the run had done (`AtProbe`). */
function noteAtProbe(probe: Probe, w: RunWorld): AtProbe[] {
  const seen: AtProbe[] = [];
  probe.answer = async (): Promise<boolean> => {
    const [waiting] = await w.jobs.list({ states: ["waiting_room"] });
    seen.push({ callCount: w.faux.state.callCount, waiting });
    return true;
  };
  return seen;
}

describe("the run: a lost room mid-bash pauses the job (VT-1, EX-1)", () => {
  it("pause_requested and its event, the result replaced, aborted before another model request, waiting_room", async () => {
    const probe: Probe = { answer: () => true };
    const w = await runWorld({ connection: roomGoesDown(), channel: probed(probe) });
    const atProbe = noteAtProbe(probe, w);
    w.faux.setResponses([lostBash(), answer("resumed")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    // STOP-1: no provider request between the pause trigger and the abort.
    expect(atProbe[0]).toMatchObject({
      callCount: 1,
      waiting: { pauseRequested: false, pauseCount: 1 },
    });
    expect(atProbe[0]?.waiting).not.toHaveProperty("endReason");
    const events = await w.events(job.id);
    const pausedAt = kinds(events).indexOf("pause");
    expect(kinds(events).slice(pausedAt, pausedAt + 2)).toEqual([
      "pause",
      "transition:waiting_room",
    ]);
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
    // The deadline and soft timers armed at running were stopped by the pause.
    const paused = w.timers.armed.slice(0, 2);
    expect(paused).toHaveLength(2);
    expect(paused.every((timer) => timer.cancelled)).toBe(true);
  });

  it("a model request racing the abort is refused by the gate (STOP-1): no provider call, no count, no ceiling", async () => {
    const probe: Probe = { answer: () => true };
    const w = await runWorld({
      connection: roomGoesDown(),
      harness: abortHeldUntilSettled,
      channel: probed(probe),
    });
    const atProbe = noteAtProbe(probe, w);
    w.faux.setResponses([lostBash(), answer("resumed")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(atProbe[0]?.callCount).toBe(1);
    expect(atProbe[0]?.waiting).toMatchObject({ modelRequests: 1, pauseCount: 1 });
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

// --- the waiting episode, the resume, the segment loop (batch B: EX-2, EX-3; VT-1 resume half) ---

/** The `running` transitions' payloads, oldest first. */
const runningPayloads = (events: readonly JobEvent[]): JsonRecord[] =>
  events.filter((event) => kinds([event])[0] === "transition:running").map((e) => e.payload);

/** Whether job `id` is waiting for its room. */
const waiting = async (w: RunWorld, id: string): Promise<boolean> =>
  (await w.job(id)).state === "waiting_room";

describe("awaitRoom: the waiting episode's probe (EX-3)", () => {
  const deps = (
    answers: boolean[],
    start: number,
  ): { slept: number[]; probed: string[]; deps: AwaitRoomDeps } => {
    let clock = start;
    const slept: number[] = [];
    const probed: string[] = [];
    return {
      slept,
      probed,
      deps: {
        channel: {
          reachable: (repo, jobId): Promise<boolean> => {
            probed.push(`${repo.name} ${jobId}`);
            return Promise.resolve(answers.shift() ?? false);
          },
        },
        config: exampleConfig(),
        now: (): number => clock,
        sleep: (ms: number): Promise<void> => {
          slept.push(ms);
          clock += ms;
          return Promise.resolve();
        },
      },
    };
  };
  const BOUND_MS = exampleConfig().maxima.maxRoomWaitS * 1000;
  const REPO = configEntry(exampleConfig().repos, "repo", "satan");
  const JOB = { id: "pj-1", stateEnteredAt: 0 };

  it("probes the job's room with backoff until it is reachable", async () => {
    const { deps: d, slept, probed } = deps([false, false, false, true], 0);

    expect(await awaitRoom(d, REPO, JOB, new AbortController().signal)).toBe("reachable");
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(probed).toEqual(Array(4).fill("satan pj-1"));
  });

  it("is bounded by max_room_wait from state_entered_at, not from when it starts", async () => {
    const { deps: d, slept } = deps([], BOUND_MS - 500);

    expect(await awaitRoom(d, REPO, JOB, new AbortController().signal)).toBe("timed_out");
    expect(slept).toEqual([500]);
  });

  it("a cancel ends it: cancelled, no further probe", async () => {
    const { deps: d } = deps([], 0);
    const stop = new AbortController();
    stop.abort();

    expect(await awaitRoom(d, REPO, JOB, stop.signal)).toBe("cancelled");
  });
});

describe("a probe ChannelFailed ends the job, never parked (VT-3, EX-4)", () => {
  const trustFailure = (): ChannelFailed =>
    new ChannelFailed(`capsule ${ROOM} collect satan job/pj-1 exited 1: host key changed`);

  it("in waiting_room: end_reason = error, then collecting, then failed class error", async () => {
    const w = await runWorld({
      connection: roomGoesDown(),
      channel: probed({ answer: () => Promise.reject(trustFailure()) }),
    });
    w.faux.setResponses([writeAndCommit(), lostBash(), answer("never")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({ state: "failed", endReason: "error", class: "error" });
    const events = await w.events(job.id);
    const transitions = kinds(events).filter((kind) => kind.startsWith("transition:"));
    expect(transitions.slice(transitions.indexOf("transition:waiting_room"))).toEqual([
      "transition:waiting_room",
      "transition:collecting",
      "transition:failed",
    ]);
    expect(eventOf(events, "transition:collecting")?.payload).toMatchObject({
      from: "waiting_room",
      reason: "channel_failed",
      message: trustFailure().message,
    });
    // No resume: the provider saw the two calls before the pause, nothing after.
    expect(w.faux.state.callCount).toBe(2);
  });

  it("in pending_collection: failed class error, the channel's reason in its failure", async () => {
    const world = await roomKindCollectWorld();
    world.guestJob(world.jobId, "src/a.ts");
    world.capsule.up = false;
    expect(await collectJob(world.deps, world.jobId, T0 + 10)).toMatchObject({
      state: "pending_collection",
    });
    world.capsule.up = true;
    world.capsule.exit = 1;

    expect(await retryPendingCollection(world.deps, world.jobId, T0 + 20)).toMatchObject({
      state: "failed",
      class: "error",
      failure: { reason: "collection_failed", channel: "channel_failed" },
    });
    const transitions = (await world.events())
      .filter((event) => event.kind === "transition")
      .map((event) => event.payload["to"]);
    expect(transitions.slice(-2)).toEqual(["pending_collection", "failed"]);
  });
});

describe("submitResume: the resume message (EX-2)", () => {
  async function resumeWorld(): Promise<{
    jobs: JobStore;
    job: Job;
    conversation: Conversation;
    drafts: unknown[];
  }> {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);
    const { harness, root, faux } = await openFauxHarness(new MemoryStorage());
    onTestFinished(() => closeHarness(harness));
    faux.setResponses([answer(), answer()]);
    const drafts: unknown[] = [];
    const conversation = new Proxy(root, {
      get(target, key): unknown {
        if (key === "submit") {
          return (...args: Parameters<Conversation["submit"]>): Promise<Submission> => {
            drafts.push(args[0]);
            return target.submit(...args);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    return { jobs, job, conversation, drafts };
  }

  it("requestId resume-<job id>-<pause_count>: stable, a second submit returns the same submission", async () => {
    const { jobs, job, conversation, drafts } = await resumeWorld();
    const d = { conversation, jobs, jobId: job.id, now: (): number => T0 };

    const first = await submitResume(d, { pauseCount: 2, withWarning: false });
    const second = await submitResume(d, { pauseCount: 2, withWarning: false });

    expect(resumeRequestId(job.id, 2)).toBe(`resume-${job.id}-2`);
    expect(second.id).toBe(first.id);
    expect(drafts[0]).toEqual({
      type: "input",
      content: RESUME_TEXT,
      requestId: `resume-${job.id}-2`,
    });
    expect(warningEvents(await jobs.events(job.id))).toEqual([]);
  });

  it("carrying the warning: its text after the resume sentence, receipted as a warning (trigger resume)", async () => {
    const { jobs, job, conversation, drafts } = await resumeWorld();

    const submission = await submitResume(
      { conversation, jobs, jobId: job.id, now: () => T0 },
      { pauseCount: 1, withWarning: true },
    );

    expect(drafts[0]).toMatchObject({ content: `${RESUME_TEXT}\n\n${WARNING_TEXT}` });
    expect(warningEvents(await jobs.events(job.id)).map((event) => event.payload)).toEqual([
      { requestId: `resume-${job.id}-1`, submissionId: String(submission.id), trigger: "resume" },
    ]);
  });

  it("resubmitted after a crash before running: the same submission, receipted once", async () => {
    const { jobs, job, conversation } = await resumeWorld();
    const d = { conversation, jobs, jobId: job.id, now: (): number => T0 };

    const first = await submitResume(d, { pauseCount: 1, withWarning: true });
    const again = await submitResume(d, { pauseCount: 1, withWarning: true });

    expect(again.id).toBe(first.id);
    expect(warningEvents(await jobs.events(job.id))).toHaveLength(1);
  });

  it.each([
    [false, undefined, false],
    [true, undefined, true],
    [true, { placed: false }, true],
    [true, { placed: true }, false],
    [false, { placed: false }, false],
  ])("warningOwed(thresholdPassed %s, receipt %o) is %s", (thresholdPassed, receipt, owed) => {
    expect(warningOwed(thresholdPassed, receipt)).toBe(owed);
  });
});

describe("the run: the room returns, the job resumes (VT-1 resume half, EX-2)", () => {
  it("resume-<id>-1 admitted, then running; the paused segment's aborted settlement is no end reason", async () => {
    const users: string[][] = [];
    const probe: Probe = { answer: () => true };
    const w = await runWorld({ connection: roomGoesDown(), channel: probed(probe) });
    const atProbe = noteAtProbe(probe, w);
    w.faux.setResponses([
      lostBash(),
      (request): AssistantMessage => {
        users.push(userTexts(request.messages));
        return writeAndCommit();
      },
      answer("resumed"),
    ]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    // STOP-1: no provider request between the pause and the probe.
    expect(atProbe.map((seen) => seen.callCount)).toEqual([1]);
    expect(job).toMatchObject({
      state: "needs_review",
      endReason: "completed",
      class: "complete",
      pauseCount: 1,
      pauseRequested: false,
    });
    const events = await w.events(job.id);
    expect(kinds(events).filter((kind) => kind.startsWith("transition:"))).toEqual([
      "transition:preparing",
      "transition:running",
      "transition:waiting_room",
      "transition:running",
      "transition:collecting",
      "transition:needs_review",
    ]);
    expect(eventOf(events, "transition:waiting_room")?.payload).toMatchObject({
      submission: "unanswered",
      submissionReason: "aborted",
    });
    const [, resumed] = runningPayloads(events);
    expect(resumed).toMatchObject({ from: "waiting_room", requestId: `resume-${job.id}-1` });
    expect(users[0]?.at(-1)).toBe(RESUME_TEXT);
    expect(warningEvents(events)).toEqual([]);
  });

  it("a request the gate declined while pausing (model_error) is no end reason either", async () => {
    const w = await runWorld({ connection: roomGoesDown(), harness: abortHeldUntilSettled });
    w.faux.setResponses([lostBash(), writeAndCommit(), answer("resumed")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({ state: "needs_review", endReason: "completed", pauseCount: 1 });
    expect(eventOf(await w.events(job.id), "transition:waiting_room")?.payload).toMatchObject({
      submission: "unanswered",
    });
  });

  it("a second pause: pause_count 2, resumed with resume-<id>-2", async () => {
    const w = await runWorld({ connection: roomGoesDown() });
    w.faux.setResponses([lostBash(), lostBash(), writeAndCommit(), answer("resumed")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({ state: "needs_review", endReason: "completed", pauseCount: 2 });
    expect(runningPayloads(await w.events(job.id)).map((payload) => payload["requestId"])).toEqual([
      job.id,
      `resume-${job.id}-1`,
      `resume-${job.id}-2`,
    ]);
    expect(w.faux.state.callCount).toBe(4);
  });

  it("waiting is not active time: the resumed deadline is re-armed with what is left", async () => {
    let probes = 0;
    const w = await runWorld({
      connection: roomGoesDown(),
      channel: probed({ answer: () => ++probes > 3 }),
    });
    w.faux.setResponses([lostBash(), writeAndCommit(), answer("resumed")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    const waitedMs = w.slept.reduce((sum, ms) => sum + ms, 0);
    expect(waitedMs).toBe(7000);
    expect(job.activeMs).toBeLessThan(1000);
    // Segment one armed the deadline and the soft timer; the resume re-armed both.
    expect(w.timers.armed).toHaveLength(4);
    const deadlineOf = (timers: ArmedTimer[]): number => Math.max(...timers.map((t) => t.ms));
    const first = deadlineOf(w.timers.armed.slice(0, 2));
    const resumed = deadlineOf(w.timers.armed.slice(2));
    expect(resumed).toBeLessThan(first);
    expect(resumed).toBeGreaterThan(first - 1000);
  });

  it.each([
    [
      "the deadline",
      (w: RunWorld): Promise<unknown> => {
        w.timers.fire("longest");
        return Promise.resolve();
      },
      { state: "needs_review", endReason: "ceiling_exceeded", class: "partial" },
    ],
    [
      "a cancel",
      (w: RunWorld, id: string): Promise<unknown> => w.scheduler.cancel(id, "stop", T0),
      { state: "cancelled", endReason: "cancelled" },
    ],
  ])("%s in the resumed segment ends the job as in any run", async (_stop, stop, ending) => {
    const w = await runWorld({ connection: roomGoesDown() });
    w.faux.setResponses([lostBash(), writeAndCommit(), call("wait", {}), answer("never")]);
    const held = w.blocking.started();

    const queued = await w.submit();
    await within(SETTLE_MS, "wait", held);
    await within(SETTLE_MS, "stop", stop(w, queued.id));
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({ ...ending, pauseCount: 1 });
    expect(w.verbs()).toContain("collect");
  });
});

describe("the run: the warning across a pause (EX-2, AS-2, AS-3)", () => {
  it("due and withdrawn by the pause: the resume message carries it, receipted once (trigger resume)", async () => {
    const w = await runWorld({ connection: roomGoesDown() });
    const users: string[][] = [];
    w.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("wait", {}, { id: "held" }),
          fauxToolCall("bash", { command: `echo ${ROOM_DOWN}` }, { id: "lost" }),
        ],
        { stopReason: "toolUse" },
      ),
      writeAndCommit(),
      (request): AssistantMessage => {
        users.push(userTexts(request.messages));
        return answer("resumed");
      },
    ]);
    const held = w.blocking.started();

    const queued = await w.submit();
    await within(SETTLE_MS, "wait", held);
    w.timers.fire("shortest");
    await warned(w, queued.id);
    w.blocking.release();
    const job = await settled(w, queued.id);

    const receipts = warningEvents(await w.events(job.id)).map((event) => event.payload);
    expect(receipts).toMatchObject([
      { requestId: `warn-${job.id}`, trigger: "wall_clock" },
      { requestId: `resume-${job.id}-1`, trigger: "resume" },
    ]);
    // Given once to the model: in the resume message, never as the withdrawn steer.
    expect(users[0]?.filter((text) => text.includes(WARNING_TEXT))).toEqual([
      `${RESUME_TEXT}\n\n${WARNING_TEXT}`,
    ]);
    expect(job).toMatchObject({ state: "needs_review", endReason: "completed" });
  });

  it("carried by a resume message that was placed: a second pause's resume does not repeat it", async () => {
    const w = await runWorld({ connection: roomGoesDown() });
    const users: string[][] = [];
    w.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("wait", {}, { id: "held" }),
          fauxToolCall("bash", { command: `echo ${ROOM_DOWN}` }, { id: "lost" }),
        ],
        { stopReason: "toolUse" },
      ),
      lostBash(),
      writeAndCommit(),
      (request): AssistantMessage => {
        users.push(userTexts(request.messages));
        return answer("resumed");
      },
    ]);
    const held = w.blocking.started();

    const queued = await w.submit();
    await within(SETTLE_MS, "wait", held);
    w.timers.fire("shortest");
    await warned(w, queued.id);
    w.blocking.release();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({ pauseCount: 2, endReason: "completed" });
    expect(warningEvents(await w.events(job.id))).toHaveLength(2);
    expect(users[0]?.filter((text) => text.startsWith(RESUME_TEXT))).toEqual([
      `${RESUME_TEXT}\n\n${WARNING_TEXT}`,
      RESUME_TEXT,
    ]);
  });

  it("placed before the pause: the resume message does not repeat it; the resumed segment gives none", async () => {
    const w = await runWorld({ connection: roomGoesDown() });
    const users: string[][] = [];
    w.faux.setResponses([
      call("wait", {}),
      lostBash(),
      writeAndCommit(),
      call("wait", {}),
      (request): AssistantMessage => {
        users.push(userTexts(request.messages));
        return answer("resumed");
      },
    ]);
    let held = w.blocking.started();

    const queued = await w.submit();
    await within(SETTLE_MS, "first wait", held);
    w.timers.fire("shortest");
    await warned(w, queued.id);
    held = w.blocking.started();
    w.blocking.release();
    await within(SETTLE_MS, "resumed wait", held);
    // The resumed segment's soft timer: due again, but a warning is on record.
    w.timers.fire("shortest");
    w.blocking.release();
    const job = await settled(w, queued.id);

    expect(warningEvents(await w.events(job.id))).toHaveLength(1);
    expect(users[0]?.filter((text) => text.includes(WARNING_TEXT))).toEqual([WARNING_TEXT]);
    expect(users[0]).toContain(RESUME_TEXT);
  });
});

describe("the run: the room does not return (EX-3)", () => {
  it("max_room_wait passes: pending_collection, room_unavailable; collected once the room is back", async () => {
    const probe: Probe = { answer: () => true };
    const w = await runWorld({ connection: roomGoesDown(), channel: probed(probe) });
    // Down for as long as any job waits for it.
    probe.answer = async (): Promise<boolean> =>
      (await w.jobs.list({ states: ["waiting_room"] })).length === 0;
    w.faux.setResponses([writeAndCommit(), lostBash(), answer("never")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    expect(job).toMatchObject({
      state: "needs_review",
      endReason: "room_unavailable",
      class: "partial",
      pauseCount: 1,
    });
    const events = await w.events(job.id);
    expect(
      kinds(events)
        .filter((kind) => kind.startsWith("transition:"))
        .slice(2),
    ).toEqual([
      "transition:waiting_room",
      "transition:pending_collection",
      "transition:collecting",
      "transition:needs_review",
    ]);
    expect(eventOf(events, "transition:pending_collection")?.payload).toMatchObject({
      reason: "room_unavailable",
    });
    expect(w.slept.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(w.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      w.deps.config.maxima.maxRoomWaitS * 1000,
    );
    expect(w.faux.state.callCount).toBe(2);
  });

  it("a cancel while waiting: pending_collection, cancelled; collected when the room returns, then cancelled", async () => {
    const probing = Promise.withResolvers<undefined>();
    const down = Promise.withResolvers<boolean>();
    const probe: Probe = {
      answer: (): Promise<boolean> => {
        probing.resolve(undefined);
        return down.promise;
      },
    };
    const w = await runWorld({ connection: roomGoesDown(), channel: probed(probe) });
    w.faux.setResponses([writeAndCommit(), lostBash(), answer("never")]);

    const queued = await w.submit();
    await within(SETTLE_MS, "probe", probing.promise);
    expect(await waiting(w, queued.id)).toBe(true);
    const cancel = w.scheduler.cancel(queued.id, "stop", T0);
    probe.answer = (): boolean => true;
    down.resolve(false);
    const answered = await within(SETTLE_MS, "cancel", cancel);
    const job = await settled(w, queued.id);

    expect(answered).toMatchObject({ state: "pending_collection", endReason: "cancelled" });
    expect(job).toMatchObject({ state: "cancelled", endReason: "cancelled", pauseCount: 1 });
    expect(runningPayloads(await w.events(job.id))).toHaveLength(1);
    expect(w.verbs()).toContain("collect");
  });
});

// --- a trust failure is no pause (PHASE-15 batch B: EX-5; VT-6) ---------------------

const TRUST_FAILURES = [
  ["HostKeyChangedError", (): Error => new HostKeyChangedError("the host key changed")],
  ["HostKeyUnknownError", (): Error => new HostKeyUnknownError("the host key is not trusted")],
] as const;

describe("the run: a trust failure is no pause (VT-6, EX-5)", () => {
  it.each(TRUST_FAILURES)(
    "running, the room's restart failing %s: aborted, end_reason error (host_key), collected; never waiting_room",
    async (_name, failure) => {
      const probe: Probe = { answer: () => true };
      const w = await runWorld({ connection: roomRebuilt(failure), channel: probed(probe) });
      w.faux.setResponses([writeAndCommit(), lostBash(), answer("never")]);

      const queued = await w.submit();
      const job = await settled(w, queued.id);

      // Collected and classified (I12): an `error` end is class error, `failed`.
      expect(job).toMatchObject({
        state: "failed",
        class: "error",
        endReason: "error",
        pauseRequested: false,
        pauseCount: 0,
      });
      const events = await w.events(job.id);
      expect(kinds(events)).toContain("collected");
      expect(kinds(events)).not.toContain("pause");
      expect(kinds(events)).not.toContain("transition:waiting_room");
      expect(kinds(events)).not.toContain("ceiling");
      expect(eventOf(events, "transition:collecting")?.payload).toMatchObject({
        from: "running",
        reason: "host_key",
      });
      expect(w.verbs()).toContain("collect");
    },
  );

  it.each(TRUST_FAILURES)(
    "preparing, the first start failing %s: failed, reason host_key, never retried",
    async (_name, failure) => {
      const w = await runWorld({ connection: roomUntrusted(failure) });
      w.faux.setResponses([answer("never")]);

      const queued = await w.submit();
      const job = await settled(w, queued.id);

      expect(job).toMatchObject({ state: "failed", endReason: "error", pauseRequested: false });
      const events = await w.events(job.id);
      expect(eventOf(events, "transition:failed")?.payload).toMatchObject({ reason: "host_key" });
      expect(kinds(events)).not.toContain("pause");
      expect(w.slept).toEqual([]);
      expect(w.faux.state.callCount).toBe(0);
    },
  );

  it("a plain failure of the same restart is a lost room: the job pauses (waiting_room)", async () => {
    const probe: Probe = { answer: () => true };
    const w = await runWorld({
      connection: roomRebuilt(() => new Error("no route to the room")),
      channel: probed(probe),
    });
    w.faux.setResponses([lostBash(), answer("resumed")]);

    const queued = await w.submit();
    const job = await settled(w, queued.id);

    const events = await w.events(job.id);
    expect(kinds(events)).toContain("pause");
    expect(kinds(events)).toContain("transition:waiting_room");
    expect(job.pauseCount).toBe(1);
  });
});
