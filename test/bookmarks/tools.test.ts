// VT-1: bookmarks_search matching — every query term a substring across the
// capped title, url, tags or folder; case-insensitive; tag equality (not a
// substring); folder a prefix at a segment boundary (Menu/dev matches
// Menu/dev/cli, not Menu/devops); filters AND; order added desc with missing
// added last and guid ascending on ties.
// VT-2: paging and bounds — limit 1-200 (default 50) and offset 0-10000 (default
// 0), next_offset with no skip or repeat, none on the last page, out-of-range
// bounds clamped and named in the header, offset 1e21 clamped rather than thrown.
// VT-3: input refusals before the source is read — oversize query/tag/folder,
// non-string and non-object arguments refused with no source call recorded and
// no part of the value in the text; exactly-at-cap accepted with one call.
// VT-4: bookmarks_tags counts and order (count desc, tag asc); bookmarks_folders
// every folder in path order with empty ones included; not_configured and other
// source errors as error results, never an empty page.
// VT-5: each description carries the staleness, structure-first and cap clauses;
// search adds several searches / paging; folders direct counts vs subfolders.
// Every tool: replay "safe", exactly one text output.

import { type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  BookmarkSourceError,
  type BookmarkSource,
  unconfiguredSource,
} from "../../src/bookmarks/backup.ts";
import type { Bookmark } from "../../src/bookmarks/project.ts";
import { bookmarkTools } from "../../src/bookmarks/tools.ts";
import { context } from "../../src/context.ts";
import { type JsonRecord, isRecord } from "../../src/json.ts";
import { bookmark, fakeBookmarkSource, snapshot } from "./bookmark-fixtures.ts";

// ------------------------------------------------------------------ driving

/** Fixed: the snapshot's date, so the header carries no stale line. */
const NOW = Date.parse("2026-10-29T09:00:00Z");

type ToolName = "bookmarks_search" | "bookmarks_tags" | "bookmarks_folders";

const TOOL_NAMES: readonly ToolName[] = ["bookmarks_search", "bookmarks_tags", "bookmarks_folders"];

interface Outcome {
  readonly text: string;
  readonly isError: boolean;
}

/** The tools execute never reads the api; a stub stands in for the one it is given. */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a stub of the one field a bookmark tool could read
const API = { env: undefined } as unknown as ToolExecutionApi;

function toolsFor(source: BookmarkSource): ToolRegistration[] {
  return bookmarkTools({ source, now: () => NOW });
}

function toolNamed(tools: readonly ToolRegistration[], name: ToolName): ToolRegistration {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return tool;
}

/** Run one tool over `tools`; rejects when the tool throws. */
async function exec(
  tools: readonly ToolRegistration[],
  name: ToolName,
  args: unknown,
): Promise<Outcome> {
  const tool = toolNamed(tools, name);
  const result = await tool.execute(args, API, context);
  const [first, ...rest] = result.output ?? [];
  if (first?.type !== "text" || rest.length > 0) {
    throw new Error("expected exactly one text output");
  }
  return { text: first.text, isError: result.isError === true };
}

/** Run one tool over `source` at NOW. */
async function run(source: BookmarkSource, name: ToolName, args: unknown = {}): Promise<Outcome> {
  return exec(toolsFor(source), name, args);
}

/** The text of a call that must succeed. */
function ok(outcome: Outcome): string {
  expect(outcome.isError).toBe(false);
  return outcome.text;
}

// ----------------------------------------------------------------- readers

const OPEN = '<bookmark-data untrusted="true">';
const CLOSE = "</bookmark-data>";

function resultLines(result: string): { lines: string[]; open: number } {
  const lines = result.split("\n");
  const open = lines.indexOf(OPEN);
  if (open < 0 || lines.at(-1) !== CLOSE) {
    throw new Error("not a bookmark result");
  }
  return { lines, open };
}

/** The trusted header lines, before the block's opening line. */
function headerLinesOf(result: string): string[] {
  const { lines, open } = resultLines(result);
  return lines.slice(0, open);
}

