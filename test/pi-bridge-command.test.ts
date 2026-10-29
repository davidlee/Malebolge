// SL-009 PHASE-09 VT-3 (contract "command.ts", "Tests"): malebolge-bridge is one
// post-once per run, never retried, and its exit status is the outcome. These
// cases drive `runCommand` in-process against a fake daemon (a real unix
// socket), plus one spawned run of the real script to prove the shebang, the
// exec bit and the .ts imports.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { EXIT, type CommandIo, runCommand } from "../pi-bridge/command.ts";
import type { NotifyDesktop } from "../pi-bridge/notices.ts";
import {
  BRIDGE_BODY_MAX_BYTES,
  BRIDGE_POST_WAIT_MS,
  capHeadTail,
  FIRST_LINE_FRAMES,
  parseFrame,
  type PostOnceFrame,
} from "../pi-bridge/wire.ts";
import { tempDir } from "./fixtures.ts";
import { fakeDaemon, type FakeConn, type FakeDaemon } from "./pi-bridge-fake-daemon.ts";

const TOKEN = "tok-9f3a-secret";
const CONVERSATION = "7";
const REFUSAL = "budget exhausted, waiting on the operator";
const BRIDGE_SCRIPT = join(import.meta.dirname, "..", "pi-bridge", "malebolge-bridge");

// --- the fake command world --------------------------------------------------

/** One desktop notification the command asked for. */
interface DesktopCall {
  readonly summary: string;
  readonly body: string;
}

/** One in-process run: its exit, and everything it wrote. */
interface Harness {
  readonly exit: Promise<number>;
  /** Whether the run has settled already (fake timers flush microtasks, not sockets). */
  readonly settled: () => boolean;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly desktop: () => readonly DesktopCall[];
}

interface RunOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin?: AsyncIterable<string | Uint8Array>;
  readonly cwd?: string;
}

/** A writable that keeps what is written, readable as soon as the write returns. */
function sink(): { readonly stream: Writable; readonly text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      done: (error?: Error | null) => void,
    ): void {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream, text: (): string => chunks.join("") };
}

/** Run `runCommand` in-process, with stdout/stderr kept and desktop notices recorded. */
function harness(options: RunOptions): Harness {
  const out = sink();
  const err = sink();
  const desktop: DesktopCall[] = [];
  const notifyDesktop: NotifyDesktop = (summary, body): void => {
    desktop.push({ summary, body });
  };
  const io: CommandIo = {
    argv: options.argv,
    stdin: options.stdin ?? Readable.from([""]),
    stdout: out.stream,
    stderr: err.stream,
    env: options.env,
    cwd: options.cwd ?? process.cwd(),
    notifyDesktop,
  };
  let done = false;
  const exit = runCommand(io).finally(() => {
    done = true;
  });
  // A red stub rejects at once: surface it where the test awaits it, not as an
  // unhandled rejection in an earlier turn.
  void exit.catch(() => undefined);
  return {
    exit,
    settled: (): boolean => done,
    stdout: out.text,
    stderr: err.text,
    desktop: (): readonly DesktopCall[] => desktop,
  };
}

/** The spawn hook's env: conversation 7 on `socket`, with the token. */
function pairedEnv(
  socket: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    MALEBOLGE_BRIDGE_SOCKET: socket,
    MALEBOLGE_BRIDGE_CONVERSATION: CONVERSATION,
    MALEBOLGE_BRIDGE_TOKEN: TOKEN,
    ...overrides,
  };
}

/** `work`, or the run's own failure when it settles first: a red stub never reaches the socket. */
async function orFail<T>(work: Promise<T>, run: Harness): Promise<T> {
  return Promise.race([
    work,
    run.exit.then((code) => {
      throw new Error(`the command exited ${String(code)} before this happened`);
    }),
  ]);
}

/** The daemon's next connection, from `run`. */
function firstConnection(daemon: FakeDaemon, run: Harness): Promise<FakeConn> {
  return orFail(daemon.nextConnection(), run);
}

/** The connection's next line, from `run`. */
function firstLine(conn: FakeConn, run: Harness): Promise<unknown> {
  return orFail(conn.nextLine(), run);
}

/** The post-once frame `line` holds, or a failure saying what it is instead. */
function postOnce(line: unknown): PostOnceFrame {
  const read = parseFrame(FIRST_LINE_FRAMES, JSON.stringify(line));
  if (!read.ok) {
    throw new Error(`not a client frame: ${read.refused.reason}`);
  }
  if (read.frame.type !== "post-once") {
    throw new Error(`not a post-once frame: ${read.frame.type}`);
  }
  return read.frame;
}

/** The token is never readable from a command run: not on stdout, stderr, or the desktop. */
function expectNoToken(run: Harness): void {
  expect(run.stdout()).not.toContain(TOKEN);
  expect(run.stderr()).not.toContain(TOKEN);
  for (const call of run.desktop()) {
    expect(`${call.summary}\n${call.body}`).not.toContain(TOKEN);
  }
}

/** Let pending socket work land (a connection the command must not have made). */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

