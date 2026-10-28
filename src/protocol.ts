// The daemon socket protocol, one JSON message per line.
//
//   client → daemon   ClientMessage, or a first-line frame: `attach`, which names
//                     the conversation the connection binds to, `list`, which
//                     asks for the conversations this store holds or its topics,
//                     or `topic`, which writes one topic's directory and toolset
//   daemon → client   AgentEvent (pi-durable `watchEvents`, the first a `snapshot`)
//                     | AttachedMessage, the reply to a successful attach
//                     | ConversationsMessage, the reply to a `list` frame
//                     | TopicsMessage, the reply to a `topics` listing or a `topic` write
//                     | ErrorMessage, for a line the daemon could not act on
//
// A first-line frame is valid only as a connection's first line, and each ends
// the connection differently: `attach` binds it, `list` and `topic` answer and
// close it. A
// connection whose first line is neither is bound to root and receives no
// `attached`; a connection that sends nothing is never bound and receives
// nothing. A conversation id names a conversation only within this profile's
// store and socket, so a client that persists one must persist the profile
// with it.

import type { Profile } from "./config.ts";
import { optionalString, parseObject, withOptional } from "./fields.ts";
import type { JsonRecord } from "./json.ts";
import { messageOf } from "./message-of.ts";

export type ClientMessage =
  | { type: "input"; content: string; requestId?: string }
  | { type: "abort" }
  | { type: "compact"; instructions?: string }
  | { type: "orient" };

export interface ErrorMessage {
  type: "error";
  message: string;
}

/**
 * Where an `attach` frame points: the conversation an `attach` frame names,
 * which nothing creates before it parses; only a client's unresolved parse
 * parameterises the name. A topic target names no id: it binds that topic's
 * latest conversation, or creates its first when `new` asks for one.
 */
export type AttachTarget<T = string> =
  | { kind: "root" }
  | { kind: "existing"; id: number }
  | { kind: "new"; cwd?: string }
  | { kind: "topic"; name: T; new: boolean; cwd?: string };

export interface AttachMessage {
  type: "attach";
  target: AttachTarget;
}

/** The daemon's reply to a successful attach: which conversation this is. */
export interface AttachedMessage {
  type: "attached";
  conversation: number;
}

/** What a `list` frame asks for: everything, one topic's ids, or the topics themselves. */
export type ListQuery = { kind: "all" } | { kind: "topic"; name: string } | { kind: "topics" };

/** The `list` frame: this store's conversations, asked for on a fresh connection. */
export interface ListMessage {
  type: "list";
  query: ListQuery;
}

/** The `topic` frame: create one topic, set its directory or toolset, or leave it unchanged. */
export interface TopicMessage {
  type: "topic";
  name: string;
  /** Absent creates or leaves unchanged; a string sets the directory; `null` clears it. */
  cwd?: string | null;
  /** The same three cases for the toolset, which the profile's policy judges in `setTopic`. */
  toolset?: string | null;
}

/**
 * How a listing marks a thread (DEC-037): the conversation it was forked from, or
 * the one whose `thread_start` created it.
 */
export type ThreadMark = { forkOf: number } | { startedBy: number };

/**
 * The daemon's reply to a `list` frame: bare ids, newest first, and whether the
 * page was cut. A framed object rather than a bare array so keys can widen
 * additively (DEC-007).
 */
export interface ConversationsMessage {
  type: "conversations";
  conversations: number[];
  truncated: boolean;
  /** Present when any listed id is a thread: its mark, by id. */
  marks?: Record<string, ThreadMark>;
}

/** One topic as a `topics` reply shows it: its name, its directory and its toolset. */
export interface TopicSummary {
  name: string;
  cwd?: string;
  toolset?: string;
}

/**
 * The daemon's reply to a `topics` listing and to a `topic` write: the records,
 * and the profile whose path space their `cwd`s are in (design sec-4).
 */
export interface TopicsMessage {
  type: "topics";
  profile: Profile;
  topics: TopicSummary[];
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
const ATTACH_KEYS: readonly string[] = ["type", "conversation", "new", "cwd", "topic"];

/** Strict too: `{"type":"list","page":2}` is a refusal, not root's transcript. */
const LIST_KEYS: readonly string[] = ["type", "topic", "topics"];

/** Strict: a `topic` write names the name and the directory, nothing else. */
const TOPIC_KEYS: readonly string[] = ["type", "name", "cwd", "toolset"];

/**
 * The topic every conversation starts in: it always exists and is never stored
 * in `topics`, so it cannot be created or given a directory (DEC-015).
 */
export const DEFAULT_TOPIC = "default";

/** A topic name: a leading letter or digit, then up to 63 more of the same family. */
const TOPIC_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The one name rule (design sec-3), for the parser and the client alike: `name`
 * when it matches, else a refusal naming the rule. The frame prefix is the
 * caller's, so this module's client can report it without a frame.
 */
export function topicNameOf(name: unknown): string {
  if (typeof name === "string" && TOPIC_NAME.test(name)) {
    return name;
  }
  throw new Error("topic must match [a-z0-9][a-z0-9._-]{0,63}");
}

/** `name` through `topicNameOf`, the refusal naming `frame` as every refusal does. */
function topicNamed(frame: string, name: unknown): string {
  try {
    return topicNameOf(name);
  } catch (error) {
    frameRefused(frame, messageOf(error));
  }
}

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
  const cwd = attachCwd(message);
  return cwd === undefined ? { kind: "new" } : { kind: "new", cwd };
}

/** An attach frame's `cwd`, untrimmed and as sent: absent, or a string. */
function attachCwd(message: JsonRecord): string | undefined {
  const cwd = message["cwd"];
  if (cwd !== undefined && typeof cwd !== "string") {
    attachRefused("cwd must be a string");
  }
  return cwd;
}

