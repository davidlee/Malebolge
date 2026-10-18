import { describe, expect, it } from "vitest";
import {
  columnOf,
  decodeEvent,
  decodeJob,
  encodeEvent,
  encodeJob,
  type Job,
  JOB_FIELDS,
} from "../../src/runner/rows.ts";

const T0 = Date.parse("2026-10-18T07:38:01.165Z");

/** A job with only the required fields. */
const BARE: Job = {
  id: "pj-01ARYZ6S410000000000000000",
  submissionId: "sub-1",
  state: "queued",
  mode: "fix",
  directive: "Fix it.",
  repo: "satan",
  baseRef: "main",
  allowedPaths: ["src/"],
  tags: [],
  context: {},
  source: {},
  ceilings: {},
  pauseRequested: false,
  pauseCount: 0,
  stateEnteredAt: T0,
  activeMs: 0,
  modelRequests: 0,
  createdAt: T0,
  updatedAt: T0,
};

/** A job with every field set. */
const FULL: Job = {
  ...BARE,
  conversationId: "conv-1",
  state: "needs_review",
  tags: ["a", "b"],
  context: { note: "n", nested: { depth: 2 } },
  source: { from: "inbox" },
  ceilings: { model_requests: 5, cost_usd: 0.5 },
  policy: { model: "m" },
  baseOid: "abc123",
  endReason: "completed",
  pauseRequested: true,
  pauseCount: 2,
  runningSince: T0 + 1,
  activeMs: 12_345,
  modelRequests: 7,
  reviewedOid: "def456",
  quarantineRef: "refs/quarantine/x",
  class: "complete",
  failure: { reason: "none" },
  startedAt: T0 + 2,
  finishedAt: T0 + 3,
  announcedAt: T0 + 4,
};

/** `job`'s row with `column` replaced by `value`. */
const rowWith = (job: Job, column: string, value: unknown): Record<string, unknown> => ({
  ...encodeJob(job),
  [column]: value,
});

describe("job row codec", () => {
  it("round-trips a full job and a bare one", () => {
    expect(decodeJob(encodeJob(FULL))).toEqual(FULL);
    expect(decodeJob(encodeJob(BARE))).toEqual(BARE);
  });

  it("stores times as ISO-8601 UTC text, flags as 0/1 and JSON as text", () => {
    const row = encodeJob(FULL);
    expect(row["created_at"]).toBe("2026-10-18T07:38:01.165Z");
    expect(row["pause_requested"]).toBe(1);
    expect(encodeJob(BARE)["pause_requested"]).toBe(0);
    expect(row["allowed_paths"]).toBe('["src/"]');
    expect(row["ceilings"]).toBe('{"model_requests":5,"cost_usd":0.5}');
  });

  it("writes an absent optional field as NULL and reads NULL as absent", () => {
    const row = encodeJob(BARE);
    expect(row["running_since"]).toBeNull();
    expect(row["conversation_id"]).toBeNull();
    expect("runningSince" in decodeJob(row)).toBe(false);
  });

  it("names each field's column in snake case, in schema order", () => {
    expect(columnOf("stateEnteredAt")).toBe("state_entered_at");
    expect(columnOf("activeMs")).toBe("active_ms");
    expect(Object.keys(encodeJob(BARE))).toEqual(JOB_FIELDS.map(columnOf));
  });

  it.each([
    ["created_at", "2026-10-18", /created_at/],
    ["created_at", "2026-10-18T07:38:01Z", /created_at/],
    ["created_at", "not a time", /created_at/],
    ["created_at", 5, /created_at/],
    ["pause_requested", 2, /pause_requested/],
    ["pause_count", -1, /pause_count/],
    ["active_ms", 1.5, /active_ms/],
    ["active_ms", 5n, /active_ms/],
    ["state", "sleeping", /state/],
    ["end_reason", "bored", /end_reason/],
    ["class", "great", /class/],
    ["allowed_paths", '{"a":1}', /allowed_paths/],
    ["allowed_paths", "[1]", /allowed_paths/],
    ["tags", "[", /tags/],
    ["tags", 5, /tags must be JSON text/],
    ["context", "[]", /context/],
    ["ceilings", '{"tokens":-1}', /ceilings/],
    ["id", null, /id/],
  ])("refuses %s = %s as a corrupt row", (column, value, message) => {
    expect(() => decodeJob(rowWith(BARE, column, value))).toThrow(message);
    expect(() => decodeJob(rowWith(BARE, column, value))).toThrow(/corrupt jobs row/);
  });

  it.each([
    ["a fractional time", { createdAt: T0 + 0.5 }],
    ["a time before 1970", { createdAt: -1 }],
    ["a time past year 9999", { createdAt: Date.parse("+010000-01-01T00:00:00Z") }],
    ["a negative count", { pauseCount: -1 }],
  ])("refuses to encode %s", (_what, change: Partial<Job>) => {
    expect(() => encodeJob({ ...BARE, ...change })).toThrow();
  });
});

describe("job event codec", () => {
  const EVENT = { jobId: BARE.id, at: T0, kind: "pause", payload: { op: "exec" } } as const;

  it("round-trips through its row", () => {
    expect(decodeEvent({ seq: 3, ...encodeEvent(EVENT) })).toEqual({ seq: 3, ...EVENT });
  });

  it("refuses an unknown kind or a non-object payload", () => {
    const row = { seq: 1, job_id: BARE.id, at: "2026-10-18T07:38:01.165Z", payload: "{}" };
    expect(() => decodeEvent({ ...row, kind: "gossip" })).toThrow(/corrupt job_events row 1.*kind/);
    expect(() => decodeEvent({ ...row, kind: "pause", payload: "1" })).toThrow(/payload/);
  });
});
