// VT-1 to VT-3: the generic untrusted data block — whole values kept in the
// items' room, the tagged wrapper and its escapes, and the count check.

import { describe, expect, it } from "vitest";
import {
  count,
  dataLine,
  fitWhole,
  HEADER_MAX_BYTES,
  HEADER_RESERVE,
  ITEMS_MAX_BYTES,
  RESULT_MAX_BYTES,
  renderBlock,
  untrustedLine,
  WRAPPER_BYTES,
} from "../src/untrusted-block.ts";

/** The bytes `value` takes on its data line, the one measure here. */
const bytesOf = (value: unknown): number => Buffer.byteLength(dataLine(value), "utf8");

describe("fitWhole", () => {
  it("keeps every value whole, in order, when they all fit", () => {
    const values = [
      { id: "A", name: "one" },
      { id: "B", name: "two" },
      { id: "C", name: "three" },
    ];
    expect(fitWhole(values)).toEqual({
      lines: values.map((value) => dataLine(value)),
      shown: 3,
      of: 3,
    });
  });

  it("keeps as many whole values as fit ITEMS_MAX_BYTES and reports shown of of", () => {
    const values = Array.from({ length: 200 }, (_, n) => ({
      id: `M${String(n)}`,
      name: "<&>".repeat(40),
    }));
    const { lines, shown, of } = fitWhole(values);
    expect(of).toBe(200);
    expect(shown).toBe(lines.length);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(values.length);
    const used = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0) + (lines.length - 1);
    expect(used).toBeLessThanOrEqual(ITEMS_MAX_BYTES);
    // as many as fit: the next one would not
    expect(used + 1 + bytesOf(values[lines.length])).toBeGreaterThan(ITEMS_MAX_BYTES);
  });

  it("stops at the first value that does not fit, without skipping to smaller later ones", () => {
    const small = (n: number): { id: string; name: string } => ({
      id: `S${String(n)}`,
      name: "s",
    });
    const giant = { id: "Giant", name: "g".repeat(ITEMS_MAX_BYTES) };
    const values = [small(1), small(2), giant, small(3), small(4)];
    expect(fitWhole(values)).toEqual({
      lines: [dataLine(small(1)), dataLine(small(2))],
      shown: 2,
      of: 5,
    });
    expect(fitWhole([giant, small(1)])).toEqual({ lines: [], shown: 0, of: 2 });
  });

  it("renders no value as shown 0 of 0", () => {
    expect(fitWhole([])).toEqual({ lines: [], shown: 0, of: 0 });
  });
});

describe("untrustedLine", () => {
  it.each(["x-data", "bookmark-data"])("names %s, on one line", (tag) => {
    const line = untrustedLine(tag);
    expect(line).toContain(tag);
    expect(line).not.toContain("\n");
    expect(line.trim()).not.toBe("");
  });
});

describe("renderBlock", () => {
  it.each(["x-data", "bookmark-data"])(
    "writes untrustedLine(%s) as the line right before the opening tag",
    (tag) => {
      const lines = renderBlock(tag, "H", ["a"]).split("\n");
      const open = lines.indexOf(`<${tag} untrusted="true">`);
      expect(open).toBeGreaterThan(0);
      expect(lines[open - 1]).toBe(untrustedLine(tag));
    },
  );

  it("keeps the wrapper's room at the longest tag in use (bookmark-data)", () => {
    expect(HEADER_MAX_BYTES + WRAPPER_BYTES).toBe(HEADER_RESERVE);
    const header = "h".repeat(HEADER_MAX_BYTES);
    // One line and its newline are exactly the items' room.
    const item = "i".repeat(ITEMS_MAX_BYTES - 1);
    expect(() => renderBlock("bookmark-data", header, [item])).not.toThrow();
  });

  it("is the header, the tagged wrapper and one line each", () => {
    expect(renderBlock("x-data", "H", ["a", "b"])).toBe(
      `H\n${untrustedLine("x-data")}\n<x-data untrusted="true">\na\nb\n</x-data>`,
    );
  });

  it("wraps an empty body as the open and close tag only", () => {
    expect(renderBlock("x-data", "H", [])).toBe(
      `H\n${untrustedLine("x-data")}\n<x-data untrusted="true">\n</x-data>`,
    );
  });

  it("carries a data line with no raw <, > or &", () => {
    const line = dataLine("<a>&");
    expect(/[<>&]/.test(line)).toBe(false);
    expect(line).toContain("\\u003c");
    expect(line).toContain("\\u003e");
    expect(line).toContain("\\u0026");
    expect(renderBlock("x-data", "H", [line])).toBe(
      `H\n${untrustedLine("x-data")}\n<x-data untrusted="true">\n${line}\n</x-data>`,
    );
  });

  it("fails closed beyond RESULT_MAX_BYTES", () => {
    expect(() => renderBlock("x-data", "H", ["x".repeat(RESULT_MAX_BYTES)])).toThrow();
  });

  it("keeps the whole result within 50 KiB", () => {
    expect(RESULT_MAX_BYTES).toBe(51200);
  });
});

describe("count", () => {
  it("refuses a negative or a fractional value", () => {
    expect(() => count(-1, "items")).toThrow("header: items is not a count");
    expect(() => count(1.5, "items")).toThrow("header: items is not a count");
  });

  it("returns a non-negative safe integer", () => {
    expect(count(3, "x")).toBe(3);
  });
});
