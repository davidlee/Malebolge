// SL-006 PHASE-07 run A (DEC-031): a premise probe, not product code. Can a tool,
// inside its own `api.commit`, fork its own conversation at the latest entry and
// append a ToolResultEntry for its own call id to the child, so that the child's
// model context shows that written result instead of pi-durable's synthetic
// `Tool result unavailable: ...` error? The probe tool lives here, test-locally.

import type { Context } from "@earendil-works/chord/context";
import { type Message, type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type ConversationId,
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import { answer } from "../src/tool-results.ts";
import { writeTopicRecord } from "../src/topics.ts";
import { FAUX_MODEL, textOf, toolResults } from "./harness-fixture.ts";
import {
  afterToolCall,
  answeredChild,
  attemptCall,
  CALL_ID,
  callerThread,
  CONTEXT,
  conversationCount,
  conversationOf,
  createIndexedThread,
  envelopeOf,
  indexEntryOf,
  INTENT,
  only,
  postedTurn,
  postTasks,
  SECOND_REF,
  threadWorld,
} from "./thread-fixture.ts";
import { userText, WAIT } from "./wake-fixture.ts";

const PROBE = "fork_probe";
/** The probe extension's name: what the caller's toolset selection resolves. */
const PROBE_EXTENSION = "fork-probe";

/** What the probe writes the child: the conversation it forked and why it exists. */
const written = (forkOf: ConversationId): string =>
  JSON.stringify({ fork_of: forkOf, purpose: "arrives as your first post" });

interface ForkProbe {
  readonly extension: Extension;
  /** The child id each call forked, in call order. */
  readonly children: ConversationId[];
}

/**
 * The test-local probe: one `api.commit` reads the caller's latest entry, forks the
 * caller there, and appends this call's own result to the child — reads before writes,
 * as a tool's commit requires. It answers the child's id.
 */
function forkProbe(): ForkProbe {
  const children: ConversationId[] = [];
  const fork = (api: ToolExecutionApi, ctx: Context): Promise<ConversationId> =>
    api.commit(async (tx) => {
      const [latest] = (
        await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 1)
      ).items;
      if (latest === undefined) {
        throw new Error(`no entry to fork conversation ${String(api.conversationId)} at`);
      }
      const { id } = await tx.forkConversation(api.conversationId, latest.id, {
        ownership: { kind: "ownerless" },
      });
      await tx.appendEntry(ToolResultEntry, id, {
        model: [
          {
            role: "toolResult",
            toolCallId: api.callId,
            toolName: PROBE,
            isError: false,
            content: [{ type: "text", text: written(api.conversationId) }],
            timestamp: api.now(),
          },
        ],
        data: { diagnostics: [] },
      });
      return id;
    }, ctx);
  const extension = defineExtension({
    name: PROBE_EXTENSION,
    tools: [
      defineTool({
        name: PROBE,
        description:
          "Forks this conversation at its latest entry, writes this call's result into the fork and answers its id.",
        parameters: Type.Object({}),
        execute: async (_args, api, ctx): Promise<ToolExecutionResult> => {
          const child = await fork(api, ctx);
          children.push(child);
          return answer({ fork: child });
        },
      }),
    ],
  });
  return { extension, children };
}

describe("fork premise (SL-006 PHASE-07 run A, DEC-031)", () => {
  it("a fork's child sees the written fork result, not 'Tool result unavailable'", async () => {
    const world = threadWorld();
    const probe = forkProbe();
    const session = await world.open(undefined, [probe.extension]);
    const caller = await createIndexedThread(session.harness, "room", ["threads", PROBE_EXTENSION]);

    // The caller's one scripted turn: a single fork_probe call, then a plain answer.
    world.faux.setResponses([
      fauxAssistantMessage([fauxToolCall(PROBE, {}, { id: CALL_ID })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("forked")]),
    ]);
    const forked = await (
      await caller.submit({ type: "input", content: "fork yourself" }, context)
    ).wait(context);
    expect(forked.status).toBe("done");
    const childId = only(probe.children);

    // The child's own turn: the request it sends is the context the premise is about.
    const requests: Message[][] = [];
    const capture: FauxResponseFactory = (request) => {
      requests.push(request.messages);
      return fauxAssistantMessage([fauxText("answered")]);
    };
    world.faux.setResponses([capture]);

    const child = await session.harness.conversation(childId, context);
    if (child === undefined) {
      throw new Error(`the probe forked ${String(childId)}, which the session cannot open`);
    }
    const answered = await (await child.submit({ type: "input", content: "hello" }, context)).wait(
      context,
    );
    expect(answered.status).toBe("done");

    const messages = only(requests);
    const saw = only(
      messages.filter(
        (message): message is ToolResultMessage =>
          message.role === "toolResult" && message.toolCallId === CALL_ID,
      ),
    );
    expect(saw.isError).toBe(false);
    expect(textOf(saw)).toContain("fork_of");
    expect(textOf(saw)).toContain(String(caller.id));
    expect(JSON.stringify(messages)).not.toContain("Tool result unavailable");
  });
});

/** The tool's description, pinned: what the model reads it is offered. */
const DESCRIPTION =
  "Fork this conversation as it stands, history included, and send the fork a first post. " +
  "intent: why it exists, about a sentence; context: optional material. " +
  "Must be the only tool call in its message. Refused over the post caps. " +
  "It answers only by thread_post to you; ask for that if you want a reply. " +
  "Returns the fork's id and topic.";

/** The answer a test scripts when it wants a post turn to finish rather than hold. */
const answering: FauxResponseFactory = (request) =>
  fauxAssistantMessage([fauxText(postedTurn(request) ? "read" : "posted")]);

