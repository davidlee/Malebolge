// The thread tools (SL-006 design § The thread tools): thread_post sends a post to
// another conversation, thread_start makes one in a topic and sends it a first post,
// and thread_fork forks the caller and sends the fork a first post. One call admits the
// target, counts the caller's and the daemon's live posts, and — under both caps — does
// all its writes in one commit, so a crash before it leaves nothing. A call that crosses
// a cap reaps a family instead (§ The reap, in order): its own, refused, or the largest
// other, admitted. All are sequential (DEC-041) so a round's earlier thread call's task
// is counted by the next, and replay `unsafe`: pi-durable never reruns an interrupted
// call (DEC-043).

import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  configure,
  type ConversationId,
  defineTool,
  type EntryRecord,
  type Task,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { isConversationKey, toolsetInit, topicCwd } from "../conversations.ts";
import { answer, refusal } from "../tool-results.ts";
import {
  admitCaller,
  admitPost,
  admitStart,
  FAMILY_CAP,
  GLOBAL_CAP,
  type PostAdmission,
  Refusal,
  refuseOutsideTalkSet,
} from "./admission.ts";
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
interface Claimed<A extends PostAdmission> {
  admitted: A;
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

/** The `letter: "post"` input a thread call creates: its target and sender, and why it exists. */
function postInput(input: {
  to: ConversationId;
  from: ConversationId;
  topic: string;
  origin: Origin;
  intent: string;
  context?: string;
}): PostInput {
  return {
    letter: "post",
    to: input.to,
    from: input.from,
    topic: input.topic,
    origin: input.origin,
    intent: input.intent,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
}

const startParameters = Type.Object({
  intent: Type.String({ description: "Why it exists, about a sentence" }),
  context: Type.Optional(
    Type.String({ description: "Optional material that helps the recipient" }),
  ),
  topic: Type.Optional(
    Type.String({ description: "The topic to start the conversation in (default: this one's)" }),
  ),
});

const forkParameters = Type.Object({
  intent: Type.String({ description: "Why it exists, about a sentence" }),
  context: Type.Optional(
    Type.String({ description: "Optional material that helps the recipient" }),
  ),
});

/** The first post a fork sends, and why it exists. */
interface ForkArgs {
  intent: string;
  context?: string;
}

/** The thread a start asks for. */
interface StartArgs {
  intent: string;
  context?: string;
  topic?: string;
}

/** What one call that makes a conversation returns: the child, its topic, the origin it carries, and whether it reaped another family. */
interface Born {
  child: ConversationId;
  topic: string;
  origin: Origin;
  reapedOther: boolean;
}

/**
 * The creating commit of a thread_start (design § The thread tools, the thread_start
 * paragraph): reads first, so pi-durable refuses no table read — admission again, which
 * re-reads the tombstone and refuses if the origin was reaped meanwhile, then the reap's
 * writes for `reap-other`, so a start whose creation fails reaps nobody. Then the child:
 * create, configure with the topic's cwd, initialise its toolset as a thread's child, and
 * create its first post's task. The talk-set check runs on the toolset the topic chose
 * inside this commit, so a refusal throws here and the whole commit rolls back.
 */
function createStarted(call: Call, args: StartArgs, other: ToReap | undefined): Promise<Born> {
  const { api, ctx, deps, task, caller } = call;
  return api.commit(async (tx) => {
    const admitted = await admitStart(tx, caller, args.topic);
    const reapedOther =
      other !== undefined && (await reapIn(tx, task, other.origin, other.reason, deps.now()));
    const { id: child } = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const cwd = topicCwd(admitted.index, admitted.childTopic, deps.defaults);
    await configure(tx, child, { ...deps.defaults, cwd });
    await toolsetInit(deps.profile, admitted.childTopic, {
      startedBy: caller,
      require: (chosen) => {
        refuseOutsideTalkSet(
          deps.profile,
          admitted.toolset,
          chosen,
          `topic ${admitted.childTopic}`,
        );
      },
    })(tx, child);
    await createPostTask(
      tx,
      task,
      postInput({
        to: child,
        from: caller,
        topic: admitted.topic,
        origin: admitted.origin,
        intent: args.intent,
        ...(args.context === undefined ? {} : { context: args.context }),
      }),
    );
    return { child, topic: admitted.childTopic, origin: admitted.origin, reapedOther };
  }, ctx);
}

/** The refusal a fork whose assistant message carries a sibling call reads (DEC-031). */
const FORK_ONLY = "thread_fork must be the only tool call in its message";

/**
 * Whether `entry` is the assistant message a fork may fork at: its `model` holds one
 * message, an assistant's, whose content holds exactly one tool call, with id `callId`.
 */
function soleCall(entry: EntryRecord | undefined, callId: string): boolean {
  if (!AssistantEntry.is(entry)) {
    return false;
  }
  const [message] = entry.model ?? [];
  if (message?.role !== "assistant") {
    return false;
  }
  const calls = message.content.filter((block) => block.type === "toolCall");
  return calls.length === 1 && calls[0]?.id === callId;
}

/**
 * The creating commit of a thread_fork (design § The thread tools, the thread_fork
 * paragraph): reads first — the caller's admission again, and the caller's latest entry,
 * which must be this call's assistant message — then, for `reap-other`, the reap's
 * writes, so a fork that fails reaps nobody. Then the fork at that entry, the result
 * written into the child in place of pi-durable's synthetic error (DEC-031), and the
 * child's first post. The index hook copies the caller's topic and toolset.
 */
function createForked(call: Call, args: ForkArgs, other: ToReap | undefined): Promise<Born> {
  const { api, ctx, deps, task, caller } = call;
  return api.commit(async (tx) => {
    const admitted = await admitCaller(tx, caller);
    const [latest] = (await tx.scanEntries({ conversationId: caller, order: "descending" }, 1))
      .items;
    if (latest === undefined || !soleCall(latest, api.callId)) {
      throw new Refusal(FORK_ONLY);
    }
    const reapedOther =
      other !== undefined && (await reapIn(tx, task, other.origin, other.reason, deps.now()));
    const { id: child } = await tx.forkConversation(caller, latest.id, {
      ownership: { kind: "ownerless" },
    });
    await tx.appendEntry(ToolResultEntry, child, {
      model: [
        {
          role: "toolResult",
          toolCallId: api.callId,
          toolName: "thread_fork",
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({ fork_of: caller, purpose: "arrives as your first post" }),
            },
          ],
          timestamp: api.now(),
        },
      ],
      data: { diagnostics: [] },
    });
    await createPostTask(
      tx,
      task,
      postInput({
        to: child,
        from: caller,
        topic: admitted.topic,
        origin: admitted.origin,
        intent: args.intent,
        ...(args.context === undefined ? {} : { context: args.context }),
      }),
    );
    return { child, topic: admitted.topic, origin: admitted.origin, reapedOther };
  }, ctx);
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
    const post = await createPostTask(
      tx,
      task,
      postInput({
        to: args.to,
        from: caller,
        topic: admitted.topic,
        origin: admitted.origin,
        intent: args.intent,
        ...(args.context === undefined ? {} : { context: args.context }),
      }),
    );
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
 * The tail every creating commit's call shares: its journal line, then — for a
 * `reap-other` that reaped — the other family's withdrawals and notice, then the
 * result the model reads.
 */
async function finished(
  call: Call,
  other: ToReap | undefined,
  created: { origin: Origin; reapedOther: boolean },
  line: string,
  result: object,
): Promise<ToolExecutionResult> {
  const { ctx, deps } = call;
  deps.log(line);
  if (other !== undefined && created.reapedOther) {
    await afterReap(deps, other.origin, other.reason, ctx);
  }
  return answer(result);
}

/** The `admit` and `reap-other` path of a thread_post: its creating commit, then its journal line and answer. */
async function postInto(
  call: Call,
  post: PostArgs,
  other: ToReap | undefined,
): Promise<ToolExecutionResult> {
  const created = await createAdmitted(call, post, other);
  return finished(
    call,
    other,
    created,
    `post ${String(created.post)} ${String(call.caller)}->${String(post.to)} origin ${originKey(created.origin)}`,
    { post: created.post, to: post.to },
  );
}

/**
 * The shared steps of any thread call (design § The thread tools, shared steps 1-4):
 * the call's admission in one commit, then the count the verdict reads. Not
 * thread_post-specific: each tool passes the admission it runs.
 */
async function decided<A extends PostAdmission>(
  call: Call,
  admit: (tx: Tx) => Promise<A>,
): Promise<Claimed<A>> {
  const { api, ctx, deps } = call;
  const admitted = await api.commit(admit, ctx);
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
  const { deps, caller } = call;
  const { admitted, outcome } = await decided(call, (tx) =>
    admitPost(tx, deps.profile, caller, post.to),
  );
  return branched(call, admitted, outcome, (other) => postInto(call, post, other));
}

/** The `admit` and `reap-other` path of a thread_start: its creating commit, then its journal line and answer. */
async function startInto(
  call: Call,
  start: StartArgs,
  other: ToReap | undefined,
): Promise<ToolExecutionResult> {
  const created = await createStarted(call, start, other);
  return finished(
    call,
    other,
    created,
    `thread start ${String(created.child)} (${created.topic}) by ${String(call.caller)} origin ${originKey(created.origin)}`,
    { conversation: created.child, topic: created.topic },
  );
}

/** One thread_start call: the shared steps, then the child's creating commit. */
async function attemptStart(call: Call, start: StartArgs): Promise<ToolExecutionResult> {
  const { caller } = call;
  const { admitted, outcome } = await decided(call, (tx) => admitStart(tx, caller, start.topic));
  return branched(call, admitted, outcome, (other) => startInto(call, start, other));
}

/** The `admit` and `reap-other` path of a thread_fork: its creating commit, then its journal line and answer. */
async function forkInto(
  call: Call,
  fork: ForkArgs,
  other: ToReap | undefined,
): Promise<ToolExecutionResult> {
  const created = await createForked(call, fork, other);
  return finished(
    call,
    other,
    created,
    `thread fork ${String(created.child)} of ${String(call.caller)} (${created.topic}) origin ${originKey(created.origin)}`,
    { conversation: created.child, topic: created.topic },
  );
}

/** One thread_fork call: the shared steps, then the fork's creating commit. */
async function attemptFork(call: Call, fork: ForkArgs): Promise<ToolExecutionResult> {
  const { admitted, outcome } = await decided(call, (tx) => admitCaller(tx, call.caller));
  return branched(call, admitted, outcome, (other) => forkInto(call, fork, other));
}

/**
 * One call's refusal mapping: a `Refusal` becomes the `isError` result the model reads,
 * and anything else is a bug that keeps its stack. Shared by every thread tool.
 */
async function attempted(run: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Refusal) {
      return refusal(error.message);
    }
    throw error;
  }
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
      return attempted(() => attemptPost(call, post));
    },
  });

