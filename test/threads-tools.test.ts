// The thread_post tool (SL-006 PHASE-05 run B1; EX-1, EX-2, EX-5, EX-6, VT-4, VT-6):
// one call creates a post task owned by its recipient and answers its id, journals
// the post with its origin, and is offered sequential and replay-unsafe beside the
// pinned `threads` section its prompt carries.

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, type TaskInspection, UserEntry } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import { daemonExtensions } from "../src/daemon-extensions.ts";
import { isRecord } from "../src/json.ts";
import { mailExtension } from "../src/mail/extension.ts";
import { FAMILY_CAP, GLOBAL_CAP } from "../src/threads/admission.ts";
import type { Origin } from "../src/threads/origin.ts";
import { THREADS_SECTION, threadBinding, threadsExtension } from "../src/threads/extension.ts";
import { writeTopicRecord } from "../src/topics.ts";
import { tasksExtension, wakeBinding } from "../src/wake/extension.ts";
import { createTaskOwned, systemPromptSections, textOf, toolResults } from "./harness-fixture.ts";
import { interactiveSnapshot } from "./interactive-baseline.ts";
import { fakeMailSource } from "./mail/mail-fixtures.ts";
import {
  createIndexedThread,
  inputOf,
  only,
  postEntries,
  postTasks,
  type ThreadSession,
  type ThreadWorld,
  threadWorld,
} from "./thread-fixture.ts";
import { entriesOf, heldUntilCutOff, WAIT } from "./wake-fixture.ts";

const INTENT = "Summarise the failing test runs";
const CONTEXT = "see /tmp/runs.txt";

/** The design's section text, one line per paragraph: what `THREADS_SECTION` must be. */
const DESIGN_SECTION = [
  "A <post> comes from another of your own conversations, a peer thread, not from the operator. Its from is the conversation that sent it; reply with thread_post to that id. A fork's thread_fork result names the conversation it was forked from; its purpose arrives as its first post.",
  'A <post-failed> says a post of yours failed, and why. outcome="withdrawn": the recipient never read it. outcome="delivered-incomplete": the recipient read it but its turn did not complete; it may have acted on it.',
  "A <family-reaped> says an activity was stopped for fan-out: too many posts at once from one starting input. Its posts not yet read are withdrawn, and posts and thread starts from that activity are refused.",
].join("\n\n");

/** One scripted post: the world, its two conversations, the task it created and its result. */
interface Posted {
  readonly world: ThreadWorld;
  readonly session: ThreadSession;
  readonly caller: Conversation;
  readonly recipient: Conversation;
  readonly post: TaskInspection;
  /** The caller's operator input, which the post carries as a human origin. */
  readonly origin: Origin;
  /** The tool result's text, as the model reads it. */
  readonly result: string;
}

/** Whether `request` is the recipient's turn: its transcript carries the post's envelope. */
const postedTurn = (request: Parameters<FauxResponseFactory>[0]): boolean =>
  JSON.stringify(request.messages).includes("<post from=");

/**
 * The answer after the caller's tool call, for whichever conversation asks next: the
 * recipient's turn is held (so the post task stays live while a test reads it), and the
 * caller's continuation answers, in either order.
 */
const afterToolCall: FauxResponseFactory = (request, options, state, model) =>
  postedTurn(request)
    ? heldUntilCutOff(request, options, state, model)
    : fauxAssistantMessage([fauxText("posted")]);

/** The setup every post case starts from: a world, its session and an indexed caller. */
interface CallerThread {
  readonly world: ThreadWorld;
  readonly session: ThreadSession;
  readonly caller: Conversation;
}

/** A fresh world, and a caller indexed on `room` in it. */
async function callerThread(): Promise<CallerThread> {
  const world = threadWorld();
  const session = await world.open();
  const caller = await createIndexedThread(session.harness, "room");
  return { world, session, caller };
}

/**
 * One scripted caller turn that calls thread_post on `to`, and the tool result the model
 * read. A recipient's turn, when the post is admitted, is held, so the post's task is
 * still live (and counted) while the test reads it; the caller's continuation answers.
 */
async function attemptPost(
  { world, session, caller }: CallerThread,
  to: number,
): Promise<ToolResultMessage> {
  world.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("thread_post", { to, intent: INTENT, context: CONTEXT }, { id: "call-1" })],
      { stopReason: "toolUse" },
    ),
    afterToolCall,
    afterToolCall,
  ]);
  await (await caller.submit({ type: "input", content: "go" }, context)).wait(context);
  return only(await toolResults(session.harness, caller));
}

/** One scripted caller turn that posts to a fresh indexed recipient. */
async function postOnce(): Promise<Posted> {
  const base = await callerThread();
  const { world, session, caller } = base;
  const recipient = await createIndexedThread(session.harness, "research", []);
  const result = await attemptPost(base, recipient.id);
  const post = only(await postTasks(session.harness));
  const input = only((await entriesOf(caller)).filter((entry) => UserEntry.is(entry)));
  return {
    world,
    session,
    caller,
    recipient,
    post,
    origin: { conversation: caller.id, entry: input.id, kind: "human" },
    result: textOf(result),
  };
}

/**
 * Asserts that a call refusing `to` did nothing: the model read exactly `text`, no post
 * task exists, and nothing was journaled. This is the negative control: a case that
 * slipped past admission would create a post task and fail the empty assertion.
 */
