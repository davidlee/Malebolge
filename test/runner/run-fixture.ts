// The run path for harness-level tests (run.test.ts, ceilings-harness.test.ts):
// pi-durable driven by the faux provider, the runner store and pi sharing one
// SQLite handle (EVD-008), the job's tools and guard running through a local
// pi-env daemon in the room's clone, the fake slot's channel refreshing and
// collecting that clone, and the real scheduler seating each job.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Harness, JsonObject } from "@earendil-works/pi-durable";
import type { Connection } from "@earendil-works/pi-env";
import { onTestFinished } from "vitest";
import { retryPendingCollection } from "../../src/runner/collect.ts";
import type { Ceilings, RunnerConfig } from "../../src/runner/config.ts";
import { harnessConversations, jobConversation } from "../../src/runner/conversations.ts";
import { gitQuarantineReader } from "../../src/runner/git.ts";
import { DaemonConnection } from "../../src/room/connection.ts";
import { jobGuard } from "../../src/runner/guard.ts";
import type { JsonRecord } from "../../src/json.ts";
import {
  catalogLimits,
  createModelGate,
  type GateDeps,
  gatedModels,
  harnessUsage,
} from "../../src/runner/model-gate.ts";
import { type RecoverDeps, recoverHost } from "../../src/runner/recover.ts";
import type { GitChannel } from "../../src/runner/room.ts";
import type { Timer } from "../../src/runner/deadline.ts";
import { type RejoinDeps, rejoinJob } from "../../src/runner/rejoin.ts";
import { type RunDeps, runJob } from "../../src/runner/run.ts";
import { createScheduler, type Scheduler } from "../../src/runner/scheduler.ts";
import {
  type Decide,
  type Job,
  type JobEvent,
  JobStore,
  openRunnerStore,
  type RunnerStore,
} from "../../src/runner/store.ts";
import type { EventKind } from "../../src/runner/vocab.ts";
import { roomTenancy } from "../../src/runner/tenancy.ts";
import { JobTools } from "../../src/runner/tools.ts";
import { openFauxHarness, toolResults } from "../harness-fixture.ts";
import {
  FailingConnection,
  localConnection,
  lostError,
  RebuiltRoom,
} from "../room/connection-fixture.ts";
import { exampleConfig } from "./config-fixture.ts";
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

/** One request: write and commit in one bash call, so the run leaves work to collect. */
export const writeAndCommit = (): AssistantMessage =>
  call("bash", { command: `mkdir -p src && echo 'export {};' > src/a.ts && ${COMMIT}` });

/** In a bash command, the marker that makes the room's daemon connection lost. */
export const ROOM_DOWN = "ROOM-DOWN";

/** The local daemon, except an exec carrying `ROOM_DOWN` fails as `failure` (default: lost). */
export const roomGoesDown =
  (failure: () => Error = lostError) =>
  (local: Connection): Connection =>
    new FailingConnection(
      ({ op, json }) =>
        op === "exec" && JSON.stringify(json).includes(ROOM_DOWN) ? failure() : undefined,
      local,
    );

/** The local daemon, until an exec carrying `ROOM_DOWN`: from then on every start fails with `failure`. */
export const roomRebuilt =
  (failure: () => Error) =>
  (local: Connection): Connection =>
    new RebuiltRoom(local, ROOM_DOWN, failure);

/** A room whose host key no longer matches from the first start: every start fails with `failure`. */
export const roomUntrusted =
  (failure: () => Error) =>
  (local: Connection): Connection => {
    local.close();
    return new DaemonConnection(() => Promise.reject(failure()));
  };

/** A bash call the room loses mid-command: the job pauses. */
export const lostBash = (): AssistantMessage => call("bash", { command: `echo ${ROOM_DOWN}` });

/** A user message's text, whatever its content shape. */
export const userText = (message: Message): string | undefined => {
  if (message.role !== "user") {
    return undefined;
  }
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
};

/** The user texts of a model request, oldest first. */
export const userTexts = (messages: readonly Message[]): string[] =>
  messages.flatMap((message) => userText(message) ?? []);

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
  /** The runner log lines this test expects (kept in `logs`); any other still throws. */
  allowLog?: (text: string) => boolean;
  /** The modes the process's config holds; default the example's. */
  modes?: RunnerConfig["modes"];
  /** A store file that outlives the process, for `restart`; default `:memory:`. */
  path?: string;
  /**
   * The write (`eventLabel`, or `prompt`: the prompt read just before submit)
   * at which the process dies: it and every later write throw `Crash`.
   */
  crashAt?: string;
}

/** The process died at a write boundary (`crashAt`). */
export class Crash extends Error {}

