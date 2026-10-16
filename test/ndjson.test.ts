import { describe, expect, it } from "vitest";
import { encodeLine, lineSplitter } from "../src/ndjson.ts";

const collect = () => {
  const lines: string[] = [];
  return { lines, push: lineSplitter((line) => lines.push(line)) };
};

describe("lineSplitter", () => {
  it("emits each complete line once, across chunk boundaries", () => {
    const { lines, push } = collect();
    push('{"a":');
    push('1}\n{"b"');
    push(":2}\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("holds an unterminated tail until its newline arrives", () => {
    const { lines, push } = collect();
    push("partial");
    expect(lines).toEqual([]);
    push("\n");
    expect(lines).toEqual(["partial"]);
  });

  it("skips blank lines and strips CR", () => {
    const { lines, push } = collect();
    push("\n  \nx\r\n");
    expect(lines).toEqual(["x"]);
  });

  it("decodes multi-byte UTF-8 split across Buffer chunks", () => {
    const { lines, push } = collect();
    const bytes = Buffer.from("€\n");
    push(bytes.subarray(0, 1));
    push(bytes.subarray(1));
    expect(lines).toEqual(["€"]);
  });
});

describe("encodeLine", () => {
  it("is one JSON document terminated by a newline", () => {
    expect(encodeLine({ s: "a\nb" })).toBe('{"s":"a\\nb"}\n');
  });
});
