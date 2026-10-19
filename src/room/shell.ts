// The room session's shell (design §4.1, §4.2; invariants in connection.ts):
// argument vectors run in the room over a daemon connection, typed by how
// they failed. Its observer only counts: a lost connection makes the call
// ChannelUnavailable, a start that failed trust ChannelFailed `host_key`;
// any reaction is the caller's.
//
// Each call may carry ShellLimits: stdout past its cap stops the exec through
// an abort of the shell's own and answers the head, `overflowed`; stderr is
// capped while streaming; the timeout is pi-env's. Host memory per exec stays
// within the caps: nothing is kept past them.

import { withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionError, Result, ShellExecResult } from "@earendil-works/pi-durable/env";
import type { Connection } from "@earendil-works/pi-env";
import { context } from "../context.ts";
import { headKeeper } from "../truncate.ts";
import { type HostKeyFailure, observedEnv } from "./connection.ts";

/** Per-exec bounds on a room shell call (design §4.2); each absent bound is no bound. */
export interface ShellLimits {
  /** Stop the exec once stdout passes this many bytes; the result is `overflowed`. */
  maxStdoutBytes?: number;
  /** Keep at most this many stderr bytes. */
  maxStderrBytes?: number;
  /** pi-env's exec timeout, seconds. */
  timeoutS?: number;
}

export interface ShellOutput {
  /** The exit code; meaningless when `overflowed` (the shell may have stopped the process). */
  code: number;
  stdout: string;
  stderr: string;
  /** Stdout passed `maxStdoutBytes`: `stdout` is its head, cut at a character boundary. */
  overflowed?: true;
}

/**
 * Runs an argument vector in the shell's directory (or `cwd`), within `limits`;
 * ChannelUnavailable when the room is down.
 */
export type RoomShell = (
  argv: readonly string[],
  signal: AbortSignal,
  cwd?: string,
  limits?: ShellLimits,
) => Promise<ShellOutput>;

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
 * records: `channel_refusal` is a refusal of the caller's own argv or config
 * (a caller bug); `host_key` is the room's host key unknown or changed at a
 * daemon start (a trust failure, never retried).
 */
export class ChannelFailed extends Error {
  readonly reason: "channel_failed" | "channel_refusal" | "host_key";

  constructor(message: string, options: ChannelErrorOptions<ChannelFailed["reason"]> = {}) {
    super(message, options);
    this.name = "ChannelFailed";
    this.reason = options.reason ?? "channel_failed";
  }
}

/**
 * `argv`'s `output`, when it did not overflow: ChannelFailed when it did, for
 * a step that expects no more output than its limits allow (its exit code is
 * then meaningless).
 */
export function notOverflowed(argv: readonly string[], output: ShellOutput): ShellOutput {
  if (output.overflowed) {
    throw new ChannelFailed(`${argv.join(" ")}: output overflowed`);
  }
  return output;
}

/** `argv`'s stdout from `output`; ChannelFailed when it overflowed or exited non-zero. */
export function successStdout(argv: readonly string[], output: ShellOutput): string {
  const { code, stdout, stderr } = notOverflowed(argv, output);
  if (code !== 0) {
    throw new ChannelFailed(`${argv.join(" ")} exited ${String(code)}: ${stderr.trim()}`);
  }
  return stdout;
}

/** `argv`'s stdout, run within `limits`; ChannelFailed when it overflows or exits non-zero. */
export async function succeeded(
  shell: RoomShell,
  argv: readonly string[],
  signal: AbortSignal,
  limits?: ShellLimits,
): Promise<string> {
  return successStdout(argv, await shell(argv, signal, undefined, limits));
}

/** The exit code of an exec the shell stopped for overflowing: no process exit to report. */
export const OVERFLOW_EXIT_CODE = -1;

type Stream = "stdout" | "stderr";

/** What an exec printed, within its caps. */
export interface Collected {
  stdout: string;
  stderr: string;
  /** Stdout passed `maxStdoutBytes`. */
  overflowed: boolean;
}

export interface OutputCollector {
  accept: (stream: Stream, text: string) => void;
  output: () => Collected;
}

