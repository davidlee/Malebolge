// SL-005 PHASE-06 VT-1: the Screwtape MailSource adapter over a fake exec.
//
// The fake records the argv and exec options, plays stdout/stderr chunks into
// `onOutput`, honours the call's abort signal like a real env answering a kill,
// and answers an exit code or an ExecutionError. Stdout comes from the PHASE-05
// fixtures as raw text; synthetic inputs are built inline. No screwtape runs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
  err,
  ExecutionError,
  type ExecutionEnv,
  ok,
  type ShellExecOptions,
} from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import {
  MAIL_STDOUT_MAX,
  type ScrewtapeOptions,
  screwtapeSource,
} from "../../src/mail/screwtape.ts";
import { type MailSource, MailSourceError } from "../../src/mail/source.ts";
import {
  type Envelope,
  loadData,
  loadEnvelopes,
  loadReadPage,
  type MailKind,
  setAt,
  withExtraFields,
} from "./mail-fixtures.ts";

// ------------------------------------------------------------------ the fake

const BINARY = "/opt/screwtape/bin/screwtape";
const CONFIG = "/etc/screwtape/config.toml";
const HOME = "/home/mail";
const PREFIX = [BINARY, "--config", CONFIG];
const SENTINEL = "SECRET-STDERR-9f3a7c";

interface Script {
  stdout?: Iterable<string>;
  stderr?: string | undefined;
  /** An exit code, or the ExecutionError the env answers. Default: exit 0. */
  result?: number | ExecutionError;
  /** false: the child ignores a kill and answers `result` anyway. Default true. */
  killable?: boolean;
}

type ExecResult = Awaited<ReturnType<ExecutionEnv["exec"]>>;

interface Call {
  argv: readonly string[];
  options: ShellExecOptions | undefined;
}

interface Fake {
  env: Pick<ExecutionEnv, "exec">;
  calls: Call[];
  /** Stdout chunks handed to `onOutput`. */
  emitted: () => number;
  /** Whether the call's signal was aborted when the exec ended (the child was stopped). */
  stopped: () => boolean;
}

/** Plays stdout into `options.onOutput` until done or, for a killable child, until the call is aborted. */
function play(
  stdout: Iterable<string>,
  killable: boolean,
  at: Context,
  options?: ShellExecOptions,
): number {
  let emitted = 0;
  for (const text of stdout) {
    if (killable && at.abortSignal?.aborted === true) {
      break;
    }
    emitted += 1;
    options?.onOutput?.(text, at, { stream: "stdout" });
  }
  return emitted;
}

/** What the env answers: a kill when the child was stopped (and honours it), else `result`. */
function answer(result: number | ExecutionError, stopped: boolean): ExecResult {
  if (stopped) {
    return err(new ExecutionError("aborted", "aborted"));
  }
  return typeof result === "number" ? ok({ exitCode: result }) : err(result);
}

function fakeExec(script: Script = {}): Fake {
  const { stdout = [], stderr = "", result = 0, killable = true } = script;
  const calls: Call[] = [];
  let emitted = 0;
  let stopped = false;
  const env: Pick<ExecutionEnv, "exec"> = {
    exec: (command, options, at: Context) => {
      calls.push({ argv: typeof command === "string" ? [command] : command, options });
      options?.onOutput?.(stderr, at, { stream: "stderr" });
      emitted += play(stdout, killable, at, options);
      stopped = at.abortSignal?.aborted === true;
      return Promise.resolve(answer(result, killable && stopped));
    },
  };
  return { env, calls, emitted: () => emitted, stopped: () => stopped };
}

function sourceOver(fake: Fake, overrides: Partial<ScrewtapeOptions> = {}): MailSource {
  return screwtapeSource({
    binary: BINARY,
    config: CONFIG,
    home: HOME,
    env: fake.env,
    ...overrides,
  });
}

function fixtureText(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
}

const line = (envelope: unknown): string => `${JSON.stringify(envelope)}\n`;

/** One chunk per stdout text (none for empty stdout). */
const chunksOf = (text: string): string[] => (text === "" ? [] : [text]);

