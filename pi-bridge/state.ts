// SL-009 design sec-7: the pi side's pure transition function. pi events and
// socket events go in; the next state and the effects the shell performs
// (pi-bridge/index.ts, PHASE-09) come out. No I/O here: effects are data.

import {
  BRIDGE_BODY_MAX_BYTES,
  type BoundFrame,
  capHeadTail,
  type DaemonFrame,
  type DeliverFrame,
  type FirstLineFrame,
  type PairFrame,
  type Posture,
  type RefusedFrame,
} from "./wire.ts";

/** What a `/bridge pair` asks for (sec-7): the posture, and the conversation when one was named. */
export type PairRequest = Pick<PairFrame, "posture" | "conversation">;

/** What a pairing entry in pi's session records (appendEntry), and what resume needs. */
export interface Pairing {
  /** The pi session id that made the pairing (`ctx.sessionManager.getSessionId()`). */
  session: string;
  conversation: string;
  token: string;
  posture: Posture;
}

/** The latest bridge entry in pi's session: a pairing, or the unpaired marker. */
export type BridgeEntry = ({ kind: "pairing" } & Pairing) | { kind: "unpaired" };

/** A bridge message already in pi's session, by its custom message `details`. */
export interface MessageKey {
  pairing: string;
  seq: number;
}

/** A delivered message: the deliver frame without its type. */
export type Delivery = Omit<DeliverFrame, "type">;

/** A `bridge_post` sent on this pairing and not yet answered. */
export interface PendingPost {
  id: string;
  text: string;
}

/** What the paired states (`resuming`, `bound`, `outage`) hold. */
export interface Paired {
  pairing: Pairing;
  /** Deliveries held while pi is busy, in seq order (DEC-090). */
  buffer: readonly Delivery[];
  pending: readonly PendingPost[];
}

export type Phase =
  | { name: "unpaired" }
  /** `pairing`: the postures (and conversation, when asked for) the pair frame carried. */
  | ({ name: "pairing" } & PairRequest)
  /** `outage`: the attempts failed so far in the current outage; 0 when not after an outage. */
  | { name: "resuming"; paired: Paired; outage: number }
  /** `ending`: a `/bridge end` is awaiting its answer; `then` is the pair request (`/bridge pair`'s posture and conversation) a re-pair uses once it is answered. */
  | { name: "bound"; paired: Paired; ending?: { then?: PairRequest } }
  | { name: "outage"; paired: Paired; attempt: number };

export interface BridgeState {
  phase: Phase;
  /** Set from `agent_start` or the extension's own turn injection until `agent_settled`. */
  running: boolean;
  /** Generation of the current connection; events stamped with another are stale and ignored. 0: none yet. */
  conn: number;
  /** This pi session's id and project root basename, from `session_start`. */
  session: string;
  project: string;
  /** Bridge messages persisted in pi's session (the dedupe record). */
  inSession: readonly MessageKey[];
  /** Injected by this process and not yet reported persisted. */
  injected: readonly MessageKey[];
}

/** A reply deadline (BRIDGE_POST_WAIT_MS from send): a connection's request, or a post's. */
export type DeadlineKey = { conn: number; request: "pair" | "resume" | "end" } | { post: string };

export type BridgeEvent =
  | {
      type: "session_start";
      session: string;
      project: string;
      latest: BridgeEntry | undefined;
      messages: readonly MessageKey[];
    }
  | { type: "session_shutdown" }
  | ({ type: "pair" } & PairRequest)
  | { type: "end" }
  /** A daemon frame other than `deliver` on connection `conn`. */
  | { type: "frame"; conn: number; frame: Exclude<DaemonFrame, DeliverFrame> }
  /** A `deliver` frame; `idle` is `ctx.isIdle()` sampled when it arrived. */
  | { type: "deliver"; conn: number; delivery: Delivery; idle: boolean }
  /** Connect failure or connection drop. */
  | { type: "closed"; conn: number; reason: string }
  | { type: "deadline"; key: DeadlineKey }
  | { type: "retry" }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "agent_settled"; aborted: boolean }
  /** An interactive (operator) input. */
  | { type: "input" }
  /** A `bridge_post` tool call. */
  | { type: "post"; id: string; text: string }
  /** An injected message's entry is now in pi's session. */
  | { type: "persisted"; key: MessageKey };

