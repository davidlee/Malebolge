// SL-007 PHASE-01 lane B: src/stdin-env.ts, the one stdin-capable exec
// (design § A stdin-capable spawner, DEC-051), so boundedExec and its caps
// are reused unchanged. Every case runs a real child — node -e through
// process.execPath, never a shell (DEC-028) — and mirrors how NodeExecutionEnv
// reports an exec: a Result, failures as ExecutionError values, never throws.

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, withCancel } from "@earendil-works/chord/context";
import type {
  ExecutionError,
  ExecutionErrorCode,
  Result,
  ShellExecOptions,
  ShellOutputInfo,
} from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { stdinEnv } from "../src/stdin-env.ts";

// ---------------------------------------------------------------- helpers

/** argv for one node one-liner; no shell is involved (DEC-028). */
const node = (script: string): string[] => [process.execPath, "-e", script];

/** The options every case passes: pi-durable inherits unless inheritEnv is false. */
const ENV: ShellExecOptions = { inheritEnv: false };

interface Captured {
  stdout: string;
  stderr: string;
  /** Each chunk's stream tag, in arrival order. */
  streams: ("stdout" | "stderr")[];
}

/**
 * Collect onOutput per stream, so how the child's output is chunked never
 * changes an assertion, and keep the stream tags it was given.
 */
function capture(): {
  output: Captured;
  onOutput: (text: string, at: Context, info: ShellOutputInfo) => void;
} {
  const output: Captured = { stdout: "", stderr: "", streams: [] };
  return {
    output,
    onOutput: (text, _at, info): void => {
      output[info.stream] += text;
      output.streams.push(info.stream);
    },
  };
}

/** The value of a successful exec; a failure here fails the case. */
function successOf<T>(result: Result<T, ExecutionError>): T {
  if (!result.ok) {
    throw new Error(
      `expected the exec to succeed, got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}

function codeOf(result: Result<unknown, ExecutionError>): ExecutionErrorCode {
  if (result.ok) {
    throw new Error("expected the exec to fail");
  }
  return result.error.code;
}

// ------------------------------------------------------------------ cases

describe("stdinEnv", () => {
  it("delivers input on stdin and closes it: the child echoes stdin back after EOF", async () => {
    const input = "one\ntwo\n三\n";
    const { output, onOutput } = capture();
    const result = await stdinEnv(input).exec(
      node(
        'let data = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => { data += chunk; });\nprocess.stdin.on("end", () => { process.stdout.write(data); });',
      ),
      { ...ENV, onOutput },
      context,
    );
    expect(successOf(result)).toEqual({ exitCode: 0 });
    expect(output.stdout).toBe(input);
    expect(output.streams.length).toBeGreaterThan(0);
    expect(output.streams.every((stream) => stream === "stdout")).toBe(true);
  });

  it("reports stderr through onOutput tagged stream: stderr", async () => {
    const { output, onOutput } = capture();
    const result = await stdinEnv("").exec(
      node('process.stderr.write("boom\\n");'),
      { ...ENV, onOutput },
      context,
    );
    expect(successOf(result).exitCode).toBe(0);
    expect(output.stderr).toContain("boom");
    expect(output.streams).toContain("stderr");
    expect(output.streams).not.toContain("stdout");
  });

  it("reports a non-zero exit code as { exitCode: n }, not as an error", async () => {
    const result = await stdinEnv("").exec(node("process.exit(3);"), ENV, context);
    expect(successOf(result).exitCode).toBe(3);
  });

  it("ignores EPIPE when the child exits without reading a large input", async () => {
    // Far past any pipe buffer, so the write meets a closed pipe once the
    // child is gone; the result is still the child's own exit code.
    const input = "x".repeat(4 * 1024 * 1024);
    const result = await stdinEnv(input).exec(node("process.exit(7);"), ENV, context);
    expect(successOf(result).exitCode).toBe(7);
  });

  it("timeout (seconds) kills a sleeping child: error timeout", async () => {
    const result = await stdinEnv("").exec(
      node("setTimeout(() => {}, 5000);"),
      { ...ENV, timeout: 0.2 },
      context,
    );
    expect(codeOf(result)).toBe("timeout");
  });

  it("aborting the context kills the child: error aborted", async () => {
    const { context: cancellable, cancel } = withCancel(context);
    const timer = setTimeout(() => {
      cancel();
    }, 150);
    try {
      const result = await stdinEnv("").exec(node("setTimeout(() => {}, 5000);"), ENV, cancellable);
      expect(codeOf(result)).toBe("aborted");
    } finally {
      clearTimeout(timer);
    }
  });

  it("reports a missing executable as spawn_error", async () => {
    const result = await stdinEnv("").exec(
      ["malebolge-stdin-env-no-such-executable"],
      ENV,
      context,
    );
    expect(codeOf(result)).toBe("spawn_error");
  });

  it("env replaces the environment: the child sees FOO and not a variable set here", async () => {
    const inherited = "MALEBOLGE_STDIN_ENV_INHERITED";
    process.env[inherited] = "1";
    try {
      const { output, onOutput } = capture();
      const result = await stdinEnv("").exec(
        node(
          `process.stdout.write(JSON.stringify({ foo: process.env.FOO ?? null, inherited: process.env.${inherited} ?? null }));`,
        ),
        { inheritEnv: false, env: { FOO: "1" }, onOutput },
        context,
      );
      expect(successOf(result).exitCode).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({ foo: "1", inherited: null });
    } finally {
      Reflect.deleteProperty(process.env, inherited);
    }
  });

  // pi-durable's getShellEnv inherits when inheritEnv is absent, so the
  // design's "inheritEnv must be false" refuses both the explicit true and
  // the absent form. The refusal mirrors NodeExecutionEnv's invalid-request
  // convention (its "Empty argv" is a spawn_error).
  it("refuses inheritEnv: true, which would leak this process's environment", async () => {
    const result = await stdinEnv("").exec(node("process.exit(0);"), { inheritEnv: true }, context);
    expect(codeOf(result)).toBe("spawn_error");
  });

  it("refuses an absent inheritEnv, which pi-durable reads as inherit", async () => {
    const result = await stdinEnv("").exec(node("process.exit(0);"), {}, context);
    expect(codeOf(result)).toBe("spawn_error");
  });

  it("honours cwd: the child's process.cwd() is the directory given", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "malebolge-stdin-env-")));
    try {
      const { output, onOutput } = capture();
      const result = await stdinEnv("").exec(
        node("process.stdout.write(process.cwd());"),
        { ...ENV, cwd: dir, onOutput },
        context,
      );
      expect(successOf(result).exitCode).toBe(0);
      expect(output.stdout).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a string command, which would run through a shell (DEC-028)", async () => {
    const result = await stdinEnv("").exec("printf hello", ENV, context);
    expect(codeOf(result)).toBe("spawn_error");
  });
});