/** A call that must fail with a MailSourceError: returns it, throws anything else. */
async function failureOf(call: Promise<unknown>): Promise<MailSourceError> {
  const outcome = await call.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof MailSourceError)) {
    throw outcome instanceof Error ? outcome : new Error("resolved with data");
  }
  return outcome;
}

// ----------------------------------------------------------------- the verbs

interface CallOptions {
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}

const withSignal = (signal: AbortSignal | undefined): { signal?: AbortSignal } =>
  signal === undefined ? {} : { signal };

interface Verb {
  name: string;
  kind: MailKind;
  /** The result is one checked read data per stdout line. */
  many: boolean;
  /** The argv after `--config <config>` for `call(source)` with its defaults. */
  argv: string[];
  /** The `limit` of the default call; undefined when the verb has none. */
  limit: number | undefined;
  call: (source: MailSource, options?: CallOptions) => Promise<unknown>;
  /** A fixture whose first envelope is valid for this verb. */
  good: string;
  /** A fixture holding a valid envelope of another kind. */
  otherKind: string;
  /** The fields of the first envelope's data that `invalid data` mutations reach. */
  fields: readonly ("id" | "cursor" | "received_at")[];
  fieldPath: (field: string) => (string | number)[];
}

const NO_FILTERS = {};

const VERBS: Verb[] = [
  {
    name: "mailboxes",
    kind: "mailboxes",
    many: false,
    argv: ["mailboxes"],
    limit: undefined,
    call: (source, { signal } = {}) => source.mailboxes(signal),
    good: "real/mailboxes.json",
    otherKind: "real/list-20.json",
    fields: ["id"],
    fieldPath: (field) => ["items", 0, field],
  },
  {
    name: "list",
    kind: "list",
    many: false,
    argv: ["list", "--limit", "20", "--offset", "0"],
    limit: 20,
    call: (source, { limit = 20, signal } = {}) =>
      source.list({ limit, offset: 0, filters: NO_FILTERS, ...withSignal(signal) }),
    good: "real/list-20.json",
    otherKind: "real/mailboxes.json",
    fields: ["id", "cursor", "received_at"],
    fieldPath: (field) => ["items", 0, field],
  },
  {
    name: "read",
    kind: "read",
    many: false,
    argv: ["read", "Msg1", "--max-bytes", "4000"],
    limit: undefined,
    call: (source, { signal } = {}) =>
      source.read({ id: "Msg1", maxBytes: 4000, ...withSignal(signal) }),
    good: "real/read-Stm7N6wH5vLs.json",
    otherKind: "real/list-20.json",
    fields: ["id", "cursor", "received_at"],
    fieldPath: (field) => [field],
  },
  {
    name: "readAfter",
    kind: "read",
    many: true,
    argv: ["read", "--after", "1793120280000:Msg1", "--limit", "5", "--max-bytes", "4000"],
    limit: 5,
    call: (source, { limit = 5, signal } = {}) =>
      source.readAfter({
        after: "1793120280000:Msg1",
        limit,
        maxBytes: 4000,
        filters: NO_FILTERS,
        ...withSignal(signal),
      }),
    good: "real/read-StlqC78lBvpV.json",
    otherKind: "real/list-20.json",
    fields: ["id", "cursor", "received_at"],
    fieldPath: (field) => [field],
  },
  {
    name: "thread",
    kind: "thread",
    many: false,
    argv: ["thread", "Thr1", "--limit", "10"],
    limit: 10,
    call: (source, { limit = 10, signal } = {}) =>
      source.thread({ id: "Thr1", limit, ...withSignal(signal) }),
    good: "contract/thread.json",
    otherKind: "real/read-StlqC78lBvpV.json",
    fields: ["id", "cursor", "received_at"],
    // item 0 is `in_store: false` (an id only); item 1 carries a cursor and received_at
    fieldPath: (field) => ["items", field === "id" ? 0 : 1, field],
  },
];

function verbNamed(name: string): Verb {
  const verb = VERBS.find((candidate) => candidate.name === name);
  if (verb === undefined) {
    throw new Error(`no verb ${name}`);
  }
  return verb;
}

