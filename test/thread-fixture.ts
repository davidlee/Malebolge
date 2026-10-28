// The satan.post task's test world (SL-006 PHASE-04): a harness over a store that
// outlives a close, a room session with the threads extension bound in two steps,
// a recipient with one probe tool, and a post created in a commit. The
// re-openable store, scripted turns and entry readers are wake-fixture's.

import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type ConversationId,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Extension,
  type Harness,
  type SubmissionRecord,
  type Task,
  type TaskId,
  type TaskInspection,
  type TaskOutcome,
} from "@earendil-works/pi-durable";
import { expect, vi } from "vitest";
import { context } from "../src/context.ts";
import { isRecord, type JsonRecord } from "../src/json.ts";
import { registryOf } from "../src/registry.ts";
import type { Log, SatanTools } from "../src/satan-tools.ts";
import { openSession } from "../src/session.ts";
import { type ThreadDeps, threadsExtension } from "../src/threads/extension.ts";
import {
  createPostTask,
  POST_KIND,
  type PostInput,
  type PostResult,
  type PostState,
  postRequestId,
  postTask,
} from "../src/threads/task.ts";
import { closing, FAUX_MODEL, nodeEnv } from "./harness-fixture.ts";
import {
  answer,
  entriesOf,
  heldUntilCutOff,
  only,
  ReopenableMemory,
  type SatanCall,
  TYPING,
  WAIT,
} from "./wake-fixture.ts";

/** A tool that always succeeds: VT-5's run that fails after a tool succeeded. */
export const probeExtension: Extension = defineExtension({
  name: "probe",
  tools: [
    defineTool({
      name: "probe",
      description: "Answers that it probed.",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ output: [{ type: "text", text: "probed" }] }),
    }),
  ],
});

export interface ThreadSession {
  readonly harness: Harness;
  readonly root: Conversation;
}

/** A post under test: the dependencies a test scripts, and one store two sessions share. */
export interface ThreadWorld {
  /** The object every phase entry reads; the session's harness is bound into it. */
  readonly threads: ThreadDeps;
  readonly task: Task<PostInput, PostState, PostResult, object>;
  /** Every satan-mcp call the posts made, in order. */
  readonly calls: SatanCall[];
  /** What the posts logged, in order. */
  readonly lines: string[];
  readonly faux: FauxProviderHandle;
  /**
   * The next session over the world's one store, closed when the test ends. `registered`
   * replaces the satan.post the session's registry installs: a test reopens under a
   * definition too old to run the post its store holds.
   */
  open(registered?: ThreadWorld["task"]): Promise<ThreadSession>;
}

/** Model turns a held run burns, one per session: each reopen re-runs the placed turn held. */
const HELD_TURNS = 12;

/** A world whose store outlives its sessions and whose satan-mcp answers `sent`. */
export function threadWorld(): ThreadWorld {
  const calls: SatanCall[] = [];
  const lines: string[] = [];
  const log: Log = (text): void => {
    lines.push(text);
  };
  const satan: Pick<SatanTools, "call"> = {
    call: (key, tool, args, deadlineMs): Promise<ReturnType<typeof answer>> => {
      calls.push({ key, tool, args, deadlineMs });
      return Promise.resolve(answer(tool, TYPING));
    },
  };
  const threads: ThreadDeps = {
    profile: "room",
    defaults: { model: FAUX_MODEL, cwd: process.cwd() },
    now: () => Date.now(),
    log,
    satan,
    // Bound to each session as it opens.
    harness: {
      inspect: (): Promise<never> => Promise.reject(new Error("no session is open")),
      abortSubmission: (): Promise<never> => Promise.reject(new Error("no session is open")),
    },
  };
  const task = postTask(() => threads);
  const storage = new ReopenableMemory();
  const faux = fauxProvider();
  return {
    threads,
    task,
    calls,
    lines,
    faux,
    open: async (registered?: ThreadWorld["task"]): Promise<ThreadSession> => {
      const models = createModels();
      models.setProvider(faux.provider);
      const session = await openSession(storage, {
        models,
        registry: registryOf([threadsExtension(() => threads, registered ?? task), probeExtension]),
        agent: { model: FAUX_MODEL },
        profile: "room",
        log: () => undefined,
        env: nodeEnv,
        // The daemon's second binding step: the session's harness.
        beforeResume: (opened): void => {
          threads.harness = opened.harness;
        },
      });
      closing(session.harness);
      return session;
    },
  };
}

/** A conversation the posts target: ownerless, the faux model, and the probe tool. */
export const createRecipient = (
  harness: Harness,
  extensions: readonly Extension[] = [probeExtension],
): Promise<Conversation> =>
  harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: FAUX_MODEL, cwd: process.cwd(), extensions: [...extensions] },
    },
    context,
  );

export interface CreatePostOptions {
  /**
   * The task's owning conversation. Defaults to `input.to`; a post whose target is
   * absent (or a hand-written notice) names an existing one instead.
   */
  readonly owner?: ConversationId;
  /** Leave scheduling paused until the test resumes: seed a submission first. */
  readonly resume?: boolean;
}

/**
 * Creates one post task in its own commit, as a tool does: conversation-owned and
 * background. The normal path is `createPostTask`; naming another owner is for the
 * cases whose input target cannot own a task.
 */
