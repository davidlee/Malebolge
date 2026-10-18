// The scheduler (EX-1, DEC-056): one job in flight across every repo, FIFO by
// created_at then id, woken by submit with no tick; a job in waiting_room or
// pending_collection holds the seat; enabled = false schedules nothing. Runs
// are faked here; run.test.ts drives the real one.

import { describe, expect, it, onTestFinished } from "vitest";
import { context } from "../../src/context.ts";
import type { JobIdFactory } from "../../src/runner/ids.ts";
import {
  createScheduler,
  IN_FLIGHT,
  nextJob,
  type RunJob,
  type Scheduler,
  type SchedulerDeps,
} from "../../src/runner/scheduler.ts";
import { roomRetryDelay, type Sleep } from "../../src/runner/backoff.ts";
import { type Job, type JobStore, openRunnerStore } from "../../src/runner/store.ts";
import type { JobState } from "../../src/runner/vocab.ts";
import { rejectionCode } from "./refusal-fixture.ts";
import { within } from "./runner-fixture.ts";
import { NEW_JOB, sequentialIds, T0 } from "./store-fixture.ts";

/** Moves job `id` through `states`, at T0. */
async function walk(jobs: JobStore, id: string, states: readonly JobState[]): Promise<void> {
  for (const state of states) {
    await jobs.transition(id, state, T0);
  }
}

/** Takes the job out of the queue and fails it: a rest state. */
async function failJob(jobs: JobStore, id: string): Promise<Job> {
  await jobs.transition(id, "preparing", T0);
  return jobs.transition(id, "failed", T0, {}, { failure: { reason: "test" } });
}

/** The default faked run: fail the job. */
function failRun(jobs: JobStore, job: Job): Promise<Job> {
  return failJob(jobs, job.id);
}

/** A test's hold on the runs: each waits for `release` before it ends. */
interface Gate {
  release: () => void;
  /** Resolves when `count` runs have started. */
  started: (count: number) => Promise<void>;
}

interface World {
  jobs: JobStore;
  scheduler: Scheduler;
  /** Job ids in the order their runs started. */
  ran: string[];
  /** Job ids in the order their rejoins started. */
  rejoined: string[];
  /** Most runs in flight at once. */
  maxInFlight: () => number;
  retried: string[];
  /** Backoff pauses asked, in ms. */
  slept: number[];
  logs: string[];
  /** Aborts the scheduler's `stop` signal. */
  stop: () => void;
  gate: Gate;
  /** Queues a job created at `at` (default T0) for `repo`; does not wake. */
  queue: (submissionId: string, at?: number, repo?: string) => Promise<Job>;
}

interface WorldOptions {
  enabled?: boolean;
  /** What a run does once released; default: fail the job. */
  run?: (jobs: JobStore, job: Job, control: Parameters<RunJob>[1]) => Promise<Job>;
  /** Hold every run at the gate until released. */
  gated?: boolean;
  retryPending?: (jobs: JobStore, job: Job) => Promise<Job>;
  /** What a rejoin does; default: nothing (the job stays held). */
  rejoin?: (jobs: JobStore, job: Job, control: Parameters<RunJob>[1]) => Promise<Job>;
  /** The scheduler's backoff pause, after `slept` records it; default: none. */
  sleep?: Sleep;
  newId?: JobIdFactory;
}

async function world(options: WorldOptions = {}): Promise<World> {
  const store = await openRunnerStore(":memory:", { newId: options.newId ?? sequentialIds() });
  onTestFinished(() => store.storage.close(context));
  const { jobs } = store;
  const ran: string[] = [];
  const rejoined: string[] = [];
  const retried: string[] = [];
  const slept: number[] = [];
  const logs: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let open = !(options.gated ?? false);
  const waiting: (() => void)[] = [];
  const startWaiters: (() => void)[] = [];
  const gate: Gate = {
    release: () => {
      open = true;
      for (const wake of waiting.splice(0)) {
        wake();
      }
    },
    started: (count) =>
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (ran.length >= count) {
            resolve();
          } else {
            startWaiters.push(check);
          }
        };
        check();
      }),
  };
  const run: RunJob = async (job, control) => {
    ran.push(job.id);
    for (const wake of startWaiters.splice(0)) {
      wake();
    }
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      if (!open) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return await (options.run ?? failRun)(jobs, job, control);
    } finally {
      inFlight--;
    }
  };
  const stop = new AbortController();
  const deps: SchedulerDeps = {
    jobs,
    enabled: options.enabled ?? true,
    run,
    rejoin: async (job, control) => {
      rejoined.push(job.id);
      return options.rejoin === undefined ? job : options.rejoin(jobs, job, control);
    },
    retryPending: async (job) => {
      retried.push(job.id);
      return options.retryPending === undefined ? job : options.retryPending(jobs, job);
    },
    sleep: (ms, signal) => {
      slept.push(ms);
      return options.sleep === undefined ? Promise.resolve() : options.sleep(ms, signal);
    },
    stop: stop.signal,
    log: (text) => logs.push(text),
    now: () => T0 + 1,
  };
  const queue = async (submissionId: string, at = T0, repo = NEW_JOB.repo): Promise<Job> =>
    (await jobs.submit({ ...NEW_JOB, submissionId, repo }, at)).job;
  return {
    jobs,
    scheduler: createScheduler(deps),
    ran,
    rejoined,
    maxInFlight: () => maxInFlight,
    retried,
    slept,
    logs,
    stop: (): void => {
      stop.abort();
    },
    gate,
    queue,
  };
}

