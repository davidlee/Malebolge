import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { Config, Profile } from "../src/config.ts";
import { context } from "../src/context.ts";
import { type DaemonEnv, daemonEnv } from "../src/daemon-env.ts";
import { daemonExtensions } from "../src/daemon-extensions.ts";
import { type DaemonHandle, startDaemon } from "../src/daemon-start.ts";
import { acquireInstanceLock, InstanceLocked } from "../src/instance-lock.ts";
import { registryOf } from "../src/registry.ts";
import { openSession } from "../src/session.ts";
import { storedEntry } from "../src/topics.ts";
import { serveUnix, SocketInUse } from "../src/unix-socket.ts";
import { tasksExtension, wakeBinding } from "../src/wake/extension.ts";
import { liveWakes, type WakeInput } from "../src/wake/task.ts";
import { type FakeTool, fakeMcpServer, rejection, staleSocket, tempDir } from "./fixtures.ts";
import {
  callThenAnswer,
  FAUX_MODEL,
  fakeClock,
  type FakeClock,
  fauxModels,
  indexOf,
  nodeEnv,
  textOf,
  toolResults,
} from "./harness-fixture.ts";
import {
  heldUntilCutOff,
  IDLE,
  PERCEPT,
  recordedTurn,
  START,
  WAIT,
  wakeInputs,
} from "./wake-fixture.ts";

interface World {
  config: Config;
  log: string[];
  models: Models;
  faux: FauxProviderHandle;
  /** The host-shaped cwd the world was built over. */
  cwd: string;
  /** The harness clock handed to `startDaemon`; the real one when absent. */
  now?: () => number;
  /** The execution environment handed to `startDaemon`; the profile's own when absent. */
  environment?: DaemonEnv;
}

/** A daemon config over a temp tree, with persona files and injected faux models. */
async function world(): Promise<World> {
  const tmp = await tempDir();
  onTestFinished(tmp.cleanup);
  const corpus = join(tmp.dir, "corpus");
  await mkdir(join(corpus, "system"), { recursive: true });
  await mkdir(join(corpus, "prompts", "env"), { recursive: true });
  await writeFile(join(corpus, "system", "scaffold.txt"), "scaffold\n");
  await writeFile(join(corpus, "prompts", "interactive.txt"), "interactive\n");
  await writeFile(join(corpus, "prompts", "env", "host.txt"), "host\n");
  const cwd = join(tmp.dir, "cwd");
  await mkdir(cwd, { recursive: true });
  const state = join(tmp.dir, "state", "satan", "durable", "host");
  const config: Config = {
    corpusRoot: corpus,
    storagePath: join(state, "session.sqlite"),
    lockPath: join(state, "daemon.lock"),
    mcpSocket: join(tmp.dir, "mcp.sock"),
    satanIdleMs: 900_000,
    daemonSocket: join(tmp.dir, "run", "satan", "durable", "host", "durable.sock"),
    model: FAUX_MODEL,
    gatewayCatalog: join(tmp.dir, "missing-catalog.json"),
    gatewayKeyFile: join(tmp.dir, "missing-key"),
    skillDirs: [],
    wakes: {
      enabled: false,
      floorMs: 300_000,
      ceilingMs: 7_200_000,
      quiet: { startMin: 1400, endMin: 420 },
      topic: "room",
    },
    execution: { profile: "host", cwd },
  };
  const { faux, models } = fauxModels();
  return { config, log: [], models, faux, cwd };
}

const start = (world: World): Promise<DaemonHandle> =>
  startDaemon(world.config, {
    log: (line) => {
      world.log.push(line);
    },
    models: world.models,
    ...(world.now === undefined ? {} : { now: world.now }),
    ...(world.environment === undefined ? {} : { environment: world.environment }),
  });

/** Stop a handle the test may not reach (a start still in flight, or a later failure). */
const track = (started: Promise<DaemonHandle>): void => {
  onTestFinished(async () => {
    const handle = await started.catch(() => undefined);
    if (handle !== undefined) {
      await handle.stop();
    }
  });
};

const trackAll = (started: readonly Promise<DaemonHandle>[]): void => {
  for (const promise of started) {
    track(promise);
  }
};

/** The lock is free: a fresh acquire succeeds. */
const lockFree = (config: Config): void => {
  acquireInstanceLock(config.lockPath).release();
};

const note: FakeTool = {
  name: "notes_read",
  description: "Read a note",
  call: () => ({ text: "note" }),
};

