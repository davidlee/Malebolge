// The git channel (design §5.2, DEC-060): how commits move between the real
// repo, the room and the quarantine. The port is door-free; `[door] kind`
// picks one of two adapters (DEC-065), both driving oubliette's `capsule`
// command line: the slot adapter (the live rung) and the room adapter, built
// against oubliette SL-006 design sec-6 at 73ec574 (collect's stdout as pinned
// at ad2dd7d) and provisional until SL-006 locks (re-checked then, CHR-016).
// This file and config.ts are the only runner modules that know the door and
// its kind (EX-10, held by a structural test): everything else sees
// `GitChannel`, `channelFromConfig` and `roomConnection`.

import { setDefined } from "../fields.ts";
import { directLaunch, type Launch, type RoomConnection } from "../room/connection.ts";
import { type RoomDoor, roomConnectionOf } from "../room/door.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  notOverflowed,
  type RoomShell,
  type ShellLimits,
  succeeded,
  successStdout,
} from "../room/shell.ts";
import type { DoorConfig, RepoConfig, RunnerConfig, SlotDoorConfig } from "./config.ts";
import { messageOf, RunnerError, StartRefused } from "./errors.ts";
import { type ProgramOptions, type ProgramOutput, runProgram, TimedOut } from "./exec.ts";
import { gitRepoReader, type RepoReader, resolveCommit } from "./git.ts";

export type Oid = string;

/** Where a collected job branch landed. */
export interface Collected {
  /** The quarantine repo's path: the checks read it, and `result` reports it. */
  quarantine: string;
  ref: string;
  oid: Oid;
}

export interface GitChannel {
  /** Make `baseRef`'s tip present in the room's clone; return its oid. */
  refresh: (repo: RepoConfig, baseRef: string) => Promise<Oid>;
  /** Fetch `job/<id>` from the room into quarantine; return where it landed. */
  collect: (repo: RepoConfig, jobId: string) => Promise<Collected>;
  /**
   * Reachability probe for pause/resume and `pending_collection` (design §5.2).
   * Slot: a cheap `ssh true`, never throws. Room: this job's collect; false for
   * unavailable, throws `ChannelFailed`.
   */
  reachable: (repo: RepoConfig, jobId: string) => Promise<boolean>;
  /**
   * Why the clone cannot take a new job (`preparing`, before its branch), or
   * `undefined`. Never changes the clone (design §5.2).
   */
  checkClone: (
    shell: RoomShell,
    repo: RepoConfig,
    signal: AbortSignal,
  ) => Promise<CloneDefect | undefined>;
  /** Discards a collected job's residue from the clone; idempotent (design §5.2). */
  cleanClone: (shell: RoomShell, signal: AbortSignal) => Promise<void>;
}

/** A clone refused for a new job: `failed(error)` with this as its failure. */
export type CloneDefect =
  | { reason: "guest_path_invalid"; guestPath: string }
  | { reason: "dirty_clone"; paths: string[] };

/** The bounds of every `preparing` exec in the room's clone (design §4.2). */
export const PREPARE_LIMITS = {
  timeoutS: 60,
  maxStdoutBytes: 65_536,
  maxStderrBytes: 4096,
} as const satisfies ShellLimits;

/** The branch a job's commits are made on in the room. */
export const jobBranch = (jobId: string): string => `job/${jobId}`;

/** `capsule args`. Rejects only when it cannot run, or (`TimedOut`) outlives `timeoutMs`. */
export type CapsuleCli = (
  args: readonly string[],
  options?: ProgramOptions,
) => Promise<ProgramOutput>;

export const execCapsule: CapsuleCli = (args, options) => runProgram("capsule", args, options);

/** Where a door's collect puts the guest's `job/<id>`: `name` is the slot's or the room's. */
export const collectedJobRef = (name: string, jobId: string): string =>
  `refs/capsule/${name}/heads/${jobBranch(jobId)}`;

/** `baseRef`'s tip in the real repo, read only through `reader` (I3); gone is `base_ref_invalid`. */
async function baseTip(reader: RepoReader, repo: RepoConfig, baseRef: string): Promise<Oid> {
  const oid = await reader.resolveBranch(repo.path, baseRef);
  if (oid === undefined) {
    throw new RunnerError("base_ref_invalid", `baseRef ${JSON.stringify(baseRef)} is gone`);
  }
  return oid;
}

