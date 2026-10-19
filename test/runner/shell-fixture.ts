// Helpers for tests over a room shell: real pi-env connections and temp dirs
// released after each test, a rejection probe, a fake shell that records its
// calls, and a recorder over a real one.

import type { Connection } from "@earendil-works/pi-env";
import { afterEach } from "vitest";
import type { RoomShell, ShellLimits, ShellOutput } from "../../src/runner/room.ts";
import { tempDir } from "../fixtures.ts";

/** A signal that never aborts. */
export const never = (): AbortSignal => new AbortController().signal;

/** Rejection of `promise`, or a failure if it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

export interface ShellKit {
  /** `connection`, closed after the test. */
  open: (connection: Connection) => Connection;
  /** A temp dir, removed after the test (even when it fails). */
  scratch: () => Promise<string>;
}

/** Call at a test file's top level: what `open` and `scratch` hand out is released after each test. */
export function shellKit(): ShellKit {
  const opened: Connection[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const connection of opened.splice(0)) {
      connection.close();
    }
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });
  return {
    open: (connection): Connection => {
      opened.push(connection);
      return connection;
    },
    scratch: async (): Promise<string> => {
      const tmp = await tempDir();
      cleanups.push(tmp.cleanup);
      return tmp.dir;
    },
  };
}

/** A shell answer: exit `code` with `stdout` and `stderr`. */
export const exit = (code: number, stdout = "", stderr = ""): ShellOutput => ({
  code,
  stdout,
  stderr,
});

/** A shell answer: stdout passed its cap, `stdout` its head (the code is meaningless). */
export const overflowed = (stdout: string): ShellOutput => ({
  code: -1,
  stdout,
  stderr: "",
  overflowed: true,
});

/** One call a shell was given. */
export interface ShellCall {
  argv: string[];
  cwd: string | undefined;
  limits: ShellLimits | undefined;
}

/** How a fake shell answers a call; throwing rejects the call. */
export type ShellAnswer = (argv: readonly string[]) => ShellOutput;

/** A fake shell answering each call by `answer`, recording every call. */
export function recordingShell(answer: ShellAnswer): { shell: RoomShell; calls: ShellCall[] } {
  const calls: ShellCall[] = [];
  const shell: RoomShell = (argv, _signal, cwd, limits) => {
    calls.push({ argv: [...argv], cwd, limits });
    return Promise.resolve().then(() => answer(argv));
  };
  return { shell, calls };
}

/** A call's command: git's subcommand, else the binary. */
const commandOf = (argv: readonly string[]): string =>
  (argv[0] === "git" ? argv[1] : argv[0]) ?? "";

/**
 * Answers by the command (`commandOf`): an override when one names it, else
 * `rev-parse` finds nothing (exit 1) and the rest exit 0.
 */
export const by =
  (overrides: Record<string, ShellAnswer> = {}): ShellAnswer =>
  (argv) => {
    const command = commandOf(argv);
    return overrides[command]?.(argv) ?? exit(command === "rev-parse" ? 1 : 0);
  };

/** One call through an `observedShell`: as requested, and what it cost. */
export interface ObservedCall extends ShellCall {
  /** The timeout the inner shell was given (the requested one, scaled). */
  passedTimeoutS: number | undefined;
  ms: number;
  stdoutBytes: number;
  stderrBytes: number;
  /** Whether the call rejected. */
  rejected: boolean;
}

/**
 * `inner`, recording each call: its limits as requested, the time it took and
 * the bytes it answered. Each call's `timeoutS` reaches `inner` multiplied by
 * `timeScale` (default 1), so a test can run a production bound in a fraction
 * of its time while the real timeout and kill still happen.
 */
export function observedShell(
  inner: RoomShell,
  options: { timeScale?: number } = {},
): { shell: RoomShell; calls: ObservedCall[] } {
  const scale = options.timeScale ?? 1;
  const calls: ObservedCall[] = [];
  const shell: RoomShell = async (argv, signal, cwd, limits) => {
    const passed =
      limits?.timeoutS === undefined ? limits : { ...limits, timeoutS: limits.timeoutS * scale };
    const call: ObservedCall = {
      argv: [...argv],
      cwd,
      limits,
      passedTimeoutS: passed?.timeoutS,
      ms: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      rejected: true,
    };
    calls.push(call);
    const start = performance.now();
    try {
      const output = await inner(argv, signal, cwd, passed);
      call.rejected = false;
      call.stdoutBytes = Buffer.byteLength(output.stdout, "utf8");
      call.stderrBytes = Buffer.byteLength(output.stderr, "utf8");
      return output;
    } finally {
      call.ms = performance.now() - start;
    }
  };
  return { shell, calls };
}