/** The block's data lines, in order, exactly as sent. */
function dataLinesOf(result: string): string[] {
  const { lines, open } = resultLines(result);
  return lines.slice(open + 1, -1);
}

/** One data line parsed back into an object. */
function parseLine(line: string): JsonRecord {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) {
    throw new Error(`not a JSON object: ${line}`);
  }
  return value;
}

/** The block's items, parsed back from their data lines. */
function itemsOf(result: string): JsonRecord[] {
  return dataLinesOf(result).map(parseLine);
}

/** The emitted bookmarks' guids, in order: the page's identity across calls. */
function guidsOf(result: string): string[] {
  return itemsOf(result).map((item) => {
    const guid = item["guid"];
    return typeof guid === "string" ? guid : "";
  });
}

/** The description of one tool, over an empty snapshot. */
function descriptionOf(name: ToolName): string {
  return toolNamed(toolsFor(fakeBookmarkSource(snapshot())), name).description;
}

// ---------------------------------------------------------------- builders

/** A bookmark with no filters to trip: a short title, one folder, one tag. */
function simple(guid: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return bookmark({ guid, ...overrides });
}

// -------------------------------------------------------------- VT-1 search

describe("bookmarks_search", () => {
  it("VT-1 matches when every query term hits a different field", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [
          simple("s1", {
            title: "Async Rust",
            url: "https://a.example.net/x",
            tags: ["lang"],
            folder: "Menu/dev",
          }),
          simple("s2", {
            title: "Async Python",
            url: "https://b.example.net/y",
            tags: ["lang"],
            folder: "Toolbar",
          }),
        ],
      }),
    );

    // One term in the title, one in the folder.
    expect(guidsOf(ok(await run(source, "bookmarks_search", { query: "async dev" })))).toEqual([
      "s1",
    ]);
    // One term in the tags, one in the folder.
    expect(guidsOf(ok(await run(source, "bookmarks_search", { query: "lang toolbar" })))).toEqual([
      "s2",
    ]);
    // A term in the url only.
    expect(
      guidsOf(ok(await run(source, "bookmarks_search", { query: "b.example.net/y" }))),
    ).toEqual(["s2"]);
    // Both terms must hit the same bookmark: "rust" is s1's, "toolbar" s2's.
    expect(guidsOf(ok(await run(source, "bookmarks_search", { query: "rust toolbar" })))).toEqual(
      [],
    );
  });

  it("VT-1 is case-insensitive in every field", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [
          simple("s1", {
            title: "Rust Book",
            url: "https://Example.NET/X",
            tags: ["Lang"],
            folder: "Menu/Dev",
          }),
        ],
      }),
    );
    expect(guidsOf(ok(await run(source, "bookmarks_search", { query: "RUST BOOK" })))).toEqual([
      "s1",
    ]);
    expect(guidsOf(ok(await run(source, "bookmarks_search", { query: "example.net" })))).toEqual([
      "s1",
    ]);
  });

  it("VT-1 a blank query lists all bookmarks", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [simple("s1"), simple("s2"), simple("s3")],
      }),
    );
    for (const query of [undefined, "", "   ", "\t\n"]) {
      expect(itemsOf(ok(await run(source, "bookmarks_search", { query })))).toHaveLength(3);
    }
  });

  it("VT-1 the tag filter is case-insensitive equality, not a substring", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [
          simple("s1", { tags: ["dev"] }),
          simple("s2", { tags: ["devops"] }),
          simple("s3", { tags: ["Dev"] }),
        ],
      }),
    );
    expect(guidsOf(ok(await run(source, "bookmarks_search", { tag: "dev" })))).toEqual([
      "s1",
      "s3",
    ]);
    expect(guidsOf(ok(await run(source, "bookmarks_search", { tag: "DEV" })))).toEqual([
      "s1",
      "s3",
    ]);
    expect(guidsOf(ok(await run(source, "bookmarks_search", { tag: "devops" })))).toEqual(["s2"]);
  });

  it("VT-1 the folder filter is a segment-boundary prefix: Menu/dev, not Menu/devops", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [
          simple("s1", { folder: "Menu/dev" }),
          simple("s2", { folder: "Menu/dev/cli" }),
          simple("s3", { folder: "Menu/devops" }),
          simple("s4", { folder: "Menu/development" }),
        ],
      }),
    );
    expect(guidsOf(ok(await run(source, "bookmarks_search", { folder: "Menu/dev" })))).toEqual([
      "s1",
      "s2",
    ]);
    // Case-insensitive too.
    expect(guidsOf(ok(await run(source, "bookmarks_search", { folder: "menu/DEV" })))).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("VT-1 given filters combine with AND", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [
          simple("s1", { title: "Rust async", tags: ["lang"], folder: "Menu/dev" }),
          simple("s2", { title: "Rust sync", tags: ["lang"], folder: "Toolbar" }),
        ],
      }),
    );
    expect(
      guidsOf(
        ok(
          await run(source, "bookmarks_search", {
            query: "rust",
            tag: "lang",
            folder: "Menu/dev",
          }),
        ),
      ),
    ).toEqual(["s1"]);
    expect(
      guidsOf(ok(await run(source, "bookmarks_search", { query: "rust", folder: "Menu/dev" }))),
    ).toEqual(["s1"]);
    // The tag matches s2 but the folder does not: AND excludes it.
    expect(
      guidsOf(
        ok(
          await run(source, "bookmarks_search", {
            query: "rust",
            tag: "lang",
            folder: "Other",
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("VT-1 orders added descending, with missing added last, guid ascending on ties", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [
          simple("c3", { added: "2026-09-01" }),
          simple("b2", { added: "2026-10-02" }),
          simple("a1", { added: "2026-10-02" }),
          simple("z9"),
          simple("a0"),
        ],
      }),
    );
    expect(guidsOf(ok(await run(source, "bookmarks_search", {})))).toEqual([
      "a1",
      "b2",
      "c3",
      "a0",
      "z9",
    ]);
  });

  it("VT-1 matching reads the capped title, not the page's own title", async () => {
    // The projection already shortened the title: the dropped tail is not in the
    // snapshot at all, so it cannot be matched, while the kept head can.
    const source = fakeBookmarkSource(
      snapshot({ bookmarks: [simple("s1", { title: "Kept head…" })] }),
    );
    expect(guidsOf(ok(await run(source, "bookmarks_search", { query: "kept head" })))).toEqual([
      "s1",
    ]);
    expect(guidsOf(ok(await run(source, "bookmarks_search", { query: "dropped tail" })))).toEqual(
      [],
    );
  });
});