/** Where `job/<id>` landed in `quarantine` under `ref`; absent or unreadable is ChannelFailed. */
async function landed(quarantine: string, ref: string, jobId: string): Promise<Collected> {
  let oid: string | undefined;
  try {
    oid = await resolveCommit(quarantine, ref);
  } catch (error) {
    throw new ChannelFailed(messageOf(error), { cause: error });
  }
  if (oid === undefined) {
    throw new ChannelFailed(`${jobBranch(jobId)} not collected: no ${ref} in ${quarantine}`);
  }
  return { quarantine, ref, oid };
}

// --- the slot adapter ------------------------------------------------------------

/**
 * Pushes `ref` (any commit-ish of the source repo) onto the guest's `work`.
 * The source repo is `CAPSULE_REPO` (host/git-channel.nix `src`), not the cwd.
 */
export const provisionArgs = (slot: string, ref: string, profile?: string): string[] => [
  slot,
  "provision",
  ref,
  ...(profile === undefined ? [] : ["--profile", profile]),
];

/** Fetches every guest head into `refs/capsule/<slot>/heads/*` of the slot's quarantine. */
export const collectArgs = (slot: string): string[] => [slot, "collect"];

export const probeArgs = (slot: string): string[] => [slot, "ssh", "true"];

/**
 * PROVISIONAL, pending H1: provision refuses unless the guest's HEAD is
 * `refs/heads/work` (oubliette host/git-channel.nix:272), and a job leaves it
 * on `job/<id>`. So refresh first switches the guest clone back to `work`.
 */
export const returnToWorkArgs = (slot: string, guestPath: string): string[] => [
  slot,
  "ssh",
  "git",
  "-C",
  guestPath,
  "switch",
  "work",
];

export type SlotDoor = Pick<SlotDoorConfig, "slot" | "quarantine" | "profile">;

