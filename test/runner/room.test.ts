import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonRecord } from "../../src/json.ts";
import { collectJob, retryPendingCollection } from "../../src/runner/collect.ts";
import { StartRefused } from "../../src/runner/errors.ts";
import { gitQuarantineReader } from "../../src/runner/git.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  channelFromConfig,
  jobBranch,
  roomConnection,
  type SlotCli,
  slotChannel,
} from "../../src/runner/room.ts";
import { isoTime } from "../../src/runner/rows.ts";
import { type Job, JobStore } from "../../src/runner/store.ts";
import { resultBody } from "../../src/runner/views.ts";
import { parseRunnerConfig } from "../../src/runner/config.ts";
import { exampleConfig, HOME, variant } from "./config-fixture.ts";
import { rejectionCode } from "./refusal-fixture.ts";
import {
  type CollectWorld,
  collectWorld,
  GUEST_PATH,
  MAX_PENDING_S,
  roomWorld,
  SLOT,
} from "./room-fixture.ts";
import { NEW_JOB, sequentialIds, T0 } from "./store-fixture.ts";

const JOB = "pj-1";
const JOB_REF = `refs/capsule/${SLOT}/heads/job/${JOB}`;

const spawnFails: SlotCli = () => Promise.reject(new Error("spawn capsule ENOENT"));

describe("the job branch", () => {
  it("is job/<id>", () => {
    expect(jobBranch(JOB)).toBe("job/pj-1");
  });
});

describe("refresh over a slot", () => {
  it("puts the real repo's branch tip on the guest's work, and returns its oid", async () => {
    const world = roomWorld();
    const tip = world.real.commit("src/new.ts");
    const before = world.real.snapshot();
    expect(await world.channel.refresh(world.repo, "main")).toBe(tip);
    expect(world.room.git("rev-parse", "work")).toBe(tip);
    expect(world.room.git("status", "--porcelain")).toBe("");
    expect(world.real.snapshot()).toBe(before);
  });

  it("refuses a base branch deleted since submit with base_ref_invalid", async () => {
    const world = roomWorld();
    expect(await rejectionCode(world.channel.refresh(world.repo, "gone"))).toBe("base_ref_invalid");
    expect(world.slot.calls).toEqual([]);
  });

  it("returns the guest to work after a job left it on job/<id> (provisional, pending H1)", async () => {
    const world = roomWorld();
    world.guestJob(JOB, "src/a.ts");
    const tip = world.real.commit("src/next.ts");
    expect(await world.channel.refresh(world.repo, "main")).toBe(tip);
    expect(world.room.git("symbolic-ref", "HEAD")).toBe("refs/heads/work");
    expect(world.slot.calls[0]).toEqual([SLOT, "ssh", "git", "-C", GUEST_PATH, "switch", "work"]);
  });

  it("is ChannelUnavailable when the room is down", async () => {
    const world = roomWorld();
    world.slot.up = false;
    await expect(world.channel.refresh(world.repo, "main")).rejects.toBeInstanceOf(
      ChannelUnavailable,
    );
  });

  it("is ChannelFailed when the room is up and the push is refused", async () => {
    const world = roomWorld();
    world.room.commit("guest-only");
    await expect(world.channel.refresh(world.repo, "main")).rejects.toBeInstanceOf(ChannelFailed);
  });
});

