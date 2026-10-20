// Agent events as plain appended text: no cursor movement, so the same output
// suits a terminal and an Emacs comint buffer.

import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, MessageChange } from "@earendil-works/pi-durable";
import { isRecord } from "./json.ts";
import type { AttachedMessage, ErrorMessage } from "./protocol.ts";

export type Printable = AgentEvent | ErrorMessage | AttachedMessage;

/** Each printable event type, keyed to its event. */
type PrintableMap = { [E in Printable as E["type"]]: E };
type Handlers = { [K in keyof PrintableMap]: (event: PrintableMap[K]) => string };

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

function transcriptLine(entry: EntryRecord): string {
  const message = messageOf(entry);
  if (message?.role === "user") {
    return line(`» ${textOf(message)}`);
  }
  if (message?.role === "assistant") {
    return lineUnlessEmpty(textOf(message));
  }
  return entry.kind === "pi.compaction" ? note("compacted") : "";
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

/** What events outside the answer in flight print; most print nothing. */
const notices: Omit<Handlers, "snapshot" | "message_start" | "message_update" | "message_end"> = {
  tool_execution_start: (event) => line(`· ${event.toolName} ${toolArgs(event.args)}`),
  tool_execution_end: (event) => {
    const result = messageOf(event.entry);
    const failed = result?.role === "toolResult" && result.isError;
    return failed ? line(`· ${event.toolName} failed`) : "";
  },
  auto_retry_start: (event) => note(`retry ${String(event.attempt)}: ${event.errorMessage}`),
  compaction_start: () => note("compacting"),
  compaction_end: (event) =>
    note(
      event.error === undefined || event.error === ""
        ? "compacted"
        : `compaction failed: ${event.error}`,
    ),
  task_failed: (event) => note(`${event.kind} failed: ${event.message}`),
  error: (event) => note(`error: ${event.message}`),
  attached: (event) => note(`attached to conversation ${String(event.conversation)}`),
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
export function createRenderer(): (event: Printable) => string {
  let blocks: string[] = [];
  let shown = "";
  /** The part of `text` not yet printed; a rewrite (rare) restarts the line. */
  const advance = (text: string): string => {
    const unseen = text.startsWith(shown) ? text.slice(shown.length) : `\n${text}`;
    shown = text;
    return unseen;
  };
  const reset = (): void => {
    blocks = [];
    shown = "";
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
    ...notices,
    snapshot: (event) =>
      event.entries.map(transcriptLine).join("") + begin(event.generation?.message),
    message_start: (event) => begin(event.message),
    message_update: (event) => {
      for (const change of event.changes) {
        blocks = applyChange(blocks, change);
      }
      return advance(blocks.join(""));
    },
    message_end: (event) => {
      const message = messageOf(event.entry);
      if (message?.role !== "assistant") {
        return "";
      }
      const unseen = advance(textOf(message));
      const out = shown === "" ? "" : line(unseen);
      reset();
      return out;
    },
  };
  return (event) => dispatch(handlers, event.type, event);
}