const goodText = (verb: Verb): string => fixtureText(verb.good);

/** The data a verb must return for a fixture. */
function expectedFor(verb: Verb, file: string): object {
  return verb.many ? loadReadPage(file) : loadData(verb.kind, file);
}

const firstEnvelope = (verb: Verb): Envelope => {
  const [envelope] = loadEnvelopes(verb.good);
  if (envelope === undefined) {
    throw new Error(`${verb.good}: no envelope`);
  }
  return envelope;
};

/** Runs `verb` over a fake playing `script`; the call resolves or rejects as the adapter does. */
function run(
  verb: Verb,
  script: Script,
  options?: CallOptions,
): { fake: Fake; result: Promise<unknown> } {
  const fake = fakeExec(script);
  return { fake, result: verb.call(sourceOver(fake), options) };
}

const CONTRACT = (what: string): string => `screwtape contract violation: ${what}`;
const RETRY = "screwtape output over 4 MiB; retry with limit 1";
const PLAIN = "screwtape output over 4 MiB";

// ------------------------------------------------------------------- argv

describe("argv", () => {
  it.each(VERBS)("$name: exact argv, --config first after the binary", async (verb) => {
    const { fake, result } = run(verb, { stdout: chunksOf(goodText(verb)) });
    await result;
    expect(fake.calls.map((call) => call.argv)).toEqual([[...PREFIX, ...verb.argv]]);
    const [call] = fake.calls;
    expect(call?.argv.slice(0, 3)).toEqual(PREFIX);
  });

  it("list: limit and offset as decimal strings, filters in order mailbox, unread, from", async () => {
    const fake = fakeExec({ stdout: chunksOf(fixtureText("real/list-20.json")) });
    await sourceOver(fake).list({
      limit: 7,
      offset: 30,
      filters: { from: "ada@example.com", unread: true, mailbox: "mbx1" },
    });
    expect(fake.calls[0]?.argv).toEqual([
      ...PREFIX,
      "list",
      "--limit",
      "7",
      "--offset",
      "30",
      "--mailbox",
      "mbx1",
      "--unread",
      "--from",
      "ada@example.com",
    ]);
  });

  it("list: unread false adds no flag; a lone from adds only --from", async () => {
    const fake = fakeExec({ stdout: chunksOf(fixtureText("real/list-20.json")) });
    await sourceOver(fake).list({ limit: 1, offset: 0, filters: { unread: false, from: "a@b" } });
    expect(fake.calls[0]?.argv).toEqual([
      ...PREFIX,
      "list",
      "--limit",
      "1",
      "--offset",
      "0",
      "--from",
      "a@b",
    ]);
  });

  it("readAfter: --since only when given, after --max-bytes and before the filters", async () => {
    const fake = fakeExec({});
    const source = sourceOver(fake);
    await source.readAfter({
      after: "",
      limit: 3,
      maxBytes: 100,
      since: "2026-10-01T00:00:00Z",
      filters: { mailbox: "mbx1", unread: true, from: "ada@example.com" },
    });
    await source.readAfter({ after: "5:x", limit: 3, maxBytes: 100, filters: {} });
    expect(fake.calls.map((call) => call.argv)).toEqual([
      [
        ...PREFIX,
        "read",
        "--after",
        "",
        "--limit",
        "3",
        "--max-bytes",
        "100",
        "--since",
        "2026-10-01T00:00:00Z",
        "--mailbox",
        "mbx1",
        "--unread",
        "--from",
        "ada@example.com",
      ],
      [...PREFIX, "read", "--after", "5:x", "--limit", "3", "--max-bytes", "100"],
    ]);
  });

  it("uses the configured binary and config paths", async () => {
    const fake = fakeExec({ stdout: chunksOf(fixtureText("real/mailboxes.json")) });
    await sourceOver(fake, { binary: "/x/bin", config: "/x/cfg" }).mailboxes();
    expect(fake.calls[0]?.argv.slice(0, 3)).toEqual(["/x/bin", "--config", "/x/cfg"]);
  });
});

