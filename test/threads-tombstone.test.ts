// Tombstones and their enforcement (SL-006 design § The tombstone record and §
// One phase: deliver; PHASE-06 EX-1, EX-2, EX-3, VT-1, VT-2): a reap's one write,
// the post task's check before it submits and re-check after its input fails, the
// withdrawal of its own queued input only, notices that still arrive, and the
// refusal a turn started by a `family-reaped` notice reads.

import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type ConversationId,
  type Harness,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import { type Origin, originKey } from "../src/threads/origin.ts";
import { type PostInput, postRequestId } from "../src/threads/task.ts";
import { isReaped, tombstone, type ThreadsDoc } from "../src/threads/tombstones.ts";
import { textOf, toolResults } from "./harness-fixture.ts";
import {
  createIndexedThread,
  createPost,
  createRecipient,
  neighbourRequestId,
  noticeTasks,
  postEntries,
  postResult,
  postTasks,
  reapedOrigins,
  threadWorld,
  waitRequest,
  waitQueuedPost,
  writeTombstone,
} from "./thread-fixture.ts";
import { heldTurn, heldUntilCutOff, only, submissionOf, WAIT } from "./wake-fixture.ts";

/** An origin stamped as a caller's first human input: what a post carries. */
const originOf = (from: ConversationId): Origin => ({
  conversation: from,
  entry: 1,
  kind: "human",
});

const postTo = (to: ConversationId, from: ConversationId): PostInput => ({
  letter: "post",
  to,
  from,
  topic: "research",
  origin: originOf(from),
  intent: "Summarise the failing test runs",
});

const REASON = "5 active (cap 4)";

/** Plain model answers: the turns a delivered notice or a released hold runs. */
const plains = (count = 4): ReturnType<typeof fauxAssistantMessage>[] =>
  Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));

/** The held turns a reopened store re-runs before the reap's check settles the post. */
const heldTurns = (): FauxResponseFactory[] => Array.from({ length: 4 }, () => heldUntilCutOff);

/** A held run has reached the model, so every later input queues behind it. */
async function waitHeld(faux: { readonly state: { readonly callCount: number } }): Promise<void> {
  await vi.waitFor(() => {
    expect(faux.state.callCount).toBe(1);
  }, WAIT);
}

/** The submission `requestId` identifies, or `undefined`. */
function ownSubmission(
  harness: Harness,
  recipient: ConversationId,
  postId: number,
): Promise<SubmissionRecord | undefined> {
  return submissionOf(harness, recipient, postRequestId(postId));
}

