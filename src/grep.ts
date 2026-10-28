// The grep tool (design §4.5): ripgrep's JSON output through the
// conversation's execution environment, in pi's output format.
//
// rg may be repo-supplied and so hostile (design "Trust"), and `--json`
// always carries whole lines, so nothing it sends is buffered unbounded:
// the bounds come from bounded-exec (src/bounded-exec.ts) — a line splitter
// capped at MAX_MESSAGE_BYTES, kept output stopping at GREP_MAX_BYTES, stderr
// capped at GREP_MAX_STDERR_BYTES — and the exec is boundedExec, in "count"
// mode. Host memory per call is those caps plus the chunk in hand.

import { posix } from "node:path";
import { type Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { boundedExec, boundedOutput } from "./bounded-exec.ts";
import { isRecord } from "./json.ts";
import { GREP_MAX_LINE_LENGTH, truncateLine } from "./truncate.ts";

/** The largest rg message parsed; a longer one is dropped as it streams and counted. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** The whole result, notices included (pi's DEFAULT_MAX_BYTES). */
export const GREP_MAX_BYTES = 50 * 1024;
export const GREP_MAX_STDERR_BYTES = 4 * 1024;
/**
 * Room kept below GREP_MAX_BYTES for the notices: the stderr notice's capped
 * text plus the fixed ones, so the result fits without cutting a notice.
 */
const NOTICE_RESERVE = GREP_MAX_STDERR_BYTES + 1024;
const DEFAULT_LIMIT = 100;

const parameters = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(
    Type.String({ description: "Directory or file to search (default: current directory)" }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }),
  ),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: "Case-insensitive search (default: false)" }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description: "Treat pattern as literal string instead of regex (default: false)",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description: "Number of lines to show before and after each match (default: 0)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of matches to return (default: 100)" }),
  ),
  noIgnore: Type.Optional(
    Type.Boolean({
      description: "Also search files .gitignore excludes; .git stays excluded (default: false)",
    }),
  ),
});

export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
  noIgnore?: boolean;
}

/** What grep needs of an env. */
export type GrepEnv = Pick<ExecutionEnv, "cwd" | "exec">;

export interface GrepResult {
  text: string;
  isError: boolean;
}

/** `value` truncated toward zero, then clamped to [lo, hi]; `fallback` when absent or not finite. */
const clamp = (value: number | undefined, lo: number, hi: number, fallback: number): number =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(hi, Math.max(lo, Math.trunc(value)));

/** Context lines around each match: 0–20, default 0. */
export const contextLines = (value?: number): number => clamp(value, 0, 20, 0);
/** Matches kept: 1–1000, default 100. */
export const matchLimit = (value?: number): number => clamp(value, 1, 1000, DEFAULT_LIMIT);

const searchPathOf = (params: GrepParams): string =>
  params.path === undefined || params.path === "" ? "." : params.path;

export function grepArgv(params: GrepParams): string[] {
  const context = contextLines(params.context);
  return [
    "rg",
    "--json",
    "--line-number",
    "--color=never",
    "--hidden",
    ...(params.glob === undefined ? [] : ["--glob", params.glob]),
    ...(params.ignoreCase === true ? ["--ignore-case"] : []),
    ...(params.literal === true ? ["--fixed-strings"] : []),
    ...(context > 0 ? ["--context", String(context)] : []),
    ...(params.noIgnore === true ? ["--no-ignore", "--glob", "!.git"] : []),
    "--",
    params.pattern,
    searchPathOf(params),
  ];
}

/** An rg text field: `{text}`, or `{bytes}` (base64) for non-UTF-8, decoded with replacement characters. */
const textOf = (field: unknown): string => {
  if (!isRecord(field)) {
    return "";
  }
  const { text, bytes } = field;
  if (typeof text === "string") {
    return text;
  }
  return typeof bytes === "string" ? Buffer.from(bytes, "base64").toString("utf8") : "";
};

/**
 * A reported path relative to the search path; a path rg reports exactly as
 * given (a file search) or one outside it is shown as its basename (pi's fallback).
 */