// ---------------------------------------------------------- exec options

describe("exec options", () => {
  it.each(VERBS)("$name: timeout 10 s and no cwd", async (verb) => {
    const { fake, result } = run(verb, { stdout: chunksOf(goodText(verb)) });
    await result;
    expect(fake.calls[0]?.options?.timeout).toBe(10);
    expect(fake.calls[0]?.options?.cwd).toBeUndefined();
  });

  describe("negative control: an inherited environment fails (RV-015 F-13)", () => {
    it.each(VERBS)("$name: inheritEnv is false and env is exactly { HOME }", async (verb) => {
      const { fake, result } = run(verb, { stdout: chunksOf(goodText(verb)) });
      await result;
      const options = fake.calls[0]?.options;
      expect(options?.inheritEnv).toBe(false);
      expect(options?.env).toEqual({ HOME });
      expect(Object.keys(options?.env ?? {})).toEqual(["HOME"]);
    });
  });
});

// ------------------------------------------------------ exit 0: the result

describe("exit 0 returns the checked data", () => {
  const FIXTURES: Record<string, string[]> = {
    mailboxes: ["real/mailboxes.json", "contract/mailboxes.json"],
    list: ["real/list-20.json", "contract/list-offset.json", "contract/list-after.json"],
    read: ["real/read-StlqC78lBvpV.json", "real/read-Stm7N6wH5vLs.json", "contract/read.json"],
    readAfter: [
      "contract/read-after-empty.jsonl",
      "real/read-StlqC78lBvpV.json",
      "contract/read-after-2-lines.jsonl",
      "real/read-after-1.json",
      "real/read-after-2.json",
    ],
    thread: ["real/thread-Ar3hVBQKNIKV.json", "contract/thread.json"],
  };
  const cases = VERBS.flatMap((verb) =>
    (FIXTURES[verb.name] ?? []).map((file): [string, Verb, string] => [verb.name, verb, file]),
  );

  it.each(cases)("%s: %s", async (_name, verb, file) => {
    const { result } = run(verb, { stdout: chunksOf(fixtureText(file)) });
    await expect(result).resolves.toEqual(expectedFor(verb, file));
  });

  it("readAfter: zero lines resolve to an empty array, one line to a one-element array", async () => {
    const [verb] = VERBS.filter((v) => v.name === "readAfter");
    if (verb === undefined) {
      throw new Error("no readAfter verb");
    }
    await expect(run(verb, {}).result).resolves.toEqual([]);
    const one = await run(verb, { stdout: chunksOf(goodText(verb)) }).result;
    expect(one).toHaveLength(1);
  });

  it.each(VERBS)("$name: output split into small chunks gives the same result", async (verb) => {
    const text = goodText(verb);
    const pieces = text.match(/[\s\S]{1,97}/g) ?? [];
    const { result } = run(verb, { stdout: pieces });
    await expect(result).resolves.toEqual(expectedFor(verb, verb.good));
  });

  it.each(VERBS)("$name: stderr on exit 0 is ignored", async (verb) => {
    const { result } = run(verb, {
      stdout: chunksOf(goodText(verb)),
      stderr: `warning ${SENTINEL}\n`,
    });
    await expect(result).resolves.toEqual(expectedFor(verb, verb.good));
  });

  it.each(VERBS)("$name: extra top-level and nested fields are accepted", async (verb) => {
    const lines = loadEnvelopes(verb.good).map((envelope) =>
      line({ ...envelope, data: withExtraFields(envelope.data), x_top: { future: true } }),
    );
    const { result } = run(verb, { stdout: lines });
    await expect(result).resolves.toMatchObject(expectedFor(verb, verb.good));
  });
});

// --------------------------------------------------------- failed outcomes