export type PostOutcome =
  | { kind: "sent" }
  | { kind: "refused"; reason: string }
  | { kind: "unknown" }
  /** Not bound when called: the shell answers with `outageText(ends)`. */
  | { kind: "not bound" };

export type Notice =
  | { kind: "outage"; reason: string }
  | { kind: "recovered" }
  | { kind: "pair failed"; reason: string; mayHavePaired: boolean; conversation?: string }
  | { kind: "refused"; reason: string }
  | { kind: "forked pairing" }
  | { kind: "busy"; phase: "pairing" | "resuming" | "outage" | "ending" }
  | { kind: "end unanswered" }
  | { kind: "ended" }
  /** `/bridge end` in an outage: unpaired here only; the daemon's pairing is left as is. */
  | { kind: "ended locally" }
  | { kind: "not paired" };

/** What `setStatus` shows. */
export interface StatusView {
  phase: Phase["name"];
  attempt?: number;
}

export type Effect =
  /** Open connection `conn` and write its first line. */
  | { type: "connect"; conn: number; frame: FirstLineFrame }
  | { type: "send"; conn: number; frame: BoundFrame }
  | { type: "close"; conn: number }
  /** Arm a BRIDGE_POST_WAIT_MS timer that feeds back `{type: "deadline", key}`. */
  | { type: "deadline"; key: DeadlineKey }
  /** Arm the retry timer (backoff by `attempt`) that feeds back `{type: "retry"}`. */
  | { type: "retry"; attempt: number }
  /** Clear every armed timer (deadlines and retry). */
  | { type: "cancel timers" }
  /** Complete a `bridge_post` call. */
  | { type: "complete"; id: string; outcome: PostOutcome }
  /** Inject as a custom message (`details {pairing, seq}`); report `persisted` once its entry is in the session. */
  | { type: "inject"; pairing: string; delivery: Delivery; triggerTurn: boolean }
  | { type: "append"; entry: BridgeEntry }
  /** Set (or with null, clear) the spawn hook's bridge env. */
  | { type: "env"; env: { conversation: string; token: string } | null }
  | { type: "notify"; level: "info" | "error"; notice: Notice }
  | { type: "status"; status: StatusView };

export interface Step {
  state: BridgeState;
  effects: readonly Effect[];
}

export const initialState: BridgeState = {
  phase: { name: "unpaired" },
  running: false,
  conn: 0,
  session: "",
  project: "",
  inSession: [],
  injected: [],
};

// --- shapes the table leans on ----------------------------------------------

/** One event type's own event shape. */
type EventOf<T extends BridgeEvent["type"]> = Extract<BridgeEvent, { type: T }>;

/** A daemon reply: any daemon frame but `deliver` (which arrives as its own event). */
type DaemonReply = Exclude<DaemonFrame, DeliverFrame>;

/** The phases that hold a `paired` (sec-7 `settlePending`, `supersede`, `unpair`). */
type PairedPhase = Extract<Phase, { paired: Paired }>;
type BoundPhase = Extract<Phase, { name: "bound" }>;
type PairingPhase = Extract<Phase, { name: "pairing" }>;
type ResumingPhase = Extract<Phase, { name: "resuming" }>;

/** One row of the table: any event type, narrowed by the row's selector. */
type StepHandler = (state: BridgeState, event: BridgeEvent) => Step;

/** The phases a `busy` report can name (sec-7 `busy`). */
type BusyPhase = Extract<Notice, { kind: "busy" }>["phase"];

/** A refusal that ends the pairing (sec-7 general rules, sec-4 `superseded by a new pairing`). */
const TERMINAL_REASONS = ["pairing ended", "bad token", "superseded by a new pairing"];

/** The daemon's word for a sibling connection taking the conversation (sec-7). */
const SUPERSEDED = "superseded by a newer connection";

/** Whether `reason` ends the pairing rather than answering one frame. */
const isTerminal = (reason: string): boolean => TERMINAL_REASONS.includes(reason);

// --- small pure helpers ------------------------------------------------------

/** The phase unchanged and no effects (sec-7 general rules `stale`, and every ignored row). */
const unchanged = (state: BridgeState): Step => ({ state, effects: [] });

/** `state` with `change` applied, emitting `effects`: how a row returns a new state. */
const next = (
  state: BridgeState,
  change: Partial<BridgeState>,
  effects: readonly Effect[] = [],
): Step => ({ state: { ...state, ...change }, effects });

