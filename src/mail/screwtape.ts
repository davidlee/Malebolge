// The MailSource adapter over the screwtape CLI (design sec-5, DEC-028): one
// child process per call, no shell, its stdout read as a stream of JSON
// envelope lines through the one bounded exec. Each line must be a v1
// envelope of the verb's kind whose `data` satisfies the v1 schema; anything
// else fails closed, so a call returns checked data or no data at all.
// classify is the one exception that reads a failing child's output: it reads
// each id with the read verb, sends those lines to one classify child through
// the stdin-capable exec, and maps how that child ended onto the ids it left
// unanswered (DEC-056).
//
// Every failure becomes a MailSourceError worded from a fixed vocabulary:
// stderr is read only for a usage error's code (its `reason`), so no child text — least of
// all raw stderr — ever reaches a message the model can see.

import { withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, type ExecutionError } from "@earendil-works/pi-durable/env";
import { type Breach, boundedExec, boundedOutput, type ExecOutcome } from "../bounded-exec.ts";
import { context } from "../context.ts";
import { isRecord } from "../json.ts";
import { stdinEnv } from "../stdin-env.ts";
import {
  checkData,
  type Classification,
  type ClassifyOutcome,
  type ClassifyQuery,
  type DataOf,
  isCanonicalCursor,
  type ListQuery,
  type MailFilters,
  type MailKind,
  type MailSource,
  MailSourceError,
  type ReadAfterQuery,
  type ReadData,
  type ReadQuery,
  type ThreadQuery,
  type Unclassified,
} from "./source.ts";

/** The most stdout one call may produce: per line and in all (a runaway child is killed). */
export const MAIL_STDOUT_MAX = 4 * 1024 * 1024;
/** The most stderr kept: read for a usage error's code and for nothing else. */
export const MAIL_STDERR_MAX = 4 * 1024;
/** ShellExecOptions.timeout is in SECONDS. */
export const MAIL_TIMEOUT_S = 10;
/** The classify child's deadline: one Jev call per batch, in SECONDS. */
export const CLASSIFY_TIMEOUT_S = 30;
/** The most bytes each classify read takes: screwtape's body budget, so no more is sent to Jev. */
export const CLASSIFY_READ_BYTES = 16_384;

export interface ScrewtapeOptions {
  /** Absolute path (checked at startup in PHASE-08). */
  binary: string;
  /** Absolute path. */
  config: string;
  /** The child's HOME (and, for classify, its cwd). */
  home: string;
  /** A host NodeExecutionEnv in production; a fake in tests. */
  env: Pick<ExecutionEnv, "exec">;
  /**
   * Jev's credentials directory, the classify child's CREDENTIALS_DIRECTORY.
   * Absent: no credentials, so every id is `unavailable` and nothing spawns.
   */
  credentials?: string;
  /**
   * The exec the classify spawn runs through, given its stdin text:
   * the stdin-capable exec by default, a fake in tests.
   */
  stdinEnv?: (input: string) => Pick<ExecutionEnv, "exec">;
}

/** The shape one fixed stderr field takes: a bare word, so no stderr text rides along. */
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

/** A stderr field as a bare word, or undefined: a field carrying text is dropped. */
function bareWord(value: unknown): string | undefined {
  return typeof value === "string" && USAGE_CODE.test(value) ? value : undefined;
}

/**
 * The first stderr line that is a JSON object at level "error" (screwtape
 * writes one diagnostic per line, and a warning may come first).
 */
function firstDiagnostic(stderr: string): Record<string, unknown> | undefined {
  return stderr
    .split("\n")
    .map(errorDiagnostic)
    .find((d) => d !== undefined);
}

/** A usage error's code: the `reason` of stderr's first error-level line, if a bare word. */
function usageCode(stderr: string): string | undefined {
  return bareWord(firstDiagnostic(stderr)?.["reason"]);
}

