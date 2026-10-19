// The grep tool (design §4.5): rg --json through the conversation's env,
// bounded on the host. VT-1 and VT-2 run over a scripted env that plays lazy
// chunk generators into `onOutput`, so no rg and no large fixture is needed;
// VT-3 runs once over a local pi-env daemon with the host's rg.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { err, ExecutionError, ok } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import {
  contextLines,
  type GrepEnv,
  type GrepParams,
  GREP_MAX_BYTES,
  GREP_MAX_STDERR_BYTES,
  grepArgv,
  grepCollector,
  grepExtension,
  grepTool,
  MAX_MESSAGE_BYTES,
  matchLimit,
  runGrep,
} from "../src/grep.ts";
import { type BoundedLineSplitter, boundedLineSplitter } from "../src/ndjson.ts";
import { jobEnv } from "../src/runner/env.ts";
import { tempDir } from "./fixtures.ts";
import { callThenAnswer, openFauxHarness, textOf, toolResults } from "./harness-fixture.ts";
import { localConnection } from "./runner/env-fixture.ts";
import { realBin } from "./runner/fake-bin.ts";
import { closeHarness, within } from "./runner/runner-fixture.ts";

// ---- rg --json builders ----------------------------------------------------

type Field = { text: string } | { bytes: string };
const field = (value: string | Buffer): Field =>
  typeof value === "string" ? { text: value } : { bytes: value.toString("base64") };

const message = (
  type: "match" | "context",
  path: string | Buffer,
  line: number,
  text: string | Buffer,
  submatches: unknown[] = [],
): string =>
  `${JSON.stringify({
    type,
    data: { path: field(path), lines: field(text), line_number: line, submatches },
  })}\n`;

const match = (path: string, line: number, text: string): string =>
  message("match", path, line, `${text}\n`);
const contextLine = (path: string, line: number, text: string): string =>
  message("context", path, line, `${text}\n`);
const begin = (path: string): string =>
  `${JSON.stringify({ type: "begin", data: { path: { text: path } } })}\n`;
const summary = `${JSON.stringify({ type: "summary", data: { stats: { matches: 1 } } })}\n`;

// ---- the scripted env -------------------------------------------------------

interface Chunk {
  stream: "stdout" | "stderr";
  text: string;
}

const out = (text: string): Chunk => ({ stream: "stdout", text });
const err2 = (text: string): Chunk => ({ stream: "stderr", text });

function* chunks(...texts: string[]): Generator<Chunk> {
  for (const text of texts) {
    yield out(text);
  }
}

interface Scripted {
  env: GrepEnv;
  argv: () => readonly string[];
  cwd: () => string | undefined;
  /** Chunks handed to `onOutput`: fewer than the script holds when the exec was stopped. */
  emitted: () => number;
}

/**
 * An env whose exec plays `script` lazily, checking the call's signal before
 * each chunk and once after the last, as a real env answers a kill.
 */
function scriptedEnv(script: Iterable<Chunk>, exitCode = 0): Scripted {
  let argv: readonly string[] = [];
  let cwd: string | undefined;
  let emitted = 0;
  const aborted = err<{ exitCode: number }, ExecutionError>(
    new ExecutionError("aborted", "aborted"),
  );
  const isAborted = (at: Context): boolean => at.abortSignal?.aborted === true;
  const env: GrepEnv = {
    cwd: "/repo",
    exec: (command, options, at) => {
      argv = typeof command === "string" ? [command] : command;
      cwd = options?.cwd;
      for (const chunk of script) {
        if (isAborted(at)) {
          return Promise.resolve(aborted);
        }
        emitted += 1;
        options?.onOutput?.(chunk.text, at, { stream: chunk.stream });
      }
      return Promise.resolve(isAborted(at) ? aborted : ok({ exitCode }));
    },
  };
  return { env, argv: () => argv, cwd: () => cwd, emitted: () => emitted };
}

const grep = (
  script: Iterable<Chunk>,
  params: Partial<GrepParams> = {},
  exitCode = 0,
  at: Context = context,
): Promise<{ text: string; isError: boolean }> =>
  runGrep(scriptedEnv(script, exitCode).env, { pattern: "x", ...params }, at);

// ---- VT-1 -------------------------------------------------------------------

