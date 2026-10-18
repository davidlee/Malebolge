// Starting the runner: environment to paths, config, prompt file, the way
// into the room, store, harness, scheduler, control socket. Fails closed (I13):
// anything missing or invalid is a StartRefused, before the socket serves.
// The harness is opened passive (no `resume()`): nothing runs until something
// asks it for progress, and with `enabled = false` nothing does (I14).
// Restart recovery (DEC-054) is two-phase. Phase A (recover.ts) runs here,
// after the harness opens and before the socket serves or the scheduler
// wakes: host work and read-only views only (I15), so no task is scheduled
// before it completes. Phase B, the in-flight job's harness act then
// `resume()`, is its rejoined run's (rejoin.ts), which the woken scheduler
// seats: enabled runners only, and never with no job in flight (R2).
//
// One store feeds control and scheduler, so `watch` sees every transition
// (observers are per JobStore instance), and pi shares its database handle
// (EVD-008: run.ts never nests a call to one inside the other's transaction).
// The harness sees the model catalog only through the model gate (DEC-057),
// which charges the seated job.

import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import type { Connection } from "@earendil-works/pi-env";
import { modelsStorePath } from "../config.ts";
import { context } from "../context.ts";
import { createDaemonModels, readModelsStore } from "../models.ts";
import { registryOf } from "../session.ts";
import { abortableSleep } from "./backoff.ts";
import { type CollectDeps, retryPendingCollection } from "./collect.ts";
import { parseRunnerConfig, type RepoConfig, type RunnerConfig } from "./config.ts";
import { type ControlDeps, serveControl } from "./control.ts";
import { harnessConversations } from "./conversations.ts";
import { systemTimer } from "./deadline.ts";
import { roomDaemon } from "./env.ts";
import { messageOf, StartRefused } from "./errors.ts";
import { gitQuarantineReader, gitRepoReader } from "./git.ts";
import { jobGuard } from "./guard.ts";
import { catalogLimits, createModelGate, gatedModels, harnessUsage } from "./model-gate.ts";
import { recoverHost } from "./recover.ts";
import { channelFromConfig, type GitChannel, roomConnection } from "./room.ts";
import { type RejoinDeps, rejoinJob } from "./rejoin.ts";
import { runJob } from "./run.ts";
import { createScheduler } from "./scheduler.ts";
import { openRunnerStore } from "./store.ts";
import { roomTenancy } from "./tenancy.ts";
import { JobTools } from "./tools.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Where the runner reads and writes. */
export interface RunnerPaths {
  home: string;
  /** `$SATAN_RUNNER_CONFIG`, set by the unit. */
  config: string;
  /** `$XDG_STATE_HOME/satan/runner/runner.sqlite`. */
  store: string;
  /** `$XDG_RUNTIME_DIR/satan-runner/control.sock`: a directory no jail binds (I4). */
  socket: string;
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new StartRefused(`${name} is not set`);
  }
  return value;
}

export function runnerPaths(env: Env): RunnerPaths {
  const home = required(env, "HOME");
  const stateHome = env["XDG_STATE_HOME"] ?? join(home, ".local", "state");
  return {
    home,
    config: required(env, "SATAN_RUNNER_CONFIG"),
    store: join(stateHome, "satan", "runner", "runner.sqlite"),
    socket: join(required(env, "XDG_RUNTIME_DIR"), "satan-runner", "control.sock"),
  };
}

async function loadConfig(path: string, home: string): Promise<RunnerConfig> {
  try {
    return parseRunnerConfig(await readFile(path, "utf8"), home);
  } catch (error) {
    throw new StartRefused(`config ${path}: ${messageOf(error)}`, { cause: error });
  }
}

/** The prompt file must be a readable regular file; there is no fallback (CHR-003). */
async function checkPromptFile(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isFile()) {
      throw new Error("not a regular file");
    }
    await access(path, constants.R_OK);
  } catch (error) {
    throw new StartRefused(`prompt_file ${path}: ${messageOf(error)}`, { cause: error });
  }
}

