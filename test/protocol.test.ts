import { describe, expect, it } from "vitest";
import { parseClientMessage } from "../src/protocol.ts";

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
