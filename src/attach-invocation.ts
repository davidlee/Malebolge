// The command line: what malebolge-attach was asked to do, and what it refuses
// before any socket exists. Parsing only: no connection, no resolution.

import { parseArgs } from "node:util";
import { messageOf } from "./message-of.ts";
import { type AttachTarget, topicNameOf } from "./protocol.ts";
import type { Presentation } from "./render.ts";
import type { ConnectWait } from "./unix-socket.ts";

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
  isNew: boolean;
  emacs: boolean;
  list: boolean;
  topics: boolean;
  noDir: boolean;
}

/** The options `parseArgs` reads, named as the user writes them. */
const OPTIONS = {
  conversation: { type: "string" },
  topic: { type: "string" },
  new: { type: "boolean" },
  cwd: { type: "string" },
  dir: { type: "string" },
  "set-topic": { type: "string" },
  emacs: { type: "boolean" },
  list: { type: "boolean" },
  topics: { type: "boolean" },
  "no-dir": { type: "boolean" },
} as const;

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
      emacs: values.emacs === true,
      list: values.list === true,
      topics: values.topics === true,
      noDir: values["no-dir"] === true,
    };
    if (values.conversation !== undefined) {
      parsed.conversation = values.conversation;
    }
    if (values.topic !== undefined) {
      parsed.topic = values.topic;
    }
    if (values.cwd !== undefined) {
      parsed.cwd = values.cwd;
    }
    if (values.dir !== undefined) {
      parsed.dir = values.dir;
    }
    if (values["set-topic"] !== undefined) {
      parsed.setTopic = values["set-topic"];
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

/** A parsed command line that attaches: where to attach, and how to read input and print. */
export interface AttachCommand {
  /** Absent: the untagged arm of `AttachInvocation`, so the shipped shapes parse unchanged. */
  mode?: undefined;
  target: AttachTarget;
  inputMode: InputMode;
  presentation: Presentation;
}

/** A listing: one `list` frame for the whole store or one topic (DEC-008, EX-2). */
export interface ListInvocation {
  mode: "list";
  wait: ConnectWait;
  topic?: string;
}

/** The topics themselves: one `list` frame with `topics:true`. */
export interface TopicsInvocation {
  mode: "topics";
  wait: ConnectWait;
}

/** A topic write: create the topic, set its directory, or leave it (design sec-4). */
export interface SetTopicInvocation {
  mode: "set-topic";
  wait: ConnectWait;
  name: string;
  /** A string sets the directory, `null` clears it, absent leaves it unchanged. */
  cwd: string | null | undefined;
}

/** The modes that ask one question over one connection, and print its one reply. */
export type RequestInvocation = ListInvocation | TopicsInvocation | SetTopicInvocation;

/** What a command line asks for: attach to a target, or ask the daemon one question. */
export type AttachInvocation = AttachCommand | RequestInvocation;

/** The topic target `name` the parsed flags name. */
function topicTargetFrom(name: string, { conversation, cwd, isNew }: AttachArgs): AttachTarget {
  if (conversation !== undefined) {
    throw new UsageError("conversation and topic are exclusive");
  }
  const topic = topicNamed(name);
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

/** The target the parsed flags name; every refusal is a `UsageError`. */
function targetFrom(args: AttachArgs): AttachTarget {
  if (args.topic !== undefined) {
    return topicTargetFrom(args.topic, args);
  }
  if (args.dir !== undefined || args.noDir) {
    throw new UsageError("dir needs set-topic");
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

/** The conversation the command line names; every refusal is a `UsageError`. */
export function attachTargetOf(args: string[]): AttachTarget {
  const invocation = attachInvocationOf(args);
  if (invocation.mode !== undefined) {
    throw new UsageError(`${invocation.mode} names no attach target`);
  }
  return invocation.target;
}

/** The directory a `--set-topic` writes: a path sets it, `--no-dir` clears it, neither leaves it. */
function directoryOf({ dir, noDir }: AttachArgs): string | null | undefined {
  if (dir !== undefined && noDir) {
    throw new UsageError("dir and no-dir are exclusive");
  }
  if (dir !== undefined) {
    return dir;
  }
  return noDir ? null : undefined;
}

/** The one parse of a command line: what it asks, or a `UsageError` refusing it. */
export function attachInvocationOf(args: string[]): AttachInvocation {
  const parsed = parseAttachArgs(args);
  const given = flagsOf(parsed);
  if (parsed.topics) {
    // The topics are a question about the store, so they take no other flag.
    checkAlone("topics", [], given);
    return { mode: "topics", wait: LIST_WAIT };
  }
  if (parsed.setTopic !== undefined) {
    checkAlone("set-topic", ["dir", "no-dir"], given);
    return {
      mode: "set-topic",
      wait: LIST_WAIT,
      name: topicNamed(parsed.setTopic),
      cwd: directoryOf(parsed),
    };
  }
  if (parsed.list) {
    checkAlone("list", ["topic"], given);
    return parsed.topic === undefined
      ? { mode: "list", wait: LIST_WAIT }
      : { mode: "list", wait: LIST_WAIT, topic: topicNamed(parsed.topic) };
  }
  const target = targetFrom(parsed);
  return parsed.emacs
    ? { target, inputMode: "frames", presentation: "emacs" }
    : { target, inputMode: "lines", presentation: "terminal" };
}

/** A request runs against a daemon that is already up, and Emacs calls a listing synchronously. */
const LIST_WAIT: ConnectWait = { intervalMs: 200, timeoutMs: 1_000 };
