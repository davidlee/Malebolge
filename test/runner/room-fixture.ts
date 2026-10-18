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

import { execFileSync } from "node:child_process";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { type CollectDeps } from "../../src/runner/collect.ts";
import type { RepoConfig, RunnerConfig } from "../../src/runner/config.ts";
import { gitQuarantineReader } from "../../src/runner/git.ts";
import { type Job, type JobEvent, JobStore } from "../../src/runner/store.ts";
import type { EndReason } from "../../src/runner/vocab.ts";
import type { ProgramOutput } from "../../src/runner/exec.ts";
import { type SlotCli, slotChannel, type GitChannel } from "../../src/runner/room.ts";
import {
  type BareRepo,
  ISOLATED_ENV,
  tempBareRepo,
  tempClone,
  tempRepo,
  type TestRepo,
} from "./git-fixture.ts";
import { exampleConfig } from "./config-fixture.ts";
import { NEW_JOB, openTestStore, sequentialIds, T0 } from "./store-fixture.ts";

export const SLOT = "f";
export const GUEST_PATH = "/work/repos/satan";

const ok = (stdout = ""): ProgramOutput => ({ code: 0, stdout, stderr: "" });
const refused = (stderr: string): ProgramOutput => ({ code: 1, stdout: "", stderr });

/** Runs `git` as the slot's scripts would; a failure is exit 1, as `capsule` reports it. */
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

export interface FakeSlot {
  cli: SlotCli;
  /** `false`: the room is down, and every verb exits 1. */
  up: boolean;
  /** Every argv the channel ran, in order. */
  calls: (readonly string[])[];
}

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
    cli: (args, env = {}) => {
      fake.calls.push(args);
      return Promise.resolve(fake.up ? verb(rooms, args, env) : refused("cannot reach the guest"));
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

export interface CollectWorld extends RoomWorld {
  jobs: JobStore;
  deps: CollectDeps;
  jobId: string;
  /** The oid refresh put on the guest's `work`: the job's `base_oid`. */
  base: string;
  job: () => Promise<Job>;
  events: () => Promise<JobEvent[]>;
}

/** Seconds a job may wait in pending_collection in a collect world. */
export const MAX_PENDING_S = 60;

/**
 * A job in `collecting`, ended for `endReason`, its base refreshed onto the
 * guest's `work` at T0, and collection's dependencies over `roomWorld`.
 * `jobs` defaults to the store's own; pass one sharing its database to
 * intercept writes.
 */
export async function collectWorld(
  endReason: EndReason = "completed",
  jobsOn: (db: SqliteDatabase) => JobStore = (db) => new JobStore(db, sequentialIds()),
): Promise<CollectWorld> {
  const world = roomWorld();
  const jobs = jobsOn((await openTestStore()).db);
  const { job: submitted } = await jobs.submit(NEW_JOB, T0);
  const jobId = submitted.id;
  const base = await world.channel.refresh(world.repo, "main");
  await jobs.transition(jobId, "preparing", T0, {}, { baseOid: base });
  await jobs.transition(jobId, "running", T0);
  await jobs.transition(jobId, "collecting", T0, {}, { endReason });
  const example = exampleConfig();
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
