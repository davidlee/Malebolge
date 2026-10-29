// SL-009 PHASE-03 VT-1/VT-2: the wire module both sides of the bridge share
// (design sec-2, sec-4 "Framing and caps"). Written red first: pi-bridge/wire.ts
// arrives with the code brief, and the parser, the caps and the socket path
// rule are pinned here.

import { describe, expect, it } from "vitest";
import {
  BOUND_FRAMES,
  BRIDGE_BODY_MAX_BYTES,
  BRIDGE_LINE_MAX_BYTES,
  BRIDGE_POST_WAIT_MS,
  type BoundFrame,
  bridgeSocketPath,
  DAEMON_FRAMES,
  type DaemonFrame,
  type DeliverFrame,
  FIRST_LINE_FRAMES,
  type FirstLineFrame,
  type Parsed,
  capHeadTail,
  capUtf8,
  parseFrame,
} from "../pi-bridge/wire.ts";
import { capUtf8 as truncateCapUtf8 } from "../src/truncate.ts";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** The cut marker, as the contract spells it. */
const cutMarker = (n: number): string => `[\u2026 ${String(n)} bytes cut \u2026]`;
const CUT = /^(.*?)\[\u2026 (\d+) bytes cut \u2026\](.*)$/s;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type VocabularyName = "first line" | "bound" | "daemon";

/** A line parsed in the vocabulary `name` names: the three tables have different frames. */
function parseIn(
  name: VocabularyName,
  line: string,
): Parsed<FirstLineFrame | BoundFrame | DaemonFrame> {
  switch (name) {
    case "first line":
      return parseFrame(FIRST_LINE_FRAMES, line);
    case "bound":
      return parseFrame(BOUND_FRAMES, line);
    case "daemon":
      return parseFrame(DAEMON_FRAMES, line);
  }
}

describe("parseFrame: round trips (VT-1)", () => {
  const firstLine: FirstLineFrame[] = [
    { type: "pair", posture: "delegate", project: "malebolge" },
    { type: "pair", posture: "consult", project: "malebolge" },
    { type: "resume", conversation: "c1", token: "t0ken" },
    { type: "post-once", conversation: "c1", token: "t0ken", kind: "turn", text: "hi" },
    { type: "post-once", conversation: "c1", token: "t0ken", kind: "note", text: "" },
  ];
  const bound: BoundFrame[] = [
    { type: "post", id: "p1", kind: "turn", text: "hi" },
    { type: "post", id: "p2", kind: "note", text: "" },
    { type: "ack", seq: 0 },
    { type: "ack", seq: 4_294_967_295 },
    { type: "refill" },
    { type: "end" },
  ];
  // The daemon's frames, with each optional key both present and absent.
  const daemon: DaemonFrame[] = [
    { type: "paired", conversation: "c1" },
    { type: "paired", conversation: "c1", token: "t0ken" },
    { type: "accepted" },
    { type: "accepted", id: "p1" },
    { type: "refused", reason: "outbox full" },
    { type: "refused", id: "p1", reason: "outbox full" },
    { type: "deliver", seq: 0, kind: "turn", text: "hi" },
    { type: "deliver", seq: 12, kind: "note", text: "" },
  ];

  it.each(firstLine)("first-line %j round-trips", (frame) => {
    expect(parseFrame(FIRST_LINE_FRAMES, JSON.stringify(frame))).toEqual({ ok: true, frame });
  });

  it.each(bound)("bound %j round-trips", (frame) => {
    expect(parseFrame(BOUND_FRAMES, JSON.stringify(frame))).toEqual({ ok: true, frame });
  });

  it.each(daemon)("daemon %j round-trips", (frame) => {
    expect(parseFrame(DAEMON_FRAMES, JSON.stringify(frame))).toEqual({ ok: true, frame });
  });

  it("holds only the declared keys, whatever the line's key order", () => {
    expect(parseFrame(BOUND_FRAMES, '{"seq":7,"type":"ack"}')).toEqual({
      ok: true,
      frame: { type: "ack", seq: 7 },
    });
  });
});

