// The command line: what malebolge-attach was asked to do, and what it refuses
// before any socket exists. Parsing only, except `--here`, which is left as a
// marker for `resolveHere` to resolve against the answering daemon.

import type { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { messageOf } from "./message-of.ts";
import { gitRootOf } from "./project-context.ts";
import { type AttachTarget, type TopicSummary, topicNameOf } from "./protocol.ts";
import type { Presentation } from "./render.ts";
import { requestFrameOf, request } from "./request.ts";
import type { ConnectWait } from "./unix-socket.ts";

/** A request runs against a daemon that is already up, and Emacs calls a listing synchronously. */
const LIST_WAIT: ConnectWait = { intervalMs: 200, timeoutMs: 1_000 };

/** An attach may race `malebolge-start`, so it waits for the daemon to begin listening. */
export const ATTACH_WAIT: ConnectWait = { intervalMs: 200, timeoutMs: 10_000 };

/** A refused command line: `attach-main` prints the usage and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The flags as parsed, before their combination is checked. */
interface AttachArgs {
  conversation?: string;
  topic?: string;
  cwd?: string;
  dir?: string;
  setTopic?: string;
  toolset?: string;
  model?: string;
  isNew: boolean;
  here: boolean;
  emacs: boolean;
  list: boolean;
  topics: boolean;
  noDir: boolean;
  noToolset: boolean;
  noModel: boolean;
}

/** The options `parseArgs` reads, named as the user writes them. */
const OPTIONS = {
  conversation: { type: "string" },
  topic: { type: "string" },
  new: { type: "boolean" },
  cwd: { type: "string" },
  dir: { type: "string" },
  here: { type: "boolean" },
  "set-topic": { type: "string" },
  toolset: { type: "string" },
  model: { type: "string" },
  emacs: { type: "boolean" },
  list: { type: "boolean" },
  topics: { type: "boolean" },
  "no-dir": { type: "boolean" },
  "no-toolset": { type: "boolean" },
  "no-model": { type: "boolean" },
} as const;

/** The options that take a value, and the `AttachArgs` field each lands in. */
const VALUED_FIELDS = [
  ["conversation", "conversation"],
  ["topic", "topic"],
  ["cwd", "cwd"],
  ["dir", "dir"],
  ["set-topic", "setTopic"],
  ["toolset", "toolset"],
  ["model", "model"],
] as const;

/** `parseArgs`, strict, with every one of its throws turned into a `UsageError`. */
function parseAttachArgs(args: string[]): AttachArgs {
  try {
    const { values } = parseArgs({
      args,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    });
    const parsed: AttachArgs = {
      isNew: values.new === true,
      here: values.here === true,
      emacs: values.emacs === true,
      list: values.list === true,
      topics: values.topics === true,
      noDir: values["no-dir"] === true,
      noToolset: values["no-toolset"] === true,
      noModel: values["no-model"] === true,
    };
    for (const [option, field] of VALUED_FIELDS) {
      const value = values[option];
      if (value !== undefined) {
        parsed[field] = value;
      }
    }
    return parsed;
  } catch (error) {
    throw new UsageError(messageOf(error));
  }
}

/** Every flag the parse found, by the name the user writes it with. */
function flagsOf(args: AttachArgs): ReadonlyMap<string, boolean> {
  return new Map([
    ["conversation", args.conversation !== undefined],
    ["topic", args.topic !== undefined],
    ["new", args.isNew],
    ["cwd", args.cwd !== undefined],
    ["dir", args.dir !== undefined],
    ["no-dir", args.noDir],
    ["toolset", args.toolset !== undefined],
    ["no-toolset", args.noToolset],
    ["model", args.model !== undefined],
    ["no-model", args.noModel],
    ["here", args.here],
    ["emacs", args.emacs],
    ["list", args.list],
    ["topics", args.topics],
    ["set-topic", args.setTopic !== undefined],
  ]);
}

/**
 * `subject` takes `allowed`'s flags and no others (DEC-008, extended by
 * design sec-5): the first other flag the parse holds is the refusal.
 */
function checkAlone(
  subject: string,
  allowed: readonly string[],
  given: ReadonlyMap<string, boolean>,
): void {
  const other = [...given].find(
    ([flag, held]) => held && flag !== subject && !allowed.includes(flag),
  )?.[0];
  if (other !== undefined) {
    throw new UsageError(`${subject} and ${other} are exclusive`);
  }
}

/** A topic name the client sends: the daemon's one rule, refused as a usage error. */
function topicNamed(name: string): string {
  try {
    return topicNameOf(name);
  } catch (error) {
    throw new UsageError(messageOf(error));
  }
}

/** The id `--conversation` names: digits only, no leading zeros, safe. */
function conversationOf(text: string): number {
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new UsageError("conversation must be a positive integer");
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id)) {
    throw new UsageError("conversation must be a positive integer");
  }
  return id;
}

