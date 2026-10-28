// SL-005 PHASE-06: the one bounded exec (design sec-5, DEC-028 (3)) — the
// pure output sink held to its caps, and the exec wiring grep and mail share.
// Every chunk here is handed to the fake env's `onOutput` by the fake itself,
// so no child and no large fixture is needed.

import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
  err,
  type ExecutionEnv,
  ExecutionError,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import {
  type BoundedExecOptions,
  type BoundedOutput,
  boundedExec,
  boundedOutput,
  type Breach,
  type Oversize,
} from "../src/bounded-exec.ts";
import { context } from "../src/context.ts";

// ---- the pure output sink ---------------------------------------------------

const MODES: readonly Oversize[] = ["fail", "count"];

interface Sink {
  output: BoundedOutput;
  lines: string[];
  breaches: Breach[];
}

/** A sink over fresh arrays, with an optional total ceiling. */
function sinkOf(options: {
  maxLineBytes: number;
  maxTotalBytes?: number;
  maxStderrBytes: number;
  oversize: Oversize;
}): Sink {
  const lines: string[] = [];
  const breaches: Breach[] = [];
  const output = boundedOutput({
    maxLineBytes: options.maxLineBytes,
    maxTotalBytes: options.maxTotalBytes ?? Number.POSITIVE_INFINITY,
    maxStderrBytes: options.maxStderrBytes,
    oversize: options.oversize,
    onLine: (line) => {
      lines.push(line);
    },
    onBreach: (breach) => {
      breaches.push(breach);
    },
  });
  return { output, lines, breaches };
}

describe("boundedOutput: count mode (grep)", () => {
  it("drops an oversize line and counts it, delivers later lines, the carry never past maxLineBytes", () => {
    const { output, lines, breaches } = sinkOf({
      maxLineBytes: 8,
      maxStderrBytes: 4,
      oversize: "count",
    });
    const carried: number[] = [];
    const push = (text: string): void => {
      output.accept("stdout", text);
      carried.push(output.carriedBytes());
    };
    push("12345678\n"); // exactly the cap: delivered
    push("12345"); // five bytes of the next line held
    push("6789"); // would pass the cap: that line is dropped and counted
    push("tail\n"); // the dropped line's remainder, still discarded
    push("after\n"); // delivered
    expect(lines).toEqual(["12345678", "after"]);
    expect(output.oversized).toBe(1);
    expect(output.breach).toBeUndefined();
    expect(breaches).toEqual([]);
    expect(carried[1]).toBe(5);
    expect(Math.max(...carried)).toBeLessThanOrEqual(8);
    expect(output.stdoutBytes).toBe(Buffer.byteLength("12345678\n123456789tail\nafter\n", "utf8"));
  });
});

describe("boundedOutput: fail mode (mail)", () => {
  it("an oversize line is a line breach, onBreach once, no line after it", () => {
    const { output, lines, breaches } = sinkOf({
      maxLineBytes: 8,
      maxStderrBytes: 4,
      oversize: "fail",
    });
    output.accept("stdout", "before\n");
    output.accept("stdout", `${"x".repeat(9)}\nafter\n`); // the breach and a good line in one chunk
    output.accept("stdout", "later\n");
    expect(lines).toEqual(["before"]);
    expect(output.breach).toBe("line");
    expect(output.oversized).toBe(1);
    expect(breaches).toEqual(["line"]);
  });

  it("a second oversize line does not report a second breach", () => {
    const { output, breaches } = sinkOf({
      maxLineBytes: 4,
      maxStderrBytes: 4,
      oversize: "fail",
    });
    output.accept("stdout", `${"x".repeat(5)}\n${"y".repeat(5)}\n`);
    expect(output.breach).toBe("line");
    expect(breaches).toEqual(["line"]);
  });
});

describe("boundedOutput: the total ceiling", () => {
  it.each(MODES)(
    "in %s mode a chunk past maxTotalBytes is a ceiling breach, never pushed",
    (mode) => {
      const { output, lines, breaches } = sinkOf({
        maxLineBytes: 64,
        maxTotalBytes: 10,
        maxStderrBytes: 4,
        oversize: mode,
      });
      output.accept("stdout", "abc\n"); // 4 bytes
      output.accept("stdout", "defg\n"); // 5 bytes: 9 in all
      output.accept("stdout", "hi\n"); // would be 12: the ceiling
      output.accept("stdout", "later\n"); // ignored after the breach
      expect(output.breach).toBe("ceiling");
      expect(output.stdoutBytes).toBe(9);
      expect(lines).toEqual(["abc", "defg"]);
      expect(breaches).toEqual(["ceiling"]);
    },
  );
});

describe("boundedOutput: stderr", () => {
  it("keeps the head to maxStderrBytes and never delivers it as a line", () => {
    const { output, lines, breaches } = sinkOf({
      maxLineBytes: 64,
      maxStderrBytes: 4,
      oversize: "count",
    });
    output.accept("stderr", "warn");
    output.accept("stderr", "ing\n");
    expect(output.stderr.text).toBe("warn");
    expect(output.stderr.bytes).toBe(4);
    expect(output.stderr.full).toBe(true);
    expect(lines).toEqual([]);
    expect(breaches).toEqual([]);
  });
});

