// VT-4: the bounds every tool shares — a value clamped into its range, and the
// header's one entry per clamped name.

import { describe, expect, it } from "vitest";
import { bounded, type Clamp, report, type Range } from "../src/ranges.ts";

const RANGE: Range = { min: 2, max: 8, default: 5 };

const clampsOf = (): Clamp<"limit" | "offset">[] => [];

describe("bounded", () => {
  it.each([
    ["an omitted value", undefined],
    ["a non-integer number", 2.5],
    ["a numeric string", "5"],
  ])("takes the default for %s, reporting nothing", (_label, raw) => {
    const clamps = clampsOf();
    expect(bounded(raw, RANGE, "limit", clamps)).toBe(RANGE.default);
    expect(clamps).toEqual([]);
  });

  it("clamps below min and above max, pushing one entry each", () => {
    const below = clampsOf();
    expect(bounded(0, RANGE, "limit", below)).toBe(RANGE.min);
    expect(below).toEqual([{ name: "limit", to: RANGE.min }]);
    const above = clampsOf();
    expect(bounded(99, RANGE, "offset", above)).toBe(RANGE.max);
    expect(above).toEqual([{ name: "offset", to: RANGE.max }]);
  });

  it("reports nothing for a value in range, the bounds included", () => {
    const clamps = clampsOf();
    expect(bounded(RANGE.min, RANGE, "limit", clamps)).toBe(RANGE.min);
    expect(bounded(RANGE.max, RANGE, "offset", clamps)).toBe(RANGE.max);
    expect(clamps).toEqual([]);
  });
});

describe("report", () => {
  it("keeps one entry per name, holding the last value", () => {
    const clamps = clampsOf();
    report(clamps, "limit", 3);
    report(clamps, "limit", 4);
    expect(clamps).toEqual([{ name: "limit", to: 4 }]);
  });

  it("keeps one entry per distinct name", () => {
    const clamps = clampsOf();
    report(clamps, "limit", 3);
    report(clamps, "offset", 1);
    expect(clamps).toEqual([
      { name: "limit", to: 3 },
      { name: "offset", to: 1 },
    ]);
  });
});