async function expectRefusal(base: CallerThread, to: number, text: string): Promise<void> {
  const result = await attemptPost(base, to);
  expect(result.isError).toBe(true);
  expect(textOf(result)).toBe(text);
  expect(await postTasks(base.session.harness)).toEqual([]);
  expect(base.world.lines.filter((line) => line.startsWith("post "))).toEqual([]);
}

describe("thread_post (PHASE-05 EX-1, EX-2, EX-5, EX-6, VT-4, VT-6)", () => {
  it("thread_post creates a post task owned by the recipient", async () => {
    const { caller, recipient, post, origin, result } = await postOnce();

    expect(JSON.parse(result)).toEqual({ post: post.record.id, to: recipient.id });
    expect(post.record.conversationId).toBe(recipient.id);
    expect(post.record.owner).toBeUndefined();
    expect(post.record.background).toBe(true);
    expect(inputOf(post)).toEqual({
      letter: "post",
      to: recipient.id,
      from: caller.id,
      topic: "room",
      origin,
      intent: INTENT,
      context: CONTEXT,
    });
    await vi.waitFor(async () => {
      expect(await postEntries(recipient)).toHaveLength(1);
    }, WAIT);
  });

  it("thread_post journals the post with its origin key", async () => {
    const { world, caller, recipient, post, origin } = await postOnce();

    expect(world.lines).toEqual([
      `post ${String(post.record.id)} ${String(caller.id)}->${String(recipient.id)} origin ${String(origin.conversation)}/${String(origin.entry)}`,
    ]);
  });

  it("the threads section text is pinned", async () => {
    expect(THREADS_SECTION).toBe(DESIGN_SECTION);

    const world = threadWorld();
    const session = await world.open();
    const caller = await createIndexedThread(session.harness, "room");
    const sections = await systemPromptSections(
      { harness: session.harness, root: caller, faux: world.faux },
      caller,
    );
    const threads = sections
      .filter(isRecord)
      .map((section) => section["threads"])
      .filter((text) => text !== undefined);
    expect(threads).toEqual([`<threads>\n${DESIGN_SECTION}\n</threads>`]);
  });

  it("thread_post is sequential and replay unsafe", async () => {
    const world = threadWorld();
    const session = await world.open();
    const caller = await createIndexedThread(session.harness, "room");

    const agent = await caller.agent(context);
    const tool = agent.tools.find((each) => each.name === "thread_post");
    expect(tool?.executionMode).toBe("sequential");
    expect(tool?.replay).toBe("unsafe");
    expect(tool?.description).toBe(
      `Post to another conversation by id; it starts or queues a turn there. Reply to a post by posting to its from. At most ${String(FAMILY_CAP)} active posts per activity and ${String(GLOBAL_CAP)} in all; crossing a cap stops the activity. Returns the post id.`,
    );
  });
});

// Each case below is a negative control for PHASE-05 EX-2 and VT-2: the admission refuses,
// so one caller turn creates no post task and journals no `post` line (`expectRefusal`
// asserts both), and the model reads the design's exact refusal text.
describe("thread_post refuses a missing, unindexed or own target (PHASE-05 EX-2, VT-2)", () => {
  it("thread_post refuses a missing, unindexed or own target: a conversation nobody has", async () => {
    const base = await callerThread();

    await expectRefusal(base, 9999, "no conversation 9999");
  });

  it("thread_post refuses a target that is the caller itself", async () => {
    const base = await callerThread();

    await expectRefusal(base, base.caller.id, "a conversation cannot post to itself");
  });

  it("thread_post refuses a task's conversation, which no topic indexes", async () => {
    const base = await callerThread();
    // Task-owned, so never in the index (DEC-012); the stub task is the caller's.
    const target = await createTaskOwned({
      harness: base.session.harness,
      root: base.caller,
      faux: base.world.faux,
    });

    await expectRefusal(
      base,
      target,
      `conversation ${String(target)} is not in a topic (a task's conversation)`,
    );
  });

  it("thread_post refuses a mail topic's conversation, outside the caller's talk set", async () => {
    const base = await callerThread();
    await writeTopicRecord(base.session.harness, "inbox", { toolset: "mail" });
    const inbox = await createIndexedThread(base.session.harness, "inbox", []);

    await expectRefusal(
      base,
      inbox.id,
      `conversation ${String(inbox.id)} (toolset mail) is outside this conversation's talk set (interactive)`,
    );
  });

  it("thread_post refuses a target that is not a conversation id", async () => {
    const base = await callerThread();

    await expectRefusal(base, 1.5, "no conversation 1.5");
  });
});

// VT-3: the catalogue's room-only rule reaches the built extensions, not just the name list.
describe("threads is the room's extension (VT-3)", () => {
  const partsOf = (profile: "room" | "host"): ReturnType<typeof daemonExtensions> =>
    daemonExtensions({
      personaFiles: () => [],
      projectContext: undefined,
      skills: [],
      profile,
      tasks: tasksExtension(wakeBinding().deps),
      threads: threadsExtension(threadBinding().deps),
      ...(profile === "room"
        ? { mail: mailExtension({ source: fakeMailSource(), now: () => 0 }) }
        : {}),
    });

  it("thread tools are not installed on host", async () => {
    // The room's registry builds it, so the host's absence below says something.
    expect(partsOf("room").map(({ name }) => name)).toContain("threads");
    expect(partsOf("host").map(({ name }) => name)).not.toContain("threads");

    const { tools } = await interactiveSnapshot(partsOf("host"));
    expect(tools.filter((name) => name.startsWith("thread_"))).toEqual([]);
  });
});