/** `step` with `lead` emitted before its own effects (an answer that precedes an exit). */
const precededBy = (step: Step, lead: readonly Effect[]): Step => ({
  state: step.state,
  effects: [...lead, ...step.effects],
});

/** `step` with `trail` emitted after its own effects (the report that follows an exit). */
const followedBy = (step: Step, trail: readonly Effect[]): Step => ({
  state: step.state,
  effects: [...step.effects, ...trail],
});

/** A row that only reports something (sec-7 `busy`, `not paired`, `forked pairing`). */
const tells = (state: BridgeState, level: "info" | "error", notice: Notice): Step =>
  next(state, {}, [{ type: "notify", level, notice }]);

/** The daemon's reason reported as an error (sec-7 `refused`). */
const refusal = (reason: string): Effect => ({
  type: "notify",
  level: "error",
  notice: { kind: "refused", reason },
});

/** A pair or end asked for while a pairing is already in flight (sec-7 `busy`). */
const busy = (state: BridgeState, phase: BusyPhase): Step =>
  tells(state, "error", { kind: "busy", phase });

/** The `paired` a phase holds, if it holds one. */
const pairedPhase = (phase: Phase): PairedPhase | undefined =>
  phase.name === "bound" || phase.name === "resuming" || phase.name === "outage"
    ? phase
    : undefined;

/** Whether `key` names the same injected or session message. */
const sameKey = (left: MessageKey, right: MessageKey): boolean =>
  left.pairing === right.pairing && left.seq === right.seq;

/** Whether `keys` holds `key` (the dedupe record, F-10). */
const hasKey = (keys: readonly MessageKey[], key: MessageKey): boolean =>
  keys.some((held) => sameKey(held, key));

/** Whether post `id` is still awaiting its answer. */
const isPending = (paired: Paired, id: string): boolean =>
  paired.pending.some((post) => post.id === id);

/** `pending` without post `id`. */
const without = (pending: readonly PendingPost[], id: string): readonly PendingPost[] =>
  pending.filter((post) => post.id !== id);

/** `phase` bound with `paired`, keeping the `ending` it already carries. */
const boundWith = (phase: BoundPhase, paired: Paired): BoundPhase =>
  phase.ending === undefined
    ? { name: "bound", paired }
    : { name: "bound", paired, ending: phase.ending };

/** `phase` with its `paired` replaced, keeping its own attempt or ending. */
function withPaired(phase: PairedPhase, paired: Paired): PairedPhase {
  if (phase.name === "bound") {
    return boundWith(phase, paired);
  }
  if (phase.name === "resuming") {
    return { name: "resuming", paired, outage: phase.outage };
  }
  return { name: "outage", paired, attempt: phase.attempt };
}

// --- sec-7's shared steps ----------------------------------------------------

/** sec-7 `settlePending`: every pending post completes unknown, then every timer is cancelled. */
function settle(paired: Paired): readonly Effect[] {
  return [
    ...paired.pending.map(
      (post): Effect => ({ type: "complete", id: post.id, outcome: { kind: "unknown" } }),
    ),
    { type: "cancel timers" },
  ];
}

/** sec-7 `unpair`: settle, close, append the unpaired marker, clear env; the phase is unpaired. */
function unpair(state: BridgeState, paired: Paired): Step {
  return next(state, { phase: { name: "unpaired" } }, [
    ...settle(paired),
    { type: "close", conn: state.conn },
    { type: "append", entry: { kind: "unpaired" } },
    { type: "env", env: null },
  ]);
}

/** sec-7 `supersede`: settle, close, clear env and report; no append (the daemon kept the pairing). */
function supersede(state: BridgeState, paired: Paired, reason: string): Step {
  return next(state, { phase: { name: "unpaired" } }, [
    ...settle(paired),
    { type: "close", conn: state.conn },
    { type: "env", env: null },
    refusal(reason),
  ]);
}

/** sec-7 `end unanswered`: unpair, then report it; a pending re-pair is dropped. */
function endUnanswered(state: BridgeState, paired: Paired): Step {
  return followedBy(unpair(state, paired), [
    { type: "notify", level: "error", notice: { kind: "end unanswered" } },
  ]);
}