// ---- the exec wiring --------------------------------------------------------

interface Call {
  argv: readonly string[];
  options: ShellExecOptions | undefined;
  context: Context;
}

type Answer = Result<ShellExecResult, ExecutionError>;

/** An env whose exec records its call and answers with `play`'s result. */
function fakeEnv(play: (call: Call) => Answer | Promise<Answer>): {
  env: Pick<ExecutionEnv, "exec">;
  calls: Call[];
} {
  const calls: Call[] = [];
  const env: Pick<ExecutionEnv, "exec"> = {
    exec: (command, options, at) => {
      const call = {
        argv: typeof command === "string" ? [command] : command,
        options,
        context: at,
      };
      calls.push(call);
      return Promise.resolve(play(call));
    },
  };
  return { env, calls };
}

/** A sink that keeps nothing: the wiring tests only need a valid output. */
const quiet = (): BoundedOutput =>
  boundedOutput({
    maxLineBytes: 64,
    maxStderrBytes: 8,
    oversize: "count",
    onLine: () => undefined,
  });

const execOptions = (overrides: Partial<BoundedExecOptions> = {}): BoundedExecOptions => ({
  exec: {},
  output: quiet(),
  stop: new AbortController().signal,
  ...overrides,
});

describe("boundedExec: the exec call", () => {
  it("passes exec options through and routes onOutput chunks by stream", async () => {
    const sink = sinkOf({ maxLineBytes: 64, maxStderrBytes: 16, oversize: "count" });
    const fake = fakeEnv(({ options, context: at }) => {
      options?.onOutput?.("one\n", at, { stream: "stdout" });
      options?.onOutput?.("boom\n", at, { stream: "stderr" });
      return ok({ exitCode: 0 });
    });
    const outcome = await boundedExec(
      fake.env,
      ["rg", "--json"],
      execOptions({
        exec: { cwd: "/repo", env: { HOME: "/home/x" }, inheritEnv: false, timeout: 10 },
        output: sink.output,
      }),
      context,
    );
    expect(outcome).toEqual({ kind: "exited", exitCode: 0 });
    expect(fake.calls[0]?.argv).toEqual(["rg", "--json"]);
    expect(fake.calls[0]?.options).toMatchObject({
      cwd: "/repo",
      env: { HOME: "/home/x" },
      inheritEnv: false,
      timeout: 10,
    });
    // onOutput is boundedExec's, whatever the caller passed.
    expect(typeof fake.calls[0]?.options?.onOutput).toBe("function");
    expect(sink.lines).toEqual(["one"]);
    expect(sink.output.stderr.text).toBe("boom\n");
  });

  it("ok is exited with its code", async () => {
    const fake = fakeEnv(() => ok({ exitCode: 7 }));
    expect(await boundedExec(fake.env, ["rg"], execOptions(), context)).toEqual({
      kind: "exited",
      exitCode: 7,
    });
  });

  it("the own stop is wired to the exec's signal; its abort with an aborted error is stopped", async () => {
    const own = new AbortController();
    let sawAborted = false;
    const fake = fakeEnv(({ context: at }) => {
      own.abort();
      sawAborted = at.abortSignal?.aborted === true;
      return err(new ExecutionError("aborted", "aborted"));
    });
    const outcome = await boundedExec(fake.env, ["rg"], execOptions({ stop: own.signal }), context);
    expect(outcome).toEqual({ kind: "stopped" });
    expect(sawAborted).toBe(true);
  });

  it("an aborted error without the own stop is failed", async () => {
    const fake = fakeEnv(() => err(new ExecutionError("aborted", "aborted")));
    const outcome = await boundedExec(fake.env, ["rg"], execOptions(), context);
    expect(outcome.kind).toBe("failed");
  });

  it("a timeout is failed with its error", async () => {
    const error = new ExecutionError("timeout", "timed out after 10 s");
    const fake = fakeEnv(() => err(error));
    const outcome = await boundedExec(fake.env, ["screwtape"], execOptions(), context);
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" ? outcome.error : undefined).toBe(error);
  });
});

describe("boundedExec: the caller's abort", () => {
  it("throws even when the exec ended ok", async () => {
    const caller = new AbortController();
    const fake = fakeEnv(() => {
      caller.abort();
      return ok({ exitCode: 0 });
    });
    await expect(
      boundedExec(fake.env, ["rg"], execOptions(), withAbortSignal(caller.signal, context)),
    ).rejects.toThrow();
  });

  it("throws even when the own stop also fired", async () => {
    const caller = new AbortController();
    const own = new AbortController();
    const fake = fakeEnv(() => {
      own.abort();
      caller.abort();
      return err(new ExecutionError("aborted", "aborted"));
    });
    await expect(
      boundedExec(
        fake.env,
        ["rg"],
        execOptions({ stop: own.signal }),
        withAbortSignal(caller.signal, context),
      ),
    ).rejects.toThrow();
  });
});
