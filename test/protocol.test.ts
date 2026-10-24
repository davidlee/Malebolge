import { describe, expect, it } from "vitest";
import {
  FrameRefused,
  parseClientMessage,
  parseConnectionMessage,
  parseFirstLineFrame,
} from "../src/protocol.ts";

describe("parseClientMessage", () => {
  it.each([
    [{ type: "input", content: "hi" }],
    [{ type: "input", content: "hi", requestId: "r1" }],
    [{ type: "abort" }],
    [{ type: "compact" }],
    [{ type: "compact", instructions: "keep test names" }],
  ])("accepts %j", (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    ["not json", /JSON/],
    ['{"type":"input"}', /content/],
    ['{"type":"input","content":3}', /content/],
    ['{"type":"compact","instructions":1}', /instructions/],
    ['{"type":"warp"}', /warp/],
    ["[]", /object/],
  ])("rejects %s", (line, reason) => {
    expect(() => parseClientMessage(line)).toThrow(reason);
  });
});

/** The message `read` throws; "" when it throws nothing. */
function errorOf(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("parseConnectionMessage", () => {
  it.each([
    [{ type: "attach" }, { kind: "root" }],
    [
      { type: "attach", conversation: 3 },
      { kind: "existing", id: 3 },
    ],
    [{ type: "attach", new: true }, { kind: "new" }],
    [
      { type: "attach", new: true, cwd: "/tmp/work" },
      { kind: "new", cwd: "/tmp/work" },
    ],
    [
      { type: "attach", new: true, cwd: "" },
      { kind: "new", cwd: "" },
    ],
    [
      { type: "attach", new: true, cwd: "  /tmp/work  " },
      { kind: "new", cwd: "  /tmp/work  " },
    ],
  ])("accepts %j", (message, target) => {
    expect(parseConnectionMessage(JSON.stringify(message))).toEqual({ type: "attach", target });
  });

  it.each([
    [{ type: "attach", conversation: 1, new: true }],
    [{ type: "attach", cwd: "/tmp" }],
    [{ type: "attach", conversation: 1, cwd: "/tmp" }],
    [{ type: "attach", new: false }],
    [{ type: "attach", new: 1 }],
    [{ type: "attach", new: "true" }],
    [{ type: "attach", new: null }],
    [{ type: "attach", conversation: 0 }],
    [{ type: "attach", conversation: -1 }],
    [{ type: "attach", conversation: 1.5 }],
    [{ type: "attach", conversation: 2 ** 53 }],
    [{ type: "attach", conversation: "3" }],
    [{ type: "attach", conversation: null }],
    [{ type: "attach", new: true, cwd: 1 }],
    [{ type: "attach", new: true, cwd: null }],
    [{ type: "attach", new: true, cwd: true }],
    [{ type: "attach", topic: "x" }],
    [{ type: "attach", conversation: 1, topic: "x" }],
    [{ type: "attach", new: true, cwd: "/tmp", topic: "x" }],
  ])("refuses %j", (message) => {
    expect(() => parseConnectionMessage(JSON.stringify(message))).toThrow(FrameRefused);
  });

  /** Every first-line frame names itself, so a refusal cannot be mistaken for the other. */
  it.each([
    ['{"type":"attach","conversation":0}', "attach: conversation must be a positive integer"],
    ['{"type":"attach","topic":"x"}', "attach: unknown key topic"],
    ['{"type":"list","topic":"x"}', "list: unknown key topic"],
    ['{"type":"list","conversation":3}', "list: unknown key conversation"],
  ])("names the frame that refused %s", (line, message) => {
    expect(errorOf(() => parseConnectionMessage(line))).toBe(message);
  });

  it("parses a list frame", () => {
    expect(parseConnectionMessage('{"type":"list"}')).toEqual({ type: "list" });
  });

  it.each([
    [{ type: "input", content: "hi" }],
    [{ type: "input", content: "hi", requestId: "r1" }],
    [{ type: "abort" }],
    [{ type: "compact" }],
    [{ type: "compact", instructions: "keep test names" }],
  ])("parses %j as parseClientMessage does", (message) => {
    const line = JSON.stringify(message);
    expect(parseConnectionMessage(line)).toEqual(parseClientMessage(line));
  });

  it.each([
    "not json",
    "[]",
    '{"type":"input"}',
    '{"type":"input","content":3}',
    '{"type":"warp"}',
  ])("keeps parseClientMessage's error for %s", (line) => {
    expect(errorOf(() => parseConnectionMessage(line))).toBe(
      errorOf(() => parseClientMessage(line)),
    );
  });

  it("reports a non-frame parse error, not a FrameRefused", () => {
    let thrown: unknown;
    try {
      parseConnectionMessage('{"type":"warp"}');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(FrameRefused);
  });

  it("leaves parseClientMessage unaware of the first-line frames", () => {
    expect(() => parseClientMessage('{"type":"attach"}')).toThrow('unknown message type "attach"');
    expect(() => parseClientMessage('{"type":"list"}')).toThrow('unknown message type "list"');
  });
});

/** The daemon's dispatch table has one row per frame here (SL-003 PHASE-02, design sec-4). */
describe("parseFirstLineFrame", () => {
  it.each([
    [{ type: "attach" }, { kind: "root" }],
    [
      { type: "attach", conversation: 3 },
      { kind: "existing", id: 3 },
    ],
    [
      { type: "attach", new: true, cwd: "/tmp/work" },
      { kind: "new", cwd: "/tmp/work" },
    ],
  ])("parses the attach frame %j", (message, target) => {
    expect(parseFirstLineFrame(message)).toEqual({ type: "attach", target });
  });

  it("parses the list frame", () => {
    expect(parseFirstLineFrame({ type: "list" })).toEqual({ type: "list" });
  });

  it.each([[{ type: "input", content: "hi" }], [{ type: "abort" }], [{ type: "warp" }], [{}]])(
    "leaves %j to the client parser",
    (message) => {
      expect(parseFirstLineFrame(message)).toBeUndefined();
    },
  );

  it.each([
    [{ type: "attach", topic: "x" }, "attach: unknown key topic"],
    [{ type: "attach", conversation: 0 }, "attach: conversation must be a positive integer"],
    [{ type: "list", topic: "x" }, "list: unknown key topic"],
  ])("refuses %j strictly", (message, refusal) => {
    expect(errorOf(() => parseFirstLineFrame(message))).toBe(refusal);
  });
});