describe("grepTool: argv (VT-1)", () => {
  const base = ["rg", "--json", "--line-number", "--color=never", "--hidden"];

  it("defaults to the conversation's cwd and no flags", () => {
    expect(grepArgv({ pattern: "-p" })).toEqual([...base, "--", "-p", "."]);
  });

  it("maps every parameter, noIgnore as --no-ignore with .git still excluded", () => {
    expect(
      grepArgv({
        pattern: "p",
        path: "src",
        glob: "*.ts",
        ignoreCase: true,
        literal: true,
        context: 2,
        noIgnore: true,
      }),
    ).toEqual([
      ...base,
      "--glob",
      "*.ts",
      "--ignore-case",
      "--fixed-strings",
      "--context",
      "2",
      "--no-ignore",
      "--glob",
      "!.git",
      "--",
      "p",
      "src",
    ]);
  });

  it("runs in the env's cwd", async () => {
    const scripted = scriptedEnv(chunks());
    await runGrep(scripted.env, { pattern: "x" }, context);
    expect(scripted.cwd()).toBe("/repo");
    expect(scripted.argv()[0]).toBe("rg");
  });

  it.each([
    [25, 20],
    [-3, 0],
    [2.9, 2],
    [Number.NaN, 0],
    [undefined, 0],
  ])("clamps context %s to %s", (given, clamped) => {
    expect(contextLines(given)).toBe(clamped);
  });

  it.each([
    [0, 1],
    [5000, 1000],
    [7.9, 7],
    [Number.NaN, 100],
    [Infinity, 100],
    [undefined, 100],
  ])("clamps limit %s to %s", (given, clamped) => {
    expect(matchLimit(given)).toBe(clamped);
  });
});

