// VT-1 and VT-2: measurement, the fill, the header and the page. Every size is
// measured with Buffer.byteLength on the actual output, never on raw input text.

import { describe, expect, it } from "vitest";
import {
  CUT_ORDER,
  type ProjectedItem,
  projectListItem,
  projectMailbox,
  projectNew,
  projectRead,
  projectThreadItem,
} from "../../src/mail/project.ts";
import {
  type Clamp,
  cutRendered,
  dataLine,
  fitItem,
  fitMailboxes,
  HEADER_MAX_BYTES,
  HEADER_RESERVE,
  type HeaderFacts,
  ITEMS_MAX_BYTES,
  MAIL_MAX_BYTES,
  renderedLength,
  renderHeader,
  renderMailboxes,
  renderPage,
  renderResult,
  shareOf,
  WRAPPER_BYTES,
} from "../../src/mail/render.ts";
import {
  absentThreadItem,
  addressOf,
  bodyPartOf,
  bytesOf,
  CLOSE_TAG,
  dataLinesOf,
  headerLinesOf,
  HOSTILE_ONCE,
  idOf,
  inStoreThreadItem,
  longestCursor,
  mailboxOf,
  makeRng,
  maxRead,
  maxSummary,
  mustCheck,
  OPEN_TAG,
  parseLine,
  randomRead,
  randomSummary,
  randomThreadItem,
  readOf,
  renderedBytes,
  type Rng,
  type Size,
  summaryOf,
} from "./mail-fixtures.ts";

const KNOWN_GAPS =
  "known gaps: late arrivals with an older received_at are not returned; filters do not reopen passed positions";

type PageFacts = Omit<HeaderFacts, "items" | "withCuts">;

const coreOf = (item: ProjectedItem): Record<string, unknown> => Object.fromEntries(item.core);

/** A hand-built item: the fill and body rules need no projection to be tested. */
function itemOf(
  core: ProjectedItem["core"],
  extra: { fill?: ProjectedItem["fill"]; body?: string; cut?: ProjectedItem["cut"] } = {},
): ProjectedItem {
  const base = { core, fill: extra.fill ?? [], cut: extra.cut ?? [] };
  return extra.body === undefined ? base : { ...base, body: extra.body };
}

/** The core entries the fill never rewrites: each must reach the line unchanged. */
function expectCoreWhole(parsed: Record<string, unknown>, item: ProjectedItem): void {
  for (const [key, value] of item.core) {
    if (key !== "cut" && key !== "output_truncated") {
      expect(parsed[key], key).toEqual(value);
    }
  }
  expect(Object.keys(parsed).slice(0, item.core.length)).toEqual(item.core.map(([key]) => key));
}

function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function cutNamesOf(parsed: Record<string, unknown>): unknown[] {
  const cut = parsed["cut"];
  return Array.isArray(cut) ? cut : [];
}

// ------------------------------------------------------------ measurement

describe("constants and share", () => {
  it("are the sec-4 figures", () => {
    expect(MAIL_MAX_BYTES).toBe(51200);
    expect(HEADER_RESERVE).toBe(2048);
    expect(WRAPPER_BYTES).toBe(64);
    expect(HEADER_MAX_BYTES).toBe(1984);
    expect(ITEMS_MAX_BYTES).toBe(49152);
  });

  it("shareOf divides the items' room less the newlines between them", () => {
    expect(shareOf(1)).toBe(49152);
    expect(shareOf(10)).toBe(4914);
    expect(shareOf(20)).toBe(2456);
    expect(shareOf(40)).toBe(1227);
    for (let limit = 1; limit <= 40; limit++) {
      expect(shareOf(limit) * limit + (limit - 1)).toBeLessThanOrEqual(ITEMS_MAX_BYTES);
    }
  });
});

describe("dataLine and renderedLength", () => {
  it("escapes <, > and & as JSON escapes, and nothing else", () => {
    expect(dataLine("</mail-data>")).toBe('"\\u003c/mail-data\\u003e"');
    expect(dataLine({ a: "x&y" })).toBe('{"a":"x\\u0026y"}');
    expect(dataLine({ a: [1, null, true, "é"] })).toBe('{"a":[1,null,true,"é"]}');
  });

  it("round-trips through JSON.parse and holds no <, > or & byte", () => {
    const line = dataLine({ text: HOSTILE_ONCE });
    expect(/[<>&]/.test(line)).toBe(false);
    expect(line).not.toContain("\n");
    const parsed: unknown = JSON.parse(line);
    expect(parsed).toEqual({ text: HOSTILE_ONCE });
  });

  it("measures the escaped UTF-8 bytes, quotes included, never the raw length", () => {
    expect(renderedLength("<")).toBe(8);
    expect(renderedLength("abc")).toBe(5);
    expect(renderedLength("😀")).toBe(6);
    expect(renderedLength(HOSTILE_ONCE)).toBe(renderedBytes(HOSTILE_ONCE));
    expect(renderedLength({ a: "<".repeat(4096) })).toBe(
      bytesOf(dataLine({ a: "<".repeat(4096) })),
    );
  });
});