describe("startDaemon", () => {
  it("refuses a corpus missing a persona file of an allowed toolset, naming the file", async () => {
    const w = await world();
    const prompt = join(w.config.corpusRoot, "prompts", "interactive.txt");
    await rm(prompt);
    await expect(start(w)).rejects.toThrow(`no persona file for toolset interactive: ${prompt}`);
    // Refused before the lock was claimed, so a later start is free to take it.
    expect(existsSync(w.config.lockPath)).toBe(false);
    lockFree(w.config);
  });

  it("refuses while another holder has the instance lock", async () => {
    const w = await world();
    const held = acquireInstanceLock(w.config.lockPath);
    onTestFinished(held.release);
    const started = start(w);
    track(started);
    expect(await rejection(started)).toBeInstanceOf(InstanceLocked);
    expect(existsSync(w.config.storagePath)).toBe(false);
    expect(existsSync(w.config.daemonSocket)).toBe(false);
  });

  it("refuses a live listener on the daemon socket and frees the lock", async () => {
    const w = await world();
    await mkdir(dirname(w.config.daemonSocket), { recursive: true });
    const live = await serveUnix(w.config.daemonSocket, (socket) => socket.end());
    onTestFinished(live.close);
    const started = start(w);
    track(started);
    expect(await rejection(started)).toBeInstanceOf(SocketInUse);
    expect(existsSync(w.config.storagePath)).toBe(false);
    lockFree(w.config);
  });

  it("claims the socket and serves before it opens the store", async () => {
    const w = await world();
    const mcp = await fakeMcpServer(w.config.mcpSocket, [note], { silent: ["tools/list"] });
    const started = start(w);
    // Close the held server first, then the daemon: either order of test-end hooks is safe.
    onTestFinished(async () => {
      await mcp.close();
      const handle = await started.catch(() => undefined);
      if (handle !== undefined) {
        await handle.stop();
      }
    });
    await mcp.requests.next((method) => method === "tools/list");
    expect(existsSync(w.config.daemonSocket)).toBe(true);
    expect(existsSync(w.config.storagePath)).toBe(false);
    await mcp.release();
    const handle = await started;
    expect(existsSync(w.config.storagePath)).toBe(true);
    expect(handle.satanTools).toBe(1);
  });

  it("undoes the socket claim when the store cannot be opened", async () => {
    const w = await world();
    await mkdir(w.config.storagePath, { recursive: true });
    const started = start(w);
    track(started);
    await expect(started).rejects.toThrow();
    expect(existsSync(w.config.daemonSocket)).toBe(false);
    lockFree(w.config);
  });

  it("starts with no SATAN tools when satan-mcp is absent", async () => {
    const w = await world();
    const started = start(w);
    track(started);
    const handle = await started;
    expect(handle.satanTools).toBe(0);
    expect(w.log.some((line) => line.includes("satan-mcp unreachable"))).toBe(true);
  });

  it("lets exactly one of two concurrent starts hold the lock", async () => {
    const w = await world();
    const started = [start(w), start(w)];
    trackAll(started);
    const results = await Promise.allSettled(started);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      InstanceLocked,
    );
  });

  it("lets exactly one concurrent start replace a stale socket", async () => {
    const w = await world();
    await mkdir(dirname(w.config.daemonSocket), { recursive: true });
    await staleSocket(w.config.daemonSocket);
    const started = [start(w), start(w)];
    trackAll(started);
    const results = await Promise.allSettled(started);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      InstanceLocked,
    );
    expect(existsSync(w.config.daemonSocket)).toBe(true);
  });

  it("stops once, removing the socket and the lock", async () => {
    const w = await world();
    const started = start(w);
    track(started);
    const handle = await started;
    expect(existsSync(w.config.daemonSocket)).toBe(true);
    const first = handle.stop();
    const second = handle.stop();
    expect(second).toBe(first);
    await first;
    expect(existsSync(w.config.daemonSocket)).toBe(false);
    lockFree(w.config);
  });
});

/** A room-profile world over the host-shaped environment seam: no room, no ssh. */
async function roomWorld(wakes: { enabled: boolean }): Promise<World> {
  const w = await world();
  const { corpusRoot } = w.config;
  await writeFile(join(corpusRoot, "prompts", "env", "room.txt"), "room\n");
  await writeFile(join(corpusRoot, "prompts", "wake.md"), "FRAGMENT TEXT\n");
  w.config.execution = {
    profile: "room",
    // Never connected: `environment` stands in for the room.
    room: { host: "room", user: "u", hostKeyAlias: "room", knownHosts: "/dev/null" },
    home: w.cwd,
  };
  w.config.wakes.enabled = wakes.enabled;
  w.environment = daemonEnv({ profile: "host", cwd: w.cwd }, (line) => {
    w.log.push(line);
  });
  return w;
}

