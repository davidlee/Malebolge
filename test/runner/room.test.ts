import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonRecord } from "../../src/json.ts";
import { collectJob, retryPendingCollection } from "../../src/runner/collect.ts";
import { StartRefused } from "../../src/runner/errors.ts";
import { gitQuarantineReader } from "../../src/runner/git.ts";
import { ChannelFailed, ChannelUnavailable, type RoomShell } from "../../src/room/shell.ts";
import {
  channelFromConfig,
  jobBranch,
  type CapsuleCli,
  roomChannel,
  roomConnection,
  slotChannel,
} from "../../src/runner/door.ts";
import { runProgram } from "../../src/runner/exec.ts";
import { isoTime } from "../../src/runner/rows.ts";
import { type Job, JobStore } from "../../src/runner/store.ts";
import { resultBody } from "../../src/runner/views.ts";
import { parseRunnerConfig } from "../../src/runner/config.ts";
import { configEntry } from "../../src/runner/policy.ts";
import { EXAMPLE_TOML, exampleConfig, HOME, roomConfig, variant } from "./config-fixture.ts";
import { rejectionCode } from "./refusal-fixture.ts";
import {
  type CollectWorld,
  collectWorld,
  GUEST_PATH,
  MAX_PENDING_S,
  ROOM,
  ROOM_DOOR,
  type RoomKindWorld,
  roomKindCollectWorld,
  readying,
  roomKindWorld,
  roomWorld,
  SLOT,
} from "./room-fixture.ts";
import { NEW_JOB, sequentialIds, T0 } from "./store-fixture.ts";

const JOB = "pj-1";
const JOB_REF = `refs/capsule/${SLOT}/heads/job/${JOB}`;

const spawnFails: CapsuleCli = () => Promise.reject(new Error("spawn capsule ENOENT"));

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
    expect(await world.channel.reachable(world.repo, JOB)).toBe(true);
    world.slot.up = false;
    expect(await world.channel.reachable(world.repo, JOB)).toBe(false);
    expect(world.slot.calls.at(-1)).toEqual([SLOT, "ssh", "true"]);
  });

  it("never throws: a command line that cannot run is unreachable", async () => {
    const world = roomWorld();
    const channel = slotChannel({ slot: SLOT, quarantine: "/nowhere" }, spawnFails);
    expect(await channel.reachable(world.repo, JOB)).toBe(false);
  });
});

// --- the room adapter (SL-006 design sec-6 at oubliette 73ec574, collect's stdout ad2dd7d) ---

const ROOM_JOB_REF = `refs/capsule/${ROOM}/heads/job/${JOB}`;

/** A room world whose base is pushed into the guest clone, and `job/<JOB>` committed there. */
async function roomWithJob(...files: string[]): Promise<{ world: RoomKindWorld; tip: string }> {
  const world = roomKindWorld();
  await world.channel.refresh(world.repo, "main");
  return { world, tip: world.guestJob(JOB, ...files) };
}

/** `cli`, running `before` first: the world changing between the adapter's steps. */
const after =
  (before: () => void, cli: CapsuleCli): CapsuleCli =>
  (args, options) => {
    before();
    return cli(args, options);
  };

