// The git channel (design §5.2, DEC-060): how commits move between the real
// repo, the room and the quarantine. The port is door-free; `[door] kind`
// picks one of two adapters (DEC-065), both driving oubliette's `capsule`
// command line: the slot adapter (the live rung) and the room adapter, built
// against oubliette SL-006 design sec-6 at 73ec574 and provisional until
// SL-006 locks (re-checked then, CHR-016). This file and config.ts are the
// only ones that know the door (held by a structural test): everything else
// sees `GitChannel`, `channelFromConfig` and `roomConnection`.

import { setDefined } from "../fields.ts";
import type {
  DoorConfig,
  RepoConfig,
  RoomDoorConfig,
  RunnerConfig,
  SlotDoorConfig,
} from "./config.ts";
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
  /** Cheap reachability probe; never throws. */
  reachable: () => Promise<boolean>;
}

interface ChannelErrorOptions<Reason> extends ErrorOptions {
  reason?: Reason;
}

/**
 * The room is down: retry later. `reason` is what the audit records: a verb
 * past its bound is `channel_timeout`, apart from a room known to be down.
 */
export class ChannelUnavailable extends Error {
  readonly reason: "channel_unavailable" | "channel_timeout";

  constructor(message: string, options: ChannelErrorOptions<ChannelUnavailable["reason"]> = {}) {
    super(message, options);
    this.name = "ChannelUnavailable";
    this.reason = options.reason ?? "channel_unavailable";
  }
}

/**
 * The channel failed for any other reason. `reason` is what the audit
 * records: `channel_refusal` is the door refusing the runner's own argv or
 * config (a runner bug); `host_key` is the room's host key unknown or changed
 * at a daemon start (a trust failure, never retried).
 */
export class ChannelFailed extends Error {
  readonly reason: "channel_failed" | "channel_refusal" | "host_key";

  constructor(message: string, options: ChannelErrorOptions<ChannelFailed["reason"]> = {}) {
    super(message, options);
    this.name = "ChannelFailed";
    this.reason = options.reason ?? "channel_failed";
  }
}

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

  async function reachable(): Promise<boolean> {
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
    throw (await reachable()) ? new ChannelFailed(message) : new ChannelUnavailable(message);
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

  return { refresh, collect, reachable };
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

export const roomProbeArgs = (room: string, user: string): string[] => [room, "ssh", user, "true"];

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

export type RoomDoor = Pick<RoomDoorConfig, "room" | "user" | "probeTimeoutS">;

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
  door: RoomDoor,
  cli: CapsuleCli,
  reader: RepoReader = gitRepoReader,
): GitChannel {
  const { room } = door;

  async function reachable(): Promise<boolean> {
    try {
      const probe = roomProbeArgs(room, door.user);
      return (await cli(probe, { timeoutMs: door.probeTimeoutS * 1000 })).code === 0;
    } catch {
      return false;
    }
  }

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
    // Collect's stdout ("the ref and its oid") has no pinned format in SL-006,
    // and sec-6 fixes the ref; so the ref is read from the quarantine, never stdout.
    await verb(roomCollectArgs(room, repo.name, jobId), transferTimeoutMs);
    return landed(quarantine, collectedJobRef(room, jobId), jobId);
  }

  return { refresh, collect, reachable };
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

/** How the execution environment reaches the room's shell. */
export interface RoomConnection {
  /** The guest's address; a room's is its name, a placeholder the relay ignores. */
  host: string;
  user: string;
  /** The fixed name the room's host keys are stored under in `knownHosts`. */
  hostKeyAlias: string;
  knownHosts: string;
  /** An ssh config file (e.g. the relay's ProxyCommand) instead of `~/.ssh/config`. */
  sshConfig?: string;
  identity?: string;
}

/**
 * The words that start the daemon at path `daemon` in the guest; the
 * execution environment quotes them into ssh's remote command.
 */
export type Launch = (daemon: string) => readonly string[];

/**
 * How `repo`'s daemon is started: a slot's is the daemon itself; a room's
 * runs it through the room's session program in the repo's checkout
 * (oubliette SL-006 sec-6: `<session_path> <repo> -- <daemon>`).
 */
export function daemonLaunch(config: RunnerConfig, repo: RepoConfig): Launch {
  const door = doorOf(config);
  if (door.kind === "slot") {
    return (daemon) => [daemon];
  }
  return (daemon) => [door.sessionPath, repo.name, "--", daemon];
}

/** The execution environment's connection facts, as configured: none derived (I13). */
export function roomConnection(config: RunnerConfig): RoomConnection {
  const door = doorOf(config);
  const { user, hostKeyAlias, knownHosts, sshConfig, identity } = door;
  const host = door.kind === "slot" ? door.host : door.room;
  return setDefined<RoomConnection>(
    { host, user, hostKeyAlias, knownHosts },
    { sshConfig, identity },
  );
}
