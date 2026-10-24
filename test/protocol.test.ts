import { describe, expect, it } from "vitest";
import {
  FrameRefused,
  parseClientMessage,
  parseConnectionMessage,
  parseFirstLineFrame,
  topicNameOf,
} from "../src/protocol.ts";
import { NAME_RULE } from "./harness-fixture.ts";

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
    [
      { type: "attach", topic: "work" },
      { kind: "topic", name: "work", new: false },
    ],
    [
      { type: "attach", topic: "default" },
      { kind: "topic", name: "default", new: false },
    ],
    [
      { type: "attach", topic: "work", new: true },
      { kind: "topic", name: "work", new: true },
    ],
    [
      { type: "attach", topic: "work", new: true, cwd: "/tmp/work" },
      { kind: "topic", name: "work", new: true, cwd: "/tmp/work" },
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
    [{ type: "attach", conversation: 1, topic: "work" }],
    [{ type: "attach", topic: "work", cwd: "/tmp" }],
    [{ type: "attach", topic: "work", new: false }],
    [{ type: "attach", topic: "work", new: true, cwd: 1 }],
    [{ type: "attach", topic: "work", new: true, cwd: null }],
  ])("refuses %j", (message) => {
    expect(() => parseConnectionMessage(JSON.stringify(message))).toThrow(FrameRefused);
  });

  /** Every refusal of the widened frames, in design sec-4's words (PHASE-03 EX-1). */
  it.each([
    ['{"type":"attach","conversation":0}', "attach: conversation must be a positive integer"],
    ['{"type":"attach","topic":"A"}', `attach: ${NAME_RULE}`],
    [
      '{"type":"attach","topic":"work","conversation":1}',
      "attach: conversation and topic are exclusive",
    ],
    ['{"type":"attach","topic":"work","cwd":"/tmp"}', "attach: cwd needs new"],
    ['{"type":"attach","topic":"work","new":false}', "attach: new must be true"],
    ['{"type":"attach","topic":"work","new":true,"cwd":1}', "attach: cwd must be a string"],
    ['{"type":"list","topic":"work","topics":true}', "list: topic and topics are exclusive"],
    ['{"type":"list","topics":false}', "list: topics must be true"],
    ['{"type":"list","topics":"yes"}', "list: topics must be true"],
    ['{"type":"list","topic":"A"}', `list: ${NAME_RULE}`],
    ['{"type":"list","page":2}', "list: unknown key page"],
    ['{"type":"list","conversation":3}', "list: unknown key conversation"],
    ['{"type":"topic","name":"default"}', "topic: default is reserved"],
    ['{"type":"topic","name":"default","cwd":"/tmp"}', "topic: default is reserved"],
    ['{"type":"topic","name":"work","cwd":1}', "topic: cwd must be a string or null"],
    ['{"type":"topic","name":"work","cwd":false}', "topic: cwd must be a string or null"],
    ['{"type":"topic","name":"A"}', `topic: ${NAME_RULE}`],
    ['{"type":"topic"}', `topic: ${NAME_RULE}`],
    ['{"type":"topic","name":"work","conversation":3}', "topic: unknown key conversation"],
  ])("names the frame that refused %s", (line, message) => {
    expect(errorOf(() => parseConnectionMessage(line))).toBe(message);
  });

  it.each([
    [{ type: "list" }, { type: "list", query: { kind: "all" } }],
    [
      { type: "list", topic: "work" },
      { type: "list", query: { kind: "topic", name: "work" } },
    ],
    [
      { type: "list", topics: true },
      { type: "list", query: { kind: "topics" } },
    ],
    [
      { type: "topic", name: "work" },
      { type: "topic", name: "work" },
    ],
    [
      { type: "topic", name: "work", cwd: "/tmp" },
      { type: "topic", name: "work", cwd: "/tmp" },
    ],
    [
      { type: "topic", name: "work", cwd: null },
      { type: "topic", name: "work", cwd: null },
    ],
    [
      { type: "topic", name: "work", cwd: "" },
      { type: "topic", name: "work", cwd: "" },
    ],
  ])("parses %j as the frame it is", (message, frame) => {
    expect(parseConnectionMessage(JSON.stringify(message))).toEqual(frame);
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
    expect(() => parseClientMessage('{"type":"topic","name":"work"}')).toThrow(
      'unknown message type "topic"',
    );
  });
});

/** The name rule: one validator for the parser and the client (PHASE-03 EX-7, VT-4). */
describe("topicNameOf", () => {
  it.each(["a", "0", "a.b_c-d", "default", "a".repeat(64)])("accepts %j", (name) => {
    expect(topicNameOf(name)).toBe(name);
  });

  it.each([
    "",
    "a".repeat(65),
    "A",
    "Work",
    ".work",
    "-work",
    "_work",
    "work ",
    " work",
    "work/x",
    "work:x",
    "wörk",
    "work\n",
  ])("refuses %j", (name) => {
    expect(() => topicNameOf(name)).toThrow(NAME_RULE);
  });

  it.each([[undefined], [null], [3], [true], [[]], [{}]])("refuses the non-name %j", (name) => {
    expect(() => topicNameOf(name)).toThrow(NAME_RULE);
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
    expect(parseFirstLineFrame({ type: "list" })).toEqual({
      type: "list",
      query: { kind: "all" },
    });
  });

  it.each([
    [
      { type: "list", topic: "work" },
      { type: "list", query: { kind: "topic", name: "work" } },
    ],
    [
      { type: "list", topics: true },
      { type: "list", query: { kind: "topics" } },
    ],
    [
      { type: "topic", name: "work", cwd: null },
      { type: "topic", name: "work", cwd: null },
    ],
  ])("parses the %j frame", (message, expected) => {
    expect(parseFirstLineFrame(message)).toEqual(expected);
  });

  it("parses the topic frame", () => {
    expect(parseFirstLineFrame({ type: "topic", name: "work" })).toEqual({
      type: "topic",
      name: "work",
    });
  });

  it.each([[{ type: "input", content: "hi" }], [{ type: "abort" }], [{ type: "warp" }], [{}]])(
    "leaves %j to the client parser",
    (message) => {
      expect(parseFirstLineFrame(message)).toBeUndefined();
    },
  );

  it.each([
    [{ type: "attach", topic: "Work" }, `attach: ${NAME_RULE}`],
    [{ type: "attach", conversation: 0 }, "attach: conversation must be a positive integer"],
    [{ type: "list", topic: "Work" }, `list: ${NAME_RULE}`],
    [{ type: "list", page: 2 }, "list: unknown key page"],
    [{ type: "topic", name: "default" }, "topic: default is reserved"],
    [{ type: "topic", name: "work", cwd: 1 }, "topic: cwd must be a string or null"],
  ])("refuses %j strictly", (message, refusal) => {
    expect(errorOf(() => parseFirstLineFrame(message))).toBe(refusal);
  });
});
