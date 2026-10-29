// The bridge wire: the frames the daemon and pi's extension exchange over
// bridge.sock, the one parser both sides import, and the caps and socket path
// they share (SL-009 design sec-2, sec-4). It imports only node builtins: pi
// loads this file through jiti inside the jail, so it never reaches into src/.

import { join } from "node:path";

/** The body cap for bridge messages, in both directions (design sec-4). */
export const BRIDGE_BODY_MAX_BYTES = 32 * 1024;

/** JSON escapes a byte to at most 6 ("\u0001"), so a capped body's frame always fits. */
export const BRIDGE_LINE_MAX_BYTES = 6 * BRIDGE_BODY_MAX_BYTES + 4096;

/** Client-side reply deadline for every request frame (pair, resume, post, post-once). */
export const BRIDGE_POST_WAIT_MS = 30_000;

/** What pi does with SATAN's messages, and how it is told (DEC-072). */
export type Posture = "delegate" | "consult";

/** A message either asks for a turn or notes something for the next one (DEC-069). */
export type MessageKind = "turn" | "note";

// --- the client's first line -------------------------------------------------

/** Pair a fresh session with the project's conversation. */
export interface PairFrame {
  type: "pair";
  posture: Posture;
  project: string;
}

/** Rebind a session to a conversation it paired with before. */
export interface ResumeFrame {
  type: "resume";
  conversation: string;
  token: string;
}

/** One message, the same connection opened and closed around it (DEC-007). */
export interface PostOnceFrame {
  type: "post-once";
  conversation: string;
  token: string;
  kind: MessageKind;
  text: string;
}

export type FirstLineFrame = PairFrame | ResumeFrame | PostOnceFrame;

// --- the client's frames once bound ------------------------------------------

/** A message on a bound connection, acked by its id. */
export interface PostFrame {
  type: "post";
  id: string;
  kind: MessageKind;
  text: string;
}

/** The highest seq drained: the outbox may forget everything up to it. */
export interface AckFrame {
  type: "ack";
  seq: number;
}

/** Ask for more turns of the loop budget. */
export interface RefillFrame {
  type: "refill";
}

/** End the pairing; the conversation stays attachable. */
export interface EndFrame {
  type: "end";
}

export type BoundFrame = PostFrame | AckFrame | RefillFrame | EndFrame;

// --- the daemon's frames -----------------------------------------------------

/** The reply to pair (with a token) or resume (without one). */
export interface PairedFrame {
  type: "paired";
  conversation: string;
  token?: string;
}

/** The reply to post (with its id) or post-once (without one). */
export interface AcceptedFrame {
  type: "accepted";
  id?: string;
}

/** The reply to any frame the vocabulary names but the daemon will not act on. */
export interface RefusedFrame {
  type: "refused";
  id?: string;
  reason: string;
}

/** One outbox entry, in seq order, sent unprompted. */
export interface DeliverFrame {
  type: "deliver";
  seq: number;
  kind: MessageKind;
  text: string;
}

export type DaemonFrame = PairedFrame | AcceptedFrame | RefusedFrame | DeliverFrame;

/** A frame of vocabulary F, or the refusal to send back. */
export type Parsed<F> = { ok: true; frame: F } | { ok: false; refused: RefusedFrame };

// --- one table per vocabulary ------------------------------------------------

/** A frame's declared keys: every key its type names. */
type Declared<F> = Exclude<keyof F, "type">;

/** One key's check: the expectation its refusal states, whether it may be absent, and the value it yields. */
interface KeySpec<V> {
  /** `one of delegate, consult`, `a string`: what the key must be. */
  readonly expectation: string;
  /** An optional key may be absent; when present it must still pass `check`. */
  readonly optional: boolean;
  /** The key's value, or `undefined` when it fails the check. */
  readonly check: (value: unknown) => V | undefined;
}

/** A frame type's row: each declared key's spec, in the order the checks run. */
type KeyTable<F> = { readonly [K in Declared<F>]: KeySpec<NonNullable<F[K]>> };