describe("refresh over a room", () => {
  it("pushes base_ref and returns push's stdout oid; the guest's worktree untouched", async () => {
    const world = roomKindWorld();
    const tip = world.real.commit("src/new.ts");
    const before = world.real.snapshot();
    expect(await world.channel.refresh(world.repo, "main")).toBe(tip);
    expect(world.capsule.calls).toEqual([[ROOM, "push", "satan", "main"]]);
    expect(world.room.git("rev-parse", "refs/host/main")).toBe(tip);
    expect(world.room.git("status", "--porcelain")).toBe("");
    expect(world.real.snapshot()).toBe(before);
  });

  it("returns the oid push delivered, not one it resolved itself", async () => {
    const world = roomKindWorld();
    let moved = "";
    const channel = roomChannel(
      ROOM_DOOR,
      after(() => {
        moved = world.real.commit("src/racing.ts");
      }, world.capsule.cli),
    );
    expect(await channel.refresh(world.repo, "main")).toBe(moved);
  });

  it("checks refs/heads/<base_ref> first: absent is base_ref_invalid, and nothing is pushed", async () => {
    const world = roomKindWorld();
    expect(await rejectionCode(world.channel.refresh(world.repo, "gone"))).toBe("base_ref_invalid");
    expect(world.capsule.calls).toEqual([]);
  });

  it("is base_ref_invalid when push exits 2 because the branch went after the check", async () => {
    const world = roomKindWorld();
    world.real.git("switch", "--quiet", "-c", "doomed");
    world.real.commit("src/doomed.ts");
    world.real.git("switch", "--quiet", "main");
    const channel = roomChannel(
      ROOM_DOOR,
      after(() => world.real.git("branch", "--quiet", "-D", "doomed"), world.capsule.cli),
    );
    expect(await rejectionCode(channel.refresh(world.repo, "doomed"))).toBe("base_ref_invalid");
  });

  it("is ChannelFailed marked a refusal when push exits 2 with the branch still there", async () => {
    const world = roomKindWorld();
    world.capsule.exit = 2;
    const error = await world.channel
      .refresh(world.repo, "main")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelFailed);
    expect(error).toMatchObject({ reason: "channel_refusal" });
  });

  it("is ChannelFailed when push prints something other than an oid", async () => {
    const world = roomKindWorld();
    const channel = roomChannel(ROOM_DOOR, () =>
      Promise.resolve({ code: 0, stdout: "pushed\n", stderr: "" }),
    );
    await expect(channel.refresh(world.repo, "main")).rejects.toThrow(/not an oid/);
  });
});

describe("collect over a room", () => {
  it("collects job/<id> into the repo's quarantine under refs/capsule/<room>/", async () => {
    const { world, tip } = await roomWithJob("src/a.ts");
    expect(await world.channel.collect(world.repo, JOB)).toEqual({
      quarantine: world.repo.quarantine,
      ref: ROOM_JOB_REF,
      oid: tip,
    });
    expect(world.capsule.calls.at(-1)).toEqual([ROOM, "collect", "satan", `job/${JOB}`]);
    expect(world.quarantine.git("rev-parse", ROOM_JOB_REF)).toBe(tip);
  });

  it("refuses any ref but refs/capsule/<room>/heads/job/<id>", async () => {
    const { world } = await roomWithJob("src/a.ts");
    const elsewhere: CapsuleCli = async (args, options) => {
      const output = await world.capsule.cli(args, options);
      world.quarantine.git("update-ref", "refs/capsule/other/heads/job/pj-1", ROOM_JOB_REF);
      world.quarantine.git("update-ref", "-d", ROOM_JOB_REF);
      return output;
    };
    const channel = roomChannel(ROOM_DOOR, elsewhere);
    await expect(channel.collect(world.repo, JOB)).rejects.toThrow(ChannelFailed);
  });

  // VT-2: stdout is one line `<oid>\t<ref>` (SL-006 sec-6), cross-checked against the quarantine.
  it.each([
    ["another oid", (_oid: string, ref: string): string => `${"0".repeat(40)}\t${ref}\n`],
    ["another ref", (oid: string): string => `${oid}\trefs/capsule/${ROOM}/heads/job/other\n`],
    ["the ref first", (oid: string, ref: string): string => `${ref}\t${oid}\n`],
    ["a space for the tab", (oid: string, ref: string): string => `${oid} ${ref}\n`],
    ["two lines", (oid: string, ref: string): string => `${oid}\t${ref}\n${oid}\t${ref}\n`],
    ["nothing", (): string => ""],
  ])(
    "is ChannelFailed when stdout gives %s, not the quarantine's refs/capsule/<room>/ ref",
    async (_label, print) => {
      const { world } = await roomWithJob("src/a.ts");
      world.capsule.collectStdout = print;
      await expect(world.channel.collect(world.repo, JOB)).rejects.toMatchObject({
        name: "ChannelFailed",
        reason: "channel_failed",
      });
    },
  );

  it("is ChannelFailed when the guest has no job/<id> (exit 1)", async () => {
    const world = roomKindWorld();
    await world.channel.refresh(world.repo, "main");
    await expect(world.channel.collect(world.repo, JOB)).rejects.toMatchObject({
      name: "ChannelFailed",
      reason: "channel_failed",
    });
  });

  it("is ChannelFailed for a repo without the room's keys", async () => {
    const { world } = await roomWithJob("src/a.ts");
    const { quarantine, ...bare } = world.repo;
    expect(quarantine).toBeDefined();
    await expect(world.channel.collect(bare, JOB)).rejects.toThrow(/quarantine/);
  });
});

