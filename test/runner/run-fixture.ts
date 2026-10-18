// The run path for harness-level tests (run.test.ts, ceilings-harness.test.ts):
// pi-durable driven by the faux provider, the runner store and pi sharing one
// SQLite handle (EVD-008), the job's tools and guard running through a local
// pi-env daemon in the room's clone, the fake slot's channel refreshing and
// collecting that clone, and the real scheduler seating each job.

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Harness, JsonObject } from "@earendil-works/pi-durable";
import type { Connection } from "@earendil-works/pi-env";
import { onTestFinished } from "vitest";
import { retryPendingCollection } from "../../src/runner/collect.ts";
import type { Ceilings, RunnerConfig } from "../../src/runner/config.ts";
import { harnessConversations, jobConversation } from "../../src/runner/conversations.ts";
import { gitQuarantineReader } from "../../src/runner/git.ts";
import { jobGuard } from "../../src/runner/guard.ts";
import {
  createModelGate,
  type GateDeps,
  gatedModels,
  harnessUsage,
} from "../../src/runner/model-gate.ts";
import type { GitChannel } from "../../src/runner/room.ts";
import type { Timer } from "../../src/runner/deadline.ts";
import { type RunDeps, runJob } from "../../src/runner/run.ts";
import { createScheduler, type Scheduler } from "../../src/runner/scheduler.ts";
import { openRunnerStore, type Job, type JobEvent, type JobStore } from "../../src/runner/store.ts";
import { roomTenancy } from "../../src/runner/tenancy.ts";
import { JobTools } from "../../src/runner/tools.ts";
import { openFauxHarness, toolResults } from "../harness-fixture.ts";
import { exampleConfig } from "./config-fixture.ts";
import { localConnection } from "./env-fixture.ts";
import { type RoomWorld, roomWorld } from "./room-fixture.ts";
import { blockingTool, type BlockingTool, closeHarness, within } from "./runner-fixture.ts";
import { NEW_JOB, sequentialIds, T0 } from "./store-fixture.ts";

export const SETTLE_MS = 20_000;

/** Commits whatever the agent changed, in the clone, with git's config isolated. */
export const COMMIT =
  "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; git add -A && " +
  "git -c user.name=Agent -c user.email=agent@example.invalid -c commit.gpgsign=false " +
  "commit --quiet --no-verify -m change";

let calls = 0;
export const call = (tool: string, args: JsonObject): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(tool, args, { id: `call-${String(++calls)}` })], {
    stopReason: "toolUse",
  });
export const answer = (text = "done"): AssistantMessage => fauxAssistantMessage([fauxText(text)]);

/** One `setTimeout` a `ManualTimer` holds. */
export interface ArmedTimer {
  ms: number;
  fire: () => void;
  cancelled: boolean;
}

/** A `Timer` that never fires on its own: the test fires what it armed. */
export interface ManualTimer {
  timer: Timer;
  /** Everything armed, oldest first. */
  armed: ArmedTimer[];
  /** Fires the live timer with the longest delay (the deadline), or the shortest (the soft timer). */
  fire: (which: "longest" | "shortest") => void;
}

export function manualTimer(): ManualTimer {
  const armed: ArmedTimer[] = [];
  const timer: Timer = (ms, fire) => {
    const entry: ArmedTimer = { ms, fire, cancelled: false };
    armed.push(entry);
    return {
      cancel: (): void => {
        entry.cancelled = true;
      },
    };
  };
  function fire(which: "longest" | "shortest"): void {
    const live = armed.filter((entry) => !entry.cancelled).sort((a, b) => a.ms - b.ms);
    const entry = which === "longest" ? live.at(-1) : live[0];
    if (entry === undefined) {
      throw new Error("no live timer");
    }
    entry.cancelled = true;
    entry.fire();
  }
  return { timer, armed, fire };
}

export interface RunWorldOptions {
  /** The room's `max_room_wait`, seconds. */
  maxRoomWaitS?: number;
  channel?: (channel: GitChannel) => GitChannel;
  /** The harness `runJob` sees. */
  harness?: (harness: Harness) => RunDeps["harness"];
  /** Submit ceilings of each job `submit` queues, over `NEW_JOB`'s. */
  ceilings?: Partial<Ceilings>;
  /** How the model gate reads usage; default: the harness's `pi.usage`. */
  usageOf?: GateDeps["usageOf"];
  /** The job's daemon connection, given the local one; e.g. one that loses chosen calls. */
  connection?: (local: Connection) => Connection;
}

export interface RunWorld extends RoomWorld {
  jobs: JobStore;
  harness: Harness;
  deps: RunDeps;
  scheduler: Scheduler;
  blocking: BlockingTool;
  /** The model: scripted turns, and `state.callCount` its provider requests. */
  faux: FauxProviderHandle;
  /** The run's ceiling timers (deadline, soft threshold), fired by hand. */
  timers: ManualTimer;
  /** Queues a job (as submit does) and wakes the scheduler. */
  submit: () => Promise<Job>;
  job: (id: string) => Promise<Job>;
  events: (id: string) => Promise<JobEvent[]>;
  /** The slot verbs the channel ran, e.g. `collect`. */
  verbs: () => string[];
}

