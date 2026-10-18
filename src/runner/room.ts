// The git channel (design §5.2, DEC-060): how commits move between the real
// repo, the room and the quarantine. The port is door-free; the slot adapter
// below drives an oubliette slot through its `capsule <slot> <verb>` command
// line, standing in for the room until oubliette SL-005 pins the room verbs
// (ASM-005). This file and config.ts are the only ones that know the door
// (EX-3, held by a structural test): everything else sees `GitChannel`,
// `channelFromConfig` and `roomConnection`.

import { setDefined } from "../fields.ts";
import type { RepoConfig, RunnerConfig } from "./config.ts";
import { messageOf, RunnerError, StartRefused } from "./errors.ts";
import { type ProgramOutput, runProgram } from "./exec.ts";
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

/** The room is down: retry later. */
export class ChannelUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChannelUnavailable";
  }
}

/** The channel failed for any other reason. */
export class ChannelFailed extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChannelFailed";
  }
}

/** The branch a job's commits are made on in the room. */
export const jobBranch = (jobId: string): string => `job/${jobId}`;

// --- the slot adapter ------------------------------------------------------------

/** `capsule args`, `env` laid over the runner's environment. Rejects only when it cannot run. */
export type SlotCli = (
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<ProgramOutput>;

export const execCapsule: SlotCli = (args, env = {}) => runProgram("capsule", args, { env });

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

/** Where the slot's collect puts the guest's `job/<id>`. */
export const collectedJobRef = (slot: string, jobId: string): string =>
  `refs/capsule/${slot}/heads/${jobBranch(jobId)}`;

export interface SlotDoor {
  slot: string;
  /** `$state/collect/<slot>.git`. */
  quarantine: string;
  profile?: string;
}

/** A git channel over an oubliette slot. Reads the real repo only through `reader` (I3). */
export function slotChannel(
  door: SlotDoor,
  cli: SlotCli,
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
  async function step(args: readonly string[], env?: Record<string, string>): Promise<void> {
    const what = `capsule ${args.join(" ")}`;
    let output: ProgramOutput;
    try {
      output = await cli(args, env);
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
    const oid = await reader.resolveBranch(repo.path, baseRef);
    if (oid === undefined) {
      throw new RunnerError("base_ref_invalid", `baseRef ${JSON.stringify(baseRef)} is gone`);
    }
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
    const ref = collectedJobRef(slot, jobId);
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

  return { refresh, collect, reachable };
}

// --- from config -------------------------------------------------------------------

function doorOf(config: RunnerConfig): NonNullable<RunnerConfig["door"]> {
  if (config.door === undefined) {
    throw new StartRefused("config has no [door] table");
  }
  return config.door;
}

/** A refusal naming the door keys, by their TOML names, that `keys` lacks. */
function lacking(keys: Readonly<Record<string, string | undefined>>): StartRefused {
  const unset = Object.keys(keys).filter((key) => keys[key] === undefined);
  return new StartRefused(`[door] lacks ${unset.join(", ")}`);
}

/** The configured channel; refuses to start without the door keys it needs (I13). */
export function channelFromConfig(
  config: RunnerConfig,
  cli: SlotCli = execCapsule,
  reader: RepoReader = gitRepoReader,
): GitChannel {
  const { slot, quarantine, profile } = doorOf(config);
  if (slot === undefined || quarantine === undefined) {
    throw lacking({ slot, quarantine });
  }
  return slotChannel(setDefined<SlotDoor>({ slot, quarantine }, { profile }), cli, reader);
}

/** How the execution environment reaches the room's shell. */
export interface RoomConnection {
  /** The guest's address. */
  host: string;
  user: string;
  /** The fixed name the room's host keys are stored under in `knownHosts`. */
  hostKeyAlias: string;
  knownHosts: string;
  /** An ssh config file (e.g. the relay's ProxyCommand) instead of `~/.ssh/config`. */
  sshConfig?: string;
  identity?: string;
}

/** The execution environment's connection facts; refuses to start without them (I13). */
export function roomConnection(config: RunnerConfig): RoomConnection {
  const { slot, host, user, knownHosts, sshConfig, identity } = doorOf(config);
  if (slot === undefined || host === undefined || user === undefined || knownHosts === undefined) {
    throw lacking({ slot, host, user, known_hosts: knownHosts });
  }
  return setDefined<RoomConnection>(
    { host, user, hostKeyAlias: `pi-env-${slot}`, knownHosts },
    { sshConfig, identity },
  );
}
