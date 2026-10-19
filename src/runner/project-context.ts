// The patch-job runner's project-context fetch (design §4.2): the last step
// of readying the room, reading the repo's context files from the room's
// clone through its shell. Every exec is bounded (the repo's tool set may
// supply the binaries); a failure is classified once, by error type then
// code, into a rethrow (retry, trust) or a degradation the job runs on with.

import { join } from "node:path";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import {
  type ContextSource,
  readSources,
  SOURCE_CAP_BYTES,
  type SourceReader,
} from "../project-context.ts";
import type { RepoConfig } from "./config.ts";
import type { FinalStep } from "./prepare.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  type RoomShell,
  type ShellLimits,
  type ShellOutput,
} from "./room.ts";

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
 * The degradation an exec's rejection is, or the rejection rethrown (design
 * §4.2 table, first match wins): the caller's abort, a lost room (retried by
 * readyRoom, whatever its cause) and an untrusted host key are rethrown, as
 * is anything not a channel error (a bug); a ChannelFailed is classified by
 * its exec cause's code.
 */
function classifyFetchFailure(error: unknown, signal: AbortSignal): Failure {
  if (
    signal.aborted ||
    error instanceof ChannelUnavailable ||
    !(error instanceof ChannelFailed) ||
    error.reason === "host_key"
  ) {
    throw error;
  }
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

/**
 * readyRoom's final step for `repo`: its context sources read from the
 * room's clone (the runner's cwd, its git root), and what could not be read.
 * Degradations belong to the call, so a retried attempt's are dropped with it.
 */
export function fetchProjectContext(repo: RepoConfig): FinalStep<Fetched> {
  return async (shell, signal) => {
    const degraded: Degradation[] = [];
    const reader = roomSourceReader(shell, signal, degraded);
    const sources = await readSources(repo.guestPath, [repo.guestPath], reader);
    return { sources, degraded };
  };
}
