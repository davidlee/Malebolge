import { describe, expect, it } from "vitest";
import {
  cancel,
  JOB_STATES,
  type JobRecord,
  type JobState,
  markPauseRequested,
  parseJobState,
  type RecoverySnapshot,
  recoveryPlan,
  TERMINAL,
  transition,
  TRANSITIONS,
} from "../../src/runner/jobs.ts";
import { codeOf } from "./refusal-fixture.ts";

const NOW = 50_000;

const job = (state: JobState, extra: Partial<JobRecord> = {}): JobRecord => ({
  state,
  activeMs: 0,
  pauseRequested: false,
  pauseCount: 0,
  ...extra,
});

/** The §5.4 state diagram, edge by edge. */
const LEGAL: readonly (readonly [JobState, JobState])[] = [
  ["queued", "preparing"],
  ["queued", "cancelled"],
  ["preparing", "running"],
  ["preparing", "failed"],
  ["preparing", "cancelled"],
  ["running", "waiting_room"],
  ["running", "collecting"],
  ["waiting_room", "running"],
  ["waiting_room", "pending_collection"],
  ["collecting", "pending_collection"],
  ["collecting", "needs_review"],
  ["collecting", "failed"],
  ["collecting", "cancelled"],
  ["pending_collection", "collecting"],
  ["pending_collection", "failed"],
  ["needs_review", "promoted"],
  ["needs_review", "rejected"],
];

const isLegal = (from: JobState, to: JobState): boolean =>
  LEGAL.some(([a, b]) => a === from && b === to);

describe("state machine: edges", () => {
  it("the transition table is exactly the diagram", () => {
    const edges = JOB_STATES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to]));
    expect(edges).toEqual(expect.arrayContaining(LEGAL.map((edge) => [...edge])));
    expect(edges).toHaveLength(LEGAL.length);
  });

  it.each(LEGAL)("%s -> %s is legal and stamps state_entered_at", (from, to) => {
    const patch = transition(job(from, { runningSince: 1_000 }), to, NOW);
    expect(patch.state).toBe(to);
    expect(patch.stateEnteredAt).toBe(NOW);
  });

  const illegal = JOB_STATES.flatMap((from) =>
    JOB_STATES.filter((to) => !isLegal(from, to)).map((to) => [from, to] as const),
  );

  it.each(illegal)("%s -> %s is invalid_transition", (from, to) => {
    expect(codeOf(() => transition(job(from), to, NOW))).toBe("invalid_transition");
  });

  it("terminal states have no way out", () => {
    expect(TERMINAL).toEqual(["promoted", "rejected", "cancelled", "failed"]);
    for (const state of TERMINAL) {
      expect(TRANSITIONS[state]).toEqual([]);
    }
  });

  it("refuses an unknown state string", () => {
    expect(parseJobState("waiting_room")).toBe("waiting_room");
    expect(() => parseJobState("claimed")).toThrow(/unknown job state/);
  });
});

describe("state machine: field effects", () => {
  it("entering running from preparing opens a segment and stamps started_at", () => {
    expect(transition(job("preparing"), "running", NOW)).toEqual({
      state: "running",
      stateEnteredAt: NOW,
      runningSince: NOW,
      startedAt: NOW,
    });
  });

  it("leaving running closes the segment into active_ms and clears running_since", () => {
    const patch = transition(
      job("running", { activeMs: 700, runningSince: 10_000 }),
      "collecting",
      NOW,
    );
    expect(patch.activeMs).toBe(700 + NOW - 10_000);
    expect(patch.runningSince).toBeNull();
  });

  it("entering waiting_room clears pause_requested and increments pause_count", () => {
    const paused = job("running", { runningSince: 0, pauseRequested: true, pauseCount: 2 });
    const patch = transition(paused, "waiting_room", NOW);
    expect(patch).toMatchObject({ pauseRequested: false, pauseCount: 3, activeMs: NOW });
  });

  it("resuming from waiting_room opens a new segment without restamping started_at", () => {
    const patch = transition(job("waiting_room", { activeMs: 900 }), "running", NOW);
    expect(patch).toEqual({ state: "running", stateEnteredAt: NOW, runningSince: NOW });
  });

  it("entering a terminal state sets finished_at", () => {
    expect(transition(job("needs_review"), "promoted", NOW).finishedAt).toBe(NOW);
    expect(transition(job("collecting"), "needs_review", NOW)).not.toHaveProperty("finishedAt");
  });
});

describe("pause_requested mark (DEC-055)", () => {
  it("marks a running job", () => {
    expect(markPauseRequested(job("running"))).toEqual({ pauseRequested: true });
  });

  it("is idempotent: an already marked job is a no-op, not an error", () => {
    expect(markPauseRequested(job("running", { pauseRequested: true }))).toBeUndefined();
  });

  it.each(JOB_STATES.filter((state) => state !== "running"))("is a no-op in %s", (state) => {
    expect(markPauseRequested(job(state))).toBeUndefined();
  });
});

