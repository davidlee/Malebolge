// The MailSource adapter over the screwtape CLI (design sec-5, DEC-028): one
// child process per call, no shell, its stdout read as a stream of JSON
// envelope lines through the one bounded exec. Each line must be a v1
// envelope of the verb's kind whose `data` satisfies the v1 schema; anything
// else fails closed, so a call returns checked data or no data at all.
//
// Every failure becomes a MailSourceError worded from a fixed vocabulary:
// stderr is read only for a usage error's `code`, so no child text — least of
// all raw stderr — ever reaches a message the model can see.

import { withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, type ExecutionError } from "@earendil-works/pi-durable/env";
import { boundedExec, boundedOutput } from "../bounded-exec.ts";
import { context } from "../context.ts";
import { isRecord } from "../json.ts";
import {
  checkData,
  type DataOf,
  type ListQuery,
  type MailFilters,
  type MailKind,
  type MailSource,
  MailSourceError,
  type ReadAfterQuery,
  type ReadQuery,
  type ThreadQuery,
} from "./source.ts";

/** The most stdout one call may produce: per line and in all (a runaway child is killed). */
export const MAIL_STDOUT_MAX = 4 * 1024 * 1024;
/** The most stderr kept: read for a usage error's code and for nothing else. */
export const MAIL_STDERR_MAX = 4 * 1024;
/** ShellExecOptions.timeout is in SECONDS. */
export const MAIL_TIMEOUT_S = 10;

export interface ScrewtapeOptions {
  /** Absolute path (checked at startup in PHASE-08). */
  binary: string;
  /** Absolute path. */
  config: string;
  /** The child's HOME. */
  home: string;
  /** A host NodeExecutionEnv in production; a fake in tests. */
  env: Pick<ExecutionEnv, "exec">;
}

/** The shape a usage error's `code` may take: a bare word, so no stderr text rides along. */
const USAGE_CODE = /^[a-z_]{1,64}$/;

/** How many envelopes a verb prints: exactly one, or at most `max` (readAfter). */
type Arity = "one" | { readonly max: number };

// ----------------------------------------------------------------- argv

/** The listing filters, in contract order: mailbox, unread, from. */
function filterArgs(filters: MailFilters): string[] {
  return [
    ...(filters.mailbox === undefined ? [] : ["--mailbox", filters.mailbox]),
    ...(filters.unread === true ? ["--unread"] : []),
    ...(filters.from === undefined ? [] : ["--from", filters.from]),
  ];
}

function listArgs(query: ListQuery): string[] {
  return [
    "list",
    "--limit",
    String(query.limit),
    "--offset",
    String(query.offset),
    ...filterArgs(query.filters),
  ];
}

function readArgs(query: ReadQuery): string[] {
  return ["read", query.id, "--max-bytes", String(query.maxBytes)];
}

function readAfterArgs(query: ReadAfterQuery): string[] {
  return [
    "read",
    "--after",
    query.after,
    "--limit",
    String(query.limit),
    "--max-bytes",
    String(query.maxBytes),
    ...(query.since === undefined ? [] : ["--since", query.since]),
    ...filterArgs(query.filters),
  ];
}

function threadArgs(query: ThreadQuery): string[] {
  return ["thread", query.id, "--limit", String(query.limit)];
}

// -------------------------------------------------------------- failures

/** What a contract violation names: a fixed set, so no child text reaches the message. */
type Violation =
  | "unterminated line"
  | "wrong arity"
  | "not JSON"
  | "unsupported version"
  | "wrong kind"
  | "invalid data";

function contractViolation(what: Violation): MailSourceError {
  return new MailSourceError("contract", `screwtape contract violation: ${what}`);
}

/** The failure for output past a cap: above limit 1, a retry with limit 1 is sound advice. */
function oversizeError(limit: number | undefined): MailSourceError {
  const message =
    limit !== undefined && limit > 1
      ? "screwtape output over 4 MiB; retry with limit 1"
      : "screwtape output over 4 MiB";
  return new MailSourceError("oversize", message);
}

/**
 * The error for a failed exec: a timeout and a spawn failure are the
 * adapter's own words; any other ExecutionError is not its to rewrite.
 */
function execError(error: ExecutionError): Error {
  if (error.code === "timeout") {
    return new MailSourceError("timeout", "screwtape timed out after 10 s");
  }
  if (error.code === "spawn_error") {
    return new MailSourceError("spawn", "screwtape could not run");
  }
  return error;
}