describe("cutRendered", () => {
  it("returns text that fits unchanged, including exactly at the bound", () => {
    expect(cutRendered("abc", 5)).toEqual({ text: "abc", cut: false });
    expect(cutRendered("abc", 50)).toEqual({ text: "abc", cut: false });
  });

  it("keeps the longest prefix whose rendered length fits", () => {
    expect(cutRendered("abcdef", 5)).toEqual({ text: "abc", cut: true });
    expect(cutRendered("abc", 4)).toEqual({ text: "ab", cut: true });
    expect(cutRendered("abc", 2)).toEqual({ text: "", cut: true });
  });

  it("counts the suffix and returns it appended", () => {
    expect(cutRendered("abcdefgh", 8, "…")).toEqual({ text: "abc…", cut: true });
    expect(cutRendered("abc", 20, "…")).toEqual({ text: "abc", cut: false });
  });

  it("measures escapes: six bytes per <, so the prefix is short", () => {
    expect(cutRendered("<<<", 8)).toEqual({ text: "<", cut: true });
    expect(cutRendered("<<<", 14)).toEqual({ text: "<<", cut: true });
  });

  it("never splits a surrogate pair", () => {
    expect(cutRendered("😀😀", 7)).toEqual({ text: "😀", cut: true });
    expect(cutRendered("😀😀", 5)).toEqual({ text: "", cut: true });
    expect(cutRendered("a😀b", 6).text.isWellFormed()).toBe(true);
  });
});

// ------------------------------------------------------------ escaping

describe("escaping (VT-1)", () => {
  const CLOSER = `before ${CLOSE_TAG} after\n${OPEN_TAG}\n& done`;

  it.each([
    ["a body containing </mail-data>", CLOSER],
    ["a body of 4096 <", "<".repeat(4096)],
    ["a body of every hostile character", HOSTILE_ONCE],
  ])("%s stays in one valid JSON line, and the block closes once", (_name, body) => {
    const item = projectRead(
      readOf({
        subject: CLOSER,
        preview: CLOSER,
        from: [{ name: CLOSER, email: "a&b@example.com" }],
        keywords: [CLOSER],
        bodies: [bodyPartOf({ text: body })],
      }),
    );
    const result = renderPage({ tool: "mail_read", clamps: [] }, [item], 1);
    const lines = dataLinesOf(result);
    expect(lines).toHaveLength(1);
    for (const line of lines) {
      expect(line).not.toContain("\n");
      expect(/[<>&]/.test(line)).toBe(false);
      const parsed = parseLine(line);
      expect(parsed["body"]).toBe(body);
      expect(parsed["subject"]).toBe(CLOSER);
      expect(parsed["preview"]).toBe(CLOSER);
      expect(parsed["keywords"]).toEqual([CLOSER]);
    }
    expect(result.split(CLOSE_TAG)).toHaveLength(2);
    expect(result.split(OPEN_TAG)).toHaveLength(2);
    expect(result.endsWith(CLOSE_TAG)).toBe(true);
  });

  it("keeps hostile mailbox names in one line each, and the header free of data", () => {
    const result = renderMailboxes([projectMailbox(mailboxOf({ name: CLOSER }))]);
    const [line] = dataLinesOf(result);
    expect(line).toBeDefined();
    expect(parseLine(line ?? "")["name"]).toBe(CLOSER);
    expect(result.split(CLOSE_TAG)).toHaveLength(2);
    expect(headerLinesOf(result).join("\n")).not.toContain("mail-data");
  });
});

// ------------------------------------------------------------ the fill

