// Agent events as plain appended text: no cursor movement, so the same output
// suits a terminal and an Emacs comint buffer.

import type { Message } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, MessageChange } from "@earendil-works/pi-durable";
import type { ErrorMessage } from "./protocol.ts";

export type Printable = AgentEvent | ErrorMessage;

const ARGS_LIMIT = 120;

const messageOf = (entry: EntryRecord | undefined): Message | undefined =>
  entry?.model?.[0] as Message | undefined;

/** Visible text of a content block; thinking and tool calls show none. */
const blockText = (block: { type: string; text?: string }): string =>
  block.type === "text" ? (block.text ?? "") : "";

function textOf(message: Message | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map(blockText).join("");
}

const line = (text: string) => `${text}\n`;
const note = (text: string) => line(`[${text}]`);

function transcriptLine(entry: EntryRecord): string {
  const message = messageOf(entry);
  if (message?.role === "user") return line(`» ${textOf(message)}`);
  if (message?.role === "assistant") return textOf(message) ? line(textOf(message)) : "";
  return entry.kind === "pi.compaction" ? note("compacted") : "";
}

function toolArgs(args: unknown): string {
  const json = JSON.stringify(args ?? {});
  return json.length > ARGS_LIMIT ? `${json.slice(0, ARGS_LIMIT)}…` : json;
}

/** `blocks` with index `i` set to `text`; unlike `Array.with`, it may grow. */
function setAt(blocks: readonly string[], i: number, text: string): string[] {
  const next = [...blocks];
  next[i] = text;
  return Array.from(next, (block) => block ?? "");
}

/** Visible text of each block of the answer in flight, by content index. */
function applyChange(blocks: string[], change: MessageChange): string[] {
  switch (change.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
    case "block":
      return setAt(blocks, change.contentIndex, blockText(change.block));
    case "text_delta":
      return setAt(blocks, change.contentIndex, (blocks[change.contentIndex] ?? "") + change.delta);
    case "message":
      return change.message.content.map(blockText);
    default:
      return blocks;
  }
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
  const advance = (text: string) => {
    const unseen = text.startsWith(shown) ? text.slice(shown.length) : `\n${text}`;
    shown = text;
    return unseen;
  };
  const reset = () => {
    blocks = [];
    shown = "";
  };
  /** Start tracking an answer from its partial so far; returns its text. */
  const begin = (partial: Message | undefined) => {
    reset();
    if (partial?.role === "assistant") blocks = partial.content.map(blockText);
    return advance(blocks.join(""));
  };
  return (event) => {
    switch (event.type) {
      case "snapshot": {
        const transcript = event.entries.map(transcriptLine).join("");
        return transcript + begin(event.generation?.message);
      }
      case "message_start":
        return begin(event.message);
      case "message_update":
        blocks = event.changes.reduce(applyChange, blocks);
        return advance(blocks.join(""));
      case "message_end": {
        const message = messageOf(event.entry);
        if (message?.role !== "assistant") return "";
        const unseen = advance(textOf(message));
        const out = shown ? line(unseen) : "";
        reset();
        return out;
      }
      case "tool_execution_start":
        return line(`· ${event.toolName} ${toolArgs(event.args)}`);
      case "tool_execution_end": {
        const result = messageOf(event.entry);
        const failed = result?.role === "toolResult" && result.isError;
        return failed ? line(`· ${event.toolName} failed`) : "";
      }
      case "auto_retry_start":
        return note(`retry ${event.attempt}: ${event.errorMessage}`);
      case "compaction_start":
        return note("compacting");
      case "compaction_end":
        return note(event.error ? `compaction failed: ${event.error}` : "compacted");
      case "task_failed":
        return note(`${event.kind} failed: ${event.message}`);
      case "error":
        return note(`error: ${event.message}`);
      default:
        return "";
    }
  };
}