// -------------------------------------------------------------- VT-2 paging

describe("bookmarks_search paging", () => {
  const five = (): Bookmark[] => [
    simple("p0"),
    simple("p1"),
    simple("p2"),
    simple("p3"),
    simple("p4"),
  ];

  it("VT-2 pages with next_offset and no skip or repeat", async () => {
    const source = fakeBookmarkSource(snapshot({ bookmarks: five() }));

    const first = ok(await run(source, "bookmarks_search", { limit: 2 }));
    expect(headerLinesOf(first)).toEqual([
      "bookmarks_search: 2 items, 0 with cuts",
      "matched: 5, next_offset: 2",
      "source: bookmark backup 2026-10-29",
    ]);
    expect(guidsOf(first)).toEqual(["p0", "p1"]);

    const second = ok(await run(source, "bookmarks_search", { limit: 2, offset: 2 }));
    expect(headerLinesOf(second)).toContain("matched: 5, next_offset: 4");
    expect(guidsOf(second)).toEqual(["p2", "p3"]);

    const last = ok(await run(source, "bookmarks_search", { limit: 2, offset: 4 }));
    expect(headerLinesOf(last)).toContain("matched: 5");
    expect(headerLinesOf(last).some((line) => line.includes("next_offset"))).toBe(false);
    expect(guidsOf(last)).toEqual(["p4"]);

    expect([...guidsOf(first), ...guidsOf(second), ...guidsOf(last)]).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
  });

  it("VT-2 clamps limit 0 to 1 and limit 250 to 200, named in the header", async () => {
    const source = fakeBookmarkSource(snapshot({ bookmarks: five() }));
    const one = ok(await run(source, "bookmarks_search", { limit: 0 }));
    expect(headerLinesOf(one)).toContain("limit clamped to 1");
    expect(itemsOf(one)).toHaveLength(1);
    const plenty = ok(await run(source, "bookmarks_search", { limit: 250 }));
    expect(headerLinesOf(plenty)).toContain("limit clamped to 200");
    expect(itemsOf(plenty)).toHaveLength(5);
  });

  it("VT-2 offset 1e21 is clamped to 10000, a result not a throw", async () => {
    const source = fakeBookmarkSource(snapshot({ bookmarks: five() }));
    const outcome = await run(source, "bookmarks_search", { offset: 1e21 });
    const text = ok(outcome);
    expect(headerLinesOf(text)).toContain("offset clamped to 10000");
    expect(headerLinesOf(text).some((line) => line.includes("next_offset"))).toBe(false);
    expect(itemsOf(text)).toEqual([]);
  });

  it("VT-2 clamps the tags and folders offset too", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [simple("s1", { tags: ["dev"] })],
        folders: [{ path: "Menu", count: 1 }],
      }),
    );
    for (const name of ["bookmarks_tags", "bookmarks_folders"] as const) {
      const text = ok(await run(source, name, { offset: 1e21 }));
      expect(headerLinesOf(text)).toContain("offset clamped to 10000");
    }
  });
});