/** The `code` of the first non-blank stderr line, if that line is a JSON object naming one. */
function usageCode(stderr: string): string | undefined {
  const first = stderr.split("\n").find((line) => line.trim() !== "");
  if (first === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const code = parsed["code"];
  return typeof code === "string" && USAGE_CODE.test(code) ? code : undefined;
}

/** The failure for a non-zero exit: stderr contributes only a usage error's code. */
function exitError(exitCode: number, stderr: string): MailSourceError {
  if (exitCode !== 2) {
    return new MailSourceError("failed", `screwtape failed (exit ${String(exitCode)})`);
  }
  const code = usageCode(stderr);
  return new MailSourceError(
    "usage",
    code === undefined ? "screwtape usage error" : `screwtape usage error: ${code}`,
  );
}

// ------------------------------------------------------------- envelopes

/** Whether `envelopes` stdout lines are an acceptable count for `arity`. */
function arityAllows(arity: Arity, envelopes: number): boolean {
  return arity === "one" ? envelopes === 1 : envelopes <= arity.max;
}

/**
 * The checked data of one envelope line of `kind`: a JSON object, version 1,
 * that kind, and data the kind's schema accepts (extra fields are allowed).
 * The checks run in the contract's order, so the first failure names the
 * earliest defect.
 */
function checkEnvelope<K extends MailKind>(kind: K, line: string): DataOf<K> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw contractViolation("not JSON");
  }
  if (!isRecord(parsed)) {
    throw contractViolation("not JSON");
  }
  if (parsed["version"] !== 1) {
    throw contractViolation("unsupported version");
  }
  if (parsed["kind"] !== kind) {
    throw contractViolation("wrong kind");
  }
  const data = checkData(kind, parsed["data"]);
  if (data === undefined) {
    throw contractViolation("invalid data");
  }
  return data;
}

// ------------------------------------------------------------------ calls

/** One call: where the child runs, its argv, and the envelope it must print. */
interface Call<K extends MailKind> {
  /** The binary, config, HOME and env the child runs with. */
  readonly client: ScrewtapeOptions;
  /** The argv after `--config <config>`. */
  readonly args: readonly string[];
  /** The caller's signal: aborting it throws, and the error is not a MailSourceError. */
  readonly signal: AbortSignal | undefined;
  /** The query's limit where it has one: above 1 an oversize result advises a retry. */
  readonly limit?: number;
  /** The kind of envelope the verb prints (readAfter prints reads). */
  readonly kind: K;
}

/** A call with how many envelopes it may print. */
interface RunCall<K extends MailKind> extends Call<K> {
  readonly arity: Arity;
}

/**
 * One screwtape child, start to finish: the bounded exec, its outcome mapped
 * to an error, then the envelope contract. A breach, a non-zero exit or a
 * contract violation fails the whole call — no partial data is returned.
 */
async function run<K extends MailKind>(call: RunCall<K>): Promise<DataOf<K>[]> {
  const lines: string[] = [];
  const stop = new AbortController();
  const output = boundedOutput({
    maxLineBytes: MAIL_STDOUT_MAX,
    maxTotalBytes: MAIL_STDOUT_MAX,
    maxStderrBytes: MAIL_STDERR_MAX,
    oversize: "fail",
    onLine: (line) => {
      lines.push(line);
    },
    onBreach: () => {
      stop.abort();
    },
  });
  const outcome = await boundedExec(
    call.client.env,
    [call.client.binary, "--config", call.client.config, ...call.args],
    {
      exec: { env: { HOME: call.client.home }, inheritEnv: false, timeout: MAIL_TIMEOUT_S },
      output,
      stop: stop.signal,
    },
    call.signal === undefined ? context : withAbortSignal(call.signal, context),
  );
  if (output.breach !== undefined) {
    throw oversizeError(call.limit);
  }
  if (outcome.kind === "failed") {
    throw execError(outcome.error);
  }
  if (outcome.kind === "stopped") {
    // Our one stop is a breach, answered above; any other stop is unexpected.
    throw new Error("screwtape stopped");
  }
  if (outcome.exitCode !== 0) {
    throw exitError(outcome.exitCode, output.stderr.text);
  }
  if (output.carriedBytes() > 0) {
    throw contractViolation("unterminated line");
  }
  if (!arityAllows(call.arity, lines.length)) {
    throw contractViolation("wrong arity");
  }
  return lines.map((line) => checkEnvelope(call.kind, line));
}

/** A single-envelope verb's one checked data. */
async function runOne<K extends MailKind>(call: Call<K>): Promise<DataOf<K>> {
  const [data] = await run({ ...call, arity: "one" });
  if (data === undefined) {
    // run checked the arity, so this cannot happen; it still returns no data.
    throw contractViolation("wrong arity");
  }
  return data;
}

/** A multi-envelope verb's checked datas: every line, or (on any failure) none. */
async function runMany<K extends MailKind>(
  call: Call<K> & { readonly limit: number },
): Promise<DataOf<K>[]> {
  return run({ ...call, arity: { max: call.limit } });
}

// ------------------------------------------------------------------ port

/** The MailSource over the screwtape CLI: one checked call per query. */
export function screwtapeSource(options: ScrewtapeOptions): MailSource {
  return {
    mailboxes: (signal) =>
      runOne({ client: options, args: ["mailboxes"], signal, kind: "mailboxes" }),
    list: (query) =>
      runOne({
        client: options,
        args: listArgs(query),
        signal: query.signal,
        limit: query.limit,
        kind: "list",
      }),
    read: (query) =>
      runOne({ client: options, args: readArgs(query), signal: query.signal, kind: "read" }),
    readAfter: (query) =>
      runMany({
        client: options,
        args: readAfterArgs(query),
        signal: query.signal,
        limit: query.limit,
        kind: "read",
      }),
    thread: (query) =>
      runOne({
        client: options,
        args: threadArgs(query),
        signal: query.signal,
        limit: query.limit,
        kind: "thread",
      }),
  };
}
