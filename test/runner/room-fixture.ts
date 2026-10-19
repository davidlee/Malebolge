// A room on temp repos, behind a fake `capsule` that moves commits the way
// oubliette's slot verbs do, with real git:
//   - `<slot> provision <ref>`: from the repo `CAPSULE_REPO` names, resolve
//     `<ref>` and push it, unforced, onto the guest's `work`; refused unless
//     the guest's HEAD is `refs/heads/work` (oubliette host/git-channel.nix:272,
//     :291).
//   - `<slot> collect`: into the quarantine, `fetch --no-tags --atomic` with
//     `transfer.fsckObjects=true` and the refspec
//     `+refs/heads/*:refs/capsule/<slot>/heads/*`, every guest head
//     (host/git-channel.nix:539, :605; host/quarantine.nix:45-62).
//   - `<slot> ssh <cmd…>`: `true`, or git in the guest clone.
//   - every failure exits 1, a room that is down included.
// The guest clone is a working repo with `receive.denyCurrentBranch =
// updateInstead`, as the guest's checkout is.
//
// And a room behind a fake `capsule` for the room door, following oubliette
// SL-006 design sec-4 ("Order of a run"), sec-5 (verbs) and sec-6 (the
// interface satan SL-023 builds against) at oubliette commit 73ec574, collect's
// stdout as pinned at ad2dd7d —
// provisional until SL-006 locks; re-check at that lock (CHR-016):
//   - `<room> push <repo> <branch>`: resolve `<branch>^{commit}` in the
//     target's host checkout (refused, exit 2, if absent), push it to the
//     guest clone's `refs/host/<branch>` (the worktree untouched); stdout is
//     the oid alone.
//   - `<room> collect <repo> <branch>`: make the quarantine bare if absent,
//     fetch `+refs/heads/<branch>:refs/capsule/<room>/heads/<branch>` with
//     `transfer.fsckObjects`, `--no-tags`; stdout is one line `<oid>\t<ref>`
//     (`ls-remote` order), which the adapter checks against the quarantine.
//   - exit 2: usage or a refused branch, decided before the room is asked;
//     75: the room is down (pre-flight); 1: anything after the banner.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { Connection } from "@earendil-works/pi-env";
import { type CollectDeps } from "../../src/runner/collect.ts";
import { type FinalStep, readyRoom, type ReadyDeps } from "../../src/runner/prepare.ts";
import { roomShell } from "../../src/runner/shell.ts";
import type { RepoConfig, RunnerConfig } from "../../src/runner/config.ts";
import { gitQuarantineReader } from "../../src/runner/git.ts";
import { type Job, type JobEvent, JobStore } from "../../src/runner/store.ts";
import type { EndReason } from "../../src/runner/vocab.ts";
import { type ProgramOutput, TimedOut } from "../../src/runner/exec.ts";
import {
  type CapsuleCli,
  type GitChannel,
  type RoomShell,
  roomChannel,
  slotChannel,
} from "../../src/runner/room.ts";
import { localConnection } from "./env-fixture.ts";
import {
  type BareRepo,
  gitIn,
  ISOLATED_ENV,
  tempBareRepo,
  tempClone,
  tempDir,
  tempRepo,
  tempUnbornRepo,
  type TestRepo,
} from "./git-fixture.ts";
import { exampleConfig, roomConfig } from "./config-fixture.ts";
import { NEW_JOB, openTestStore, sequentialIds, T0 } from "./store-fixture.ts";

export const SLOT = "f";
export const GUEST_PATH = "/work/repos/satan";

const ok = (stdout = ""): ProgramOutput => ({ code: 0, stdout, stderr: "" });
const exited = (code: number, stderr: string): ProgramOutput => ({ code, stdout: "", stderr });
const refused = (stderr: string): ProgramOutput => exited(1, stderr);

