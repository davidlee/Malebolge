// The room's shell (design §4.2, §5.2): an argument vector over a job's daemon
// connection, typed by how it failed, and bounded by optional ShellLimits —
// stdout past maxStdoutBytes stops the process and answers its head as
// `overflowed`, stderr is capped while streaming, timeoutS is pi-env's timeout,
// and the caller's abort is always rethrown, never `overflowed`.

import { execFileSync } from "node:child_process";
import { constants, openSync } from "node:fs";
import { join } from "node:path";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import {
  type Connection,
  HostKeyChangedError,
  HostKeyUnknownError,
  type RequestOptions,
} from "@earendil-works/pi-env";
import { describe, expect, it } from "vitest";
import { daemonConnection } from "../../src/runner/env.ts";
import { preparingFailure } from "../../src/runner/prepare.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  type RoomShell,
  type ShellLimits,
} from "../../src/runner/room.ts";
import {
  type ExecFacts,
  OVERFLOW_EXIT_CODE,
  type OutputCollector,
  outputCollector,
  roomShell,
  settle,
} from "../../src/runner/shell.ts";
import { exampleConfig, roomConfig } from "./config-fixture.ts";
import {
  doorFacts,
  FailingConnection,
  fakeHelpers,
  localConnection,
  lostConnection,
} from "./env-fixture.ts";
import { never, rejection, shellKit } from "./shell-fixture.ts";

const JOB_ID = "pj-1";
const { open, scratch } = shellKit();

const shellIn = (connection: Connection, cwd: string): RoomShell =>
  roomShell(open(connection), JOB_ID, cwd);

/** A shell over the local daemon in a fresh temp dir. */
const localShell = async (): Promise<RoomShell> => shellIn(localConnection(), await scratch());

/** The `ExecutionError` code a shell rejection carries as its cause. */
const causeCode = (error: unknown): string | undefined =>
  error instanceof Error && error.cause instanceof ExecutionError ? error.cause.code : undefined;

/** Milliseconds `run` took to settle, and what it settled with. */
async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await run();
  return { ms: performance.now() - start, value };
}

describe("roomShell", () => {
  it("answers the exit code and captures stdout and stderr", async () => {
    const shell = await localShell();

    const output = await shell(["sh", "-c", "echo out; echo err >&2; exit 3"], never());

    expect(output).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
    expect("overflowed" in output).toBe(false);
  });

  it("without limits keeps all of its output, as before", async () => {
    const shell = await localShell();

    const output = await shell(["head", "-c", "300000", "/dev/zero"], never());

    expect(output.stdout).toHaveLength(300_000);
    expect("overflowed" in output).toBe(false);
  });

  it("a lost daemon connection is ChannelUnavailable: the room is down", async () => {
    const shell = shellIn(lostConnection(), await scratch());

    expect(await rejection(shell(["true"], never()))).toBeInstanceOf(ChannelUnavailable);
  });

  it("an exec that fails on a live connection is ChannelFailed: not retried", async () => {
    const shell = shellIn(localConnection(), `${await scratch()}/absent`);

    expect(await rejection(shell(["true"], never()))).toBeInstanceOf(ChannelFailed);
  });

  // Carry-forward 5 (EX-8): either door kind's daemon connection, counted, never paused.
  describe.each([
    ["slot", exampleConfig],
    ["room", roomConfig],
  ])("over a %s door's daemon connection", (_kind, config) => {
    it("a lost start is ChannelUnavailable: retried, no pause", async () => {
      const { facts, launch } = doorFacts(config());
      const shell = shellIn(daemonConnection(facts, launch, fakeHelpers("false")), await scratch());

      expect(await rejection(shell(["true"], never()))).toBeInstanceOf(ChannelUnavailable);
    });

    it.each([
      ["HostKeyChangedError", (): Error => new HostKeyChangedError("changed")],
      ["HostKeyUnknownError", (): Error => new HostKeyUnknownError("unknown")],
    ])("a start failing %s is ChannelFailed host_key: never retried", async (_name, failure) => {
      const { facts, launch } = doorFacts(config());
      const connection = daemonConnection(facts, launch, fakeHelpers("ssh", failure));
      const shell = shellIn(connection, await scratch());

      const error = await rejection(shell(["true"], never()));

      expect(error).toBeInstanceOf(ChannelFailed);
      expect(error).toMatchObject({ reason: "host_key" });
      expect(preparingFailure(error)).toMatchObject({
        failure: { reason: "host_key" },
        endReason: "error",
      });
    });
  });
});