/** A git channel over an oubliette slot. Reads the real repo only through `reader` (I3). */
export function slotChannel(
  door: SlotDoor,
  cli: CapsuleCli,
  reader: RepoReader = gitRepoReader,
): GitChannel {
  const { slot, quarantine } = door;

  async function probe(): Promise<boolean> {
    try {
      return (await cli(probeArgs(slot))).code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Runs one verb. `capsule` exits 1 for every failure, so a failed verb is
   * typed by probing afterwards: unreachable → ChannelUnavailable.
   */
  async function step(args: readonly string[], env: Record<string, string> = {}): Promise<void> {
    const what = `capsule ${args.join(" ")}`;
    let output: ProgramOutput;
    try {
      output = await cli(args, { env });
    } catch (error) {
      throw new ChannelFailed(`${what}: ${messageOf(error)}`, { cause: error });
    }
    if (output.code === 0) {
      return;
    }
    const message = `${what} exited ${String(output.code)}: ${output.stderr.trim()}`;
    throw (await probe()) ? new ChannelFailed(message) : new ChannelUnavailable(message);
  }

  async function refresh(repo: RepoConfig, baseRef: string): Promise<Oid> {
    const oid = await baseTip(reader, repo, baseRef);
    await step(returnToWorkArgs(slot, repo.guestPath));
    // The oid, not the branch name: the guest gets exactly what is returned,
    // however the real branch moves meanwhile.
    await step(provisionArgs(slot, oid, door.profile), { CAPSULE_REPO: repo.path });
    return oid;
  }

  async function collect(_repo: RepoConfig, jobId: string): Promise<Collected> {
    await step(collectArgs(slot));
    // The slot's collect transfers every guest head, not only `job/<id>`;
    // narrowing the transfer needs oubliette's room verbs (SL-005). What this
    // adapter guarantees is that only `job/<id>` is read and recorded.
    return landed(quarantine, collectedJobRef(slot, jobId), jobId);
  }

  // The slot's clone is returned to `work` by refresh: nothing to check or clean.
  return {
    refresh,
    collect,
    reachable: probe,
    checkClone: () => Promise.resolve(undefined),
    cleanClone: () => Promise.resolve(),
  };
}

// --- the room adapter (oubliette SL-006 design sec-6, provisional) -------------------

/** `capsule <room> push <repo> <branch>`: the branch's tip to the guest's `refs/host/<branch>`. */
export const roomPushArgs = (room: string, repo: string, branch: string): string[] => [
  room,
  "push",
  repo,
  branch,
];

/** `capsule <room> collect <repo> job/<id>`: into `refs/capsule/<room>/heads/job/<id>`. */
export const roomCollectArgs = (room: string, repo: string, jobId: string): string[] => [
  room,
  "collect",
  repo,
  jobBranch(jobId),
];

/** The room's verbs exit 75 when the room is down (pre-flight), 2 on a refusal (SL-006 sec-4). */
const ROOM_DOWN = 75;
const REFUSED = 2;

/** A room verb's non-zero exit, typed by the code alone: no probe. */
export function roomVerbError(
  what: string,
  output: ProgramOutput,
): ChannelUnavailable | ChannelFailed {
  const message = `${what} exited ${String(output.code)}: ${output.stderr.trim()}`;
  if (output.code === ROOM_DOWN) {
    return new ChannelUnavailable(message);
  }
  // 1, a trust failure included (authentication, a changed host key), is never downtime.
  return new ChannelFailed(message, {
    reason: output.code === REFUSED ? "channel_refusal" : "channel_failed",
  });
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Collect's one stdout line, `<oid>\t<ref>` in `ls-remote` order (SL-006 sec-6 at ad2dd7d). */
const lsRemoteLine = ({ oid, ref }: Pick<Collected, "oid" | "ref">): string => `${oid}\t${ref}`;

/** The room keys of `repo`; config refuses a room repo without them (I13). */
function roomRepo(repo: RepoConfig): { quarantine: string; transferTimeoutMs: number } {
  const { quarantine, transferTimeoutS } = repo;
  if (quarantine === undefined || transferTimeoutS === undefined) {
    throw new ChannelFailed(`repo ${repo.name} has no room quarantine or transfer_timeout_s`);
  }
  return { quarantine, transferTimeoutMs: transferTimeoutS * 1000 };
}

/** A git channel over an oubliette room. Reads the real repo only through `reader` (I3). */
export function roomChannel(
  door: Pick<RoomDoor, "room">,
  cli: CapsuleCli,
  reader: RepoReader = gitRepoReader,
): GitChannel {
  const { room } = door;

  /** Runs one verb within `timeoutMs`; its stdout, or the typed failure. */
  async function verb(args: readonly string[], timeoutMs: number): Promise<string> {
    const what = `capsule ${args.join(" ")}`;
    let output: ProgramOutput;
    try {
      output = await cli(args, { timeoutMs });
    } catch (error) {
      if (error instanceof TimedOut) {
        throw new ChannelUnavailable(`${what}: ${error.message}`, {
          cause: error,
          reason: "channel_timeout",
        });
      }
      throw new ChannelFailed(`${what}: ${messageOf(error)}`, { cause: error });
    }
    if (output.code !== 0) {
      throw roomVerbError(what, output);
    }
    return output.stdout;
  }

  async function refresh(repo: RepoConfig, baseRef: string): Promise<Oid> {
    const { transferTimeoutMs } = roomRepo(repo);
    await baseTip(reader, repo, baseRef);
    let stdout: string;
    try {
      stdout = await verb(roomPushArgs(room, repo.name, baseRef), transferTimeoutMs);
    } catch (error) {
      // Push refuses a branch absent from the host checkout too: one deleted
      // since the check above is the caller's error, not a runner bug.
      if (error instanceof ChannelFailed && error.reason === "channel_refusal") {
        await baseTip(reader, repo, baseRef);
      }
      throw error;
    }
    // The oid push delivered, not the one checked above: the branch may have
    // moved between them, and the guest has exactly what push printed.
    const oid = stdout.trim();
    if (!OID.test(oid)) {
      throw new ChannelFailed(`capsule push printed ${JSON.stringify(oid)}, not an oid`);
    }
    return oid;
  }

  async function collect(repo: RepoConfig, jobId: string): Promise<Collected> {
    const { quarantine, transferTimeoutMs } = roomRepo(repo);
    const stdout = await verb(roomCollectArgs(room, repo.name, jobId), transferTimeoutMs);
    const collected = await landed(quarantine, collectedJobRef(room, jobId), jobId);
    // The quarantine is what the checks read; stdout must say the same.
    const expected = lsRemoteLine(collected);
    if (stdout.replace(/\n$/, "") !== expected) {
      throw new ChannelFailed(
        `capsule collect printed ${JSON.stringify(stdout)}, not the quarantine's ${JSON.stringify(expected)}`,
      );
    }
    return collected;
  }

  /** The probe is this job's collect (DEC-060): its bound, exit mapping and cross-check. */
  async function reachable(repo: RepoConfig, jobId: string): Promise<boolean> {
    try {
      await collect(repo, jobId);
      return true;
    } catch (error) {
      if (error instanceof ChannelUnavailable) {
        return false;
      }
      throw error;
    }
  }

  return { refresh, collect, reachable, checkClone: checkRoomClone, cleanClone: cleanRoomClone };
}

/**
 * The room's preparing checks (design §5.2): `<guest_path>/.git` is a
 * directory, and `git status --porcelain` is empty (untracked counted, ignored
 * not). Run from `/`, so an absent `guest_path` is a defect, not a failed exec.
 * Both run within PREPARE_LIMITS (design §4.2): a status that overflows is
 * dirty, its paths those of the head's complete lines.
 */
export async function checkRoomClone(
  shell: RoomShell,
  repo: RepoConfig,
  signal: AbortSignal,
): Promise<CloneDefect | undefined> {
  const { guestPath } = repo;
  const probe = ["test", "-d", `${guestPath}/.git`];
  if (notOverflowed(probe, await shell(probe, signal, "/", PREPARE_LIMITS)).code !== 0) {
    return { reason: "guest_path_invalid", guestPath };
  }
  const status = ["git", "status", "--porcelain", "--untracked-files=normal"];
  const output = await shell(status, signal, undefined, PREPARE_LIMITS);
  // An overflowed head ends mid-line: only its complete lines name paths.
  const listing = output.overflowed
    ? output.stdout.slice(0, output.stdout.lastIndexOf("\n") + 1)
    : successStdout(status, output);
  const paths = listing
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));
  return paths.length === 0 && !output.overflowed ? undefined : { reason: "dirty_clone", paths };
}

/**
 * The room's clean after a collect (design §5.2): tracked changes reset, and
 * untracked files and nested repos removed; ignored files (caches) kept.
 */
export async function cleanRoomClone(shell: RoomShell, signal: AbortSignal): Promise<void> {
  await succeeded(shell, ["git", "reset", "--quiet", "--hard"], signal);
  await succeeded(shell, ["git", "clean", "-ffd", "--quiet"], signal);
}

// --- from config -------------------------------------------------------------------

function doorOf(config: RunnerConfig): DoorConfig {
  if (config.door === undefined) {
    throw new StartRefused("config has no [door] table");
  }
  return config.door;
}

/** The configured channel; config has already refused a door lacking a key its kind needs (I13). */
export function channelFromConfig(
  config: RunnerConfig,
  cli: CapsuleCli = execCapsule,
  reader: RepoReader = gitRepoReader,
): GitChannel {
  const door = doorOf(config);
  return door.kind === "slot" ? slotChannel(door, cli, reader) : roomChannel(door, cli, reader);
}

/**
 * How `repo`'s daemon is started: a slot's is the daemon itself; a room's
 * runs it through the room's session program in the repo's checkout
 * (oubliette SL-006 sec-6: `<session_path> <repo> -- <daemon>`).
 */
export function daemonLaunch(config: RunnerConfig, repo: RepoConfig): Launch {
  const door = doorOf(config);
  if (door.kind === "slot") {
    return directLaunch;
  }
  return (daemon) => [door.sessionPath, repo.name, "--", daemon];
}

/** The execution environment's connection facts, as configured: none derived (I13). */
export function roomConnection(config: RunnerConfig): RoomConnection {
  const door = doorOf(config);
  if (door.kind === "room") {
    return roomConnectionOf(door, door.sshConfig);
  }
  const { host, user, hostKeyAlias, knownHosts, sshConfig, identity } = door;
  return setDefined<RoomConnection>(
    { host, user, hostKeyAlias, knownHosts },
    { sshConfig, identity },
  );
}