describe("fitItem: core, then fill in order, whole or left out", () => {
  const core: ProjectedItem["core"] = [
    ["id", "x"],
    ["cut", []],
  ];

  it("adds every fill field that fits, in order, and names nothing", () => {
    const item = itemOf(core, {
      fill: [
        ["from", ["a"]],
        ["to", ["b"]],
      ],
    });
    expect(fitItem(item, 1000)).toEqual({
      line: '{"id":"x","cut":[],"from":["a"],"to":["b"]}',
      cut: [],
    });
  });

  it("leaves a field that does not fit out whole and still adds later, smaller ones", () => {
    const item = itemOf(core, {
      fill: [
        ["from", ["a".repeat(60)]],
        ["to", ["b"]],
      ],
    });
    const expected = '{"id":"x","cut":["from"],"to":["b"]}';
    expect(fitItem(item, bytesOf(expected))).toEqual({ line: expected, cut: ["from"] });
  });

  it("reserves room to name every later field it might leave out", () => {
    // `from` alone would fit exactly, but then `to` (too big) is named in cut and the line overflows.
    const from = ["abcdefghijklmnopqrstuvwxyz"];
    const share = renderedBytes({ id: "x", cut: [], from });
    const item = itemOf(core, {
      fill: [
        ["from", from],
        ["to", ["t".repeat(100)]],
      ],
    });
    const result = fitItem(item, share);
    expect(bytesOf(result.line)).toBeLessThanOrEqual(share);
    expect(result).toEqual({ line: '{"id":"x","cut":["from","to"]}', cut: ["from", "to"] });
  });

  it("keeps the cuts the projection made, in cut order", () => {
    const item = itemOf(
      [
        ["id", "x"],
        ["cut", ["subject"]],
      ],
      { fill: [["from", ["a".repeat(60)]]], cut: ["subject"] },
    );
    const result = fitItem(item, 40);
    expect(result.cut).toEqual(["subject", "from"]);
    expect(result.line).toBe('{"id":"x","cut":["subject","from"]}');
  });

  it("throws when the core alone exceeds the share (a bug, not a cut)", () => {
    expect(() => fitItem(itemOf(core), 5)).toThrow();
  });
});

describe("fitItem: the body takes what remains (VT-1 body cut)", () => {
  const core: ProjectedItem["core"] = [
    ["id", "x"],
    ["output_truncated", false],
    ["cut", []],
  ];
  const BODY = "abcdefgh";
  const whole = renderedBytes({ id: "x", output_truncated: false, cut: [], body: BODY });
  const bare = renderedBytes({ id: "x", output_truncated: true, cut: ["body"] }); // no body key at all
  const ROOM = 10; // `,"body":""`

  it("adds a body that fits, leaving output_truncated alone", () => {
    expect(fitItem(itemOf(core, { body: BODY }), whole)).toEqual({
      line: '{"id":"x","output_truncated":false,"cut":[],"body":"abcdefgh"}',
      cut: [],
    });
  });

  it("cuts a body one byte over: names body, sets output_truncated, keeps a prefix", () => {
    const { line, cut } = fitItem(itemOf(core, { body: BODY }), whole - 1);
    expect(cut).toEqual(["body"]);
    expect(line).toBe('{"id":"x","output_truncated":true,"cut":["body"],"body":"ab"}');
  });

  it.each([
    [0, ""],
    [1, "a"],
    [2, "ab"],
  ])("fills exactly the room left: %i spare bytes keep %j", (spare, kept) => {
    const share = bare + ROOM + spare;
    const { line, cut } = fitItem(itemOf(core, { body: BODY }), share);
    expect(line).toBe(
      `{"id":"x","output_truncated":true,"cut":["body"],"body":${JSON.stringify(kept)}}`,
    );
    expect(cut).toEqual(["body"]);
    expect(bytesOf(line)).toBe(share);
  });

  it("leaves the body key out, still naming it, when not even an empty body fits", () => {
    const { line, cut } = fitItem(itemOf(core, { body: BODY }), bare + ROOM - 1);
    expect(line).toBe('{"id":"x","output_truncated":true,"cut":["body"]}');
    expect(cut).toEqual(["body"]);
  });

  it("measures the body rendered and cuts on a code-point boundary", () => {
    const euro = fitItem(itemOf(core, { body: "€€€€€" }), bare + ROOM + 3);
    expect(parseLine(euro.line)["body"]).toBe("€");
    const euroShort = fitItem(itemOf(core, { body: "€€€€€" }), bare + ROOM + 2);
    expect(parseLine(euroShort.line)["body"]).toBe("");
    const emoji = fitItem(itemOf(core, { body: "😀😀😀" }), bare + ROOM + 6);
    expect(parseLine(emoji.line)["body"]).toBe("😀");
    const angle = fitItem(itemOf(core, { body: "<<<<" }), bare + ROOM + 13);
    expect(parseLine(angle.line)["body"]).toBe("<<");
    expect(angle.line).toContain('"body":"\\u003c\\u003c"');
  });

  it("reserves nothing for a body that is absent", () => {
    expect(fitItem(itemOf(core), 1000).line).toBe('{"id":"x","output_truncated":false,"cut":[]}');
  });
});

// ------------------------------------------------- negative controls (F-3, F-4, F-25, F-28)

