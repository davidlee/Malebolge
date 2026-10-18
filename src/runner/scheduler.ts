// The scheduler (design §5.4 "Scheduling", DEC-056): one job in flight across
// every repo, FIFO by `created_at` then `id`. `submit` wakes it; there is no
// tick. A job in any in-flight state holds the seat, `waiting_room` and
// `pending_collection` included (one room; the uncollected job branch is still
// in it). With `enabled = false` it schedules nothing and runs no step that
// asks the harness for progress (I14).
//
// A held `pending_collection` job is retried from the drain itself, with
// backoff, until it leaves that state (collected, or abandoned at
// `max_pending_collection` by collect.ts) — not only when the next submit
// wakes the scheduler. `stop` ends the drain, cutting a pause short.
//
// The scheduler owns only the seat and the queue; a job's life is `run`'s.
// Cancels of the seated job go to its run, which owns every write to it; any
// other job is cancelled through the store. Picking a job and routing a cancel
// take turns, so a cancel never falls between "picked" and "seated".

import { roomRetryDelay, type Sleep } from "./backoff.ts";
import type { CancelJob } from "./control.ts";
import { RunnerError } from "./errors.ts";
import type { Job, JobStore } from "./store.ts";
import type { JobState } from "./vocab.ts";

/** States that hold the seat. */
export const IN_FLIGHT: readonly JobState[] = [
  "preparing",
  "running",
  "waiting_room",
  "collecting",
  "pending_collection",
];

/** The job to run next: the oldest queued one, unless the seat is held or the runner disabled. */
export function nextJob<J extends Pick<Job, "state">>(
  inFlight: J | undefined,
  queued: J | undefined,
  enabled: boolean,
): J | undefined {
  return enabled && inFlight === undefined ? queued : undefined;
}

/**
 * The seated job's cancel, between the scheduler and the run. The run checks
 * `cancelReason` (or `signal`) at each step, records the cancel itself, and
 * reports it with `cancelled`; `ended` refuses a cancel it never recorded.
 */
export class RunControl {
  readonly #stop = new AbortController();
  #reason: string | undefined;
  #answer: PromiseWithResolvers<Job> | undefined;

  /** Aborted once a cancel is asked. */
  get signal(): AbortSignal {
    return this.#stop.signal;
  }

  get cancelReason(): string | undefined {
    return this.#reason;
  }

  /** Asks the run to cancel; settles when it records the cancel, or ends without it. */
  cancel(reason: string): Promise<Job> {
    if (this.#answer === undefined) {
      this.#reason = reason;
      this.#answer = Promise.withResolvers<Job>();
      this.#stop.abort();
    }
    return this.#answer.promise;
  }

  /** The run recorded the cancel: `job` as written. */
  cancelled(job: Job): void {
    this.#answer?.resolve(job);
  }

  /** The run ended at `job`; a cancel it did not record is refused (a no-op once answered). */
  ended(job: Job): void {
    this.#answer?.reject(
      new RunnerError("invalid_transition", `a ${job.state} job cannot be cancelled`),
    );
  }

  /** The run failed unexpectedly; the cancel fails with it. */
  failed(error: unknown): void {
    this.#answer?.reject(error);
  }
}

/** Drives a queued job to a resting state; returns the job as it left it. */
export type RunJob = (job: Job, control: RunControl) => Promise<Job>;

export interface SchedulerDeps {
  /** The instance the control server observes (notes PHASE-05: observers are per instance). */
  jobs: JobStore;
  enabled: boolean;
  run: RunJob;
  /**
   * One collection retry of a `pending_collection` job (collect.ts): it owns
   * the `max_pending_collection` bound, so the scheduler only paces retries.
   */
  retryPending: (job: Job) => Promise<Job>;
  /** The pause between `pending_collection` retries; `stop` cuts it short. */
  sleep: Sleep;
  /** Once aborted: no new pick or retry, and a backoff pause ends; a seated run is left to finish. */
  stop: AbortSignal;
  log: (text: string) => void;
  now: () => number;
}

