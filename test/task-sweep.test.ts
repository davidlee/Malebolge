// EX-2 and VT-4/VT-5 (SL-006 design § Components and boundaries): the start
// sweep is neutral over a per-kind table. Pure: a fake harness and fake kinds,
// no session, so every call and journal line is asserted in the order made.

import type {
  BlockedReason,
  ConversationId,
  EntryId,
  Harness,
  HarnessInspection,
  JsonObject,
  SubmissionId,
  SubmissionRecord,
  TaskId,
  TaskInspection,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { type SweptKind, sweepBlockedTasks } from "../src/task-sweep.ts";

/** Whether `n` could be one of pi-durable's ids: positive safe integers. */
const isPositive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/** pi-durable's branded ids, each through a guard: no case here needs a cast. */
const isConversationId = (n: number): n is ConversationId => isPositive(n);
const isTaskId = (n: number): n is TaskId<JsonValue> => isPositive(n);
const isSubmissionId = (n: number): n is SubmissionId => isPositive(n);
const isEntryId = (n: number): n is EntryId => isPositive(n);

/** `n` as an id `is` accepts, or a failure: pi-durable's ids are opaque numbers to a test. */
const idOf = <I extends number>(n: number, is: (value: number) => value is I, what: string): I => {
  if (!is(n)) {
    throw new Error(`test id ${String(n)} is no ${what}`);
  }
  return n;
};

const conversationIdOf = (n: number): ConversationId =>
  idOf(n, isConversationId, "conversation id");
const taskIdOf = (n: number): TaskId<JsonValue> => idOf(n, isTaskId, "task id");
const submissionIdOf = (n: number): SubmissionId => idOf(n, isSubmissionId, "submission id");
const entryIdOf = (n: number): EntryId => idOf(n, isEntryId, "entry id");

/** The conversation every fake task and submission belongs to. */
const CONVERSATION = conversationIdOf(1);

/** Any JSON value (pi-durable exports only its object form): what a task record's id carries. */
type JsonValue = JsonObject[string];

/** A live task record of `kind`, as the harness reports one. */
const liveTask = (id: TaskId<JsonValue>, kind: string): TaskInspection["record"] => ({
  id,
  conversationId: CONVERSATION,
  kind,
  version: 1,
  input: {},
  background: true,
  abortRequested: false,
  state: { status: "pending", checkpoint: {} },
});

/** A task of `kind` the registry cannot run here. */
const blockedTask = (
  id: TaskId<JsonValue>,
  kind: string,
  reason: BlockedReason,
): TaskInspection => ({
  record: liveTask(id, kind),
  state: { kind: "blocked", reason },
});

/** A task of `kind` the sweep must leave alone: it can run. */
const runningTask = (id: TaskId<JsonValue>, kind: string): TaskInspection => ({
  record: { ...liveTask(id, kind), state: { status: "running", checkpoint: {} } },
  state: { kind: "running" },
});

/** A queued submission, as a task's own request namespace submits it. */
const queued = (id: SubmissionId, requestId: string): SubmissionRecord => ({
  id,
  conversationId: CONVERSATION,
  requestId,
  type: "input",
  status: "queued",
});

/** A queued submission already in the transcript: a sweep leaves it to run. */
const placed = (id: SubmissionId, requestId: string): SubmissionRecord => ({
  id,
  conversationId: CONVERSATION,
  requestId,
  type: "input",
  status: "placed",
  entry: entryIdOf(1),
});

describe("sweepBlockedTasks", () => {
  it("sweepBlockedTasks touches only the listed kinds", async () => {
    const calls: string[] = [];
    const journal: string[] = [];
    const row = (kind: string, noun: string): SweptKind => ({
      kind,
      noun,
      requestPrefix: (taskId) => `${noun}:${String(taskId)}:`,
      report: (task, reason): Promise<void> => {
        calls.push(`report ${String(task.record.id)} ${reason}`);
        return Promise.resolve();
      },
    });

    const tasks = [
      blockedTask(taskIdOf(1), "alpha.task", "missing_task"),
      blockedTask(taskIdOf(2), "beta.task", "restart_limit"),
      blockedTask(taskIdOf(3), "gamma.task", "missing_task"),
      runningTask(taskIdOf(4), "alpha.task"),
    ];
    const submissions = [
      queued(submissionIdOf(10), "alpha:1:0"),
      // Answered by a run that raced the sweep: withdrawn, but not counted.
      queued(submissionIdOf(11), "alpha:1:1"),
      placed(submissionIdOf(12), "alpha:1:2"),
      queued(submissionIdOf(13), "alpha:4:0"),
      queued(submissionIdOf(14), "beta:2:0"),
      queued(submissionIdOf(15), "gamma:3:0"),
    ];
    const harness: Pick<Harness, "inspect" | "abortSubmission" | "abortTask"> = {
      inspect: (): Promise<HarnessInspection> =>
        Promise.resolve({ scheduling: "running", tasks, submissions }),
      abortSubmission: (id, _ctx, conversationId): ReturnType<Harness["abortSubmission"]> => {
        calls.push(`withdraw ${String(id)} from ${String(conversationId)}`);
        return Promise.resolve(id === submissionIdOf(11) ? "already_placed" : "aborted");
      },
      abortTask: (taskId): ReturnType<Harness["abortTask"]> => {
        calls.push(`abort ${String(taskId)}`);
        return Promise.resolve("terminal");
      },
    };
    const log = (line: string): void => {
      journal.push(line);
      calls.push(`log ${line}`);
    };

    await sweepBlockedTasks(
      harness,
      [row("alpha.task", "alpha"), row("beta.task", "beta")],
      log,
      context,
    );

    // Each blocked listed task in full, in the harness's order; one call per step.
    expect(calls).toEqual([
      "log alpha 1 blocked (missing_task); aborting",
      "withdraw 10 from 1",
      "withdraw 11 from 1",
      "log alpha 1 withdrew 1 queued input(s)",
      "report 1 missing_task",
      "abort 1",
      "log beta 2 blocked (restart_limit); aborting",
      "withdraw 14 from 1",
      "log beta 2 withdrew 1 queued input(s)",
      "report 2 restart_limit",
      "abort 2",
    ]);
    expect(journal).toEqual([
      "alpha 1 blocked (missing_task); aborting",
      "alpha 1 withdrew 1 queued input(s)",
      "beta 2 blocked (restart_limit); aborting",
      "beta 2 withdrew 1 queued input(s)",
    ]);
  });
});