describe("collect over a slot", () => {
  it("fetches job/<id> into the quarantine and returns where it landed", async () => {
    const world = roomWorld();
    const tip = world.guestJob(JOB, "src/a.ts");
    expect(await world.channel.collect(world.repo, JOB)).toEqual({
      quarantine: world.quarantine.path,
      ref: JOB_REF,
      oid: tip,
    });
    expect(world.quarantine.git("rev-parse", JOB_REF)).toBe(tip);
  });

  it("reads only job/<id>: another guest branch changes neither ref nor oid", async () => {
    const world = roomWorld();
    world.guestJob("pj-other", "out/evil");
    world.room.git("switch", "--quiet", "work");
    const tip = world.guestJob(JOB, "src/a.ts");
    const collected = await world.channel.collect(world.repo, JOB);
    expect(collected).toMatchObject({ ref: JOB_REF, oid: tip });
  });

  it("is ChannelFailed when the guest has no job/<id>", async () => {
    const world = roomWorld();
    await expect(world.channel.collect(world.repo, JOB)).rejects.toThrow(ChannelFailed);
    await expect(world.channel.collect(world.repo, JOB)).rejects.toThrow(/not collected/);
  });

  it("is ChannelUnavailable when the room is down", async () => {
    const world = roomWorld();
    world.guestJob(JOB, "src/a.ts");
    world.slot.up = false;
    await expect(world.channel.collect(world.repo, JOB)).rejects.toBeInstanceOf(ChannelUnavailable);
  });

  it("is ChannelFailed when the command line cannot run", async () => {
    const world = roomWorld();
    const channel = slotChannel({ slot: SLOT, quarantine: world.quarantine.path }, spawnFails);
    await expect(channel.collect(world.repo, JOB)).rejects.toBeInstanceOf(ChannelFailed);
  });

  it("is ChannelFailed when the quarantine cannot be read", async () => {
    const world = roomWorld();
    world.guestJob(JOB, "src/a.ts");
    const channel = slotChannel({ slot: SLOT, quarantine: "/nonexistent/f.git" }, world.slot.cli);
    await expect(channel.collect(world.repo, JOB)).rejects.toBeInstanceOf(ChannelFailed);
  });

  it("carries paths with spaces and non-ASCII names through raw", async () => {
    const world = roomWorld();
    const base = world.room.git("rev-parse", "work");
    world.guestJob(JOB, "src/with space.ts", "src/naïve.ts");
    const { quarantine, oid } = await world.channel.collect(world.repo, JOB);
    const facts = await gitQuarantineReader.inspect(quarantine, base, oid);
    expect(facts.changedPaths).toEqual(["src/with space.ts", "src/naïve.ts"]);
  });
});

describe("reachable", () => {
  it("is the probe's answer", async () => {
    const world = roomWorld();
    expect(await world.channel.reachable()).toBe(true);
    world.slot.up = false;
    expect(await world.channel.reachable()).toBe(false);
    expect(world.slot.calls.at(-1)).toEqual([SLOT, "ssh", "true"]);
  });

  it("never throws: a command line that cannot run is unreachable", async () => {
    const channel = slotChannel({ slot: SLOT, quarantine: "/nowhere" }, spawnFails);
    expect(await channel.reachable()).toBe(false);
  });
});

describe("the channel from config", () => {
  it("builds a slot channel from the door table", async () => {
    const calls: (readonly string[])[] = [];
    const cli: SlotCli = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    expect(await channelFromConfig(exampleConfig(), cli).reachable()).toBe(true);
    expect(calls).toEqual([["f", "ssh", "true"]]);
  });

  it.each([
    ["no door table", withoutDoor, /\[door\]/],
    ["no slot", (): string => variant('slot = "f"\n', ""), /slot/],
    [
      "no quarantine",
      (): string => variant('quarantine = "~/state/collect/f.git"\n', ""),
      /quarantine/,
    ],
  ])("refuses to start with %s (I13)", (_label, text, reason) => {
    const config = parseRunnerConfig(text(), HOME);
    expect(() => channelFromConfig(config)).toThrow(StartRefused);
    expect(() => channelFromConfig(config)).toThrow(reason);
  });

  it("passes the profile to provision when the door names one", async () => {
    const calls: (readonly string[])[] = [];
    const cli: SlotCli = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const world = roomWorld();
    const config = parseRunnerConfig(variant('slot = "f"', 'slot = "f"\nprofile = "satan"'), HOME);
    await channelFromConfig(config, cli).refresh(world.repo, "main");
    expect(calls.at(-1)).toEqual([
      "f",
      "provision",
      world.real.git("rev-parse", "main"),
      "--profile",
      "satan",
    ]);
  });
});

describe("the room connection for the execution environment", () => {
  it("is the door's ssh facts", () => {
    expect(roomConnection(exampleConfig())).toEqual({
      sshConfig: "/home/test/.ssh/config",
      identity: "/home/test/.ssh/id",
      knownHosts: "/home/test/.ssh/known_hosts",
    });
  });

  it("refuses to start without a door table", () => {
    expect(() => roomConnection(parseRunnerConfig(withoutDoor(), HOME))).toThrow(StartRefused);
  });
});