/** How a client reads its input: typed lines, or one private JSON frame per line. */
export type InputMode = "lines" | "frames";

/** `--here`'s marker: the topic at the client's git root, resolved against the daemon by `resolveHere`. */
export interface Here {
  here: true;
}

/** The one marker: `--here` given once (parsing refuses a `--here` that names a topic too). */
const HERE: Here = { here: true };

/** A parsed command line that attaches: where to attach, and how to read input and print. */
export interface AttachCommand<T = string> {
  /** Absent: the untagged arm of `AttachInvocation`, so the shipped shapes parse unchanged. */
  mode?: undefined;
  target: AttachTarget<T>;
  inputMode: InputMode;
  presentation: Presentation;
}

/** A listing: one `list` frame for the whole store or one topic (DEC-008, EX-2). */
export interface ListInvocation<T = string> {
  mode: "list";
  wait: ConnectWait;
  topic?: T;
}

/** The topics themselves: one `list` frame with `topics:true`. */
export interface TopicsInvocation {
  mode: "topics";
  wait: ConnectWait;
}

/** A topic write: create the topic, set its directory, or leave it (design sec-4). */
export interface SetTopicInvocation<T = string> {
  mode: "set-topic";
  wait: ConnectWait;
  name: string;
  /** A string sets the directory, `null` clears it, absent leaves it unchanged. */
  cwd: T | null | undefined;
  /** The same three cases for the toolset; the profile's policy judges a name. */
  toolset?: string | null | undefined;
  /** The same three cases for the model; the catalogue judges a ref. */
  model?: string | null | undefined;
}

/** The modes that ask one question over one connection, and print its one reply. */
export type RequestInvocation = ListInvocation | TopicsInvocation | SetTopicInvocation;

/**
 * What a command line asks for: attach to a target, or ask the daemon one
 * question. `Here` stands wherever `--here` did until `resolveHere` names it.
 */
export type AttachInvocation<T = string | Here> =
  | AttachCommand<T>
  | ListInvocation<T>
  | TopicsInvocation
  | SetTopicInvocation<T>;

/** A command line with every `--here` resolved: what `attach-main` dispatches. */
export type ResolvedInvocation = AttachInvocation<string>;

/** The topic target a topic's name (or `--here`) names; the name is checked before it is passed. */
function topicTargetFrom<T>(topic: T, { conversation, cwd, isNew }: AttachArgs): AttachTarget<T> {
  if (conversation !== undefined) {
    throw new UsageError("conversation and topic are exclusive");
  }
  if (!isNew) {
    // A directory makes sense only for a conversation being created.
    if (cwd !== undefined) {
      throw new UsageError("cwd needs new");
    }
    return { kind: "topic", name: topic, new: false };
  }
  return cwd === undefined
    ? { kind: "topic", name: topic, new: true }
    : { kind: "topic", name: topic, new: true, cwd };
}

/** The target `--new` names: a fresh conversation, in `cwd` when one is given. */
function newTargetFrom({ conversation, cwd }: AttachArgs): AttachTarget {
  if (conversation !== undefined) {
    throw new UsageError("conversation and new are exclusive");
  }
  return cwd === undefined ? { kind: "new" } : { kind: "new", cwd };
}

/**
 * A topic's directory, toolset and model are written only by `--set-topic`, never
 * by an attach: any of them given without it is a refusal, before any target is
 * named.
 */
function requireSetTopic(args: AttachArgs): void {
  if (args.dir !== undefined || args.noDir) {
    throw new UsageError("dir needs set-topic");
  }
  if (args.toolset !== undefined || args.noToolset) {
    throw new UsageError("toolset needs set-topic");
  }
  if (args.model !== undefined || args.noModel) {
    throw new UsageError("model needs set-topic");
  }
}

