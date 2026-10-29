// The thread_post tool (SL-006 PHASE-05 run B1; EX-1, EX-2, EX-5, EX-6, VT-4, VT-6):
// one call creates a post task owned by its recipient and answers its id, journals
// the post with its origin, and is offered sequential and replay-unsafe beside the
// pinned `threads` section its prompt carries.

import type { ToolResultMessage } from "@earendil-works/pi-ai";
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
import { parseModel } from "../src/models.ts";
import { tasksExtension, wakeBinding } from "../src/wake/extension.ts";
import { bookmarksPart } from "./bookmarks/bookmark-fixtures.ts";
import { createTaskOwned, systemPromptSections, textOf } from "./harness-fixture.ts";
import { interactiveSnapshot } from "./interactive-baseline.ts";
import { fakeMailDeps } from "./mail/mail-fixtures.ts";
import {
  answeredChild,
  attemptCall,
  type CallerThread,
  callerThread,
  CONTEXT,
  conversationCount,
  conversationOf,
  createIndexedThread,
  envelopeOf,
  indexEntryOf,
  inputOf,
  INTENT,
  only,
  postEntries,
  postTasks,
  type ThreadSession,
  type ThreadWorld,
  threadWorld,
  SECOND_REF,
} from "./thread-fixture.ts";
import { entriesOf, userText, WAIT } from "./wake-fixture.ts";

/** The design's section text, one line per paragraph: what `THREADS_SECTION` must be. */
const DESIGN_SECTION = [
  "A <post> comes from another of your own conversations, a peer thread, not from the operator. Its from is the conversation that sent it; reply with thread_post to that id. A fork's thread_fork result names the conversation it was forked from; its purpose arrives as its first post. A thread answers you only by posting to you: what it says in its own turn stays in its own transcript. When you want an answer, ask for a reply with thread_post, and do not forbid it tools.",
  'A <post-failed> says a post of yours failed, and why. outcome="withdrawn": the recipient never read it. outcome="delivered-incomplete": the recipient read it but its turn did not complete; it may have acted on it.',
  "A <family-reaped> says an activity was stopped for fan-out: too many posts at once from one starting input. Its posts not yet read are withdrawn, and posts and thread starts from that activity are refused.",
].join("\n\n");

/** A ref no world's catalog holds: the stale stored model a redeploy leaves behind. */
const STALE_REF = "gateway/withdrawn";

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

/** One scripted caller turn that calls thread_post on `to`. */
const attemptPost = (base: CallerThread, to: number): Promise<ToolResultMessage> =>
  attemptCall(base, "thread_post", { to, intent: INTENT, context: CONTEXT });

/** One scripted caller turn that calls thread_start in `topic`. */
const attemptStart = (base: CallerThread, topic?: string): Promise<ToolResultMessage> =>
  attemptCall(base, "thread_start", {
    intent: INTENT,
    context: CONTEXT,
    ...(topic === undefined ? {} : { topic }),
  });

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