describe("grepTool: output (VT-1)", () => {
  it("renders matches and context lines in pi's format, relative to the search path", async () => {
    const result = await grep(
      chunks(
        begin("src/a.ts"),
        contextLine("src/a.ts", 1, "before"),
        match("src/a.ts", 2, "hit"),
        summary,
      ),
      { path: "src" },
    );
    expect(result).toEqual({ text: "a.ts-1- before\na.ts:2: hit", isError: false });
  });

  it("reassembles a message split across chunks, mid character", async () => {
    const whole = match("./a", 1, "😀 ok");
    // Between the emoji's two UTF-16 code units: each chunk holds half a character.
    const at = whole.indexOf("😀") + 1;
    const result = await grep(chunks(whole.slice(0, 5), whole.slice(5, at), whole.slice(at)));
    expect(result.text).toBe("a:1: 😀 ok");
  });

  it("decodes bytes fields as UTF-8 with replacement characters", async () => {
    const path = Buffer.from([0x62, 0xff, 0x2f, 0x63]);
    const line = Buffer.from([0x6f, 0x6b, 0xfe, 0x0a]);
    const result = await grep(chunks(message("match", path, 3, line)), { path: "." });
    expect(result.text).toBe("b\uFFFD/c:3: ok\uFFFD");
  });

  it("shows a file path as its basename", async () => {
    const result = await grep(chunks(match("deep/dir/file.ts", 4, "x")), {
      path: "deep/dir/file.ts",
    });
    expect(result.text).toBe("file.ts:4: x");
  });

  it("truncates a long line to 500 characters, with pi's notice", async () => {
    const result = await grep(chunks(match("./a", 1, "y".repeat(600))));
    expect(result.text).toBe(
      `a:1: ${"y".repeat(500)}... [truncated]\n\n[Some lines truncated to 500 chars. Use read tool to see full lines]`,
    );
  });

  it("stops at the limit: a success with pi's notice, and the env saw the abort", async () => {
    const all = Array.from({ length: 10 }, (_, line) => match("./a", line + 1, "x"));
    const scripted = scriptedEnv(chunks(...all));
    const result = await runGrep(scripted.env, { pattern: "x", limit: 3 }, context);
    expect(result).toEqual({
      text: "a:1: x\na:2: x\na:3: x\n\n[3 matches limit reached. Use limit=6 for more, or refine pattern]",
      isError: false,
    });
    expect(scripted.emitted()).toBe(3);
  });

  it("stops at 50 KB: a success with the notice, within 50 KB, and the env saw the abort", async () => {
    const all = Array.from({ length: 1000 }, (_, line) => match("./a", line + 1, "z".repeat(400)));
    const scripted = scriptedEnv(chunks(...all));
    const result = await runGrep(scripted.env, { pattern: "x", limit: 1000 }, context);
    expect(result.isError).toBe(false);
    expect(result.text.endsWith("[50.0KB limit reached]")).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(GREP_MAX_BYTES);
    expect(scripted.emitted()).toBeLessThan(200);
  });

  it("exit 1 is No matches found", async () => {
    expect(await grep(chunks(), {}, 1)).toEqual({ text: "No matches found", isError: false });
  });

  it("exit 2 with matches answers the matches and a notice carrying stderr", async () => {
    const script = [out(match("./a", 1, "x")), err2("rg: b: Permission denied (os error 13)\n")];
    expect(await grep(script, {}, 2)).toEqual({
      text: "a:1: x\n\n[rg reported errors: rg: b: Permission denied (os error 13)]",
      isError: false,
    });
  });

  it.each([2, 3])("exit %s without matches is a tool error with stderr", async (code) => {
    expect(await grep([err2("rg: regex parse error\n")], {}, code)).toEqual({
      text: "rg: regex parse error",
      isError: true,
    });
  });

  it("an exit with no stderr names the code", async () => {
    expect(await grep(chunks(), {}, 3)).toEqual({
      text: "ripgrep exited with code 3",
      isError: true,
    });
  });

  it("an rg that cannot start is a tool error", async () => {
    const env: GrepEnv = {
      cwd: "/repo",
      exec: () => Promise.resolve(err(new ExecutionError("spawn_error", "spawn rg ENOENT"))),
    };
    expect(await runGrep(env, { pattern: "x" }, context)).toEqual({
      text: "ripgrep (rg) is not available: spawn rg ENOENT",
      isError: true,
    });
  });

  it("an env failure other than abort or spawn throws", async () => {
    const env: GrepEnv = {
      cwd: "/repo",
      exec: () => Promise.resolve(err(new ExecutionError("timeout", "timed out"))),
    };
    await expect(runGrep(env, { pattern: "x" }, context)).rejects.toThrow("timed out");
  });

  it("throws when the caller aborts", async () => {
    const caller = new AbortController();
    function* script(): Generator<Chunk> {
      yield out(match("./a", 1, "x"));
      caller.abort();
      yield out(match("./a", 2, "x"));
    }
    await expect(grep(script(), {}, 0, withAbortSignal(caller.signal, context))).rejects.toThrow();
  });

  it("throws when the caller aborts, even after its own stop fired", async () => {
    const caller = new AbortController();
    function* script(): Generator<Chunk> {
      yield out(match("./a", 1, "x"));
      caller.abort();
    }
    // limit 1: the first match fires the tool's own stop; the caller aborts after it.
    await expect(
      grep(script(), { limit: 1 }, 0, withAbortSignal(caller.signal, context)),
    ).rejects.toThrow();
  });

  it("throws when the caller aborts as the exec ends cleanly", async () => {
    const caller = new AbortController();
    const env: GrepEnv = {
      cwd: "/repo",
      exec: () => {
        caller.abort();
        return Promise.resolve(ok({ exitCode: 0 }));
      },
    };
    await expect(
      runGrep(env, { pattern: "x" }, withAbortSignal(caller.signal, context)),
    ).rejects.toThrow();
  });
});

// ---- VT-2: the RV-033 F-2 probe ---------------------------------------------
//
// Peak host memory is grep's own buffers (splitter carry ≤ MAX_MESSAGE_BYTES,
// kept output ≤ GREP_MAX_BYTES, stderr ≤ GREP_MAX_STDERR_BYTES) plus one chunk
// in hand and one parsed message: the constant. Asserted structurally through
// the collector's stats, never through process RSS. Every input is a lazy
// generator, so a 64 MiB line never exists whole; the bound does not depend on
// the line's size, so 64 MiB stands in for multi-GB.

const CHUNK = "x".repeat(64 * 1024);
const MIB = 1024 * 1024;

/** One `match` message whose line is `bytes` long, in 64 KiB chunks, then `rest`. */
function* hugeLine(bytes: number, ...rest: string[]): Generator<Chunk> {
  yield out('{"type":"match","data":{"path":{"text":"./big"},"lines":{"text":"');
  for (let sent = 0; sent < bytes; sent += CHUNK.length) {
    yield out(CHUNK);
  }
  yield out('\\n"},"line_number":1,"submatches":[]}}\n');
  yield* chunks(...rest);
}

