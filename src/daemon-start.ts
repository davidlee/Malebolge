// The daemon's one startup path: one instance per profile, the socket claimed
// before the store is opened, SATAN's tools refreshed before the session resumes.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Config, Profile } from "./config.ts";
import { context } from "./context.ts";
import { type Conversations, type ConversationDefaults, conversations } from "./conversations.ts";
import { daemonEnv, requireGatewaySocket } from "./daemon-env.ts";
import { daemonExtensions } from "./daemon-extensions.ts";
import { type Daemon, serve } from "./daemon.ts";
import { acquireInstanceLock } from "./instance-lock.ts";
import { loadGatewayModels, type ModelRef } from "./models.ts";
import { personaFiles } from "./persona.ts";
import { renderProjectContext } from "./project-context.ts";
import { registryOf } from "./registry.ts";
import { type Log, SATAN_EXTENSION, satanTools } from "./satan-tools.ts";
import { openSession, type Session } from "./session.ts";
import { loadSkills } from "./skills.ts";

export interface StartDeps {
  log: Log;
  /** The model catalog; the gateway's when omitted. */
  models?: Models;
}

/** `models`, or an error naming the model the catalog lacks. */
function requireKnownModel(models: Models, model: ModelRef): Models {
  const { provider, modelId } = model;
  if (models.getModelOfType("chat", provider, modelId) === undefined) {
    throw new Error(`unknown model ${provider}/${modelId}`);
  }
  return models;
}

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
  const { log } = deps;
  const persona = personaFiles(config.corpusRoot, config.execution.profile);
  const skills = loadSkills(config.skillDirs, log);
  requireGatewaySocket(config.execution);
  const models = requireKnownModel(
    deps.models ?? (await loadGatewayModels(config.gatewayCatalog, config.gatewayKeyFile)),
    config.model,
  );

  // Local configuration is checked before the room is reached.
  const environment = daemonEnv(config.execution, log);
  // One defaults object: root's on every open, every other conversation's at creation.
  const defaults: ConversationDefaults = { model: config.model, cwd: environment.cwd };
  // Read once: a context file edit takes a restart.
  const projectContext = renderProjectContext(await environment.readContext());
  const registry = registryOf(
    daemonExtensions({
      personaFiles: persona,
      projectContext,
      skills,
    }),
  );

  let lock: { release: () => void };
  try {
    lock = acquireInstanceLock(config.lockPath);
  } catch (error) {
    environment.close();
    throw error;
  }
  // Construction never connects, so nothing here can fail before the `try`.
  const satan = satanTools(config.mcpSocket, registry, log, { idleMs: config.satanIdleMs });
  let daemon: Daemon | undefined;
  let session: Session | undefined;
  try {
    mkdirSync(dirname(config.daemonSocket), { recursive: true });
    const sessionReady = Promise.withResolvers<Session>();
    // Resolved after `openSession`, hence after `resume()`: no client outruns it.
    const conversationsReady: Promise<Conversations> = sessionReady.promise.then((ready) =>
      conversations(ready, defaults, config.execution.profile),
    );
    daemon = await serve({
      socketPath: config.daemonSocket,
      conversations: conversationsReady,
      beforeInput: satan.refresh,
    });
    // Before the session resumes, so a turn's SATAN call runs, not `tool_unavailable`.
    await satan.refresh();
    mkdirSync(dirname(config.storagePath), { recursive: true });
    session = await openSession(await openNodeSqliteStorage(config.storagePath), {
      models,
      registry,
      agent: defaults,
      env: environment.env,
    });
    sessionReady.resolve(session);
  } catch (error) {
    // In reverse, the lock last.
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
    satanTools: registry.snapshot().extension(SATAN_EXTENSION)?.tools?.length ?? 0,
    skills: skills.length,
    hasProjectContext: projectContext !== undefined,
    storagePath: config.storagePath,
    daemonSocket: config.daemonSocket,
  };
}