/** The example config with its door table and keys removed. */
function withoutDoor(): string {
  const text = variant("[door]", "");
  return text
    .split("\n")
    .filter((line) => !/^(slot|quarantine|ssh_config|identity|known_hosts) =/.test(line))
    .join("\n");
}

// --- EX-3: nothing outside room.ts and config knows the door (ASM-005) -------------

const SRC = join(import.meta.dirname, "../../src");
const DOOR_WORDS = /\bcapsule|\bslot|\bdoor/i;
const DOOR_OWNERS = new Set(["runner/room.ts", "runner/config.ts"]);

function sourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

describe("door knowledge (EX-3)", () => {
  it("lives only in room.ts and config.ts", () => {
    const knowing = sourceFiles(SRC).filter((file) =>
      DOOR_WORDS.test(readFileSync(join(SRC, file), "utf8")),
    );
    expect(knowing.sort()).toEqual([...DOOR_OWNERS].sort());
  });
});

// --- collection and classification (EX-2) -----------------------------------------

const lastPayload = async (world: CollectWorld, kind: string): Promise<JsonRecord | undefined> =>
  (await world.events()).findLast((event) => event.kind === kind)?.payload;

/** In the guest: delete `file` on the current branch, as a commit. */
function guestDelete(world: CollectWorld, file: string): void {
  world.room.git("rm", "--quiet", "--", file);
  world.room.git("commit", "--quiet", "-m", `drop ${file}`);
}

describe("collection: a clean job", () => {
  it("records reviewed_oid and the ref, and reaches needs_review as complete", async () => {
    const world = await collectWorld();
    const tip = world.guestJob(world.jobId, "src/a.ts", "src/b.ts");
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    expect(job).toMatchObject({
      state: "needs_review",
      class: "complete",
      reviewedOid: tip,
      quarantineRef: `refs/capsule/${SLOT}/heads/job/${world.jobId}`,
    });
    expect(job.failure).toBeUndefined();
    expect(await world.job()).toEqual(job);
  });

  it("records commits and diffstat in the collected event, and result shows them", async () => {
    const world = await collectWorld();
    const tip = world.guestJob(world.jobId, "src/a.ts");
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    const collected = await lastPayload(world, "collected");
    expect(collected).toEqual({
      quarantine: world.quarantine.path,
      quarantineRef: job.quarantineRef,
      reviewedOid: tip,
      commits: [{ oid: tip, subject: "add src/a.ts" }],
      diffstat: { files: 1, insertions: 1, deletions: 0 },
    });
    expect(resultBody(job, collected)).toMatchObject({
      baseOid: world.base,
      reviewedOid: tip,
      quarantine: world.quarantine.path,
      commits: [{ oid: tip, subject: "add src/a.ts" }],
      diffstat: { files: 1, insertions: 1, deletions: 0 },
    });
    expect(await lastPayload(world, "transition")).toMatchObject({
      from: "collecting",
      to: "needs_review",
      class: "complete",
      flagged: false,
      offending: [],
    });
  });

  it("reads only job/<id>: another guest branch outside the allowlist does not count", async () => {
    const world = await collectWorld();
    world.guestJob("pj-other", "out/evil");
    world.room.git("switch", "--quiet", "work");
    world.guestJob(world.jobId, "src/a.ts");
    expect(await collectJob(world.deps, world.jobId, T0 + 10)).toMatchObject({
      state: "needs_review",
      class: "complete",
    });
  });
});