/** sec-7 pairing failures: unpaired, `pair failed`; `open` when the conn still needs closing. */
function pairFailed(
  state: BridgeState,
  reason: string,
  mayHavePaired: boolean,
  open: boolean,
  conversation?: string,
): Step {
  const notice: Effect = {
    type: "notify",
    level: "error",
    notice:
      conversation === undefined
        ? { kind: "pair failed", reason, mayHavePaired }
        : { kind: "pair failed", reason, mayHavePaired, conversation },
  };
  return next(
    state,
    { phase: { name: "unpaired" } },
    open ? [{ type: "close", conn: state.conn }, notice] : [notice],
  );
}

/** sec-7 general rules `connect`: open `conn + 1` with `frame`, then arm its reply deadline. */
function connect(
  state: BridgeState,
  phase: Phase,
  frame: FirstLineFrame,
  request: "pair" | "resume",
  rest: Partial<BridgeState> = {},
): Step {
  const conn = state.conn + 1;
  return next(state, { ...rest, phase, conn }, [
    { type: "connect", conn, frame },
    { type: "deadline", key: { conn, request } },
  ]);
}

/** sec-7 `outage step`: outage at `attempt + 1`, close, report the first failure, then retry. */
function outageStep(state: BridgeState, paired: Paired, attempt: number, reason: string): Step {
  const effects: Effect[] = [{ type: "close", conn: state.conn }];
  if (attempt === 0) {
    effects.push({ type: "notify", level: "error", notice: { kind: "outage", reason } });
  }
  effects.push({ type: "retry", attempt: attempt + 1 });
  return next(state, { phase: { name: "outage", paired, attempt: attempt + 1 } }, effects);
}

/** The resume request a stored pairing rebinds with (sec-7 `connect`). */
const resumeFrame = (pairing: Pairing): FirstLineFrame => ({
  type: "resume",
  conversation: pairing.conversation,
  token: pairing.token,
});

/** sec-7 `pair`: the first line a PairRequest sends; the `conversation` key is absent when none was asked for. */
const pairFrame = (request: PairRequest, project: string): FirstLineFrame => ({
  type: "pair",
  project,
  ...request,
});

/** sec-7 `pairing`: the pairing phase a PairRequest enters, keeping the conversation it named. */
const pairingPhaseOf = (request: PairRequest): PairingPhase => ({ name: "pairing", ...request });

// --- sec-7's bound rows ------------------------------------------------------

/** sec-7 bound `accepted`: a pending post is sent; any other answer is ignored. */
function acceptedPost(state: BridgeState, phase: BoundPhase, id: string | undefined): Step {
  if (id === undefined || !isPending(phase.paired, id)) {
    return unchanged(state);
  }
  const paired: Paired = { ...phase.paired, pending: without(phase.paired.pending, id) };
  return next(state, { phase: boundWith(phase, paired) }, [
    { type: "complete", id, outcome: { kind: "sent" } },
  ]);
}

/** sec-7 bound terminal `refused`: unpair, then `ended` (the end's answer) or `refused`; re-pair if asked. */
function terminalRefusal(
  state: BridgeState,
  phase: BoundPhase,
  paired: Paired,
  reason: string,
): Step {
  const ended = phase.ending !== undefined && reason === "pairing ended";
  const out = followedBy(unpair(state, paired), [
    ended ? { type: "notify", level: "info", notice: { kind: "ended" } } : refusal(reason),
  ]);
  const then = phase.ending?.then;
  if (!ended || then === undefined) {
    return out;
  }
  return precededBy(
    connect(out.state, pairingPhaseOf(then), pairFrame(then, state.project), "pair"),
    out.effects,
  );
}

/** sec-7 bound `refused`: answer a pending post, then end the pairing or just report it. */
function boundRefused(state: BridgeState, phase: BoundPhase, frame: RefusedFrame): Step {
  const id = frame.id;
  const reason = frame.reason;
  const hit = id !== undefined && isPending(phase.paired, id) ? id : undefined;
  const paired: Paired =
    hit === undefined
      ? phase.paired
      : { ...phase.paired, pending: without(phase.paired.pending, hit) };
  const lead: readonly Effect[] =
    hit === undefined ? [] : [{ type: "complete", id: hit, outcome: { kind: "refused", reason } }];
  if (isTerminal(reason)) {
    return precededBy(terminalRefusal(state, phase, paired, reason), lead);
  }
  if (reason === SUPERSEDED) {
    return precededBy(supersede(state, paired, reason), lead);
  }
  if (hit === undefined) {
    return tells(state, "error", { kind: "refused", reason });
  }
  return next(state, { phase: boundWith(phase, paired) }, lead);
}

