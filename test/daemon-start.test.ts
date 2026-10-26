import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Config } from "../src/config.ts";
import { type DaemonHandle, startDaemon } from "../src/daemon-start.ts";
import { acquireInstanceLock, InstanceLocked } from "../src/instance-lock.ts";
import { serveUnix, SocketInUse } from "../src/unix-socket.ts";
import { type FakeTool, fakeMcpServer, rejection, staleSocket, tempDir } from "./fixtures.ts";
import { FAUX_MODEL, fauxModels } from "./harness-fixture.ts";

interface World {
  config: Config;
  log: string[];
  models: Models;
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
    execution: { profile: "host", cwd },
  };
  return { config, log: [], models: fauxModels().models };
}

const start = (world: World): Promise<DaemonHandle> =>
  startDaemon(world.config, {
    log: (line) => {
      world.log.push(line);
    },
    models: world.models,
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