describe("roomShell with ShellLimits (VT-1, over a local daemon)", () => {
  it("stdout past maxStdoutBytes stops an endless producer and answers its head, overflowed", async () => {
    const shell = await localShell();
    const limits: ShellLimits = { maxStdoutBytes: 1000 };

    const { ms, value: output } = await timed(() => shell(["yes"], never(), undefined, limits));

    expect(output).toEqual({
      code: OVERFLOW_EXIT_CODE,
      stdout: "y\n".repeat(500),
      stderr: "",
      overflowed: true,
    });
    expect(ms).toBeLessThan(5000);
  });

  it("stdout of exactly maxStdoutBytes is not overflowed", async () => {
    const shell = await localShell();

    const output = await shell(["head", "-c", "1000", "/dev/zero"], never(), undefined, {
      maxStdoutBytes: 1000,
    });

    expect(output).toEqual({ code: 0, stdout: "\0".repeat(1000), stderr: "" });
    expect("overflowed" in output).toBe(false);
  });

  it.each([
    [2, { stdout: "a", overflowed: true }],
    [3, { stdout: "aé" }],
  ])(
    "maxStdoutBytes %i over a two-byte character: the head ends on a character boundary",
    async (max, expected) => {
      const shell = await localShell();

      const output = await shell(["printf", "aé"], never(), undefined, { maxStdoutBytes: max });

      expect(output).toMatchObject(expected);
      expect(output.stdout).not.toContain("�");
    },
  );

  it("stderr past maxStderrBytes is capped while the process runs to its own exit: never overflowed", async () => {
    const shell = await localShell();
    const script = "head -c 50000 /dev/zero >&2; echo done; exit 4";

    const output = await shell(["sh", "-c", script], never(), undefined, { maxStderrBytes: 100 });

    expect(output).toEqual({ code: 4, stdout: "done\n", stderr: "\0".repeat(100) });
    expect("overflowed" in output).toBe(false);
  });

  it("past timeoutS: ChannelFailed whose cause is pi-env's ExecutionError timeout", async () => {
    const shell = await localShell();

    const { ms, value: error } = await timed(() =>
      rejection(shell(["sleep", "30"], never(), undefined, { timeoutS: 0.5 })),
    );

    expect(error).toBeInstanceOf(ChannelFailed);
    expect(causeCode(error)).toBe("timeout");
    expect(ms).toBeLessThan(5000);
  });

  it("a process blocked opening a FIFO (mkfifo) is stopped by timeoutS", async () => {
    const dir = await scratch();
    const fifo = join(dir, "f");
    execFileSync("mkfifo", [fifo]);
    const shell = shellIn(localConnection(), dir);

    const { ms, value: error } = await timed(() =>
      rejection(shell(["cat", fifo], never(), undefined, { timeoutS: 0.5 })),
    );

    expect(error).toBeInstanceOf(ChannelFailed);
    expect(causeCode(error)).toBe("timeout");
    expect(ms).toBeLessThan(5000);
    // Reaped, not abandoned: no reader holds the FIFO any more (ENXIO).
    await expect(eventually(() => readerGone(fifo))).resolves.toBe(true);
  }, 15_000);

  it("the caller's abort mid-exec is ChannelFailed, cause aborted: never overflowed", async () => {
    const shell = await localShell();
    const caller = new AbortController();
    setTimeout(() => {
      caller.abort();
    }, 200);

    const error = await rejection(
      shell(["sleep", "30"], caller.signal, undefined, { maxStdoutBytes: 10, timeoutS: 10 }),
    );

    expect(error).toBeInstanceOf(ChannelFailed);
    expect(causeCode(error)).toBe("aborted");
  });

  it("the caller's abort racing the shell's own overflow abort is rethrown, never overflowed", async () => {
    const caller = new AbortController();
    // Each output event is delivered, then the caller aborts: both aborts fire before exec settles.
    const tapped = new TappedConnection(localConnection(), () => {
      caller.abort();
    });
    const shell = shellIn(tapped, await scratch());

    const error = await rejection(shell(["yes"], caller.signal, undefined, { maxStdoutBytes: 10 }));

    expect(error).toBeInstanceOf(ChannelFailed);
    expect(causeCode(error)).toBe("aborted");
  });
});

/** The local daemon, with `tap` called after each event a request delivers. */
class TappedConnection extends FailingConnection {
  readonly #tap: () => void;

  constructor(inner: Connection, tap: () => void) {
    super(() => undefined, inner);
    this.#tap = tap;
  }

  override request(
    op: string,
    json: Record<string, unknown>,
    options?: RequestOptions,
  ): ReturnType<Connection["request"]> {
    const onEvent = options?.onEvent;
    if (onEvent === undefined) {
      return super.request(op, json, options);
    }
    return super.request(op, json, {
      ...options,
      onEvent: (event, payload) => {
        onEvent(event, payload);
        this.#tap();
      },
    });
  }
}

/** Whether `fifo` has no reader: a non-blocking write open fails ENXIO. */
function readerGone(fifo: string): boolean {
  try {
    openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENXIO";
  }
}