/** An event as `kind`, or `transition:<to>`: what `kinds` lists and `crashAt` names. */
export const eventLabel = ({ kind, payload }: Pick<JobEvent, "kind" | "payload">): string =>
  kind === "transition" ? `transition:${String(payload["to"])}` : kind;

/**
 * A job store whose process dies at write `at`: that write and every later
 * one throw `Crash`, rolled back as a crash would leave them. `undefined`
 * never crashes.
 */
class CrashingJobStore extends JobStore {
  readonly #at: string | undefined;
  /** Aborted when the process dies: its scheduler stops. */
  readonly #dead = new AbortController();

  constructor(db: RunnerStore["db"], at: string | undefined) {
    super(db, sequentialIds());
    this.#at = at;
  }

  get dead(): AbortSignal {
    return this.#dead.signal;
  }

  /** The process dies now: every later write throws, the scheduler stops. */
  crash(): void {
    this.#dead.abort();
  }

  /** Throws once the process is dead, or when `label` is the write it dies at. */
  check(label: string): void {
    if (this.#dead.signal.aborted || label === this.#at) {
      this.crash();
      throw new Crash(`crashed at ${label}`);
    }
  }

  override change(id: string, now: number, decide: Decide): Promise<Job> {
    return super.change(id, now, (job) => {
      const change = decide(job);
      if (change !== undefined) {
        this.check(eventLabel(change.event));
      }
      return change;
    });
  }

  override appendEvent(
    id: string,
    now: number,
    kind: EventKind,
    payload: JsonRecord,
  ): Promise<void> {
    this.check(kind);
    return super.appendEvent(id, now, kind, payload);
  }
}

export interface RunWorld extends RoomWorld {
  jobs: JobStore;
  harness: Harness;
  deps: RunDeps;
  /** Phase A's view of this process (recover.ts). */
  recoverDeps: RecoverDeps;
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
  /** Every backoff pause asked of `sleep` (it returns at once, advancing the clock), in order. */
  slept: number[];
  /** The runner log lines `allowLog` let through, in order. */
  logs: string[];
  /** Moves the clock on by `ms`. */
  advance: (ms: number) => void;
  /** The process dies now: every later write throws `Crash`, the scheduler stops. */
  crash: () => void;
  /** Closes this process's harness, its storage and database; once. */
  close: () => Promise<void>;
  /** What every process of the world shares: the room, the clock, the store file. */
  shared: Shared;
}

/** What outlives a process: the room, the clock, the store file, the options. */
interface Shared {
  world: RoomWorld;
  path: string;
  options: RunWorldOptions;
  clock: { now: number };
}

interface ProcessOptions {
  enabled: boolean;
  /** The modes this process's config holds. */
  modes: RunnerConfig["modes"];
  /** Restarts open passive (`start.ts`); the first process schedules at once. */
  resume: boolean;
  crashAt?: string;
}

/** The modes a process under `options` holds: the example's unless `options` narrows them. */
const modesOf = (options: RunWorldOptions): RunnerConfig["modes"] =>
  options.modes ?? exampleConfig().modes;

/** The rejoin's harness: the run's (as a test wraps it), plus `harness`'s views and `resume()`. */
const rejoinHarness = (harness: Harness, run: RunDeps["harness"]): RejoinDeps["harness"] => ({
  conversation: run.conversation.bind(run),
  commit: run.commit.bind(run),
  snapshot: harness.snapshot.bind(harness),
  submission: harness.submission.bind(harness),
  resume: (): void => {
    harness.resume();
  },
});

