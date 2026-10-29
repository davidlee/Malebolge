// SL-009 PHASE-08 VT-1..3: `step` is the design sec-7 table, and this file is
// that table. One case per contract row (phase-08-contract.md), named
// `<state> | <event> -> <next>`, written red before step's body (T2). Types and
// effect shapes come from pi-bridge/state.ts; frame shapes from wire.ts.

import { describe, expect, it } from "vitest";
import {
  type BridgeEntry,
  type BridgeEvent,
  type BridgeState,
  type Delivery,
  type Effect,
  type MessageKey,
  type Notice,
  type Paired,
  type Pairing,
  type PendingPost,
  type Phase,
  type PostOutcome,
  step,
} from "../pi-bridge/state.ts";
import {
  BRIDGE_BODY_MAX_BYTES,
  type BoundFrame,
  capHeadTail,
  type FirstLineFrame,
  type MessageKind,
  type Posture,
} from "../pi-bridge/wire.ts";

// --- fixtures and effects ----------------------------------------------------

const PAIRING = {
  session: "session-a",
  conversation: "conv-a",
  token: "token-a",
  posture: "delegate",
} as const satisfies Paired["pairing"];

const SUPERSEDED = "superseded by a newer connection";

const initial = (overrides: Partial<BridgeState> = {}): BridgeState => ({
  phase: { name: "unpaired" },
  running: false,
  conn: 0,
  session: PAIRING.session,
  project: "proj",
  inSession: [],
  injected: [],
  ...overrides,
});

const paired = (overrides: Partial<Paired> = {}): Paired => ({
  pairing: PAIRING,
  buffer: [],
  pending: [],
  ...overrides,
});

const bound = (overrides: Partial<Paired> = {}, rest: Partial<BridgeState> = {}): BridgeState =>
  initial({ conn: 1, phase: { name: "bound", paired: paired(overrides) }, ...rest });

const boundEnding = (
  ending: { then?: Posture },
  overrides: Partial<Paired> = {},
  rest: Partial<BridgeState> = {},
): BridgeState =>
  initial({ conn: 1, phase: { name: "bound", paired: paired(overrides), ending }, ...rest });

const resuming = (
  outage = 0,
  overrides: Partial<Paired> = {},
  rest: Partial<BridgeState> = {},
): BridgeState =>
  initial({ conn: 1, phase: { name: "resuming", paired: paired(overrides), outage }, ...rest });

const outage = (
  attempt = 1,
  overrides: Partial<Paired> = {},
  rest: Partial<BridgeState> = {},
): BridgeState =>
  initial({ conn: 1, phase: { name: "outage", paired: paired(overrides), attempt }, ...rest });

const pairingPhase = (
  posture: Posture = "delegate",
  rest: Partial<BridgeState> = {},
): BridgeState => initial({ conn: 1, phase: { name: "pairing", posture }, ...rest });

const unpairedAt = (
  session: string = PAIRING.session,
  rest: Partial<BridgeState> = {},
): BridgeState => initial({ session, ...rest });

const delivery = (seq: number, kind: MessageKind = "turn"): Delivery => ({
  seq,
  kind,
  text: `${kind} ${String(seq)}`,
});

const pendingPost = (id: string, text = "hello"): PendingPost => ({ id, text });

const keyOf = (seq: number, pairing: string = PAIRING.conversation): MessageKey => ({
  pairing,
  seq,
});

const send = (conn: number, frame: BoundFrame): Effect => ({ type: "send", conn, frame });
const connect = (conn: number, frame: FirstLineFrame): Effect => ({ type: "connect", conn, frame });
const close = (conn: number): Effect => ({ type: "close", conn });
const deadline = (key: Extract<Effect, { type: "deadline" }>["key"]): Effect => ({
  type: "deadline",
  key,
});
const retry = (attempt: number): Effect => ({ type: "retry", attempt });
const CANCEL: Effect = { type: "cancel timers" };
const complete = (id: string, outcome: PostOutcome): Effect => ({ type: "complete", id, outcome });
const unknown = (id: string): Effect => complete(id, { kind: "unknown" });
const inject = (message: Delivery, triggerTurn: boolean): Effect => ({
  type: "inject",
  pairing: PAIRING.conversation,
  delivery: message,
  triggerTurn,
});
const append = (entry: BridgeEntry): Effect => ({ type: "append", entry });
const env = (value: { conversation: string; token: string } | null): Effect => ({
  type: "env",
  env: value,
});
const notify = (level: "info" | "error", notice: Notice): Effect => ({
  type: "notify",
  level,
  notice,
});

const status = (phase: Phase["name"], attempt?: number): Effect =>
  attempt === undefined
    ? { type: "status", status: { phase } }
    : { type: "status", status: { phase, attempt } };