/** The satan-mcp tools a wake calls, answering as a room user who is away. */
const wakeTools: FakeTool[] = [
  { name: "activity_read", call: () => ({ text: IDLE }) },
  { name: "satan_boot_context", call: () => ({ text: PERCEPT }) },
  { name: "notify_send", call: () => ({ text: "sent" }) },
];

/** Answers every model request plainly and returns the messages each request carried. */
function recordTurns(faux: FauxProviderHandle): Message[][] {
  const { step, seen } = recordedTurn();
  faux.setResponses(Array.from({ length: 8 }, () => step));
  return seen;
}

/** The store as a stopped daemon left it, read through `profile`'s registry and closed after `read`. */
async function inStore<T>(
  w: World,
  profile: Profile,
  read: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(w.config.storagePath),
    {
      models: w.models,
      registry: registryOf(
        daemonExtensions({
          personaFiles: () => [],
          projectContext: undefined,
          skills: [],
          profile,
          tasks: tasksExtension(wakeBinding().deps),
        }),
      ),
      env: nodeEnv,
    },
    context,
  );
  try {
    return await read(harness);
  } finally {
    await harness.close(context);
  }
}

/** A live wake and the topic of the conversation it targets. */
interface WakeInTopic {
  id: number;
  input: WakeInput;
  topic: string | undefined;
}

const wakesInStore = (w: World, profile: Profile): Promise<WakeInTopic[]> =>
  inStore(w, profile, async (harness) => {
    const index = await indexOf(harness);
    return (await liveWakes(harness, context)).map(({ id, input }) => ({
      id,
      input,
      topic: storedEntry(index, input.conversationId)?.topic,
    }));
  });

/** The files under `dir` this process holds open (Linux: its descriptors in /proc/self/fd). */
const openFilesUnder = (dir: string): string[] =>
  readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = readlinkSync(join("/proc/self/fd", fd));
      return target.startsWith(dir) ? [target] : [];
    } catch {
      // Closed between the listing and the read.
      return [];
    }
  });

/** The id in the log's `wake heartbeat <id> created in room` line. */
const createdHeartbeats = (w: World): string[] =>
  w.log.flatMap((line) => /^wake heartbeat (\d+) created in room$/.exec(line)?.[1] ?? []);

const logged = (w: World, pattern: RegExp): boolean => w.log.some((line) => pattern.test(line));

/** A started, tracked daemon. */
async function started(w: World): Promise<DaemonHandle> {
  const handle = start(w);
  track(handle);
  return handle;
}

/** A room world whose heartbeat is overdue: started once at noon, stopped, a ceiling and a minute on. */
async function overdueHeartbeat(
  enabled: boolean,
): Promise<{ w: World; clock: FakeClock; id: string }> {
  const w = await roomWorld({ enabled });
  const clock = fakeClock(START);
  w.now = clock.now;
  const mcp = await fakeMcpServer(w.config.mcpSocket, wakeTools);
  onTestFinished(mcp.close);
  await (await started(w)).stop();
  const [id] = createdHeartbeats(w);
  expect(id).toBeDefined();
  clock.advance(w.config.wakes.ceilingMs + 60_000);
  return { w, clock, id: id ?? "" };
}