/** Wakes the scheduler and waits until it rests. */
async function drain(w: World): Promise<void> {
  w.scheduler.wake();
  await within(5000, "drain", w.scheduler.idle());
}

describe("nextJob", () => {
  const job = (state: JobState): Pick<Job, "state"> => ({ state });

  it("is the first queued job when nothing holds the seat and the runner is enabled", () => {
    const queued = job("queued");
    expect(nextJob(undefined, queued, true)).toBe(queued);
  });

  it.each(IN_FLIGHT)("is none while a %s job holds the seat", (state) => {
    expect(nextJob(job(state), job("queued"), true)).toBeUndefined();
  });

  it("is none when disabled or nothing is queued", () => {
    expect(nextJob(undefined, job("queued"), false)).toBeUndefined();
    expect(nextJob(undefined, undefined, true)).toBeUndefined();
  });

  it("counts waiting_room and pending_collection as holding the seat (one room)", () => {
    expect(IN_FLIGHT).toEqual(expect.arrayContaining(["waiting_room", "pending_collection"]));
  });
});

describe("the scheduler", () => {
  it("runs jobs of every repo one at a time, oldest created first", async () => {
    const w = await world();
    await w.queue("late", T0 + 2, "satan");
    await w.queue("early", T0, "other");
    await w.queue("middle", T0 + 1, "satan");

    await drain(w);

    expect(w.ran).toEqual(["pj-2", "pj-3", "pj-1"]);
    expect(w.maxInFlight()).toBe(1);
  });

  it("orders jobs created in the same millisecond by id", async () => {
    const ids = ["pj-b", "pj-a"];
    const w = await world({ newId: () => ids.shift() ?? "pj-z" });
    await w.queue("first", T0);
    await w.queue("second", T0);

    await drain(w);

    expect(w.ran).toEqual(["pj-a", "pj-b"]);
  });

  it("does nothing until woken: there is no tick", async () => {
    const w = await world();
    await w.queue("s1");

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(w.ran).toEqual([]);
  });

  it("takes a job queued during a run after that run, from the same drain", async () => {
    const w = await world({ gated: true });
    await w.queue("s1");
    w.scheduler.wake();
    await within(5000, "first run", w.gate.started(1));

    await w.queue("s2");
    w.scheduler.wake();
    expect(w.ran).toEqual(["pj-1"]);
    w.gate.release();
    await within(5000, "drain", w.scheduler.idle());

    expect(w.ran).toEqual(["pj-1", "pj-2"]);
    expect(w.maxInFlight()).toBe(1);
  });

  it("schedules nothing while a waiting_room job holds the seat", async () => {
    const w = await world();
    const parked = await w.queue("parked");
    await walk(w.jobs, parked.id, ["preparing", "running", "waiting_room"]);
    await w.queue("next");

    await drain(w);

    expect(w.ran).toEqual([]);
    expect((await w.jobs.get("pj-2"))?.state).toBe("queued");
  });

  it.each(["preparing", "running", "collecting"] as const)(
    "leaves a %s job a previous process left alone, and holds the seat for it",
    async (state) => {
      const w = await world();
      const left = await w.queue("left");
      const path: JobState[] = ["preparing", "running", "collecting"];
      await walk(w.jobs, left.id, path.slice(0, path.indexOf(state) + 1));
      await w.queue("next");

      await drain(w);

      expect(w.ran).toEqual([]);
      expect((await w.jobs.get(left.id))?.state).toBe(state);
    },
  );

  it("retries a pending_collection job with backoff and no further wake, then runs the queue", async () => {
    let retries = 0;
    const w = await world({
      retryPending: (jobs, job) =>
        ++retries < 3
          ? Promise.resolve(job)
          : jobs.transition(job.id, "failed", T0, {}, { failure: { reason: "test" } }),
    });
    const pending = await w.queue("pending");
    await walk(w.jobs, pending.id, ["preparing", "running", "collecting", "pending_collection"]);
    const next = await w.queue("next");

    await drain(w);

    expect(w.retried).toEqual([pending.id, pending.id, pending.id]);
    expect(w.slept).toEqual([roomRetryDelay(0), roomRetryDelay(1)]);
    expect(w.ran).toEqual([next.id]);
  });

  it("stop ends a drain sleeping between pending_collection retries; later wakes do nothing", async () => {
    const asleep = Promise.withResolvers<undefined>();
    const w = await world({
      sleep: async (_ms, signal) => {
        asleep.resolve(undefined);
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve);
        });
      },
    });
    const pending = await w.queue("pending");
    await walk(w.jobs, pending.id, ["preparing", "running", "collecting", "pending_collection"]);
    await w.queue("next");
    w.scheduler.wake();
    await within(5000, "asleep", asleep.promise);

    w.stop();
    await within(5000, "stopped", w.scheduler.idle());
    await drain(w);

    expect(w.retried).toEqual([pending.id]);
    expect(w.ran).toEqual([]);
  });

  it("with enabled = false schedules nothing and retries nothing (I14)", async () => {
    const w = await world({ enabled: false });
    await w.queue("s1");
    const pending = await w.queue("pending");
    await walk(w.jobs, pending.id, ["preparing", "running", "collecting", "pending_collection"]);

    await drain(w);

    expect(w.ran).toEqual([]);
    expect(w.retried).toEqual([]);
  });

  it("stops draining on a run's unexpected failure, logs it, and tries again on the next wake", async () => {
    let failures = 1;
    const w = await world({
      run: (jobs, job) => {
        if (failures-- > 0) {
          return Promise.reject(new Error("host broke"));
        }
        return failJob(jobs, job.id);
      },
    });
    await w.queue("s1");

    await drain(w);
    expect(w.logs.join("\n")).toContain("host broke");
    expect((await w.jobs.get("pj-1"))?.state).toBe("queued");

    await drain(w);
    expect((await w.jobs.get("pj-1"))?.state).toBe("failed");
  });
});