describe("thread_fork (PHASE-07 EX-3, VT-1, VT-2)", () => {
  it("a fork's child learns its parent and purpose", async () => {
    const base = await callerThread();
    const { caller } = base;
    const requests: Message[][] = [];
    // Capture the child's first request: its post turn is the one carrying the envelope.
    const capture: FauxResponseFactory = (request) => {
      if (postedTurn(request)) {
        requests.push(request.messages);
        return fauxAssistantMessage([fauxText("answered")]);
      }
      return fauxAssistantMessage([fauxText("forked")]);
    };

    const result = await attemptCall(
      base,
      "thread_fork",
      { intent: INTENT, context: CONTEXT },
      capture,
    );

    expect(result.isError).toBe(false);
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
    }, WAIT);
    const messages = only(requests);
    const saw = only(
      messages.filter(
        (message): message is ToolResultMessage =>
          message.role === "toolResult" && message.toolCallId === CALL_ID,
      ),
    );
    expect(saw.isError).toBe(false);
    expect(JSON.parse(textOf(saw))).toEqual({
      fork_of: caller.id,
      purpose: "arrives as your first post",
    });
    // The purpose arrives as the fork's first post, after the written result.
    const envelope = envelopeOf(caller.id, "room");
    expect(messages.map(userText)).toContain(envelope);
    expect(messages.indexOf(saw)).toBeLessThan(
      messages.findIndex((message) => userText(message) === envelope),
    );
    expect(JSON.stringify(messages)).not.toContain("Tool result unavailable");
  });

  it("thread_fork keeps the caller's topic and toolset and survives a restart", async () => {
    const world = threadWorld();
    const session = await world.open();
    const caller = await createIndexedThread(session.harness, "research");

    const result = await attemptCall(
      { world, session, caller },
      "thread_fork",
      { intent: INTENT },
      answering,
    );
    const childId = answeredChild(result);
    expect(await indexEntryOf(session, childId)).toEqual({
      topic: "research",
      parent: caller.id,
      toolset: "interactive",
    });

    // A restart opens the store the fork left: the index entry it carries is enough.
    await session.harness.close(context);
    const reopened = await world.open();
    const child = await conversationOf(reopened.harness, childId);
    const names = (await child.agent(context)).tools.map(({ name }) => name);
    expect(names).toContain("thread_post");
  });

  it("thread_fork after compaction forks at the latest entry", async () => {
    const world = threadWorld();
    // The daemon's own policy: an explicit compaction writes the summary entry.
    const session = await world.open();
    const caller = await createIndexedThread(session.harness, "room");

    world.faux.setResponses([fauxAssistantMessage([fauxText("before the summary")])]);
    await (await caller.submit({ type: "input", content: "first" }, context)).wait(context);
    world.faux.setResponses([fauxAssistantMessage([fauxText("the summary")])]);
    const summary = await caller.compact(undefined, context);
    await session.harness.waitForTask(summary, context);
    await vi.waitFor(async () => {
      const { messages } = await caller.context(context);
      expect(JSON.stringify(messages)).toContain("the summary");
    }, WAIT);

    const result = await attemptCall(
      { world, session, caller },
      "thread_fork",
      { intent: INTENT },
      answering,
    );
    const child = await conversationOf(session.harness, answeredChild(result));
    const { messages } = await child.context(context);
    const transcript = JSON.stringify(messages);
    // The fork kept the compaction summary and forked at this turn's call, not before it.
    expect(transcript).toContain("the summary");
    expect(transcript).toContain(CALL_ID);
  });

  it("thread_fork with a sibling tool call is refused", async () => {
    const world = threadWorld();
    const session = await world.open();
    const caller = await createIndexedThread(session.harness, "room", ["threads", "probe"]);
    const before = await conversationCount(session.harness);

    world.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("thread_fork", { intent: INTENT }, { id: CALL_ID }),
          fauxToolCall("probe", {}, { id: "call-2" }),
        ],
        { stopReason: "toolUse" },
      ),
      afterToolCall,
      afterToolCall,
    ]);
    await (await caller.submit({ type: "input", content: "go" }, context)).wait(context);

    const refused = only(
      (await toolResults(session.harness, caller)).filter(
        (result) => result.toolCallId === CALL_ID,
      ),
    );
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("thread_fork must be the only tool call in its message");
    // The negative control: no fork, no post task, no journal line.
    expect(await conversationCount(session.harness)).toBe(before);
    expect(await postTasks(session.harness)).toEqual([]);
    expect(world.lines.filter((line) => line.startsWith("thread fork"))).toEqual([]);
  });

  // SL-010 PHASE-03 VT-4: a pin, not a change: the fork copies its parent's agent model.
  it("thread_fork keeps its parent's model when the topic's model differs (VT-4)", async () => {
    const base = await callerThread();
    const { session, caller } = base;
    // The caller was created before the topic wrote a model, so its own is the default.
    await writeTopicRecord(session.harness, "room", { model: SECOND_REF });
    expect((await caller.agent(context)).model).toEqual(FAUX_MODEL);

    const forked = await conversationOf(
      session.harness,
      answeredChild(await attemptCall(base, "thread_fork", { intent: INTENT }, answering)),
    );

    expect((await forked.agent(context)).model).toEqual(FAUX_MODEL);
  });

  it("thread_fork is model-only, sequential and replay unsafe", async () => {
    const world = threadWorld();
    const session = await world.open();
    const caller = await createIndexedThread(session.harness, "room");

    const tool = (await caller.agent(context)).tools.find(({ name }) => name === "thread_fork");
    expect(tool?.callers).toEqual(["model"]);
    expect(tool?.executionMode).toBe("sequential");
    expect(tool?.replay).toBe("unsafe");
    expect(tool?.description).toBe(DESCRIPTION);
  });
});
