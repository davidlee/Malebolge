// The room session's source reader (design §4.1, §4.2; invariants in
// connection.ts): project-context reads over a room shell, every exec
// bounded. A failure is classified once, by error type then code: what a read
// may answer for goes to the caller's callback as a ReadFailure; the caller's
// abort, a lost room, an untrusted host key and non-channel errors are
// rethrown.

import { join } from "node:path";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { SOURCE_CAP_BYTES, type SourceReader } from "../project-context.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  type RoomShell,
  type ShellLimits,
  type ShellOutput,
} from "./shell.ts";

/** Why a read failed, before it is pinned to a source. */
export type ReadFailure =
  | { reason: "missing" | "timeout" | "overflow" }
  | { reason: "error"; code?: number | string; stderr?: string };

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

/**
 * `error`, unless it is a ChannelFailed a step may answer for: the caller's
 * abort, a lost room (the caller retries it, whatever its cause) and an
 * untrusted host key are rethrown, as is anything not a channel error (a bug).
 */
export function answerable(error: unknown, signal: AbortSignal): ChannelFailed {
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
function classifyFetchFailure(rejected: unknown, signal: AbortSignal): ReadFailure {
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

export type Attempt = { output: ShellOutput } | { failure: ReadFailure };

/** One bounded exec in the shell's directory: its output, or the failure it classifies as. */
export async function attempt(
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
export async function attemptNamed(
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
 * A SourceReader over the room's shell, each read that fails handed to
 * `failed` with the source it was about. `regularFiles` is one `stat -L` of
 * absolute paths from the shell's directory (an absent directory is then a
 * missing name, not a failed cwd): it reads inodes and opens nothing, so a FIFO cannot block it; exit 0, or 1
 * with some names absent, answers with the lines printed. `readCapped` is
 * `head -c`: an overflow is the head (capSource truncates it), a non-zero
 * exit an unreadable file.
 */
export function roomSourceReader(
  shell: RoomShell,
  signal: AbortSignal,
  failed: (source: string, failure: ReadFailure) => void,
): SourceReader {
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
