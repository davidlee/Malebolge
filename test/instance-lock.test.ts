import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { acquireInstanceLock, InstanceLocked } from "../src/instance-lock.ts";
import { type Child, childProcess, sourceUrl, tempDir } from "./fixtures.ts";

/** A lock path in a fresh directory that does not exist yet. */
async function lockPath(): Promise<string> {
  const { dir, cleanup } = await tempDir();
  onTestFinished(cleanup);
  return join(dir, "room", "daemon.lock");
}

/** A child process holding the lock at `path` until killed. */
async function holder(path: string): Promise<Child> {
  const child = await childProcess(`
    const { acquireInstanceLock } = await import(${sourceUrl("../src/instance-lock.ts")});
    acquireInstanceLock(${JSON.stringify(path)});
    console.log("held");
    setInterval(() => {}, 1000);
  `);
  onTestFinished(child.kill);
  return child;
}

/** What `run` throws; fails the test if it returns. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("did not throw");
}

describe("acquireInstanceLock", () => {
  it("refuses a second holder in the same process, naming the path", async () => {
    const path = await lockPath();
    const lock = acquireInstanceLock(path);
    onTestFinished(lock.release);
    expect(() => acquireInstanceLock(path)).toThrow(InstanceLocked);
    expect(() => acquireInstanceLock(path)).toThrow(path);
  });

  it("is acquirable again once released", async () => {
    const path = await lockPath();
    acquireInstanceLock(path).release();
    acquireInstanceLock(path).release();
  });

  it("refuses while another process holds it, and is freed when that process is killed", async () => {
    const path = await lockPath();
    const child = await holder(path);
    expect(() => acquireInstanceLock(path)).toThrow(InstanceLocked);
    await child.kill();
    acquireInstanceLock(path).release();
  });

  it("propagates a failure other than contention", async () => {
    const path = await lockPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not a database, and longer than a sqlite header is.......");
    expect(thrown(() => acquireInstanceLock(path))).not.toBeInstanceOf(InstanceLocked);
  });
});