describe("cancel", () => {
  it.each([
    ["queued", "cancelled"],
    ["preparing", "cancelled"],
    ["running", "collecting"],
    ["waiting_room", "pending_collection"],
  ] as const)("cancel in %s moves to %s with end_reason cancelled", (from, to) => {
    const patch = cancel(job(from, { runningSince: 0 }), NOW);
    expect(patch).toMatchObject({ state: to, endReason: "cancelled" });
  });

  it("cancel-queued: a queued job ends cancelled at once", () => {
    expect(cancel(job("queued"), NOW).finishedAt).toBe(NOW);
  });

  it.each(["collecting", "pending_collection", "needs_review", ...TERMINAL] as const)(
    "cancel-refuses-terminal and post-run states: %s is invalid_transition",
    (state) => {
      expect(codeOf(() => cancel(job(state), NOW))).toBe("invalid_transition");
    },
  );
});

/** A queued job before its conversation exists. */
const UNCREATED: RecoverySnapshot = {
  jobId: "pj-1",
  state: "queued",
  pauseRequested: false,
  pauseCount: 0,
  conversationSettled: false,
  warningThresholdPassed: false,
};

const snapshot = (state: JobState, extra: Partial<RecoverySnapshot> = {}): RecoverySnapshot => ({
  ...UNCREATED,
  conversationId: "c-1",
  state,
  ...extra,
});

/** One row per §5.4 restart-recovery table row (DEC-054). */
const RECOVERY_ROWS: readonly (readonly [string, RecoverySnapshot, unknown, unknown])[] = [
  ["queued, conversation_id null", UNCREATED, [], [{ kind: "create_conversation" }]],
  ["queued", snapshot("queued"), [], []],
  ["preparing, no base_oid", snapshot("preparing"), [{ kind: "redo_refresh" }], []],
  [
    "preparing, base_oid set",
    snapshot("preparing", { baseOid: "abc" }),
    [{ kind: "ensure_job_branch" }],
    [{ kind: "submit_initial_prompt", requestId: "pj-1" }],
  ],
  [
    "running, pause_requested = 1",
    snapshot("running", { pauseRequested: true }),
    [],
    [{ kind: "abort_then_waiting_room" }],
  ],
  [
    "running, conversation settled, pause recorded (crash after abort): pause wins",
    snapshot("running", { conversationSettled: true, pauseRequested: true }),
    [],
    [{ kind: "abort_then_waiting_room" }],
  ],
  [
    "running, conversation settled",
    snapshot("running", { conversationSettled: true }),
    [{ kind: "to_collecting" }],
    [],
  ],
  ["running", snapshot("running"), [{ kind: "rearm_deadline" }], []],
  [
    "running, warning threshold passed, no warning receipt",
    snapshot("running", { warningThresholdPassed: true }),
    [{ kind: "rearm_deadline" }],
    [{ kind: "resubmit_warning", requestId: "warn-pj-1" }],
  ],
  [
    "waiting_room, warning threshold passed, no placed warning",
    snapshot("waiting_room", {
      pauseCount: 2,
      warningThresholdPassed: true,
      warningReceipt: { placed: false },
    }),
    [{ kind: "resume_probing" }],
    [{ kind: "submit_resume", requestId: "resume-pj-1-2", withWarning: true }],
  ],
  [
    "waiting_room",
    snapshot("waiting_room", { pauseCount: 1 }),
    [{ kind: "resume_probing" }],
    [{ kind: "submit_resume", requestId: "resume-pj-1-1", withWarning: false }],
  ],
  ["collecting", snapshot("collecting"), [{ kind: "redo_collect" }], []],
  ["pending_collection", snapshot("pending_collection"), [{ kind: "resume_collection_retry" }], []],
  ["needs_review", snapshot("needs_review"), [], []],
];

describe("recovery table", () => {
  it.each(RECOVERY_ROWS)("recovery row: %s", (_row, state, phaseA, phaseB) => {
    expect(recoveryPlan(state, true)).toEqual({ phaseA, phaseB });
  });

  it.each(TERMINAL)("recovery leaves terminal %s alone", (state) => {
    expect(recoveryPlan(snapshot(state), true)).toEqual({ phaseA: [], phaseB: [] });
  });

  it.each(RECOVERY_ROWS)(
    "disabled runner: %s keeps phase A, empty phase B (I14)",
    (_row, state, phaseA) => {
      expect(recoveryPlan(state, false)).toEqual({ phaseA, phaseB: [] });
    },
  );

  it("disabled runner with a recorded pause: no harness act, the mark is kept", () => {
    const plan = recoveryPlan(snapshot("running", { pauseRequested: true }), false);
    expect(plan).toEqual({ phaseA: [], phaseB: [] });
  });

  it("a crashed running job is re-armed and resumed, not failed (divergence from the Go reconcile)", () => {
    const plan = recoveryPlan(snapshot("running"), true);
    expect(plan.phaseA).toEqual([{ kind: "rearm_deadline" }]);
  });

  it("a placed warning is not repeated; a receipt marks the running warning done", () => {
    const placed = { warningThresholdPassed: true, warningReceipt: { placed: true } };
    expect(recoveryPlan(snapshot("waiting_room", placed), true).phaseB).toEqual([
      { kind: "submit_resume", requestId: "resume-pj-1-0", withWarning: false },
    ]);
    expect(
      recoveryPlan(snapshot("running", { ...placed, warningReceipt: { placed: false } }), true)
        .phaseB,
    ).toEqual([]);
  });

  it("the resume requestId is restart-stable for a given pause_count", () => {
    const first = recoveryPlan(snapshot("waiting_room", { pauseCount: 4 }), true);
    const again = recoveryPlan(snapshot("waiting_room", { pauseCount: 4 }), true);
    expect(again).toEqual(first);
  });
});