describe("tombstones and their enforcement (PHASE-06 EX-1, EX-2, EX-3, VT-1, VT-2)", () => {
  it("a post task created before the reap and not yet submitted withdraws itself", async () => {
    const world = threadWorld();
    const session = await world.open();
    const recipient = await createRecipient(session.harness);
    const input = postTo(recipient.id, session.root.id);
    const id = await createPost(session, world.task, input, { resume: false });
    expect(await writeTombstone(session.harness, input.origin, REASON)).toBe(true);
    session.harness.resume();

    expect(await postResult(session.harness, id)).toEqual({ outcome: "reaped" });
    expect(await ownSubmission(session.harness, recipient.id, id)).toBeUndefined();
    expect(await postEntries(recipient)).toEqual([]);
    expect(await noticeTasks(session.harness)).toEqual([]);
    expect(world.lines).toEqual([]);
  });

  it("a post that passed its tombstone check before the reap commit and restarted before its submit re-checks on re-run and settles reaped", async () => {
    const world = threadWorld();
    const session = await world.open();
    const recipient = await createRecipient(session.harness);
    const input = postTo(recipient.id, session.root.id);
    const id = await createPost(session, world.task, input, { resume: false });
    expect(await writeTombstone(session.harness, input.origin, REASON)).toBe(true);
    // A phase's check commits nothing, so a crash between it and the submit leaves
    // the same durable state: the post's creation and the tombstone, nothing else.
    await session.harness.close(context);
    const reopened = await world.open();
    const reopenedRecipient = await reopened.harness.conversation(recipient.id, context);
    if (reopenedRecipient === undefined) {
      throw new Error(`no conversation ${String(recipient.id)} after reopening`);
    }

    expect(await postResult(reopened.harness, id)).toEqual({ outcome: "reaped" });
    expect(await ownSubmission(reopened.harness, recipient.id, id)).toBeUndefined();
    expect(await postEntries(reopenedRecipient)).toEqual([]);
    expect(await noticeTasks(reopened.harness)).toEqual([]);
    expect(world.lines).toEqual([]);
  });

  it("a post whose input is queued when its origin is reaped withdraws only its own input on re-run", async () => {
    const world = threadWorld();
    let session = await world.open();
    const recipient = await createRecipient(session.harness);
    world.faux.setResponses(heldTurns());
    await recipient.submit(
      { type: "input", content: "foreground", requestId: "foreground" },
      context,
    );
    await waitHeld(world.faux);

    const input = postTo(recipient.id, session.root.id);
    const id = await createPost(session, world.task, input);
    await waitQueuedPost(session, id, recipient.id);
    await recipient.submit(
      {
        type: "input",
        content: "neighbour",
        whenBusy: "followUp",
        requestId: neighbourRequestId(id),
      },
      context,
    );
    await waitRequest(session.harness, recipient.id, neighbourRequestId(id), "queued");
    expect(await writeTombstone(session.harness, input.origin, REASON)).toBe(true);
    await session.harness.close(context);
    world.faux.setResponses(heldTurns());
    session = await world.open();

    expect(await postResult(session.harness, id)).toEqual({ outcome: "reaped" });
    const own = await ownSubmission(session.harness, recipient.id, id);
    expect(own?.status).not.toBe("queued");
    expect(own?.reason).toBe("aborted");
    // The neighbour shares the prefix but not the delimiter: it is another input.
    expect(
      (await submissionOf(session.harness, recipient.id, neighbourRequestId(id)))?.status,
    ).toBe("queued");
    expect(await noticeTasks(session.harness)).toEqual([]);
    expect(world.lines).toEqual([]);
  });

  it("a post withdrawn after its origin is reaped settles reaped with no post-failed", async () => {
    const world = threadWorld();
    const session = await world.open();
    const recipient = await createRecipient(session.harness);
    const held = heldTurn();
    world.faux.setResponses([held.step, ...plains()]);
    await recipient.submit(
      { type: "input", content: "foreground", requestId: "foreground" },
      context,
    );
    await held.reached;
    const input = postTo(recipient.id, session.root.id);
    const id = await createPost(session, world.task, input);
    await waitQueuedPost(session, id, recipient.id);

    expect(await writeTombstone(session.harness, input.origin, REASON)).toBe(true);
    const own = await ownSubmission(session.harness, recipient.id, id);
    if (own === undefined) {
      throw new Error(`no queued submission for post ${String(id)}`);
    }
    // The withdrawal a reap would perform: one input, by its id.
    expect(await session.harness.abortSubmission(own.id, context, recipient.id)).toBe("aborted");

    expect(await postResult(session.harness, id)).toEqual({ outcome: "reaped" });
    expect(await noticeTasks(session.harness)).toEqual([]);
    expect(world.lines).toEqual([]);
    held.release();
  });

  it("a notice is delivered though its origin is reaped", async () => {
    const world = threadWorld();
    const session = await world.open();
    const recipient = await createRecipient(session.harness);
    const origin = originOf(session.root.id);
    expect(await writeTombstone(session.harness, origin, REASON)).toBe(true);
    world.faux.setResponses(plains());

    const id = await createPost(session, world.task, {
      letter: "family-reaped",
      to: recipient.id,
      origin,
      reason: REASON,
    });

    expect(await postResult(session.harness, id)).toEqual({ outcome: "delivered" });
    expect(await postEntries(recipient)).toHaveLength(1);
    expect(world.lines).toEqual([]);
  });

  it("a turn started by family-reaped cannot post", async () => {
    const world = threadWorld();
    const session = await world.open();
    const caller = await createIndexedThread(session.harness, "room");
    const recipient = await createIndexedThread(session.harness, "research", []);
    const origin = originOf(session.root.id);
    expect(await writeTombstone(session.harness, origin, REASON)).toBe(true);
    world.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "thread_post",
            { to: recipient.id, intent: "Summarise the failing test runs" },
            { id: "call-1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("refused")]),
    ]);

    const notice = await createPost(session, world.task, {
      letter: "family-reaped",
      to: caller.id,
      origin,
      reason: REASON,
    });
    expect(await postResult(session.harness, notice)).toEqual({ outcome: "delivered" });

    const result = only(await toolResults(session.harness, caller));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `origin ${originKey(origin)} was reaped for fan-out; posts and thread starts from it are refused`,
    );
    expect(await postTasks(session.harness)).toEqual([]);
    expect(world.lines.filter((line) => line.startsWith("post "))).toEqual([]);
  });
});

describe("the tombstone record (PHASE-06 EX-1)", () => {
  it("tombstone writes once and reports whether it was new", async () => {
    const world = threadWorld();
    const session = await world.open();
    const recipient = await createRecipient(session.harness);
    const first = originOf(session.root.id);
    const second = originOf(recipient.id);
    const at = 1_793_260_800_000;

    const doc: ThreadsDoc = { reaped: {} };
    expect(tombstone(doc, first, REASON, at)).toBe(true);
    expect(tombstone(doc, first, "later", at + 1)).toBe(false);
    expect(isReaped(doc, first)).toBe(true);
    expect(isReaped(doc, second)).toBe(false);
    expect(tombstone(doc, second, "6 active (cap 4)", at + 2)).toBe(true);
    expect(doc.reaped).toEqual({
      [originKey(first)]: { at, reason: REASON },
      [originKey(second)]: { at: at + 2, reason: "6 active (cap 4)" },
    });
  });

  it("a written tombstone survives in the session document", async () => {
    const world = threadWorld();
    const session = await world.open();
    const origin = originOf(session.root.id);

    expect(await writeTombstone(session.harness, origin, REASON)).toBe(true);
    expect(await writeTombstone(session.harness, origin, "later")).toBe(false);
    const reaped = await reapedOrigins(session.harness);
    expect(Object.keys(reaped)).toEqual([originKey(origin)]);
    expect(reaped[originKey(origin)]?.reason).toBe(REASON);
    expect(typeof reaped[originKey(origin)]?.at).toBe("number");
  });
});
