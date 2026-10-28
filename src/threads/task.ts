// satan.post v1 (SL-006 design § The satan.post task and its notices, § One phase:
// deliver): one task definition for posts and the two notices. A post delivers
// through wake's submission idiom without a bound, and answers its sender when it
// fails; a notice that fails journals and notifies, and never sends another notice.
// A post checks its origin's tombstone before it submits and again when its input
// fails, so a reap is enforced wherever the task runs; notices skip both checks.

import type { Context } from "@earendil-works/chord/context";
import {
  type BlockedReason,
  type ConversationId,
  defineTask,
  type JsonObject,
  type NextTaskState,
  type RunningTask,
  type SettledSubmissionRecord,
  type SubmissionRecord,
  type Task,
  type TaskId,
  type TaskInspection,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { isRecord } from "../json.ts";
import { notifyBestEffort, reasonOf, scheduledKey } from "../task-support.ts";
import type { SweptKind } from "../task-sweep.ts";
import { isOrigin, type Origin, originKey } from "./origin.ts";
import type { ThreadDeps } from "./extension.ts";
import { isReaped, threadsDoc } from "./tombstones.ts";

/** The task kind, and the entry kind its input is placed as. */
export const POST_KIND = "satan.post";

export type PostInput =
  | {
      letter: "post";
      to: ConversationId;
      from: ConversationId;
      /** The sender's topic. */
      topic: string;
      origin: Origin;
      intent: string;
      context?: string;
    }
  | {
      letter: "post-failed";
      to: ConversationId;
      origin: Origin;
      post: number;
      recipient: ConversationId;
      outcome: "withdrawn" | "delivered-incomplete";
      reason: string;
      intent: string;
    }
  | { letter: "family-reaped"; to: ConversationId; origin: Origin; reason: string };

export interface PostState {
  phase: "deliver";
}

/** Whether `value` reads as a post's input: every letter carries a recipient and an origin. */
export const isPostInput = (value: unknown): value is PostInput => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["to"] === "number" &&
    isOrigin(value["origin"]) &&
    (value["letter"] === "post" ||
      value["letter"] === "post-failed" ||
      value["letter"] === "family-reaped")
  );
};

export interface PostResult {
  outcome: "delivered" | "withdrawn" | "delivered-incomplete" | "reaped";
}

/**
 * The request id of task `taskId`'s input. It ends in `:`, unlike the design's
 * `post:<id>`: the shared sweep matches request ids by this prefix, and `post:44:`
 * must not reach post 440's queued input.
 */
export const postRequestId = (taskId: number): string => `post:${String(taskId)}:`;

/** Creates a post as its tools do: owned by its recipient, in the background. */
export const createPostTask = (
  tx: Tx,
  task: Task<PostInput, PostState, PostResult, object>,
  input: PostInput,
): Promise<TaskId<PostResult>> =>
  tx.createTask(task, input, {
    ownership: { kind: "conversation" },
    conversationId: input.to,
    background: true,
  });

/** The input text the model reads (design § Envelopes the model reads). */
const contentOf = (input: PostInput): string => {
  switch (input.letter) {
    case "post":
      return [
        `<post from="${String(input.from)}" topic="${input.topic}">`,
        `<intent>${input.intent}</intent>`,
        ...(input.context === undefined ? [] : [`<context>${input.context}</context>`]),
        "</post>",
      ].join("");
    case "post-failed":
      return [
        `<post-failed post="${String(input.post)}" to="${String(input.recipient)}" outcome="${input.outcome}" reason="${input.reason}">`,
        `<intent>${input.intent}</intent>`,
        "</post-failed>",
      ].join("");
    case "family-reaped":
      return `<family-reaped origin="${originKey(input.origin)}" reason="${input.reason}"/>`;
  }
};

/** An origin as JSON, for an entry's data. */
const originData = (origin: Origin): JsonObject => ({
  conversation: origin.conversation,
  entry: origin.entry,
  kind: origin.kind,
  ...(origin.episodeClass === undefined ? {} : { episodeClass: origin.episodeClass }),
});

/** The entry the input is placed as: its data is the input plus `taskId` (design § Input, entry and result). */
const entryOf = (taskId: TaskId<PostResult>, input: PostInput): JsonObject => ({
  ...input,
  origin: originData(input.origin),
  taskId,
});

type Runtime = TaskRuntime<PostInput, PostState, PostResult, object>;
type Post = RunningTask<PostInput, PostState, PostResult>;

/** How a post's input ended: delivered, withdrawn (never placed), or placed but unanswered. */
type Ending =
  | { kind: "delivered" }
  | { kind: "withdrawn"; reason: string }
  | { kind: "delivered-incomplete"; reason: string };

