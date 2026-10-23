// The daemon socket protocol, one JSON message per line.
//
//   client → daemon   ClientMessage, or a first-line frame: `attach`, which names
//                     the conversation the connection binds to, or `list`, which
//                     asks for the conversations this store holds
//   daemon → client   AgentEvent (pi-durable `watchEvents`, the first a `snapshot`)
//                     | AttachedMessage, the reply to a successful attach
//                     | ConversationsMessage, the reply to a `list` frame
//                     | ErrorMessage, for a line the daemon could not act on
//
// A first-line frame is valid only as a connection's first line, and each ends
// the connection differently: `attach` binds it, `list` answers and closes it. A
// connection whose first line is neither is bound to root and receives no
// `attached`; a connection that sends nothing is never bound and receives
// nothing. A conversation id names a conversation only within this profile's
// store and socket, so a client that persists one must persist the profile
// with it.

import { optionalString, parseObject, withOptional } from "./fields.ts";
import type { JsonRecord } from "./json.ts";

export type ClientMessage =
  | { type: "input"; content: string; requestId?: string }
  | { type: "abort" }
  | { type: "compact"; instructions?: string };

export interface ErrorMessage {
  type: "error";
  message: string;
}

/** The conversation an `attach` frame names; nothing is created before it parses. */
export type AttachTarget =
  | { kind: "root" }
  | { kind: "existing"; id: number }
  | { kind: "new"; cwd?: string };

export interface AttachMessage {
  type: "attach";
  target: AttachTarget;
}

/** The daemon's reply to a successful attach: which conversation this is. */
export interface AttachedMessage {
  type: "attached";
  conversation: number;
}

/** The `list` frame: this store's conversation ids, asked for on a fresh connection. */
export interface ListMessage {
  type: "list";
}

/**
 * The daemon's reply to a `list` frame: bare ids, newest first, and whether the
 * page was cut. A framed object rather than a bare array so keys can widen
 * additively (DEC-007).
 */
export interface ConversationsMessage {
  type: "conversations";
  conversations: number[];
  truncated: boolean;
}

/** A refused first-line frame; `instanceof` tells it from an ordinary parse error. */
export class FrameRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameRefused";
  }
}

/** Every refusal of a first-line frame names the frame it refused. */
function frameRefused(frame: string, problem: string): never {
  throw new FrameRefused(`${frame}: ${problem}`);
}

/** The first key of `message` that `allowed` does not name, if any: strict parsing. */
function unknownKey(message: JsonRecord, allowed: readonly string[]): string | undefined {
  return Object.keys(message).find((key) => !allowed.includes(key));
}

/** Strict, so a field this daemon does not know fails rather than attaches root. */
const ATTACH_KEYS: readonly string[] = ["type", "conversation", "new", "cwd"];

/** Strict too: `{"type":"list","topic":"x"}` is a refusal, not root's transcript. */
const LIST_KEYS: readonly string[] = ["type"];

/** Every refusal of an `attach` frame says which field it read. */
function attachRefused(problem: string): never {
  frameRefused("attach", problem);
}

/** An id pi can return and a lookup can hold; `optionalPositiveInt` admits 2 ** 53. */
const isSafePositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The target of a `new: true` frame: `cwd` only alongside it, untrimmed and as sent. */
function newTarget(message: JsonRecord): AttachTarget {
  if (message["new"] !== true) {
    attachRefused("new must be true");
  }
  if (message["conversation"] !== undefined) {
    attachRefused("conversation and new are exclusive");
  }
  const cwd = message["cwd"];
  if (cwd === undefined) {
    return { kind: "new" };
  }
  if (typeof cwd !== "string") {
    attachRefused("cwd must be a string");
  }
  return { kind: "new", cwd };
}

/** The target of a `conversation: N` frame, N a safe positive integer. */
function existingTarget(conversation: unknown): AttachTarget {
  if (!isSafePositiveInteger(conversation)) {
    attachRefused("conversation must be a positive integer");
  }
  return { kind: "existing", id: conversation };
}

/** The target an `attach` frame names; every refusal is a `FrameRefused`. */
function attachTarget(message: JsonRecord): AttachTarget {
  const unknown = unknownKey(message, ATTACH_KEYS);
  if (unknown !== undefined) {
    attachRefused(`unknown key ${unknown}`);
  }
  if (message["new"] !== undefined) {
    return newTarget(message);
  }
  if (message["cwd"] !== undefined) {
    attachRefused("cwd needs new");
  }
  const conversation = message["conversation"];
  return conversation === undefined ? { kind: "root" } : existingTarget(conversation);
}

/** The `list` frame, parsed strictly: a field this daemon does not know is a refusal. */
function listFrame(message: JsonRecord): ListMessage {
  const unknown = unknownKey(message, LIST_KEYS);
  if (unknown !== undefined) {
    frameRefused("list", `unknown key ${unknown}`);
  }
  return { type: "list" };
}

/**
 * A connection's line: a first-line frame parsed strictly, or any other message
 * exactly as `parseClientMessage` parses it, errors included.
 */
export function parseConnectionMessage(line: string): AttachMessage | ListMessage | ClientMessage {
  const message = parseObject(line);
  switch (message["type"]) {
    case "attach":
      return { type: "attach", target: attachTarget(message) };
    case "list":
      return listFrame(message);
    default:
      return parseClientMessage(line);
  }
}

function inputMessage(message: JsonRecord): ClientMessage {
  const content = message["content"];
  if (typeof content !== "string") {
    throw new Error("input needs string content");
  }
  return withOptional(
    { type: "input", content },
    "requestId",
    optionalString(message, "requestId"),
  );
}

export function parseClientMessage(line: string): ClientMessage {
  const message = parseObject(line);
  const type = message["type"];
  switch (type) {
    case "input":
      return inputMessage(message);
    case "abort":
      return { type: "abort" };
    case "compact":
      return withOptional(
        { type: "compact" },
        "instructions",
        optionalString(message, "instructions"),
      );
    default:
      throw new Error(`unknown message type ${JSON.stringify(type)}`);
  }
}