/** `probe` true within ~2 s of polling. */
async function eventually(probe: () => boolean): Promise<boolean> {
  for (let tries = 0; tries < 40; tries++) {
    if (probe()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("outputCollector (the shell's byte accounting)", () => {
  /** A collector that counts its overflow calls. */
  const collecting = (limits: ShellLimits): OutputCollector & { calls: () => number } => {
    let calls = 0;
    const collector = outputCollector(limits, () => {
      calls++;
    });
    return { ...collector, calls: () => calls };
  };

  it("keeps every chunk, in order, without limits", () => {
    const c = collecting({});
    c.accept("stdout", "a");
    c.accept("stderr", "x");
    c.accept("stdout", "b");

    expect(c.output()).toEqual({ stdout: "ab", stderr: "x", overflowed: false });
    expect(c.calls()).toBe(0);
  });

  it("chunks reaching exactly maxStdoutBytes are not an overflow", () => {
    const c = collecting({ maxStdoutBytes: 4 });
    c.accept("stdout", "ab");
    c.accept("stdout", "cd");

    expect(c.output()).toEqual({ stdout: "abcd", stderr: "", overflowed: false });
    expect(c.calls()).toBe(0);
  });

  it("past maxStdoutBytes: the head kept, overflow called once, later chunks dropped", () => {
    const c = collecting({ maxStdoutBytes: 4 });
    c.accept("stdout", "abc");
    c.accept("stdout", "def");
    c.accept("stdout", "ghi");
    c.accept("stderr", "still kept");

    expect(c.output()).toEqual({ stdout: "abcd", stderr: "still kept", overflowed: true });
    expect(c.calls()).toBe(1);
  });

  it("a character straddling the cap is dropped whole", () => {
    const c = collecting({ maxStdoutBytes: 4 });
    c.accept("stdout", "aé");
    c.accept("stdout", "éb");

    expect(c.output()).toMatchObject({ stdout: "aé", overflowed: true });
  });

  it("stderr past maxStderrBytes is capped silently: no overflow", () => {
    const c = collecting({ maxStderrBytes: 2 });
    c.accept("stderr", "xyz");
    c.accept("stderr", "w");
    c.accept("stdout", "out");

    expect(c.output()).toEqual({ stdout: "out", stderr: "xy", overflowed: false });
    expect(c.calls()).toBe(0);
  });
});

describe("settle (the shell's outcome, by precedence)", () => {
  const ARGV = ["git", "status"];
  const head = { stdout: "head", stderr: "e" };
  const facts = (overrides: Partial<ExecFacts> = {}): ExecFacts => ({
    trust: undefined,
    lost: false,
    callerAborted: false,
    output: { ...head, overflowed: false },
    ...overrides,
  });
  const overflowed = { output: { ...head, overflowed: true } };
  const failedWith = (code: ExecutionError["code"]) =>
    ({ ok: false, error: new ExecutionError(code, code) }) as const;
  const exited = (exitCode: number) => ({ ok: true, value: { exitCode } }) as const;
  const thrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected a throw");
  };

  it("an exit answers its code and output", () => {
    expect(settle(ARGV, exited(2), facts())).toEqual({ code: 2, ...head });
  });

  it("an exit after the cap was passed keeps its real code, still overflowed", () => {
    expect(settle(ARGV, exited(0), facts(overflowed))).toEqual({
      code: 0,
      ...head,
      overflowed: true,
    });
  });

  it("the shell's own abort answers the head, overflowed, with the sentinel code", () => {
    expect(settle(ARGV, failedWith("aborted"), facts(overflowed))).toEqual({
      code: OVERFLOW_EXIT_CODE,
      ...head,
      overflowed: true,
    });
  });

  it("a host key failure comes first: ChannelFailed host_key, even when lost and overflowed", () => {
    const trust = new HostKeyChangedError("changed");
    const error = thrown(() =>
      settle(ARGV, failedWith("unknown"), facts({ trust, lost: true, ...overflowed })),
    );

    expect(error).toBeInstanceOf(ChannelFailed);
    expect(error).toMatchObject({ reason: "host_key", cause: trust });
  });

  it("a loss comes before any abort: ChannelUnavailable, even with the caller aborted and overflowed", () => {
    const error = thrown(() =>
      settle(
        ARGV,
        failedWith("unknown"),
        facts({ lost: true, callerAborted: true, ...overflowed }),
      ),
    );

    expect(error).toBeInstanceOf(ChannelUnavailable);
  });

  it("the caller's abort is rethrown even when the shell's own abort also fired", () => {
    const error = thrown(() =>
      settle(ARGV, failedWith("aborted"), facts({ callerAborted: true, ...overflowed })),
    );

    expect(error).toBeInstanceOf(ChannelFailed);
    expect(causeCode(error)).toBe("aborted");
  });

  it("a timeout racing the overflow abort is the timeout: ChannelFailed", () => {
    const error = thrown(() => settle(ARGV, failedWith("timeout"), facts(overflowed)));

    expect(error).toBeInstanceOf(ChannelFailed);
    expect(causeCode(error)).toBe("timeout");
    expect(error).toMatchObject({ message: "git status: timeout" });
  });
});