/** One vocabulary: one row per frame type, so a frame without a row is a compile error. */
export type Vocabulary<F extends { type: string }> = {
  readonly [T in F["type"]]: KeyTable<Extract<F, { type: T }>>;
};

/** A row read as specs by key name: the parser checks keys, whatever frame names them. */
type Specs = Readonly<Record<string, KeySpec<unknown>>>;

/** A JSON object, as a line parses to one. */
type JsonRecord = Record<string, unknown>;

const POSTURES: readonly Posture[] = ["delegate", "consult"];
const KINDS: readonly MessageKind[] = ["turn", "note"];

/** A string key, required: `a string`. */
const text: KeySpec<string> = {
  expectation: "a string",
  optional: false,
  check: (value) => (typeof value === "string" ? value : undefined),
};

/** A non-negative safe integer key, required: `a non-negative integer`. */
const nonNegativeInteger: KeySpec<number> = {
  expectation: "a non-negative integer",
  optional: false,
  check: (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined,
};

/** One member of a closed vocabulary, required: `one of a, b`. */
const oneOf = <T extends string>(members: readonly T[]): KeySpec<T> => ({
  expectation: `one of ${members.join(", ")}`,
  optional: false,
  check: (value) => members.find((member) => member === value),
});

/** `spec`, which a frame may omit. */
const optional = <V>(spec: KeySpec<V>): KeySpec<V> => ({ ...spec, optional: true });

/** The first line's vocabulary (design sec-2's tables). */
export const FIRST_LINE_FRAMES: Vocabulary<FirstLineFrame> = {
  pair: { posture: oneOf(POSTURES), project: text },
  resume: { conversation: text, token: text },
  "post-once": { conversation: text, token: text, kind: oneOf(KINDS), text },
};

/** The bound client's vocabulary: post, ack, refill, end. */
export const BOUND_FRAMES: Vocabulary<BoundFrame> = {
  post: { id: text, kind: oneOf(KINDS), text },
  ack: { seq: nonNegativeInteger },
  refill: {},
  end: {},
};

/** The daemon's vocabulary: the replies and the outbox's deliveries. */
export const DAEMON_FRAMES: Vocabulary<DaemonFrame> = {
  paired: { conversation: text, token: optional(text) },
  accepted: { id: optional(text) },
  refused: { id: optional(text), reason: text },
  deliver: { seq: nonNegativeInteger, kind: oneOf(KINDS), text },
};

// --- the one parser ----------------------------------------------------------

/** Whether `value` is a JSON object: not an array, not null, not a scalar. */
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A line read as a JSON object, or the reason it is refused. */
type JsonRead = { readonly record: JsonRecord } | { readonly reason: string };

/** `line` as a JSON object; anything else is `not a JSON object`. */
function objectOf(line: string): JsonRead {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { reason: "not a JSON object" };
  }
  return isRecord(value) ? { record: value } : { reason: "not a JSON object" };
}

/** The refusal to send back for `reason`: never the offending line's own id. */
const refused = (reason: string): Parsed<never> => ({
  ok: false,
  refused: { type: "refused", reason },
});

/** Whether the vocabulary names `type`: its table's own keys answer it. */
function isFrameType<F extends { type: string }>(
  vocabulary: Vocabulary<F>,
  type: string,
): type is F["type"] {
  return Object.hasOwn(vocabulary, type);
}

/** Whether `record` holds exactly `row`'s declared keys, each passing its spec: a frame of that vocabulary. */
function isFrame<F extends { type: string }>(
  vocabulary: Vocabulary<F>,
  type: F["type"],
  record: JsonRecord,
): record is JsonRecord & F {
  const row: Specs = vocabulary[type];
  const present = Object.keys(record);
  return (
    present.every((key) => key === "type" || Object.hasOwn(row, key)) &&
    Object.entries(row).every(
      ([key, spec]) =>
        (spec.optional && !Object.hasOwn(record, key)) || spec.check(record[key]) !== undefined,
    )
  );
}

