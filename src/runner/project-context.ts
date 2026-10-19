// The patch-job runner's project-context fetch (design §4.2): the last step
// of readying the room, reading the repo's context files from the room's
// clone through its shell. Every exec is bounded (the repo's tool set may
// supply the binaries); a failure is classified once, by error type then
// code, into a rethrow (retry, trust) or a degradation the job runs on with.

import { join } from "node:path";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import {
  type ContextSource,
  capSource,
  readSources,
  SOURCE_CAP_BYTES,
  type SourceReader,
} from "../project-context.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  type RoomShell,
  type ShellLimits,
  type ShellOutput,
} from "../room/shell.ts";
import type { RepoConfig } from "./config.ts";
import { type FinalStep, PrepareFailed } from "./prepare.ts";
import { type CloneDefect, type GitChannel } from "./room.ts";

/** The bounds of a fetch exec that prints little: `stat`, `test`, `git` (design §4.2). */
export const FETCH_LIMITS = {
  timeoutS: 10,
  maxStdoutBytes: 4096,
  maxStderrBytes: 4096,
} as const satisfies ShellLimits;

/** The bounds of a capped read: overflow there is truncation. */
export const HEAD_LIMITS = {
  ...FETCH_LIMITS,
  maxStdoutBytes: SOURCE_CAP_BYTES + 1,
} as const satisfies ShellLimits;

/** The bounds of doctrine's boot (design §4.3): its stdout is a source, so overflow is truncation. */
export const DOCTRINE_LIMITS = {
  timeoutS: 60,
  maxStdoutBytes: SOURCE_CAP_BYTES + 1,
  maxStderrBytes: 4096,
} as const satisfies ShellLimits;

/** A source the fetch could not read, and why; the job runs on without it. */
export interface Degradation {
  /** `"doctrine"`, or the file (or directory) the failed exec was about. */
  source: string;
  reason: "boot_not_ignored" | "missing" | "exit" | "timeout" | "overflow" | "empty" | "error";
  code?: number | string;
  stderr?: string;
}

/** What a failed exec says, before it is pinned to a source. */
type Failure = Omit<Degradation, "source">;

export interface Fetched {
  sources: ContextSource[];
  degraded: Degradation[];
}

/**
 * `error`, unless it is a ChannelFailed a step may answer for: the caller's
 * abort, a lost room (retried by readyRoom, whatever its cause) and an
 * untrusted host key are rethrown, as is anything not a channel error (a bug).
 */
function answerable(error: unknown, signal: AbortSignal): ChannelFailed {
  if (
    signal.aborted ||
    error instanceof ChannelUnavailable ||
    !(error instanceof ChannelFailed) ||
    error.reason === "host_key"
  ) {
    throw error;
  }
  return error;
}

/**
 * The degradation an exec's rejection is, or the rejection rethrown (design
 * §4.2 table, first match wins; `answerable`): a ChannelFailed is classified
 * by its exec cause's code.
 */
function classifyFetchFailure(rejected: unknown, signal: AbortSignal): Failure {
  const error = answerable(rejected, signal);
  const code = error.cause instanceof ExecutionError ? error.cause.code : error.reason;
  if (code === "spawn_error") {
    return { reason: "missing" };
  }
  if (code === "timeout") {
    return { reason: "timeout" };
  }
  return { reason: "error", code };
}

type Attempt = { output: ShellOutput } | { failure: Failure };

/** One bounded exec from the clone: its output, or the failure it classifies as. */
async function attempt(
  shell: RoomShell,
  signal: AbortSignal,
  argv: readonly string[],
  limits: ShellLimits,
): Promise<Attempt> {
  try {
    return { output: await shell(argv, signal, undefined, limits) };
  } catch (error) {
    return { failure: classifyFetchFailure(error, signal) };
  }
}

/**
 * `attempt` within FETCH_LIMITS of a step that expects little output and
 * names exit `codes`: an overflow is `overflow`, any other code `error`.
 */
async function attemptNamed(
  shell: RoomShell,
  signal: AbortSignal,
  argv: readonly string[],
  codes: readonly number[],
): Promise<Attempt> {
  const outcome = await attempt(shell, signal, argv, FETCH_LIMITS);
  if ("failure" in outcome) {
    return outcome;
  }
  const { code, stderr, overflowed } = outcome.output;
  if (overflowed) {
    return { failure: { reason: "overflow" } };
  }
  return codes.includes(code) ? outcome : { failure: { reason: "error", code, stderr } };
}

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;

/** The paths `stat --printf '%f %n\n'` output reports as regular files; lines that do not parse are skipped. */
function regularPaths(stdout: string): Set<string> {
  const regular = new Set<string>();
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    const mode = line.slice(0, space);
    if (
      space > 0 &&
      /^[0-9a-f]+$/i.test(mode) &&
      (Number.parseInt(mode, 16) & S_IFMT) === S_IFREG
    ) {
      regular.add(line.slice(space + 1));
    }
  }
  return regular;
}

/**
 * A SourceReader over the room's shell, recording each degradation in
 * `degraded`. `regularFiles` is one `stat -L` of absolute paths from the
 * clone (an absent directory is then a missing name, not a failed cwd): it
 * reads inodes and opens nothing, so a FIFO cannot block it; exit 0, or 1
 * with some names absent, answers with the lines printed. `readCapped` is
 * `head -c`: an overflow is the head (capSource truncates it), a non-zero
 * exit an unreadable file.
 */
function roomSourceReader(
  shell: RoomShell,
  signal: AbortSignal,
  degraded: Degradation[],
): SourceReader {
  const failed = (source: string, failure: Failure): void => {
    degraded.push({ source, ...failure });
  };
  return {
    regularFiles: async (dir, names): Promise<ReadonlySet<string>> => {
      const paths = names.map((name) => join(dir, name));
      const [only] = paths;
      const source = paths.length === 1 && only !== undefined ? only : dir;
      const stat = ["stat", "-L", "--printf", "%f %n\\n", "--", ...paths];
      const outcome = await attemptNamed(shell, signal, stat, [0, 1]);
      if ("failure" in outcome) {
        failed(source, outcome.failure);
        return new Set();
      }
      // Only names asked for: a path stat printed but was not given is ignored.
      const regular = regularPaths(outcome.output.stdout);
      return new Set(names.filter((name) => regular.has(join(dir, name))));
    },
    readCapped: async (path): Promise<string | undefined> => {
      const outcome = await attempt(
        shell,
        signal,
        ["head", "-c", String(SOURCE_CAP_BYTES + 1), "--", path],
        HEAD_LIMITS,
      );
      if ("failure" in outcome) {
        failed(path, outcome.failure);
        return undefined;
      }
      const { output } = outcome;
      return output.overflowed || output.code === 0 ? output.stdout : undefined;
    },
  };
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
    const reader = roomSourceReader(shell, signal, degraded);
    const extra = "source" in boot ? boot.source : undefined;
    const sources = await readSources(repo.guestPath, [repo.guestPath], reader, extra);
    return { sources, degraded };
  };
}
