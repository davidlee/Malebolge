// Starting the runner: environment to paths, config, prompt file, store,
// harness, control socket. Fails closed (I13): anything missing or invalid is
// a StartRefused, before the socket serves. The harness is opened passive: no
// `resume()`, so nothing is scheduled (I14) until the scheduler exists.

import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { modelsStorePath } from "../config.ts";
import { context } from "../context.ts";
import { createDaemonModels, readModelsStore } from "../models.ts";
import { registryOf } from "../session.ts";
import { parseRunnerConfig, type RunnerConfig } from "./config.ts";
import { type ControlDeps, harnessConversations, serveControl } from "./control.ts";
import { StartRefused } from "./errors.ts";
import { gitRepoReader } from "./git.ts";
import { openRunnerStore } from "./store.ts";

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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

export interface StartOptions {
  log: (text: string) => void;
  /** The model catalog; defaults to pi-ai's plus the coding agent's cache under HOME. */
  models?: Models;
}

export interface Runner {
  paths: RunnerPaths;
  /** Stops serving, then closes the harness, its storage and the database. */
  close: () => Promise<void>;
}

export async function startRunner(env: Env, options: StartOptions): Promise<Runner> {
  const paths = runnerPaths(env);
  const config = await loadConfig(paths.config, paths.home);
  await checkPromptFile(config.promptFile);
  await mkdir(dirname(paths.store), { recursive: true });
  const store = await openRunnerStore(paths.store);
  const models = options.models ?? createDaemonModels(readModelsStore(modelsStorePath(paths.home)));
  const harness = await Harness.open(store.storage, { models, registry: registryOf([]) }, context);
  const deps: ControlDeps = {
    config,
    jobs: store.jobs,
    conversations: harnessConversations(harness),
    repos: gitRepoReader,
    wake: () => undefined, // The scheduler (PHASE-07) wakes on submit.
    now: Date.now,
    log: options.log,
  };
  const server = await serveControl(deps, paths.socket).catch(async (error: unknown) => {
    await harness.close(context);
    throw error;
  });
  return {
    paths,
    close: async (): Promise<void> => {
      await server.close();
      await harness.close(context);
    },
  };
}
