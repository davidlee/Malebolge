// The daemon's one startup path: one instance per profile, the socket claimed
// before the store is opened, SATAN's tools refreshed before the session resumes.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { orientationOf } from "./boot-context.ts";
import type { Config, Profile } from "./config.ts";
import { context } from "./context.ts";
import { type Conversations, type ConversationDefaults, conversations } from "./conversations.ts";
import { type DaemonEnv, daemonEnv, requireGatewaySocket } from "./daemon-env.ts";
import { daemonExtensions } from "./daemon-extensions.ts";
import { type Daemon, serve } from "./daemon.ts";
import { acquireInstanceLock } from "./instance-lock.ts";
import { loadGatewayModels, type ModelRef } from "./models.ts";
import { personaFiles, readPersona, requirePersonaFiles } from "./persona.ts";
import { renderProjectContext } from "./project-context.ts";
import { registryOf } from "./registry.ts";
import { type Log, SATAN_EXTENSION, type SatanTools, satanTools } from "./satan-tools.ts";
import { openSession, type Session, type SessionOptions } from "./session.ts";
import { loadSkills } from "./skills.ts";
import {
  type EarlyWakeDeps,
  tasksExtension,
  wakeBinding,
  type WakeDeps,
} from "./wake/extension.ts";
import { ensureHeartbeat } from "./wake/heartbeat.ts";
import { v0Policy } from "./wake/policy.ts";
import { sweepBlockedWakes } from "./wake/sweep.ts";
import { wakeTask } from "./wake/task.ts";

type WakeTask = ReturnType<typeof wakeTask>;

export interface StartDeps {
  log: Log;
  /** The model catalog; the gateway's when omitted. */
  models?: Models;
  /** The harness clock, which wakes read too; `Date.now` when omitted. */
  now?: () => number;
  /** The profile's execution environment; `daemonEnv`'s when omitted (a test seam: no room needed). */
  environment?: DaemonEnv;
}

/** `models`, or an error naming the model the catalog lacks. */
function requireKnownModel(models: Models, model: ModelRef): Models {
  const { provider, modelId } = model;
  if (models.getModelOfType("chat", provider, modelId) === undefined) {
    throw new Error(`unknown model ${provider}/${modelId}`);
  }
  return models;
}

/** What the wakes read that exists before the session: step 1 of their binding. */
const earlyWakeDeps = (
  config: Config,
  satan: SatanTools,
  log: Log,
  now: () => number,
): EarlyWakeDeps => {
  const fragment = join(config.corpusRoot, "prompts", "wake.md");
  return {
    settings: config.wakes,
    policy: v0Policy(config.wakes),
    now,
    random: Math.random,
    satan,
    // Per fire, as the persona is read per request: an edit lands on the next wake.
    fragment: () => readPersona([fragment]),
    log,
  };
};

/** Room only (W10), after `resume()`: the start sweep, then exactly one heartbeat (W5). */
const startWakes = async (
  profile: Profile,
  deps: () => WakeDeps,
  session: Session,
  task: WakeTask,
): Promise<void> => {
  if (profile !== "room") {
    return;
  }
  await sweepBlockedWakes(deps(), session.harness, context);
  await ensureHeartbeat(deps(), task, context);
};

/** The session over the configured store, opened and resumed, on this daemon's profile. */
const openBoundSession = async (
  config: Config,
  log: Log,
  options: Omit<SessionOptions, "profile" | "log">,
): Promise<Session> => {
  mkdirSync(dirname(config.storagePath), { recursive: true });
  return openSession(await openNodeSqliteStorage(config.storagePath), {
    ...options,
    profile: config.execution.profile,
    log,
  });
};

/** The injected catalog, or the gateway's; either must know the configured model. */
const modelsFor = async (config: Config, injected: Models | undefined): Promise<Models> =>
  requireKnownModel(
    injected ?? (await loadGatewayModels(config.gatewayCatalog, config.gatewayKeyFile)),
    config.model,
  );

/** The instance lock; on refusal the environment is closed first. */
const lockOrClose = (config: Config, environment: DaemonEnv): { release: () => void } => {
  try {
    return acquireInstanceLock(config.lockPath);
  } catch (error) {
    environment.close();
    throw error;
  }
};

