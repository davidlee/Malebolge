import { describe, expect, it } from "vitest";
import { boundedLineSplitter, encodeLine, lineSplitter } from "../src/ndjson.ts";

const collect = (): { lines: string[]; push: (chunk: Buffer | string) => void } => {
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

const bounded = (
  maxBytes: number,
): {
  lines: string[];
  oversize: () => number;
  splitter: ReturnType<typeof boundedLineSplitter>;
} => {
  const lines: string[] = [];
  let oversized = 0;
  const splitter = boundedLineSplitter({
    maxBytes,
    onLine: (line) => lines.push(line),
    onOversize: () => {
      oversized += 1;
    },
  });
  return { lines, oversize: () => oversized, splitter };
};

describe("boundedLineSplitter", () => {
  it("passes a line exactly at the cap, counted in UTF-8 bytes", () => {
    const { lines, oversize, splitter } = bounded(4);
    splitter.push("a€");
    expect(splitter.carriedBytes()).toBe(4);
    splitter.push("\n");
    expect(lines).toEqual(["a€"]);
    expect(oversize()).toBe(0);
  });

  it("drops a line one byte over the cap, once, and keeps the next line", () => {
    const { lines, oversize, splitter } = bounded(4);
    splitter.push("abcde\nok\n");
    expect(lines).toEqual(["ok"]);
    expect(oversize()).toBe(1);
  });

  it("counts an oversize line split across many chunks once, and carries nothing of it", () => {
    const { lines, oversize, splitter } = bounded(4);
    let peak = 0;
    for (const chunk of ["ab", "cd", "ef", "gh", "ij", "k\nnext", "\n"]) {
      splitter.push(chunk);
      peak = Math.max(peak, splitter.carriedBytes());
    }
    expect(lines).toEqual(["next"]);
    expect(oversize()).toBe(1);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("is unbounded at maxBytes Infinity", () => {
    const { splitter } = bounded(Infinity);
    splitter.push("x".repeat(100));
    expect(splitter.carriedBytes()).toBe(100);
  });
});

describe("encodeLine", () => {
  it("is one JSON document terminated by a newline", () => {
    expect(encodeLine({ s: "a\nb" })).toBe('{"s":"a\\nb"}\n');
  });
});
