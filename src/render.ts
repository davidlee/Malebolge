// Agent events as plain appended text: no cursor movement, so the same output
// suits a terminal and an Emacs comint buffer.

import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, MessageChange } from "@earendil-works/pi-durable";
import { isRecord } from "./json.ts";
import type {
  AttachedMessage,
  ConversationSummary,
  ConversationsMessage,
  ErrorMessage,
  ThreadMark,
  TopicsMessage,
} from "./protocol.ts";
import { isEpisodeClass, originKey } from "./threads/origin.ts";
import { isPostInput, POST_KIND, type PostInput } from "./threads/task.ts";
import { type EpisodeClass, WAKE_KIND } from "./wake/task.ts";

/** A notice the client makes for itself; it never reaches the daemon. */
export interface ClientNotice {
  type: "client_notice";
  text: string;
}

export type Printable =
  | AgentEvent
  | ErrorMessage
  | AttachedMessage
  | ConversationsMessage
  | TopicsMessage
  | ClientNotice;

/** How the output reads: the terminal's own, or an Emacs comint buffer's. */
export type Presentation = "terminal" | "emacs";

export interface RendererOptions {
  presentation?: Presentation;
}

/** Each printable event type, keyed to its event. */
type PrintableMap = { [E in Printable as E["type"]]: E };
type Handlers = { [K in keyof PrintableMap]: (event: PrintableMap[K]) => string };

/** Notices outside the answer in flight, which only some presents interrupt. */
type Notices = Omit<Handlers, "snapshot" | "message_start" | "message_update" | "message_end">;

/**
 * `value`, a line the daemon sent, as an event. The daemon is a trusted peer,
 * so only the discriminant is checked: anything else is not an event at all.
 */
export function toPrintable(value: unknown): Printable {
  if (!isPrintable(value)) {
    throw new Error(`not an event: ${JSON.stringify(value)}`);
  }
  return value;
}

function isPrintable(value: unknown): value is Printable {
  return isRecord(value) && typeof value["type"] === "string";
}

const ARGS_LIMIT = 120;

const messageOf = (entry: EntryRecord | undefined): Message | undefined => entry?.model?.[0];

/** Visible text of a content block; thinking and tool calls show none. */
const blockText = (block: { type: string; text?: string }): string =>
  block.type === "text" ? (block.text ?? "") : "";

function textOf(message: Message | undefined): string {
  if (message === undefined) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content.map(blockText).join("");
}

const line = (text: string): string => `${text}\n`;
const note = (text: string): string => line(`[${text}]`);
const silent = (): string => "";

/** `line(text)`, or nothing for empty text. */
const lineUnlessEmpty = (text: string): string => (text === "" ? "" : line(text));

/** The newlines `text` ends with, up to the two that make a blank line. */
const trailingNewlines = (text: string): string => /\n{0,2}$/.exec(text)?.[0] ?? "";

/** The newlines `text` lacks to end in a blank line: a terminated last line, then an empty one. */
const afterBlankLine = (text: string): string => "\n\n".slice(trailingNewlines(text).length);

/** `text`'s part past `shown`; a text that does not extend `shown` rewrites it. */
function extension(text: string, shown: string): { unseen: string; rewrite: boolean } {
  return text.startsWith(shown)
    ? { unseen: text.slice(shown.length), rewrite: false }
    : { unseen: text, rewrite: true };
}

/** Why answer text starts on a line of its own rather than continuing one. */
type Cause = "heading" | "continued" | "revised";

/** The cue `unseen` answer text needs, if any: a rewrite, a heading, a resumption. */
function blockCause(
  { unseen, rewrite }: { unseen: string; rewrite: boolean },
  visible: boolean,
  interrupted: boolean,
): Cause | null {
  if (unseen === "") {
    return null;
  }
  if (rewrite) {
    return "revised";
  }
  if (!visible) {
    return "heading";
  }
  return interrupted ? "continued" : null;
}

const EMACS_CUES: Record<Cause, string> = {
  heading: "Satan:",
  continued: "Satan (continued):",
  revised: "Satan (revised):",
};

/**
 * `text` with the trailing newlines past `shown` dropped; newlines already
 * shown stay, so a text that extends `shown` still does.
 */
function withoutTrailingNewlines(text: string, shown: string): string {
  return text.startsWith(shown)
    ? shown + text.slice(shown.length).replace(/\n+$/, "")
    : text.replace(/\n+$/, "");
}

