// VT-3: presence is read from the one text satan-mcp returns. The fixtures are
// real prin1-to-string output; the window title carries an escaped \"idle\"
// that must not be mistaken for the presence fact (SL-034 design § WakePolicy; PHASE-01 VT-3).

import { describe, expect, it } from "vitest";
import type { Presence } from "../src/wake/policy.ts";
import { presenceOf, type ToolResultText } from "../src/wake/presence.ts";

/** The fact satan-mcp reports for a current window with `presence` recorded. */
const current = (presence: string): string =>
  String.raw`(:scope "current" :status "ok" :window (:app_id "firefox" :title "x :presence \"idle\" y" :since "2026-10-28T10:00:00+11:00") :presence (:status "ok" :window_minutes 10 :key_seconds 41 :pointer_seconds 12 :presence "${presence}"))`;

const TYPING = current("typing");
const READING = current("reading");
const MIXED = current("mixed");
const IDLE = current("idle");
const MISSING = String.raw`(:scope "current" :status "missing" :window nil :presence (:status "missing"))`;

/** A tool result whose only content is `text`. */
const text = (value: string): ToolResultText => ({ content: [{ type: "text", text: value }] });

/** The verdict for a result whose only content is `value`. */
const verdict = (value: string): Presence => presenceOf(text(value));

describe("presenceOf", () => {
  it.each([
    ["typing", TYPING],
    ["reading", READING],
    ["mixed", MIXED],
  ])("reads %s as present", (_label, result) => {
    expect(verdict(result)).toBe("present");
  });

  it("reads idle as away, not the escaped idle in the window title", () => {
    expect(verdict(IDLE)).toBe("away");
  });

  it("does not read the escaped idle in a title as a fact at all", () => {
    expect(
      verdict(
        String.raw`(:scope "current" :status "ok" :window (:app_id "firefox" :title "x :presence \"idle\" y"))`,
      ),
    ).toBe("unknown");
  });

  it("reads a missing presence fact as unknown", () => {
    expect(verdict(MISSING)).toBe("unknown");
  });

  it("reads a disabled satan-mcp as unknown", () => {
    const disabled: ToolResultText = {
      content: [{ type: "text", text: "satan-mcp disabled" }],
      isError: true,
    };
    expect(presenceOf(disabled)).toBe("unknown");
  });

  it("reads an error result as unknown, whatever its text says", () => {
    expect(presenceOf({ ...text(TYPING), isError: true })).toBe("unknown");
  });

  it("reads empty content as unknown", () => {
    expect(presenceOf({ content: [] })).toBe("unknown");
  });

  it("reads the first match, across text items", () => {
    const both = (first: string, second: string): ToolResultText => ({
      content: [...text(first).content, ...text(second).content],
    });
    expect(presenceOf(both(TYPING, IDLE))).toBe("present");
    expect(presenceOf(both(IDLE, TYPING))).toBe("away");
  });

  it("skips items that are not text", () => {
    expect(presenceOf({ content: [{ type: "image" }, { type: "text", text: TYPING }] })).toBe(
      "present",
    );
  });
});