describe("the seat (EX-8): held from preparing until terminal", () => {
  const COLLECTING_PATH: readonly JobState[] = ["preparing", "running", "collecting"];

  it("a collecting job a previous process left holds the seat: queued B waits until A is terminal", async () => {
    const w = await world();
    const a = await w.queue("a");
    await walk(w.jobs, a.id, COLLECTING_PATH);
    const b = await w.queue("b");

    await drain(w);
    expect(w.ran).toEqual([]);
    expect((await w.jobs.get(b.id))?.state).toBe("queued");

    await w.jobs.transition(a.id, "needs_review", T0, {}, {});
    await drain(w);
    expect(w.ran).toEqual([b.id]);
  });

  it("a pending_collection job holds the seat between retries: queued B waits until A is terminal", async () => {
    const asleep = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const w = await world({
      sleep: async () => {
        asleep.resolve(undefined);
        await resume.promise;
      },
    });
    const a = await w.queue("a");
    await walk(w.jobs, a.id, [...COLLECTING_PATH, "pending_collection"]);
    const b = await w.queue("b");

    w.scheduler.wake();
    await within(5000, "backing off", asleep.promise);
    expect(w.ran).toEqual([]);
    expect((await w.jobs.get(b.id))?.state).toBe("queued");

    await w.jobs.transition(a.id, "failed", T0, {}, { failure: { reason: "test" } });
    resume.resolve(undefined);
    await within(5000, "drain", w.scheduler.idle());
    expect(w.ran).toEqual([b.id]);
  });

  it("a live run holds the seat inside its collecting step: B starts only after A's run returns", async () => {
    const inCollecting = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<undefined>();
    const w = await world({
      run: async (jobs, job) => {
        if (job.submissionId === "a") {
          await walk(jobs, job.id, COLLECTING_PATH);
          inCollecting.resolve(undefined);
          await finish.promise;
          return jobs.transition(job.id, "needs_review", T0, {}, {});
        }
        return failJob(jobs, job.id);
      },
    });
    const a = await w.queue("a");
    w.scheduler.wake();
    await within(5000, "A collecting", inCollecting.promise);

    const b = await w.queue("b");
    w.scheduler.wake();
    expect((await w.jobs.get(a.id))?.state).toBe("collecting");
    expect(w.ran).toEqual([a.id]);

    finish.resolve(undefined);
    await within(5000, "drain", w.scheduler.idle());
    expect(w.ran).toEqual([a.id, b.id]);
    expect(w.maxInFlight()).toBe(1);
  });
});