// ------------------------------------------------------------ VT-3 refusals

describe("bookmarks input refusals", () => {
  it("VT-3 refuses a query over 512 bytes with no source call", async () => {
    const source = fakeBookmarkSource(snapshot());
    // Multi-byte characters: 300 chars, 600 bytes, so bytes are not chars.
    const query = `MARKERQ${"é".repeat(300)}`;
    expect(Buffer.byteLength(query, "utf8")).toBeGreaterThan(512);
    const outcome = await run(source, "bookmarks_search", { query });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("512");
    expect(outcome.text).toContain("query");
    expect(outcome.text).not.toContain("MARKERQ");
    expect(source.calls).toHaveLength(0);
  });

  it("VT-3 refuses a tag over 64 bytes with no source call", async () => {
    const source = fakeBookmarkSource(snapshot());
    const tag = `MARKERT${"t".repeat(60)}`;
    expect(Buffer.byteLength(tag, "utf8")).toBeGreaterThan(64);
    const outcome = await run(source, "bookmarks_search", { tag });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("64");
    expect(outcome.text).toContain("tag");
    expect(outcome.text).not.toContain("MARKERT");
    expect(source.calls).toHaveLength(0);
  });

  it("VT-3 refuses a folder over 256 bytes with no source call", async () => {
    const source = fakeBookmarkSource(snapshot());
    const folder = `MARKERF${"f".repeat(250)}`;
    expect(Buffer.byteLength(folder, "utf8")).toBeGreaterThan(256);
    const outcome = await run(source, "bookmarks_search", { folder });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("256");
    expect(outcome.text).toContain("folder");
    expect(outcome.text).not.toContain("MARKERF");
    expect(source.calls).toHaveLength(0);
  });

  it("VT-3 refuses a non-string query with no source call", async () => {
    const source = fakeBookmarkSource(snapshot());
    const outcome = await run(source, "bookmarks_search", { query: 42 });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("query");
    expect(source.calls).toHaveLength(0);
  });

  it("VT-3 accepts a query, tag or folder exactly at its cap, one call through", async () => {
    const at = {
      query: "a".repeat(512),
      tag: "t".repeat(64),
      folder: "f".repeat(256),
    };
    for (const args of [at, { tag: at.tag }, { folder: at.folder }]) {
      const source = fakeBookmarkSource(snapshot());
      expect(ok(await run(source, "bookmarks_search", args))).toContain(OPEN);
      expect(source.calls).toHaveLength(1);
    }
  });

  it.each(TOOL_NAMES)("VT-3 %s refuses non-object arguments", async (name) => {
    const source = fakeBookmarkSource(snapshot());
    const outcome = await run(source, name, "not an object");
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("arguments must be an object");
    expect(source.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------- VT-4 tags, folders

describe("bookmarks_tags", () => {
  it("VT-4 counts each distinct tag, count descending then tag ascending", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        bookmarks: [
          simple("s1", { tags: ["rust", "dev"] }),
          simple("s2", { tags: ["rust"] }),
          simple("s3", { tags: ["dev", "zebra"] }),
          simple("s4", { tags: ["alpha"] }),
        ],
      }),
    );
    const text = ok(await run(source, "bookmarks_tags", {}));
    expect(headerLinesOf(text)).toEqual([
      "bookmarks_tags: shown 4 of 4",
      "source: bookmark backup 2026-10-29",
    ]);
    expect(itemsOf(text)).toEqual([
      { tag: "dev", count: 2 },
      { tag: "rust", count: 2 },
      { tag: "alpha", count: 1 },
      { tag: "zebra", count: 1 },
    ]);
  });
});

describe("bookmarks_folders", () => {
  it("VT-4 lists every folder, empty ones included, sorted by path", async () => {
    const source = fakeBookmarkSource(
      snapshot({
        folders: [
          { path: "Menu/b", count: 0 },
          { path: "Menu/a", count: 2 },
          { path: "Toolbar", count: 1 },
        ],
      }),
    );
    const text = ok(await run(source, "bookmarks_folders", {}));
    expect(headerLinesOf(text)).toEqual([
      "bookmarks_folders: shown 3 of 3",
      "source: bookmark backup 2026-10-29",
    ]);
    expect(itemsOf(text)).toEqual([
      { folder: "Menu/a", count: 2 },
      { folder: "Menu/b", count: 0 },
      { folder: "Toolbar", count: 1 },
    ]);
  });
});

describe("source errors are error results", () => {
  it.each(TOOL_NAMES)("VT-4 %s reports not_configured, never an empty page", async (name) => {
    const outcome = await run(unconfiguredSource(), name, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe("bookmarks are not configured");
    expect(outcome.text).not.toContain(OPEN);
  });

  it.each(TOOL_NAMES)("VT-4 %s passes another source error's message through", async (name) => {
    const source = fakeBookmarkSource(
      new BookmarkSourceError("corrupt", "the bookmark backup is corrupt"),
    );
    const outcome = await run(source, name, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe("the bookmark backup is corrupt");
    expect(outcome.text).not.toContain(OPEN);
  });
});

// ------------------------------------------------- VT-5 the tool descriptions

describe("descriptions", () => {
  it.each(TOOL_NAMES)(
    "VT-5 %s names the backup's staleness, the two structure tools and every cap",
    (name) => {
      const description = descriptionOf(name);
      expect(description).toContain("up to a day");
      expect(description).toContain("bookmarks_tags");
      expect(description).toContain("bookmarks_folders");
      expect(description).toContain("capped fields");
      // "20" alone is a substring of "200": pin the tag-count phrase instead.
      for (const cap of ["200", "512", "64", "256"]) {
        expect(description).toContain(cap);
      }
      expect(description).toContain("at most 20 tags");
    },
  );

  it("VT-5 the search description says several searches or paging the full list", () => {
    const description = descriptionOf("bookmarks_search");
    expect(description).toContain("several searches");
    expect(description).toContain("page");
  });

  it("VT-5 the folders description tells direct counts from the search's subfolders", () => {
    const description = descriptionOf("bookmarks_folders");
    expect(description).toContain("direct");
    expect(description).toContain("subfolder");
  });
});

// --------------------------------------------------------- every tool shape

describe("every tool", () => {
  it.each(TOOL_NAMES)("VT-1 %s is replay safe with one text output", async (name) => {
    const tools = toolsFor(fakeBookmarkSource(snapshot({ bookmarks: [simple("s1")] })));
    const tool = toolNamed(tools, name);
    expect(tool.replay).toBe("safe");
    const result = await tool.execute({}, API, context);
    expect(result.isError).toBe(false);
    expect(result.output).toHaveLength(1);
    expect(result.output?.[0]?.type).toBe("text");
  });
});