/**
 * The run path over `roomWorld({ guestAtClone: true })`: a local daemon runs
 * the job's tools in the room's clone, which the fake slot refreshes and
 * collects.
 */
export async function runWorld(options: RunWorldOptions = {}): Promise<RunWorld> {
  const world = roomWorld({ guestAtClone: true });
  const store = await openRunnerStore(":memory:", { newId: sequentialIds() });
  const { jobs } = store;
  let clock = T0;
  const now = (): number => ++clock;
  const tenancy = roomTenancy();
  const timers = manualTimer();
  const blocking = blockingTool("wait");
  const extensions = [
    JobTools,
    jobGuard({ currentJob: tenancy.guarded, jobs, now }),
    blocking.extension,
  ];
  // The model gate as start.ts wires it: built before the harness it sits in.
  const usage = harnessUsage();
  const gate = createModelGate({
    seated: tenancy.seated,
    jobs,
    now,
    usageOf: options.usageOf ?? usage.usageOf,
  });
  const { harness, faux } = await openFauxHarness(store.storage, {
    extensions,
    env: tenancy.env,
    models: (models) => gatedModels(models, gate),
  });
  usage.bind(harness);
  onTestFinished(() => closeHarness(harness));
  const example = exampleConfig();
  const config: RunnerConfig = {
    ...example,
    defaults: { ...example.defaults, model: "faux/faux-1" },
    maxima: { ...example.maxima, maxRoomWaitS: options.maxRoomWaitS ?? 60 },
    repos: new Map([[NEW_JOB.repo, world.repo]]),
  };
  const deps: RunDeps = {
    jobs,
    channel: options.channel?.(world.channel) ?? world.channel,
    quarantine: gitQuarantineReader,
    config,
    harness: options.harness?.(harness) ?? harness,
    conversations: harnessConversations(harness),
    tenancy,
    connect: () => {
      const local = localConnection();
      return options.connection?.(local) ?? local;
    },
    extensions,
    readPrompt: () => Promise.resolve("You are the patch agent."),
    now,
    timer: timers.timer,
    log: (text) => {
      throw new Error(`unexpected runner log: ${text}`);
    },
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  };
  const scheduler = createScheduler({
    jobs,
    enabled: true,
    run: (job, control) => runJob(deps, job, control),
    retryPending: (job) => retryPendingCollection(deps, job.id, now()),
    sleep: deps.sleep,
    stop: new AbortController().signal,
    log: () => undefined,
    now,
  });
  let submissions = 0;
  async function submit(): Promise<Job> {
    const { job: queued } = await jobs.submit(
      {
        ...NEW_JOB,
        submissionId: `sub-${String(++submissions)}`,
        ceilings: { ...NEW_JOB.ceilings, ...options.ceilings },
      },
      now(),
    );
    scheduler.wake();
    return queued;
  }
  const job = async (id: string): Promise<Job> => {
    const found = await jobs.get(id);
    if (found === undefined) {
      throw new Error(`no job ${id}`);
    }
    return found;
  };
  return {
    ...world,
    jobs,
    harness,
    deps,
    scheduler,
    blocking,
    faux,
    timers,
    submit,
    job,
    events: (id) => jobs.events(id),
    verbs: () => world.slot.calls.map((args) => args[1] ?? ""),
  };
}

/** Waits for the scheduler to rest; the job as the run left it. */
export async function settled(world: RunWorld, id: string): Promise<Job> {
  await within(SETTLE_MS, "scheduler", world.scheduler.idle());
  return world.job(id);
}

/** Resolves once `holds` does, polled; fails after `SETTLE_MS`. */
export async function until(what: string, holds: () => boolean | Promise<boolean>): Promise<void> {
  const poll = async (): Promise<void> => {
    while (!(await holds())) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  await within(SETTLE_MS, what, poll());
}

/** Each event as `kind` or `transition:<to>`. */
export const kinds = (events: readonly JobEvent[]): string[] =>
  events.map((event) =>
    event.kind === "transition" ? `transition:${String(event.payload["to"])}` : event.kind,
  );

/** The tool results of `job`'s conversation, oldest first. */
export async function jobToolResults(world: RunWorld, job: Job): Promise<ToolResultMessage[]> {
  const conversation = await jobConversation(world.harness, job.conversationId ?? "");
  return conversation === undefined ? [] : toolResults(world.harness, conversation);
}

export const eventOf = (events: readonly JobEvent[], kind: string): JobEvent | undefined =>
  events.find((event) => kinds([event])[0] === kind);