const displayPath = (reported: string, searchPath: string): string => {
  const relative = reported === searchPath ? "" : posix.relative(searchPath, reported);
  return relative === "" || relative.startsWith("..") ? posix.basename(reported) : relative;
};

interface RgLine {
  kind: "match" | "context";
  path: string;
  lineNumber: number;
  text: string;
}

/** A `match` or `context` message; anything else, or a line that is not JSON, is undefined. */
const parseLine = (line: string): RgLine | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value["data"])) {
    return undefined;
  }
  const kind = value["type"];
  const lineNumber = value["data"]["line_number"];
  if ((kind !== "match" && kind !== "context") || typeof lineNumber !== "number") {
    return undefined;
  }
  return {
    kind,
    path: textOf(value["data"]["path"]),
    lineNumber,
    text: textOf(value["data"]["lines"]),
  };
};

export interface GrepStats {
  /** The splitter's largest carry: at most MAX_MESSAGE_BYTES. */
  peakCarryBytes: number;
  stderrBytes: number;
  /** Kept output, before notices. */
  outputBytes: number;
  /** Messages over MAX_MESSAGE_BYTES, dropped. */
  oversized: number;
  matches: number;
}

export interface GrepCollector {
  accept: (stream: "stdout" | "stderr", text: string) => void;
  /** The result for rg's exit code; a collector that stopped itself is a success whatever the code. */
  render: (exitCode: number) => GrepResult;
  stats: () => GrepStats;
}

interface Kept {
  lines: string[];
  bytes: number;
  matches: number;
  limitReached: boolean;
  byteCapped: boolean;
  linesTruncated: boolean;
}

const noticesOf = (kept: Kept, limit: number, stderr: string, oversized: number): string[] => [
  ...(kept.limitReached
    ? [
        `${String(limit)} matches limit reached. Use limit=${String(limit * 2)} for more, or refine pattern`,
      ]
    : []),
  ...(kept.byteCapped ? [`${(GREP_MAX_BYTES / 1024).toFixed(1)}KB limit reached`] : []),
  ...(kept.linesTruncated
    ? [
        `Some lines truncated to ${String(GREP_MAX_LINE_LENGTH)} chars. Use read tool to see full lines`,
      ]
    : []),
  ...(oversized > 0
    ? [`${String(oversized)} results too large to show; narrow the pattern or path`]
    : []),
  ...(stderr === "" ? [] : [`rg reported errors: ${stderr}`]),
];

/** Kept lines, then pi's bracketed notices. */
const renderKept = (kept: Kept, limit: number, stderr: string, oversized: number): string => {
  const notices = noticesOf(kept, limit, stderr, oversized);
  const parts = [kept.lines.join("\n"), notices.length === 0 ? "" : `[${notices.join(". ")}]`];
  const text = parts.filter((part) => part !== "").join("\n\n");
  return text === "" ? "No matches found" : text;
};

/** pi's line: `path:line: text` for a match, `path-line- text` for context; the text cut to GREP_MAX_LINE_LENGTH. */
const renderLine = (line: RgLine, searchPath: string): { text: string; wasTruncated: boolean } => {
  const separator = line.kind === "match" ? ":" : "-";
  const cut = truncateLine(line.text.replace(/\n$/, "").replaceAll("\r", ""));
  const prefix = `${displayPath(line.path, searchPath)}${separator}${String(line.lineNumber)}${separator}`;
  return { text: `${prefix} ${cut.text}`, wasTruncated: cut.wasTruncated };
};

/** design §4.5's exit codes: 0, a stopped search, or 2 with matches answer the matches; 1 none; else an error. */
const resultOf = (
  kept: Kept,
  limit: number,
  stderr: string,
  oversized: number,
  exitCode: number,
  stopped: boolean,
): GrepResult => {
  if (stopped || exitCode === 0 || (exitCode === 2 && kept.matches > 0)) {
    return {
      text: renderKept(kept, limit, exitCode === 2 ? stderr : "", oversized),
      isError: false,
    };
  }
  if (exitCode === 1) {
    return { text: "No matches found", isError: false };
  }
  return {
    text: stderr === "" ? `ripgrep exited with code ${String(exitCode)}` : stderr,
    isError: true,
  };
};