describe("a body of 4096 > at limit 10 (RV-015 F-3, F-4, F-25)", () => {
  const share = shareOf(10);
  const BODY = ">".repeat(4096);
  const item = projectNew(
    readOf({
      from: [addressOf(1)],
      to: [addressOf(2), addressOf(3)],
      bodies: [bodyPartOf({ text: BODY })],
    }),
  );
  const { line, cut } = fitItem(item, share);
  const parsed = parseLine(line);

  it("keeps the whole core and the addresses", () => {
    expectCoreWhole(parsed, item);
    expect(parsed["from"]).toEqual([addressOf(1)]);
    expect(parsed["to"]).toEqual([addressOf(2), addressOf(3)]);
  });

  it("cuts the body to a non-empty prefix, names it and sets output_truncated", () => {
    const kept = parsed["body"];
    expect(typeof kept).toBe("string");
    expect(String(kept).length).toBeGreaterThan(0); // a stub that drops the body fails here
    expect(String(kept).length).toBeLessThan(4096);
    expect(BODY.startsWith(String(kept))).toBe(true);
    expect(cut).toContain("body");
    expect(cutNamesOf(parsed)).toContain("body");
    expect(parsed["output_truncated"]).toBe(true);
  });

  it("uses the room it has, measured rendered: within 6 bytes of the share, never over", () => {
    // 4096 raw bytes would "fit" 4914; the rendered body is 24576. A raw-byte measure overflows.
    const bytes = Buffer.byteLength(line);
    expect(bytes).toBeLessThanOrEqual(share);
    expect(bytes).toBeGreaterThanOrEqual(share - 6);
  });
});

describe("a long to list and a long references list (RV-015 F-28)", () => {
  const share = shareOf(20);
  const to = Array.from({ length: 40 }, (_, n) => addressOf(n, 40));
  const references = Array.from({ length: 100 }, (_, n) => `ref${String(n)}-${"r".repeat(20)}`);
  const item = projectNew(
    readOf({
      to,
      references,
      cc: [addressOf(5)],
      in_reply_to: ["parent"],
      keywords: ["$seen"],
      attachments: [],
    }),
  );
  const { line, cut } = fitItem(item, share);
  const parsed = parseLine(line);

  it("are left out whole (key absent, not shortened) and named in cut", () => {
    expect(Buffer.byteLength(JSON.stringify(to))).toBeGreaterThan(share);
    expect(Buffer.byteLength(JSON.stringify(references))).toBeGreaterThan(share);
    expect(parsed).not.toHaveProperty("to");
    expect(parsed).not.toHaveProperty("references");
    expect(cut).toEqual(["to", "references"]);
    expect(parsed["cut"]).toEqual(["to", "references"]);
  });

  it("do not stop the smaller later fields from appearing", () => {
    expect(parsed["cc"]).toEqual([addressOf(5)]);
    expect(parsed["keywords"]).toEqual(["$seen"]);
    expect(parsed["in_reply_to"]).toEqual(["parent"]);
    expect(parsed["attachments"]).toEqual([]);
    expect(parsed["body"]).toBe("body text");
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(share);
  });
});

// ------------------------------------------------------------ largest cores

describe("the largest cores fit their share (RV-015 F-25, F-39)", () => {
  /** The core as rendered with the largest `cut` it can ever carry. */
  const coreWithCut = (item: ProjectedItem, cut: readonly string[]): number =>
    renderedBytes({ ...coreOf(item), cut });

  it.each([
    ["mail_list", projectListItem(maxSummary("list"), true)],
    ["mail_thread", projectThreadItem({ ...maxSummary("thr"), in_store: true })],
  ])(
    "%s at limit 40: a summary core with every flag, 255-byte ids and every fill left out",
    (_tool, item) => {
      const { line, cut } = fitItem(item, shareOf(40));
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(shareOf(40));
      expectCoreWhole(parseLine(line), item);
      expect(cut).toEqual(["subject", "from", "mailbox_ids", "preview"]);
      expect(coreWithCut(item, ["subject", "from", "mailbox_ids", "preview"])).toBeLessThanOrEqual(
        1152,
      );
    },
  );

  it("mail_new at limit 20: the core with every body flag and held_back, other fields left out", () => {
    const item = projectNew(maxRead("new"), true);
    const { line, cut } = fitItem(item, shareOf(20));
    const parsed = parseLine(line);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(shareOf(20));
    expectCoreWhole(parsed, item);
    expect(parsed["held_back"]).toBe(true);
    expect(parsed["output_truncated"]).toBe(true);
    expect(cut).toEqual(CUT_ORDER.filter((name) => name !== "message_id" && name !== "size"));
    expect(parsed["size"]).toBe(5120);
    expect(coreWithCut(item, CUT_ORDER)).toBeLessThanOrEqual(1280);
  });

  it("mail_read: the core with every flag and 5 long message ids renders within 3 KiB", () => {
    const item = projectRead(maxRead("read"));
    const core = coreOf(item);
    expect(core["is_truncated"]).toBe(true);
    expect(core["is_encoding_problem"]).toBe(true);
    expect(core["conversion_failed"]).toBe(true);
    expect(core["truncated_by"]).toEqual(["server", "message_limit"]);
    expect(core["output_truncated"]).toBe(true);
    expect(coreWithCut(item, CUT_ORDER)).toBeLessThanOrEqual(3072);
    const { line } = fitItem(item, shareOf(1));
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(shareOf(1));
    expectCoreWhole(parseLine(line), item);
  });
});