type Failure = Exclude<Ending, { kind: "delivered" }>;

/** What a settled record means (DEC-045): done is delivered; else its entry decides. */
const endingOf = (record: SettledSubmissionRecord): Ending => {
  if (record.status === "done") {
    return { kind: "delivered" };
  }
  const reason = `unanswered (${record.reason})`;
  return record.type === "input" && record.entry !== undefined
    ? { kind: "delivered-incomplete", reason }
    : { kind: "withdrawn", reason };
};

/** Open the recipient, submit the input once, and wait for its turn, unbounded. */
const placed = async (runtime: Runtime, input: PostInput, ctx: Context): Promise<Ending> => {
  try {
    const target = await runtime.conversation(input.to, ctx);
    if (target === undefined) {
      return { kind: "withdrawn", reason: "target unreachable" };
    }
    const submission = await target.submit(
      {
        type: "input",
        whenBusy: "followUp",
        requestId: postRequestId(runtime.taskId),
        entry: { kind: POST_KIND, data: entryOf(runtime.taskId, input) },
        content: contentOf(input),
      },
      ctx,
    );
    return endingOf(await submission.wait(ctx));
  } catch (error) {
    return { kind: "withdrawn", reason: reasonOf(runtime, error) };
  }
};

/** The notice a failed post sends its sender (DEC-035, DEC-045). */
const noticeOf = (
  taskId: TaskId<PostResult>,
  input: Extract<PostInput, { letter: "post" }>,
  failure: Failure,
): PostInput => ({
  letter: "post-failed",
  to: input.from,
  origin: input.origin,
  post: taskId,
  recipient: input.to,
  outcome: failure.kind,
  reason: failure.reason,
  intent: input.intent,
});

/** One journal line about a failed post or notice (design § Journal). */
const failureLine = (taskId: TaskId<PostResult>, input: PostInput, failure: Failure): string =>
  input.letter === "post"
    ? `post ${String(taskId)} failed ${failure.kind}: ${failure.reason} origin ${originKey(input.origin)}`
    : `notice ${String(taskId)} to ${String(input.to)} failed: ${failure.reason} origin ${originKey(input.origin)}`;

/** How a phase settles a failure: a phase's task completes, the abort handler's is aborted. */
type Settle = (outcome: PostResult["outcome"]) => NextTaskState<PostState, PostResult>;

const completed: Settle = (outcome) => ({
  status: "terminal",
  outcome: { status: "completed", result: { outcome } },
});

const abortedState: Settle = (outcome) => ({
  status: "terminal",
  outcome: { status: "aborted", result: { outcome } },
});

/**
 * A post's failure builds its notice in the commit that settles it, then journals; a
 * notice journals its own failure and notifies, best effort, and creates nothing. The
 * journal follows the commit so a crash before it re-runs the phase without a second line.
 */
const failed = async (
  deps: ThreadDeps,
  task: Task<PostInput, PostState, PostResult, object>,
  running: Post,
  runtime: Runtime,
  ctx: Context,
  failure: Failure,
  settle: Settle,
): Promise<void> => {
  const input = running.input;
  const line = failureLine(runtime.taskId, input, failure);
  if (input.letter === "post") {
    await runtime.commit(async (tx) => {
      await createPostTask(tx, task, noticeOf(runtime.taskId, input, failure));
      return settle(failure.kind);
    }, ctx);
    deps.log(line);
    return;
  }
  await runtime.commit(() => settle(failure.kind), ctx);
  deps.log(line);
  await notifyBestEffort(deps.satan, scheduledKey(input.to), "SATAN thread notice failed", line);
};

/** Whether `origin` is reaped, read in one commit: deliver's step 1 and its step-5 re-check. */
const reaped = async (runtime: Runtime, origin: Origin, ctx: Context): Promise<boolean> => {
  let tombstoned = false;
  await runtime.commit(async (tx) => {
    tombstoned = isReaped(await threadsDoc(tx), origin);
    return undefined;
  }, ctx);
  return tombstoned;
};

/** The deliver phase: open the recipient, submit, wait, and settle or answer the sender. */
const deliver = async (
  deps: ThreadDeps,
  task: Task<PostInput, PostState, PostResult, object>,
  running: Post,
  runtime: Runtime,
  ctx: Context,
): Promise<void> => {
  const input = running.input;
  if (input.letter === "post" && (await reaped(runtime, input.origin, ctx))) {
    // Withdraw this task's own input if a re-run finds it queued: one input by its id,
    // never the conversation. A check commits nothing, so a crash before the submit
    // re-runs it from the same durable state.
    const submission = await admitted(runtime, input, ctx);
    if (submission?.status === "queued") {
      await deps.harness.abortSubmission(submission.id, ctx, input.to);
    }
    await runtime.commit(() => completed("reaped"), ctx);
    return;
  }
  const ending = await placed(runtime, input, ctx);
  if (ending.kind === "delivered") {
    await runtime.commit(() => completed("delivered"), ctx);
    return;
  }
  if (input.letter === "post" && (await reaped(runtime, input.origin, ctx))) {
    await runtime.commit(() => completed("reaped"), ctx);
    return;
  }
  await failed(deps, task, running, runtime, ctx, ending, completed);
};

