import { describe, expect, it } from "vitest";
import type { JsonRecord } from "../src/json.ts";
import { createRenderer, toPrintable } from "../src/render.ts";

const assistant = (text: string): JsonRecord => ({
  kind: "pi.assistant",
  model: [{ role: "assistant", content: [{ type: "text", text }] }],
});
const user = (text: string): JsonRecord => ({
  kind: "pi.user",
  model: [{ role: "user", content: text }],
});
const toolResult = (isError: boolean): JsonRecord => ({
  kind: "pi.tool-result",
  model: [{ role: "toolResult", isError, content: [{ type: "text", text: "x" }] }],
});
const snapshot = (entries: unknown[]): JsonRecord => ({
  type: "snapshot",
  entries,
  tools: [],
  nestedTools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: {},
});

// Events are loosely built here, as they arrive off the wire: the renderer
// reads only the fields it prints.
const renderAll = (events: unknown[]): string => {
  const render = createRenderer();
  return events.map((event) => render(toPrintable(event))).join("");
};

describe("renderer", () => {
  it("replays the transcript of a snapshot, user turns marked", () => {
    expect(renderAll([snapshot([user("hi"), assistant("hello")])])).toBe("» hi\nhello\n");
  });

  it("shows an answer in flight at attach, then continues it", () => {
    const partial = { role: "assistant", content: [{ type: "text", text: "I am" }] };
    expect(
      renderAll([
        { ...snapshot([user("hi")]), generation: { attempt: 1, message: partial } },
        {
          type: "message_update",
          changes: [{ type: "text_delta", contentIndex: 0, delta: " SATAN" }],
        },
        { type: "message_end", entry: assistant("I am SATAN") },
      ]),
    ).toBe("» hi\nI am SATAN\n");
  });

  it("streams text deltas, ending the message with a newline", () => {
    const delta = (d: string): JsonRecord => ({
      type: "message_update",
      changes: [{ type: "text_delta", contentIndex: 0, delta: d }],
    });
    expect(
      renderAll([
        { type: "message_start", message: { role: "assistant", content: [] } },
        delta("hel"),
        delta("lo"),
        { type: "message_end", entry: assistant("hello") },
      ]),
    ).toBe("hello\n");
  });

  it("prints the text a block opens with, then its deltas", () => {
    expect(
      renderAll([
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          changes: [
            { type: "text_start", contentIndex: 0, block: { type: "text", text: "I am" } },
            { type: "text_delta", contentIndex: 0, delta: " SATAN" },
          ],
        },
        { type: "message_end", entry: assistant("I am SATAN") },
      ]),
    ).toBe("I am SATAN\n");
  });

  it("follows whole-block and whole-message replacements, not just deltas", () => {
    const text = (t: string): JsonRecord => ({ type: "text", text: t });
    expect(
      renderAll([
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          changes: [{ type: "text_start", contentIndex: 0, block: text("A") }],
        },
        {
          type: "message_update",
          changes: [{ type: "block", contentIndex: 0, block: text("ABC") }],
        },
        {
          type: "message_update",
          changes: [{ type: "message", message: { role: "assistant", content: [text("ABCD")] } }],
        },
        { type: "message_end", entry: assistant("ABCD") },
      ]),
    ).toBe("ABCD\n");
  });

  it("prints the tail the stream never delivered when the answer ends", () => {
    expect(
      renderAll([
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "What" } }],
        },
        { type: "message_end", entry: assistant("What do you want?") },
      ]),
    ).toBe("What do you want?\n");
  });

  it("skips thinking blocks between text blocks", () => {
    expect(
      renderAll([
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          changes: [
            { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
            { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
            { type: "text_start", contentIndex: 1, block: { type: "text", text: "Hi" } },
          ],
        },
        { type: "message_end", entry: assistant("Hi") },
      ]),
    ).toBe("Hi\n");
  });

  it("starts from the partial answer message_start carries, printing it once", () => {
    const partial = { role: "assistant", content: [{ type: "text", text: "Good. Malebol" }] };
    expect(
      renderAll([
        { type: "message_start", message: partial },
        {
          type: "message_update",
          changes: [{ type: "text_delta", contentIndex: 0, delta: "ge it is" }],
        },
        { type: "message_end", entry: assistant("Good. Malebolge it is.") },
      ]),
    ).toBe("Good. Malebolge it is.\n");
  });

  it("ignores a user message's start", () => {
    expect(renderAll([{ type: "message_start", message: { role: "user", content: "hi" } }])).toBe(
      "",
    );
  });

  it("prints a whole answer that arrived without deltas", () => {
    expect(
      renderAll([
        { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_end", entry: assistant("all at once") },
      ]),
    ).toBe("all at once\n");
  });

  it("does not echo live user turns: the typing client already shows them", () => {
    expect(renderAll([{ type: "message_end", entry: user("hi") }])).toBe("");
  });

  it("marks tool calls, and failures", () => {
    expect(
      renderAll([
        {
          type: "tool_execution_start",
          toolName: "bash",
          toolCallId: "1",
          args: { command: "ls" },
        },
        { type: "tool_execution_end", toolName: "bash", toolCallId: "1", entry: toolResult(false) },
        { type: "tool_execution_start", toolName: "bash", toolCallId: "2", args: {} },
        { type: "tool_execution_end", toolName: "bash", toolCallId: "2", entry: toolResult(true) },
      ]),
    ).toBe('· bash {"command":"ls"}\n· bash {}\n· bash failed\n');
  });

  it("notes retries, compaction, failures and daemon errors", () => {
    expect(
      renderAll([
        { type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "429" },
        { type: "compaction_start", taskId: "t", reason: "manual", blocking: false },
        { type: "compaction_end", taskId: "t", reason: "manual" },
        { type: "compaction_end", taskId: "t", reason: "manual", error: "nope" },
        { type: "task_failed", taskId: "t", kind: "pi.generation", message: "bad key" },
        { type: "error", message: "unknown message type" },
      ]),
    ).toBe(
      [
        "[retry 1: 429]",
        "[compacting]",
        "[compacted]",
        "[compaction failed: nope]",
        "[pi.generation failed: bad key]",
        "[error: unknown message type]",
        "",
      ].join("\n"),
    );
  });

  it("announces the conversation it attached to", () => {
    expect(renderAll([{ type: "attached", conversation: 3 }])).toBe(
      "[attached to conversation 3]\n",
    );
  });

  it("ignores bookkeeping events", () => {
    expect(renderAll([{ type: "usage_changed", usage: {} }, { type: "turn_start" }])).toBe("");
  });
});

describe("toPrintable", () => {
  it.each([[null], [[]], ["text"], [{}], [{ type: 1 }]])("rejects %j as not an event", (value) => {
    expect(() => toPrintable(value)).toThrow(/not an event/);
  });
});