describe("collection: the allowlist over every commit (I6)", () => {
  it("is a path_violation when a commit touched a path the tip no longer has", async () => {
    const world = await collectWorld();
    world.guestJob(world.jobId, "src/a.ts", "out/x");
    guestDelete(world, "out/x");
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    expect(job).toMatchObject({
      state: "failed",
      class: "path_violation",
      failure: { reason: "path_violation", offending: ["out/x"] },
    });
    expect(await lastPayload(world, "collected")).toMatchObject({
      diffstat: { files: 1, insertions: 1, deletions: 0 },
    });
  });

  it("is a path_violation when a merge commit brings in a disallowed path", async () => {
    const world = await collectWorld();
    world.room.git("switch", "--quiet", "-c", "side", "work");
    world.room.commit("out/side");
    world.guestJob(world.jobId, "src/a.ts");
    world.room.git("merge", "--quiet", "--no-ff", "-m", "merge side", "side");
    expect(await collectJob(world.deps, world.jobId, T0 + 10)).toMatchObject({
      state: "failed",
      class: "path_violation",
      failure: { offending: ["out/side"] },
    });
  });

  it.each([
    ["rewritten onto an orphan history", false],
    ["rewritten, and base_oid absent from the quarantine", true],
  ])("is a path_violation when job/<id> is %s", async (_label, dropBase) => {
    const world = await collectWorld();
    world.room.git("switch", "--quiet", "--orphan", `job/${world.jobId}`);
    world.room.commit("src/a.ts");
    if (dropBase) {
      world.room.git("branch", "--quiet", "-D", "work", "main");
    }
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    expect(job).toMatchObject({
      state: "failed",
      class: "path_violation",
      failure: { reason: "path_violation" },
    });
    expect(world.quarantine.git("for-each-ref").includes(world.base)).toBe(!dropBase);
  });

  it("is no_changes when job/<id> has no commits beyond base_oid", async () => {
    const world = await collectWorld();
    world.guestJob(world.jobId);
    expect(await collectJob(world.deps, world.jobId, T0 + 10)).toMatchObject({
      state: "failed",
      class: "no_changes",
      reviewedOid: world.base,
    });
  });
});

describe("collection: how execution ended", () => {
  it.each([
    ["cancelled", "cancelled", "partial", false],
    ["error", "failed", "error", false],
    ["ceiling_exceeded", "needs_review", "partial", true],
  ] as const)("ended %s → %s, class %s", async (endReason, state, jobClass, flagged) => {
    const world = await collectWorld(endReason);
    world.guestJob(world.jobId, "src/a.ts");
    expect(await collectJob(world.deps, world.jobId, T0 + 10)).toMatchObject({
      state,
      class: jobClass,
      endReason,
    });
    expect(await lastPayload(world, "transition")).toMatchObject({ flagged });
  });

  it("is an error when the guest has no job/<id>", async () => {
    const world = await collectWorld();
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    expect(job).toMatchObject({ state: "failed", class: "error" });
    expect(job.failure).toMatchObject({ reason: "collection_failed" });
    expect(job.reviewedOid).toBeUndefined();
  });

  it("fails closed when the job's repo is gone from config", async () => {
    const world = await collectWorld();
    const deps = { ...world.deps, config: { ...world.deps.config, repos: new Map() } };
    expect(await collectJob(deps, world.jobId, T0 + 10)).toMatchObject({
      state: "failed",
      class: "error",
      failure: { reason: "repo_not_configured" },
    });
  });

  it("records reviewed_oid and fails as an error when the checks cannot run", async () => {
    const world = await collectWorld();
    const tip = world.guestJob(world.jobId, "src/a.ts");
    const quarantine = { inspect: (): Promise<never> => Promise.reject(new Error("disk gone")) };
    const job = await collectJob({ ...world.deps, quarantine }, world.jobId, T0 + 10);
    expect(job).toMatchObject({
      state: "failed",
      class: "error",
      reviewedOid: tip,
      failure: { reason: "check_failed", message: "disk gone" },
    });
    expect(await lastPayload(world, "collected")).not.toHaveProperty("commits");
  });

  it("fails closed on a collecting row without base_oid", async () => {
    const world = await collectWorld();
    const { job: bare } = await world.jobs.submit({ ...NEW_JOB, submissionId: "sub-2" }, T0);
    for (const state of ["preparing", "running", "collecting"] as const) {
      await world.jobs.transition(bare.id, state, T0);
    }
    expect(await collectJob(world.deps, bare.id, T0 + 10)).toMatchObject({
      state: "failed",
      class: "error",
      failure: { reason: "corrupt_job" },
    });
  });

  it("refuses a job that is not collecting", async () => {
    const world = await collectWorld();
    world.guestJob(world.jobId, "src/a.ts");
    await collectJob(world.deps, world.jobId, T0 + 10);
    expect(await rejectionCode(collectJob(world.deps, world.jobId, T0 + 20))).toBe(
      "invalid_transition",
    );
  });
});

