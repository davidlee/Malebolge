// The thread_post tool (SL-006 design § The thread tools): one call admits the target,
// counts the caller's and the daemon's live posts, and — under both caps — creates the
// post's satan.post task in one commit, so a crash before it leaves nothing. A call that
// crosses a cap reaps a family instead (§ The reap, in order): its own, refused, or the
// largest other, admitted. It is sequential (DEC-041) so a round's earlier thread call's
// task is counted by the next, and replay `unsafe`: pi-durable never reruns an
// interrupted call (DEC-043).

import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  defineTool,
  type Task,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { isConversationKey } from "../conversations.ts";
import { answer, refusal } from "../tool-results.ts";
import { admitPost, FAMILY_CAP, GLOBAL_CAP, type PostAdmission, Refusal } from "./admission.ts";
import { familiesOf, type Verdict, verdict } from "./caps.ts";
import { afterReap, reapIn } from "./reap.ts";
import { type Origin, originKey } from "./origin.ts";
import type { ThreadDeps } from "./extension.ts";
import { createPostTask, type PostInput, type PostResult, type PostState } from "./task.ts";
import { reapedRefusal } from "./tombstones.ts";

type PostTask = Task<PostInput, PostState, PostResult, object>;

/** What one call's creating commit returns: the post, the origin it carries, and whether it reaped another family. */
interface Created {
  post: TaskId<PostResult>;
  origin: Origin;
  reapedOther: boolean;
}

/** What a `reap-other` verdict hands the creating commit: the family to reap, and why. */
interface ToReap {
  origin: Origin;
  reason: string;
}

/**
 * What one call shares: the tool's bindings and the conversation whose origin it acts on.
 * thread_start and thread_fork bundle their own creating commit over the same value.
 */
interface Call {
  api: ToolExecutionApi;
  ctx: Context;
  deps: ThreadDeps;
  task: PostTask;
  caller: ConversationId;
}

/** One admitted call's shared steps: the admission's reads, and the verdict its count yields. */
interface Claimed {
  admitted: PostAdmission;
  outcome: Verdict;
}

const postParameters = Type.Object({
  to: Type.Number({ description: "The conversation to post to" }),
  intent: Type.String({ description: "Why you post, about a sentence" }),
  context: Type.Optional(
    Type.String({ description: "Optional material that helps the recipient" }),
  ),
});

/** The post a call asks for, once its target is known to be a conversation id. */
interface PostArgs {
  to: ConversationId;
  intent: string;
  context?: string;
}

/**
 * The creating commit of an `admit` or `reap-other` call (design § The thread tools,
 * shared steps step 5): admission again, which re-reads the tombstone before any table
 * write and refuses if the origin was reaped meanwhile; then, for `reap-other`, the
 * reap's writes in this same commit, so a call whose creation fails reaps nobody; then
 * the post itself.
 */
function createAdmitted(call: Call, args: PostArgs, other: ToReap | undefined): Promise<Created> {
  const { api, ctx, deps, task, caller } = call;
  return api.commit(async (tx) => {
    const admitted = await admitPost(tx, deps.profile, caller, args.to);
    const reapedOther =
      other !== undefined && (await reapIn(tx, task, other.origin, other.reason, deps.now()));
    const post = await createPostTask(tx, task, {
      letter: "post",
      to: args.to,
      from: caller,
      topic: admitted.topic,
      origin: admitted.origin,
      intent: args.intent,
      ...(args.context === undefined ? {} : { context: args.context }),
    });
    return { post, origin: admitted.origin, reapedOther };
  }, ctx);
}

/**
 * The `reap-own` branch (design § The thread tools, shared steps step 4): the reap's
 * writes alone, in one commit, then the withdrawals and the notice, and a refusal. When
 * the commit wrote nothing another conversation reaped the family first: the refusal
 * says only that the origin is reaped.
 */
async function reapOwn(call: Call, origin: Origin, reason: string): Promise<ToolExecutionResult> {
  const { api, ctx, deps, task } = call;
  const reaped = await api.commit((tx) => reapIn(tx, task, origin, reason, deps.now()), ctx);
  if (!reaped) {
    return refusal(reapedRefusal(origin));
  }
  await afterReap(deps, origin, reason, ctx);
  return refusal(reapedRefusal(origin, reason));
}

/**
 * The `admit` and `reap-other` path: one creating commit, then the post's journal line,
 * then — for a `reap-other` that reaped — the other family's withdrawals and notice.
 */
async function postInto(
  call: Call,
  post: PostArgs,
  other: ToReap | undefined,
): Promise<ToolExecutionResult> {
  const { ctx, deps } = call;
  const created = await createAdmitted(call, post, other);
  deps.log(
    `post ${String(created.post)} ${String(call.caller)}->${String(post.to)} origin ${originKey(created.origin)}`,
  );
  if (other !== undefined && created.reapedOther) {
    await afterReap(deps, other.origin, other.reason, ctx);
  }
  return answer({ post: created.post, to: post.to });
}

/**
 * The shared steps of any thread call (design § The thread tools, shared steps 1-4):
 * admission in one commit, then the count the verdict reads. Not thread_post-specific.
 */
async function decided(call: Call, to: ConversationId): Promise<Claimed> {
  const { api, ctx, deps, caller } = call;
  const admitted = await api.commit((tx) => admitPost(tx, deps.profile, caller, to), ctx);
  const { tasks } = await deps.harness.inspect(ctx);
  const families = familiesOf(tasks, (key) => admitted.reaped.has(key));
  return { admitted, outcome: verdict(families, admitted.origin) };
}

/**
 * The branch a verdict sends an admitted call down (shared step 4's outcome, step 5's
 * writes): `reap-own` commits the reap alone and refuses; every other verdict runs the
 * call's own creating commit, carrying the other family's reap when the verdict named
 * one. thread_start and thread_fork bring their own `create` through the same branch.
 */
async function branched(
  call: Call,
  admitted: PostAdmission,
  outcome: Verdict,
  create: (other: ToReap | undefined) => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  if (outcome.kind === "reap-own") {
    return reapOwn(call, admitted.origin, outcome.reason);
  }
  return create(
    outcome.kind === "reap-other"
      ? { origin: outcome.family.origin, reason: outcome.reason }
      : undefined,
  );
}

/** One thread_post call: the shared steps, then the post's creating commit. */
async function attemptPost(call: Call, post: PostArgs): Promise<ToolExecutionResult> {
  const { admitted, outcome } = await decided(call, post.to);
  return branched(call, admitted, outcome, (other) => postInto(call, post, other));
}

export const threadPost = (
  deps: () => ThreadDeps,
  task: PostTask,
): ToolRegistration<typeof postParameters> =>
  defineTool({
    name: "thread_post",
    description:
      "Post to another conversation by id; it starts or queues a turn there. " +
      "Reply to a post by posting to its from. " +
      `At most ${String(FAMILY_CAP)} active posts per activity and ${String(GLOBAL_CAP)} in all; ` +
      "crossing a cap stops the activity. Returns the post id.",
    parameters: postParameters,
    executionMode: "sequential",
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const bound = deps();
      if (!isConversationKey(args.to)) {
        return refusal(`no conversation ${String(args.to)}`);
      }
      const post: PostArgs = {
        to: args.to,
        intent: args.intent,
        ...(args.context === undefined ? {} : { context: args.context }),
      };
      const call: Call = { api, ctx, deps: bound, task, caller: api.conversationId };
      try {
        return await attemptPost(call, post);
      } catch (error) {
        if (error instanceof Refusal) {
          return refusal(error.message);
        }
        throw error;
      }
    },
  });