/** The target the parsed flags name; every refusal is a `UsageError`. */
function targetFrom(args: AttachArgs): AttachTarget<string | Here> {
  requireSetTopic(args);
  if (args.here) {
    return topicTargetFrom<Here>(HERE, args);
  }
  if (args.topic !== undefined) {
    return topicTargetFrom(topicNamed(args.topic), args);
  }
  if (args.isNew) {
    return newTargetFrom(args);
  }
  if (args.cwd !== undefined) {
    throw new UsageError("cwd needs new");
  }
  return args.conversation === undefined
    ? { kind: "root" }
    : { kind: "existing", id: conversationOf(args.conversation) };
}

/**
 * The conversation the command line names; every refusal is a `UsageError`.
 * `--here` is left unresolved: only `resolveHere` can name the topic it means.
 */
export function attachTargetOf(args: string[]): AttachTarget<string | Here> {
  const invocation = attachInvocationOf(args);
  if (invocation.mode !== undefined) {
    throw new UsageError(`${invocation.mode} names no attach target`);
  }
  return invocation.target;
}

/**
 * One field a `--set-topic` writes: `value` sets it, `clear` clears it, neither
 * leaves it unchanged. Every field of the write takes this one reading.
 */
function writeOf<T>(value: T | undefined, clear: boolean, name: string): T | null | undefined {
  if (value !== undefined && clear) {
    throw new UsageError(`${name} and no-${name} are exclusive`);
  }
  if (value !== undefined) {
    return value;
  }
  return clear ? null : undefined;
}

/** The directory a `--set-topic` writes: a path sets it, `--no-dir` clears it, neither leaves it. */
const directoryOf = ({ dir, noDir }: AttachArgs): string | null | undefined =>
  writeOf(dir, noDir, "dir");

/** The toolset a `--set-topic` writes: a name sets it, `--no-toolset` clears it, neither leaves it. */
const toolsetOf = ({ toolset, noToolset }: AttachArgs): string | null | undefined =>
  writeOf(toolset, noToolset, "toolset");

/** The model a `--set-topic` writes: a ref sets it, `--no-model` clears it, neither leaves it. */
const modelOf = ({ model, noModel }: AttachArgs): string | null | undefined =>
  writeOf(model, noModel, "model");

/** The one parse of a command line: what it asks, or a `UsageError` refusing it. */
export function attachInvocationOf(args: string[]): AttachInvocation {
  const parsed = parseAttachArgs(args);
  const given = flagsOf(parsed);
  checkHereAlone(parsed.here, given);
  if (parsed.topics) {
    // The topics are a question about the store, so they take no other flag.
    checkAlone("topics", [], given);
    return { mode: "topics", wait: LIST_WAIT };
  }
  if (parsed.setTopic !== undefined) {
    checkAlone(
      "set-topic",
      ["dir", "no-dir", "here", "toolset", "no-toolset", "model", "no-model"],
      given,
    );
    return {
      mode: "set-topic",
      wait: LIST_WAIT,
      name: topicNamed(parsed.setTopic),
      // The git root, once resolved, is the directory; nothing else is a directory.
      cwd: parsed.here ? HERE : directoryOf(parsed),
      toolset: toolsetOf(parsed),
      model: modelOf(parsed),
    };
  }
  if (parsed.list) {
    checkAlone("list", ["topic", "here"], given);
    if (parsed.here) {
      return { mode: "list", wait: LIST_WAIT, topic: HERE };
    }
    return parsed.topic === undefined
      ? { mode: "list", wait: LIST_WAIT }
      : { mode: "list", wait: LIST_WAIT, topic: topicNamed(parsed.topic) };
  }
  const target = targetFrom(parsed);
  return parsed.emacs
    ? { target, inputMode: "frames", presentation: "emacs" }
    : { target, inputMode: "lines", presentation: "terminal" };
}

/** The client's git root, `undefined` outside a repository: injected, so tests need no repo. */
export type GitRoot = () => string | undefined;

/** A `--here` the filesystem or the daemon cannot resolve: `attach-main` prints it and exits 1. */
export class HereRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HereRefusedError";
  }
}