/** The abort handler: withdraw the input if still queued, settle `aborted`, and answer the sender as a phase would. */
const aborted = async (
  deps: ThreadDeps,
  task: Task<PostInput, PostState, PostResult, object>,
  running: Post,
  runtime: Runtime,
  ctx: Context,
): Promise<void> => {
  const ending = await abortEnding(deps, runtime, running.input, ctx);
  if (ending.kind === "delivered") {
    await runtime.commit(() => abortedState("delivered"), ctx);
    return;
  }
  await failed(deps, task, running, runtime, ctx, ending, abortedState);
};

/** The task's input as a submission, read in a commit: the abort handler's one lookup. */
const admitted = async (
  runtime: Runtime,
  input: PostInput,
  ctx: Context,
): Promise<SubmissionRecord | undefined> => {
  let found: SubmissionRecord | undefined;
  await runtime.commit(async (tx) => {
    found = await tx.submissionByRequest(input.to, postRequestId(runtime.taskId));
    return undefined;
  }, ctx);
  return found;
};

/** A record the abort found settled: step 5 decides, whatever the lookup caught mid-flight. */
const settledEnding = (record: SubmissionRecord): Ending =>
  record.status === "done" || record.status === "unanswered"
    ? endingOf(record)
    : { kind: "withdrawn", reason: "not admitted" };

/**
 * Withdraw the task's input if still queued, and map `abortSubmission`'s answer (EX-4):
 * `aborted`/`not_found` withdrew it, `already_placed` was placed, `settled` reads the record.
 */
const abortEnding = async (
  deps: ThreadDeps,
  runtime: Runtime,
  input: PostInput,
  ctx: Context,
): Promise<Ending> => {
  const submission = await admitted(runtime, input, ctx);
  if (submission === undefined) {
    return { kind: "withdrawn", reason: "not admitted" };
  }
  switch (await deps.harness.abortSubmission(submission.id, ctx, input.to)) {
    case "not_found":
      return { kind: "withdrawn", reason: "not admitted" };
    case "aborted":
      return { kind: "withdrawn", reason: "aborted" };
    case "already_placed":
      return { kind: "delivered-incomplete", reason: "aborted while placed" };
    case "settled": {
      const settled = (await admitted(runtime, input, ctx)) ?? submission;
      return settledEnding(settled);
    }
  }
};

/** satan.post v1 over the late-bound `deps`, read at every phase entry. */
export const postTask = (
  deps: () => ThreadDeps,
): Task<PostInput, PostState, PostResult, object> => {
  const task: Task<PostInput, PostState, PostResult, object> = defineTask<
    PostInput,
    PostState,
    PostResult
  >({
    name: POST_KIND,
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: (running, runtime, ctx) => deliver(deps(), task, running, runtime, ctx),
    },
    abort: (running, runtime, ctx) => aborted(deps(), task, running, runtime, ctx),
  });
  return task;
};

/** A blocked post's or notice's failure line: the sweep names no outcome. */
const blockedLine = (taskId: number, input: PostInput, reason: BlockedReason): string =>
  input.letter === "post"
    ? `post ${String(taskId)} failed: blocked (${reason}) origin ${originKey(input.origin)}`
    : `notice ${String(taskId)} to ${String(input.to)} failed: blocked (${reason}) origin ${originKey(input.origin)}`;

/** A blocked task's report: a journal line and a best-effort notification; no notice is created. */
const reportBlocked = async (
  deps: ThreadDeps,
  task: TaskInspection,
  reason: BlockedReason,
): Promise<void> => {
  const { id, input } = task.record;
  if (!isPostInput(input)) {
    return;
  }
  const line = blockedLine(id, input, reason);
  deps.log(line);
  const title = input.letter === "post" ? "SATAN post blocked" : "SATAN thread notice failed";
  await notifyBestEffort(deps.satan, scheduledKey(input.to), title, line);
};

/** The satan.post row of the start sweep: its own request namespace, and its report. */
export const postSweptKind = (deps: ThreadDeps): SweptKind => ({
  kind: POST_KIND,
  noun: "post",
  requestPrefix: postRequestId,
  report: (task, reason) => reportBlocked(deps, task, reason),
});