const pushVerb = (world: RoomKindWorld): Promise<unknown> =>
  world.channel.refresh(world.repo, "main");
const collectVerb = (world: RoomKindWorld): Promise<unknown> =>
  world.channel.collect(world.repo, JOB);
/** The two transfer verbs, each run through the port member that drives it. */
const verbs = [
  ["push", pushVerb],
  ["collect", collectVerb],
] as const;

describe("room verbs typed by exit code alone", () => {
  it.each(verbs)("%s exit 75 is ChannelUnavailable, with no probe", async (verb, run) => {
    const { world } = await roomWithJob("src/a.ts");
    world.capsule.up = false;
    const calls = world.capsule.calls.length;
    const error = await run(world).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelUnavailable);
    expect(error).toMatchObject({ reason: "channel_unavailable" });
    expect(world.capsule.calls.slice(calls)).toEqual([[ROOM, verb, "satan", expect.any(String)]]);
  });

  it.each(verbs)("%s exit 1 is ChannelFailed, not a refusal: never a pause", async (_verb, run) => {
    const { world } = await roomWithJob("src/a.ts");
    world.capsule.exit = 1;
    const error = await run(world).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelFailed);
    expect(error).toMatchObject({ reason: "channel_failed" });
  });

  it.each(verbs)("%s exit 2 is ChannelFailed marked a refusal", async (_verb, run) => {
    const { world } = await roomWithJob("src/a.ts");
    world.capsule.exit = 2;
    await expect(run(world)).rejects.toMatchObject({
      name: "ChannelFailed",
      reason: "channel_refusal",
    });
  });

  it("is ChannelFailed when the command line cannot run", async () => {
    const world = roomKindWorld();
    const channel = roomChannel(ROOM_DOOR, spawnFails);
    await expect(channel.refresh(world.repo, "main")).rejects.toMatchObject({
      name: "ChannelFailed",
      reason: "channel_failed",
    });
  });
});

describe("room verbs past their bound: transfer_timeout_s (no probe_timeout_s: the probe is a collect)", () => {
  it("bounds push, collect and the probe alike by the repo's transfer_timeout_s", async () => {
    const { world } = await roomWithJob("src/a.ts");
    await world.channel.collect(world.repo, JOB);
    await world.channel.reachable(world.repo, JOB);
    expect(world.capsule.timeouts).toEqual([600_000, 600_000, 600_000]);
    expect(world.capsule.calls.at(-1)).toEqual([ROOM, "collect", "satan", `job/${JOB}`]);
  });

  it.each(verbs)(
    "%s past it is ChannelUnavailable audited channel_timeout, not exit 75",
    async (_verb, run) => {
      const { world } = await roomWithJob("src/a.ts");
      world.capsule.hang = true;
      const error = await run(world).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChannelUnavailable);
      expect(error).toMatchObject({ reason: "channel_timeout" });
    },
  );

  it("a probe past it is unreachable", async () => {
    const world = roomKindWorld();
    world.capsule.hang = true;
    expect(await world.channel.reachable(world.repo, JOB)).toBe(false);
    expect(world.capsule.timeouts.at(-1)).toBe(600_000);
  });

  /** A `capsule` that never exits, run for real: its group is killed at the bound. */
  const neverExits: CapsuleCli = (_args, options) =>
    runProgram("sleep", ["60"], { ...options, killGraceMs: 200 });

  it("a real verb that never exits is killed at its bound and is channel_timeout", async () => {
    const world = roomKindWorld();
    const channel = roomChannel(ROOM_DOOR, neverExits);
    const repo = { ...world.repo, transferTimeoutS: 1 };
    await expect(channel.refresh(repo, "main")).rejects.toMatchObject({
      name: "ChannelUnavailable",
      reason: "channel_timeout",
    });
    expect(await channel.reachable(repo, JOB)).toBe(false);
  });
});

