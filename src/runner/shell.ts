// The room's shell (design §5.2 "Env uses outside `running`"): argument
// vectors run in the room's clone through a job's daemon connection, for the
// `preparing` checks and switch and the clean after collect. Its observer
// only counts: a lost connection makes the step ChannelUnavailable and never
// marks a pause (EX-8). Only the running job's tools pause (pause.ts).
//
// Each call may carry ShellLimits (design §4.2): stdout past its cap stops the
// exec through an abort of the shell's own and answers the head, `overflowed`;
// stderr is capped while streaming; the timeout is pi-env's. Host memory per
// exec stays within the caps: nothing is kept past them.

import { withAbortSignal } from "@earendil-works/chord/context";
import type { ExecutionError, Result, ShellExecResult } from "@earendil-works/pi-durable/env";
import type { Connection } from "@earendil-works/pi-env";
import { context } from "../context.ts";
import { capUtf8 } from "../truncate.ts";
import { type HostKeyFailure, jobEnv } from "./env.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  type RoomShell,
  type ShellLimits,
  type ShellOutput,
} from "./room.ts";

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
  const max = {
    stdout: limits.maxStdoutBytes ?? Infinity,
    stderr: limits.maxStderrBytes ?? Infinity,
  };
  const kept = { stdout: "", stderr: "" };
  const bytes = { stdout: 0, stderr: 0 };
  const full = { stdout: false, stderr: false };
  return {
    accept: (stream, text): void => {
      if (full[stream]) {
        return;
      }
      const size = Buffer.byteLength(text, "utf8");
      if (bytes[stream] + size <= max[stream]) {
        kept[stream] += text;
        bytes[stream] += size;
        return;
      }
      kept[stream] += capUtf8(text, max[stream] - bytes[stream]).text;
      full[stream] = true;
      if (stream === "stdout") {
        onOverflow();
      }
    },
    output: (): Collected => ({ ...kept, overflowed: full.stdout }),
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
 * A shell in the room's clone `cwd` over the job's daemon `connection`. The
 * environment turns a lost connection into an exec failure; its connection
 * reports the loss by type first, which is what makes it ChannelUnavailable.
 * A loss whose start failed trust is ChannelFailed `host_key` instead: never
 * retried. Counting only: nothing here marks a pause (EX-8).
 */
export function roomShell(connection: Connection, jobId: string, cwd: string): RoomShell {
  let losses = 0;
  const untrusted: HostKeyFailure[] = [];
  const env = jobEnv({
    jobId,
    cwd,
    connection,
    observer: {
      lost: () => {
        losses++;
        return Promise.resolve();
      },
      untrusted: (_failure, trust) => {
        untrusted.push(trust);
      },
    },
  });
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