describe("cancel", () => {
  it("cancels a job not in flight through the store", async () => {
    const w = await world();
    const job = await w.queue("s1");

    const cancelled = await w.scheduler.cancel(job.id, "not needed", T0 + 1);

    expect(cancelled.state).toBe("cancelled");
    expect(w.ran).toEqual([]);
  });

  it("asks the job in flight's run, and answers once the run records it", async () => {
    const w = await world({
      gated: true,
      run: async (jobs, job, control) => {
        await jobs.transition(job.id, "preparing", T0);
        const reason = control.cancelReason;
        if (reason === undefined) {
          return jobs.transition(job.id, "failed", T0, {}, {});
        }
        const cancelled = await jobs.cancel(job.id, T0, { reason });
        control.cancelled(cancelled);
        return cancelled;
      },
    });
    await w.queue("s1");
    w.scheduler.wake();
    await within(5000, "run", w.gate.started(1));

    const answer = w.scheduler.cancel("pj-1", "stop", T0 + 1);
    w.gate.release();

    expect((await within(5000, "cancel", answer)).state).toBe("cancelled");
    await within(5000, "drain", w.scheduler.idle());
    expect(await rejectionCode(w.scheduler.cancel("pj-1", "again", T0 + 2))).toBe(
      "invalid_transition",
    );
  });

  it("refuses a cancel the run ended without recording", async () => {
    const w = await world({ gated: true });
    await w.queue("s1");
    w.scheduler.wake();
    await within(5000, "run", w.gate.started(1));

    const answer = w.scheduler.cancel("pj-1", "stop", T0 + 1);
    w.gate.release();

    expect(await rejectionCode(answer)).toBe("invalid_transition");
  });
});

describe("rejoin (PHASE-10): a held job a restart left is seated once and rejoined", () => {
  const RUNNING_PATH: readonly JobState[] = ["preparing", "running"];

  it("is rejoined, not run; once it rests, the queue goes on", async () => {
    const w = await world({
      rejoin: (jobs, job) =>
        jobs.transition(job.id, "collecting", T0, {}, { endReason: "completed" }),
    });
    const a = await w.queue("a");
    await walk(w.jobs, a.id, RUNNING_PATH);
    const b = await w.queue("b");

    await drain(w);

    // Rejoined from running to collecting; collecting is still held, and was rejoined once.
    expect(w.rejoined).toEqual([a.id]);
    expect(w.ran).toEqual([]);
    expect(w.logs).toEqual([`scheduler: job ${a.id} still collecting after its rejoin; resting`]);
    await w.jobs.transition(a.id, "needs_review", T0, {}, {});
    await drain(w);
    expect(w.ran).toEqual([b.id]);
    expect(w.rejoined).toEqual([a.id]);
  });

  it("a held job whose rejoin failed is not rejoined again: the drain rests (no hot loop)", async () => {
    const w = await world({ rejoin: () => Promise.reject(new Error("rejoin failed")) });
    const a = await w.queue("a");
    await walk(w.jobs, a.id, RUNNING_PATH);

    await drain(w);
    await drain(w);

    expect(w.rejoined).toEqual([a.id]);
    expect(w.logs).toEqual([
      "scheduler: stopped draining: rejoin failed",
      `scheduler: job ${a.id} still running after its rejoin; resting`,
    ]);
  });

  it("a held pending_collection job is retried, never rejoined", async () => {
    const w = await world({
      retryPending: (jobs, job) => jobs.transition(job.id, "failed", T0, {}, {}),
    });
    const a = await w.queue("a");
    await walk(w.jobs, a.id, [...RUNNING_PATH, "collecting", "pending_collection"]);

    await drain(w);

    expect(w.rejoined).toEqual([]);
    expect(w.retried).toEqual([a.id]);
  });

  it("disabled: nothing is rejoined (I14)", async () => {
    const w = await world({ enabled: false });
    const a = await w.queue("a");
    await walk(w.jobs, a.id, RUNNING_PATH);

    await drain(w);

    expect(w.rejoined).toEqual([]);
    expect(w.logs).toEqual([]);
  });

  it("a cancel of the rejoined job goes to its rejoin, which records it", async () => {
    const started = Promise.withResolvers<undefined>();
    const asked: string[] = [];
    const w = await world({
      rejoin: async (jobs, job, control) => {
        started.resolve(undefined);
        await new Promise((resolve) => {
          control.signal.addEventListener("abort", resolve);
        });
        asked.push(control.cancelReason ?? "");
        const cancelled = await jobs.cancel(job.id, T0, { reason: control.cancelReason ?? "" });
        control.cancelled(cancelled);
        return cancelled;
      },
    });
    const a = await w.queue("a");
    await walk(w.jobs, a.id, RUNNING_PATH);
    w.scheduler.wake();
    await within(5000, "rejoin", started.promise);

    const answer = await within(5000, "cancel", w.scheduler.cancel(a.id, "stop", T0 + 1));

    expect(asked).toEqual(["stop"]);
    expect(answer.endReason).toBe("cancelled");
    await within(5000, "drain", w.scheduler.idle());
  });
});