describe("a preparing room verb past transfer_timeout_s, within max_room_wait (VT-2)", () => {
  it("is retried with backoff: the base recorded once the push answers", async () => {
    const world = roomKindWorld({ guestAtClone: true });
    world.capsule.hang = true;
    const r = await readying(world, {
      onSleep: () => {
        world.capsule.hang = false;
      },
    });

    const base = await r.ready();

    expect(r.slept).toEqual([1000]);
    expect(base).toBe(world.real.git("rev-parse", "main"));
    expect(world.room.git("rev-parse", `job/${r.job.id}`)).toBe(base);
  });

  it("past max_room_wait: failed room_unavailable, audited channel_timeout", async () => {
    const world = roomKindWorld({ guestAtClone: true });
    world.capsule.hang = true;
    const r = await readying(world, { maxRoomWaitS: 2.5 });

    await expect(r.ready()).rejects.toMatchObject({
      failure: { reason: "room_unavailable", channel: "channel_timeout" },
    });
    expect(r.slept).toEqual([1000, 1500]);
  });
});

describe("clone hygiene over a slot: nothing to check or clean (A1)", () => {
  it("never touches the shell", async () => {
    const world = roomWorld();
    const shell: RoomShell = () => Promise.reject(new Error("refresh owns the slot's clone"));
    const signal = new AbortController().signal;

    await expect(world.channel.checkClone(shell, world.repo, signal)).resolves.toBeUndefined();
    await expect(world.channel.cleanClone(shell, signal)).resolves.toBeUndefined();
  });
});

describe("reachable(repo, job) over a room is this job's collect (DEC-060, VT-1)", () => {
  it("exit 0 is reachable: capsule <room> collect <repo> job/<id>, landed in the quarantine", async () => {
    const { world, tip } = await roomWithJob("src/a.ts");
    expect(await world.channel.reachable(world.repo, JOB)).toBe(true);
    expect(world.capsule.calls.at(-1)).toEqual([ROOM, "collect", "satan", `job/${JOB}`]);
    expect(world.quarantine.git("rev-parse", ROOM_JOB_REF)).toBe(tip);
  });

  it("exit 75 is unreachable", async () => {
    const { world } = await roomWithJob("src/a.ts");
    world.capsule.up = false;
    expect(await world.channel.reachable(world.repo, JOB)).toBe(false);
  });

  it("past transfer_timeout_s is unreachable", async () => {
    const { world } = await roomWithJob("src/a.ts");
    world.capsule.hang = true;
    expect(await world.channel.reachable(world.repo, JOB)).toBe(false);
    expect(world.capsule.timeouts.at(-1)).toBe(600_000);
  });

  it("exit 1 (a changed host key, refused auth) throws ChannelFailed: a trust failure is never downtime", async () => {
    const { world } = await roomWithJob("src/a.ts");
    world.capsule.exit = 1;
    await expect(world.channel.reachable(world.repo, JOB)).rejects.toMatchObject({
      name: "ChannelFailed",
      reason: "channel_failed",
    });
  });

  it("exit 2 throws ChannelFailed marked a refusal", async () => {
    const { world } = await roomWithJob("src/a.ts");
    world.capsule.exit = 2;
    await expect(world.channel.reachable(world.repo, JOB)).rejects.toMatchObject({
      name: "ChannelFailed",
      reason: "channel_refusal",
    });
  });

  it("throws ChannelFailed when stdout disagrees with the quarantine", async () => {
    const { world } = await roomWithJob("src/a.ts");
    world.capsule.collectStdout = (): string => "";
    await expect(world.channel.reachable(world.repo, JOB)).rejects.toMatchObject({
      name: "ChannelFailed",
    });
  });

  it("throws ChannelFailed when the command line cannot run, as collect does (a deploy fault)", async () => {
    const world = roomKindWorld();
    const channel = roomChannel(ROOM_DOOR, spawnFails);
    await expect(channel.reachable(world.repo, JOB)).rejects.toMatchObject({
      name: "ChannelFailed",
      reason: "channel_failed",
    });
  });
});

