// The room's clone hygiene after collection (VT-8, EX-7, EX-8; design §5.2,
// §5.4 step 2): once a collect is recorded, `git reset --hard` and
// `git clean -ffd` in `guest_path`, through a connection of collection's own
// that only counts its losses. Real git in a room-kind world, the clean run by
// a local pi-env daemon. Collection's classification is room.test.ts's.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Connection, HostKeyChangedError } from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import { jobEnvId } from "../../src/runner/env.ts";
import { collectJob } from "../../src/runner/collect.ts";
import { daemonConnection } from "../../src/room/connection.ts";
import { cleanRoomClone } from "../../src/runner/door.ts";
import { roomShell } from "../../src/room/shell.ts";
import { fakeHelpers, localConnection, lostConnection } from "../room/connection-fixture.ts";
import { exampleConfig, roomConfig } from "./config-fixture.ts";
import { doorFacts } from "./env-fixture.ts";
import { type CollectWorld, type RoomKindWorld, roomKindCollectWorld } from "./room-fixture.ts";
import { T0 } from "./store-fixture.ts";

type World = CollectWorld<RoomKindWorld>;

/** A collecting job whose agent committed `src/a.ts`, and left residue of every sort in the clone. */
async function withResidue(): Promise<World & { tip: string }> {
  const world = await roomKindCollectWorld();
  const tip = world.guestJob(world.jobId, "src/a.ts");
  const at = (...parts: string[]): string => join(world.room.path, ...parts);
  writeFileSync(at(".git", "info", "exclude"), "cache/\n");
  mkdirSync(at("cache"));
  writeFileSync(at("cache", "built.o"), "ignored\n");
  writeFileSync(at("src", "a.ts"), "edited, never committed\n");
  writeFileSync(at("notes.txt"), "untracked\n");
  mkdirSync(at("vendored"));
  world.room.git("-C", at("vendored"), "init", "--quiet");
  writeFileSync(at("vendored", "x"), "a nested repo\n");
  return { ...world, tip };
}

/** The clone as `git status` shows it, ignored files included. */
const status = (world: World): string => world.room.git("status", "--porcelain", "--ignored");

const CLEANED = "!! cache/";

const kinds = async (world: World): Promise<string[]> =>
  (await world.events()).map((event) => event.kind);

describe("after a successful collect: git reset --hard, git clean -ffd", () => {
  it("resets tracked edits and removes untracked files and nested repos; ignored files are kept", async () => {
    const world = await withResidue();
    expect(status(world)).not.toBe(CLEANED);

    const job = await collectJob(world.deps, world.jobId, T0 + 10);

    expect(job).toMatchObject({ state: "needs_review", reviewedOid: world.tip });
    expect(status(world)).toBe(CLEANED);
    expect(world.room.git("rev-parse", "HEAD")).toBe(world.tip);
    expect(await kinds(world)).not.toContain("clean_failed");
  });

  it("is idempotent: a clean clone cleaned again is unchanged", async () => {
    const world = await withResidue();
    await collectJob(world.deps, world.jobId, T0 + 10);
    const connection = localConnection();
    try {
      await cleanRoomClone(
        roomShell(connection, { id: jobEnvId(world.jobId), cwd: world.room.path }),
        new AbortController().signal,
      );
    } finally {
      connection.close();
    }
    expect(status(world)).toBe(CLEANED);
  });

  it.each([
    ["fails (exit 1)", 1, "failed"],
    ["finds the room down (exit 75)", 75, "pending_collection"],
  ])("a collect that %s leaves the clone untouched", async (_case, exit, state) => {
    const world = await withResidue();
    const before = status(world);
    world.capsule.exit = exit;

    const job = await collectJob(world.deps, world.jobId, T0 + 10);

    expect(job.state).toBe(state);
    expect(status(world)).toBe(before);
  });
});

describe("a clean that fails: audited, the job's outcome unchanged", () => {
  /** `world` collected with every clean connection from `connect`; the job and its events. */
  async function collectedWith(
    world: World & { tip: string },
    connect: () => Connection,
  ): Promise<void> {
    world.deps.connect = connect;
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    expect(job).toMatchObject({ state: "needs_review", class: "complete", reviewedOid: world.tip });
  }

  it("a git failure in the clone (a stale index.lock) is clean_failed channel_failed", async () => {
    const world = await withResidue();
    writeFileSync(join(world.room.path, ".git", "index.lock"), "");

    await collectedWith(world, () => localConnection());

    const failed = (await world.events()).find((event) => event.kind === "clean_failed");
    expect(failed?.payload).toMatchObject({ reason: "channel_failed" });
    expect(String(failed?.payload["message"])).toContain("reset");
  });

  // Carry-forward 5 (EX-8), the clean's half: either kind's daemon connection, counted, never a pause.
  describe.each([
    ["slot", exampleConfig],
    ["room", roomConfig],
  ])("over a %s door's daemon connection", (_kind, config) => {
    it("a room stop during the clean writes no pause_requested and no pause event", async () => {
      const world = await withResidue();
      const { facts, launch } = doorFacts(config());

      await collectedWith(world, () => daemonConnection(facts, launch, fakeHelpers("false")));

      expect((await world.job()).pauseRequested).toBe(false);
      expect(await kinds(world)).not.toContain("pause");
      const failed = (await world.events()).find((event) => event.kind === "clean_failed");
      expect(failed?.payload).toMatchObject({ reason: "channel_unavailable" });
      expect(status(world)).not.toBe(CLEANED);
    });

    it("a changed host key at the clean's start is clean_failed host_key, never a pause", async () => {
      const world = await withResidue();
      const { facts, launch } = doorFacts(config());
      const changed = (): Error => new HostKeyChangedError("changed");

      await collectedWith(world, () =>
        daemonConnection(facts, launch, fakeHelpers("ssh", changed)),
      );

      expect((await world.job()).pauseRequested).toBe(false);
      expect((await world.events()).find((e) => e.kind === "clean_failed")?.payload).toMatchObject({
        reason: "host_key",
      });
    });
  });

  it("a lost connection is counted: clean_failed channel_unavailable", async () => {
    const world = await withResidue();
    await collectedWith(world, lostConnection);
    expect(await kinds(world)).toContain("clean_failed");
    expect(await kinds(world)).not.toContain("pause");
  });
});

describe("a crash between collect and clean (EX-7)", () => {
  it("leaves collecting with the residue; collecting again (restart row 12) cleans, collected once", async () => {
    const world = await withResidue();
    const before = status(world);
    world.deps.connect = (): Connection => {
      throw new Error("the process died");
    };

    await expect(collectJob(world.deps, world.jobId, T0 + 10)).rejects.toThrow("died");
    expect(await world.job()).toMatchObject({ state: "collecting", reviewedOid: world.tip });
    expect(status(world)).toBe(before);

    world.deps.connect = (): Connection => localConnection();
    const job = await collectJob(world.deps, world.jobId, T0 + 20);

    expect(job.state).toBe("needs_review");
    expect(status(world)).toBe(CLEANED);
    expect((await kinds(world)).filter((kind) => kind === "collected")).toHaveLength(1);
  });
});