/**
 * Output chunks accumulated within `limits`: each stream keeps its head up to
 * its cap, cut at a character boundary, and drops everything after. Stdout
 * passing its cap calls `onOverflow`, once; stderr's cap is silent.
 */
export function outputCollector(limits: ShellLimits, onOverflow: () => void): OutputCollector {
  const kept = {
    stdout: headKeeper(limits.maxStdoutBytes ?? Infinity),
    stderr: headKeeper(limits.maxStderrBytes ?? Infinity),
  };
  return {
    accept: (stream, text): void => {
      const keeper = kept[stream];
      if (keeper.full) {
        return;
      }
      if (!keeper.accept(text) && stream === "stdout") {
        onOverflow();
      }
    },
    output: (): Collected => ({
      stdout: kept.stdout.text,
      stderr: kept.stderr.text,
      overflowed: kept.stdout.full,
    }),
  };
}

/** What, besides exec's result, decides a shell call's outcome. */
export interface ExecFacts {
  /** A daemon start during the call failed trust. */
  trust: HostKeyFailure | undefined;
  /** The connection was lost during the call. */
  lost: boolean;
  /** The caller's signal aborted. */
  callerAborted: boolean;
  output: Collected;
}

/**
 * A shell call's outcome, first match wins: an exit is its output
 * (`overflowed` if stdout passed its cap); a trust failure is ChannelFailed
 * `host_key`; a loss is ChannelUnavailable (known only by the count: pi-env
 * collapses it to `unknown`); the caller's abort is ChannelFailed, even when
 * the shell's own abort also fired; the shell's own abort is the head,
 * `overflowed`; anything else (a timeout included) is ChannelFailed.
 */
export function settle(
  argv: readonly string[],
  result: Result<ShellExecResult, ExecutionError>,
  facts: ExecFacts,
): ShellOutput {
  const { stdout, stderr, overflowed } = facts.output;
  const answer = (code: number): ShellOutput =>
    overflowed ? { code, stdout, stderr, overflowed } : { code, stdout, stderr };
  if (result.ok) {
    return answer(result.value.exitCode);
  }
  const message = `${argv.join(" ")}: ${result.error.message}`;
  if (facts.trust !== undefined) {
    throw new ChannelFailed(message, { cause: facts.trust, reason: "host_key" });
  }
  if (facts.lost) {
    throw new ChannelUnavailable(message, { cause: result.error });
  }
  if (!facts.callerAborted && overflowed && result.error.code === "aborted") {
    return answer(OVERFLOW_EXIT_CODE);
  }
  throw new ChannelFailed(message, { cause: result.error });
}

/**
 * A shell over the daemon `connection`, in `cwd`, as environment `id`. The
 * environment turns a lost connection into an exec failure; its connection
 * reports the loss by type first, which is what makes it ChannelUnavailable.
 * A loss whose start failed trust is ChannelFailed `host_key` instead: never
 * retried.
 */
export function roomShell(
  connection: Connection,
  { id, cwd }: { id: string; cwd: string },
): RoomShell {
  let losses = 0;
  const untrusted: HostKeyFailure[] = [];
  const env = observedEnv(
    connection,
    {
      lost: (): Promise<void> => {
        losses++;
        return Promise.resolve();
      },
      untrusted: (_failure, trust): void => {
        untrusted.push(trust);
      },
    },
    { id, cwd },
  );
  return async (argv, signal, at, limits = {}) => {
    const before = losses;
    const trustedBefore = untrusted.length;
    const own = new AbortController();
    const collector = outputCollector(limits, () => {
      own.abort();
    });
    const result = await env.exec(
      argv,
      {
        ...(at === undefined ? {} : { cwd: at }),
        ...(limits.timeoutS === undefined ? {} : { timeout: limits.timeoutS }),
        onOutput: (text, _context, info) => {
          collector.accept(info.stream, text);
        },
      },
      withAbortSignal(AbortSignal.any([signal, own.signal]), context),
    );
    return settle(argv, result, {
      trust: untrusted.at(trustedBefore),
      lost: losses > before,
      callerAborted: signal.aborted,
      output: collector.output(),
    });
  };
}