describe("collection: the room is down (ChannelUnavailable → pending_collection)", () => {
  const MAX_MS = MAX_PENDING_S * 1000;

  async function pendingWorld(): Promise<CollectWorld> {
    const world = await collectWorld();
    world.guestJob(world.jobId, "src/a.ts");
    world.slot.up = false;
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    expect(job).toMatchObject({ state: "pending_collection", stateEnteredAt: T0 + 10 });
    expect(await lastPayload(world, "transition")).toMatchObject({
      reason: "channel_unavailable",
    });
    return world;
  }

  it("waits without a write while the room stays down", async () => {
    const world = await pendingWorld();
    const before = { job: await world.job(), events: await world.events() };
    await retryPendingCollection(world.deps, world.jobId, T0 + 20);
    expect({ job: await world.job(), events: await world.events() }).toEqual(before);
  });

  it("collects once the room is reachable again", async () => {
    const world = await pendingWorld();
    world.slot.up = true;
    const job = await retryPendingCollection(world.deps, world.jobId, T0 + 20);
    expect(job).toMatchObject({ state: "needs_review", class: "complete" });
    const moves = (await world.events())
      .filter((event) => event.kind === "transition")
      .map((event) => event.payload["to"]);
    expect(moves.slice(-3)).toEqual(["pending_collection", "collecting", "needs_review"]);
  });

  it("abandons at max_pending_collection, counted from state_entered_at across restarts", async () => {
    const world = await pendingWorld();
    await retryPendingCollection(world.deps, world.jobId, T0 + 10 + MAX_MS - 1);
    expect((await world.job()).state).toBe("pending_collection");
    world.slot.up = true;
    const job = await retryPendingCollection(world.deps, world.jobId, T0 + 10 + MAX_MS);
    expect(job).toMatchObject({
      state: "failed",
      class: "error",
      failure: { reason: "collection_abandoned", pendingSince: isoTime(T0 + 10) },
    });
    expect(job.reviewedOid).toBeUndefined();
  });

  it("refuses a job that is not pending_collection", async () => {
    const world = await collectWorld();
    expect(await rejectionCode(retryPendingCollection(world.deps, world.jobId, T0))).toBe(
      "invalid_transition",
    );
  });
});

/** A job store that crashes once on the way to needs_review: between collection's two writes. */
class CrashBeforeReview extends JobStore {
  #crashed = false;

  override transition(...args: Parameters<JobStore["transition"]>): Promise<Job> {
    if (args[1] === "needs_review" && !this.#crashed) {
      this.#crashed = true;
      return Promise.reject(new Error("crash"));
    }
    return super.transition(...args);
  }
}

describe("collection: reviewed_oid is immutable (I7)", () => {
  async function crashedAfterRecord(): Promise<{ world: CollectWorld; tip: string }> {
    const world = await collectWorld(
      "completed",
      (db) => new CrashBeforeReview(db, sequentialIds()),
    );
    const tip = world.guestJob(world.jobId, "src/a.ts");
    await expect(collectJob(world.deps, world.jobId, T0 + 10)).rejects.toThrow("crash");
    expect(await world.job()).toMatchObject({ state: "collecting", reviewedOid: tip });
    return { world, tip };
  }

  it("redo after a crash with the same tip is idempotent", async () => {
    const { world, tip } = await crashedAfterRecord();
    const job = await collectJob(world.deps, world.jobId, T0 + 20);
    expect(job).toMatchObject({ state: "needs_review", reviewedOid: tip });
    expect((await world.events()).filter((event) => event.kind === "collected")).toHaveLength(1);
  });

  it("a job branch moved after reviewed_oid was recorded fails, the oid unchanged", async () => {
    const { world, tip } = await crashedAfterRecord();
    const moved = world.room.commit("src/later.ts");
    const job = await collectJob(world.deps, world.jobId, T0 + 20);
    expect(job).toMatchObject({
      state: "failed",
      class: "error",
      reviewedOid: tip,
      failure: { reason: "reviewed_oid_mismatch", recorded: tip, collected: moved },
    });
  });
});