describe("received_at (RV-015 F-42)", () => {
  it("renders 24 bytes in UTC; the raw long value never appears", () => {
    const raw = "2026-10-27T16:58:00.123456789+05:30";
    const data = mustCheck("list", {
      offset: 0,
      limit: 1,
      items: [summaryOf({ received_at: raw })],
    });
    const result = renderPage(
      { tool: "mail_list", clamps: [] },
      data.items.map((s) => projectListItem(s)),
      1,
    );
    const [line] = dataLinesOf(result);
    const receivedAt = parseLine(line ?? "")["received_at"];
    expect(receivedAt).toBe("2026-10-27T11:28:00.123Z");
    expect(Buffer.byteLength(String(receivedAt))).toBe(24);
    expect(result).not.toContain("123456789");
    expect(result).not.toContain("+05:30");
  });
});

describe("fields outside the projection (RV-015 F-39)", () => {
  it("are not rendered", () => {
    const noisy = mustCheck("read", {
      ...readOf({ provenance: { account_id: "acct9", email_state: "secret-state" } }),
      x_future_field: "FUTURE",
    });
    const result = renderPage({ tool: "mail_read", clamps: [] }, [projectRead(noisy)], 1);
    for (const stray of [
      "x_future_field",
      "FUTURE",
      "secret-state",
      "1793120280000:Msg1",
      "cursor",
      "provenance",
    ]) {
      expect(result).not.toContain(stray);
    }
    expect(result).toContain('"account_id":"acct9"');
  });
});

// ------------------------------------------------------------ header