export interface Scheduler {
  /** A job was queued: drain unless draining. A no-op when disabled. */
  wake: () => void;
  /** `ControlDeps.cancel`: the seated job through its run, any other through the store. */
  cancel: CancelJob;
  /** Resolves once the scheduler rests. */
  idle: () => Promise<void>;
}

interface Seat {
  jobId: string;
  control: RunControl;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs each task after every earlier one has settled, whatever its outcome. */
function turns(): <T>(task: () => Promise<T>) => Promise<T> {
  let turn: Promise<unknown> = Promise.resolve();
  return function inTurn<T>(task: () => Promise<T>): Promise<T> {
    const result = turn.then(task);
    turn = result.catch(() => undefined);
    return result;
  };
}

/**
 * Retries of the held `pending_collection` job, paced with backoff while it
 * stays (a pause `stop` cuts short); the count restarts per job. Each answers
 * whether to take another step.
 */
function pendingRetries(
  deps: Pick<SchedulerDeps, "retryPending" | "sleep" | "stop">,
): (held: Job) => Promise<boolean> {
  let backoff: { jobId: string; attempts: number } | undefined;
  return async function retryHeld(held: Job): Promise<boolean> {
    if ((await deps.retryPending(held)).state !== "pending_collection") {
      backoff = undefined;
      return true;
    }
    const attempts = backoff?.jobId === held.id ? backoff.attempts : 0;
    backoff = { jobId: held.id, attempts: attempts + 1 };
    await deps.sleep(roomRetryDelay(attempts), deps.stop);
    return true;
  };
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { jobs } = deps;
  let seat: Seat | undefined;
  let dirty = false;
  let draining: Promise<void> | undefined;
  const inTurn = turns();
  const retryHeld = pendingRetries(deps);

  /** The job holding the seat, and the job seated to run next, if any. */
  const pick = (): Promise<{ held?: Job; seated?: Seat & { job: Job } }> =>
    inTurn(async () => {
      const [held] = await jobs.list({ states: [...IN_FLIGHT], limit: 1 });
      const [queued] = await jobs.list({ states: ["queued"], limit: 1 });
      const next = nextJob(held, queued, deps.enabled);
      if (next === undefined) {
        return held === undefined ? {} : { held };
      }
      seat = { jobId: next.id, control: new RunControl() };
      return { seated: { ...seat, job: next } };
    });

  async function runSeated({ job, control }: Seat & { job: Job }): Promise<void> {
    try {
      control.ended(await deps.run(job, control));
    } catch (error) {
      control.failed(error);
      throw error;
    } finally {
      seat = undefined;
    }
  }

  /**
   * One step; whether to take another. A held `pending_collection` job is
   * retried; any other held state rests the drain (PHASE-10 acts on it).
   */
  async function step(): Promise<boolean> {
    if (deps.stop.aborted) {
      return false;
    }
    const { held, seated } = await pick();
    if (seated !== undefined) {
      await runSeated(seated);
      return true;
    }
    return held?.state === "pending_collection" ? retryHeld(held) : false;
  }

  /** Reads and clears the wake flag. */
  function takeDirty(): boolean {
    const was = dirty;
    dirty = false;
    return was;
  }

  async function drain(): Promise<void> {
    try {
      while (takeDirty()) {
        while (await step()) {
          // Each step rests one job; the next pick sees what it left.
        }
      }
    } catch (error) {
      deps.log(`scheduler: stopped draining: ${messageOf(error)}`);
    } finally {
      // Synchronous with the last `dirty` check: a wake after it starts a new drain.
      draining = undefined;
    }
  }

  function wake(): void {
    if (!deps.enabled || deps.stop.aborted) {
      return;
    }
    dirty = true;
    draining ??= drain();
  }

  async function cancel(jobId: string, reason: string, now: number): Promise<Job> {
    // The run's answer travels boxed, so the turn does not wait for the run.
    const routed = await inTurn(async () =>
      seat?.jobId === jobId
        ? { asked: seat.control.cancel(reason) }
        : { stored: await jobs.cancel(jobId, now, { reason }) },
    );
    return "asked" in routed ? routed.asked : routed.stored;
  }

  return {
    wake,
    cancel,
    idle: () => draining ?? Promise.resolve(),
  };
}
