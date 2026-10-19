// The patch-job runner's project-context fetch (design §4.2): the last step
// of readying the room, reading the repo's context files from the room's
// clone through the room tier's source reader, and doctrine's boot. Every
// exec is bounded (the repo's tool set may supply the binaries); a failure is
// classified once (source-reader.ts) into a rethrow (retry, trust) or a
// degradation the job runs on with.

import {
  type ContextSource,
  capSource,
  readSources,
  SOURCE_CAP_BYTES,
} from "../project-context.ts";
import { type RoomShell, type ShellLimits } from "../room/shell.ts";
import {
  answerable,
  type Attempt,
  attempt,
  attemptNamed,
  type ReadFailure,
  roomSourceReader,
} from "../room/source-reader.ts";
import type { RepoConfig } from "./config.ts";
import { type FinalStep, PrepareFailed } from "./prepare.ts";
import { type CloneDefect, type GitChannel } from "./door.ts";

/** The bounds of doctrine's boot (design §4.3): its stdout is a source, so overflow is truncation. */
export const DOCTRINE_LIMITS = {
  timeoutS: 60,
  maxStdoutBytes: SOURCE_CAP_BYTES + 1,
  maxStderrBytes: 4096,
} as const satisfies ShellLimits;

/** A failed step's answer, before it is pinned to a source: a read's, or doctrine's own. */
type Failure =
  | ReadFailure
  | { reason: "exit"; code: number; stderr: string }
  | { reason: "boot_not_ignored" | "empty" };

/** A source the fetch could not read, and why; the job runs on without it. */
export type Degradation = {
  /** `"doctrine"`, or the file (or directory) the failed exec was about. */
  source: string;
} & Failure;

export interface Fetched {
  sources: ContextSource[];
  degraded: Degradation[];
}

const DOCTRINE_ARGV = ["doctrine", "prompt", "resolve", "--role", "orchestrator"] as const;
const BOOT_ORIGIN = { command: DOCTRINE_ARGV.join(" ") };

/** Doctrine's run as a source, or the failure it degrades to (design §4.3). */
function bootOf(ran: Attempt): { source: ContextSource } | { failure: Failure } {
  if ("failure" in ran) {
    return ran;
  }
  const { code, stdout, stderr, overflowed } = ran.output;
  if (!overflowed && code !== 0) {
    return { failure: { reason: "exit", code, stderr } };
  }
  // Whitespace says nothing: the boot is empty.
  return stdout.trim() === ""
    ? { failure: { reason: "empty" } }
    : { source: capSource(BOOT_ORIGIN, stdout) };
}

/** The clone check readyRoom runs before the job branch, reused as the re-check. */
type CheckClone = GitChannel["checkClone"];

/**
 * The clone checked again after doctrine ran (design §4.3), by the check
 * before it: a defect fails preparing with it; a check that cannot finish
 * (timeout, overflowed probe, failed status) fails closed as `dirty_clone`
 * with no paths. A lost room, a host key and the caller's abort are
 * rethrown. Never cleans.
 */
async function recheckClone(
  checkClone: CheckClone,
  shell: RoomShell,
  repo: RepoConfig,
  signal: AbortSignal,
): Promise<void> {
  let defect: CloneDefect | undefined;
  try {
    defect = await checkClone(shell, repo, signal);
  } catch (error) {
    answerable(error, signal); // rethrows all but a ChannelFailed the step answers for
    defect = { reason: "dirty_clone", paths: [] };
  }
  if (defect !== undefined) {
    throw new PrepareFailed(defect);
  }
}

/** The doctrine step's answer: its boot (none without `.doctrine/`), or why it has none. */
type BootStep = { source?: ContextSource } | { failure: Failure };

/**
 * Doctrine's boot for the clone (design §4.3), when `.doctrine/` is there and
 * its boot is ignored: `doctrine prompt resolve`, whatever its outcome, then
 * the clone re-checked, since a repo's doctrine may write more than its boot.
 */
async function doctrineBoot(
  checkClone: CheckClone,
  shell: RoomShell,
  repo: RepoConfig,
  signal: AbortSignal,
): Promise<BootStep> {
  const present = await attemptNamed(shell, signal, ["test", "-d", ".doctrine"], [0, 1]);
  if ("failure" in present) {
    return present;
  }
  if (present.output.code === 1) {
    return {};
  }
  const ignore = ["git", "check-ignore", "-q", ".doctrine/state/boot.md"];
  const ignored = await attemptNamed(shell, signal, ignore, [0, 1]);
  if ("failure" in ignored) {
    return ignored;
  }
  if (ignored.output.code === 1) {
    return { failure: { reason: "boot_not_ignored" } };
  }
  const boot = bootOf(await attempt(shell, signal, DOCTRINE_ARGV, DOCTRINE_LIMITS));
  await recheckClone(checkClone, shell, repo, signal);
  return boot;
}

/**
 * readyRoom's final step for `repo`: its context sources read from the
 * room's clone (the runner's cwd, its git root), doctrine's boot among them,
 * and what could not be read; `checkClone` is the channel's, which readyRoom
 * ran first. Degradations belong to the call, so a retried attempt's are
 * dropped with it.
 */
export function fetchProjectContext(repo: RepoConfig, checkClone: CheckClone): FinalStep<Fetched> {
  return async (shell, signal) => {
    const degraded: Degradation[] = [];
    const boot = await doctrineBoot(checkClone, shell, repo, signal);
    if ("failure" in boot) {
      degraded.push({ source: "doctrine", ...boot.failure });
    }
    const reader = roomSourceReader(shell, signal, (source, failure) => {
      degraded.push({ source, ...failure });
    });
    const extra = "source" in boot ? boot.source : undefined;
    const sources = await readSources(repo.guestPath, [repo.guestPath], reader, extra);
    return { sources, degraded };
  };
}