/** Runs `git` as the channel's scripts would; a failure is exit 1, as `capsule` reports it. */
function gitStep(cwd: string, args: readonly string[]): ProgramOutput {
  try {
    return ok(
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd,
        env: ISOLATED_ENV,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    return refused(String(error));
  }
}

export interface FakeCapsule {
  cli: CapsuleCli;
  /** `false`: the room is down. */
  up: boolean;
  /** Every argv the channel ran, in order. */
  calls: (readonly string[])[];
}

/** The slot's `capsule`: every failure exits 1, a room that is down included. */
export type FakeSlot = FakeCapsule;

interface Rooms {
  room: TestRepo;
  quarantine: BareRepo;
  /** The repo's `guest_path`: where the room's ssh finds the clone. */
  guestPath: string;
}

function provision(
  rooms: Rooms,
  args: readonly string[],
  source: string | undefined,
): ProgramOutput {
  const [ref] = args;
  if (source === undefined || ref === undefined) {
    return refused("capsule-provision: no source repo or ref");
  }
  const head = gitStep(rooms.room.path, ["symbolic-ref", "HEAD"]);
  if (head.stdout.trim() !== "refs/heads/work") {
    return refused(`capsule-provision: the guest has HEAD at ${head.stdout.trim()}`);
  }
  const commit = gitStep(source, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (commit.code !== 0) {
    return commit;
  }
  return gitStep(source, [
    "push",
    "--quiet",
    rooms.room.path,
    `${commit.stdout.trim()}:refs/heads/work`,
  ]);
}

function collect(rooms: Rooms): ProgramOutput {
  return gitStep(rooms.quarantine.path, [
    "-c",
    "transfer.fsckObjects=true",
    "fetch",
    "--quiet",
    "--no-tags",
    "--atomic",
    rooms.room.path,
    `+refs/heads/*:refs/capsule/${SLOT}/heads/*`,
  ]);
}

function ssh(rooms: Rooms, command: readonly string[]): ProgramOutput {
  const [program, flag, path, ...rest] = command;
  if (program === "true" && command.length === 1) {
    return ok();
  }
  if (program === "git" && flag === "-C" && path === rooms.guestPath) {
    return gitStep(rooms.room.path, rest);
  }
  return { code: 127, stdout: "", stderr: `fake guest cannot run ${command.join(" ")}` };
}

function verb(
  rooms: Rooms,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): ProgramOutput {
  const [slot, name, ...rest] = args;
  if (slot !== SLOT) {
    return refused(`capsule: no slot ${String(slot)}`);
  }
  if (name === "provision") {
    return provision(rooms, rest, env["CAPSULE_REPO"]);
  }
  if (name === "collect") {
    return collect(rooms);
  }
  return name === "ssh" ? ssh(rooms, rest) : refused(`capsule: unknown verb ${String(name)}`);
}

export function fakeSlot(rooms: Rooms): FakeSlot {
  const fake: FakeSlot = {
    up: true,
    calls: [],
    cli: (args, options = {}) => {
      fake.calls.push(args);
      return Promise.resolve(
        fake.up ? verb(rooms, args, options.env ?? {}) : refused("cannot reach the guest"),
      );
    },
  };
  return fake;
}

export interface RoomWorld extends Rooms {
  /** The user's repo: the channel may only read it (I3). */
  real: TestRepo;
  slot: FakeSlot;
  repo: RepoConfig;
  channel: GitChannel;
  /** In the guest, `job/<jobId>` from `work` with a commit per file; the tip. */
  guestJob: (jobId: string, ...files: string[]) => string;
}

export interface RoomWorldOptions {
  /**
   * `guest_path` is the clone's own path, for an execution environment that
   * runs there; default the guest's path, `GUEST_PATH`.
   */
  guestAtClone?: boolean;
}

/** A real repo on `main`, its room (guest clone on `work`), an empty quarantine. */
export function roomWorld(options: RoomWorldOptions = {}): RoomWorld {
  const real = tempRepo();
  const room = tempClone(real.path);
  room.git("switch", "--quiet", "-c", "work");
  room.git("config", "receive.denyCurrentBranch", "updateInstead");
  const quarantine = tempBareRepo();
  const guestPath = options.guestAtClone === true ? room.path : GUEST_PATH;
  const rooms = { room, quarantine, guestPath };
  const slot = fakeSlot(rooms);
  const repo: RepoConfig = {
    name: "satan",
    path: real.path,
    guestPath,
    defaultBranch: "main",
    ceilings: {},
  };
  const guestJob = (jobId: string, ...files: string[]): string => {
    room.git("switch", "--quiet", "-c", `job/${jobId}`, "work");
    for (const file of files) {
      room.commit(file);
    }
    return room.git("rev-parse", "HEAD");
  };
  return {
    ...rooms,
    real,
    slot,
    repo,
    channel: slotChannel({ slot: SLOT, quarantine: quarantine.path }, slot.cli),
    guestJob,
  };
}

// --- the room door (SL-006 sec-6) ---------------------------------------------------

export const ROOM = "assistant";
/** The room adapter's door facts in a room world. */
export const ROOM_DOOR = { room: ROOM } as const;
/** The target's `guestPath`, `/work/<target>` (SL-006 sec-6). */
export const ROOM_GUEST_PATH = "/work/satan";

/** The room's `capsule`, typed by exit code: 2 refused, 75 down, 1 failed after the banner. */
export interface FakeRoom extends FakeCapsule {
  /** Every verb exits this, as given, instead of running. */
  exit?: number;
  /** Every verb outlives its bound: the cli rejects `TimedOut`, as `runProgram` does. */
  hang: boolean;
  /** The bound each call was given, in order. */
  timeouts: (number | undefined)[];
  /** A successful collect prints this instead of `<oid>\t<ref>` (SL-006 sec-6). */
  collectStdout?: (oid: string, ref: string) => string;
}

/** The fake's knobs a verb reads. */
type RoomKnobs = Pick<FakeRoom, "up" | "collectStdout">;

/** Collect's one stdout line, `<oid>\t<ref>` in `ls-remote` order (SL-006 sec-6 at ad2dd7d). */
const lsRemoteLine = (oid: string, ref: string): string => `${oid}\t${ref}\n`;

interface RoomTarget extends Rooms {
  /** The target's name, `[repo.*]`'s key. */
  repo: string;
  /** The target's host checkout: the real repo. */
  source: string;
}

/** `git check-ref-format --branch`: the room's first refusal (SL-006 sec-4 step 1). */
const branchRefused = (cwd: string, branch: string): boolean =>
  gitStep(cwd, ["check-ref-format", "--branch", branch]).code !== 0;

function roomPush(target: RoomTarget, branch: string): ProgramOutput {
  const commit = gitStep(target.source, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
  if (branchRefused(target.source, branch) || commit.code !== 0) {
    return exited(2, `capsule-room-git: no branch ${branch} in the host checkout`);
  }
  const oid = commit.stdout.trim();
  const pushed = gitStep(target.source, [
    "push",
    "--quiet",
    target.room.path,
    `+${oid}:refs/host/${branch}`,
  ]);
  return pushed.code === 0 ? ok(`${oid}\n`) : pushed;
}

function roomCollect(
  target: RoomTarget,
  room: string,
  branch: string,
  print: (oid: string, ref: string) => string = lsRemoteLine,
): ProgramOutput {
  if (branchRefused(target.source, branch)) {
    return exited(2, `capsule-room-git: refused branch ${branch}`);
  }
  const quarantine = target.quarantine.path;
  const made = gitStep(target.source, ["init", "--quiet", "--bare", quarantine]);
  if (made.code !== 0) {
    return made;
  }
  const ref = `refs/capsule/${room}/heads/${branch}`;
  const fetched = gitStep(quarantine, [
    "-c",
    "transfer.fsckObjects=true",
    "fetch",
    "--quiet",
    "--no-tags",
    target.room.path,
    `+refs/heads/${branch}:${ref}`,
  ]);
  if (fetched.code !== 0) {
    return fetched;
  }
  const oid = gitStep(quarantine, ["rev-parse", ref]).stdout.trim();
  return ok(print(oid, ref));
}

/** `<room> push|collect <repo> <branch>`: usage is refused (2) before the pre-flight (75). */
function roomTransfer(
  target: RoomTarget,
  name: string | undefined,
  rest: readonly string[],
  { up, collectStdout }: RoomKnobs,
): ProgramOutput {
  const [repo, branch, ...extra] = rest;
  if ((name !== "push" && name !== "collect") || repo !== target.repo || extra.length > 0) {
    return exited(2, `capsule: usage, or no target ${String(repo)}`);
  }
  if (branch === undefined) {
    return exited(2, "capsule: usage: no branch");
  }
  if (!up) {
    return exited(75, "capsule-room-git: no SSH-2.0 banner through the room's socket");
  }
  return name === "push"
    ? roomPush(target, branch)
    : roomCollect(target, ROOM, branch, collectStdout);
}

function roomVerb(target: RoomTarget, args: readonly string[], knobs: RoomKnobs): ProgramOutput {
  const [room, name, ...rest] = args;
  if (room !== ROOM) {
    return exited(2, `capsule: no room ${String(room)}`);
  }
  return roomTransfer(target, name, rest, knobs);
}

export function fakeRoom(target: RoomTarget): FakeRoom {
  const fake: FakeRoom = {
    up: true,
    hang: false,
    calls: [],
    timeouts: [],
    cli: (args, options = {}) => {
      fake.calls.push(args);
      fake.timeouts.push(options.timeoutMs);
      if (fake.hang) {
        return Promise.reject(new TimedOut("capsule", options.timeoutMs ?? 0));
      }
      return Promise.resolve(
        fake.exit === undefined
          ? roomVerb(target, args, fake)
          : exited(fake.exit, `forced exit ${String(fake.exit)}`),
      );
    },
  };
  return fake;
}

export interface RoomKindWorld extends Rooms {
  real: TestRepo;
  capsule: FakeRoom;
  repo: RepoConfig;
  channel: GitChannel;
  /** In the guest, `job/<jobId>` from the pushed `refs/host/main`, a commit per file; the tip. */
  guestJob: (jobId: string, ...files: string[]) => string;
}

/**
 * A real repo on `main`; its room's clone fresh (`git init`, an unborn branch,
 * no commits, as SL-006 sec-6 gives it); a quarantine path collect will make.
 */
export function roomKindWorld(options: RoomWorldOptions = {}): RoomKindWorld {
  const real = tempRepo();
  const room = tempUnbornRepo("work");
  const quarantinePath = join(tempDir("mb-collect-"), ROOM, "satan.git");
  const quarantine: BareRepo = { path: quarantinePath, git: gitIn(quarantinePath) };
  const guestPath = options.guestAtClone === true ? room.path : ROOM_GUEST_PATH;
  const rooms = { room, quarantine, guestPath };
  const capsule = fakeRoom({ ...rooms, repo: "satan", source: real.path });
  const repo: RepoConfig = {
    name: "satan",
    path: real.path,
    guestPath,
    defaultBranch: "main",
    quarantine: quarantinePath,
    transferTimeoutS: 600,
    ceilings: {},
  };
  const guestJob = (jobId: string, ...files: string[]): string => {
    room.git("switch", "--quiet", "-c", `job/${jobId}`, "refs/host/main");
    for (const file of files) {
      room.commit(file);
    }
    return room.git("rev-parse", "HEAD");
  };
  return {
    ...rooms,
    real,
    capsule,
    repo,
    channel: roomChannel(ROOM_DOOR, capsule.cli),
    guestJob,
  };
}

/** What collection needs of a world, whichever the door kind. */
type ChannelWorld = Pick<
  RoomWorld,
  "real" | "room" | "quarantine" | "repo" | "channel" | "guestJob"
>;

/** A job in `collecting` over world `W`, and collection's dependencies. */
export type CollectWorld<W extends ChannelWorld = RoomWorld> = W & {
  jobs: JobStore;
  deps: CollectDeps;
  jobId: string;
  /** The oid refresh put in the guest's clone: the job's `base_oid`. */
  base: string;
  job: () => Promise<Job>;
  events: () => Promise<JobEvent[]>;
};

/** Seconds a job may wait in pending_collection in a collect world. */
export const MAX_PENDING_S = 60;

type JobsOn = (db: SqliteDatabase) => JobStore;

const ownJobs: JobsOn = (db) => new JobStore(db, sequentialIds());

/**
 * A job in `collecting`, ended for `endReason`, its base refreshed into
 * `world`'s guest clone at T0, and collection's dependencies over `world`
 * and `example` (its repos replaced by the world's).
 */
async function collectWorldOver<W extends ChannelWorld>(
  world: W,
  example: RunnerConfig,
  endReason: EndReason,
  jobsOn: JobsOn,
): Promise<CollectWorld<W>> {
  const jobs = jobsOn((await openTestStore()).db);
  const { job: submitted } = await jobs.submit(NEW_JOB, T0);
  const jobId = submitted.id;
  const base = await world.channel.refresh(world.repo, "main");
  await jobs.transition(jobId, "preparing", T0, {}, { baseOid: base });
  await jobs.transition(jobId, "running", T0);
  await jobs.transition(jobId, "collecting", T0, {}, { endReason });
  const config: RunnerConfig = {
    ...example,
    maxima: { ...example.maxima, maxPendingCollectionS: MAX_PENDING_S },
    repos: new Map([[NEW_JOB.repo, world.repo]]),
  };
  const deps: CollectDeps = {
    jobs,
    channel: world.channel,
    quarantine: gitQuarantineReader,
    config,
    connect: () => localConnection(),
  };
  const job = async (): Promise<Job> => {
    const found = await jobs.get(jobId);
    if (found === undefined) {
      throw new Error(`no job ${jobId}`);
    }
    return found;
  };
  return { ...world, jobs, deps, jobId, base, job, events: () => jobs.events(jobId) };
}

/**
 * `collectWorldOver` a slot's `roomWorld`. `jobs` defaults to the store's
 * own; pass one sharing its database to intercept writes.
 */
export const collectWorld = (
  endReason: EndReason = "completed",
  jobsOn: JobsOn = ownJobs,
): Promise<CollectWorld> => collectWorldOver(roomWorld(), exampleConfig(), endReason, jobsOn);

/**
 * `collectWorldOver` a room door's `roomKindWorld`, its `guest_path` the
 * clone's own: the clean after collect runs there through a local daemon.
 */
export const roomKindCollectWorld = (
  endReason: EndReason = "completed",
): Promise<CollectWorld<RoomKindWorld>> =>
  collectWorldOver(roomKindWorld({ guestAtClone: true }), roomConfig(), endReason, ownJobs);

/** A job `preparing` over a room-kind world, and `readyRoom` for it through a local daemon. */
export interface Readying {
  jobs: JobStore;
  job: Job;
  /** Each pause, in ms; the clock moves by it. */
  slept: number[];
  /** `readyRoom` for the job over `repo` (default the world's), its shell in `repo.guestPath`; the base. */
  ready: (repo?: RepoConfig) => Promise<string>;
  /** `ready` with `finalStep` as readyRoom's last step: the base and the step's value. */
  readyWith: <T>(finalStep: FinalStep<T>, repo?: RepoConfig) => Promise<Readied<T>>;
}

/** What readyRoom returns. */
export interface Readied<T> {
  baseOid: string;
  value: T;
}

export interface ReadyingOptions {
  maxRoomWaitS?: number;
  onSleep?: () => void;
  /** The daemon each ready connects to; default `localConnection()`. */
  connect?: () => Connection;
  /** The shell readyRoom is given, from the room shell; default as is. */
  wrap?: (shell: RoomShell) => RoomShell;
}

export async function readying(
  world: RoomKindWorld,
  options: ReadyingOptions = {},
): Promise<Readying> {
  const { jobs } = await openTestStore();
  const { job: queued } = await jobs.submit(NEW_JOB, T0);
  const job = await jobs.transition(queued.id, "preparing", T0);
  const example = roomConfig();
  let clock = T0;
  const slept: number[] = [];
  const deps: ReadyDeps = {
    jobs,
    channel: world.channel,
    config: { ...example, maxima: { ...example.maxima, maxRoomWaitS: options.maxRoomWaitS ?? 60 } },
    now: () => clock,
    sleep: (ms) => {
      slept.push(ms);
      clock += ms;
      options.onSleep?.();
      return Promise.resolve();
    },
  };
  const connect = options.connect ?? ((): Connection => localConnection());
  const wrap = options.wrap ?? ((shell: RoomShell): RoomShell => shell);
  const readyWith = async <T>(finalStep: FinalStep<T>, repo = world.repo): Promise<Readied<T>> => {
    const connection = connect();
    try {
      const shell = wrap(roomShell(connection, job.id, repo.guestPath));
      return await readyRoom(deps, job, repo, shell, new AbortController().signal, finalStep);
    } finally {
      connection.close();
    }
  };
  const ready = async (repo = world.repo): Promise<string> =>
    (await readyWith(() => Promise.resolve(undefined), repo)).baseOid;
  return { jobs, job, slept, ready, readyWith };
}