/** The highest carry `splitter` held while taking `script`'s stdout. */
const peakCarry = (splitter: BoundedLineSplitter, script: Iterable<Chunk>): number => {
  let peak = 0;
  for (const chunk of script) {
    splitter.push(chunk.text);
    peak = Math.max(peak, splitter.carriedBytes());
  }
  return peak;
};

interface Probe {
  text: string;
  isError: boolean;
  stats: ReturnType<ReturnType<typeof grepCollector>["stats"]>;
}

/** The tool's collector over `script`, rendered for `exitCode`, with its stats. */
const probe = (script: Iterable<Chunk>, exitCode = 0, limit = 100): Probe => {
  // The env's side of a stop: it emits nothing more.
  const env = { stopped: false };
  const collector = grepCollector({
    limit,
    searchPath: ".",
    stop: () => {
      env.stopped = true;
    },
  });
  for (const chunk of script) {
    if (env.stopped) {
      break;
    }
    collector.accept(chunk.stream, chunk.text);
  }
  return { ...collector.render(exitCode), stats: collector.stats() };
};

const expectBounded = (result: Probe): void => {
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(GREP_MAX_BYTES);
  expect(result.stats.outputBytes).toBeLessThanOrEqual(GREP_MAX_BYTES);
  expect(result.stats.peakCarryBytes).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  expect(result.stats.stderrBytes).toBeLessThanOrEqual(GREP_MAX_STDERR_BYTES);
};

describe("grepTool: host memory is bounded (VT-2, EX-2)", () => {
  it("a 64 MiB single line: carry stays within MAX_MESSAGE_BYTES, one oversize notice, later matches kept", () => {
    const result = probe(hugeLine(64 * MIB, match("./a", 2, "after")));
    expectBounded(result);
    expect(result.stats.oversized).toBe(1);
    expect(result.text).toBe(
      "a:2: after\n\n[1 results too large to show; narrow the pattern or path]",
    );
  });

  it("negative control: the same probe over an uncapped splitter exceeds MAX_MESSAGE_BYTES", () => {
    const uncapped = boundedLineSplitter({ maxBytes: Infinity, onLine: () => undefined });
    expect(peakCarry(uncapped, hugeLine(4 * MIB))).toBeGreaterThan(MAX_MESSAGE_BYTES);
    // The capped splitter under the same probe holds.
    const capped = boundedLineSplitter({ maxBytes: MAX_MESSAGE_BYTES, onLine: () => undefined });
    expect(peakCarry(capped, hugeLine(4 * MIB))).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("a short line with ~200k submatches: a message over 1 MiB without a long line is oversized", () => {
    function* manySubmatches(): Generator<Chunk> {
      yield out(
        '{"type":"match","data":{"path":{"text":"./s"},"lines":{"text":"aaaa\\n"},"line_number":1,"submatches":[',
      );
      const batch = Array.from(
        { length: 1000 },
        () => '{"match":{"text":"a"},"start":0,"end":1}',
      ).join(",");
      for (let sent = 0; sent < 200; sent += 1) {
        yield out(`${sent === 0 ? "" : ","}${batch}`);
      }
      yield out("]}}\n");
    }
    const result = probe(manySubmatches());
    expectBounded(result);
    expect(result.stats.oversized).toBe(1);
    expect(result.stats.matches).toBe(0);
  });

  it("binary bytes payloads and malformed JSON lines are decoded or skipped, bounded", () => {
    const binary = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 256));
    const result = probe(
      chunks(
        "not json at all\n",
        '{"type":"match","data":\n',
        message("match", Buffer.from([0xff]), 1, binary),
        "\u0000\u0001garbage}{\n",
        "[1,2]\n",
        '{"type":"match","data":[]}\n',
        '{"type":"match","data":{"path":7,"lines":{"text":"no path\\n"},"line_number":3}}\n',
        match("./ok", 2, "fine"),
      ),
    );
    expectBounded(result);
    expect(result.stats.matches).toBe(3);
    expect(result.text).toContain(":3: no path");
    expect(result.text).toContain("ok:2: fine");
  });

  it("limit 1000 over 100 KB lines: each line cut to 500 characters, the 50 KB stop fires", () => {
    const line = "q".repeat(100 * 1024);
    function* long(): Generator<Chunk> {
      for (let n = 1; n <= 1000; n += 1) {
        yield out(match("./a", n, line));
      }
    }
    const result = probe(long(), 0, 1000);
    expectBounded(result);
    expect(result.text).toContain("50.0KB limit reached");
    for (const rendered of result.text.split("\n").filter((l) => l.startsWith("a:"))) {
      expect(rendered.length).toBeLessThanOrEqual(
        `a:1000: `.length + 500 + "... [truncated]".length,
      );
    }
  });

  it("multi-MB stderr with exit 2 and matches: stderr kept to 4 KiB in the notice", () => {
    function* noisy(): Generator<Chunk> {
      yield out(match("./a", 1, "x"));
      for (let sent = 0; sent < 8 * MIB; sent += CHUNK.length) {
        yield err2(CHUNK);
      }
    }
    const result = probe(noisy(), 2);
    expectBounded(result);
    expect(result.stats.stderrBytes).toBe(GREP_MAX_STDERR_BYTES);
    expect(result.text).toBe(
      `a:1: x\n\n[rg reported errors: ${CHUNK.slice(0, GREP_MAX_STDERR_BYTES)}]`,
    );
  });

  it("unbounded stdout with no newline, ended by the caller's abort: bounded, and the tool throws", async () => {
    /** 64 KiB chunks with no newline: 16 MiB, then `end` (the caller's abort) before the next. */
    function* endless(end: () => void): Generator<Chunk> {
      for (let n = 0; n < 256; n += 1) {
        yield out(CHUNK);
      }
      end();
      yield out(CHUNK);
    }
    const result = probe(endless(() => undefined));
    expectBounded(result);
    expect(result.stats.oversized).toBe(1);
    const caller = new AbortController();
    const aborted = grep(
      endless(() => {
        caller.abort();
      }),
      {},
      0,
      withAbortSignal(caller.signal, context),
    );
    await expect(aborted).rejects.toThrow();
  });
});