/** How many satan-mcp tools the last refresh registered. */
const satanToolCount = (registry: Registry): number =>
  registry.snapshot().extension(SATAN_EXTENSION)?.tools?.length ?? 0;

/** A started daemon and the facts its entry script reports. */
export interface DaemonHandle {
  /** Terminal; a second call returns the same promise. */
  stop: () => Promise<void>;
  model: ModelRef;
  profile: Profile;
  cwd: string;
  satanTools: number;
  skills: number;
  hasProjectContext: boolean;
  storagePath: string;
  daemonSocket: string;
}

/**
 * Start the profile's daemon: lock, claim the socket, refresh SATAN's tools,
 * then open and resume the session. A failure undoes what preceded it in
 * reverse, releasing the lock last.
 */
export async function startDaemon(config: Config, deps: StartDeps): Promise<DaemonHandle> {
  const { log, now = Date.now } = deps;
  requirePersonaFiles(config.corpusRoot, config.execution.profile);
  const skills = loadSkills(config.skillDirs, log);
  requireGatewaySocket(config.execution);
  const models = await modelsFor(config, deps.models);

  // Local configuration is checked before the room is reached.
  const environment = deps.environment ?? daemonEnv(config.execution, log);
  // One defaults object: root's on every open, every other conversation's at creation.
  const defaults: ConversationDefaults = { model: config.model, cwd: environment.cwd };
  // Read once: a context file edit takes a restart.
  const projectContext = renderProjectContext(await environment.readContext());
  const wakes = wakeBinding();
  const task = wakeTask(wakes.deps);
  const registry = registryOf(
    daemonExtensions({
      personaFiles: (toolset) => personaFiles(config.corpusRoot, toolset, config.execution.profile),
      projectContext,
      skills,
      profile: config.execution.profile,
      tasks: tasksExtension(wakes.deps, task),
    }),
  );

  const lock = lockOrClose(config, environment);
  // Construction never connects, so nothing here can fail before the `try`.
  const satan = satanTools(config.mcpSocket, registry, log, { idleMs: config.satanIdleMs });
  let daemon: Daemon | undefined;
  let session: Session | undefined;
  try {
    mkdirSync(dirname(config.daemonSocket), { recursive: true });
    wakes.bindEarly(earlyWakeDeps(config, satan, log, now));
    // Resolved in `beforeResume`, so a client's continuation runs after `resume()`.
    const conversationsReady = Promise.withResolvers<Conversations>();
    daemon = await serve({
      socketPath: config.daemonSocket,
      conversations: conversationsReady.promise,
      beforeInput: satan.refresh,
      orientation: (conversation) => orientationOf(satan.call, conversation),
    });
    // Before the session resumes, so a turn's SATAN call runs, not `tool_unavailable`.
    await satan.refresh();
    session = await openBoundSession(config, log, {
      models,
      registry,
      agent: defaults,
      env: environment.env,
      now,
      // The one Conversations: the socket's, and the wakes' (design § Daemon wiring, step 2).
      beforeResume: (opened) => {
        const shared = conversations(opened, defaults, config.execution.profile);
        wakes.bindLate({ harness: opened.harness, conversations: shared });
        conversationsReady.resolve(shared);
      },
    });
    await startWakes(config.execution.profile, wakes.deps, session, task);
  } catch (error) {
    // In reverse, the lock last: a session that resumed may already run wakes.
    await session?.harness.close(context);
    await daemon?.close();
    await satan.close();
    environment.close();
    lock.release();
    throw error;
  }

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async (): Promise<void> => {
      await daemon.close();
      await session.harness.close(context);
      environment.close();
      await satan.close();
      lock.release();
    })();
    return stopping;
  };

  return {
    stop,
    model: config.model,
    profile: config.execution.profile,
    cwd: environment.cwd,
    satanTools: satanToolCount(registry),
    skills: skills.length,
    hasProjectContext: projectContext !== undefined,
    storagePath: config.storagePath,
    daemonSocket: config.daemonSocket,
  };
}
