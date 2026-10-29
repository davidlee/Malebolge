// The daemon's one startup path: one instance per profile, its sockets claimed
// before the store is opened (the room's private bridge listener too, DEC-064),
// SATAN's tools refreshed before the session resumes.

import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ConversationId, Extension, Registry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { backupSource, unconfiguredSource } from "./bookmarks/backup.ts";
import { bookmarksExtension } from "./bookmarks/extension.ts";
import { orientationOf } from "./boot-context.ts";
import { operatorRefill } from "./bridge/inbound.ts";
import { type BridgeHost, serveBridge } from "./bridge/listener.ts";
import type { Config, Profile, ScrewtapePaths } from "./config.ts";
import { context } from "./context.ts";
import { type ConversationDefaults, type Conversations, conversations } from "./conversations.ts";
import { type Daemon, type ServeOptions, serve } from "./daemon.ts";
import { type DaemonEnv, daemonEnv, requireGatewaySocket } from "./daemon-env.ts";
import { daemonExtensions } from "./daemon-extensions.ts";
import { acquireInstanceLock } from "./instance-lock.ts";
import { classificationCache } from "./mail/classifications.ts";
import { mailExtension, mailRefusal } from "./mail/extension.ts";
import { screwtapeSource } from "./mail/screwtape.ts";
import {
  loadGatewayModels,
  type ModelCatalog,
  type ModelRef,
  modelCatalog,
  refOf,
  UnknownModel,
} from "./models.ts";
import { personaFiles, readPersona, requirePersonaFiles } from "./persona.ts";
import { renderProjectContext } from "./project-context.ts";
import { registryOf } from "./registry.ts";
import { type Log, SATAN_EXTENSION, type SatanTools, satanTools } from "./satan-tools.ts";
import { openSession, type Session, type SessionOptions } from "./session.ts";
import { loadSkills, type Skill } from "./skills.ts";
import { sweepBlockedTasks } from "./task-sweep.ts";
import { type ThreadDeps, threadBinding, threadsExtension } from "./threads/extension.ts";
import { postSweptKind, postTask } from "./threads/task.ts";
import type { UnixServer } from "./unix-socket.ts";
import {
  type EarlyWakeDeps,
  tasksExtension,
  type WakeBinding,
  type WakeDeps,
  wakeBinding,
} from "./wake/extension.ts";
import { ensureHeartbeat } from "./wake/heartbeat.ts";
import { v0Policy } from "./wake/policy.ts";
import { wakeSweptKind } from "./wake/sweep.ts";
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