describe("startDaemon wakes", () => {
  it("VT-3 a: a fresh room start creates one recurring heartbeat in the wake topic, and a restart none", async () => {
    const w = await roomWorld({ enabled: true });
    await (await started(w)).stop();
    const wakes = await wakesInStore(w, "room");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.input.recurring).toBe(true);
    expect(wakes[0]?.topic).toBe(w.config.wakes.topic);
    expect(createdHeartbeats(w)).toEqual([String(wakes[0]?.id)]);

    await (await started(w)).stop();
    expect(await wakesInStore(w, "room")).toHaveLength(1);
    expect(createdHeartbeats(w)).toHaveLength(1);
  });

  it("VT-3 b: an overdue heartbeat fires on resume with every wake dependency bound", async () => {
    const { w, id } = await overdueHeartbeat(true);
    const seen = recordTurns(w.faux);
    await started(w);
    await vi.waitFor(() => {
      expect(logged(w, new RegExp(`^wake ${id} n=\\d+ \\(room\\) done$`))).toBe(true);
    }, WAIT);
    const fire = w.log.findIndex((line) =>
      new RegExp(`^wake ${id} n=\\d+ \\(room\\) fire$`).test(line),
    );
    const done = w.log.findIndex((line) =>
      new RegExp(`^wake ${id} n=\\d+ \\(room\\) done$`).test(line),
    );
    expect(fire).toBeGreaterThanOrEqual(0);
    expect(fire).toBeLessThan(done);
    expect(wakeInputs(seen)).not.toHaveLength(0);
    expect(w.log.filter((line) => line.includes("read before the daemon bound"))).toEqual([]);
  });

  it("VT-3 c: a resumed turn's wake_list runs against bound dependencies", async () => {
    const w = await roomWorld({ enabled: true });
    await mkdir(dirname(w.config.storagePath), { recursive: true });
    // Seed: a turn left in flight, as a crash leaves it.
    w.faux.setResponses([heldUntilCutOff]);
    const seeded = await openSession(await openNodeSqliteStorage(w.config.storagePath), {
      models: w.models,
      registry: registryOf(
        daemonExtensions({
          personaFiles: () => [],
          projectContext: undefined,
          skills: [],
          profile: "room",
          tasks: tasksExtension(wakeBinding().deps),
        }),
      ),
      agent: { model: FAUX_MODEL, cwd: w.cwd },
      profile: "room",
      log: () => undefined,
      env: nodeEnv,
    });
    await seeded.root.submit({ type: "input", content: "hello" }, context);
    await vi.waitFor(() => {
      expect(w.faux.state.callCount).toBe(1);
    }, WAIT);
    await seeded.harness.close(context);

    w.faux.setResponses(callThenAnswer("wake_list", {}, "listed"));
    const handle = await started(w);
    await vi.waitFor(() => {
      expect(w.faux.state.callCount).toBeGreaterThanOrEqual(3);
    }, WAIT);
    await handle.stop();
    const results = await inStore(w, "room", (harness) => toolResults(harness));
    const listed = results.find((message) => message.toolName === "wake_list");
    expect(listed?.isError).toBe(false);
    expect(listed === undefined ? "" : textOf(listed)).toContain('"enabled"');
  });

  // Off is MALEBOLGE_WAKES unset (anything but "on"): resolveConfig's `wakes.enabled` false.
  it("VT-3 d: with wakes off an overdue heartbeat defers 'disabled' and fires once they are on", async () => {
    const { w, clock, id } = await overdueHeartbeat(false);
    const off = recordTurns(w.faux);
    const second = await started(w);
    await vi.waitFor(() => {
      expect(logged(w, new RegExp(`^wake ${id} n=\\d+ \\(room\\) defer disabled until `))).toBe(
        true,
      );
    }, WAIT);
    await second.stop();
    expect(wakeInputs(off)).toEqual([]);
    expect((await wakesInStore(w, "room")).map((wake) => String(wake.id))).toEqual([id]);

    w.config.wakes.enabled = true;
    clock.advance(2 * w.config.wakes.floorMs);
    const on = recordTurns(w.faux);
    await started(w);
    await vi.waitFor(() => {
      expect(wakeInputs(on)).not.toHaveLength(0);
    }, WAIT);
  });

  it("VT-3 e: a host start schedules no wake and logs none", async () => {
    const w = await world();
    await (await started(w)).stop();
    expect(await wakesInStore(w, "host")).toEqual([]);
    expect(w.log.filter((line) => line.startsWith("wake "))).toEqual([]);
  });

  it("VT-3 f: a failed heartbeat ensure fails the start and undoes it", async () => {
    const w = await roomWorld({ enabled: true });
    // `default` is reserved: setTopic refuses it, so the ensure throws after the resume.
    w.config.wakes.topic = "default";
    const failed = start(w);
    track(failed);
    await expect(failed).rejects.toThrow("default");
    lockFree(w.config);
    // The resumed session was closed, not leaked: nothing holds the store open.
    expect(openFilesUnder(dirname(w.config.storagePath))).toEqual([]);

    // The failed start closed the store too: the next one opens it and ensures one heartbeat.
    w.config.wakes.topic = "room";
    await started(w);
    expect(createdHeartbeats(w)).toHaveLength(1);
  });
});