/** Which label an input entry's line carries: a post, or a wake. */
type InputKind = "thread" | "wake";

/** An input entry as the transcript words it: its label, and the text under the header. */
interface InputRendering {
  kind: InputKind;
  header: string;
  body: string;
}

/** An input entry's lines: `[<kind>] <header>`, then the body's own. */
const inputLine = (kind: InputKind, header: string, body: string): string =>
  line(`[${kind}] ${header}`) + lineUnlessEmpty(body);

/**
 * What the two presentations word differently. Everything else — the answer in
 * flight, snapshots, the notices — is shared.
 */
interface PresentationTable {
  /** A user turn; history always, live only where the client does not echo. */
  userTurn: (text: string) => string;
  /** A post or wake; live even where the client shows the operator's typing. */
  input: (kind: InputKind, header: string, body: string) => string;
  /** Whether the client shows the user's typing, making a live echo a repeat. */
  echoesTyping: boolean;
  /** An assistant turn already complete in transcript history. */
  answer: (text: string) => string;
  /** Prefix starting answer text that does not continue the printed line. */
  start: (cause: Cause, atLineStart: boolean) => string;
  /** A completed answer's final text, as far as it is printed. */
  finalText: (text: string, shown: string) => string;
  /**
   * The terminator of a completed answer, given its printed text and the
   * output's trailing newlines; none if the answer is empty.
   */
  finish: (printed: string, ended: string) => string;
  /** A daemon or client notice, `body` given without brackets. */
  notice: (body: string) => string;
  /** Tool activity, `text` given without its mark. */
  tool: (text: string) => string;
  /** Whether notices start on a line of their own, out of an answer's text. */
  freshLines: boolean;
}

const TERMINAL: PresentationTable = {
  userTurn: (text) => line(`» ${text}`),
  input: inputLine,
  echoesTyping: true,
  answer: lineUnlessEmpty,
  // A rewrite cannot overwrite printed text, so it opens a line.
  start: (cause) => (cause === "revised" ? "\n" : ""),
  // An answer with no text at all prints nothing, not even a bare line.
  // Trailing newlines arriving only at the end are dropped for the terminator.
  finalText: withoutTrailingNewlines,
  finish: (printed) => (printed === "" ? "" : "\n"),
  notice: note,
  tool: (text) => line(`· ${text}`),
  freshLines: false,
};

const EMACS: PresentationTable = {
  userTurn: (text) => line("You:") + line(text),
  input: inputLine,
  echoesTyping: false,
  answer: (text) => (text === "" ? "" : line(EMACS_CUES.heading) + text + afterBlankLine(text)),
  start: (cause, atLineStart) => `${atLineStart ? "" : "\n"}${line(EMACS_CUES[cause])}`,
  finalText: (text) => text,
  finish: (printed, ended) => (printed === "" ? "" : afterBlankLine(ended)),
  notice: (body) => line(`[status] ${body}`),
  tool: (text) => line(`[tool] ${text}`),
  freshLines: true,
};

const PRESENTATIONS: Record<Presentation, PresentationTable> = {
  terminal: TERMINAL,
  emacs: EMACS,
};

/** A wake entry's fields a transcript line reads (src/wake/task.ts `entryOf`). */
interface WakeEntryData {
  scheduledBy: number;
  episodeClass: EpisodeClass;
  intent: string;
}

/** Whether entry data reads as a wake's: the fields its line prints. */
const isWakeEntry = (value: unknown): value is WakeEntryData =>
  isRecord(value) &&
  typeof value["scheduledBy"] === "number" &&
  isEpisodeClass(value["episodeClass"]) &&
  typeof value["intent"] === "string";

/** A post as a transcript line: its letter decides both header and body. */
const postRendering = (post: PostInput): InputRendering => {
  switch (post.letter) {
    case "post":
      return {
        kind: "thread",
        header: `post from ${String(post.from)} (${post.topic})`,
        body: [post.intent, ...(post.context === undefined ? [] : [post.context])].join("\n"),
      };
    case "post-failed":
      return {
        kind: "thread",
        header: `post ${String(post.post)} to ${String(post.recipient)} failed (${post.outcome}): ${post.reason}`,
        body: "",
      };
    case "family-reaped":
      return {
        kind: "thread",
        header: `family ${originKey(post.origin)} reaped: ${post.reason}`,
        body: "",
      };
  }
};

