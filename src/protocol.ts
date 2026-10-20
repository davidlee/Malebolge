// The daemon socket protocol, one JSON message per line.
//
//   client → daemon   ClientMessage, or the attach frame (AttachMessage) that
//                     names the conversation the connection binds to
//   daemon → client   AgentEvent (pi-durable `watchEvents`, the first a `snapshot`)
//                     | AttachedMessage, the reply to a successful attach
//                     | ErrorMessage, for a line the daemon could not act on
//
// The attach frame is valid only as a connection's first line. A connection
// whose first line is not `attach` is bound to root and receives no
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

/** A refused attach frame; `instanceof` tells it from an ordinary parse error. */
export class AttachRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachRefused";
  }
}

/** Strict, so a field this daemon does not know fails rather than attaches root. */
const ATTACH_KEYS: readonly string[] = ["type", "conversation", "new", "cwd"];

/** Every refusal of an `attach` frame says which field it read. */
function attachRefused(problem: string): never {
  throw new AttachRefused(`attach: ${problem}`);
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

/** The target an `attach` frame names; every refusal is an `AttachRefused`. */
function attachTarget(message: JsonRecord): AttachTarget {
  const unknown = Object.keys(message).find((key) => !ATTACH_KEYS.includes(key));
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

/**
 * A connection's line: the attach frame, parsed strictly, or any other message
 * exactly as `parseClientMessage` parses it, errors included.
 */
export function parseConnectionMessage(line: string): AttachMessage | ClientMessage {
  const message = parseObject(line);
  if (message["type"] === "attach") {
    return { type: "attach", target: attachTarget(message) };
  }
  return parseClientMessage(line);
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