describe("outcome mapping", () => {
  interface Outcome {
    name: string;
    stderr?: string;
    result: number | ExecutionError;
    failure: "usage" | "failed" | "timeout" | "spawn";
    message: string;
  }
  const USAGE = "screwtape usage error";
  const diagnostic = (fields: Record<string, unknown>): string =>
    `${JSON.stringify({ message: SENTINEL, ...fields })}\n`;

  const OUTCOMES: Outcome[] = [
    {
      name: "exit 2 with a valid code",
      stderr: diagnostic({ code: "bad_flag" }),
      result: 2,
      failure: "usage",
      message: `${USAGE}: bad_flag`,
    },
    {
      name: "exit 2 with a 64 character code",
      stderr: diagnostic({ code: "a".repeat(64) }),
      result: 2,
      failure: "usage",
      message: `${USAGE}: ${"a".repeat(64)}`,
    },
    {
      name: "exit 2, the code read from the first non-blank stderr line only",
      stderr: `\n\n${diagnostic({ code: "first_code" })}${diagnostic({ code: "second_code" })}`,
      result: 2,
      failure: "usage",
      message: `${USAGE}: first_code`,
    },
    {
      name: "exit 2 with an invalid code (Bad-Code)",
      stderr: diagnostic({ code: "Bad-Code" }),
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with a 65 character code",
      stderr: diagnostic({ code: "a".repeat(65) }),
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with an empty code",
      stderr: diagnostic({ code: "" }),
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with a code ending in a newline",
      stderr: diagnostic({ code: "bad_flag\n" }),
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with a code holding stderr text",
      stderr: diagnostic({ code: `bad_flag ${SENTINEL}` }),
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with a non-string code",
      stderr: diagnostic({ code: 7 }),
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with no code field",
      stderr: diagnostic({ error: "x" }),
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with plain-text stderr",
      stderr: `usage: ${SENTINEL}\n`,
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with a JSON array on stderr",
      stderr: `[{"code":"bad_flag"}] ${SENTINEL}\n`,
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 whose first non-blank line is not JSON, a valid code on the next",
      stderr: `${SENTINEL}\n${diagnostic({ code: "bad_flag" })}`,
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 2 with empty stderr",
      result: 2,
      failure: "usage",
      message: USAGE,
    },
    {
      name: "exit 1",
      stderr: diagnostic({ code: "boom" }),
      result: 1,
      failure: "failed",
      message: "screwtape failed (exit 1)",
    },
    {
      name: "exit 137",
      stderr: `killed ${SENTINEL}\n`,
      result: 137,
      failure: "failed",
      message: "screwtape failed (exit 137)",
    },
    {
      name: "exit 3 (unmapped)",
      stderr: diagnostic({ code: "bad_flag" }),
      result: 3,
      failure: "failed",
      message: "screwtape failed (exit 3)",
    },
    {
      name: "timeout",
      stderr: `slow ${SENTINEL}\n`,
      result: new ExecutionError("timeout", `timed out ${SENTINEL}`),
      failure: "timeout",
      message: "screwtape timed out after 10 s",
    },
    {
      name: "spawn_error",
      stderr: `nope ${SENTINEL}\n`,
      result: new ExecutionError("spawn_error", `ENOENT ${SENTINEL}`),
      failure: "spawn",
      message: "screwtape could not run",
    },
  ];

  const cases = VERBS.flatMap((verb) =>
    OUTCOMES.map((outcome): [string, string, Verb, Outcome] => [
      verb.name,
      outcome.name,
      verb,
      outcome,
    ]),
  );

  // Valid stdout accompanies every failure: no data may be returned with it.
  it.each(cases)("%s: %s", async (_name, _outcome, verb, outcome) => {
    const { result } = run(verb, {
      stdout: chunksOf(goodText(verb)),
      stderr: outcome.stderr,
      result: outcome.result,
    });
    const error = await failureOf(result);
    expect(error.failure).toBe(outcome.failure);
    expect(error.message).toBe(outcome.message);
  });

  describe("no fixture stderr text in any error", () => {
    it.each(cases)("%s: %s", async (_name, _outcome, verb, outcome) => {
      const { result } = run(verb, {
        stdout: chunksOf(goodText(verb)),
        stderr: outcome.stderr,
        result: outcome.result,
      });
      const error = await failureOf(result);
      expect(error.message).not.toContain(SENTINEL);
      expect(error.cause).toBeUndefined();
    });

    it.each(VERBS)(
      "$name: a contract violation carrying stderr text does not echo it",
      async (verb) => {
        const { result } = run(verb, { stdout: ["not json\n"], stderr: `${SENTINEL}\n` });
        const error = await failureOf(result);
        expect(error.message).toBe(CONTRACT("not JSON"));
        expect(error.message).not.toContain(SENTINEL);
      },
    );
  });

  describe("negative control: an unmapped exit fails, never resolves (RV-015 F-13)", () => {
    it.each(VERBS)("$name: exit 3 with valid stdout rejects", async (verb) => {
      const { result } = run(verb, { stdout: chunksOf(goodText(verb)), result: 3 });
      const error = await failureOf(result);
      expect(error.failure).toBe("failed");
    });
  });

  it("any other ExecutionError propagates as is", async () => {
    const error = new ExecutionError("unknown", "boom");
    const { result } = run(verbNamed("mailboxes"), { result: error });
    await expect(result).rejects.toBe(error);
  });
});