/** sec-7 bound `frame`: the posts' answers, and the refusals that end the pairing. */
function boundFrame(state: BridgeState, phase: BoundPhase, frame: DaemonReply): Step {
  if (frame.type === "accepted") {
    return acceptedPost(state, phase, frame.id);
  }
  if (frame.type === "refused") {
    return boundRefused(state, phase, frame);
  }
  return unchanged(state);
}

/** sec-7 bound `post`: a capped turn is pending until its answer; a re-post of a pending id is ignored. */
function postEvent(state: BridgeState, event: EventOf<"post">): Step {
  const phase = state.phase;
  if (phase.name !== "bound") {
    return next(state, {}, [{ type: "complete", id: event.id, outcome: { kind: "not bound" } }]);
  }
  if (isPending(phase.paired, event.id)) {
    return unchanged(state);
  }
  const text = capHeadTail(event.text, BRIDGE_BODY_MAX_BYTES);
  const post: PendingPost = { id: event.id, text };
  return next(
    state,
    { phase: boundWith(phase, { ...phase.paired, pending: [...phase.paired.pending, post] }) },
    [
      { type: "send", conn: state.conn, frame: { type: "post", id: event.id, kind: "turn", text } },
      { type: "deadline", key: { post: event.id } },
    ],
  );
}

// --- sec-7's resuming and pairing rows --------------------------------------

/** sec-7 resuming `frame paired`: bound again, env from the stored pairing, the pending posts resent. */
function recovered(state: BridgeState, paired: Paired, outage: number): Step {
  const { conversation, token } = paired.pairing;
  const effects: Effect[] = [{ type: "env", env: { conversation, token } }];
  if (outage > 0) {
    effects.push({ type: "notify", level: "info", notice: { kind: "recovered" } });
  }
  for (const post of paired.pending) {
    effects.push({
      type: "send",
      conn: state.conn,
      frame: { type: "post", id: post.id, kind: "turn", text: post.text },
    });
  }
  return next(state, { phase: { name: "bound", paired } }, effects);
}

/** sec-7 resuming `frame`: the stored pairing binds; superseded ends it, any other refusal unpairs. */
function resumingFrame(state: BridgeState, phase: ResumingPhase, frame: DaemonReply): Step {
  const { paired, outage } = phase;
  if (frame.type === "paired") {
    return recovered(state, paired, outage);
  }
  if (frame.type !== "refused") {
    return unchanged(state);
  }
  if (frame.reason === SUPERSEDED) {
    return supersede(state, paired, frame.reason);
  }
  return followedBy(unpair(state, paired), [refusal(frame.reason)]);
}

/** sec-7 pairing `frame`: a token pairs the session, anything else is a pair failure. */
function pairingFrame(state: BridgeState, phase: PairingPhase, frame: DaemonReply): Step {
  if (frame.type === "paired") {
    const token = frame.token;
    if (token === undefined) {
      return pairFailed(state, "paired without a token", false, true, phase.conversation);
    }
    const pairing: Pairing = {
      session: state.session,
      conversation: frame.conversation,
      token,
      posture: phase.posture,
    };
    return next(state, { phase: { name: "bound", paired: { pairing, buffer: [], pending: [] } } }, [
      { type: "append", entry: { kind: "pairing", ...pairing } },
      { type: "env", env: { conversation: pairing.conversation, token } },
    ]);
  }
  if (frame.type !== "refused") {
    return unchanged(state);
  }
  return pairFailed(state, frame.reason, false, true, phase.conversation);
}

// --- sec-7's delivery rows (DEC-090) ----------------------------------------

/** The buffer with `delivery` inserted in seq order. */
function buffered(buffer: readonly Delivery[], delivery: Delivery): readonly Delivery[] {
  const at = buffer.findIndex((held) => held.seq > delivery.seq);
  return at < 0 ? [...buffer, delivery] : [...buffer.slice(0, at), delivery, ...buffer.slice(at)];
}

/** sec-7 `agent_settled`: the deliveries to inject — up to the first turn, or all when aborted. */
function flushOf(paired: Paired, aborted: boolean): readonly Delivery[] {
  if (aborted) {
    return paired.buffer;
  }
  const turn = paired.buffer.findIndex((delivery) => delivery.kind === "turn");
  return turn < 0 ? paired.buffer : paired.buffer.slice(0, turn + 1);
}