/** A wake as a transcript line: who scheduled it and its class, then its intent. */
const wakeRendering = (wake: WakeEntryData): InputRendering => ({
  kind: "wake",
  header: `scheduled by ${String(wake.scheduledBy)} (${wake.episodeClass})`,
  body: wake.intent,
});

/** An entry's input, if it is a post or a wake; anything else renders as it did. */
function inputOf(entry: EntryRecord): InputRendering | undefined {
  const data = entry.data;
  if (entry.kind === POST_KIND && isPostInput(data)) {
    return postRendering(data);
  }
  return entry.kind === WAKE_KIND && isWakeEntry(data) ? wakeRendering(data) : undefined;
}

function transcriptLine(p: PresentationTable, entry: EntryRecord): string {
  const input = inputOf(entry);
  if (input !== undefined) {
    return p.input(input.kind, input.header, input.body);
  }
  const message = messageOf(entry);
  if (message?.role === "user") {
    return p.userTurn(textOf(message));
  }
  if (message?.role === "assistant") {
    return p.answer(textOf(message));
  }
  return entry.kind === "pi.compaction" ? p.notice("compacted") : "";
}

function toolArgs(args: unknown): string {
  const json = JSON.stringify(args ?? {});
  return json.length > ARGS_LIMIT ? `${json.slice(0, ARGS_LIMIT)}…` : json;
}

/** `blocks` with index `i` set to `text`; unlike `Array.with`, it may grow. */
function setAt(blocks: readonly string[], i: number, text: string): string[] {
  const next = Array.from({ length: Math.max(blocks.length, i + 1) }, (_, j) => blocks[j] ?? "");
  next[i] = text;
  return next;
}

/** Visible text of each block of the answer in flight, by content index. */
function applyChange(blocks: string[], change: MessageChange): string[] {
  if ("block" in change) {
    // A block opened, or replaced whole.
    return setAt(blocks, change.contentIndex, blockText(change.block));
  }
  switch (change.type) {
    case "text_delta":
      return setAt(blocks, change.contentIndex, (blocks[change.contentIndex] ?? "") + change.delta);
    case "message":
      return change.message.content.map(blockText);
    case "thinking_delta":
    case "toolcall_delta":
      return blocks;
  }
}

/** A thread mark as a listing prints it: what created the id. */
const markText = (mark: ThreadMark): string =>
  "forkOf" in mark ? `fork of ${String(mark.forkOf)}` : `started by ${String(mark.startedBy)}`;

/** One listing line's summary fields: the topic, then the model, empty when absent. */
const summaryFields = (summary: ConversationSummary | undefined): string =>
  `${summary?.topic ?? ""}\t${summary?.model ?? ""}`;

/**
 * One listing line: `id<TAB>topic<TAB>model`, and the thread mark after another tab
 * when the id has one. A reply without summaries still prints both empty fields.
 */
const lineOf = (
  id: number,
  summary: ConversationSummary | undefined,
  mark: ThreadMark | undefined,
): string =>
  `${String(id)}\t${summaryFields(summary)}${mark === undefined ? "" : `\t${markText(mark)}`}\n`;

/**
 * What events outside the answer in flight print; most print nothing. Those
 * that print go through `interrupt`, which cuts into the answer in flight.
 */
function notices(p: PresentationTable, interrupt: (out: string) => string): Notices {
  return {
    tool_execution_start: (event) => interrupt(p.tool(`${event.toolName} ${toolArgs(event.args)}`)),
    tool_execution_end: (event): string => {
      const result = messageOf(event.entry);
      const failed = result?.role === "toolResult" && result.isError;
      return failed ? interrupt(p.tool(`${event.toolName} failed`)) : "";
    },
    auto_retry_start: (event) =>
      interrupt(p.notice(`retry ${String(event.attempt)}: ${event.errorMessage}`)),
    compaction_start: () => interrupt(p.notice("compacting")),
    compaction_end: (event) =>
      interrupt(
        p.notice(
          event.error === undefined || event.error === ""
            ? "compacted"
            : `compaction failed: ${event.error}`,
        ),
      ),
    task_failed: (event) => interrupt(p.notice(`${event.kind} failed: ${event.message}`)),
    error: (event) => interrupt(p.notice(`error: ${event.message}`)),
    attached: (event) =>
      interrupt(p.notice(`attached to conversation ${String(event.conversation)}`)),
    // `id<TAB>topic<TAB>model`, then `\tmark` when the id is a thread: same text in both presents.
    conversations: (event) =>
      event.conversations
        .map((id) => lineOf(id, event.summaries?.[String(id)], event.marks?.[String(id)]))
        .join(""),
    // `name<TAB>cwd<TAB>toolset<TAB>model`, one per line: every field a topic leaves unset prints empty.
    topics: (event) =>
      event.topics
        .map(
          (topic) =>
            `${topic.name}\t${topic.cwd ?? ""}\t${topic.toolset ?? ""}\t${topic.model ?? ""}\n`,
        )
        .join(""),
    client_notice: (event) => interrupt(p.notice(event.text)),
    agent_changed: silent,
    auto_retry_end: silent,
    deferred_poll: silent,
    entry_appended: silent,
    inbox_update: silent,
    run_start: silent,
    run_end: silent,
    submission: silent,
    tool_execution_update: silent,
    turn_start: silent,
    turn_end: silent,
    usage_changed: silent,
  };
}