// ------------------------------------------------------------------- abort

describe("abort", () => {
  function* abortingStream(controller: AbortController, text: string): Generator<string> {
    yield text.slice(0, 40);
    controller.abort(new Error("caller gave up"));
    yield text.slice(40);
  }

  it.each(VERBS)(
    "$name: the caller's signal aborted mid-stream rejects with an error that is not a MailSourceError",
    async (verb) => {
      const controller = new AbortController();
      const { fake, result } = run(
        verb,
        { stdout: abortingStream(controller, goodText(verb)) },
        { signal: controller.signal },
      );
      const error = await result.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(fake.calls).toHaveLength(1);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MailSourceError);
    },
  );

  it.each(VERBS)(
    "$name: the caller's abort wins even when the child ignored it and exited 0",
    async (verb) => {
      const controller = new AbortController();
      const { fake, result } = run(
        verb,
        { stdout: abortingStream(controller, goodText(verb)), killable: false },
        { signal: controller.signal },
      );
      const error = await result.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(fake.calls).toHaveLength(1);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MailSourceError);
    },
  );
});

// ------------------------------------------------- fail closed: the contract

describe("contract violations fail closed", () => {
  const withEnvelope = (verb: Verb, change: Partial<Envelope>): string =>
    line({ ...firstEnvelope(verb), ...change });

  const INVALID_DATA: [string, "id" | "cursor" | "received_at", string][] = [
    ["an id with a space", "id", "bad id"],
    ["an id with a colon", "id", "a:b"],
    ["a non-canonical cursor (05:x)", "cursor", "05:x"],
    ["a received_at that is not RFC 3339", "received_at", "yesterday"],
    ["a received_at without the T", "received_at", "2026-10-27 16:58:00Z"],
  ];

  type Case = [name: string, what: string, stdout: string];

  const zeroEnvelopes = (verb: Verb): Case[] =>
    verb.many ? [] : [["wrong arity: zero envelopes", "wrong arity", ""]];

  const cases = (verb: Verb): Case[] => [
    ["not JSON", "not JSON", "not json\n"],
    ["a JSON array is not an object", "not JSON", "[1,2]\n"],
    ["a JSON number is not an object", "not JSON", "42\n"],
    ["JSON null is not an object", "not JSON", "null\n"],
    ["unsupported version (2)", "unsupported version", withEnvelope(verb, { version: 2 })],
    [
      "unsupported version (the string 1)",
      "unsupported version",
      withEnvelope(verb, { version: "1" }),
    ],
    ["wrong kind (another verb's envelope)", "wrong kind", fixtureText(verb.otherKind)],
    ["wrong kind (an unknown kind)", "wrong kind", withEnvelope(verb, { kind: "bogus" })],
    ...verb.fields.flatMap((field) =>
      INVALID_DATA.filter(([, f]) => f === field).map((entry): [string, string, string] => [
        `invalid data: ${entry[0]}`,
        "invalid data",
        line(setAt(firstEnvelope(verb), ["data", ...verb.fieldPath(field)], entry[2])),
      ]),
    ),
    ["invalid data: data is not an object", "invalid data", withEnvelope(verb, { data: "x" })],
    // readAfter prints 0 to limit envelopes, so zero is arity-valid there.
    ...zeroEnvelopes(verb),
    // one past the limit of the default call (limit 5), or a second envelope
    ["wrong arity: too many envelopes", "wrong arity", goodText(verb).repeat(verb.many ? 6 : 2)],
    ["unterminated line", "unterminated line", goodText(verb).trimEnd()],
    [
      "unterminated line: a partial line after a valid one",
      "unterminated line",
      `${goodText(verb)}{"version":1`,
    ],
  ];

  const all = VERBS.flatMap((verb) =>
    cases(verb).map((entry): [string, string, Verb, string, string] => [
      verb.name,
      entry[0],
      verb,
      entry[1],
      entry[2],
    ]),
  );

  it.each(all)("%s: %s", async (_name, _case, verb, what, stdout) => {
    const { result } = run(verb, { stdout: chunksOf(stdout) });
    const error = await failureOf(result);
    expect(error.failure).toBe("contract");
    expect(error.message).toBe(CONTRACT(what));
  });

  const readAfter = verbNamed("readAfter");

  it("readAfter: limit + 1 envelopes is wrong arity (limit 1 with 2, limit 2 with 3)", async () => {
    for (const limit of [1, 2]) {
      const stdout = chunksOf(goodText(readAfter).repeat(limit + 1));
      const error = await failureOf(run(readAfter, { stdout }, { limit }).result);
      expect(error.failure).toBe("contract");
      expect(error.message).toBe(CONTRACT("wrong arity"));
    }
  });

  it("readAfter: exactly limit envelopes is accepted", async () => {
    const stdout = chunksOf(goodText(readAfter).repeat(2));
    await expect(run(readAfter, { stdout }, { limit: 2 }).result).resolves.toHaveLength(2);
  });

  it("readAfter: a bad later line fails the whole call, no partial data", async () => {
    const stdout = chunksOf(goodText(readAfter) + goodText(readAfter) + "not json\n");
    const error = await failureOf(run(readAfter, { stdout }).result);
    expect(error.message).toBe(CONTRACT("not JSON"));
  });

  describe("the first failure wins", () => {
    it("version before kind", async () => {
      const stdout = chunksOf(withEnvelope(verbNamed("mailboxes"), { version: 2, kind: "bogus" }));
      const error = await failureOf(run(verbNamed("mailboxes"), { stdout }).result);
      expect(error.message).toBe(CONTRACT("unsupported version"));
    });

    it("kind before data", async () => {
      const stdout = chunksOf(withEnvelope(verbNamed("mailboxes"), { kind: "bogus", data: "x" }));
      const error = await failureOf(run(verbNamed("mailboxes"), { stdout }).result);
      expect(error.message).toBe(CONTRACT("wrong kind"));
    });

    it("an unterminated line before arity and content", async () => {
      const verb = verbNamed("mailboxes");
      const error = await failureOf(run(verb, { stdout: ["not json\nnot json"] }).result);
      expect(error.message).toBe(CONTRACT("unterminated line"));
    });

    it("arity before content: two lines of garbage are wrong arity for a single-envelope verb", async () => {
      const verb = verbNamed("mailboxes");
      const error = await failureOf(run(verb, { stdout: ["not json\nnot json\n"] }).result);
      expect(error.message).toBe(CONTRACT("wrong arity"));
    });

    it("readAfter: lines are checked in order", async () => {
      const stdout = [
        goodText(readAfter),
        withEnvelope(readAfter, { kind: "bogus" }),
        "not json\n",
      ];
      const error = await failureOf(run(readAfter, { stdout }).result);
      expect(error.message).toBe(CONTRACT("wrong kind"));
    });
  });
});