/**
 * rg's output as it streams, within the caps: pi's lines for `match` and
 * `context` messages, each truncated to GREP_MAX_LINE_LENGTH. Reaching
 * `limit` matches, or a line that would pass the output budget, calls `stop`
 * once; later stdout is ignored.
 */
export function grepCollector(options: {
  limit: number;
  searchPath: string;
  stop: () => void;
}): GrepCollector {
  const { limit, searchPath } = options;
  const kept: Kept = {
    lines: [],
    bytes: 0,
    matches: 0,
    limitReached: false,
    byteCapped: false,
    linesTruncated: false,
  };
  let stopped = false;
  let peakCarryBytes = 0;
  const halt = (): void => {
    stopped = true;
    options.stop();
  };
  const keep = (line: RgLine): void => {
    const { text: rendered, wasTruncated } = renderLine(line, searchPath);
    const size = Buffer.byteLength(rendered, "utf8") + (kept.lines.length > 0 ? 1 : 0);
    if (kept.bytes + size > GREP_MAX_BYTES - NOTICE_RESERVE) {
      kept.byteCapped = true;
      halt();
      return;
    }
    kept.lines.push(rendered);
    kept.bytes += size;
    kept.linesTruncated ||= wasTruncated;
    if (line.kind === "match") {
      kept.matches += 1;
      if (kept.matches >= limit) {
        kept.limitReached = true;
        halt();
      }
    }
  };
  const output = boundedOutput({
    maxLineBytes: MAX_MESSAGE_BYTES,
    maxStderrBytes: GREP_MAX_STDERR_BYTES,
    oversize: "count",
    onLine: (text) => {
      const line = stopped ? undefined : parseLine(text);
      if (line !== undefined) {
        keep(line);
      }
    },
  });
  return {
    accept: (stream, text): void => {
      if (stream === "stderr") {
        output.accept("stderr", text);
      } else if (!stopped) {
        output.accept("stdout", text);
        peakCarryBytes = Math.max(peakCarryBytes, output.carriedBytes());
      }
    },
    render: (exitCode) =>
      resultOf(kept, limit, output.stderr.text.trim(), output.oversized, exitCode, stopped),
    stats: () => ({
      peakCarryBytes,
      stderrBytes: output.stderr.bytes,
      outputBytes: kept.bytes,
      oversized: output.oversized,
      matches: kept.matches,
    }),
  };
}

/**
 * One search in `env`'s cwd. The collector's own stop aborts rg and is a
 * success; the caller's abort throws, even when the own stop also fired.
 */
export async function runGrep(
  env: GrepEnv,
  params: GrepParams,
  context: Context,
): Promise<GrepResult> {
  const own = new AbortController();
  const collector = grepCollector({
    limit: matchLimit(params.limit),
    searchPath: searchPathOf(params),
    stop: () => {
      own.abort();
    },
  });
  const outcome = await boundedExec(
    env,
    grepArgv(params),
    { exec: { cwd: env.cwd }, output: collector, stop: own.signal },
    context,
  );
  if (outcome.kind === "exited") {
    return collector.render(outcome.exitCode);
  }
  if (outcome.kind === "stopped") {
    return collector.render(0);
  }
  if (outcome.error.code === "spawn_error") {
    return { text: `rg could not run: ${outcome.error.message}`, isError: true };
  }
  throw outcome.error;
}

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents for a pattern. Returns matching lines with file paths and line numbers. " +
    `Respects .gitignore unless noIgnore. Output is truncated to ${String(DEFAULT_LIMIT)} matches ` +
    `or ${String(GREP_MAX_BYTES / 1024)}KB (whichever is hit first). ` +
    `Long lines are truncated to ${String(GREP_MAX_LINE_LENGTH)} chars.`,
  parameters,
  // A search changes nothing: an interrupted one reruns after a restart.
  replay: "safe",
  execute: async (args, api, context) => {
    if (api.env === undefined) {
      throw new Error("No execution environment is configured");
    }
    const { text, isError } = await runGrep(api.env, args, context);
    return { output: [{ type: "text", text }], isError };
  },
});

export const grepExtension = defineExtension({ name: "grep", tools: [grepTool] });