export async function createPost(
  session: ThreadSession,
  task: Task<PostInput, PostState, PostResult, object>,
  input: PostInput,
  options: CreatePostOptions = {},
): Promise<TaskId<PostResult>> {
  const id = await session.harness.commit(
    (tx) =>
      options.owner === undefined
        ? createPostTask(tx, task, input)
        : tx.createTask(task, input, {
            ownership: { kind: "conversation" },
            conversationId: options.owner,
            background: true,
          }),
    context,
  );
  if (options.resume ?? true) {
    session.harness.resume();
  }
  return id;
}

/** The entries of `conversation` that a post or notice was placed as. */
export async function postEntries(conversation: Conversation): Promise<EntryRecord[]> {
  return (await entriesOf(conversation)).filter((entry) => entry.kind === POST_KIND);
}

/** Every live task of the post kind. */
export async function postTasks(harness: Harness): Promise<TaskInspection[]> {
  const { tasks } = await harness.inspect(context);
  return tasks.filter((task) => task.record.kind === POST_KIND);
}

/** A live post's input, as its record holds it (pi-durable hands inputs back as JSON). */
export const inputOf = (task: TaskInspection): JsonRecord =>
  isRecord(task.record.input) ? task.record.input : {};

/** The live notice tasks: what a failed post created, and what a failed notice must not. */
export async function noticeTasks(harness: Harness): Promise<TaskInspection[]> {
  return (await postTasks(harness)).filter((task) => inputOf(task)["letter"] === "post-failed");
}

/** The task's outcome, polled: a phase commits its outcome asynchronously. */
export async function waitOutcome<R>(harness: Harness, id: TaskId<R>): Promise<TaskOutcome<R>> {
  await vi.waitFor(async () => {
    const record = await harness.getTask(id, context);
    expect(record?.state.status).toBe("terminal");
  }, WAIT);
  const record = await harness.getTask(id, context);
  if (record?.state.status !== "terminal") {
    throw new Error(`task ${String(id)} is not terminal`);
  }
  return record.state.outcome;
}

/** The result of a post that completed. */
export async function postResult(harness: Harness, id: TaskId<PostResult>): Promise<PostResult> {
  const outcome = await waitOutcome(harness, id);
  if (outcome.status !== "completed") {
    throw new Error(`task ${String(id)} ended ${outcome.status}`);
  }
  return outcome.result;
}

/** A submission of `conversation`, polled until it reaches `status`. */
export async function waitRequest(
  harness: Harness,
  conversationId: ConversationId,
  requestId: string,
  status: SubmissionRecord["status"],
): Promise<SubmissionRecord> {
  await vi.waitFor(async () => {
    const record = await harness.commit(
      (tx) => tx.submissionByRequest(conversationId, requestId),
      context,
    );
    expect(record?.status).toBe(status);
  }, WAIT);
  const record = await harness.commit(
    (tx) => tx.submissionByRequest(conversationId, requestId),
    context,
  );
  if (record === undefined) {
    throw new Error(`no submission ${requestId} in conversation ${String(conversationId)}`);
  }
  return record;
}

/** Waits until post `taskId`'s input is queued in `conversation`. */
export function waitQueuedPost(
  session: ThreadSession,
  taskId: TaskId<PostResult>,
  conversationId: ConversationId,
): Promise<SubmissionRecord> {
  return waitRequest(session.harness, conversationId, postRequestId(taskId), "queued");
}

/** The post task at a lower version than the world's: a registry that cannot run what its store holds. */
export const tooOld = (world: ThreadWorld): ThreadWorld["task"] => ({
  definition: { ...world.task.definition, version: 0 },
});

/**
 * The request id that shares post `postId`'s prefix but not its delimiter: `post:<N>0:`
 * (post 440 for post 44), which `post:<N>:` must not withdraw.
 */
export const neighbourRequestId = (postId: number): string => `post:${String(postId)}0:`;

export interface BlockedPost {
  /** The session over the reopened store: its registry's satan.post is too old. */
  readonly session: ThreadSession;
  /** The conversation the post targets; its held run keeps the post's input queued. */
  readonly recipient: Conversation;
  readonly id: TaskId<PostResult>;
  /** The input `id` was created with: its origin keys the failure line the sweep journals. */
  readonly input: PostInput;
}

/**
 * A real post blocked `task_too_old`: a run held until the process cuts it off, the post's
 * input queued behind it (and `post:<N>0:` behind that), then a close and a reopen under a
 * registry whose satan.post is too old to run what the store holds.
 */
export async function reopenedTooOldPost(world: ThreadWorld): Promise<BlockedPost> {
  const session = await world.open();
  const recipient = await createRecipient(session.harness);
  world.faux.setResponses(Array.from({ length: HELD_TURNS }, () => heldUntilCutOff));
  await recipient.submit(
    { type: "input", content: "foreground", requestId: "foreground" },
    context,
  );
  // The held turn has reached the model: every input below queues behind its run.
  await vi.waitFor(() => {
    expect(world.faux.state.callCount).toBe(1);
  }, WAIT);

  const input: PostInput = {
    letter: "post",
    to: recipient.id,
    from: session.root.id,
    topic: "research",
    origin: { conversation: session.root.id, entry: 1, kind: "human" },
    intent: "Summarise the failing test runs",
    context: "see /tmp/runs.txt",
  };
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

  await session.harness.close(context);
  const reopened = await world.open(tooOld(world));
  return { session: reopened, recipient, id, input };
}

/** The one item of `items`; re-exported so a post test reads like a wake test. */
export { only };

/** Every notification the posts sent, in order. */
export const notifyCalls = (world: ThreadWorld): SatanCall[] =>
  world.calls.filter((call) => call.tool === "notify_send");