/** sec-7 `agent_settled`: stop running, then flush the buffer (the only place that flushes). */
function agentSettled(state: BridgeState, event: EventOf<"agent_settled">): Step {
  const phase = pairedPhase(state.phase);
  if (phase === undefined) {
    return next(state, { running: false });
  }
  const paired = phase.paired;
  const conversation = paired.pairing.conversation;
  const flushed = flushOf(paired, event.aborted);
  const triggerTurn = (delivery: Delivery): boolean => !event.aborted && delivery.kind === "turn";
  return next(
    state,
    {
      phase: withPaired(phase, { ...paired, buffer: paired.buffer.slice(flushed.length) }),
      running: flushed.some(triggerTurn),
      injected: [
        ...state.injected,
        ...flushed.map((delivery): MessageKey => ({ pairing: conversation, seq: delivery.seq })),
      ],
    },
    flushed.map(
      (delivery): Effect => ({
        type: "inject",
        pairing: conversation,
        delivery,
        triggerTurn: triggerTurn(delivery),
      }),
    ),
  );
}

/** sec-7 `deliver`: re-ack a message the session already holds. */
const reAcked = (state: BridgeState, delivery: Delivery): Step =>
  next(state, {}, [{ type: "send", conn: state.conn, frame: { type: "ack", seq: delivery.seq } }]);

/** sec-7 `deliver`: whether the key is already injected, or its seq already buffered (the dedupe). */
const knownDelivery = (state: BridgeState, phase: BoundPhase, key: MessageKey): boolean =>
  hasKey(state.injected, key) || phase.paired.buffer.some((held) => held.seq === key.seq);

/** sec-7 `deliver`: an idle, not-running pairing injects the message now (DEC-090). */
function injectDelivery(state: BridgeState, phase: BoundPhase, delivery: Delivery): Step {
  const pairing = phase.paired.pairing.conversation;
  const triggerTurn = delivery.kind === "turn";
  return next(
    state,
    { running: triggerTurn, injected: [...state.injected, { pairing, seq: delivery.seq }] },
    [{ type: "inject", pairing, delivery, triggerTurn }],
  );
}

/** sec-7 `deliver`: re-ack, skip, inject when idle, else buffer in seq order. */
function deliverEvent(state: BridgeState, event: EventOf<"deliver">): Step {
  const phase = state.phase;
  if (phase.name !== "bound" || event.conn !== state.conn) {
    return unchanged(state);
  }
  const { delivery, idle } = event;
  const key: MessageKey = { pairing: phase.paired.pairing.conversation, seq: delivery.seq };
  if (hasKey(state.inSession, key)) {
    return reAcked(state, delivery);
  }
  if (knownDelivery(state, phase, key)) {
    return unchanged(state);
  }
  if (!idle || state.running) {
    const paired = { ...phase.paired, buffer: buffered(phase.paired.buffer, delivery) };
    return next(state, { phase: boundWith(phase, paired) });
  }
  return injectDelivery(state, phase, delivery);
}

/** sec-7 `persisted`: the injected key joins the session; a bound conversation is acked. */
function persistedEvent(state: BridgeState, event: EventOf<"persisted">): Step {
  const { key } = event;
  const change: Partial<BridgeState> = {
    injected: state.injected.filter((held) => !sameKey(held, key)),
    inSession: hasKey(state.inSession, key) ? state.inSession : [...state.inSession, key],
  };
  const phase = state.phase;
  if (phase.name !== "bound" || key.pairing !== phase.paired.pairing.conversation) {
    return next(state, change);
  }
  return next(state, change, [
    { type: "send", conn: state.conn, frame: { type: "ack", seq: key.seq } },
  ]);
}

// --- sec-7's session and lifecycle rows -------------------------------------

/** sec-7 session_start: a new session adopts the latest entry; only its own session resumes it. */
function sessionStart(state: BridgeState, event: EventOf<"session_start">): Step {
  const adopted: Partial<BridgeState> = {
    session: event.session,
    project: event.project,
    inSession: event.messages,
    injected: [],
    running: false,
  };
  const latest = event.latest;
  if (latest === undefined || latest.kind === "unpaired") {
    return next(state, { ...adopted, phase: { name: "unpaired" } });
  }
  if (latest.session !== event.session) {
    return next(state, { ...adopted, phase: { name: "unpaired" } }, [
      { type: "notify", level: "info", notice: { kind: "forked pairing" } },
    ]);
  }
  const pairing: Pairing = {
    session: latest.session,
    conversation: latest.conversation,
    token: latest.token,
    posture: latest.posture,
  };
  const phase: Phase = {
    name: "resuming",
    paired: { pairing, buffer: [], pending: [] },
    outage: 0,
  };
  return connect(state, phase, resumeFrame(pairing), "resume", adopted);
}