function run(
  start: BridgeState,
  ...events: readonly BridgeEvent[]
): { state: BridgeState; effects: readonly Effect[] } {
  let state = start;
  const effects: Effect[] = [];
  for (const event of events) {
    const next = step(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

function freezeState(state: BridgeState): BridgeState {
  Object.freeze(state.inSession);
  Object.freeze(state.injected);
  const phase = state.phase;
  if (phase.name === "bound" || phase.name === "resuming" || phase.name === "outage") {
    Object.freeze(phase.paired.buffer);
    Object.freeze(phase.paired.pending);
    Object.freeze(phase.paired);
  }
  Object.freeze(phase);
  Object.freeze(state);
  return state;
}

// --- the table ---------------------------------------------------------------

describe("step(state, event): the sec-7 table (VT-1)", () => {
  describe("session_start", () => {
    it("unpaired | session_start (latest pairing, this session) -> resuming", () => {
      const message = keyOf(7);
      const { state: next, effects } = step(unpairedAt(), {
        type: "session_start",
        session: PAIRING.session,
        project: "proj",
        latest: { kind: "pairing", ...PAIRING },
        messages: [message],
      });
      expect(effects).toEqual([
        connect(1, { type: "resume", conversation: PAIRING.conversation, token: PAIRING.token }),
        deadline({ conn: 1, request: "resume" }),
        status("resuming"),
      ]);
      expect(next).toEqual(
        initial({
          conn: 1,
          inSession: [message],
          phase: { name: "resuming", paired: paired(), outage: 0 },
        }),
      );
    });

    it("unpaired | session_start (latest unpaired or none) -> unpaired", () => {
      const fromBound = bound(
        { pending: [pendingPost("p1")] },
        { running: true, inSession: [keyOf(1)], injected: [keyOf(2)] },
      );
      const { state: next, effects } = step(fromBound, {
        type: "session_start",
        session: PAIRING.session,
        project: "proj",
        latest: { kind: "unpaired" },
        messages: [keyOf(3)],
      });
      expect(effects).toEqual([status("unpaired")]);
      expect(next).toEqual(initial({ conn: 1, inSession: [keyOf(3)] }));

      const none = step(unpairedAt(), {
        type: "session_start",
        session: PAIRING.session,
        project: "proj",
        latest: undefined,
        messages: [keyOf(4)],
      });
      expect(none.effects).toEqual([]);
      expect(none.state).toEqual(initial({ inSession: [keyOf(4)] }));
    });

    it("F-5: unpaired | session_start (latest pairing from another session) -> unpaired, no end", () => {
      const { state: next, effects } = step(unpairedAt("session-a"), {
        type: "session_start",
        session: "session-b",
        project: "proj",
        latest: { kind: "pairing", ...PAIRING },
        messages: [keyOf(5)],
      });
      expect(effects).toEqual([notify("info", { kind: "forked pairing" })]);
      expect(next).toEqual(unpairedAt("session-b", { inSession: [keyOf(5)] }));
      expect(effects.some((effect) => effect.type === "send" || effect.type === "connect")).toBe(
        false,
      );
    });

    it("F-5: any | session_start (latest pairing from another session) -> unpaired, whatever came before", () => {
      const { state: next } = step(outage(2), {
        type: "session_start",
        session: "session-b",
        project: "proj",
        latest: { kind: "pairing", ...PAIRING },
        messages: [],
      });
      expect(next.phase).toEqual({ name: "unpaired" });
    });
  });

  describe("pair", () => {
    it("unpaired | pair -> pairing", () => {
      const { state: next, effects } = step(unpairedAt(), { type: "pair", posture: "consult" });
      expect(effects).toEqual([
        connect(1, { type: "pair", posture: "consult", project: "proj" }),
        deadline({ conn: 1, request: "pair" }),
        status("pairing"),
      ]);
      expect(next).toEqual(initial({ conn: 1, phase: { name: "pairing", posture: "consult" } }));
    });

    it("bound | /bridge pair -> bound, ending then pairing", () => {
      const { state: next, effects } = step(bound({ pending: [pendingPost("p1")] }), {
        type: "pair",
        posture: "consult",
      });
      expect(effects).toEqual([send(1, { type: "end" }), deadline({ conn: 1, request: "end" })]);
      expect(next).toEqual(boundEnding({ then: "consult" }, { pending: [pendingPost("p1")] }));
    });

    it("pairing, resuming, outage, bound-ending | pair -> same (busy)", () => {
      const cases: readonly (readonly [
        BridgeState,
        "pairing" | "resuming" | "outage" | "ending",
      ])[] = [
        [pairingPhase(), "pairing"],
        [resuming(), "resuming"],
        [outage(), "outage"],
        [boundEnding({}), "ending"],
      ];
      for (const [start, phase] of cases) {
        const { state: next, effects } = step(start, { type: "pair", posture: "delegate" });
        expect(effects).toEqual([notify("error", { kind: "busy", phase })]);
        expect(next).toEqual(start);
      }
    });
  });

  describe("end", () => {
    it("bound | end -> bound (ending)", () => {
      const { state: next, effects } = step(bound(), { type: "end" });
      expect(effects).toEqual([send(1, { type: "end" }), deadline({ conn: 1, request: "end" })]);
      expect(next).toEqual(boundEnding({}));
    });

    it("pairing, resuming, bound-ending | end -> same (busy)", () => {
      const cases: readonly (readonly [BridgeState, "pairing" | "resuming" | "ending"])[] = [
        [pairingPhase(), "pairing"],
        [resuming(), "resuming"],
        [boundEnding({}), "ending"],
      ];
      for (const [start, phase] of cases) {
        const { state: next, effects } = step(start, { type: "end" });
        expect(effects).toEqual([notify("error", { kind: "busy", phase })]);
        expect(next).toEqual(start);
      }
    });

    // Operator ruling 2026-10-30: an outage's end unpairs locally; no frame, the daemon's pairing is left as is.
    it("outage | end -> unpaired locally (marker, no frame)", () => {
      const { state: next, effects } = step(outage(2, { pending: [pendingPost("p1")] }), {
        type: "end",
      });
      expect(effects).toEqual([
        unknown("p1"),
        CANCEL,
        close(1),
        append({ kind: "unpaired" }),
        env(null),
        notify("info", { kind: "ended locally" }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("unpaired | end -> same (not paired)", () => {
      const { state: next, effects } = step(unpairedAt(), { type: "end" });
      expect(effects).toEqual([notify("info", { kind: "not paired" })]);
      expect(next).toEqual(unpairedAt());
    });
  });

  describe("frame", () => {
    it("pairing | frame paired -> bound", () => {
      const pairing: Pairing = {
        session: PAIRING.session,
        conversation: "conv-new",
        token: "token-new",
        posture: "consult",
      };
      const { state: next, effects } = step(pairingPhase("consult"), {
        type: "frame",
        conn: 1,
        frame: { type: "paired", conversation: "conv-new", token: "token-new" },
      });
      expect(effects).toEqual([
        append({ kind: "pairing", ...pairing }),
        env({ conversation: "conv-new", token: "token-new" }),
        status("bound"),
      ]);
      expect(next).toEqual(
        initial({
          conn: 1,
          phase: { name: "bound", paired: { pairing, buffer: [], pending: [] } },
        }),
      );
    });

    it("pairing | frame paired without a token -> unpaired (pair failed)", () => {
      const { state: next, effects } = step(pairingPhase(), {
        type: "frame",
        conn: 1,
        frame: { type: "paired", conversation: "conv-new" },
      });
      expect(effects).toEqual([
        close(1),
        notify("error", {
          kind: "pair failed",
          reason: "paired without a token",
          mayHaveCreated: false,
        }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("F-11: pairing | frame refused -> unpaired (pair failed, nothing created)", () => {
      const { state: next, effects } = step(pairingPhase(), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: "bad posture" },
      });
      expect(effects).toEqual([
        close(1),
        notify("error", { kind: "pair failed", reason: "bad posture", mayHaveCreated: false }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("resuming | frame paired -> bound", () => {
      const { state: next, effects } = step(resuming(0), {
        type: "frame",
        conn: 1,
        frame: { type: "paired", conversation: PAIRING.conversation },
      });
      expect(effects).toEqual([
        env({ conversation: PAIRING.conversation, token: PAIRING.token }),
        status("bound"),
      ]);
      expect(next).toEqual(bound());
    });

    it("resuming | frame paired after an outage -> bound (recovered once, resend pending)", () => {
      const pending = [pendingPost("p1"), pendingPost("p2")];
      const { state: next, effects } = step(resuming(2, { pending }), {
        type: "frame",
        conn: 1,
        frame: { type: "paired", conversation: PAIRING.conversation },
      });
      expect(effects).toEqual([
        env({ conversation: PAIRING.conversation, token: PAIRING.token }),
        notify("info", { kind: "recovered" }),
        send(1, { type: "post", id: "p1", kind: "turn", text: "hello" }),
        send(1, { type: "post", id: "p2", kind: "turn", text: "hello" }),
        status("bound"),
      ]);
      expect(next).toEqual(bound({ pending }));
    });

    it("F-12: resuming | frame refused superseded -> unpaired (no append, no retry)", () => {
      const { state: next, effects } = step(resuming(1, { pending: [pendingPost("p1")] }), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: SUPERSEDED },
      });
      expect(effects).toEqual([
        unknown("p1"),
        CANCEL,
        close(1),
        env(null),
        notify("error", { kind: "refused", reason: SUPERSEDED }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("resuming | frame refused -> unpaired (refused)", () => {
      const { state: next, effects } = step(resuming(1, { pending: [pendingPost("p1")] }), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: "bad token" },
      });
      expect(effects).toEqual([
        unknown("p1"),
        CANCEL,
        close(1),
        append({ kind: "unpaired" }),
        env(null),
        notify("error", { kind: "refused", reason: "bad token" }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("bound | frame accepted -> bound (complete sent)", () => {
      const { state: next, effects } = step(
        bound({ pending: [pendingPost("p1"), pendingPost("p2")] }),
        {
          type: "frame",
          conn: 1,
          frame: { type: "accepted", id: "p1" },
        },
      );
      expect(effects).toEqual([complete("p1", { kind: "sent" })]);
      expect(next).toEqual(bound({ pending: [pendingPost("p2")] }));
    });

    it("bound | frame refused with id -> bound (complete refused)", () => {
      const { state: next, effects } = step(
        bound({ pending: [pendingPost("p1"), pendingPost("p2")] }),
        {
          type: "frame",
          conn: 1,
          frame: { type: "refused", id: "p1", reason: "budget exhausted" },
        },
      );
      expect(effects).toEqual([complete("p1", { kind: "refused", reason: "budget exhausted" })]);
      expect(next).toEqual(bound({ pending: [pendingPost("p2")] }));
    });

    it("bound | frame refused with id, terminal -> unpaired (complete, then refused)", () => {
      const { state: next, effects } = step(
        bound({ pending: [pendingPost("p1"), pendingPost("p2")] }),
        {
          type: "frame",
          conn: 1,
          frame: { type: "refused", id: "p1", reason: "bad token" },
        },
      );
      expect(effects).toEqual([
        complete("p1", { kind: "refused", reason: "bad token" }),
        unknown("p2"),
        CANCEL,
        close(1),
        append({ kind: "unpaired" }),
        env(null),
        notify("error", { kind: "refused", reason: "bad token" }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("bound | frame refused terminal -> unpaired (refused)", () => {
      const { state: next, effects } = step(bound(), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: "bad token" },
      });
      expect(effects).toEqual([
        CANCEL,
        close(1),
        append({ kind: "unpaired" }),
        env(null),
        notify("error", { kind: "refused", reason: "bad token" }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("bound (ending) | frame refused pairing ended -> unpaired (ended)", () => {
      const { state: next, effects } = step(boundEnding({}, { pending: [pendingPost("p1")] }), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: "pairing ended" },
      });
      expect(effects).toEqual([
        unknown("p1"),
        CANCEL,
        close(1),
        append({ kind: "unpaired" }),
        env(null),
        notify("info", { kind: "ended" }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("bound | /bridge pair -> unpaired, then pairing", () => {
      const { state: next, effects } = run(
        bound(),
        { type: "pair", posture: "consult" },
        { type: "frame", conn: 1, frame: { type: "refused", reason: "pairing ended" } },
      );
      expect(effects).toEqual([
        send(1, { type: "end" }),
        deadline({ conn: 1, request: "end" }),
        CANCEL,
        close(1),
        append({ kind: "unpaired" }),
        env(null),
        notify("info", { kind: "ended" }),
        connect(2, { type: "pair", posture: "consult", project: "proj" }),
        deadline({ conn: 2, request: "pair" }),
        status("pairing"),
      ]);
      expect(next).toEqual(initial({ conn: 2, phase: { name: "pairing", posture: "consult" } }));
    });

    it("F-12: bound | frame refused superseded -> unpaired (no append, no retry)", () => {
      const { state: next, effects } = step(bound({ pending: [pendingPost("p1")] }), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: SUPERSEDED },
      });
      expect(effects).toEqual([
        unknown("p1"),
        CANCEL,
        close(1),
        env(null),
        notify("error", { kind: "refused", reason: SUPERSEDED }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("bound | frame refused (no pending id) -> bound (notify)", () => {
      const start = bound();
      const { state: next, effects } = step(start, {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: "budget exhausted" },
      });
      expect(effects).toEqual([notify("error", { kind: "refused", reason: "budget exhausted" })]);
      expect(next).toEqual(start);
    });

    it("bound | frame (unhandled) -> bound (ignored)", () => {
      const start = bound();
      const frames: Extract<BridgeEvent, { type: "frame" }>["frame"][] = [
        { type: "paired", conversation: "conv-x", token: "token-x" },
        { type: "accepted", id: "not-pending" },
      ];
      for (const frame of frames) {
        const { state: next, effects } = step(start, { type: "frame", conn: 1, frame });
        expect(effects).toEqual([]);
        expect(next).toEqual(start);
      }
    });
  });

  describe("closed", () => {
    it("F-11: pairing | closed -> unpaired (pair failed, nothing created)", () => {
      const { state: next, effects } = step(pairingPhase(), {
        type: "closed",
        conn: 1,
        reason: "connect refused",
      });
      expect(effects).toEqual([
        notify("error", { kind: "pair failed", reason: "connect refused", mayHaveCreated: false }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("resuming | closed -> outage (first failure notifies)", () => {
      const { state: next, effects } = step(resuming(0, { pending: [pendingPost("p1")] }), {
        type: "closed",
        conn: 1,
        reason: "connection reset",
      });
      expect(effects).toEqual([
        close(1),
        notify("error", { kind: "outage", reason: "connection reset" }),
        retry(1),
        status("outage", 1),
      ]);
      expect(next).toEqual(outage(1, { pending: [pendingPost("p1")] }));
    });

    it("resuming | closed after an outage -> outage (second failure silent)", () => {
      const { state: next, effects } = step(resuming(1), {
        type: "closed",
        conn: 1,
        reason: "connection reset",
      });
      expect(effects).toEqual([close(1), retry(2), status("outage", 2)]);
      expect(next).toEqual(outage(2));
    });

    it("bound | closed -> outage from attempt 0", () => {
      const { state: next, effects } = step(bound(), {
        type: "closed",
        conn: 1,
        reason: "connection reset",
      });
      expect(effects).toEqual([
        close(1),
        notify("error", { kind: "outage", reason: "connection reset" }),
        retry(1),
        status("outage", 1),
      ]);
      expect(next).toEqual(outage(1));
    });

    it("bound (ending) | closed -> unpaired (end unanswered, no pair)", () => {
      const { state: next, effects } = step(boundEnding({ then: "consult" }), {
        type: "closed",
        conn: 1,
        reason: "connection reset",
      });
      expect(effects).toEqual([
        CANCEL,
        close(1),
        append({ kind: "unpaired" }),
        env(null),
        notify("error", { kind: "end unanswered" }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("unpaired | closed -> unpaired (ignored)", () => {
      const start = initial({ conn: 1 });
      const { state: next, effects } = step(start, { type: "closed", conn: 1, reason: "anything" });
      expect(effects).toEqual([]);
      expect(next).toEqual(start);
    });
  });

  describe("deadline", () => {
    it("F-11: pairing | deadline pair -> unpaired (pair failed, may have created)", () => {
      const { state: next, effects } = step(pairingPhase(), {
        type: "deadline",
        key: { conn: 1, request: "pair" },
      });
      expect(effects).toEqual([
        close(1),
        notify("error", { kind: "pair failed", reason: "no reply", mayHaveCreated: true }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("resuming | deadline resume -> outage (no reply notifies once)", () => {
      const { state: next, effects } = step(resuming(0), {
        type: "deadline",
        key: { conn: 1, request: "resume" },
      });
      expect(effects).toEqual([
        close(1),
        notify("error", { kind: "outage", reason: "no reply" }),
        retry(1),
        status("outage", 1),
      ]);
      expect(next).toEqual(outage(1));
    });

    it("bound (ending) | deadline end -> unpaired (end unanswered, no pair)", () => {
      const { state: next, effects } = step(boundEnding({}), {
        type: "deadline",
        key: { conn: 1, request: "end" },
      });
      expect(effects).toEqual([
        CANCEL,
        close(1),
        append({ kind: "unpaired" }),
        env(null),
        notify("error", { kind: "end unanswered" }),
        status("unpaired"),
      ]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("bound, resuming, outage | deadline post -> same (unknown, not resent)", () => {
      const rest = paired({ pending: [pendingPost("p2")] });
      const cases: readonly (readonly [BridgeState, Phase])[] = [
        [
          bound({ pending: [pendingPost("p1"), pendingPost("p2")] }),
          { name: "bound", paired: rest },
        ],
        [
          resuming(1, { pending: [pendingPost("p1"), pendingPost("p2")] }),
          { name: "resuming", paired: rest, outage: 1 },
        ],
        [
          outage(1, { pending: [pendingPost("p1"), pendingPost("p2")] }),
          { name: "outage", paired: rest, attempt: 1 },
        ],
      ];
      for (const [start, phase] of cases) {
        const { state: next, effects } = step(start, { type: "deadline", key: { post: "p1" } });
        expect(effects).toEqual([unknown("p1")]);
        expect(next.phase).toEqual(phase);
        expect(effects.some((effect) => effect.type === "send")).toBe(false);
      }
    });

    it("bound | deadline (unknown post, end not awaited) -> bound (ignored)", () => {
      const start = bound({ pending: [pendingPost("p1")] });
      const keys: readonly Extract<Effect, { type: "deadline" }>["key"][] = [
        { post: "not-pending" },
        { conn: 1, request: "end" },
        { conn: 1, request: "pair" },
      ];
      for (const key of keys) {
        const { state: next, effects } = step(start, { type: "deadline", key });
        expect(effects).toEqual([]);
        expect(next).toEqual(start);
      }
    });
  });

  describe("retry", () => {
    it("outage | retry -> resuming", () => {
      const { state: next, effects } = step(outage(2, { pending: [pendingPost("p1")] }), {
        type: "retry",
      });
      expect(effects).toEqual([
        connect(2, { type: "resume", conversation: PAIRING.conversation, token: PAIRING.token }),
        deadline({ conn: 2, request: "resume" }),
        status("resuming"),
      ]);
      expect(next).toEqual(resuming(2, { pending: [pendingPost("p1")] }, { conn: 2 }));
    });

    it("bound | retry -> bound (ignored)", () => {
      const start = bound();
      const { state: next, effects } = step(start, { type: "retry" });
      expect(effects).toEqual([]);
      expect(next).toEqual(start);
    });
  });

  describe("session_shutdown", () => {
    it("bound | session_shutdown -> unpaired (settled, closed, no append)", () => {
      const { state: next, effects } = step(
        bound({ pending: [pendingPost("p1"), pendingPost("p2")] }),
        {
          type: "session_shutdown",
        },
      );
      expect(effects).toEqual([unknown("p1"), unknown("p2"), CANCEL, close(1), status("unpaired")]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("pairing | session_shutdown -> unpaired (close, no append)", () => {
      const { state: next, effects } = step(pairingPhase(), { type: "session_shutdown" });
      expect(effects).toEqual([close(1), status("unpaired")]);
      expect(next).toEqual(initial({ conn: 1 }));
    });

    it("unpaired | session_shutdown -> unpaired (no close)", () => {
      const { state: next, effects } = step(unpairedAt(), { type: "session_shutdown" });
      expect(effects).toEqual([]);
      expect(next).toEqual(unpairedAt());
    });
  });

  describe("agent_start / agent_end", () => {
    it("unpaired | agent_start -> running true", () => {
      const start = unpairedAt();
      const { state: next, effects } = step(start, { type: "agent_start" });
      expect(effects).toEqual([]);
      expect(next).toEqual({ ...start, running: true });
    });

    it("RV-021 F-9: bound | agent_end -> bound (no change, no effects)", () => {
      const start = bound({ pending: [pendingPost("p1")] }, { running: true });
      const { state: next, effects } = step(start, { type: "agent_end" });
      expect(effects).toEqual([]);
      expect(next).toEqual(start);
    });
  });

  describe("agent_settled (VT-2, DEC-090)", () => {
    it("VT-2: bound | agent_settled (not aborted) -> notes up to the first turn, rest buffered", () => {
      const note1 = delivery(1, "note");
      const note2 = delivery(2, "note");
      const turn3 = delivery(3, "turn");
      const note4 = delivery(4, "note");
      const turn5 = delivery(5, "turn");
      const { state: next, effects } = step(
        bound({ buffer: [note1, note2, turn3, note4, turn5] }, { running: true }),
        {
          type: "agent_settled",
          aborted: false,
        },
      );
      expect(effects).toEqual([inject(note1, false), inject(note2, false), inject(turn3, true)]);
      expect(next).toEqual(
        bound(
          { buffer: [note4, turn5] },
          { running: true, injected: [keyOf(1), keyOf(2), keyOf(3)] },
        ),
      );
    });

    it("VT-2: bound | agent_settled (aborted) -> the whole buffer as notes", () => {
      const buffered = [
        delivery(1, "note"),
        delivery(2, "turn"),
        delivery(3, "note"),
        delivery(4, "turn"),
        delivery(5, "note"),
      ];
      const { state: next, effects } = step(bound({ buffer: buffered }, { running: true }), {
        type: "agent_settled",
        aborted: true,
      });
      expect(effects).toEqual(buffered.map((message) => inject(message, false)));
      expect(next).toEqual(
        bound({}, { running: false, injected: [keyOf(1), keyOf(2), keyOf(3), keyOf(4), keyOf(5)] }),
      );
    });

    it("unpaired | agent_settled -> unpaired (running false, nothing to flush)", () => {
      const { state: next, effects } = step(initial({ running: true }), {
        type: "agent_settled",
        aborted: false,
      });
      expect(effects).toEqual([]);
      expect(next).toEqual(initial({ running: false }));
    });
  });

  describe("deliver (VT-2): isIdle-only inject (DEC-090)", () => {
    it("VT-2: bound | deliver (isIdle true, not running) -> inject turn", () => {
      const message = delivery(4, "turn");
      const { state: next, effects } = step(bound(), {
        type: "deliver",
        conn: 1,
        delivery: message,
        idle: true,
      });
      expect(effects).toEqual([inject(message, true)]);
      expect(next).toEqual(bound({}, { running: true, injected: [keyOf(4)] }));
    });

    it("VT-2: bound | deliver note (isIdle true) -> inject, running stays clear", () => {
      const message = delivery(5, "note");
      const { state: next, effects } = step(bound(), {
        type: "deliver",
        conn: 1,
        delivery: message,
        idle: true,
      });
      expect(effects).toEqual([inject(message, false)]);
      expect(next).toEqual(bound({}, { injected: [keyOf(5)] }));
    });

    it("VT-2: bound | deliver (isIdle false) -> buffer in seq order", () => {
      const after3 = step(bound(), {
        type: "deliver",
        conn: 1,
        delivery: delivery(3),
        idle: false,
      });
      const { state: next, effects } = step(after3.state, {
        type: "deliver",
        conn: 1,
        delivery: delivery(2),
        idle: false,
      });
      expect(effects).toEqual([]);
      expect(next).toEqual(bound({ buffer: [delivery(2), delivery(3)] }));
    });

    it("VT-2: bound | deliver while running -> buffered", () => {
      const message = delivery(6);
      const { state: next, effects } = step(bound({}, { running: true }), {
        type: "deliver",
        conn: 1,
        delivery: message,
        idle: true,
      });
      expect(effects).toEqual([]);
      expect(next).toEqual(bound({ buffer: [message] }, { running: true }));
    });

    it("VT-2: bound | deliver already in the session -> re-ack", () => {
      const start = bound({}, { inSession: [keyOf(7)] });
      const { state: next, effects } = step(start, {
        type: "deliver",
        conn: 1,
        delivery: delivery(7),
        idle: true,
      });
      expect(effects).toEqual([send(1, { type: "ack", seq: 7 })]);
      expect(next).toEqual(start);
    });

    it("VT-2: bound | deliver already injected or buffered -> skipped", () => {
      const buffered = bound({ buffer: [delivery(8)] });
      const injected = bound({}, { injected: [keyOf(9)] });
      const cases: readonly (readonly [BridgeState, Delivery])[] = [
        [buffered, delivery(8)],
        [injected, delivery(9)],
      ];
      for (const [start, message] of cases) {
        const { state: next, effects } = step(start, {
          type: "deliver",
          conn: 1,
          delivery: message,
          idle: true,
        });
        expect(effects).toEqual([]);
        expect(next).toEqual(start);
      }
    });

    it("bound | deliver from a stale conn, or while not bound -> ignored", () => {
      const stale = step(bound(), { type: "deliver", conn: 0, delivery: delivery(10), idle: true });
      expect(stale.effects).toEqual([]);
      expect(stale.state).toEqual(bound());

      const notBound = unpairedAt(PAIRING.session, { conn: 1 });
      const other = step(notBound, {
        type: "deliver",
        conn: 1,
        delivery: delivery(11),
        idle: true,
      });
      expect(other.effects).toEqual([]);
      expect(other.state).toEqual(notBound);
    });
  });

  describe("persisted", () => {
    it("VT-2: bound | persisted -> injected to inSession, ack", () => {
      const key = keyOf(11);
      const { state: next, effects } = step(bound({}, { injected: [key] }), {
        type: "persisted",
        key,
      });
      expect(effects).toEqual([send(1, { type: "ack", seq: 11 })]);
      expect(next).toEqual(bound({}, { inSession: [key] }));

      const other = keyOf(12, "conv-other");
      const silent = step(bound({}, { injected: [other] }), { type: "persisted", key: other });
      expect(silent.effects).toEqual([]);
      expect(silent.state).toEqual(bound({}, { inSession: [other] }));
    });

    it("unpaired | persisted -> inSession, no ack", () => {
      const key = keyOf(12);
      const start = initial({ conn: 1, injected: [key] });
      const { state: next, effects } = step(start, { type: "persisted", key });
      expect(effects).toEqual([]);
      expect(next).toEqual(initial({ conn: 1, inSession: [key] }));
    });
  });

  describe("input", () => {
    it("VT-1: bound | input -> bound (refill)", () => {
      const start = bound({}, { running: true });
      const { state: next, effects } = step(start, { type: "input" });
      expect(effects).toEqual([send(1, { type: "refill" })]);
      expect(next).toEqual(start);
    });

    it("VT-1: unpaired, pairing, resuming, outage | input -> same (none)", () => {
      const cases: readonly BridgeState[] = [unpairedAt(), pairingPhase(), resuming(), outage()];
      for (const start of cases) {
        const { state: next, effects } = step(start, { type: "input" });
        expect(effects).toEqual([]);
        expect(next).toEqual(start);
      }
    });
  });

  describe("post (F-13)", () => {
    it("bound | post -> bound (send and deadline)", () => {
      for (const start of [bound(), boundEnding({})]) {
        const { state: next, effects } = step(start, { type: "post", id: "call-1", text: "hello" });
        expect(effects).toEqual([
          send(1, { type: "post", id: "call-1", kind: "turn", text: "hello" }),
          deadline({ post: "call-1" }),
        ]);
        expect(next.phase).toEqual({
          name: "bound",
          paired: paired({ pending: [pendingPost("call-1")] }),
          ...("ending" in start.phase ? { ending: start.phase.ending } : {}),
        });
      }
    });

    it("F-13: bound | post with an id already pending -> bound (ignored)", () => {
      const start = bound({ pending: [pendingPost("call-1")] });
      const { state: next, effects } = step(start, { type: "post", id: "call-1", text: "again" });
      expect(effects).toEqual([]);
      expect(next).toEqual(start);
    });

    it("bound | post caps the body", () => {
      const long = "x".repeat(BRIDGE_BODY_MAX_BYTES + 100);
      const capped = capHeadTail(long, BRIDGE_BODY_MAX_BYTES);
      const { state: next, effects } = step(bound(), { type: "post", id: "call-3", text: long });
      expect(effects).toEqual([
        send(1, { type: "post", id: "call-3", kind: "turn", text: capped }),
        deadline({ post: "call-3" }),
      ]);
      expect(next).toEqual(bound({ pending: [pendingPost("call-3", capped)] }));
      expect(capped.length).toBeLessThan(long.length);
    });

    it("F-13: unpaired | post -> complete not bound", () => {
      const { state: next, effects } = step(unpairedAt(), {
        type: "post",
        id: "call-2",
        text: "hello",
      });
      expect(effects).toEqual([complete("call-2", { kind: "not bound" })]);
      expect(next).toEqual(unpairedAt());
    });

    it("F-13: a post pending across a drop is resent with the same id on the next paired", () => {
      const { state: next, effects } = run(
        bound({ pending: [pendingPost("call-1")] }),
        { type: "closed", conn: 1, reason: "connection reset" },
        { type: "retry" },
        { type: "frame", conn: 2, frame: { type: "paired", conversation: PAIRING.conversation } },
      );
      const posts = effects.filter(
        (effect) => effect.type === "send" && effect.frame.type === "post",
      );
      expect(posts).toEqual([send(2, { type: "post", id: "call-1", kind: "turn", text: "hello" })]);
      expect(effects.filter((effect) => effect.type === "complete")).toEqual([]);
      expect(next.phase).toEqual({
        name: "bound",
        paired: paired({ pending: [pendingPost("call-1")] }),
      });
    });
  });

  describe("settlePending (VT-1): every exit completes each pending post once", () => {
    const pending = [pendingPost("p1"), pendingPost("p2")];
    const settled = [unknown("p1"), unknown("p2")];

    it("VT-1: end answered -> settlePending completes every pending post, then cancel timers", () => {
      const { effects } = step(boundEnding({}, { pending }), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: "pairing ended" },
      });
      expect(effects.slice(0, 3)).toEqual([...settled, CANCEL]);
    });

    it("VT-1: terminal refusal -> settlePending completes every pending post", () => {
      const { effects } = step(bound({ pending }), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: "bad token" },
      });
      expect(effects.slice(0, 3)).toEqual([...settled, CANCEL]);
    });

    it("VT-1: superseded -> settlePending completes every pending post", () => {
      const { effects } = step(bound({ pending }), {
        type: "frame",
        conn: 1,
        frame: { type: "refused", reason: SUPERSEDED },
      });
      expect(effects.slice(0, 3)).toEqual([...settled, CANCEL]);
    });

    it("VT-1: session_shutdown -> settlePending completes every pending post", () => {
      const { effects } = step(bound({ pending }), { type: "session_shutdown" });
      expect(effects.slice(0, 3)).toEqual([...settled, CANCEL]);
    });

    it("VT-1: a post answered by its deadline is not settled again", () => {
      const { effects } = run(
        bound({ pending }),
        { type: "deadline", key: { post: "p1" } },
        { type: "session_shutdown" },
      );
      expect(effects.filter((effect) => effect.type === "complete")).toEqual([
        unknown("p1"),
        unknown("p2"),
      ]);
    });
  });

  describe("stale connections (VT-1)", () => {
    it("frame, closed and deadline on an old conn -> ignored", () => {
      const start = boundEnding({}, { pending: [pendingPost("p1")] });
      const events: readonly BridgeEvent[] = [
        { type: "frame", conn: 0, frame: { type: "refused", reason: "bad token" } },
        { type: "closed", conn: 0, reason: "connection reset" },
        { type: "deadline", key: { conn: 0, request: "end" } },
      ];
      for (const event of events) {
        const { state: next, effects } = step(start, event);
        expect(effects).toEqual([]);
        expect(next).toEqual(start);
      }
    });
  });

  describe("busy gaps (VT-2, RV-021 F-1, F-9)", () => {
    it("RV-021 F-1: deliver with isIdle false before agent_start is buffered; an abort in that gap flushes it as a note", () => {
      const turn = delivery(4, "turn");
      const gap = run(bound(), { type: "deliver", conn: 1, delivery: turn, idle: false });
      expect(gap.effects).toEqual([]);
      expect(gap.state).toEqual(bound({ buffer: [turn] }));
      const settled = step(gap.state, { type: "agent_settled", aborted: true });
      expect(settled.effects).toEqual([inject(turn, false)]);
      expect(settled.state.running).toBe(false);
    });

    it("RV-021 F-9: an agent_end before settle (retryable error) flushes nothing; the final agent_settled does", () => {
      const note = delivery(2, "note");
      const busy = run(
        bound(),
        { type: "agent_start" },
        { type: "deliver", conn: 1, delivery: note, idle: false },
        { type: "agent_end" },
        { type: "agent_start" },
        { type: "agent_end" },
      );
      expect(busy.effects).toEqual([]);
      expect(busy.state).toEqual(bound({ buffer: [note] }, { running: true }));
      expect(step(busy.state, { type: "agent_settled", aborted: false }).effects).toEqual([
        inject(note, false),
      ]);
    });
  });

  describe("reload and dedupe (VT-3 F-10)", () => {
    it("F-10: a seq injected before a reload is never injected again, and is re-acked", () => {
      const key = keyOf(5);
      const message = delivery(5, "note");
      const { effects } = run(
        bound(),
        { type: "deliver", conn: 1, delivery: message, idle: false },
        { type: "agent_settled", aborted: false },
        { type: "persisted", key },
        { type: "session_shutdown" },
        {
          type: "session_start",
          session: PAIRING.session,
          project: "proj",
          latest: { kind: "pairing", ...PAIRING },
          messages: [key],
        },
        { type: "frame", conn: 2, frame: { type: "paired", conversation: PAIRING.conversation } },
        { type: "deliver", conn: 2, delivery: message, idle: true },
        { type: "agent_start" },
        { type: "agent_settled", aborted: false },
      );
      expect(effects.filter((effect) => effect.type === "inject")).toEqual([
        inject(message, false),
      ]);
      const acks = effects.filter(
        (effect) => effect.type === "send" && effect.frame.type === "ack",
      );
      expect(acks).toEqual([send(1, { type: "ack", seq: 5 }), send(2, { type: "ack", seq: 5 })]);
    });

    it("F-13: after end and re-pair the old pending id is not resent", () => {
      const { effects } = run(
        boundEnding({}, { pending: [pendingPost("call-1")] }),
        { type: "frame", conn: 1, frame: { type: "refused", reason: "pairing ended" } },
        { type: "pair", posture: "delegate" },
        {
          type: "frame",
          conn: 2,
          frame: { type: "paired", conversation: "conv-b", token: "token-b" },
        },
      );
      expect(effects.filter((effect) => effect.type === "complete")).toEqual([unknown("call-1")]);
      expect(
        effects.filter((effect) => effect.type === "send" && effect.frame.type === "post"),
      ).toEqual([]);
    });
  });

  describe("purity (VT-1)", () => {
    it("step does not mutate its input", () => {
      const start = freezeState(
        bound(
          { buffer: [delivery(2)], pending: [pendingPost("p1")] },
          { inSession: [keyOf(1)], injected: [keyOf(2)] },
        ),
      );
      const copy = structuredClone(start);
      expect(() => step(start, { type: "agent_settled", aborted: false })).not.toThrow();
      expect(() => step(start, { type: "session_shutdown" })).not.toThrow();
      expect(() =>
        step(start, {
          type: "session_start",
          session: "session-b",
          project: "proj",
          latest: { kind: "unpaired" },
          messages: [keyOf(3)],
        }),
      ).not.toThrow();
      expect(start).toEqual(copy);
    });
  });
});
