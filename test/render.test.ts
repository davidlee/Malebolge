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
const renderAll = (
  events: unknown[],
  options?: { presentation?: "terminal" | "emacs" },
): string => {
  const render = createRenderer(options);
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

  it("renders a conversations frame as one id per line, in both presentations", () => {
    const frame = { type: "conversations", conversations: [9, 7, 3], truncated: false };
    expect(renderAll([frame])).toBe("9\n7\n3\n");
    expect(renderAll([frame], { presentation: "emacs" })).toBe("9\n7\n3\n");
    expect(renderAll([{ type: "conversations", conversations: [], truncated: true }])).toBe("");
  });

  it("renders a topics frame as name, directory and toolset, one per line, in both presentations", () => {
    // Every field is empty when unset: `default` has neither directory nor toolset (PHASE-04).
    const frame = {
      type: "topics",
      profile: "host",
      topics: [
        { name: "default" },
        { name: "work", cwd: "/tmp/work" },
        { name: "mail", cwd: "/tmp/mail", toolset: "mail" },
      ],
    };
    const lines = "default\t\t\nwork\t/tmp/work\t\nmail\t/tmp/mail\tmail\n";
    expect(renderAll([frame])).toBe(lines);
    expect(renderAll([frame], { presentation: "emacs" })).toBe(lines);
    expect(renderAll([{ type: "topics", profile: "room", topics: [] }])).toBe("");
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

// Signature: `createRenderer(options?: { presentation?: "terminal" | "emacs" })`.
// Options default to `{ presentation: "terminal" }`, so existing callers and the
// terminal client are unchanged. `client_notice` is a client-local event:
// `{ type: "client_notice", text: "connected" }`, `text` given without brackets.
const delta = (d: string): JsonRecord => ({
  type: "message_update",
  changes: [{ type: "text_delta", contentIndex: 0, delta: d }],
});
const start = (message?: unknown): JsonRecord => ({
  type: "message_start",
  message: message ?? { role: "assistant", content: [] },
});
const clientNotice = (text: string): JsonRecord => ({ type: "client_notice", text });
const emacs = (events: unknown[]): string => renderAll(events, { presentation: "emacs" });

describe("emacs presentation", () => {
  describe("user turns", () => {
    it("heads a snapshot user entry with `You:` on its own line, then exact content", () => {
      expect(emacs([snapshot([user("hi\nthere")])])).toBe("You:\nhi\nthere\n");
    });

    it("heads a live user message_end", () => {
      expect(emacs([{ type: "message_end", entry: user("hi") }])).toBe("You:\nhi\n");
    });

    it("replays the earlier turn and the new live turn once each", () => {
      expect(
        emacs([
          snapshot([user("first"), assistant("one")]),
          { type: "message_end", entry: user("second") },
        ]),
      ).toBe("You:\nfirst\nSatan:\none\n\nYou:\nsecond\n");
    });
  });

  describe("lazy `Satan:` heading", () => {
    it("prints no heading on message_start", () => {
      expect(emacs([start()])).toBe("");
    });

    it("prints no heading and no separator for a completed empty answer", () => {
      expect(emacs([start(), { type: "message_end", entry: assistant("") }])).toBe("");
    });

    it("prints no heading and no separator for a thinking-only answer", () => {
      const thinking = {
        kind: "pi.assistant",
        model: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }],
      };
      expect(
        emacs([
          start(),
          {
            type: "message_update",
            changes: [
              {
                type: "thinking_start",
                contentIndex: 0,
                block: { type: "thinking", thinking: "" },
              },
              { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
            ],
          },
          { type: "message_end", entry: thinking },
        ]),
      ).toBe("");
    });

    it("heads an answer that arrives whole at message_end", () => {
      expect(emacs([start(), { type: "message_end", entry: assistant("all at once") }])).toBe(
        "Satan:\nall at once\n\n",
      );
    });

    it("prints the heading once, on the first visible text delta", () => {
      expect(
        emacs([
          start(),
          delta("hel"),
          delta("lo"),
          { type: "message_end", entry: assistant("hello") },
        ]),
      ).toBe("Satan:\nhello\n\n");
    });
  });

  describe("completion separator", () => {
    it.each([
      ["none", "a", "\n\n"],
      ["one", "a\n", "\n"],
      ["two", "a\n\n", ""],
      ["three", "a\n\n\n", ""],
    ])("adds only the missing newlines to an answer ending in %s", (_label, text, missing) => {
      const expected = `Satan:\n${text}${missing}`;
      expect(emacs([start(), delta(text), { type: "message_end", entry: assistant(text) }])).toBe(
        expected,
      );
      expect(emacs([snapshot([assistant(text)])])).toBe(expected);
    });

    it("renders trailing newlines that arrive only at the end as a snapshot does", () => {
      const live = emacs([
        start(),
        delta("abc"),
        { type: "message_end", entry: assistant("abc\n\n\n") },
      ]);
      expect(live).toBe(emacs([snapshot([assistant("abc\n\n\n")])]));
    });

    it("sees the trailing newlines the stream never delivered", () => {
      expect(emacs([start(), delta("a"), { type: "message_end", entry: assistant("a\n\n") }])).toBe(
        "Satan:\na\n\n",
      );
    });

    it("renders a turn the same from a snapshot and live", () => {
      const live = emacs([
        { type: "message_end", entry: user("hi\nthere") },
        start(),
        delta("hello\n"),
        delta("world"),
        { type: "message_end", entry: assistant("hello\nworld") },
      ]);
      expect(live).toBe("You:\nhi\nthere\nSatan:\nhello\nworld\n\n");
      expect(emacs([snapshot([user("hi\nthere"), assistant("hello\nworld")])])).toBe(live);
    });
  });

  describe("labels", () => {
    it("labels daemon notices `[status]`", () => {
      expect(
        emacs([
          { type: "attached", conversation: 3 },
          { type: "compaction_start", taskId: "t", reason: "manual", blocking: false },
          { type: "error", message: "boom" },
        ]),
      ).toBe("[status] attached to conversation 3\n[status] compacting\n[status] error: boom\n");
    });

    it("labels tool activity `[tool]`", () => {
      expect(
        emacs([
          {
            type: "tool_execution_start",
            toolName: "bash",
            toolCallId: "1",
            args: { command: "ls" },
          },
          {
            type: "tool_execution_end",
            toolName: "bash",
            toolCallId: "1",
            entry: toolResult(true),
          },
        ]),
      ).toBe('[tool] bash {"command":"ls"}\n[tool] bash failed\n');
    });

    it("labels a client-local notice `[status]`", () => {
      expect(emacs([clientNotice("connected")])).toBe("[status] connected\n");
    });
  });

  describe("notices mid-stream", () => {
    it("starts a notice on a fresh line and resumes under `Satan (continued):`", () => {
      expect(
        emacs([
          start(),
          delta("hello"),
          { type: "error", message: "boom" },
          delta(" world"),
          { type: "message_end", entry: assistant("hello world") },
        ]),
      ).toBe("Satan:\nhello\n[status] error: boom\nSatan (continued):\n world\n\n");
    });

    it("keeps the continuation cue across an update with no visible text", () => {
      expect(
        emacs([
          start(),
          delta("hello"),
          { type: "error", message: "boom" },
          {
            type: "message_update",
            changes: [{ type: "thinking_delta", contentIndex: 1, delta: "hmm" }],
          },
          delta(" world"),
          { type: "message_end", entry: assistant("hello world") },
        ]),
      ).toBe("Satan:\nhello\n[status] error: boom\nSatan (continued):\n world\n\n");
    });

    it("adds one blank line, not two, after a notice that ends the answer", () => {
      expect(
        emacs([
          start(),
          delta("abc"),
          { type: "tool_execution_start", toolName: "x", args: {} },
          { type: "message_end", entry: assistant("abc") },
        ]),
      ).toBe("Satan:\nabc\n[tool] x {}\n\n");
    });

    it("cuts a live user turn into a streaming answer like a notice", () => {
      expect(
        emacs([
          start(),
          delta("hello"),
          { type: "message_end", entry: user("hi\nthere") },
          delta(" world"),
          { type: "message_end", entry: assistant("hello world") },
        ]),
      ).toBe("Satan:\nhello\nYou:\nhi\nthere\nSatan (continued):\n world\n\n");
    });

    it("does the same for a client-local notice mid-stream", () => {
      expect(
        emacs([
          start(),
          delta("hello"),
          clientNotice("detached"),
          delta(" world"),
          { type: "message_end", entry: assistant("hello world") },
        ]),
      ).toBe("Satan:\nhello\n[status] detached\nSatan (continued):\n world\n\n");
    });

    it("starts a non-overwritable rewrite under `Satan (revised):`", () => {
      expect(
        emacs([
          start(),
          {
            type: "message_update",
            changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "A" } }],
          },
          {
            type: "message_update",
            changes: [{ type: "block", contentIndex: 0, block: { type: "text", text: "BCD" } }],
          },
          { type: "message_end", entry: assistant("BCD") },
        ]),
      ).toBe("Satan:\nA\nSatan (revised):\nBCD\n\n");
    });

    it("cues a rewrite that first shows at message_end", () => {
      expect(
        emacs([
          start(),
          {
            type: "message_update",
            changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "A" } }],
          },
          { type: "message_end", entry: assistant("BCD") },
        ]),
      ).toBe("Satan:\nA\nSatan (revised):\nBCD\n\n");
    });
  });

  describe("compaction entries", () => {
    it("reports a snapshot's compaction as a `[status]` notice", () => {
      expect(emacs([snapshot([{ kind: "pi.compaction" }])])).toBe("[status] compacted\n");
    });
  });

  describe("reattached partial answer", () => {
    it("gets one heading and does not duplicate its snapshot text", () => {
      const partial = { role: "assistant", content: [{ type: "text", text: "I am" }] };
      expect(
        emacs([
          { ...snapshot([user("hi")]), generation: { attempt: 1, message: partial } },
          delta(" SATAN"),
          { type: "message_end", entry: assistant("I am SATAN") },
        ]),
      ).toBe("You:\nhi\nSatan:\nI am SATAN\n\n");
    });
  });
});

describe("terminal presentation", () => {
  it('is the default: no options equals explicit `presentation: "terminal"`', () => {
    const sequence = [
      snapshot([user("hi"), assistant("hello")]),
      { type: "attached", conversation: 3 },
      start(),
      delta("wor"),
      delta("ld"),
      { type: "error", message: "boom" },
      { type: "message_end", entry: assistant("world") },
    ];
    expect(renderAll(sequence)).toBe(renderAll(sequence, { presentation: "terminal" }));
  });

  it("renders a client-local notice as its bracketed text", () => {
    expect(renderAll([clientNotice("connected")])).toBe("[connected]\n");
  });
});