/** sec-7 session_shutdown: settle and close, then unpaired; no append, no env. */
function shutdownEvent(state: BridgeState): Step {
  const phase = pairedPhase(state.phase);
  const effects: Effect[] = phase === undefined ? [] : [...settle(phase.paired)];
  if (state.conn > 0 && state.phase.name !== "unpaired") {
    effects.push({ type: "close", conn: state.conn });
  }
  return next(state, { phase: { name: "unpaired" } }, effects);
}

/** sec-7 `/bridge end` (and the first half of a bound `/bridge pair`): send `end`, await its answer. */
const askEnd = (state: BridgeState, phase: BoundPhase, ending: { then?: PairRequest }): Step =>
  next(state, { phase: { name: "bound", paired: phase.paired, ending } }, [
    { type: "send", conn: state.conn, frame: { type: "end" } },
    { type: "deadline", key: { conn: state.conn, request: "end" } },
  ]);

/** sec-7 `pair`: unpaired pairs now; bound asks its pairing to end first; anything else is busy. */
function pairEvent(state: BridgeState, event: EventOf<"pair">): Step {
  const request: PairRequest =
    event.conversation === undefined
      ? { posture: event.posture }
      : { posture: event.posture, conversation: event.conversation };
  const phase = state.phase;
  if (phase.name === "unpaired") {
    return connect(state, pairingPhaseOf(request), pairFrame(request, state.project), "pair");
  }
  if (phase.name !== "bound") {
    return busy(state, phase.name);
  }
  if (phase.ending !== undefined) {
    return busy(state, "ending");
  }
  return askEnd(state, phase, { then: request });
}

/**
 * sec-7 `end`: a bound pairing is asked to end; an outage unpairs locally
 * (operator ruling 2026-10-30: no frame, the daemon's pairing is left as is);
 * anything else is busy or not paired.
 */
function endEvent(state: BridgeState): Step {
  const phase = state.phase;
  if (phase.name === "unpaired") {
    return tells(state, "info", { kind: "not paired" });
  }
  if (phase.name === "outage") {
    return followedBy(unpair(state, phase.paired), [
      { type: "notify", level: "info", notice: { kind: "ended locally" } },
    ]);
  }
  if (phase.name !== "bound") {
    return busy(state, phase.name);
  }
  if (phase.ending !== undefined) {
    return busy(state, "ending");
  }
  return askEnd(state, phase, {});
}

/** sec-7 `frame`: only the current connection's frames count; the phase picks the row. */
function frameEvent(state: BridgeState, event: EventOf<"frame">): Step {
  if (event.conn !== state.conn) {
    return unchanged(state);
  }
  const phase = state.phase;
  if (phase.name === "pairing") {
    return pairingFrame(state, phase, event.frame);
  }
  if (phase.name === "resuming") {
    return resumingFrame(state, phase, event.frame);
  }
  if (phase.name !== "bound") {
    return unchanged(state);
  }
  return boundFrame(state, phase, event.frame);
}

/** sec-7 `closed`: pairing fails, resuming and bound go to outage, a bound `ending` unpairs. */
function closedEvent(state: BridgeState, event: EventOf<"closed">): Step {
  if (event.conn !== state.conn) {
    return unchanged(state);
  }
  const phase = state.phase;
  if (phase.name === "pairing") {
    return pairFailed(state, event.reason, false, false, phase.conversation);
  }
  if (phase.name === "resuming") {
    return outageStep(state, phase.paired, phase.outage, event.reason);
  }
  if (phase.name !== "bound") {
    return unchanged(state);
  }
  if (phase.ending !== undefined) {
    return endUnanswered(state, phase.paired);
  }
  return outageStep(state, phase.paired, 0, event.reason);
}

/** sec-7 deadline `{post}`: the unanswered post completes unknown and is not resent. */
function postDeadline(state: BridgeState, id: string): Step {
  const phase = pairedPhase(state.phase);
  if (phase === undefined || !isPending(phase.paired, id)) {
    return unchanged(state);
  }
  const paired: Paired = { ...phase.paired, pending: without(phase.paired.pending, id) };
  return next(state, { phase: withPaired(phase, paired) }, [
    { type: "complete", id, outcome: { kind: "unknown" } },
  ]);
}