// PHASE-07c EX-2: thread_start creates the child in one commit — the conversation, its
// toolset and cwd, and its first post — so a refusal leaves nothing behind.
describe("thread_start (PHASE-07c EX-2, VT-5, VT-6)", () => {
  const DESCRIPTION =
    "Start a new conversation in a topic (default: this one's) and send it a first post. " +
    "intent: why it exists, about a sentence; context: optional material. " +
    "Refused for an unknown topic, outside this conversation's talk set, or over the post caps. " +
    "It answers only by thread_post to you; ask for that if you want a reply. " +
    "Returns its id and topic.";

  it("thread_start creates a conversation in the named topic whose first turn is the post", async () => {
    const base = await callerThread();
    const { world, session, caller } = base;
    await writeTopicRecord(session.harness, "research", {});
    const tool = (await caller.agent(context)).tools.find(({ name }) => name === "thread_start");
    expect(tool?.executionMode).toBe("sequential");
    expect(tool?.replay).toBe("unsafe");
    expect(tool?.description).toBe(DESCRIPTION);

    const result = await attemptStart(base, "research");

    expect(result.isError).toBe(false);
    const child = await conversationOf(session.harness, answeredChild(result));
    expect(JSON.parse(textOf(result))).toEqual({ conversation: child.id, topic: "research" });
    expect(await indexEntryOf(session, child.id)).toEqual({
      topic: "research",
      toolset: "interactive",
      startedBy: caller.id,
    });
    await vi.waitFor(async () => {
      expect(await postEntries(child)).toHaveLength(1);
    }, WAIT);
    // The child's first turn reads the post its starter sent, and nothing else.
    const { messages } = await child.context(context);
    expect(messages.map(userText).filter((text) => text !== "")).toEqual([
      envelopeOf(caller.id, "room"),
    ]);
    const input = only((await entriesOf(caller)).filter((entry) => UserEntry.is(entry)));
    expect(world.lines).toEqual([
      `thread start ${String(child.id)} (research) by ${String(caller.id)} origin ${String(caller.id)}/${String(input.id)}`,
    ]);
  });

  it("thread_start takes the topic's toolset and cwd, else the defaults, and records startedBy", async () => {
    const base = await callerThread();
    const { session, caller, world } = base;
    // A defaults cwd that is not the caller's (process.cwd()): a start copying the caller's
    // cwd would no longer pass the `plain` assertion below.
    world.threads.defaults = { ...world.threads.defaults, cwd: "/daemon-default" };
    expect((await caller.agent(context)).cwd).not.toBe(world.threads.defaults.cwd);
    await writeTopicRecord(session.harness, "research", { cwd: "/tmp/research" });
    await writeTopicRecord(session.harness, "plain", {});

    const inResearch = await conversationOf(
      session.harness,
      answeredChild(await attemptStart(base, "research")),
    );
    const inPlain = await conversationOf(
      session.harness,
      answeredChild(await attemptStart(base, "plain")),
    );

    // Room's talk set holds one toolset, so a topic takes that or the profile default;
    // a topic with no cwd takes the daemon's (D1, EX-2).
    for (const [child, topic] of [
      [inResearch, "research"],
      [inPlain, "plain"],
    ] as const) {
      expect(await indexEntryOf(session, child.id)).toEqual({
        topic,
        toolset: "interactive",
        startedBy: caller.id,
      });
    }
    expect((await inResearch.agent(context)).cwd).toBe("/tmp/research");
    expect((await inPlain.agent(context)).cwd).toBe(world.threads.defaults.cwd);
  });

  it("thread_start refuses an unknown topic and a topic outside the talk set", async () => {
    const base = await callerThread();
    const { world, session } = base;
    await writeTopicRecord(session.harness, "inbox", { toolset: "mail" });
    const before = await conversationCount(session.harness);

    const unknown = await attemptStart(base, "nope");
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toBe("unknown topic: nope");

    const outside = await attemptStart(base, "inbox");
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toBe(
      "topic inbox (toolset mail) is outside this conversation's talk set (interactive)",
    );

    // The negative control: no child, no post task, no journal line.
    expect(await conversationCount(session.harness)).toBe(before);
    expect(await postTasks(session.harness)).toEqual([]);
    expect(world.lines.filter((line) => line.startsWith("thread start"))).toEqual([]);
  });

  // SL-010 PHASE-03 VT-3: the topic's model reaches the started child, else the defaults'.
  it("thread_start gives the child the topic's model (VT-3)", async () => {
    const base = await callerThread();
    const { session } = base;
    await writeTopicRecord(session.harness, "research", { model: SECOND_REF });
    const child = await conversationOf(
      session.harness,
      answeredChild(await attemptStart(base, "research")),
    );
    expect((await child.agent(context)).model).toEqual(parseModel(SECOND_REF));
  });

  it("thread_start with an unknown model on the topic is a refusal that creates nothing (VT-3)", async () => {
    const base = await callerThread();
    const { world, session } = base;
    // A stored model no redeploy's catalog serves: the creating commit is refused (DEC-083).
    await writeTopicRecord(session.harness, "stale", { model: STALE_REF });
    const before = await conversationCount(session.harness);

    const result = await attemptStart(base, "stale");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`unknown model ${STALE_REF}`);
    expect(await conversationCount(session.harness)).toBe(before);
    expect(await postTasks(session.harness)).toEqual([]);
    expect(world.lines.filter((line) => line.startsWith("thread start"))).toEqual([]);
  });
});

// VT-7: one start and one fork journal the child and the origin key, so one activity's
// journal can be grepped end to end.
describe("thread start and fork (PHASE-07 VT-7)", () => {
  it("thread start and fork journal the child and origin key", async () => {
    const base = await callerThread();
    const { world, session, caller } = base;
    await writeTopicRecord(session.harness, "research", {});

    const started = await attemptStart(base, "research");
    const forked = await attemptCall(base, "thread_fork", { intent: INTENT });
    const child = answeredChild(started);
    const fork = answeredChild(forked);
    // Two turns, each with its own input entry as the origin it carries.
    const inputs = (await entriesOf(caller)).filter((entry) => UserEntry.is(entry));
    const originOf = (at: number): string => `${String(caller.id)}/${String(inputs[at]?.id)}`;

    expect(world.lines).toEqual([
      `thread start ${String(child)} (research) by ${String(caller.id)} origin ${originOf(0)}`,
      `thread fork ${String(fork)} of ${String(caller.id)} (room) origin ${originOf(1)}`,
    ]);
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
      bookmarks: bookmarksPart(),
      ...(profile === "room" ? { mail: mailExtension(fakeMailDeps()) } : {}),
    });

  it("thread tools are not installed on host", async () => {
    // The room's registry builds it, so the host's absence below says something.
    expect(partsOf("room").map(({ name }) => name)).toContain("threads");
    expect(partsOf("host").map(({ name }) => name)).not.toContain("threads");

    const { tools } = await interactiveSnapshot(partsOf("host"));
    expect(tools.filter((name) => name.startsWith("thread_"))).toEqual([]);
  });
});