// ---- VT-3: one real run -----------------------------------------------------

describe("grepTool over localConnection with the host's rg (VT-3)", () => {
  it("finds a match with context, and an ignored file only with noIgnore", async () => {
    realBin("rg"); // throws "no rg on PATH": this VT fails loudly rather than skipping.
    const tmp = await tempDir();
    const connection = localConnection();
    try {
      await mkdir(join(tmp.dir, "src"));
      await writeFile(join(tmp.dir, "src", "a.txt"), "before\nneedle here\nafter\n");
      // rg honours .gitignore only inside a git repository.
      execFileSync("git", ["init", "--quiet"], { cwd: tmp.dir });
      await writeFile(join(tmp.dir, ".gitignore"), "ignored.txt\n");
      await writeFile(join(tmp.dir, "ignored.txt"), "needle hidden\n");
      const { harness, root, faux } = await openFauxHarness(new MemoryStorage(), {
        extensions: [grepExtension],
        env: () =>
          jobEnv({
            jobId: "grep",
            cwd: tmp.dir,
            connection,
            observer: { lost: () => Promise.resolve(), untrusted: () => undefined },
          }),
      });
      const run = async (args: Record<string, string | number | boolean>): Promise<string> => {
        faux.setResponses(callThenAnswer(grepTool.name, { pattern: "needle", ...args }, "done"));
        const submission = await root.submit({ type: "input", content: "go" }, context);
        await within(10_000, "grep", submission.wait(context));
        const result = (await toolResults(harness)).at(-1);
        return result === undefined ? "" : textOf(result);
      };
      try {
        expect(await run({ context: 1, path: "src" })).toBe(
          "a.txt-1- before\na.txt:2: needle here\na.txt-3- after",
        );
        expect(await run({})).toBe("src/a.txt:2: needle here");
        expect((await run({ noIgnore: true })).split("\n").sort()).toEqual([
          "ignored.txt:1: needle hidden",
          "src/a.txt:2: needle here",
        ]);
      } finally {
        await closeHarness(harness);
      }
    } finally {
      connection.close();
      await tmp.cleanup();
    }
  });
});