/** sec-7 deadline `{conn, request}`: the connection's unanswered request, else ignored. */
function requestDeadline(state: BridgeState, request: "pair" | "resume" | "end"): Step {
  const phase = state.phase;
  if (request === "pair" && phase.name === "pairing") {
    return pairFailed(state, "no reply", true, true, phase.conversation);
  }
  if (request === "resume" && phase.name === "resuming") {
    return outageStep(state, phase.paired, phase.outage, "no reply");
  }
  if (request === "end" && phase.name === "bound" && phase.ending !== undefined) {
    return endUnanswered(state, phase.paired);
  }
  return unchanged(state);
}

/** sec-7 `deadline`: a post's deadline is independent of connections; a request's is not. */
function deadlineEvent(state: BridgeState, event: EventOf<"deadline">): Step {
  const key = event.key;
  if ("post" in key) {
    return postDeadline(state, key.post);
  }
  return key.conn === state.conn ? requestDeadline(state, key.request) : unchanged(state);
}

/** sec-7 `retry`: an outage retries the resume; outside an outage it is ignored. */
function retryEvent(state: BridgeState): Step {
  const phase = state.phase;
  if (phase.name !== "outage") {
    return unchanged(state);
  }
  const resuming: Phase = { name: "resuming", paired: phase.paired, outage: phase.attempt };
  return connect(state, resuming, resumeFrame(phase.paired.pairing), "resume");
}

/** sec-7 `input`: a bound pairing asks for more turns; nothing else happens. */
function inputEvent(state: BridgeState): Step {
  if (state.phase.name !== "bound") {
    return unchanged(state);
  }
  return next(state, {}, [{ type: "send", conn: state.conn, frame: { type: "refill" } }]);
}

/** sec-7 `agent_start`: the agent is running now. */
const agentStart = (state: BridgeState): Step => next(state, { running: true });

/** sec-7 `agent_end`: no change, no effects (RV-021 F-9: only agent_settled flushes). */
const agentEnd = (state: BridgeState): Step => unchanged(state);

// --- the table ---------------------------------------------------------------

/** Whether `event` is a `type` event, so a row runs only on its own. */
const isEvent = <T extends BridgeEvent["type"]>(event: BridgeEvent, type: T): event is EventOf<T> =>
  event.type === type;

/** One row of sec-7's table: `handle` runs for its own event type. */
const row =
  <T extends BridgeEvent["type"]>(
    type: T,
    handle: (state: BridgeState, event: EventOf<T>) => Step,
  ): StepHandler =>
  (state, event) =>
    isEvent(event, type) ? handle(state, event) : unchanged(state);

/** sec-7's table: one row per event type. */
const ROWS = {
  session_start: row("session_start", sessionStart),
  session_shutdown: row("session_shutdown", shutdownEvent),
  pair: row("pair", pairEvent),
  end: row("end", endEvent),
  frame: row("frame", frameEvent),
  deliver: row("deliver", deliverEvent),
  closed: row("closed", closedEvent),
  deadline: row("deadline", deadlineEvent),
  retry: row("retry", retryEvent),
  agent_start: row("agent_start", agentStart),
  agent_end: row("agent_end", agentEnd),
  agent_settled: row("agent_settled", agentSettled),
  input: row("input", inputEvent),
  post: row("post", postEvent),
  persisted: row("persisted", persistedEvent),
} satisfies Record<BridgeEvent["type"], StepHandler>;

/** sec-7 general rules `status`: the view the shell shows for `phase`. */
const viewOf = (phase: Phase): StatusView =>
  phase.name === "outage" ? { phase: phase.name, attempt: phase.attempt } : { phase: phase.name };

/** sec-7 general rules `status`: the effect when `(phase.name, attempt)` changed, else none. */
function statusOf(before: Phase, after: Phase): readonly Effect[] {
  const from = viewOf(before);
  const to = viewOf(after);
  return from.phase === to.phase && from.attempt === to.attempt
    ? []
    : [{ type: "status", status: to }];
}

/** Design sec-7's table. */
export function step(state: BridgeState, event: BridgeEvent): Step {
  const transition = ROWS[event.type](state, event);
  return {
    state: transition.state,
    effects: [...transition.effects, ...statusOf(state.phase, transition.state.phase)],
  };
}