/** The target of a `conversation: N` frame, N a safe positive integer. */
function existingTarget(conversation: unknown): AttachTarget {
  if (!isSafePositiveInteger(conversation)) {
    attachRefused("conversation must be a positive integer");
  }
  return { kind: "existing", id: conversation };
}

/**
 * The directory a topic attach asks for: a string, and only alongside `new`,
 * because a directory makes sense only for a conversation being created.
 */
function topicDirectory(message: JsonRecord): string | undefined {
  if (message["cwd"] !== undefined && message["new"] !== true) {
    attachRefused("cwd needs new");
  }
  return attachCwd(message);
}

/**
 * The target of a `topic` frame: that topic's latest conversation, or a new one
 * carrying the client's directory. `default` is not reserved here: attaching to
 * it is how a client reaches root by name (DEC-015).
 */
function topicTarget(message: JsonRecord, topic: unknown): AttachTarget {
  if (message["conversation"] !== undefined) {
    attachRefused("conversation and topic are exclusive");
  }
  const fresh = message["new"];
  if (fresh !== undefined && fresh !== true) {
    attachRefused("new must be true");
  }
  const cwd = topicDirectory(message);
  const name = topicNamed("attach", topic);
  return {
    kind: "topic",
    name,
    new: fresh === true,
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** The target an `attach` frame names; every refusal is a `FrameRefused`. */
function attachTarget(message: JsonRecord): AttachTarget {
  const unknown = unknownKey(message, ATTACH_KEYS);
  if (unknown !== undefined) {
    attachRefused(`unknown key ${unknown}`);
  }
  const topic = message["topic"];
  if (topic !== undefined) {
    return topicTarget(message, topic);
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

/** `topic` and `topics` name different questions, so asking both is a refusal. */
function listQuery(message: JsonRecord): ListQuery {
  const topic = message["topic"];
  const topics = message["topics"];
  if (topic !== undefined) {
    if (topics !== undefined) {
      frameRefused("list", "topic and topics are exclusive");
    }
    return { kind: "topic", name: topicNamed("list", topic) };
  }
  if (topics === undefined) {
    return { kind: "all" };
  }
  if (topics !== true) {
    frameRefused("list", "topics must be true");
  }
  return { kind: "topics" };
}

/** The `list` frame, parsed strictly: a field this daemon does not know is a refusal. */
function listFrame(message: JsonRecord): ListMessage {
  const unknown = unknownKey(message, LIST_KEYS);
  if (unknown !== undefined) {
    frameRefused("list", `unknown key ${unknown}`);
  }
  return { type: "list", query: listQuery(message) };
}

/** C0 controls and DEL: what would split or corrupt a tab-separated line. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/**
 * One optional field of a `topic` frame, checked as `cwd` and `toolset` both are:
 * `undefined` when the frame leaves it out, a string or `null` otherwise.
 */
function topicField(message: JsonRecord, key: "cwd" | "toolset"): string | null | undefined {
  const value = message[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && CONTROL_CHARACTER.test(value)) {
    // `--topics` prints `NAME<TAB>DIR<TAB>TOOLSET` lines: each value is one field of one line.
    frameRefused("topic", `${key} must not contain a control character`);
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  frameRefused("topic", `${key} must be a string or null`);
}

/**
 * The `topic` frame, parsed strictly. `cwd` and `toolset` absent create or leave
 * the topic unchanged (so the frame is idempotent), a string sets one, `null`
 * clears it. The frame does not judge a toolset's name: the profile's policy does.
 */
function topicFrame(message: JsonRecord): TopicMessage {
  const unknown = unknownKey(message, TOPIC_KEYS);
  if (unknown !== undefined) {
    frameRefused("topic", `unknown key ${unknown}`);
  }
  const name = topicNamed("topic", message["name"]);
  if (name === DEFAULT_TOPIC) {
    frameRefused("topic", "default is reserved");
  }
  // Built key by key, so a field the frame left out stays absent.
  const frame: TopicMessage = { type: "topic", name };
  const cwd = topicField(message, "cwd");
  if (cwd !== undefined) {
    frame.cwd = cwd;
  }
  const toolset = topicField(message, "toolset");
  if (toolset !== undefined) {
    frame.toolset = toolset;
  }
  return frame;
}

/**
 * A connection's first line: `attach`, which binds the connection to one
 * conversation, or `list` and `topic`, which answer and close it.
 */
export type FirstLineFrame = AttachMessage | ListMessage | TopicMessage;

/**
 * `message` as a first-line frame, parsed strictly; `undefined` when its `type`
 * names none, so the caller can read it as a client message instead.
 */
export function parseFirstLineFrame(message: JsonRecord): FirstLineFrame | undefined {
  switch (message["type"]) {
    case "attach":
      return { type: "attach", target: attachTarget(message) };
    case "list":
      return listFrame(message);
    case "topic":
      return topicFrame(message);
    default:
      return undefined;
  }
}

/**
 * A connection's line: a first-line frame parsed strictly, or any other message
 * exactly as `parseClientMessage` parses it, errors included.
 */
export function parseConnectionMessage(line: string): FirstLineFrame | ClientMessage {
  const message = parseObject(line);
  return parseFirstLineFrame(message) ?? clientMessage(message);
}

export function parseClientMessage(line: string): ClientMessage {
  return clientMessage(parseObject(line));
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

/** A message a bound connection acts on, from a line already parsed as an object. */
function clientMessage(message: JsonRecord): ClientMessage {
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
    case "orient":
      return { type: "orient" };
    default:
      throw new Error(`unknown message type ${JSON.stringify(type)}`);
  }
}