/** What the wakes read that exists before the session: step 1 of their binding. */
const earlyWakeDeps = (
  config: Config,
  satan: SatanTools,
  log: Log,
  now: () => number,
): EarlyWakeDeps => {
  const fragment = join(config.corpusRoot, "prompts", "wake.md");
  return {
    profile: config.execution.profile,
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

/**
 * `ensureHeartbeat`, except that an unknown model stored on the wake topic is logged
 * instead of failing the start: the daemon serves without a heartbeat (DEC-083).
 * Every other failure is still the start's.
 */
const ensureHeartbeatOrLog = async (deps: WakeDeps, task: WakeTask): Promise<void> => {
  try {
    await ensureHeartbeat(deps, task, context);
  } catch (error) {
    if (!(error instanceof UnknownModel)) {
      throw error;
    }
    deps.log(`wake: no heartbeat: unknown model ${error.ref} in topic ${deps.settings.topic}`);
  }
};

/** Room only (W10), after `resume()`: the start sweep of both rows, then exactly one heartbeat (W5). */
const startRoomTasks = async (
  profile: Profile,
  deps: () => WakeDeps,
  threadDeps: () => ThreadDeps,
  session: Session,
  task: WakeTask,
): Promise<void> => {
  if (profile !== "room") {
    return;
  }
  await sweepBlockedTasks(
    deps().harness,
    [wakeSweptKind(deps(), session.harness), postSweptKind(threadDeps())],
    deps().log,
    context,
  );
  await ensureHeartbeatOrLog(deps(), task);
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

/** The injected catalog, or the gateway's. */
const modelsFor = async (config: Config, injected: Models | undefined): Promise<Models> =>
  injected ?? (await loadGatewayModels(config.gatewayCatalog, config.gatewayKeyFile));

/** The profile's static requirements, then its skills: the first work a start does. */
const preflight = (config: Config, log: Log): Skill[] => {
  requirePersonaFiles(config.corpusRoot, config.execution.profile);
  const skills = loadSkills(config.skillDirs, log);
  requireGatewaySocket(config.execution);
  return skills;
};

/** The instance lock; on refusal the environment is closed first. */
const lockOrClose = (config: Config, environment: DaemonEnv): { release: () => void } => {
  try {
    return acquireInstanceLock(config.lockPath);
  } catch (error) {
    environment.close();
    throw error;
  }
};

/** How many tools the registry's `name` extension registered. */
const toolCount = (registry: Registry, name: string): number =>
  registry.snapshot().extension(name)?.tools?.length ?? 0;

/**
 * The interfaces this process can reach, read once per build, or undefined when
 * `/sys/class/net` cannot be listed: a failed precondition, not an absence
 * (design § Preconditions).
 */
const networkInterfaces = (): readonly string[] | undefined => {
  try {
    return readdirSync("/sys/class/net");
  } catch {
    return undefined;
  }
};

/**
 * The mail extension over `screwtape`, or none where the profile allows no mail.
 * Its environment is a host `NodeExecutionEnv` holding no resources (no `close`):
 * an in-flight child ends with its call's abort signal when the harness closes,
 * so "closed with the daemon" needs no extra code. It is never the room's env.
 */
const mailPart = (
  screwtape: ScrewtapePaths | undefined,
  now: () => number,
  log: Log,
): Extension | undefined =>
  screwtape === undefined
    ? undefined
    : mailExtension({
        source: screwtapeSource({
          ...screwtape,
          env: new NodeExecutionEnv({ cwd: screwtape.home }),
        }),
        now,
        cache: classificationCache(),
        reported: new Map(),
        log,
        refusal: mailRefusal({
          interfaces: networkInterfaces(),
          credentials: screwtape.credentials,
        }),
      });

/**
 * The bookmarks extension over the configured backup directory, or over the
 * source that refuses every call when there is none (DEC-055).
 */
const bookmarksPart = (dir: string | undefined, now: () => number): Extension =>
  bookmarksExtension({
    source: dir === undefined ? unconfiguredSource() : backupSource(dir),
    now,
  });

/** The registry the daemon installs: the profile's catalogue, bookmarks and mail. */
const daemonRegistry = (
  config: Config,
  parts: {
    projectContext: string | undefined;
    skills: readonly Skill[];
    wakes: WakeBinding;
    task: WakeTask;
    threads: Extension;
  },
  now: () => number,
  log: Log,
): Registry => {
  const mail = mailPart(config.screwtape, now, log);
  return registryOf(
    daemonExtensions({
      personaFiles: (toolset) => personaFiles(config.corpusRoot, toolset, config.execution.profile),
      projectContext: parts.projectContext,
      skills: parts.skills,
      profile: config.execution.profile,
      tasks: tasksExtension(parts.wakes.deps, parts.task),
      threads: parts.threads,
      bookmarks: bookmarksPart(config.bookmarkBackups, now),
      ...(mail === undefined ? {} : { mail }),
    }),
  );
};

/** A started daemon and the facts its entry script reports. */
export interface DaemonHandle {
  /** Terminal; a second call returns the same promise. */
  stop: () => Promise<void>;
  model: ModelRef;
  profile: Profile;
  cwd: string;
  satanTools: number;
  /** The mail tools the registry's `mail` extension registered (0 on a host). */
  mailTools: number;
  skills: number;
  hasProjectContext: boolean;
  storagePath: string;
  daemonSocket: string;
}

/**
 * The options the daemon's socket opens with: the conversations the session
 * resolves, the one gate, and the two answers the daemon gives from its own
 * ports — the orientation a fresh turn gets, and the catalogue's chat-model refs
 * a `models` listing returns (SL-010 PHASE-06).
 */
const serveOptionsOf = (
  config: Config,
  satan: SatanTools,
  conversations: Promise<Conversations>,
  catalog: ModelCatalog,
  onOperatorInput: ((conversation: ConversationId) => Promise<void>) | undefined,
): ServeOptions => ({
  socketPath: config.daemonSocket,
  conversations,
  beforeInput: satan.refresh,
  orientation: (conversation) => orientationOf(satan.call, conversation),
  modelRefs: catalog.refs,
  ...(onOperatorInput === undefined ? {} : { onOperatorInput }),
});

/** What the bridge listener reads: the session's one harness and the daemon's own ports (SL-009 sec-2). */
const bridgeHostOf = (
  session: Session,
  conversations: Conversations,
  defaults: ConversationDefaults,
  config: Config,
  catalog: ModelCatalog,
  satan: Pick<SatanTools, "call">,
  log: Log,
  now: () => number,
): BridgeHost => ({
  session,
  conversations,
  defaults,
  profile: config.execution.profile,
  catalog,
  satan,
  log,
  now,
});

/**
 * The daemon's one stop, in reverse of the start: its sockets, the store, the
 * environment, SATAN and the lock last. A second call returns the same promise.
 */
const stopOf = (
  daemon: Daemon,
  bridge: UnixServer | undefined,
  session: Session,
  environment: DaemonEnv,
  satan: SatanTools,
  lock: { release: () => void },
): (() => Promise<void>) => {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async (): Promise<void> => {
      await daemon.close();
      await bridge?.close();
      await session.harness.close(context);
      environment.close();
      await satan.close();
      lock.release();
    })();
    return stopping;
  };
};

/**
 * The operator-refill hook: room only (the host profile's `bridgeHost` never resolves,
 * so it must get no hook), where an operator's input in a bridged conversation
 * refills its loop budget (SL-009 design sec-5).
 */
const operatorRefillOf = (
  config: Config,
  host: Promise<BridgeHost>,
): ((conversation: ConversationId) => Promise<void>) | undefined =>
  config.bridgeSocket === undefined ? undefined : operatorRefill(host);

/**
 * Start the profile's daemon: lock, claim the socket, refresh SATAN's tools,
 * then open and resume the session. A failure undoes what preceded it in
 * reverse, releasing the lock last.
 */
export async function startDaemon(config: Config, deps: StartDeps): Promise<DaemonHandle> {
  const { log, now = Date.now } = deps;
  const skills = preflight(config, log);
  const models = await modelsFor(config, deps.models);
  // The configured model must be one the catalog serves; later phases pass the port on.
  const catalog = modelCatalog(models);
  catalog.require(refOf(config.model));

  // Local configuration is checked before the room is reached.
  const environment = deps.environment ?? daemonEnv(config.execution, log);
  // One defaults object: root's on every open, every other conversation's at creation.
  const defaults: ConversationDefaults = { model: config.model, cwd: environment.cwd };
  // Read once: a context file edit takes a restart.
  const projectContext = renderProjectContext(await environment.readContext());
  const wakes = wakeBinding();
  const task = wakeTask(wakes.deps);
  const threads = threadBinding();
  const postTaskDef = postTask(threads.deps);
  const registry = daemonRegistry(
    config,
    { projectContext, skills, wakes, task, threads: threadsExtension(threads.deps, postTaskDef) },
    now,
    log,
  );

  const lock = lockOrClose(config, environment);
  // Construction never connects, so nothing here can fail before the `try`.
  const satan = satanTools(config.mcpSocket, registry, log, { idleMs: config.satanIdleMs });
  let daemon: Daemon | undefined;
  let bridge: UnixServer | undefined;
  let session: Session | undefined;
  try {
    mkdirSync(dirname(config.daemonSocket), { recursive: true });
    wakes.bindEarly(earlyWakeDeps(config, satan, log, now));
    threads.bindEarly({ profile: config.execution.profile, defaults, catalog, now, log, satan });
    // Resolved in `beforeResume`, so a client's continuation runs after `resume()`.
    const conversationsReady = Promise.withResolvers<Conversations>();
    // The bridge listener's host, resolved beside it (SL-009 design sec-2).
    const bridgeHost = Promise.withResolvers<BridgeHost>();
    // Room only, where an operator's input in a bridged conversation refills its
    // loop budget (sec-5).
    const refill = operatorRefillOf(config, bridgeHost.promise);
    daemon = await serve(
      serveOptionsOf(config, satan, conversationsReady.promise, catalog, refill),
    );
    // Room only: `config.bridgeSocket` exists on no other profile's Config.
    if (config.bridgeSocket !== undefined) {
      bridge = await serveBridge({ path: config.bridgeSocket, host: bridgeHost.promise });
    }
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
        const shared = conversations(opened, defaults, config.execution.profile, catalog);
        wakes.bindLate({ harness: opened.harness, conversations: shared });
        threads.bindLate({ harness: opened.harness });
        conversationsReady.resolve(shared);
        bridgeHost.resolve(
          bridgeHostOf(opened, shared, defaults, config, catalog, satan, log, now),
        );
      },
    });
    await startRoomTasks(config.execution.profile, wakes.deps, threads.deps, session, task);
  } catch (error) {
    // In reverse, the lock last: a session that resumed may already run wakes.
    await session?.harness.close(context);
    await bridge?.close();
    await daemon?.close();
    await satan.close();
    environment.close();
    lock.release();
    throw error;
  }

  const stop = stopOf(daemon, bridge, session, environment, satan, lock);

  return {
    stop,
    model: config.model,
    profile: config.execution.profile,
    cwd: environment.cwd,
    satanTools: toolCount(registry, SATAN_EXTENSION),
    mailTools: toolCount(registry, "mail"),
    skills: skills.length,
    hasProjectContext: projectContext !== undefined,
    storagePath: config.storagePath,
    daemonSocket: config.daemonSocket,
  };
}