/** How the runner reaches the room: its git channel, and a daemon connection per job. */
export interface RoomAccess {
  channel: GitChannel;
  connect: (repo: RepoConfig) => Connection;
}

/** The configured way in: its git channel and an ssh daemon into the guest (I13). */
function roomAccessFromConfig(config: RunnerConfig): RoomAccess {
  const channel = channelFromConfig(config);
  const connection = roomConnection(config);
  return { channel, connect: () => roomDaemon(connection) };
}

export interface StartOptions {
  log: (text: string) => void;
  /**
   * The model catalog; defaults to pi-ai's plus the coding agent's cache under
   * HOME. The harness sees it only through the model gate.
   */
  models?: Models;
  /** How to reach the room; defaults to what the config names (room.ts). */
  room?: RoomAccess;
}

export interface Runner {
  paths: RunnerPaths;
  /**
   * Stops serving, then the scheduler (no new pick; a backoff pause ends),
   * then closes the harness, its storage and the database.
   */
  close: () => Promise<void>;
}

/** `step`'s result; if it fails, the harness is closed first: startup fails closed. */
async function closingOnFailure<T>(harness: Pick<Harness, "close">, step: Promise<T>): Promise<T> {
  try {
    return await step;
  } catch (error) {
    await harness.close(context);
    throw error;
  }
}

export async function startRunner(env: Env, options: StartOptions): Promise<Runner> {
  const paths = runnerPaths(env);
  const config = await loadConfig(paths.config, paths.home);
  await checkPromptFile(config.promptFile);
  const room = options.room ?? roomAccessFromConfig(config);
  await mkdir(dirname(paths.store), { recursive: true });
  const store = await openRunnerStore(paths.store);
  const { jobs } = store;
  const now = Date.now;
  const tenancy = roomTenancy();
  const extensions = [JobTools, jobGuard({ currentJob: tenancy.guarded, jobs, now })];
  const models = options.models ?? createDaemonModels(readModelsStore(modelsStorePath(paths.home)));
  // Built before the harness it sits in: usage is unreadable until it opens (I10).
  const usage = harnessUsage();
  const gate = createModelGate({ seated: tenancy.seated, jobs, now, usageOf: usage.usageOf });
  const harness = await Harness.open(
    store.storage,
    { models: gatedModels(models, gate), registry: registryOf(extensions), env: tenancy.env },
    context,
  );
  usage.bind(harness);
  const recoverDeps = { jobs, harness, config, limitsOf: catalogLimits(models), now };
  await closingOnFailure(
    harness,
    recoverHost({ ...recoverDeps, log: options.log }, config.enabled),
  );
  const conversations = harnessConversations(harness);
  const collect: CollectDeps = {
    jobs,
    channel: room.channel,
    quarantine: gitQuarantineReader,
    config,
  };
  const stop = new AbortController();
  const runDeps: RejoinDeps = {
    ...collect,
    harness,
    conversations,
    tenancy,
    connect: room.connect,
    extensions,
    readPrompt: () => readFile(config.promptFile, "utf8"),
    now,
    sleep: abortableSleep,
    timer: systemTimer,
    log: options.log,
    limitsOf: recoverDeps.limitsOf,
    stopping: stop.signal,
  };
  const scheduler = createScheduler({
    jobs,
    enabled: config.enabled,
    run: (job, control) => runJob(runDeps, job, control),
    rejoin: (job, control) => rejoinJob(runDeps, job, control),
    retryPending: (job) => retryPendingCollection(collect, job.id, now()),
    sleep: abortableSleep,
    stop: stop.signal,
    log: options.log,
    now,
  });
  const deps: ControlDeps = {
    config,
    jobs,
    conversations,
    repos: gitRepoReader,
    wake: scheduler.wake,
    cancel: scheduler.cancel,
    now,
    log: options.log,
  };
  const server = await closingOnFailure(harness, serveControl(deps, paths.socket));
  // Jobs queued before this process started; phase A has settled the rest.
  scheduler.wake();
  return {
    paths,
    close: async (): Promise<void> => {
      await server.close();
      stop.abort();
      await harness.close(context);
    },
  };
}