describe("renderHeader", () => {
  const CLAMPS: Clamp[] = [
    { name: "limit", to: 40 },
    { name: "max_bytes", to: 32768 },
    { name: "offset", to: 10000 },
  ];

  it("writes each fact on its line, in order", () => {
    const header = renderHeader({
      tool: "mail_new",
      items: 2,
      withCuts: 1,
      heldBack: 1,
      next: "1793120280000:Msg1",
      caughtUp: true,
      clamps: [
        { name: "limit", to: 20 },
        { name: "max_bytes", to: 4096 },
      ],
      knownGaps: true,
    });
    expect(header).toBe(
      [
        "mail_new: 2 items, 1 with cuts, 1 held back",
        'next: "1793120280000:Msg1"',
        "caught_up: true",
        "limit clamped to 20; max_bytes clamped to 4096",
        KNOWN_GAPS,
      ].join("\n"),
    );
  });

  it("orders next, caught_up, clamps, thread, shown and the known gaps", () => {
    const header = renderHeader({
      tool: "mail_thread",
      items: 4,
      withCuts: 2,
      heldBack: 0,
      next: "",
      caughtUp: false,
      clamps: [{ name: "limit", to: 40 }],
      thread: { total: 9, truncated: false },
      shown: { shown: 4, of: 9 },
      knownGaps: true,
    });
    expect(header.split("\n")).toEqual([
      "mail_thread: 4 items, 2 with cuts, 0 held back",
      'next: ""',
      "caught_up: false",
      "limit clamped to 40",
      "total: 9, truncated: false",
      "shown 4 of 9",
      KNOWN_GAPS,
    ]);
  });

  it("omits every line whose fact is absent", () => {
    expect(renderHeader({ tool: "mail_list", items: 3, withCuts: 1, clamps: [] })).toBe(
      "mail_list: 3 items, 1 with cuts",
    );
    expect(
      renderHeader({
        tool: "mail_mailboxes",
        items: 3,
        withCuts: 0,
        clamps: [],
        shown: { shown: 3, of: 5 },
      }),
    ).toBe("mail_mailboxes: 3 items, 0 with cuts\nshown 3 of 5");
  });

  it("escapes next as a JSON string (a canonical cursor has nothing to escape)", () => {
    const header = renderHeader({
      tool: "mail_new",
      items: 0,
      withCuts: 0,
      next: "-5:a_b-C",
      clamps: [],
    });
    expect(header).toContain('next: "-5:a_b-C"');
  });

  it("fits its 1984 bytes, and with the wrapper HEADER_RESERVE, in its largest form (RV-015 F-27)", () => {
    const next = longestCursor();
    expect(renderedBytes(next)).toBe(278);
    const header = renderHeader({
      tool: "mail_new",
      items: 20,
      withCuts: 20,
      heldBack: 20,
      next,
      caughtUp: true,
      clamps: CLAMPS,
      knownGaps: true,
    });
    expect(bytesOf(header)).toBeLessThanOrEqual(HEADER_MAX_BYTES);
    expect(bytesOf(renderResult(header, []))).toBeLessThanOrEqual(HEADER_RESERVE);
    expect(header.split("\n")[0]).toBe("mail_new: 20 items, 20 with cuts, 20 held back"); // held back is a count only
    expect(header.match(/held back/g)).toHaveLength(1);
    expect(header).toContain(`next: ${dataLine(next)}`);
  });

  it("fits with every fact present at its largest", () => {
    const header = renderHeader({
      tool: "mail_thread",
      items: 40,
      withCuts: 40,
      heldBack: Number.MAX_SAFE_INTEGER,
      next: longestCursor(),
      caughtUp: false,
      clamps: CLAMPS,
      thread: { total: Number.MAX_SAFE_INTEGER, truncated: true },
      shown: { shown: Number.MAX_SAFE_INTEGER, of: Number.MAX_SAFE_INTEGER },
      knownGaps: true,
    });
    expect(bytesOf(header)).toBeLessThanOrEqual(HEADER_MAX_BYTES);
    expect(bytesOf(renderResult(header, []))).toBeLessThanOrEqual(HEADER_RESERVE);
  });

  const base: HeaderFacts = { tool: "mail_new", items: 1, withCuts: 0, clamps: [] };

  it.each([
    "+5:x",
    "05:x",
    "-0:x",
    "5:",
    ":x",
    "5:a:b",
    "9223372036854775808:x",
    "5:x\n</mail-data>",
    "5:a b",
  ])("fails closed on a next that is not a canonical cursor: %j", (next) => {
    expect(() => renderHeader({ ...base, next })).toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed on a count, total or clamp that is not a non-negative safe integer: %j",
    (bad) => {
      expect(() => renderHeader({ ...base, items: bad })).toThrow();
      expect(() => renderHeader({ ...base, withCuts: bad })).toThrow();
      expect(() => renderHeader({ ...base, heldBack: bad })).toThrow();
      expect(() => renderHeader({ ...base, clamps: [{ name: "limit", to: bad }] })).toThrow();
      expect(() => renderHeader({ ...base, thread: { total: bad, truncated: false } })).toThrow();
      expect(() => renderHeader({ ...base, shown: { shown: bad, of: 1 } })).toThrow();
      expect(() => renderHeader({ ...base, shown: { shown: 1, of: bad } })).toThrow();
    },
  );

  it("accepts zero and the largest safe integer", () => {
    expect(() => renderHeader({ ...base, items: 0, heldBack: 0 })).not.toThrow();
    expect(() => renderHeader({ ...base, items: Number.MAX_SAFE_INTEGER })).not.toThrow();
  });
});

// ------------------------------------------------------------ mailboxes

describe("mailboxes (RV-015 F-26)", () => {
  const big = (n: number): ReturnType<typeof projectMailbox> =>
    projectMailbox(
      mailboxOf({
        id: idOf(255, `Mbx${String(n)}`),
        name: "<&>".repeat(40),
        parent_id: idOf(255, "Parent"),
      }),
    );

  it("200 mailboxes with 255-byte ids and escaped names stay within MAIL_MAX_BYTES, shown N of 200", () => {
    const mailboxes = Array.from({ length: 200 }, (_, n) => big(n));
    const result = renderMailboxes(mailboxes);
    expect(bytesOf(result)).toBeLessThanOrEqual(MAIL_MAX_BYTES);
    const lines = dataLinesOf(result);
    const header = headerLinesOf(result);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(200);
    expect(header).toContain(`shown ${String(lines.length)} of 200`);
    expect(header[0]).toBe(`mail_mailboxes: ${String(lines.length)} items, 0 with cuts`);
    lines.forEach((line, n) => {
      expect(/[<>&]/.test(line)).toBe(false);
      expect(parseLine(line)).toEqual(jsonRoundTrip(mailboxes[n]));
    });
    // as many as fit: the next one would not
    const used = lines.reduce((sum, line) => sum + bytesOf(line), 0) + (lines.length - 1);
    expect(used).toBeLessThanOrEqual(ITEMS_MAX_BYTES);
    expect(used + 1 + renderedBytes(mailboxes[lines.length])).toBeGreaterThan(ITEMS_MAX_BYTES);
  });

  it("shows every mailbox whole when they all fit", () => {
    const mailboxes = [1, 2, 3].map((n) =>
      projectMailbox(mailboxOf({ id: `M${String(n)}`, name: `Box ${String(n)}` })),
    );
    const result = renderMailboxes(mailboxes);
    expect(dataLinesOf(result)).toEqual(mailboxes.map((m) => dataLine(m)));
    expect(headerLinesOf(result)).toContain("shown 3 of 3");
  });

  it("renders no mailbox as shown 0 of 0", () => {
    const result = renderMailboxes([]);
    expect(dataLinesOf(result)).toEqual([]);
    expect(headerLinesOf(result)).toContain("shown 0 of 0");
  });

  it("stops at the first mailbox that does not fit, without skipping to smaller later ones", () => {
    const small = (n: number): ReturnType<typeof projectMailbox> =>
      projectMailbox(mailboxOf({ id: `S${String(n)}`, name: "s" }));
    const giant = projectMailbox(mailboxOf({ id: "Giant", name: "g".repeat(ITEMS_MAX_BYTES) }));
    const mailboxes = [small(1), small(2), giant, small(3), small(4)];
    const { lines, shown, of } = fitMailboxes(mailboxes);
    expect(shown).toBe(2);
    expect(of).toBe(5);
    expect(lines).toEqual([dataLine(small(1)), dataLine(small(2))]);
    const first = fitMailboxes([giant, small(1)]);
    expect(first).toEqual({ lines: [], shown: 0, of: 2 });
  });
});

// ------------------------------------------------------------ the page

describe("renderResult", () => {
  it("is the header, the data block and nothing else", () => {
    expect(renderResult("H", ["a", "b"])).toBe(
      'H\n<mail-data untrusted="true">\na\nb\n</mail-data>',
    );
    expect(renderResult("H", [])).toBe('H\n<mail-data untrusted="true">\n</mail-data>');
  });

  it("fails closed beyond MAIL_MAX_BYTES", () => {
    expect(() => renderResult("H", ["x".repeat(MAIL_MAX_BYTES)])).toThrow();
  });
});

describe("renderPage", () => {
  const long = "s".repeat(300);

  it("throws when there are more items than the limit", () => {
    const items = [
      projectListItem(summaryOf({ id: "A" })),
      projectListItem(summaryOf({ id: "B" })),
    ];
    expect(() => renderPage({ tool: "mail_list", clamps: [] }, items, 1)).toThrow();
    expect(() => renderPage({ tool: "mail_list", clamps: [] }, items, 2)).not.toThrow();
  });

  it("counts items and items with cuts into the header, and renders one line per item", () => {
    const items = [
      projectListItem(summaryOf({ id: "A", subject: long })),
      projectListItem(summaryOf({ id: "B" })),
      projectListItem(summaryOf({ id: "C", subject: long })),
    ];
    const result = renderPage(
      { tool: "mail_list", clamps: [{ name: "limit", to: 40 }] },
      items,
      40,
    );
    expect(headerLinesOf(result)[0]).toBe("mail_list: 3 items, 2 with cuts");
    expect(headerLinesOf(result)).toContain("limit clamped to 40");
    expect(dataLinesOf(result).map((line) => parseLine(line)["id"])).toEqual(["A", "B", "C"]);
  });

  it("renders a thread entry not in the store as exactly its id and in_store: false", () => {
    const items = [
      projectThreadItem(absentThreadItem("MsgOut")),
      projectThreadItem(inStoreThreadItem()),
    ];
    const result = renderPage(
      { tool: "mail_thread", clamps: [], thread: { total: 5, truncated: true } },
      items,
      40,
    );
    const [first, second] = dataLinesOf(result);
    expect(first).toBe('{"id":"MsgOut","in_store":false}');
    expect(parseLine(second ?? "")["in_store"]).toBe(true);
    expect(headerLinesOf(result)[0]).toBe("mail_thread: 2 items, 0 with cuts");
    expect(headerLinesOf(result)).toContain("total: 5, truncated: true");
  });

  it("passes held back through as a count in the header and held_back: true on the line", () => {
    const result = renderPage(
      { tool: "mail_new", clamps: [], heldBack: 1, next: "", caughtUp: true },
      [projectNew(readOf({ id: "Future" }), true)],
      10,
    );
    expect(headerLinesOf(result)[0]).toBe("mail_new: 1 items, 0 with cuts, 1 held back");
    expect(parseLine(dataLinesOf(result)[0] ?? "")["held_back"]).toBe(true);
  });
});

// ------------------------------------------------------------ property (VT-2)

type Verb = "list" | "thread" | "new" | "read";
const MAX_LIMIT: Record<Verb, number> = { list: 40, thread: 40, new: 20, read: 1 };
const VERBS: readonly Verb[] = ["list", "thread", "new", "read"];
const SEEDS = [1, 20261028, 0xc0ffee];

interface Page {
  items: ProjectedItem[];
  facts: PageFacts;
}

const SIZES: readonly Size[] = ["small", "mixed", "mixed", "max"];

function sizeOf(rng: Rng, index: number): Size {
  return index === 0 && rng.chance(0.5) ? "max" : rng.pick(SIZES);
}

/** `limit` hostile, contract-valid envelopes of one verb, projected. */
function hostilePage(verb: Verb, rng: Rng, limit: number): Page {
  const indexes = Array.from({ length: limit }, (_, n) => n);
  switch (verb) {
    case "list": {
      const summaries = indexes.map((n) => randomSummary(rng, sizeOf(rng, n), `i${String(n)}`));
      const data = mustCheck("list", { offset: 0, limit, items: summaries });
      return {
        items: data.items.map((s) => projectListItem(s, rng.chance(0.2))),
        facts: { tool: "mail_list", clamps: [] },
      };
    }
    case "thread": {
      const entries = indexes.map((n) => randomThreadItem(rng, sizeOf(rng, n), `i${String(n)}`));
      const data = mustCheck("thread", {
        id: "Thread1",
        total: limit,
        truncated: false,
        items: entries,
      });
      return {
        items: data.items.map((entry) => projectThreadItem(entry)),
        facts: { tool: "mail_thread", clamps: [], thread: { total: limit, truncated: false } },
      };
    }
    case "new":
    case "read": {
      const reads = indexes.map((n) =>
        mustCheck("read", randomRead(rng, sizeOf(rng, n), `i${String(n)}`)),
      );
      const items = reads.map((r) =>
        verb === "new" ? projectNew(r, rng.chance(0.2)) : projectRead(r),
      );
      const facts: PageFacts =
        verb === "new"
          ? { tool: "mail_new", clamps: [], next: reads.at(-1)?.cursor ?? "", caughtUp: limit < 20 }
          : { tool: "mail_read", clamps: [] };
      return { items, facts };
    }
  }
}

/** One line is its item: core whole and in order, no fill field both shown and named, body honest. */
function expectLineFaithful(line: string, item: ProjectedItem, label: string): void {
  const parsed = parseLine(line);
  expect(parsed["id"], label).toBe(coreOf(item)["id"]);
  expectCoreWhole(parsed, item);
  const cut = cutNamesOf(parsed);
  for (const [name] of item.fill) {
    expect(name in parsed, `${label} ${name}`).toBe(!cut.includes(name));
  }
  if (item.body !== undefined) {
    expectBodyHonest(parsed, item, cut, label);
  }
}

function expectBodyHonest(
  parsed: Record<string, unknown>,
  item: ProjectedItem,
  cut: unknown[],
  label: string,
): void {
  if (cut.includes("body")) {
    expect(parsed["output_truncated"], label).toBe(true);
    const kept = parsed["body"];
    if (typeof kept === "string") {
      expect((item.body ?? "").startsWith(kept), label).toBe(true);
    }
  } else {
    expect(parsed["body"], label).toBe(item.body);
    expect(parsed["output_truncated"], label).toBe(coreOf(item)["output_truncated"]);
  }
}

function expectPageHolds(result: string, page: Page, label: string): void {
  expect(bytesOf(result), `${label} total`).toBeLessThanOrEqual(MAIL_MAX_BYTES);
  const lines = dataLinesOf(result);
  expect(lines, `${label} line count: no item dropped`).toHaveLength(page.items.length);
  page.items.forEach((item, n) => {
    expectLineFaithful(lines[n] ?? "", item, `${label} item ${String(n)}`);
  });
  const withCuts = lines.filter((line) => cutNamesOf(parseLine(line)).length > 0).length;
  expect(headerLinesOf(result)[0], label).toContain(
    `${String(page.items.length)} items, ${String(withCuts)} with cuts`,
  );
}

describe("hostile envelopes at every limit (VT-2, RV-015 F-3, F-4, F-26)", () => {
  const cases = SEEDS.flatMap((seed) => VERBS.map((verb): [number, Verb] => [seed, verb]));

  it.each(cases)(
    "seed %i, %s: every result within MAIL_MAX_BYTES, every core whole, no item dropped",
    (seed, verb) => {
      const rng = makeRng(seed);
      for (let limit = 1; limit <= MAX_LIMIT[verb]; limit++) {
        const page = hostilePage(verb, rng, limit);
        const result = renderPage(page.facts, page.items, limit);
        expectPageHolds(result, page, `seed ${String(seed)} ${verb} limit ${String(limit)}`);
      }
    },
  );

  it("is deterministic: one seed makes the same pages", () => {
    const render = (): string => {
      const page = hostilePage("list", makeRng(7), 12);
      return renderPage(page.facts, page.items, 12);
    };
    expect(render()).toBe(render());
  });
});