// ------------------------------------------------- bounded output (F-12, F-29)

describe("oversize output", () => {
  const CHUNK_BYTES = 64 * 1024;
  const OVER = MAIL_STDOUT_MAX + 4 * CHUNK_BYTES;

  interface Stream {
    chunks: Generator<string>;
    /** How many chunks the stream would play if it were never stopped. */
    count: number;
  }

  /** One valid line, then one line that never ends, played in 64 KiB chunks. */
  function oversizeLine(verb: Verb): Stream {
    const head = goodText(verb);
    const filler = "y".repeat(CHUNK_BYTES);
    const count = 2 + Math.ceil(OVER / CHUNK_BYTES);
    function* chunks(): Generator<string> {
      yield head;
      yield '{"version":1,"kind":"x","data":"';
      for (let sent = 0; sent < OVER; sent += CHUNK_BYTES) {
        yield filler;
      }
    }
    return { count, chunks: chunks() };
  }

  /** Many valid lines, each well under the per-line cap, totalling more than the ceiling. */
  function ceilingBreach(): Stream {
    const lineText = fixtureText("real/read-Stm7N6wH5vLs.json");
    const count = Math.ceil(OVER / Buffer.byteLength(lineText));
    function* chunks(): Generator<string> {
      for (let n = 0; n < count; n += 1) {
        yield lineText;
      }
    }
    return { count, chunks: chunks() };
  }

  const expectedMessage = (limit: number | undefined): string =>
    limit !== undefined && limit > 1 ? RETRY : PLAIN;

  const SHAPES: [string, (verb: Verb) => Stream][] = [
    ["an oversize line after valid ones", oversizeLine],
    ["a ceiling breach by many valid lines", ceilingBreach],
  ];

  describe("negative control: an oversize line or a ceiling breach returns no partial data (RV-015 F-12)", () => {
    const cases = VERBS.flatMap((verb) =>
      SHAPES.map((shape): [string, string, Verb, (verb: Verb) => Stream] => [
        verb.name,
        shape[0],
        verb,
        shape[1],
      ]),
    );

    it.each(cases)(
      "%s: %s fails oversize and stops the child",
      async (_name, _shape, verb, make) => {
        const stream = make(verb);
        const limit = 5;
        const { fake, result } = run(verb, { stdout: stream.chunks }, { limit });
        const error = await failureOf(result);
        expect(error.failure).toBe("oversize");
        expect(error.message).toBe(expectedMessage(verb.limit === undefined ? undefined : limit));
        expect(fake.stopped()).toBe(true);
        expect(fake.emitted()).toBeLessThan(stream.count);
      },
    );

    it.each(cases)(
      "%s: %s fails oversize even when the child ignores the kill (exit 0)",
      async (_name, _shape, verb, make) => {
        const { result } = run(verb, { stdout: make(verb).chunks, killable: false });
        const error = await failureOf(result);
        expect(error.failure).toBe("oversize");
      },
    );

    it.each(cases)(
      "%s: %s fails oversize even when the child ignores the kill (exit 1)",
      async (_name, _shape, verb, make) => {
        const { result } = run(verb, { stdout: make(verb).chunks, killable: false, result: 1 });
        const error = await failureOf(result);
        expect(error.failure).toBe("oversize");
      },
    );
  });

  describe("the ceiling message names the limit 1 retry only above limit 1 (RV-015 F-29)", () => {
    type Row = [name: string, verb: Verb, limit: number | undefined, message: string];
    const rows = (verb: Verb): Row[] =>
      verb.limit === undefined
        ? [[`${verb.name} (no limit)`, verb, undefined, PLAIN]]
        : [
            [`${verb.name} limit 5`, verb, 5, RETRY],
            [`${verb.name} limit 2`, verb, 2, RETRY],
            [`${verb.name} limit 1`, verb, 1, PLAIN],
          ];
    const cases = VERBS.flatMap(rows);

    it.each(cases)("%s", async (_name, verb, limit, message) => {
      const { result } = run(verb, { stdout: ceilingBreach().chunks }, { limit });
      const error = await failureOf(result);
      expect(error.failure).toBe("oversize");
      expect(error.message).toBe(message);
    });
  });
});