describe("parseFrame: refusals (VT-1)", () => {
  // [vocabulary, line, the exact reason text]. Keys are checked in declared
  // order, so the first failure wins.
  const REFUSALS: (readonly [VocabularyName, string, string])[] = [
    ["first line", "not json", "not a JSON object"],
    ["daemon", "[]", "not a JSON object"],
    ["first line", "null", "not a JSON object"],
    ["bound", "42", "not a JSON object"],
    ["first line", '{"posture":"delegate","project":"p"}', "a frame needs a string type"],
    ["first line", '{"type":3}', "a frame needs a string type"],
    ["bound", '{"type":"warp"}', 'unknown frame type "warp"'],
    // A durable.sock verb: the bridge parser knows no attach.
    ["first line", '{"type":"attach","target":{"kind":"root"}}', 'unknown frame type "attach"'],
    ["bound", '{"type":"attach","target":{"kind":"root"}}', 'unknown frame type "attach"'],
    // Valid in another vocabulary, refused here.
    [
      "first line",
      '{"type":"post","id":"i","kind":"turn","text":"t"}',
      'unknown frame type "post"',
    ],
    [
      "bound",
      '{"type":"deliver","seq":1,"kind":"note","text":"t"}',
      'unknown frame type "deliver"',
    ],
    // A required key absent.
    ["first line", '{"type":"pair","posture":"delegate"}', "pair needs project"],
    ["bound", '{"type":"post","id":"i","kind":"turn"}', "post needs text"],
    ["daemon", '{"type":"deliver","seq":1,"kind":"note"}', "deliver needs text"],
    // A key of the wrong type.
    ["bound", '{"type":"ack","seq":"3"}', "ack.seq is not a non-negative integer"],
    ["bound", '{"type":"post","id":"i","kind":"note","text":5}', "post.text is not a string"],
    [
      "first line",
      '{"type":"resume","conversation":null,"token":"t"}',
      "resume.conversation is not a string",
    ],
    [
      "first line",
      '{"type":"resume","conversation":"c","token":{}}',
      "resume.token is not a string",
    ],
    ["daemon", '{"type":"paired","conversation":"c","token":true}', "paired.token is not a string"],
    ["bound", '{"type":"ack","seq":9007199254740992}', "ack.seq is not a non-negative integer"],
    // Outside its enum.
    [
      "first line",
      '{"type":"pair","posture":"chair","project":"p"}',
      "pair.posture is not one of delegate, consult",
    ],
    [
      "bound",
      '{"type":"post","id":"i","kind":"shout","text":"t"}',
      "post.kind is not one of turn, note",
    ],
    [
      "daemon",
      '{"type":"deliver","seq":1,"kind":"shout","text":"t"}',
      "deliver.kind is not one of turn, note",
    ],
    // The check runs in declared order: posture fails before the absent project.
    [
      "first line",
      '{"type":"pair","posture":"chair"}',
      "pair.posture is not one of delegate, consult",
    ],
    // seq is a non-negative safe integer.
    ["bound", '{"type":"ack","seq":-1}', "ack.seq is not a non-negative integer"],
    ["bound", '{"type":"ack","seq":1.5}', "ack.seq is not a non-negative integer"],
    [
      "daemon",
      '{"type":"deliver","seq":-2,"kind":"note","text":"t"}',
      "deliver.seq is not a non-negative integer",
    ],
    // A key the frame does not name.
    ["bound", '{"type":"refill","extra":1}', "refill has unknown key extra"],
    ["daemon", '{"type":"accepted","id":"i","extra":{"a":1}}', "accepted has unknown key extra"],
  ];

  it.each(REFUSALS)("%s refuses %j as %j", (name, line, reason) => {
    expect(parseIn(name, line)).toEqual({ ok: false, refused: { type: "refused", reason } });
  });

  it("carries no id, though the refused frame named one", () => {
    const parsed = parseIn("bound", '{"type":"post","id":"i","kind":"turn"}');
    expect(parsed).toEqual({
      ok: false,
      refused: { type: "refused", reason: "post needs text" },
    });
    if (parsed.ok) {
      throw new Error("a post without text was accepted");
    }
    expect(parsed.refused).not.toHaveProperty("id");
  });

  it("never throws, whatever the line", () => {
    for (const line of ["", "{", "\u0000", '{"type":"pair","posture":null,"project":null}']) {
      expect(() => parseIn("first line", line)).not.toThrow();
    }
  });
});

describe("constants", () => {
  it("pins the 32 KiB body cap", () => {
    expect(BRIDGE_BODY_MAX_BYTES).toBe(32768);
  });

  it("lets a line cap exceed the body cap, even when every body byte escapes to six", () => {
    expect(BRIDGE_LINE_MAX_BYTES).toBeGreaterThan(BRIDGE_BODY_MAX_BYTES);
    const text = "\u0001".repeat(BRIDGE_BODY_MAX_BYTES);
    const frame: DeliverFrame = { type: "deliver", seq: 1, kind: "turn", text };
    expect(bytes(`${JSON.stringify(frame)}\n`)).toBeLessThanOrEqual(BRIDGE_LINE_MAX_BYTES);
  });

  it("pins a positive reply deadline in milliseconds", () => {
    expect(Number.isSafeInteger(BRIDGE_POST_WAIT_MS)).toBe(true);
    expect(BRIDGE_POST_WAIT_MS).toBeGreaterThan(0);
  });
});

