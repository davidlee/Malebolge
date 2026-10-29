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
    [{ type: "orient" }],
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

  const CONTROL_REFUSAL = "topic: cwd must not contain a control character";
  const TOOLSET_CONTROL_REFUSAL = "topic: toolset must not contain a control character";
  const MODEL_CONTROL_REFUSAL = "topic: model must not contain a control character";

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
    // A directory is one field of a `--topics` line: no tab, newline or other control.
    ['{"type":"topic","name":"work","cwd":"/a\\tb"}', CONTROL_REFUSAL],
    ['{"type":"topic","name":"work","cwd":"/a\\nb"}', CONTROL_REFUSAL],
    ['{"type":"topic","name":"work","cwd":"/a\\u007fb"}', CONTROL_REFUSAL],
    // A toolset is one field of a `--topics` line too: no tab, newline or other control.
    // The frame does not judge the name itself: the profile's policy does, in setTopic.
    ['{"type":"topic","name":"work","toolset":1}', "topic: toolset must be a string or null"],
    ['{"type":"topic","name":"work","toolset":false}', "topic: toolset must be a string or null"],
    [
      '{"type":"topic","name":"work","toolset":["mail"]}',
      "topic: toolset must be a string or null",
    ],
    ['{"type":"topic","name":"work","toolset":"mai\\tl"}', TOOLSET_CONTROL_REFUSAL],
    ['{"type":"topic","name":"work","toolset":"mai\\nl"}', TOOLSET_CONTROL_REFUSAL],
    ['{"type":"topic","name":"work","toolset":"mai\\u007fl"}', TOOLSET_CONTROL_REFUSAL],
    // A model is one field of a prospective `--topics` line too (SL-010 PHASE-02 VT-3).
    // The frame does not judge the ref itself: the catalog does, in setTopic.
    ['{"type":"topic","name":"work","model":1}', "topic: model must be a string or null"],
    ['{"type":"topic","name":"work","model":false}', "topic: model must be a string or null"],
    [
      '{"type":"topic","name":"work","model":["gateway/x"]}',
      "topic: model must be a string or null",
    ],
    ['{"type":"topic","name":"work","model":"gate\\tway/x"}', MODEL_CONTROL_REFUSAL],
    ['{"type":"topic","name":"work","model":"gate\\nway/x"}', MODEL_CONTROL_REFUSAL],
    ['{"type":"topic","name":"work","model":"gate\\u007fway/x"}', MODEL_CONTROL_REFUSAL],
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
    // `toolset` is parsed exactly as `cwd`: a string sets it, `null` clears it (PHASE-04 VT-1).
    [
      { type: "topic", name: "work", toolset: "mail" },
      { type: "topic", name: "work", toolset: "mail" },
    ],
    [
      { type: "topic", name: "work", toolset: null },
      { type: "topic", name: "work", toolset: null },
    ],
    [
      { type: "topic", name: "work", toolset: "" },
      { type: "topic", name: "work", toolset: "" },
    ],
    [
      { type: "topic", name: "work", cwd: "/tmp", toolset: "mail" },
      { type: "topic", name: "work", cwd: "/tmp", toolset: "mail" },
    ],
    // `model` is parsed exactly as `cwd` and `toolset`: a string sets it, `null` clears it (VT-3).
    [
      { type: "topic", name: "work", model: "gateway/openai-david/gpt-6.1-terra" },
      { type: "topic", name: "work", model: "gateway/openai-david/gpt-6.1-terra" },
    ],
    [
      { type: "topic", name: "work", model: null },
      { type: "topic", name: "work", model: null },
    ],
    [
      { type: "topic", name: "work", cwd: "/tmp", toolset: "mail", model: "gateway/x" },
      { type: "topic", name: "work", cwd: "/tmp", toolset: "mail", model: "gateway/x" },
    ],
  ])("parses %j as the frame it is", (message, frame) => {
    expect(parseConnectionMessage(JSON.stringify(message))).toEqual(frame);
  });

  it("leaves toolset and model out of a frame that left them out, so absent stays absent (VT-1, VT-3)", () => {
    const frame = parseConnectionMessage('{"type":"topic","name":"work","cwd":"/tmp"}');
    expect(Object.hasOwn(frame, "toolset")).toBe(false);
    expect(Object.hasOwn(frame, "model")).toBe(false);
  });

  it.each([
    [{ type: "input", content: "hi" }],
    [{ type: "input", content: "hi", requestId: "r1" }],
    [{ type: "abort" }],
    [{ type: "compact" }],
    [{ type: "compact", instructions: "keep test names" }],
    [{ type: "orient" }],
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
  ])("refuses %j: topic must match the rule", (name) => {
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

  it("parses the topic frame into a TopicMessage", () => {
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

  // parseConnectionMessage's table covers every refusal; this proves the path is shared.
  it("refuses a malformed first-line frame strictly rather than leaving it to the client", () => {
    expect(errorOf(() => parseFirstLineFrame({ type: "list", page: 2 }))).toBe(
      "list: unknown key page",
    );
  });
});
