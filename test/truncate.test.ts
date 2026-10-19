import { describe, expect, it } from "vitest";
import { capUtf8, headKeeper, truncateLine } from "../src/truncate.ts";

describe("capUtf8", () => {
  it("leaves text that fits, including exactly at the cap", () => {
    expect(capUtf8("abc", 3)).toEqual({ text: "abc", truncated: false });
    expect(capUtf8("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  it("cuts ASCII at the cap", () => {
    expect(capUtf8("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
  });

  it("yields nothing for a zero cap", () => {
    expect(capUtf8("abc", 0)).toEqual({ text: "", truncated: true });
    expect(capUtf8("", 0)).toEqual({ text: "", truncated: false });
  });

  it.each([
    ["2-byte", "é", 2],
    ["3-byte", "€", 3],
    ["4-byte emoji", "😀", 4],
  ])("drops a %s character that straddles the cap, whole", (_name, char, width) => {
    for (let cap = 1; cap < width; cap++) {
      expect(capUtf8(`a${char}`, 1 + cap)).toEqual({ text: "a", truncated: true });
    }
    expect(capUtf8(`a${char}b`, 1 + width)).toEqual({ text: `a${char}`, truncated: true });
  });
});

describe("truncateLine", () => {
  it("keeps a line at or under the max", () => {
    expect(truncateLine("abc", 5)).toEqual({ text: "abc", wasTruncated: false });
    expect(truncateLine("abcde", 5)).toEqual({ text: "abcde", wasTruncated: false });
  });

  it("cuts a longer line and says so, as pi does", () => {
    expect(truncateLine("abcdef", 5)).toEqual({ text: "abcde... [truncated]", wasTruncated: true });
  });
});

describe("headKeeper", () => {
  it("keeps chunks up to the cap and is not full at exactly the cap", () => {
    const keeper = headKeeper(4);
    keeper.accept("ab");
    keeper.accept("cd");
    expect([keeper.text, keeper.bytes, keeper.full]).toEqual(["abcd", 4, false]);
  });

  it("cuts the chunk that passes the cap on a character boundary and drops the rest", () => {
    const keeper = headKeeper(4);
    keeper.accept("ab€");
    keeper.accept("more");
    expect([keeper.text, keeper.bytes, keeper.full]).toEqual(["ab", 2, true]);
  });
});