/** Asserts `capHeadTail`'s result for `text` at `maxBytes`: a head, the marker, a tail. */
function expectHeadTailCut(text: string, maxBytes: number): void {
  const result = capHeadTail(text, maxBytes);
  expect(bytes(result)).toBeLessThanOrEqual(maxBytes);
  expect(result).not.toBe(text);
  const match = CUT.exec(result);
  if (match === null) {
    throw new Error(`no cut marker in ${JSON.stringify(result)}`);
  }
  const [, head = "", digits = "", tail = ""] = match;
  const removed = bytes(text) - bytes(head) - bytes(tail);
  expect(text.startsWith(head)).toBe(true);
  expect(text.endsWith(tail)).toBe(true);
  expect(Number(digits)).toBe(removed);
  expect(result).toBe(`${head}${cutMarker(removed)}${tail}`);
  // No character was split: a lone surrogate or a broken sequence would show.
  expect(result).not.toContain("\uFFFD");
  expect(Buffer.from(result, "utf8").toString("utf8")).toBe(result);
  expect(LONE_SURROGATE.test(result)).toBe(false);
}

describe("capHeadTail (VT-2)", () => {
  it.each([
    ["", 0],
    ["", 10],
    ["abc", 10],
    ["abc", 3],
    ["\u00e9\u20ac\ud83d\ude00", 9],
  ])("returns %j unchanged under or at the cap %i", (text, maxBytes) => {
    expect(capHeadTail(text, maxBytes)).toBe(text);
  });

  const OVER: (readonly [string, number])[] = [
    ["x".repeat(900), 23],
    ["x".repeat(900), 24],
    ["x".repeat(900), 40],
    ["x".repeat(900), 100],
    ["x".repeat(900), 899],
    ["\u00e9\u20ac\ud83d\ude00".repeat(300), 24],
    ["\u00e9\u20ac\ud83d\ude00".repeat(300), 30],
    ["\u00e9\u20ac\ud83d\ude00".repeat(300), 101],
    ["\u00e9\u20ac\ud83d\ude00".repeat(300), 2699],
  ];

  it.each(OVER)("cuts %j at %i, stating the bytes removed", (text, maxBytes) => {
    expectHeadTailCut(text, maxBytes);
  });

  it("never splits a code point, over every cap from the marker's size up", () => {
    const text = "\u00e9\u20ac\ud83d\ude00".repeat(300);
    for (let cap = bytes(cutMarker(bytes(text))); cap <= 120; cap++) {
      expectHeadTailCut(text, cap);
    }
  });

  it("drops a 4-byte emoji whole when the cut falls inside it", () => {
    // 40 bytes, so the marker is 22: a cap of 23, 25 or 27 leaves a head budget
    // of 1, 2 or 3 bytes, inside the first emoji.
    const text = "\ud83d\ude00".repeat(10);
    for (const cap of [23, 25, 27, 31, 33, 35]) {
      expectHeadTailCut(text, cap);
    }
  });

  it("throws RangeError when the cap cannot hold the marker", () => {
    const text = "x".repeat(100); // 3 digits, so the marker is 23 bytes
    expect(bytes(cutMarker(100))).toBe(23);
    expect(() => capHeadTail(text, 22)).toThrow(RangeError);
    expect(capHeadTail(text, 23)).toBe(cutMarker(100));
  });

  it("is the capUtf8 src/truncate.ts exports", () => {
    expect(truncateCapUtf8).toBe(capUtf8);
  });
});

describe("bridgeSocketPath (VT-3)", () => {
  const DEFAULT = "/run/u/satan/durable/room/bridge/bridge.sock";

  it("defaults to the room's bridge directory under XDG_RUNTIME_DIR", () => {
    expect(bridgeSocketPath({ XDG_RUNTIME_DIR: "/run/u" })).toBe(DEFAULT);
  });

  it("takes MALEBOLGE_BRIDGE_SOCKET over the default", () => {
    const path = "/srv/x/room/bridge/other.sock";
    expect(bridgeSocketPath({ XDG_RUNTIME_DIR: "/run/u", MALEBOLGE_BRIDGE_SOCKET: path })).toBe(
      path,
    );
  });

  it("takes MALEBOLGE_BRIDGE_SOCKET with no XDG_RUNTIME_DIR at all", () => {
    const path = "/srv/x/room/bridge/other.sock";
    expect(bridgeSocketPath({ MALEBOLGE_BRIDGE_SOCKET: path })).toBe(path);
  });

  it("refuses to default without XDG_RUNTIME_DIR", () => {
    expect(() => bridgeSocketPath({})).toThrow("XDG_RUNTIME_DIR is not set");
    expect(() => bridgeSocketPath({ XDG_RUNTIME_DIR: "" })).toThrow("XDG_RUNTIME_DIR is not set");
  });
});