// --- the real script ---------------------------------------------------------

/** A spawned `malebolge-bridge`: its output, its exit, and waits that fail when it exits first. */
interface ChildRun {
  readonly exit: Promise<number | null>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly unlessExited: <T>(work: Promise<T>) => Promise<T>;
}

/** Spawn the real script with `stdin`: node's own shebang runs it, so node must be on PATH. */
function spawnBridge(socket: string, stdin: string): ChildRun {
  const child = spawn(BRIDGE_SCRIPT, ["send"], {
    env: { ...process.env, ...pairedEnv(socket) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    out.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err.push(chunk);
  });
  const text = (chunks: readonly Buffer[]): string => Buffer.concat(chunks).toString("utf8");
  // "close", not "exit": it fires once stderr has been read, so a failure explains itself.
  const exit = new Promise<number | null>((resolve) => {
    child.once("close", () => {
      resolve(child.exitCode);
    });
  });
  child.stdin.end(stdin);
  return {
    exit,
    stdout: (): string => text(out),
    stderr: (): string => text(err),
    unlessExited: <T>(work: Promise<T>): Promise<T> =>
      Promise.race([
        work,
        exit.then((code) => {
          throw new Error(`the script exited ${String(code)} first; stderr: ${text(err)}`);
        }),
      ]),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// --- exit 0: accepted --------------------------------------------------------

describe("malebolge-bridge: exit 0 (accepted)", () => {
  it("send writes exactly one post-once line, prints accepted and exits 0", async () => {
    const daemon = await fakeDaemon();
    const run = harness({
      argv: ["send"],
      env: pairedEnv(daemon.path),
      stdin: Readable.from(["hello"]),
    });
    const conn = await firstConnection(daemon, run);
    const line = await firstLine(conn, run);
    expect(postOnce(line)).toEqual({
      type: "post-once",
      conversation: CONVERSATION,
      token: TOKEN,
      kind: "note",
      text: "hello",
    });
    conn.reply({ type: "accepted" });
    await expect(run.exit).resolves.toBe(EXIT.accepted);
    expect(conn.lines()).toHaveLength(1);
    expect(run.stdout()).toBe("accepted\n");
    expect(run.stderr()).toBe("");
    expectNoToken(run);
  });

  it("send --turn posts kind turn, prints accepted and exits 0", async () => {
    const daemon = await fakeDaemon();
    const run = harness({
      argv: ["send", "--turn"],
      env: pairedEnv(daemon.path),
      stdin: Readable.from(["go"]),
    });
    const conn = await firstConnection(daemon, run);
    const line = await firstLine(conn, run);
    expect(postOnce(line)).toEqual({
      type: "post-once",
      conversation: CONVERSATION,
      token: TOKEN,
      kind: "turn",
      text: "go",
    });
    conn.reply({ type: "accepted" });
    await expect(run.exit).resolves.toBe(EXIT.accepted);
    expect(run.stdout()).toBe("accepted\n");
    expectNoToken(run);
  });

  it("tee writes stdin through, posts it once and exits 0", async () => {
    const daemon = await fakeDaemon();
    const run = harness({
      argv: ["tee"],
      env: pairedEnv(daemon.path),
      stdin: Readable.from(["a\n", "b\n"]),
    });
    const conn = await firstConnection(daemon, run);
    const line = await firstLine(conn, run);
    expect(postOnce(line)).toEqual({
      type: "post-once",
      conversation: CONVERSATION,
      token: TOKEN,
      kind: "note",
      text: "a\nb\n",
    });
    conn.reply({ type: "accepted" });
    await expect(run.exit).resolves.toBe(EXIT.accepted);
    // Exactly the stdin bytes: no ack line after them.
    expect(run.stdout()).toBe("a\nb\n");
    expect(run.stderr()).toBe("");
    expectNoToken(run);
  });

  it("oversized stdin is capped head and tail, and accepted", async () => {
    const daemon = await fakeDaemon();
    const head = "HEAD-MARKER-";
    const tail = "-TAIL-MARKER";
    const input = `${head}${"x".repeat(BRIDGE_BODY_MAX_BYTES * 3)}${tail}`;
    const run = harness({
      argv: ["send"],
      env: pairedEnv(daemon.path),
      stdin: Readable.from([input]),
    });
    const conn = await firstConnection(daemon, run);
    const frame = postOnce(await firstLine(conn, run));
    conn.reply({ type: "accepted" });
    await expect(run.exit).resolves.toBe(EXIT.accepted);
    expect(frame.text).toBe(capHeadTail(input, BRIDGE_BODY_MAX_BYTES));
    expect(Buffer.byteLength(frame.text, "utf8")).toBeLessThanOrEqual(BRIDGE_BODY_MAX_BYTES);
    expect(frame.text.startsWith(head)).toBe(true);
    expect(frame.text.endsWith(tail)).toBe(true);
    expect(conn.lines()).toHaveLength(1);
    expectNoToken(run);
  });
});

// --- exit 2: refused, or misuse ---------------------------------------------

describe("malebolge-bridge: exit 2 (refused, or misuse)", () => {
  it("a refused post puts the reason on stderr and exits 2", async () => {
    const daemon = await fakeDaemon();
    const run = harness({
      argv: ["send"],
      env: pairedEnv(daemon.path),
      stdin: Readable.from(["hello"]),
    });
    const conn = await firstConnection(daemon, run);
    await firstLine(conn, run);
    conn.reply({ type: "refused", reason: REFUSAL });
    await expect(run.exit).resolves.toBe(EXIT.refused);
    expect(run.stderr()).toContain(REFUSAL);
    expect(run.stdout()).toBe("");
    expectNoToken(run);
  });

  it("an unpaired run exits 2 without connecting", async () => {
    const daemon = await fakeDaemon();
    const run = harness({
      argv: ["send"],
      env: {
        MALEBOLGE_BRIDGE_SOCKET: daemon.path,
        MALEBOLGE_BRIDGE_CONVERSATION: CONVERSATION,
      },
      stdin: Readable.from(["hi"]),
    });
    await expect(run.exit).resolves.toBe(EXIT.refused);
    await flush();
    expect(run.stdout()).toBe("");
    expect(run.stderr()).not.toBe("");
    expect(daemon.connections()).toHaveLength(0);
    expectNoToken(run);
  });

  it("bad arguments print usage on stderr and exit 2", async () => {
    const daemon = await fakeDaemon();
    const run = harness({
      argv: ["frobnicate"],
      env: pairedEnv(daemon.path),
      stdin: Readable.from(["hi"]),
    });
    await expect(run.exit).resolves.toBe(EXIT.refused);
    await flush();
    expect(run.stdout()).toBe("");
    expect(run.stderr()).not.toBe("");
    expect(daemon.connections()).toHaveLength(0);
    expectNoToken(run);
  });
});

// --- exit 3: outcome unknown -------------------------------------------------

describe("malebolge-bridge: exit 3 (outcome unknown)", () => {
  it("a daemon that never replies is unknown at the deadline, and never retried", async () => {
    // Only the command's own timers are faked: the socket stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const daemon = await fakeDaemon();
    const run = harness({
      argv: ["send"],
      env: pairedEnv(daemon.path),
      stdin: Readable.from(["hi"]),
    });
    const conn = await firstConnection(daemon, run);
    await firstLine(conn, run);
    expect(daemon.connections()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BRIDGE_POST_WAIT_MS - 1);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(run.exit).resolves.toBe(EXIT.unknown);
    expect(run.stderr()).toContain("outcome unknown");
    expect(run.stdout()).toBe("");
    // The one post-once, never a second connection.
    expect(conn.lines()).toHaveLength(1);
    expect(daemon.connections()).toHaveLength(1);
    expectNoToken(run);
  });

  it("a daemon that hangs up after reading leaves the outcome unknown", async () => {
    const daemon = await fakeDaemon();
    const run = harness({
      argv: ["send"],
      env: pairedEnv(daemon.path),
      stdin: Readable.from(["hi"]),
    });
    const conn = await firstConnection(daemon, run);
    await firstLine(conn, run);
    conn.end();
    await expect(run.exit).resolves.toBe(EXIT.unknown);
    expect(run.stderr()).toContain("outcome unknown");
    expect(run.stdout()).toBe("");
    expect(daemon.connections()).toHaveLength(1);
    expectNoToken(run);
  });
});

// --- exit 1: connect failure -------------------------------------------------

describe("malebolge-bridge: exit 1 (connect failure)", () => {
  it("a missing socket is an outage naming the socket and the conversation", async () => {
    const { dir, cleanup } = await tempDir();
    onTestFinished(cleanup);
    const missing = join(dir, "bridge.sock");
    const run = harness({
      argv: ["send"],
      env: pairedEnv(missing),
      stdin: Readable.from(["hi"]),
    });
    await expect(run.exit).resolves.toBe(EXIT.connectFailure);
    expect(run.stdout()).toBe("");
    const lines = run.stderr().trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(missing);
    expect(lines[0]).toContain(CONVERSATION);
    expect(run.desktop()).toHaveLength(1);
    expectNoToken(run);
  });
});

// --- the real script, under its own shebang ----------------------------------

describe("malebolge-bridge: the real script", () => {
  it("runs through its node shebang, posts once and exits 0", async () => {
    const daemon = await fakeDaemon();
    const run = spawnBridge(daemon.path, "hi");
    const conn = await run.unlessExited(daemon.nextConnection());
    const line = await run.unlessExited(conn.nextLine());
    expect(postOnce(line)).toEqual({
      type: "post-once",
      conversation: CONVERSATION,
      token: TOKEN,
      kind: "note",
      text: "hi",
    });
    conn.reply({ type: "accepted" });
    await expect(run.exit).resolves.toBe(0);
    expect(run.stdout()).toBe("accepted\n");
    expect(run.stderr()).toBe("");
    expect(run.stdout()).not.toContain(TOKEN);
    expect(run.stderr()).not.toContain(TOKEN);
  });
});