describe("the channel from config", () => {
  it("builds a slot channel from the door table", async () => {
    const calls: (readonly string[])[] = [];
    const cli: CapsuleCli = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const config = exampleConfig();
    expect(
      await channelFromConfig(config, cli).reachable(
        configEntry(config.repos, "repo", "satan"),
        JOB,
      ),
    ).toBe(true);
    expect(calls).toEqual([["f", "ssh", "true"]]);
  });

  it("builds a room channel from a room door", async () => {
    const calls: (readonly string[])[] = [];
    const cli: CapsuleCli = (args) => {
      calls.push(args);
      return Promise.resolve({ code: 75, stdout: "", stderr: "room down" });
    };
    const config = roomConfig();
    expect(
      await channelFromConfig(config, cli).reachable(
        configEntry(config.repos, "repo", "satan"),
        JOB,
      ),
    ).toBe(false);
    expect(calls).toEqual([["assistant", "collect", "satan", `job/${JOB}`]]);
  });

  it("refuses to start with no door table (I13)", () => {
    const config = parseRunnerConfig(withoutDoor(), HOME);
    expect(() => channelFromConfig(config)).toThrow(StartRefused);
    expect(() => channelFromConfig(config)).toThrow(/\[door\]/);
  });

  it("passes the profile to provision when the door names one", async () => {
    const calls: (readonly string[])[] = [];
    const cli: CapsuleCli = (args) => {
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
  it("is a slot door's ssh facts, host keys stored under the configured alias", () => {
    expect(roomConnection(exampleConfig())).toEqual({
      host: "10.99.0.2",
      user: "agent",
      hostKeyAlias: "pi-env-f",
      knownHosts: "/home/test/.ssh/known_hosts",
      sshConfig: "/home/test/.ssh/config",
      identity: "/home/test/.ssh/id",
    });
  });

  it("is a room door's ssh facts, the room's name as the placeholder host", () => {
    expect(roomConnection(roomConfig())).toEqual({
      host: "assistant",
      user: "agent",
      hostKeyAlias: "room-assistant",
      knownHosts: "/var/lib/capsule/room/assistant/known_hosts",
      sshConfig: "/home/test/.ssh/room-assistant.conf",
      identity: "/home/test/.ssh/runner",
    });
  });

  it("takes the alias as configured, never from the slot's name (I13)", () => {
    const text = variant('host_key_alias = "pi-env-f"', 'host_key_alias = "slot-alias"');
    expect(roomConnection(parseRunnerConfig(text, HOME)).hostKeyAlias).toBe("slot-alias");
  });

  it("leaves the optional ssh config and identity out when the door has none", () => {
    const text = variant('ssh_config = "~/.ssh/config"\nidentity = "~/.ssh/id"\n', "");
    const connection = roomConnection(parseRunnerConfig(text, HOME));
    expect(connection).not.toHaveProperty("sshConfig");
    expect(connection).not.toHaveProperty("identity");
  });

  it("refuses to start with no door table (I13)", () => {
    const config = parseRunnerConfig(withoutDoor(), HOME);
    expect(() => roomConnection(config)).toThrow(StartRefused);
    expect(() => roomConnection(config)).toThrow(/\[door\]/);
  });
});

/** The example config with its door table removed: it is the last table. */
const withoutDoor = (): string => EXAMPLE_TOML.slice(0, EXAMPLE_TOML.indexOf("[door]"));

// --- EX-10: the door and its kind stay behind the port (ASM-005, DEC-065) ----------

const SRC = join(import.meta.dirname, "../../src");
/** Naming the door: oubliette's command, its slots, the door table. */
const DOOR_WORDS = /\bcapsule|\bslot|\bdoor/i;
/**
 * Telling the door kinds apart (SL-027 design §4.1): `kind` compared with a
 * kind or a `case` on one, a key only one kind has (`session_path`, the room
 * timeouts), or either kind's door config type. A bare quoted "room" is not
 * one: the execution profile of that name is no door kind. Who may import the
 * room door's parser is test/structure.test.ts's rule, not this text match.
 */
const KIND_WORDS =
  /\b(?:kind\b\W{1,8}|case\s+)["'](?:slot|room)["']|\bsession_?path|\b(?:probe|transfer)_?timeout_?s\b|\b(?:slot|room)DoorConfig\b/i;

function sourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

/** `source` less its module specifiers: importing door.ts is not knowing the door. */
const withoutSpecifiers = (source: string): string =>
  source.replace(/\bfrom\s+["'][^"']+["']/g, "from");

const knowing = (words: RegExp): string[] =>
  sourceFiles(SRC)
    .filter((file) => words.test(withoutSpecifiers(readFileSync(join(SRC, file), "utf8"))))
    .sort();

describe("door knowledge (EX-10)", () => {
  it("the door is named only in the daemon's and runner's config.ts, runner/door.ts, and room/door.ts and room/connection.ts", () => {
    const owners = [
      "config.ts",
      "room/connection.ts",
      "room/door.ts",
      "runner/config.ts",
      "runner/door.ts",
    ];
    expect(knowing(DOOR_WORDS).filter((file) => !owners.includes(file))).toEqual([]);
    expect(knowing(DOOR_WORDS)).toEqual(
      expect.arrayContaining(["config.ts", "room/door.ts", "runner/config.ts", "runner/door.ts"]),
    );
  });

  it("which kind is known only in the runner's config.ts and door.ts", () => {
    expect(knowing(KIND_WORDS)).toEqual(["runner/config.ts", "runner/door.ts"]);
  });

  it("the kind check is the door's kind, not any quoted room", () => {
    expect(KIND_WORDS.test('door.kind === "room"')).toBe(true);
    expect(KIND_WORDS.test("kind: 'slot'")).toBe(true);
    expect(KIND_WORDS.test("RoomDoorConfig")).toBe(true);
    expect(KIND_WORDS.test('switch (door.kind) { case "slot": }')).toBe(true);
    expect(KIND_WORDS.test("case 'room':")).toBe(true);
    expect(KIND_WORDS.test('const PROFILES = ["host", "room"] as const;')).toBe(false);
    expect(KIND_WORDS.test('profile === "room"')).toBe(false);
    expect(KIND_WORDS.test("interface RoomDoor {")).toBe(false);
  });

  it("importing door.ts is not naming the door; a comment about it is", () => {
    expect(DOOR_WORDS.test(withoutSpecifiers('import { roomConnection } from "./door.ts";'))).toBe(
      false,
    );
    expect(DOOR_WORDS.test(withoutSpecifiers("// built from the door's facts"))).toBe(true);
  });
});

// --- collection and classification (EX-2) -----------------------------------------

const lastPayload = async (
  world: Pick<CollectWorld, "events">,
  kind: string,
): Promise<JsonRecord | undefined> =>
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
      commits: [{ oid: tip, subject: "add src/a.ts", message: "add src/a.ts\n" }],
      diffstat: { files: 1, insertions: 1, deletions: 0 },
    });
    expect(resultBody(job, collected)).toMatchObject({
      baseOid: world.base,
      reviewedOid: tip,
      quarantine: world.quarantine.path,
      commits: [{ oid: tip, subject: "add src/a.ts", message: "add src/a.ts\n" }],
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

describe("collection: a room door's job (EX-9)", () => {
  it("result reports the room repo's quarantine and refs/capsule/<room>/heads/job/<id>", async () => {
    const world = await roomKindCollectWorld();
    const tip = world.guestJob(world.jobId, "src/a.ts");
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    expect(job).toMatchObject({
      state: "needs_review",
      class: "complete",
      reviewedOid: tip,
      quarantineRef: `refs/capsule/${ROOM}/heads/job/${world.jobId}`,
    });
    const collected = await lastPayload(world, "collected");
    expect(resultBody(job, collected)).toMatchObject({
      quarantine: world.repo.quarantine,
      reviewedOid: tip,
    });
  });
});

describe("collection: a room door's channel failures, audited by reason", () => {
  it("a collect past transfer_timeout_s waits in pending_collection, audited channel_timeout", async () => {
    const world = await roomKindCollectWorld();
    world.guestJob(world.jobId, "src/a.ts");
    world.capsule.hang = true;
    expect(await collectJob(world.deps, world.jobId, T0 + 10)).toMatchObject({
      state: "pending_collection",
    });
    expect(await lastPayload(world, "transition")).toMatchObject({ reason: "channel_timeout" });
    world.capsule.hang = false;
    expect(await retryPendingCollection(world.deps, world.jobId, T0 + 20)).toMatchObject({
      state: "needs_review",
    });
  });

  it("a collect the room refuses (exit 2) fails collection_failed, audited channel_refusal", async () => {
    const world = await roomKindCollectWorld();
    world.capsule.exit = 2;
    const job = await collectJob(world.deps, world.jobId, T0 + 10);
    expect(job).toMatchObject({
      state: "failed",
      failure: { reason: "collection_failed", channel: "channel_refusal" },
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
