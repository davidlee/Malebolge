// The five mail tools, driven through their `execute` over a fake MailSource
// (PHASE-07 VT-1..3). "Refused before argv" is observable as the fake having
// recorded no call. Time is fixed: held back is judged against NOW.

import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import { type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { isRecord } from "../../src/json.ts";
import { classificationCache } from "../../src/mail/classifications.ts";
import { mailRefusal } from "../../src/mail/extension.ts";
import { type ReportKind, type Withheld, WITHHOLD_POLICY } from "../../src/mail/policy.ts";
import { JEV_MAX_BYTES } from "../../src/mail/project.ts";
import { shareOf } from "../../src/mail/render.ts";
import {
  type Address,
  type Classification,
  MailSourceError,
  type ReadData,
} from "../../src/mail/source.ts";
import {
  type MailDeps,
  MAIL_DESCRIPTION_SUFFIX,
  MAIL_ERROR_PREFIX,
  mailTools,
  NEW_JOINT_BYTES,
  NEW_MAX_BYTES,
  OVERSIZE_AT_LIMIT_1,
} from "../../src/mail/tools.ts";
import {
  absentThreadItem,
  addressesOf,
  attachmentOf,
  bodyPartOf,
  bytesOf,
  classificationOf,
  classifyAll,
  dataLinesOf,
  type FakeMailSource,
  type FakeReplies,
  fakeMailDeps,
  fakeMailSource,
  headerLinesOf,
  inStoreThreadItem,
  mailboxOf,
  OPEN_TAG,
  parseLine,
  readOf,
  type RecordedCall,
  summaryOf,
} from "./mail-fixtures.ts";

// ------------------------------------------------------------------ driving

const NOW = Date.parse("2026-10-28T09:00:00Z");
const MINUTE = 60_000;

/** An RFC 3339 time `minutes` from NOW. */
const at = (minutes: number): string => new Date(NOW + minutes * MINUTE).toISOString();

type ToolName = "mail_new" | "mail_read" | "mail_thread" | "mail_list" | "mail_mailboxes";

interface Outcome {
  readonly text: string;
  readonly isError: boolean;
}

/** The tools execute never reads the api; a stub stands in for the one it is given. */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a stub of the one field a mail tool could read
const API = { env: undefined } as unknown as ToolExecutionApi;

function toolNamed(tools: readonly ToolRegistration[], name: ToolName): ToolRegistration {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return tool;
}

/** Run one tool over `source` at NOW; `deps` overrides the rest; rejects when the tool throws. */
async function run(
  source: FakeMailSource,
  name: ToolName,
  args: Record<string, unknown>,
  ctx: Context = context,
  deps: Partial<MailDeps> = {},
): Promise<Outcome> {
  const tool = toolNamed(mailTools(fakeMailDeps({ source, now: () => NOW, ...deps })), name);
  const result = await tool.execute(args, API, ctx);
  const [first, ...rest] = result.output ?? [];
  if (first?.type !== "text" || rest.length > 0) {
    throw new Error("expected exactly one text output");
  }
  return { text: first.text, isError: result.isError === true };
}

function idsOfReadAfter(replies: FakeReplies): string[] {
  const page = replies.readAfter;
  return Array.isArray(page) ? page.map((read) => read.id) : [];
}

function idsOfRead(replies: FakeReplies): string[] {
  const read = replies.read;
  return read === undefined || read instanceof Error ? [] : [read.id];
}

function idsOfThread(replies: FakeReplies): string[] {
  const thread = replies.thread;
  if (thread === undefined || thread instanceof Error) {
    return [];
  }
  return thread.items.flatMap((item) => (item.in_store ? [item.id] : []));
}

function idsOfList(replies: FakeReplies): string[] {
  const list = replies.list;
  if (list === undefined || list instanceof Error) {
    return [];
  }
  return list.items.map((item) => item.id);
}

/** The ids the tool's read reaches for these replies: the page's, in-store only for a thread. */
function itemIdsOf(name: ToolName, replies: FakeReplies): string[] {
  switch (name) {
    case "mail_new":
      return idsOfReadAfter(replies);
    case "mail_read":
      return idsOfRead(replies);
    case "mail_thread":
      return idsOfThread(replies);
    case "mail_list":
      return idsOfList(replies);
    case "mail_mailboxes":
      return [];
  }
}

/** `replies` with a benign classification for every id the tool's read reaches (SL-007 PHASE-05). */
function withClassify(name: ToolName, replies: FakeReplies): FakeReplies {
  const classify = replies.classify;
  if (classify !== undefined) {
    return replies;
  }
  return { ...replies, classify: classifyAll(itemIdsOf(name, replies)) };
}

/** mail_new's joint bound at `limit`, built from the exported constants and never typed. */
const jointBound = (limit: number): number => Math.floor(NEW_JOINT_BYTES / limit) - JEV_MAX_BYTES;

/** Run one tool over a fake answering `replies`; returns the outcome and the fake. */
async function runWith(
  replies: FakeReplies,
  name: ToolName,
  args: Record<string, unknown>,
  deps: Partial<MailDeps> = {},
): Promise<{ outcome: Outcome; source: FakeMailSource }> {
  const source = fakeMailSource(withClassify(name, replies));
  return { outcome: await run(source, name, args, context, deps), source };
}

/** Every call that is not a classify: the tool's one read. */
function readCallsOf(source: FakeMailSource): RecordedCall[] {
  return source.calls.filter((call) => call.verb !== "classify");
}

/** The classify calls: at most one per tool call (SL-007 PHASE-05, § One tool call). */
function classifyCallsOf(source: FakeMailSource): RecordedCall[] {
  return source.calls.filter((call) => call.verb === "classify");
}

/** The query of the only read call, without its signal: one read, and at most one classify. */
function onlyQuery(source: FakeMailSource): object | undefined {
  const reads = readCallsOf(source);
  expect(reads).toHaveLength(1);
  expect(classifyCallsOf(source).length).toBeLessThanOrEqual(1);
  return reads[0]?.query;
}

/** The one classify call, when there is one, and its ids exactly: none only for an empty page. */
function expectClassified(source: FakeMailSource, ids: readonly string[]): void {
  const calls = classifyCallsOf(source);
  expect(calls.length).toBeLessThanOrEqual(1);
  if (calls.length === 0) {
    expect(ids).toEqual([]);
    return;
  }
  expect(calls[0]?.query).toMatchObject({ ids });
}

// ----------------------------------------------------------------- readers

const headerLine = (text: string, prefix: string): string | undefined =>
  headerLinesOf(text).find((line) => line.startsWith(prefix));

/** The header's `next:` value, parsed from its JSON string; undefined when absent. */
function nextOf(text: string): unknown {
  const line = headerLine(text, "next: ");
  return line === undefined ? undefined : JSON.parse(line.slice("next: ".length));
}

const caughtUpOf = (text: string): string | undefined =>
  headerLine(text, "caught_up: ")?.slice("caught_up: ".length);

/** The `N held back` count on the first header line; undefined when the line has none. */
function heldBackCount(text: string): number | undefined {
  const match = /, (\d+) held back$/.exec(headerLinesOf(text)[0] ?? "");
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The items line, the header's first: `mail_list: 3 items, 0 with cuts, 1 withheld`. */
const itemsLineOf = (text: string): string => headerLinesOf(text)[0] ?? "";

/** The header's clamps line (`limit clamped to 20; max_bytes clamped to 2048`). */
const clampsOf = (text: string): string | undefined =>
  headerLinesOf(text).find((line) => line.includes(" clamped to "));

const itemsOf = (text: string): Record<string, unknown>[] => dataLinesOf(text).map(parseLine);

function expectRefused(outcome: Outcome, message: string, source: FakeMailSource): void {
  expect(outcome.isError).toBe(true);
  expect(outcome.text).toBe(MAIL_ERROR_PREFIX + message);
  expect(source.calls).toHaveLength(0);
}

// ---------------------------------------------------------------- builders

/** A read envelope whose cursor agrees with its received_at, as screwtape's do. */
function arrival(n: number, minutesFromNow: number, overrides: Partial<ReadData> = {}): ReadData {
  const receivedAt = at(minutesFromNow);
  return readOf({
    id: `M${String(n)}`,
    thread_id: `T${String(n)}`,
    received_at: receivedAt,
    cursor: `${String(Date.parse(receivedAt))}:M${String(n)}`,
    ...overrides,
  });
}

/** A page whose n-th message arrived at the n-th of `minutes` from NOW (ahead of NOW is held back). */
const pageAt = (...minutes: number[]): ReadData[] => minutes.map((m, n) => arrival(n, m));

const PAST = -60;
const AHEAD = 11;

const listReply = (items = [summaryOf()]): Pick<FakeReplies, "list"> => ({
  list: { limit: 20, offset: 0, items },
});
const threadReply = (
  total = 1,
  truncated = false,
  items = [inStoreThreadItem()],
): Pick<FakeReplies, "thread"> => ({
  thread: { id: "Thr1", total, truncated, items },
});

// ============================================================ VT-1: inputs

describe("VT-1 mail tools refuse bad input before any port call", () => {
  const ID_MESSAGE = (tool: string, param: string): string =>
    `${tool}: ${param} must be a mail id ([A-Za-z0-9_-], 1 to 255 characters)`;
  const FROM_MESSAGE = (tool: string): string =>
    `${tool}: from must be at most 256 bytes, with no control characters and no leading "-"`;
  const AFTER_MESSAGE = 'mail_new: after must be "" or a cursor from a previous next';

  describe("an id that is not a JMAP Id", () => {
    const BAD_IDS = ["--after", "-x", "", "a".repeat(256), "a b", "a:b", "é"];

    for (const tool of ["mail_read", "mail_thread"] as const) {
      it.each(BAD_IDS)(`${tool} refuses id %j (VT-1: an id --after)`, async (id) => {
        const source = fakeMailSource(tool === "mail_read" ? { read: readOf() } : threadReply());
        const outcome = await run(source, tool, { id });
        expectRefused(outcome, ID_MESSAGE(tool, "id"), source);
        if (id !== "") {
          expect(outcome.text).not.toContain(id);
        }
      });
    }

    for (const tool of ["mail_new", "mail_list"] as const) {
      it.each(["--after", "-x", "", "a".repeat(256)])(
        `${tool} refuses mailbox %j`,
        async (mailbox) => {
          const source = fakeMailSource({ ...listReply(), readAfter: [] });
          const outcome = await run(source, tool, { after: "", mailbox });
          expectRefused(outcome, ID_MESSAGE(tool, "mailbox"), source);
        },
      );
    }

    it("accepts an id of 255 characters and one with _ and - inside", async () => {
      const { source } = await runWith({ read: readOf() }, "mail_read", {
        id: `${"a".repeat(250)}_-b9`,
      });
      expect(readCallsOf(source).map(({ verb }) => verb)).toEqual(["read"]);
      expect(classifyCallsOf(source).length).toBeLessThanOrEqual(1);
      expect(onlyQuery(source)).toMatchObject({ id: `${"a".repeat(250)}_-b9` });
    });
  });

  describe("from", () => {
    const BAD_FROM = [
      ["a leading -", "-rf"],
      ["a lone -", "-"],
      ["257 bytes", "a".repeat(257)],
      ["258 bytes of 129 two-byte characters", "é".repeat(129)],
      ["a NUL", "a\u0000b"],
      ["a newline", "a\nb"],
      ["a DEL", "a\u007fb"],
      ["a C1 control", "a\u0085b"],
    ] as const;

    for (const tool of ["mail_new", "mail_list"] as const) {
      it.each(BAD_FROM)(`${tool} refuses from with %s`, async (_label, from) => {
        const source = fakeMailSource({ ...listReply(), readAfter: [] });
        const outcome = await run(source, tool, { after: "", from });
        // The exact fixed message proves the value is not echoed (a lone "-" is in it).
        expectRefused(outcome, FROM_MESSAGE(tool), source);
      });
    }

    it.each([
      ["256 bytes", "a".repeat(256)],
      ["256 bytes of 128 two-byte characters (bytes, not characters)", "é".repeat(128)],
      ["a - that is not leading", "a-b@example.com"],
      ["a space and a non-ASCII name", "Zoë Smith"],
    ])("accepts from of %s and passes it through", async (_label, from) => {
      const { source } = await runWith({ readAfter: [] }, "mail_new", { after: "", from });
      expect(onlyQuery(source)).toMatchObject({ filters: { from } });
    });
  });

  describe("after and since on mail_new", () => {
    const BAD_AFTER = [
      "+5:x",
      "05:x",
      "-0:x",
      "9223372036854775808:x",
      "-9223372036854775809:x",
      "5:",
      ":x",
      "5:a:b",
      "5:-bad id",
      "abc",
      "--after",
      "5",
    ];

    it.each(BAD_AFTER)("refuses after %j (VT-1: non-canonical cursors)", async (after) => {
      const source = fakeMailSource({ readAfter: [] });
      const outcome = await run(source, "mail_new", { after });
      expectRefused(outcome, AFTER_MESSAGE, source);
      expect(outcome.text).not.toContain(after);
    });

    it.each([
      "",
      "1793120280000:Msg1",
      "0:x",
      "-5:x",
      "9223372036854775807:x",
      "-9223372036854775808:x",
    ])("accepts after %j and passes it to the port unchanged", async (after) => {
      const { source } = await runWith({ readAfter: [] }, "mail_new", { after });
      expect(onlyQuery(source)).toMatchObject({ after });
    });

    it("refuses since with a non-empty after (VT-1: since with a non-empty after)", async () => {
      const source = fakeMailSource({ readAfter: [] });
      const outcome = await run(source, "mail_new", {
        after: "1793120280000:Msg1",
        since: "2026-10-27",
      });
      expectRefused(outcome, 'mail_new: since is only allowed with after ""', source);
    });

    // Screwtape's --since is a calendar date, read as midnight UTC (its README).
    it.each([
      "yesterday",
      "2026-10-27T00:00:00Z",
      "2026-13-01",
      "2026-02-30",
      "26-10-27",
      "2026-1-27",
      "",
      20261027,
    ])("refuses since %j that is not a YYYY-MM-DD date", async (since) => {
      const source = fakeMailSource({ readAfter: [] });
      const outcome = await run(source, "mail_new", { after: "", since });
      expectRefused(outcome, "mail_new: since must be a date, YYYY-MM-DD", source);
    });

    it.each(["2026-10-27", "2024-02-29"])(
      'passes since %j with after "" to the port',
      async (since) => {
        const { source } = await runWith({ readAfter: [] }, "mail_new", { after: "", since });
        expect(onlyQuery(source)).toMatchObject({ after: "", since });
      },
    );
  });

  describe("what the port receives", () => {
    it("mail_new carries only the filters and the since that were given", async () => {
      const bare = await runWith({ readAfter: [] }, "mail_new", { after: "" });
      expect(onlyQuery(bare.source)).toStrictEqual({
        after: "",
        limit: 10,
        maxBytes: jointBound(10),
        filters: {},
      });
      const full = await runWith({ readAfter: [] }, "mail_new", {
        after: "",
        since: "2026-10-27",
        limit: 5,
        max_bytes: 2048,
        mailbox: "mbx1",
        unread: true,
        from: "bob@example.com",
      });
      expect(onlyQuery(full.source)).toStrictEqual({
        after: "",
        since: "2026-10-27",
        limit: 5,
        maxBytes: 2048,
        filters: { mailbox: "mbx1", unread: true, from: "bob@example.com" },
      });
    });

    it("mail_list carries limit, offset and the filters that were given", async () => {
      const bare = await runWith(listReply(), "mail_list", {});
      expect(onlyQuery(bare.source)).toStrictEqual({ limit: 20, offset: 0, filters: {} });
      const full = await runWith(listReply(), "mail_list", {
        limit: 7,
        offset: 30,
        mailbox: "mbx1",
        from: "bob",
      });
      expect(onlyQuery(full.source)).toStrictEqual({
        limit: 7,
        offset: 30,
        filters: { mailbox: "mbx1", from: "bob" },
      });
    });

    it("mail_read and mail_thread carry id and the bounds", async () => {
      const read = await runWith({ read: readOf() }, "mail_read", { id: "Msg1" });
      expect(onlyQuery(read.source)).toStrictEqual({ id: "Msg1", maxBytes: 16384 });
      const thread = await runWith(threadReply(), "mail_thread", { id: "Thr1" });
      expect(onlyQuery(thread.source)).toStrictEqual({ id: "Thr1", limit: 20 });
    });

    it("mail_mailboxes asks the port once, with no arguments", async () => {
      const { source } = await runWith({ mailboxes: { items: [] } }, "mail_mailboxes", {});
      expect(source.calls.map(({ verb }) => verb)).toEqual(["mailboxes"]);
    });

    it("every tool hands the context's abort signal to the port", async () => {
      const controller = new AbortController();
      const ctx = withAbortSignal(controller.signal, context);
      const runs: [ToolName, Record<string, unknown>][] = [
        ["mail_new", { after: "" }],
        ["mail_read", { id: "Msg1" }],
        ["mail_thread", { id: "Thr1" }],
        ["mail_list", {}],
        ["mail_mailboxes", {}],
      ];
      const replies: FakeReplies = {
        readAfter: [],
        read: readOf(),
        ...threadReply(),
        ...listReply(),
        mailboxes: { items: [] },
      };
      for (const [name, args] of runs) {
        const source = fakeMailSource(withClassify(name, replies));
        await run(source, name, args, ctx);
        expect(readCallsOf(source)).toHaveLength(1);
        expect(classifyCallsOf(source).length).toBeLessThanOrEqual(1);
        expect(readCallsOf(source)[0]?.signal).toBe(controller.signal);
      }
    });
  });

  describe("clamps are reported in the header and the clamped value reaches the port", () => {
    interface Case {
      readonly tool: ToolName;
      readonly args: Record<string, unknown>;
      /** The header's clamps line; undefined when nothing is reported. */
      readonly header: string | undefined;
      readonly query: object;
    }

    const NEW_OF = (limit: number, maxBytes: number): object => ({
      after: "",
      limit,
      maxBytes,
      filters: {},
    });
    const CASES: [string, Case][] = [
      [
        "mail_new limit above 20",
        {
          tool: "mail_new",
          args: { after: "", limit: 21, max_bytes: jointBound(20) },
          header: "limit clamped to 20",
          query: NEW_OF(20, jointBound(20)),
        },
      ],
      [
        "mail_new limit below 1",
        {
          tool: "mail_new",
          args: { after: "", limit: 0, max_bytes: 4096 },
          header: "limit clamped to 1",
          query: NEW_OF(1, 4096),
        },
      ],
      [
        "mail_new max_bytes above 8192 (limit 1 leaves the joint bound above it)",
        {
          tool: "mail_new",
          args: { after: "", limit: 1, max_bytes: 9000 },
          header: "max_bytes clamped to 8192",
          query: NEW_OF(1, 8192),
        },
      ],
      [
        "mail_new max_bytes below 512",
        {
          tool: "mail_new",
          args: { after: "", limit: 20, max_bytes: 100 },
          header: "max_bytes clamped to 512",
          query: NEW_OF(20, 512),
        },
      ],
      [
        "mail_new joint clamp: limit 10 lowers max_bytes 8192 to the joint bound",
        {
          tool: "mail_new",
          args: { after: "", limit: 10, max_bytes: 8192 },
          header: `max_bytes clamped to ${String(jointBound(10))}`,
          query: NEW_OF(10, jointBound(10)),
        },
      ],
      [
        "mail_new joint clamp at limit 20 lowers the DEFAULT max_bytes to the joint bound, reported",
        {
          tool: "mail_new",
          args: { after: "", limit: 20 },
          header: `max_bytes clamped to ${String(jointBound(20))}`,
          query: NEW_OF(20, jointBound(20)),
        },
      ],
      [
        "mail_new limit and max_bytes both clamped: limit first, one entry per name",
        {
          tool: "mail_new",
          args: { after: "", limit: 100, max_bytes: 8000 },
          header: `limit clamped to 20; max_bytes clamped to ${String(jointBound(20))}`,
          query: NEW_OF(20, jointBound(20)),
        },
      ],
      [
        "mail_new limit below 1 and max_bytes above 8192: both clamped",
        {
          tool: "mail_new",
          args: { after: "", limit: 0, max_bytes: 9000 },
          header: "limit clamped to 1; max_bytes clamped to 8192",
          query: NEW_OF(1, 8192),
        },
      ],
      [
        "mail_read max_bytes above 32768",
        {
          tool: "mail_read",
          args: { id: "Msg1", max_bytes: 99999 },
          header: "max_bytes clamped to 32768",
          query: { id: "Msg1", maxBytes: 32768 },
        },
      ],
      [
        "mail_read max_bytes below 1024",
        {
          tool: "mail_read",
          args: { id: "Msg1", max_bytes: 10 },
          header: "max_bytes clamped to 1024",
          query: { id: "Msg1", maxBytes: 1024 },
        },
      ],
      [
        "mail_thread limit above 40",
        {
          tool: "mail_thread",
          args: { id: "Thr1", limit: 41 },
          header: "limit clamped to 40",
          query: { id: "Thr1", limit: 40 },
        },
      ],
      [
        "mail_thread limit below 1",
        {
          tool: "mail_thread",
          args: { id: "Thr1", limit: -3 },
          header: "limit clamped to 1",
          query: { id: "Thr1", limit: 1 },
        },
      ],
      [
        "mail_list limit above 40",
        {
          tool: "mail_list",
          args: { limit: 500 },
          header: "limit clamped to 40",
          query: { limit: 40, offset: 0, filters: {} },
        },
      ],
      [
        "mail_list offset below 0",
        {
          tool: "mail_list",
          args: { offset: -1 },
          header: "offset clamped to 0",
          query: { limit: 20, offset: 0, filters: {} },
        },
      ],
      [
        "mail_list offset above 10000",
        {
          tool: "mail_list",
          args: { offset: 10001 },
          header: "offset clamped to 10000",
          query: { limit: 20, offset: 10000, filters: {} },
        },
      ],
      [
        "mail_list limit and offset: limit first",
        {
          tool: "mail_list",
          args: { limit: 0, offset: 99999 },
          header: "limit clamped to 1; offset clamped to 10000",
          query: { limit: 1, offset: 10000, filters: {} },
        },
      ],
    ];
    const REPLIES: FakeReplies = {
      readAfter: [],
      read: readOf(),
      ...threadReply(),
      ...listReply(),
    };

    it.each(CASES)("%s", async (_label, { tool, args, header, query }) => {
      const { outcome, source } = await runWith(REPLIES, tool, args);
      expect(outcome.isError).toBe(false);
      expect(clampsOf(outcome.text)).toBe(header);
      expect(onlyQuery(source)).toStrictEqual(query);
    });

    it.each([
      [
        "mail_new at limit 10 and the joint bound",
        "mail_new",
        { after: "", limit: 10, max_bytes: jointBound(10) },
      ],
      [
        "mail_new at limit 20 and the joint bound",
        "mail_new",
        { after: "", limit: 20, max_bytes: jointBound(20) },
      ],
      [
        "mail_new at limit 5 and the joint bound",
        "mail_new",
        { after: "", limit: 5, max_bytes: jointBound(5) },
      ],
      [
        "mail_new at the bounds limit 1 and max_bytes 512",
        "mail_new",
        { after: "", limit: 1, max_bytes: 512 },
      ],
      ["mail_read at the default", "mail_read", { id: "Msg1" }],
      ["mail_read at its bounds", "mail_read", { id: "Msg1", max_bytes: 1024 }],
      ["mail_thread at the default", "mail_thread", { id: "Thr1" }],
      ["mail_thread at limit 40", "mail_thread", { id: "Thr1", limit: 40 }],
      ["mail_list at the defaults", "mail_list", {}],
      ["mail_list at limit 40, offset 10000", "mail_list", { limit: 40, offset: 10000 }],
    ] as const)(
      "reports nothing for %s (defaults and in-range values are not clamps)",
      async (_label, tool, args) => {
        const { outcome } = await runWith(REPLIES, tool, args);
        expect(clampsOf(outcome.text)).toBeUndefined();
      },
    );
  });
});

// ============================================================= VT-2: cursor

describe("VT-2 the cursor: next, caught_up, held back", () => {
  const CURSOR_AFTER = "1793120280000:Msg1";

  describe("next and caught_up", () => {
    it.each(["", CURSOR_AFTER])(
      "next on an empty page equals after %j, caught_up is true, no items",
      async (after) => {
        const { outcome } = await runWith({ readAfter: [] }, "mail_new", { after });
        expect(nextOf(outcome.text)).toBe(after);
        expect(caughtUpOf(outcome.text)).toBe("true");
        expect(heldBackCount(outcome.text)).toBe(0);
        expect(itemsOf(outcome.text)).toEqual([]);
      },
    );

    it("a full page: next is the last item's cursor and caught_up is false", async () => {
      const page = pageAt(PAST - 2, PAST - 1, PAST);
      const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "", limit: 3 });
      expect(nextOf(outcome.text)).toBe(page[2]?.cursor);
      expect(caughtUpOf(outcome.text)).toBe("false");
      expect(heldBackCount(outcome.text)).toBe(0);
      expect(itemsOf(outcome.text).map((item) => item["id"])).toEqual(["M0", "M1", "M2"]);
      expect(itemsOf(outcome.text).some((item) => "held_back" in item)).toBe(false);
    });

    it("a short page: next is the last item's cursor and caught_up is true", async () => {
      const page = pageAt(PAST - 1, PAST);
      const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "", limit: 3 });
      expect(nextOf(outcome.text)).toBe(page[1]?.cursor);
      expect(caughtUpOf(outcome.text)).toBe("true");
    });

    it("limit is the clamped one: a page of 20 at a requested limit of 99 is full, not short", async () => {
      const page = Array.from({ length: 20 }, (_, n) => arrival(n, PAST + n * 0.5));
      const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "", limit: 99 });
      expect(caughtUpOf(outcome.text)).toBe("false");
    });

    it("the header always carries a held back count for mail_new, 0 included", async () => {
      const { outcome } = await runWith({ readAfter: pageAt(PAST) }, "mail_new", { after: "" });
      expect(headerLinesOf(outcome.text)[0]).toBe("mail_new: 1 items, 0 with cuts, 0 held back");
    });
  });

  describe("held back", () => {
    it("first: next stays at after (not the first cursor), caught_up is true on a full page, the count is 1", async () => {
      const page = pageAt(AHEAD, PAST, PAST);
      const { outcome } = await runWith({ readAfter: page }, "mail_new", {
        after: CURSOR_AFTER,
        limit: 3,
      });
      expect(nextOf(outcome.text)).toBe(CURSOR_AFTER);
      expect(caughtUpOf(outcome.text)).toBe("true");
      expect(heldBackCount(outcome.text)).toBe(1);
      const items = itemsOf(outcome.text);
      expect(items.map((item) => item["held_back"])).toEqual([true, undefined, undefined]);
    });

    it('first, from the start: next is "" (defined), not absent', async () => {
      const { outcome } = await runWith({ readAfter: pageAt(AHEAD) }, "mail_new", { after: "" });
      expect(nextOf(outcome.text)).toBe("");
      expect(headerLine(outcome.text, "next: ")).toBe('next: ""');
    });

    it("k-th: next is the cursor just before it, not the last item's; later items still shown", async () => {
      const page = pageAt(PAST - 1, PAST, AHEAD, PAST);
      const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "", limit: 4 });
      expect(nextOf(outcome.text)).toBe(page[1]?.cursor);
      expect(caughtUpOf(outcome.text)).toBe("true");
      expect(heldBackCount(outcome.text)).toBe(1);
      const items = itemsOf(outcome.text);
      expect(items.map((item) => item["id"])).toEqual(["M0", "M1", "M2", "M3"]);
      expect(items.map((item) => item["held_back"])).toEqual([
        undefined,
        undefined,
        true,
        undefined,
      ]);
    });

    it("k-th on a short page: still stops before it", async () => {
      const page = pageAt(PAST, AHEAD);
      const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "", limit: 10 });
      expect(nextOf(outcome.text)).toBe(page[0]?.cursor);
      expect(caughtUpOf(outcome.text)).toBe("true");
    });

    it("several: next stops before the FIRST held-back message; the count is all of them", async () => {
      const page = pageAt(PAST, AHEAD, PAST, AHEAD + 5);
      const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "", limit: 4 });
      expect(nextOf(outcome.text)).toBe(page[0]?.cursor);
      expect(heldBackCount(outcome.text)).toBe(2);
      expect(itemsOf(outcome.text).map((item) => item["held_back"])).toEqual([
        undefined,
        true,
        undefined,
        true,
      ]);
    });

    it("all: next is after, caught_up is true, every item carries held_back, the count is N", async () => {
      const page = pageAt(AHEAD, AHEAD + 1, AHEAD + 2);
      const { outcome } = await runWith({ readAfter: page }, "mail_new", {
        after: CURSOR_AFTER,
        limit: 3,
      });
      expect(nextOf(outcome.text)).toBe(CURSOR_AFTER);
      expect(caughtUpOf(outcome.text)).toBe("true");
      expect(heldBackCount(outcome.text)).toBe(3);
      expect(headerLinesOf(outcome.text)[0]).toBe("mail_new: 3 items, 0 with cuts, 3 held back");
      expect(itemsOf(outcome.text).map((item) => item["held_back"])).toEqual([true, true, true]);
    });

    it("held back with cut fields: the item is still held_back, named cut, and next stops before it", async () => {
      const big = arrival(1, AHEAD, {
        to: addressesOf(40, 60),
        cc: addressesOf(40, 60),
        bcc: addressesOf(40, 60),
        bodies: [bodyPartOf({ text: "x".repeat(8000) })],
      });
      const page = [arrival(0, PAST), big];
      const { outcome } = await runWith({ readAfter: page }, "mail_new", {
        after: "",
        // Limit 20's share (2456 bytes) cannot hold the 8000-byte body.
        limit: 20,
      });
      const [, heldItem] = itemsOf(outcome.text);
      expect(heldItem?.["held_back"]).toBe(true);
      expect(heldItem?.["cut"]).toContain("body");
      expect(heldBackCount(outcome.text)).toBe(1);
      expect(headerLinesOf(outcome.text)[0]).toBe("mail_new: 2 items, 1 with cuts, 1 held back");
      expect(nextOf(outcome.text)).toBe(page[0]?.cursor);
    });

    describe("the rule reads received_at on the validated envelope, never the cursor, never a string", () => {
      it("exactly now + 10 minutes is not held back; a second later is", async () => {
        const edge = await runWith({ readAfter: pageAt(10) }, "mail_new", { after: "" });
        expect(heldBackCount(edge.outcome.text)).toBe(0);
        const over = arrival(0, 10, {
          received_at: new Date(NOW + 10 * MINUTE + 1000).toISOString(),
        });
        const past = await runWith({ readAfter: [over] }, "mail_new", { after: "" });
        expect(heldBackCount(past.outcome.text)).toBe(1);
      });

      it("a cursor far in the future does not hold back a message whose received_at is old", async () => {
        const page = [arrival(0, PAST, { cursor: "9223372036854775807:M0" })];
        const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "" });
        expect(heldBackCount(outcome.text)).toBe(0);
        expect(nextOf(outcome.text)).toBe("9223372036854775807:M0");
      });

      it("a cursor in the past does not release a message whose received_at is ahead", async () => {
        const page = [arrival(0, AHEAD, { cursor: "0:M0" })];
        const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "" });
        expect(heldBackCount(outcome.text)).toBe(1);
        expect(nextOf(outcome.text)).toBe("");
      });

      it("a time with an offset is compared as an instant, not as text (past, though it sorts later)", async () => {
        // 19:05+10:00 is 09:05Z, five minutes ahead: not held back; as text "19" > "09:10".
        const page = [arrival(0, PAST, { received_at: "2026-10-28T19:05:00+10:00" })];
        const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "" });
        expect(heldBackCount(outcome.text)).toBe(0);
      });

      it("a time with an offset is compared as an instant, not as text (ahead, though it sorts earlier)", async () => {
        // 03:30-06:00 is 09:30Z, thirty minutes ahead: held back; as text "03" < "09".
        const page = [arrival(0, PAST, { received_at: "2026-10-28T03:30:00-06:00" })];
        const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "" });
        expect(heldBackCount(outcome.text)).toBe(1);
      });

      it("fractional seconds beyond a millisecond are read, not rejected", async () => {
        const page = [arrival(0, PAST, { received_at: "2026-10-28T09:20:00.123456789Z" })];
        const { outcome } = await runWith({ readAfter: page }, "mail_new", { after: "" });
        expect(heldBackCount(outcome.text)).toBe(1);
      });
    });
  });

  describe("the limit 1 ceiling failure", () => {
    const MESSAGE = "screwtape output over 4 MiB at limit 1: the next message cannot be read";

    it("pins the message", () => {
      expect(OVERSIZE_AT_LIMIT_1).toBe(MESSAGE);
    });

    it("at limit 1 an oversize failure is exactly the oversize message: an error, no next, no block", async () => {
      const failure = new MailSourceError("oversize", "screwtape output over 4 MiB");
      const { outcome } = await runWith({ readAfter: failure }, "mail_new", {
        after: CURSOR_AFTER,
        limit: 1,
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe(MAIL_ERROR_PREFIX + MESSAGE);
      expect(outcome.text).not.toContain("next:");
      expect(outcome.text).not.toContain(OPEN_TAG);
    });

    it("at limit 2 an oversize failure is the source's own message, an error with no next", async () => {
      const failure = new MailSourceError("oversize", "screwtape output over 4 MiB");
      const { outcome } = await runWith({ readAfter: failure }, "mail_new", {
        after: "",
        limit: 2,
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe(MAIL_ERROR_PREFIX + "screwtape output over 4 MiB");
    });

    it("at limit 1 a different failure keeps its own message", async () => {
      const failure = new MailSourceError("timeout", "screwtape timed out");
      const { outcome } = await runWith({ readAfter: failure }, "mail_new", {
        after: "",
        limit: 1,
      });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toBe(MAIL_ERROR_PREFIX + "screwtape timed out");
    });

    it.each([
      [
        "mail_list",
        { limit: 1 },
        { list: new MailSourceError("oversize", "list output over 4 MiB") },
      ],
      [
        "mail_thread",
        { id: "Thr1", limit: 1 },
        { thread: new MailSourceError("oversize", "thread output over 4 MiB") },
      ],
      [
        "mail_read",
        { id: "Msg1" },
        { read: new MailSourceError("oversize", "read output over 4 MiB") },
      ],
    ] as const)(
      "%s keeps the source's message for an oversize failure",
      async (tool, args, replies) => {
        const { outcome } = await runWith(replies, tool, args);
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toMatch(/output over 4 MiB$/);
        expect(outcome.text).not.toContain("at limit 1");
      },
    );

    it("any MailSourceError is an error result with only its message: no header, no items", async () => {
      const failure = new MailSourceError("failed", "screwtape failed");
      for (const [tool, args] of [
        ["mail_new", { after: "" }],
        ["mail_read", { id: "Msg1" }],
        ["mail_thread", { id: "Thr1" }],
        ["mail_list", {}],
        ["mail_mailboxes", {}],
      ] as const) {
        const { outcome } = await runWith(
          { readAfter: failure, read: failure, thread: failure, list: failure, mailboxes: failure },
          tool,
          args,
        );
        expect(outcome).toEqual({ text: MAIL_ERROR_PREFIX + "screwtape failed", isError: true });
      }
    });

    it("anything that is not a MailSourceError is thrown, not turned into a result", async () => {
      const boom = new Error("boom");
      await expect(runWith({ readAfter: boom }, "mail_new", { after: "" })).rejects.toBe(boom);
      await expect(runWith({ list: boom }, "mail_list", {})).rejects.toBe(boom);
    });
  });
});

// ======================================================== VT-3: shape, text

describe("VT-3 shape, replay and descriptions", () => {
  const ALL: ToolName[] = ["mail_new", "mail_read", "mail_thread", "mail_list", "mail_mailboxes"];
  const tools = mailTools(fakeMailDeps({ now: () => NOW }));
  const descriptionOf = (name: ToolName): string => toolNamed(tools, name).description;

  describe("the tool set", () => {
    it("is the five tools, in order", () => {
      expect(tools.map(({ name }) => name)).toEqual(ALL);
    });

    it.each(ALL)('%s is replay: "safe"', (name) => {
      expect(toolNamed(tools, name).replay).toBe("safe");
    });

    it.each(ALL)("%s has a non-empty description (an empty one fails)", (name) => {
      expect(descriptionOf(name).trim()).not.toBe("");
    });

    it.each(ALL)("%s ends with the untrusted-data sentence", (name) => {
      expect(descriptionOf(name).endsWith(MAIL_DESCRIPTION_SUFFIX)).toBe(true);
    });

    const PARAMS: [ToolName, string[], string[]][] = [
      [
        "mail_new",
        ["after", "since", "limit", "max_bytes", "mailbox", "unread", "from"],
        ["after"],
      ],
      ["mail_read", ["id", "max_bytes"], ["id"]],
      ["mail_thread", ["id", "limit"], ["id"]],
      ["mail_list", ["limit", "offset", "mailbox", "unread", "from"], []],
      ["mail_mailboxes", [], []],
    ];
    it.each(PARAMS)("%s takes exactly its parameters, required: %j", (name, keys, required) => {
      const schema: unknown = toolNamed(tools, name).parameters;
      const properties =
        isRecord(schema) && isRecord(schema["properties"]) ? schema["properties"] : {};
      expect(Object.keys(properties).sort()).toEqual([...keys].sort());
      expect(isRecord(schema) ? (schema["required"] ?? []) : null).toEqual(required);
    });
  });

  describe("descriptions are pinned", () => {
    const RETRY = "If a call fails as over 4 MiB, retry with limit 1.";
    it.each(["mail_new", "mail_thread", "mail_list"] as const)(
      "%s states the limit 1 retry",
      (name) => {
        expect(descriptionOf(name)).toContain(RETRY);
      },
    );

    it("mail_list states that offset paging drifts under a concurrent sync, and points to mail_new", () => {
      expect(descriptionOf("mail_list")).toContain(
        "Offset paging shifts when new mail syncs between calls, so a page can repeat or skip messages; use mail_new to follow new mail.",
      );
    });

    it("mail_read and mail_mailboxes say what they return", () => {
      expect(descriptionOf("mail_read")).toContain("Read one message by id");
      expect(descriptionOf("mail_mailboxes")).toContain("List the mailboxes");
    });
  });

  describe("headers", () => {
    it("a thread header has total and truncated, truncated or not (a thread header without them fails)", async () => {
      const cut = await runWith(
        threadReply(57, true, [inStoreThreadItem(), absentThreadItem("Gone1")]),
        "mail_thread",
        { id: "Thr1", limit: 2 },
      );
      expect(headerLine(cut.outcome.text, "total: ")).toBe("total: 57, truncated: true");
      const whole = await runWith(threadReply(1, false), "mail_thread", { id: "Thr1" });
      expect(headerLine(whole.outcome.text, "total: ")).toBe("total: 1, truncated: false");
    });

    it("only mail_new carries next, caught_up and held back; the other verbs have none", async () => {
      const outcomes = [
        (await runWith({ read: readOf() }, "mail_read", { id: "Msg1" })).outcome,
        (await runWith(threadReply(), "mail_thread", { id: "Thr1" })).outcome,
        (await runWith(listReply(), "mail_list", {})).outcome,
      ];
      for (const { text } of outcomes) {
        expect(headerLine(text, "next: ")).toBeUndefined();
        expect(headerLine(text, "caught_up: ")).toBeUndefined();
        expect(heldBackCount(text)).toBeUndefined();
      }
    });

    it("mail_new carries the known gaps line; the other verbs do not", async () => {
      const fresh = await runWith({ readAfter: [] }, "mail_new", { after: "" });
      expect(headerLine(fresh.outcome.text, "known gaps: ")).toBeDefined();
      const list = await runWith(listReply(), "mail_list", {});
      expect(headerLine(list.outcome.text, "known gaps: ")).toBeUndefined();
    });

    it("mail_mailboxes shows the mailboxes whole, with shown N of M", async () => {
      const mailboxes = {
        items: [mailboxOf(), mailboxOf({ id: "mbx2", name: "Sent", role: "sent" })],
      };
      const { outcome } = await runWith({ mailboxes }, "mail_mailboxes", {});
      expect(headerLine(outcome.text, "shown ")).toBe("shown 2 of 2");
      expect(itemsOf(outcome.text)).toEqual([
        {
          id: "mbx1",
          name: "Inbox",
          parent_id: null,
          role: "inbox",
          sort_order: 1,
          total_emails: 10,
          unread_emails: 3,
        },
        {
          id: "mbx2",
          name: "Sent",
          parent_id: null,
          role: "sent",
          sort_order: 1,
          total_emails: 10,
          unread_emails: 3,
        },
      ]);
    });
  });

  describe("per-verb core keys, exactly (and no cursor, provenance or raw bodies)", () => {
    const SUMMARY = [
      "id",
      "thread_id",
      "received_at",
      "subject",
      "is_seen",
      "is_flagged",
      "has_attachment",
      "jev",
    ];
    const BODY_FLAGS = [
      "is_truncated",
      "is_encoding_problem",
      "conversion_failed",
      "truncated_by",
      "output_truncated",
    ];
    const NEVER = ["cursor", "provenance", "email_state", "bodies"];
    const keysOf = (item: Record<string, unknown>, count: number): string[] =>
      Object.keys(item).slice(0, count);

    it("mail_list: summary, cut", async () => {
      const { outcome } = await runWith(listReply(), "mail_list", {});
      const [item] = itemsOf(outcome.text);
      const core = [...SUMMARY, "cut"];
      expect(keysOf(item ?? {}, core.length)).toEqual(core);
      for (const key of [...NEVER, "in_store", "message_id", "account_id", "body"]) {
        expect(item).not.toHaveProperty(key);
      }
    });

    it("mail_thread: summary, in_store, cut; an absent entry is id and in_store: false only", async () => {
      const { outcome } = await runWith(
        threadReply(2, false, [inStoreThreadItem(), absentThreadItem("Gone1")]),
        "mail_thread",
        { id: "Thr1" },
      );
      const [present, absent] = itemsOf(outcome.text);
      const core = [...SUMMARY, "in_store", "cut"];
      expect(keysOf(present ?? {}, core.length)).toEqual(core);
      expect(present?.["in_store"]).toBe(true);
      expect(absent).toEqual({ id: "Gone1", in_store: false });
      for (const key of [...NEVER, "body"]) {
        expect(present).not.toHaveProperty(key);
      }
    });

    it("mail_new: summary, the five body flags, cut; message_id and account_id are not shown", async () => {
      const { outcome } = await runWith({ readAfter: pageAt(PAST) }, "mail_new", { after: "" });
      const [item] = itemsOf(outcome.text);
      const core = [...SUMMARY, ...BODY_FLAGS, "cut"];
      expect(keysOf(item ?? {}, core.length)).toEqual(core);
      for (const key of [...NEVER, "message_id", "account_id", "in_store"]) {
        expect(item).not.toHaveProperty(key);
      }
      expect(item?.["body"]).toBe("body text");
    });

    it("mail_new: held_back sits between the summary fields and the body flags", async () => {
      const { outcome } = await runWith({ readAfter: pageAt(AHEAD) }, "mail_new", { after: "" });
      const [item] = itemsOf(outcome.text);
      const core = [...SUMMARY, "held_back", ...BODY_FLAGS, "cut"];
      expect(keysOf(item ?? {}, core.length)).toEqual(core);
    });

    it("mail_read: summary, the five body flags, message_id, account_id, cut", async () => {
      const { outcome } = await runWith({ read: readOf() }, "mail_read", { id: "Msg1" });
      const items = itemsOf(outcome.text);
      expect(items).toHaveLength(1);
      const core = [...SUMMARY, ...BODY_FLAGS, "message_id", "account_id", "cut"];
      expect(keysOf(items[0] ?? {}, core.length)).toEqual(core);
      expect(items[0]?.["account_id"]).toBe("u1234");
      expect(items[0]?.["message_id"]).toEqual(["<m1@example.com>"]);
      for (const key of [...NEVER, "in_store", "held_back"]) {
        expect(items[0]).not.toHaveProperty(key);
      }
    });
  });
});

// ============================================== VT-1: the refusal, the prefix

describe("VT-1 mailRefusal refuses every tool before any argument check", () => {
  type Facts = Parameters<typeof mailRefusal>[0];
  const CREDENTIALS = "/run/credentials/jev";
  const NETWORK: Facts = { interfaces: ["lo", "eth0"], credentials: CREDENTIALS };
  const UNREADABLE: Facts = { interfaces: undefined, credentials: CREDENTIALS };
  const UNSET: Facts = { interfaces: ["lo"], credentials: undefined };
  const REFUSED: readonly (readonly [string, Facts])[] = [
    ["a reachable network", NETWORK],
    ["an unreadable interface list", UNREADABLE],
    ["unset credentials", UNSET],
  ];

  /** The refusal a fact must produce; fails the test when the precondition holds. */
  const refusalOf = (facts: Facts): string => {
    const refusal = mailRefusal(facts);
    if (refusal === undefined) {
      throw new Error("expected a refusal");
    }
    return refusal;
  };

  it("allows lo with the credentials directory named", () => {
    expect(mailRefusal({ interfaces: ["lo"], credentials: CREDENTIALS })).toBeUndefined();
  });

  it.each(REFUSED)("refuses %s", (_label, facts) => {
    expect(refusalOf(facts).trim()).not.toBe("");
  });

  it("names each failed precondition distinctly", () => {
    expect(new Set(REFUSED.map(([, facts]) => refusalOf(facts))).size).toBe(REFUSED.length);
  });

  it("names the network first when the credentials are unset too", () => {
    expect(refusalOf({ interfaces: ["lo", "eth0"], credentials: undefined })).toBe(
      refusalOf(NETWORK),
    );
  });

  /** Every tool, with arguments that are good and with arguments that are not. */
  const ARGS: readonly (readonly [ToolName, readonly Record<string, unknown>[]])[] = [
    ["mail_new", [{ after: "" }, { after: "5" }]],
    ["mail_read", [{ id: "Msg1" }, { id: "--after" }]],
    ["mail_thread", [{ id: "Thr1" }, { id: "" }]],
    ["mail_list", [{}, { from: "-rf" }]],
    ["mail_mailboxes", [{}, { interval: 5 }]],
  ];

  /** Answers every port call, so a call shows as a result, not as a thrown failure. */
  const EVERY_REPLY: FakeReplies = {
    readAfter: [],
    read: readOf(),
    ...threadReply(),
    ...listReply(),
    mailboxes: { items: [] },
  };

  it.each(REFUSED)(
    'refuses every tool with "malebolge: " and the refusal, for %s',
    async (_label, facts) => {
      const refusal = refusalOf(facts);
      for (const [name, variants] of ARGS) {
        for (const args of variants) {
          const source = fakeMailSource(EVERY_REPLY);
          const outcome = await run(source, name, args, context, { refusal });
          expect(outcome).toEqual({ text: `${MAIL_ERROR_PREFIX}${refusal}`, isError: true });
          expect(source.calls).toHaveLength(0);
        }
      }
    },
  );

  it('prefixes an input error and a source error with "malebolge: " exactly once', async () => {
    const input = await run(fakeMailSource({ readAfter: [] }), "mail_new", { after: "5" });
    const { outcome: sourceError } = await runWith(
      { list: new MailSourceError("failed", "screwtape failed") },
      "mail_list",
      {},
    );
    for (const outcome of [input, sourceError]) {
      expect(outcome.isError).toBe(true);
      expect(outcome.text.startsWith(MAIL_ERROR_PREFIX)).toBe(true);
      expect(outcome.text.split(MAIL_ERROR_PREFIX)).toHaveLength(2);
    }
  });
});

// ========================================= PHASE-05: the item tools screen their page

// The four tools whose read reaches items; mail_mailboxes has no items to screen.
type ItemTool = "mail_new" | "mail_read" | "mail_thread" | "mail_list";

const ITEM_TOOLS = ["mail_new", "mail_read", "mail_thread", "mail_list"] as const;

const SCREENED_ID = "Msg1";
const SCREENED_AT = at(PAST);
/** Two domains, one uppercase and one repeated: `sender_domains` lowercases and dedupes. */
const SCREENED_FROM: Address[] = [
  { name: "Ada", email: "Ada@Example.com" },
  { name: null, email: "bob@example.org" },
  { name: "Ada again", email: "second@example.com" },
];
const SCREENED_DOMAINS = ["example.com", "example.org"];
/** The policy's question names, read from the table and never typed (CON-001). */
const POLICY_QUESTIONS = WITHHOLD_POLICY.map((row) => row.question);
const [FIRST_ROW] = WITHHOLD_POLICY;

/** The one item the screening tests screen: a plain read, three senders, a body, an attachment and a size. */
function screenedRead(overrides: Partial<ReadData> = {}): ReadData {
  return readOf({
    id: SCREENED_ID,
    thread_id: "Thr1",
    received_at: SCREENED_AT,
    cursor: `${String(Date.parse(SCREENED_AT))}:${SCREENED_ID}`,
    from: SCREENED_FROM,
    attachments: [attachmentOf()],
    ...overrides,
  });
}

/** The arguments `tool` needs to reach its page. */
function itemArgs(tool: ItemTool): Record<string, unknown> {
  switch (tool) {
    case "mail_new":
      return { after: "" };
    case "mail_read":
      return { id: SCREENED_ID };
    case "mail_thread":
      return { id: "Thr1" };
    case "mail_list":
      return {};
  }
}

/** What `tool` reads for one `item`: its one-message page. */
function itemReplies(tool: ItemTool, item: ReadData = screenedRead()): FakeReplies {
  switch (tool) {
    case "mail_new":
      return { readAfter: [item] };
    case "mail_read":
      return { read: item };
    case "mail_thread":
      return {
        thread: { id: "Thr1", total: 1, truncated: false, items: [inStoreThreadItem(item)] },
      };
    case "mail_list":
      return { list: { limit: 20, offset: 0, items: [item] } };
  }
}

/** The rendered `jev` object of an item. */
function jevOf(item: Record<string, unknown>): Record<string, unknown> {
  const jev = item["jev"];
  if (!isRecord(jev)) {
    throw new Error("the item has no jev object");
  }
  return jev;
}

/** The contract answers, with `question` replaced by `answer` (or dropped when it is undefined). */
function answersFor(
  id: string,
  question: string,
  answer: Classification["answers"][string] | undefined,
): Classification["answers"] {
  const kept = Object.entries(classificationOf(id).answers).filter(([name]) => name !== question);
  const base: Classification["answers"] = Object.fromEntries(kept);
  return answer === undefined ? base : { ...base, [question]: answer };
}

/** A number as the rendered `jev` rounds it: 2 dp. */
const rounded = (value: number): number => Math.round(value * 100) / 100;

interface Screening {
  /** The classify reply: a map of id to answer, or an Error; a map that omits an id answers `failed`. */
  readonly classify: NonNullable<FakeReplies["classify"]>;
  readonly reported?: Map<string, ReportKind>;
}

/** The one item `tool` renders when its page is screened by `screening`, and its raw data line. */
async function screenedOutput(
  tool: ItemTool,
  screening: Screening,
  item: ReadData = screenedRead(),
): Promise<{ item: Record<string, unknown>; line: string }> {
  const { outcome } = await runWith(
    { ...itemReplies(tool, item), classify: screening.classify },
    tool,
    itemArgs(tool),
    screening.reported === undefined ? {} : { reported: screening.reported },
  );
  expect(outcome.isError).toBe(false);
  const lines = dataLinesOf(outcome.text);
  expect(lines).toHaveLength(1);
  const [line] = lines;
  if (line === undefined) {
    throw new Error(`${tool}: no item`);
  }
  return { item: parseLine(line), line };
}

/** The one item `tool` renders when its page is screened by `screening`. */
async function screenedItem(
  tool: ItemTool,
  screening: Screening,
  item: ReadData = screenedRead(),
): Promise<Record<string, unknown>> {
  return (await screenedOutput(tool, screening, item)).item;
}

interface HoldCase {
  readonly label: string;
  readonly screening: Screening;
  readonly withheld: Withheld;
}

/** Hostile answers at each policy row's bound: withheld exactly there. */
function hostileCases(): HoldCase[] {
  return WITHHOLD_POLICY.map((row) => ({
    label: `hostile: ${row.question} at exactly its bound`,
    screening: {
      classify: {
        [SCREENED_ID]: classificationOf(
          SCREENED_ID,
          answersFor(SCREENED_ID, row.question, { noul: row.atLeast }),
        ),
      },
    },
    withheld: { reason: "hostile", detail: row.question, score: rounded(row.atLeast) },
  }));
}

/** Each withholding reason as a scripted page: the classify reply (and report) that must produce it. */
const HOLD_CASES: readonly HoldCase[] = [
  {
    label: "reported",
    screening: {
      classify: classifyAll([SCREENED_ID]),
      reported: new Map<string, ReportKind>([[SCREENED_ID, "phishing"]]),
    },
    withheld: { reason: "reported", detail: "phishing" },
  },
  {
    label: "unclassified: unavailable",
    screening: { classify: { [SCREENED_ID]: "unavailable" } },
    withheld: { reason: "unclassified", detail: "unavailable" },
  },
  {
    label: "unclassified: failed (the classify reply omits the id)",
    screening: { classify: {} },
    withheld: { reason: "unclassified", detail: "failed" },
  },
  {
    label: `missing_question: ${FIRST_ROW.question} absent`,
    screening: {
      classify: {
        [SCREENED_ID]: classificationOf(
          SCREENED_ID,
          answersFor(SCREENED_ID, FIRST_ROW.question, undefined),
        ),
      },
    },
    withheld: { reason: "missing_question", detail: FIRST_ROW.question },
  },
  {
    label: `missing_question: ${FIRST_ROW.question} under a choice shape (counts as missing)`,
    screening: {
      classify: {
        [SCREENED_ID]: classificationOf(
          SCREENED_ID,
          answersFor(SCREENED_ID, FIRST_ROW.question, { choice: "a label", confidence: 0.9 }),
        ),
      },
    },
    withheld: { reason: "missing_question", detail: FIRST_ROW.question },
  },
  ...hostileCases(),
];

/** 40 addresses whose domains are each 200 bytes, distinct within one item's list. */
function longDomainAddresses(item: number): Address[] {
  return Array.from({ length: 40 }, (_, n) => ({
    name: `Person ${String(n)}`,
    email: `person${String(n)}@${String(n).padStart(2, "0")}${String(item).padStart(
      2,
      "0",
    )}${"d".repeat(196)}`,
  }));
}

/** Every sender-written string of a screened read: subject, preview, bodies, names, local parts, file names. */
function senderTextOf(read: ReadData): string[] {
  return [
    read.subject,
    read.preview,
    ...read.bodies.map((part) => part.text),
    ...read.from.flatMap((address) => [
      address.name,
      address.email.slice(0, address.email.lastIndexOf("@")),
    ]),
    ...read.attachments.map((attachment) => attachment.name),
  ].filter((text): text is string => typeof text === "string" && text !== "");
}

/** The withheld item's exact key set: its core, and each fill key its own `cut` does not name. */
function expectWithheldKeys(item: Record<string, unknown>, tool: ItemTool): void {
  const cut = item["cut"];
  const cutNames: unknown[] = Array.isArray(cut) ? cut : [];
  const coreKeys = [
    "id",
    "thread_id",
    "received_at",
    ...(tool === "mail_new" || tool === "mail_read" ? ["size"] : []),
    "is_seen",
    "is_flagged",
    "has_attachment",
    "jev",
    "withheld",
    ...(tool === "mail_thread" ? ["in_store"] : []),
    "cut",
  ];
  const keptFill = ["sender_domains", "mailbox_ids"].filter((key) => !cutNames.includes(key));
  expect(Object.keys(item).sort()).toEqual([...coreKeys, ...keptFill].sort());
}

/** A rendered line that carries none of the screened read's sender text. */
function expectNoSenderText(line: string): void {
  const senderText = senderTextOf(screenedRead());
  expect(senderText.length).toBeGreaterThan(0);
  for (const text of senderText) {
    expect(line).not.toContain(text);
  }
}

describe("VT-2 projectWithheld withholds the sender's text, keeping sender_domains (SL-007 PHASE-05)", () => {
  const MATRIX = ITEM_TOOLS.flatMap((tool) => HOLD_CASES.map((hold) => ({ tool, ...hold })));

  it.each(MATRIX)("$tool: $label", async ({ tool, screening, withheld }) => {
    const { item, line } = await screenedOutput(tool, screening);
    expect(item["withheld"]).toEqual(withheld);
    expect(item["sender_domains"]).toEqual(SCREENED_DOMAINS);
    expect(item).toHaveProperty("jev");
    for (const key of ["subject", "preview", "body", "from", "to", "attachments"]) {
      expect(item).not.toHaveProperty(key);
    }
    if (tool === "mail_read" || tool === "mail_new") {
      expect(item["size"]).toBe(screenedRead().size);
    } else {
      expect(item).not.toHaveProperty("size");
    }
    // A withheld thread entry keeps its in_store flag, as a shown one does.
    expect(item["in_store"]).toBe(tool === "mail_thread" ? true : undefined);
    // The whole key set: the core, and the fill only where fitItem kept it.
    expectWithheldKeys(item, tool);
    // The raw line carries no sender text: not a subject, name, local part, body or file name.
    expectNoSenderText(line);
  });

  it.each(ITEM_TOOLS)("%s classifies the page's ids and no others", async (tool) => {
    const item = screenedRead();
    const replies: FakeReplies =
      tool === "mail_thread"
        ? {
            thread: {
              id: "Thr1",
              total: 2,
              truncated: false,
              items: [inStoreThreadItem(item), absentThreadItem("Gone1")],
            },
          }
        : itemReplies(tool, item);
    const { outcome, source } = await runWith(
      { ...replies, classify: classifyAll([SCREENED_ID]) },
      tool,
      itemArgs(tool),
    );
    expect(outcome.isError).toBe(false);
    expectClassified(source, [SCREENED_ID]);
  });

  it.each(WITHHOLD_POLICY)("$question: one step below its bound is shown", async (row) => {
    const below = rounded(row.atLeast - 0.01);
    const item = await screenedItem("mail_list", {
      classify: {
        [SCREENED_ID]: classificationOf(
          SCREENED_ID,
          answersFor(SCREENED_ID, row.question, { noul: below }),
        ),
      },
    });
    expect(item["withheld"]).toBeUndefined();
    expect(item).toHaveProperty("subject");
    expect(jevOf(item)[row.question]).toBe(below);
  });

  it("mail_list at limit 40 with 40 withheld items of long domains keeps every line within its share", async () => {
    const items = Array.from({ length: 40 }, (_, n) =>
      summaryOf({ id: `M${String(n)}`, from: longDomainAddresses(n) }),
    );
    const { outcome } = await runWith(
      {
        list: { limit: 40, offset: 0, items },
        classify: classifyAll(items.map((item) => item.id)),
      },
      "mail_list",
      { limit: 40 },
      {
        reported: new Map<string, ReportKind>(
          items.map((item): [string, ReportKind] => [item.id, "phishing"]),
        ),
      },
    );
    expect(outcome.isError).toBe(false);
    const lines = dataLinesOf(outcome.text);
    expect(lines).toHaveLength(40);
    for (const line of lines) {
      expect(bytesOf(line)).toBeLessThanOrEqual(shareOf(40));
    }
    for (const item of lines.map(parseLine)) {
      expect(item["withheld"]).toEqual({ reason: "reported", detail: "phishing" });
      expect(item["cut"]).toContain("sender_domains");
      expect(item).not.toHaveProperty("sender_domains");
    }
  });
});

describe('VT-3 "missing question:" lines, the withheld count, and the one classify call', () => {
  const UNKNOWN_QUESTION = "zz_not_a_policy_question";

  it("an unknown extra question renders in jev and the item is shown", async () => {
    expect(POLICY_QUESTIONS).not.toContain(UNKNOWN_QUESTION);
    const answers = {
      ...classificationOf(SCREENED_ID).answers,
      [UNKNOWN_QUESTION]: { noul: 0.99 },
    };
    const item = await screenedItem("mail_list", {
      classify: { [SCREENED_ID]: classificationOf(SCREENED_ID, answers) },
    });
    expect(item["withheld"]).toBeUndefined();
    expect(jevOf(item)[UNKNOWN_QUESTION]).toBe(0.99);
    expect(item).toHaveProperty("subject");
  });

  it("a missing policy question adds one missing question: line, once for two items", async () => {
    const ids = ["M0", "M1"];
    const classify = Object.fromEntries(
      ids.map((id): [string, Classification] => [
        id,
        classificationOf(id, answersFor(id, FIRST_ROW.question, undefined)),
      ]),
    );
    const { outcome } = await runWith(
      { list: { limit: 20, offset: 0, items: ids.map((id) => summaryOf({ id })) }, classify },
      "mail_list",
      {},
    );
    const line = `missing question: ${FIRST_ROW.question}`;
    expect(headerLinesOf(outcome.text).filter((header) => header === line)).toHaveLength(1);
    for (const item of itemsOf(outcome.text)) {
      expect(item["withheld"]).toEqual({ reason: "missing_question", detail: FIRST_ROW.question });
    }
  });

  it("a classify reply that omits one id's item withholds that item as failed, the other shown with jev", async () => {
    const ids = ["M0", "M1"];
    const shownId = "M1";
    const { outcome } = await runWith(
      {
        list: { limit: 20, offset: 0, items: ids.map((id) => summaryOf({ id })) },
        classify: { [shownId]: classificationOf(shownId) },
      },
      "mail_list",
      {},
    );
    expect(outcome.isError).toBe(false);
    const items = itemsOf(outcome.text);
    expect(items).toHaveLength(2);
    const [omitted, shown] = items;
    if (omitted === undefined || shown === undefined) {
      throw new Error("mail_list: two items expected");
    }
    expect(omitted["id"]).toBe("M0");
    expect(omitted["withheld"]).toEqual({ reason: "unclassified", detail: "failed" });
    expect(jevOf(omitted)).toEqual({ unclassified: "failed" });
    expect(shown["id"]).toBe(shownId);
    expect(shown["withheld"]).toBeUndefined();
    expect(Object.keys(jevOf(shown))).toEqual(Object.keys(classificationOf(shownId).answers));
    expect(shown).toHaveProperty("subject");
    expect(itemsLineOf(outcome.text).endsWith(", 1 withheld")).toBe(true);
  });

  it("the items line ends with , N withheld when items are withheld and says nothing when none is", async () => {
    const ids = ["M0", "M1", "M2"];
    const replies: FakeReplies = {
      list: { limit: 20, offset: 0, items: ids.map((id) => summaryOf({ id })) },
      classify: classifyAll(ids),
    };
    const held = await runWith(
      replies,
      "mail_list",
      {},
      {
        reported: new Map<string, ReportKind>([["M0", "phishing"]]),
      },
    );
    expect(itemsLineOf(held.outcome.text).endsWith(", 1 withheld")).toBe(true);
    const clear = await runWith(replies, "mail_list", {});
    expect(itemsLineOf(clear.outcome.text)).not.toContain("withheld");
  });

  it("mail_new: a held-back withheld item keeps held_back, and next and caught_up do not change", async () => {
    const page = [arrival(0, PAST), arrival(1, AHEAD)];
    const replies: FakeReplies = {
      readAfter: page,
      classify: classifyAll(page.map((read) => read.id)),
    };
    const shown = await runWith(replies, "mail_new", { after: "", limit: 2 });
    const held = await runWith(
      replies,
      "mail_new",
      { after: "", limit: 2 },
      {
        reported: new Map<string, ReportKind>([["M1", "phishing"]]),
      },
    );
    expect(nextOf(held.outcome.text)).toBe(nextOf(shown.outcome.text));
    expect(caughtUpOf(held.outcome.text)).toBe(caughtUpOf(shown.outcome.text));
    const items = itemsOf(held.outcome.text);
    expect(items).toHaveLength(2);
    expect(items[1]?.["held_back"]).toBe(true);
    expect(items[1]?.["withheld"]).toEqual({ reason: "reported", detail: "phishing" });
    expect(itemsOf(shown.outcome.text)[1]?.["withheld"]).toBeUndefined();
  });

  it("mail_thread: an in_store: false entry is not classified and renders as before", async () => {
    const items = [inStoreThreadItem({ id: "M0" }), absentThreadItem("Gone1")];
    const { outcome, source } = await runWith(
      { thread: { id: "Thr1", total: 2, truncated: false, items }, classify: classifyAll(["M0"]) },
      "mail_thread",
      { id: "Thr1", limit: 2 },
    );
    expectClassified(source, ["M0"]);
    expect(itemsOf(outcome.text)[1]).toEqual({ id: "Gone1", in_store: false });
  });

  it("a page whose ids are all cached makes no classify call on the second call", async () => {
    const cache = classificationCache();
    const ids = ["M0", "M1"];
    const source = fakeMailSource({
      list: { limit: 20, offset: 0, items: ids.map((id) => summaryOf({ id })) },
      classify: classifyAll(ids),
    });
    const first = await run(source, "mail_list", {}, context, { cache });
    const second = await run(source, "mail_list", {}, context, { cache });
    const classifyCalls = classifyCallsOf(source);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.query).toMatchObject({ ids });
    expect(itemsOf(first.text)).toHaveLength(2);
    expect(itemsOf(second.text)).toHaveLength(2);
  });

  it("the classify call receives the tool's abort signal", async () => {
    const controller = new AbortController();
    const ids = ["M0"];
    const source = fakeMailSource({
      list: { limit: 20, offset: 0, items: ids.map((id) => summaryOf({ id })) },
      classify: classifyAll(ids),
    });
    await run(source, "mail_list", {}, withAbortSignal(controller.signal, context));
    const classifyCalls = classifyCallsOf(source);
    expect(classifyCalls).toHaveLength(1);
    expect(classifyCalls[0]?.signal).toBe(controller.signal);
  });
});

describe("VT-4 mail_new's joint clamp deducts JEV_MAX_BYTES from NEW_JOINT_BYTES", () => {
  it.each([20, 5])(
    "at limit %i the port receives the joint bound and the header reports max_bytes",
    async (limit) => {
      const expected = jointBound(limit);
      expect(expected).toBeLessThan(NEW_MAX_BYTES.max);
      expect(expected).toBeGreaterThanOrEqual(NEW_MAX_BYTES.min);
      const { outcome, source } = await runWith({ readAfter: [] }, "mail_new", {
        after: "",
        limit,
        max_bytes: NEW_MAX_BYTES.max,
      });
      expect(outcome.isError).toBe(false);
      expect(onlyQuery(source)).toMatchObject({ limit, maxBytes: expected });
      const clamps = clampsOf(outcome.text);
      expect(clamps).toContain("max_bytes");
      expect(clamps).toContain(String(expected));
    },
  );
});