/** One runner process over `shared`: store, faux harness, deps, scheduler. */
async function openProcess(shared: Shared, process: ProcessOptions): Promise<RunWorld> {
  const { world, options, clock } = shared;
  const store = await openRunnerStore(shared.path, { newId: sequentialIds() });
  const jobs = new CrashingJobStore(store.db, process.crashAt);
  const now = (): number => ++clock.now;
  const tenancy = roomTenancy();
  const timers = manualTimer();
  const slept: number[] = [];
  const logs: string[] = [];
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
  let catalog: Models | undefined;
  const { harness, faux } = await openFauxHarness(store.storage, {
    extensions,
    env: tenancy.env,
    models: (models) => {
      catalog = models;
      return gatedModels(models, gate);
    },
    resume: process.resume,
  });
  usage.bind(harness);
  // The runner shutting down (`start.ts`): its runs stop, then the harness closes.
  const stopping = new AbortController();
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    stopping.abort();
    return (closed ??= closeHarness(harness));
  };
  onTestFinished(close);
  const example = exampleConfig();
  const config: RunnerConfig = {
    ...example,
    modes: process.modes,
    defaults: { ...example.defaults, model: "faux/faux-1" },
    maxima: { ...example.maxima, maxRoomWaitS: options.maxRoomWaitS ?? 60 },
    repos: new Map([[NEW_JOB.repo, world.repo]]),
  };
  const dead = AbortSignal.any([stopping.signal, jobs.dead]);
  // A process that died or is shutting down says nothing anyone hears.
  const log = (text: string): void => {
    if (options.allowLog?.(text) === true) {
      logs.push(text);
    } else if (!dead.aborted) {
      throw new Error(`unexpected runner log: ${text}`);
    }
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
    readPrompt: () => {
      jobs.check("prompt");
      return Promise.resolve("You are the patch agent.");
    },
    now,
    timer: timers.timer,
    log,
    stopping: dead,
    sleep: (ms) => {
      slept.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
  };
  const recoverDeps: RecoverDeps = {
    jobs,
    harness,
    config,
    limitsOf: (model) => (catalog === undefined ? undefined : catalogLimits(catalog)(model)),
    now,
    log,
  };
  const rejoinDeps: RejoinDeps = {
    ...deps,
    harness: rejoinHarness(harness, deps.harness),
    limitsOf: recoverDeps.limitsOf,
  };
  const scheduler = createScheduler({
    jobs,
    enabled: process.enabled,
    run: (job, control) => runJob(deps, job, control),
    rejoin: (job, control) => rejoinJob(rejoinDeps, job, control),
    retryPending: (job) => retryPendingCollection(deps, job.id, now()),
    sleep: deps.sleep,
    stop: jobs.dead,
    log: () => undefined,
    now,
  });
  async function submit(): Promise<Job> {
    const { job: queued } = await jobs.submit(
      {
        ...NEW_JOB,
        submissionId: `sub-${String((await jobs.list()).length + 1)}`,
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
    recoverDeps,
    scheduler,
    blocking,
    faux,
    timers,
    submit,
    job,
    events: (id) => jobs.events(id),
    verbs: () => world.slot.calls.map((args) => args[1] ?? ""),
    slept,
    logs,
    advance: (ms): void => {
      clock.now += ms;
    },
    crash: (): void => {
      jobs.crash();
    },
    close,
    shared,
  };
}

/**
 * The run path over `roomWorld({ guestAtClone: true })`: a local daemon runs
 * the job's tools in the room's clone, which the fake slot refreshes and
 * collects.
 */
export async function runWorld(options: RunWorldOptions = {}): Promise<RunWorld> {
  const shared: Shared = {
    world: roomWorld({ guestAtClone: true }),
    path: options.path ?? ":memory:",
    options,
    clock: { now: T0 },
  };
  return openProcess(shared, {
    enabled: true,
    resume: true,
    modes: modesOf(options),
    ...(options.crashAt === undefined ? {} : { crashAt: options.crashAt }),
  });
}

/** A store file in a fresh directory, removed after the test. */
export async function storeFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "malebolge-recovery-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "runner.sqlite");
}

/**
 * The runner restarted as `start.ts` does it: `world`'s process closed
 * without awaiting its run (a crash, or `close`), then a new one opened
 * passive on the same store file, room and clock, its model given `script`;
 * phase A (`recoverHost`), then the scheduler woken.
 */
export async function restart(
  world: RunWorld,
  {
    enabled,
    script = [],
    modes,
  }: { enabled: boolean; script?: FauxResponseStep[]; modes?: RunnerConfig["modes"] },
): Promise<RunWorld> {
  await world.close();
  const next = await openProcess(world.shared, {
    enabled,
    resume: false,
    modes: modes ?? modesOf(world.shared.options),
  });
  next.faux.setResponses(script);
  await recoverHost(next.recoverDeps, enabled);
  next.scheduler.wake();
  return next;
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
export const kinds = (events: readonly JobEvent[]): string[] => events.map(eventLabel);

/** The tool results of `job`'s conversation, oldest first. */
export async function jobToolResults(world: RunWorld, job: Job): Promise<ToolResultMessage[]> {
  const conversation = await jobConversation(world.harness, job.conversationId ?? "");
  return conversation === undefined ? [] : toolResults(world.harness, conversation);
}

export const eventOf = (events: readonly JobEvent[], kind: string): JobEvent | undefined =>
  events.find((event) => kinds([event])[0] === kind);

export const warningEvents = (events: readonly JobEvent[]): JobEvent[] =>
  events.filter((event) => event.kind === "warning");

/** Resolves once job `id` has a warning receipt. */
export const warned = (world: RunWorld, id: string): Promise<void> =>
  until("warning receipt", async () => warningEvents(await world.events(id)).length > 0);