/** `--here` stands where a topic's name or a directory would, so it takes neither. */
function checkHereAlone(here: boolean, given: ReadonlyMap<string, boolean>): void {
  if (here) {
    // `--set-topic --here` still takes the toolset and model: `--here` names the directory alone.
    checkAlone(
      "here",
      ["new", "cwd", "emacs", "list", "set-topic", "toolset", "no-toolset", "model", "no-model"],
      given,
    );
  }
}

/** Whether `value` is the unresolved marker, not a name the parser checked or a directory. */
const isHere = (value: string | Here | null | undefined): value is Here =>
  value !== null && value !== undefined && typeof value !== "string";

/** `value` when it is the unresolved marker: the one place a name may not be a string. */
const hereIn = (value: string | Here | null | undefined): Here | undefined =>
  isHere(value) ? value : undefined;

/** Where `--here` stood in `invocation`, if anywhere: only these modes carry one. */
function hereOf(invocation: AttachInvocation): Here | undefined {
  switch (invocation.mode) {
    case "topics":
      return undefined;
    case "list":
      return hereIn(invocation.topic);
    case "set-topic":
      return hereIn(invocation.cwd);
    case undefined:
      return invocation.target.kind === "topic" ? hereIn(invocation.target.name) : undefined;
  }
}

/** Whether `invocation` holds no unresolved `--here`: only then may a caller dispatch it. */
export const isResolved = (invocation: AttachInvocation): invocation is ResolvedInvocation =>
  hereOf(invocation) === undefined;

/**
 * The one topic whose directory is exactly `root`. Names are unique and
 * directories are not, so several matches refuse rather than pick one.
 */
function topicAt(topics: readonly TopicSummary[], root: string): string {
  const names = topics.filter((topic) => topic.cwd === root).map((topic) => topic.name);
  const [one, ...several] = names;
  if (one === undefined) {
    throw new HereRefusedError(`no topic has directory ${root}`);
  }
  if (several.length > 0) {
    throw new HereRefusedError(
      `topics ${names.join(", ")} have directory ${root}; name one with --topic`,
    );
  }
  return one;
}

/** `invocation` with the resolved topic `name` where its `Here` stood. */
function withTopic(invocation: AttachInvocation, name: string): ResolvedInvocation {
  if (invocation.mode === "list") {
    return { ...invocation, topic: name };
  }
  if (invocation.mode === undefined && invocation.target.kind === "topic") {
    return { ...invocation, target: { ...invocation.target, name } };
  }
  // Unreachable: only attach and `--list` name a topic, and parsing puts `Here` there.
  throw new Error("--here stood where no topic is named");
}

/**
 * `--here`, resolved against the answering daemon (design sec-5, DEC-014): the
 * client's git root, then one silent `topics` lookup whose reply must say the
 * daemon is `host`, because its topic directories are paths in its own
 * profile's space. Returns `invocation` untouched when it holds no `Here`;
 * every refusal is a `HereRefusedError`, and nothing is created.
 */
export async function resolveHere(
  invocation: AttachInvocation,
  socketPath: string,
  errors: Writable,
  gitRoot: GitRoot = () => gitRootOf(process.cwd()),
): Promise<ResolvedInvocation> {
  if (isResolved(invocation)) {
    return invocation;
  }
  const root = gitRoot();
  if (root === undefined) {
    throw new HereRefusedError("--here needs a git repository: none is above this directory");
  }
  // The lookup waits as the invocation would: an attach may race the daemon's start.
  const inquiry: TopicsInvocation = {
    mode: "topics",
    wait: invocation.mode === undefined ? ATTACH_WAIT : invocation.wait,
  };
  // Silent: the reply is the caller's to render, and the errors are the client's own.
  const reply = await request(socketPath, requestFrameOf(inquiry), "topics", errors, inquiry.wait);
  if (reply.profile !== "host") {
    throw new HereRefusedError(
      `--here needs a host daemon: this daemon runs under ${reply.profile}, ` +
        `so its topic directories are ${reply.profile} paths, not this shell's`,
    );
  }
  if (invocation.mode === "set-topic") {
    // The git root is the directory; no topic needs to match it, and others may share it.
    return { ...invocation, cwd: root };
  }
  return withTopic(invocation, topicAt(reply.topics, root));
}