function dispatch<K extends keyof PrintableMap>(
  handlers: Handlers,
  type: K,
  event: PrintableMap[K],
): string {
  return handlers[type](event);
}

/**
 * A renderer for one connection. It tracks the answer in flight and prints
 * only what is new: pi-durable sends appends as deltas, but other edits as
 * whole blocks or a whole message, and the final text arrives at message_end.
 */
export function createRenderer(options: RendererOptions = {}): (event: Printable) => string {
  const p = PRESENTATIONS[options.presentation ?? "terminal"];
  let blocks: string[] = [];
  /** The answer's text as last seen, and its output as printed: they differ mid-print. */
  let shown = "";
  let printed = "";
  /** The last output's trailing newlines, which a cue, notice or terminator may need. */
  let ended = "\n";
  /** Whether a notice cut in since the answer last printed text. */
  let interrupted = false;
  const reset = (): void => {
    blocks = [];
    shown = "";
    printed = "";
    interrupted = false;
  };
  /** The answer's new text, under the cue that starts a block when it needs one. */
  const advance = (text: string): string => {
    const { unseen, rewrite } = extension(text, shown);
    const cause = blockCause({ unseen, rewrite }, printed !== "", interrupted);
    shown = text;
    if (unseen !== "") {
      interrupted = false;
    }
    printed = rewrite ? unseen : printed + unseen;
    return (cause === null ? "" : p.start(cause, ended !== "")) + unseen;
  };
  /**
   * A notice's output, cut into the answer in flight: Emacs starts it on a
   * fresh line and marks the text that follows as a continuation.
   */
  const interrupt = (out: string): string => {
    if (out === "") {
      return "";
    }
    interrupted = true;
    return p.freshLines && ended === "" ? `\n${out}` : out;
  };
  /** Start tracking an answer from its partial so far; returns its text. */
  const begin = (partial: Message | undefined): string => {
    reset();
    if (partial?.role === "assistant") {
      blocks = partial.content.map(blockText);
    }
    return advance(blocks.join(""));
  };
  const handlers: Handlers = {
    ...notices(p, interrupt),
    snapshot: (event) =>
      event.entries.map((entry) => transcriptLine(p, entry)).join("") +
      begin(event.generation?.message),
    message_start: (event) => begin(event.message),
    message_update: (event) => {
      for (const change of event.changes) {
        blocks = applyChange(blocks, change);
      }
      return advance(blocks.join(""));
    },
    message_end: (event) => {
      const input = inputOf(event.entry);
      if (input !== undefined) {
        // No client typed a post or wake: print it live even where typing is echoed.
        return interrupt(p.input(input.kind, input.header, input.body));
      }
      const message = messageOf(event.entry);
      if (message?.role === "user") {
        // A turn from this or another client can land mid-answer: it cuts in like a notice.
        return p.echoesTyping ? "" : interrupt(p.userTurn(textOf(message)));
      }
      if (message?.role !== "assistant") {
        return "";
      }
      // The final text goes through the cue path, so an answer first seen whole
      // is headed or cued as if it had streamed in.
      const text = advance(p.finalText(textOf(message), shown));
      const out = text + p.finish(printed, trailingNewlines(ended + text));
      reset();
      return out;
    },
  };
  return (event) => {
    const out = dispatch(handlers, event.type, event);
    if (out !== "") {
      ended = trailingNewlines(out);
    }
    return out;
  };
}
