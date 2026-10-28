// The one bounded exec (design sec-5, DEC-028 (3)): a child's output held to
// fixed caps as it streams, shared by the grep tool and the mail source.
//
// DEC-028 (3): grep's bounded exec is extracted here rather than copied, with
// an oversize option. "count" drops an oversize line and counts it, and later
// lines still arrive (grep notices them); "fail" treats one as a breach, as
// it does any stdout chunk that would pass the total ceiling, and the caller
// answers by killing the child (mail fails closed, no partial result). stdout
// goes through boundedLineSplitter — no parallel splitter — and stderr
// through headKeeper, so host memory per call is the caps plus the chunk in
// hand.

import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
  type ExecutionEnv,
  type ExecutionError,
  type ShellExecOptions,
  toError,
} from "@earendil-works/pi-durable/env";
import { boundedLineSplitter } from "./ndjson.ts";
import { headKeeper, type HeadKeeper } from "./truncate.ts";

export type Oversize = "fail" | "count";
export type Breach = "line" | "ceiling";

export interface BoundedOutputOptions {
  /** The most UTF-8 bytes one stdout line may hold, newline excluded. */
  maxLineBytes: number;
  /** The most UTF-8 bytes of stdout received in all (newlines included); default Infinity. */
  maxTotalBytes?: number;
  /** stderr head kept (headKeeper). */
  maxStderrBytes: number;
  /**
   * "count": an oversize line is dropped and counted, later lines still delivered (grep).
   * "fail": an oversize line is a breach (mail).
   */
  oversize: Oversize;
  /** Each complete, non-blank stdout line within the cap (boundedLineSplitter's onLine). */
  onLine: (line: string) => void;
  /** Called once, at the first breach, so the caller can stop the child. */
  onBreach?: (breach: Breach) => void;
}

export interface BoundedOutput {
  /** Route one decoded chunk. stderr goes to the head keeper; stdout to the splitter. */
  accept: (stream: "stdout" | "stderr", text: string) => void;
  /**
   * The first breach, or undefined. "line": a line over maxLineBytes in fail mode.
   * "ceiling": a stdout chunk that would take the total past maxTotalBytes (either mode;
   * that chunk is not pushed). After a breach, stdout is ignored: no further onLine.
   */
  readonly breach: Breach | undefined;
  /** Lines over maxLineBytes, dropped (count mode; in fail mode at most 1). */
  readonly oversized: number;
  /** The kept stderr head. */
  readonly stderr: HeadKeeper;
  /** UTF-8 bytes of stdout received (pushed) so far. */
  readonly stdoutBytes: number;
  /** The splitter's carry now: bytes of a line not yet terminated (<= maxLineBytes). */
  carriedBytes: () => number;
}

/**
 * A sink for one child's output within the caps: stdout lines through
 * boundedLineSplitter, the stderr head through headKeeper, and at most one
 * breach (the first) reported to `onBreach`.
 */
export function boundedOutput(options: BoundedOutputOptions): BoundedOutput {
  const { maxLineBytes, maxTotalBytes, maxStderrBytes, oversize, onLine, onBreach } = options;
  const ceiling = maxTotalBytes ?? Number.POSITIVE_INFINITY;
  const stderr = headKeeper(maxStderrBytes);
  let breach: Breach | undefined;
  let oversized = 0;
  let stdoutBytes = 0;
  const breached = (at: Breach): void => {
    if (breach === undefined) {
      breach = at;
      onBreach?.(at);
    }
  };
  const splitter = boundedLineSplitter({
    maxBytes: maxLineBytes,
    onLine: (line) => {
      if (breach === undefined) {
        onLine(line);
      }
    },
    onOversize: () => {
      if (breach === undefined) {
        oversized += 1;
        if (oversize === "fail") {
          breached("line");
        }
      }
    },
  });
  const acceptStdout = (text: string): void => {
    if (breach !== undefined) {
      return;
    }
    const size = Buffer.byteLength(text, "utf8");
    if (stdoutBytes + size > ceiling) {
      breached("ceiling");
      return;
    }
    stdoutBytes += size;
    splitter.push(text);
  };
  return {
    accept: (stream, text): void => {
      if (stream === "stderr") {
        stderr.accept(text);
      } else {
        acceptStdout(text);
      }
    },
    get breach(): Breach | undefined {
      return breach;
    },
    get oversized(): number {
      return oversized;
    },
    stderr,
    get stdoutBytes(): number {
      return stdoutBytes;
    },
    carriedBytes: () => splitter.carriedBytes(),
  };
}

export type ExecOutcome =
  | { kind: "exited"; exitCode: number }
  /** The caller's own stop (`stop` aborted) ended the child: result aborted while stop.aborted. */
  | { kind: "stopped" }
  /** Any other ExecutionError: timeout, spawn_error, ... */
  | { kind: "failed"; error: ExecutionError };

export interface BoundedExecOptions {
  /** Passed to env.exec as is (cwd, env, inheritEnv, timeout); onOutput is boundedExec's. */
  exec: Omit<ShellExecOptions, "onOutput">;
  output: Pick<BoundedOutput, "accept">;
  /** The caller's own stop: aborting it kills the child (grep's limit; mail's breach). */
  stop: AbortSignal;
}

/**
 * One exec whose output goes through `output`, mapped to what the caller
 * answers: exit, its own stop, or a failure. The CALLER's abort always
 * throws, even when the own stop also fired and even when the exec ended ok.
 */
export async function boundedExec(
  env: Pick<ExecutionEnv, "exec">,
  argv: readonly string[],
  options: BoundedExecOptions,
  context: Context,
): Promise<ExecOutcome> {
  const result = await env.exec(
    argv,
    {
      ...options.exec,
      onOutput: (text, _context, info) => {
        options.output.accept(info.stream, text);
      },
    },
    withAbortSignal(options.stop, context),
  );
  if (context.abortSignal?.aborted === true) {
    throw result.ok ? toError(context.abortSignal.reason) : result.error;
  }
  if (result.ok) {
    return { kind: "exited", exitCode: result.value.exitCode };
  }
  if (result.error.code === "aborted" && options.stop.aborted) {
    return { kind: "stopped" };
  }
  return { kind: "failed", error: result.error };
}