export const threadStart = (
  deps: () => ThreadDeps,
  task: PostTask,
): ToolRegistration<typeof startParameters> =>
  defineTool({
    name: "thread_start",
    description:
      "Start a new conversation in a topic (default: this one's) and send it a first post. " +
      "intent: why it exists, about a sentence; context: optional material. " +
      "Refused for an unknown topic, outside this conversation's talk set, or over the post caps. " +
      "Returns its id and topic.",
    parameters: startParameters,
    executionMode: "sequential",
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const start: StartArgs = {
        intent: args.intent,
        ...(args.context === undefined ? {} : { context: args.context }),
        ...(args.topic === undefined ? {} : { topic: args.topic }),
      };
      const call: Call = { api, ctx, deps: deps(), task, caller: api.conversationId };
      return attempted(() => attemptStart(call, start));
    },
  });

export const threadFork = (
  deps: () => ThreadDeps,
  task: PostTask,
): ToolRegistration<typeof forkParameters> =>
  defineTool({
    name: "thread_fork",
    description:
      "Fork this conversation as it stands, history included, and send the fork a first post. " +
      "intent: why it exists, about a sentence; context: optional material. " +
      "Must be the only tool call in its message. Refused over the post caps. " +
      "Returns the fork's id and topic.",
    parameters: forkParameters,
    callers: ["model"],
    executionMode: "sequential",
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const fork: ForkArgs = {
        intent: args.intent,
        ...(args.context === undefined ? {} : { context: args.context }),
      };
      const call: Call = { api, ctx, deps: deps(), task, caller: api.conversationId };
      return attempted(() => attemptFork(call, fork));
    },
  });