/** A stderr line as an error-level diagnostic object, or undefined. */
function errorDiagnostic(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isRecord(parsed) && parsed["level"] === "error" ? parsed : undefined;
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

/** One bounded child: what to run, where, how long, and how much of its stdout is kept. */
interface SpawnCall {
  /** The env to spawn through: the host's, or the stdin-capable one classify needs. */
  readonly exec: Pick<ExecutionEnv, "exec">;
  /** The whole argv: the binary, `--config <config>`, the verb and its flags. */
  readonly argv: readonly string[];
  /** The child's working directory. */
  readonly cwd: string;
  /** The child's environment, which replaces the environment (inheritEnv stays false). */
  readonly env: Record<string, string>;
  /** The child's deadline in SECONDS (ShellExecOptions.timeout). */
  readonly timeoutS: number;
  /** The most stdout it may produce: per line and in all. */
  readonly stdoutMax: number;
  /** The caller's signal: aborting it throws, and the error is not a MailSourceError. */
  readonly signal: AbortSignal | undefined;
}

/** What one bounded child left behind: how it ended, and what it printed within the caps. */
interface Spawned {
  readonly outcome: ExecOutcome;
  /** The complete stdout lines it printed. */
  readonly lines: readonly string[];
  /** The kept stderr head. */
  readonly stderr: string;
  /** The first cap it broke, if any (the child was stopped for it). */
  readonly breach: Breach | undefined;
  /** Bytes of a stdout line it left unterminated: an unterminated last line. */
  readonly carried: number;
}

/**
 * One screwtape child, start to finish, with nothing judged: its output within
 * the caps, its stderr head, and how it ended. A breach, a timeout, a spawn
 * failure and a non-zero exit all come back as data for the caller to map;
 * only the caller's own abort throws.
 */
async function spawnBounded(call: SpawnCall): Promise<Spawned> {
  const lines: string[] = [];
  const stop = new AbortController();
  const output = boundedOutput({
    maxLineBytes: call.stdoutMax,
    maxTotalBytes: call.stdoutMax,
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
    call.exec,
    call.argv,
    {
      exec: { env: call.env, inheritEnv: false, timeout: call.timeoutS, cwd: call.cwd },
      output,
      stop: stop.signal,
    },
    call.signal === undefined ? context : withAbortSignal(call.signal, context),
  );
  return {
    outcome,
    lines,
    stderr: output.stderr.text,
    breach: output.breach,
    carried: output.carriedBytes(),
  };
}

/**
 * One read verb: spawnBounded, then today's failure mapping and envelope
 * contract. A breach, a non-zero exit or a contract violation fails the whole
 * call — no partial data is returned.
 */
async function run<K extends MailKind>(call: RunCall<K>): Promise<DataOf<K>[]> {
  const spawned = await spawnBounded({
    exec: call.client.env,
    argv: [call.client.binary, "--config", call.client.config, ...call.args],
    cwd: call.client.home,
    env: { HOME: call.client.home },
    timeoutS: MAIL_TIMEOUT_S,
    stdoutMax: MAIL_STDOUT_MAX,
    signal: call.signal,
  });
  if (spawned.breach !== undefined) {
    throw oversizeError(call.limit);
  }
  if (spawned.outcome.kind === "failed") {
    throw execError(spawned.outcome.error);
  }
  if (spawned.outcome.kind === "stopped") {
    // Our one stop is a breach, answered above; any other stop is unexpected.
    throw new Error("screwtape stopped");
  }
  if (spawned.outcome.exitCode !== 0) {
    throw exitError(spawned.outcome.exitCode, spawned.stderr);
  }
  if (spawned.carried > 0) {
    throw contractViolation("unterminated line");
  }
  if (!arityAllows(call.arity, spawned.lines.length)) {
    throw contractViolation("wrong arity");
  }
  return spawned.lines.map((line) => checkEnvelope(call.kind, line));
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

// --------------------------------------------------------------- classify

/** One id's read for a classify batch: the checked data, or nothing when the read failed. */
interface ReadAttempt {
  readonly id: string;
  readonly data: ReadData | undefined;
}

/** One id's batch answer: its classification, or the fixed reason it has none. */
type Verdict = Classification | Unclassified;

/** One id's read at the classify body budget, or undefined when the read failed. */
async function readForBatch(
  options: ScrewtapeOptions,
  id: string,
  signal: AbortSignal | undefined,
): Promise<ReadData | undefined> {
  try {
    return await runOne({
      client: options,
      args: readArgs({ id, maxBytes: CLASSIFY_READ_BYTES }),
      signal,
      kind: "read",
    });
  } catch (error) {
    if (error instanceof MailSourceError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Each id's read, in order and one at a time: any MailSourceError leaves that
 * id `failed` and out of the batch, and the caller's abort still throws.
 */
async function readAttempts(
  options: ScrewtapeOptions,
  ids: readonly string[],
  signal: AbortSignal | undefined,
): Promise<ReadAttempt[]> {
  const attempts: ReadAttempt[] = [];
  for (const id of ids) {
    attempts.push({ id, data: await readForBatch(options, id, signal) });
  }
  return attempts;
}

/** The classify child's stdin: each surviving read re-encoded, one `\n`-terminated line each. */
function classifyStdin(inputs: readonly ReadData[]): string {
  return inputs.map((data) => `${JSON.stringify({ version: 1, kind: "read", data })}\n`).join("");
}

/** The one classify child: the reads on stdin, Jev's own env, through the stdin-capable exec. */
async function spawnClassify(
  options: ScrewtapeOptions,
  credentials: string,
  inputs: readonly ReadData[],
  signal: AbortSignal | undefined,
): Promise<Spawned> {
  const through = options.stdinEnv ?? stdinEnv;
  return spawnBounded({
    exec: through(classifyStdin(inputs)),
    argv: [options.binary, "--config", options.config, "classify"],
    cwd: options.home,
    env: { HOME: options.home, CREDENTIALS_DIRECTORY: credentials, ERL_CRASH_DUMP_SECONDS: "0" },
    timeoutS: CLASSIFY_TIMEOUT_S,
    stdoutMax: MAIL_STDOUT_MAX,
    signal,
  });
}

/** Whether the child exited 0 (a breach ends it as stopped, so it is answered before this). */
function exitedCleanly(outcome: ExecOutcome): boolean {
  return outcome.kind === "exited" && outcome.exitCode === 0;
}

/** The checked data of one classify line, if it answers `input`; undefined on any defect. */
function classifyLine(text: string, input: ReadData | undefined): Classification | undefined {
  let data: Classification;
  try {
    data = checkEnvelope("classify", text);
  } catch {
    return undefined;
  }
  return data.id === input?.id ? data : undefined;
}

/** Whether the output cannot be a checked prefix: more lines than ids, or a line left unterminated. */
function outputShapeBroken(spawned: Spawned, ids: number): boolean {
  if (spawned.lines.length > ids) {
    return true;
  }
  return spawned.carried > 0 && spawned.breach === undefined;
}

/** Whether a clean exit left ids unanswered: a violation, unless a breach ended the child. */
function stoppedUnfinished(spawned: Spawned, checked: number, ids: number): boolean {
  return spawned.breach === undefined && checked < ids && exitedCleanly(spawned.outcome);
}

/**
 * The checked classify lines of one spawn, in order, or undefined when the
 * output is a contract violation: an unterminated last line, more lines than
 * ids, a line that is not a classify envelope of the input's id at its
 * position, or a clean exit before the batch was answered. A breach is not a
 * violation: the lines printed before it stand (DEC-056's last row).
 */
function checkedPrefix(
  spawned: Spawned,
  inputs: readonly ReadData[],
): Classification[] | undefined {
  if (outputShapeBroken(spawned, inputs.length)) {
    return undefined;
  }
  const checked: Classification[] = [];
  for (const [index, text] of spawned.lines.entries()) {
    const data = classifyLine(text, inputs[index]);
    if (data === undefined) {
      return undefined;
    }
    checked.push(data);
  }
  const unfinished = stoppedUnfinished(spawned, checked.length, inputs.length);
  return unfinished ? undefined : checked;
}

/**
 * Whether stderr's one error line says the batch ran past Jev's context bound
 * at `cursor`: `limit_exceeded` under `jev_context`, for exactly that cursor.
 */
function limitExceededAt(
  diagnostic: Record<string, unknown> | undefined,
  cursor: string | undefined,
): boolean {
  if (diagnostic === undefined || cursor === undefined) {
    return false;
  }
  const named = diagnostic["cursor"];
  return (
    bareWord(diagnostic["error"]) === "limit_exceeded" &&
    bareWord(diagnostic["bound"]) === "jev_context" &&
    typeof named === "string" &&
    isCanonicalCursor(named) &&
    named === cursor
  );
}

/**
 * Why the ids after the checked prefix have no classification: DEC-056's table,
 * read from stderr's one error line and nothing else of the child's text.
 */
function stopReason(spawned: Spawned, current: ReadData | undefined): Unclassified {
  const diagnostic = firstDiagnostic(spawned.stderr);
  if (limitExceededAt(diagnostic, current?.cursor)) {
    return "too_large";
  }
  const error = bareWord(diagnostic?.["error"]);
  return error === "config" || error === "credential" ? "unavailable" : "failed";
}

/** The verdicts after the checked prefix: input[k] by how the child ended, the rest after it. */
function suffixVerdicts(spawned: Spawned, rest: readonly ReadData[]): Verdict[] {
  const [current, ...others] = rest;
  const reason = stopReason(spawned, current);
  if (reason === "too_large") {
    return ["too_large", ...others.map((): Verdict => "failed")];
  }
  return rest.map((): Verdict => reason);
}

/** The batch's verdicts, in order: the checked prefix classified, then DEC-056's table. */
function batchVerdicts(spawned: Spawned, inputs: readonly ReadData[]): Verdict[] {
  const prefix = checkedPrefix(spawned, inputs);
  if (prefix === undefined) {
    return inputs.map((): Verdict => "failed");
  }
  return prefix.length === inputs.length
    ? prefix
    : [...prefix, ...suffixVerdicts(spawned, inputs.slice(prefix.length))];
}

/** One id's outcome from its batch verdict; an id the batch never reached is `failed`. */
function outcomeOf(id: string, verdict: Verdict | undefined): ClassifyOutcome {
  if (verdict === undefined) {
    return { id, unclassified: "failed" };
  }
  return typeof verdict === "string" ? { id, unclassified: verdict } : { id, classified: verdict };
}

/** The outcomes of every id, in `ids` order: its batch verdict, or `failed` if it had none. */
function mergeOutcomes(
  attempts: readonly ReadAttempt[],
  verdicts: readonly Verdict[],
): ClassifyOutcome[] {
  const outcomes: ClassifyOutcome[] = [];
  let next = 0;
  for (const attempt of attempts) {
    if (attempt.data === undefined) {
      outcomes.push(outcomeOf(attempt.id, undefined));
      continue;
    }
    outcomes.push(outcomeOf(attempt.id, verdicts[next]));
    next += 1;
  }
  return outcomes;
}

/**
 * One classify batch (design § One classify(ids) call): read each id, send the
 * reads that survived to one child, and map how it ended onto the ids it left
 * unanswered. No child text reaches an outcome; never throws for a classify
 * failure, only for the caller's abort.
 */
async function classify(
  options: ScrewtapeOptions,
  query: ClassifyQuery,
): Promise<ClassifyOutcome[]> {
  const credentials = options.credentials;
  if (credentials === undefined) {
    return query.ids.map((id): ClassifyOutcome => ({ id, unclassified: "unavailable" }));
  }
  const attempts = await readAttempts(options, query.ids, query.signal);
  const inputs = attempts.flatMap((attempt) => (attempt.data === undefined ? [] : [attempt.data]));
  if (inputs.length === 0) {
    return mergeOutcomes(attempts, []);
  }
  const spawned = await spawnClassify(options, credentials, inputs, query.signal);
  return mergeOutcomes(attempts, batchVerdicts(spawned, inputs));
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
    classify: (query) => classify(options, query),
  };
}