/** The refusal `record` earns against `row`: its first failure, in the row's declared order. */
function flawOf(row: Specs, record: JsonRecord, type: string): string {
  for (const [key, spec] of Object.entries(row)) {
    if (!Object.hasOwn(record, key)) {
      if (!spec.optional) {
        return `${type} needs ${key}`;
      }
      continue;
    }
    if (spec.check(record[key]) === undefined) {
      return `${type}.${key} is not ${spec.expectation}`;
    }
  }
  const declared = new Set(["type", ...Object.keys(row)]);
  const unknown = Object.keys(record).find((key) => !declared.has(key));
  return `${type} has unknown key ${String(unknown)}`;
}

/**
 * `line` as a frame of `vocabulary`, or the refusal to send back. Pure and
 * never throwing: every line has an answer, and the frame holds only the
 * declared keys, so it is exactly the JSON object the line held.
 */
export function parseFrame<F extends { type: string }>(
  vocabulary: Vocabulary<F>,
  line: string,
): Parsed<F> {
  const read = objectOf(line);
  if ("reason" in read) {
    return refused(read.reason);
  }
  const { record } = read;
  const type = record["type"];
  if (typeof type !== "string") {
    return refused("a frame needs a string type");
  }
  if (!isFrameType(vocabulary, type)) {
    return refused(`unknown frame type ${JSON.stringify(type)}`);
  }
  const row: Specs = vocabulary[type];
  return isFrame<F>(vocabulary, type, record)
    ? { ok: true, frame: record }
    : refused(flawOf(row, record, type));
}

// --- caps --------------------------------------------------------------------

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes, on a character boundary: a
 * multi-byte character that would straddle the cap is dropped whole.
 */
export const capUtf8 = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, truncated: false };
  }
  // Back off to the start of the character the cap falls in, unless it falls between two.
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end] ?? 0)) {
    end--;
  }
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
};

/** The marker a cut body carries, stating the UTF-8 bytes removed. */
const cutMarker = (removed: number): string => `[… ${String(removed)} bytes cut …]`;

/** The longest tail of `text` within `maxBytes`, cut on a code-point boundary. */
function capTail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  // Step forward to the start of the character the cut falls in, unless it falls between two.
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && isContinuationByte(bytes[start] ?? 0)) {
    start++;
  }
  return bytes.subarray(start).toString("utf8");
}

/**
 * `text` cut head-and-tail to at most `maxBytes` UTF-8 bytes (design sec-4): the
 * cut middle becomes `[… <n> bytes cut …]`, and both cuts fall on code-point
 * boundaries. The head gets the larger half of what the marker leaves.
 */
export function capHeadTail(text: string, maxBytes: number): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) {
    return text;
  }
  // The marker states bytes(text)'s digit width, an upper bound on the bytes removed.
  const reserved = Buffer.byteLength(cutMarker(total), "utf8");
  if (maxBytes < reserved) {
    throw new RangeError(
      `capHeadTail needs at least ${String(reserved)} bytes for its marker, not ${String(maxBytes)}`,
    );
  }
  const budget = maxBytes - reserved;
  const head = capUtf8(text, Math.ceil(budget / 2)).text;
  const tail = capTail(text, Math.floor(budget / 2));
  const removed = total - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return `${head}${cutMarker(removed)}${tail}`;
}

// --- the socket path rule ----------------------------------------------------

/**
 * The room's bridge socket: `MALEBOLGE_BRIDGE_SOCKET`, else
 * `$XDG_RUNTIME_DIR/satan/durable/room/bridge/bridge.sock` (design sec-2). The
 * daemon and the extension share this one rule.
 */
export function bridgeSocketPath(env: Readonly<Record<string, string | undefined>>): string {
  const override = env["MALEBOLGE_BRIDGE_SOCKET"];
  if (override !== undefined && override !== "") {
    return override;
  }
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime === undefined || runtime === "") {
    throw new Error("XDG_RUNTIME_DIR is not set");
  }
  return join(runtime, "satan", "durable", "room", "bridge", "bridge.sock");
}
