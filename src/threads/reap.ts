// The reap (SL-006 design § The reap, in order; PHASE-06 EX-5, EX-6, EX-7, VT-4,
// VT-5, VT-11): one commit's writes — the tombstone and, with it, the originator's
// `family-reaped` notice — for use INSIDE a commit after every table read; then the
// two post-commit steps: withdraw the family's queued inputs one at a time, and
// journal and notify the operator with the count withdrawn.

import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Task, TaskInspection, Tx } from "@earendil-works/pi-durable";
import { notifyBestEffort, scheduledKey } from "../task-support.ts";
import type { ThreadDeps } from "./extension.ts";
import { type Origin, originKey } from "./origin.ts";
import {
  createPostTask,
  isPostInput,
  POST_KIND,
  type PostInput,
  type PostResult,
  type PostState,
  postRequestId,
} from "./task.ts";
import { threadsDoc, tombstone } from "./tombstones.ts";

type PostTask = Task<PostInput, PostState, PostResult, object>;

/** What the post-commit steps read and withdraw through. */
type HarnessReads = Pick<Harness, "inspect" | "abortSubmission">;

/** One family post's queued input: its task id, and the conversation it was sent to. */
interface FamilyInput {
  readonly id: number;
  readonly to: ConversationId;
}

/**
 * The reap commit's writes (design § The reap, in order, step 1): the tombstone and, in
 * the same commit, the `family-reaped` notice to the reaped origin's conversation — the
 * notice only when `tombstone` reports it new. For use INSIDE a commit, after every table
 * read. Returns whether it reaped: false means another conversation reaped the family
 * first, and this writes nothing.
 */
export async function reapIn(
  tx: Tx,
  task: PostTask,
  origin: Origin,
  reason: string,
  now: number,
): Promise<boolean> {
  if (!tombstone(await threadsDoc(tx), origin, reason, now)) {
    return false;
  }
  await createPostTask(tx, task, {
    letter: "family-reaped",
    to: origin.conversation,
    origin,
    reason,
  });
  return true;
}

/** The family's live post tasks, letter `post` under `origin`: notices and other origins left out. */
const familyInputs = (tasks: readonly TaskInspection[], origin: Origin): readonly FamilyInput[] => {
  const key = originKey(origin);
  const inputs: FamilyInput[] = [];
  for (const { record } of tasks) {
    if (record.kind !== POST_KIND || !isPostInput(record.input)) {
      continue;
    }
    const input = record.input;
    if (input.letter === "post" && originKey(input.origin) === key) {
      inputs.push({ id: record.id, to: input.to });
    }
  }
  return inputs;
};

/**
 * Step 2 of the reap (design § The reap, in order): one `inspect`, then each family
 * input still queued is withdrawn by its own request id — `post:<task id>`, never a
 * prefix of another's — one at a time, never through `Conversation.abort`, which would
 * take a co-resident loop's inputs too. Counts the `aborted` answers.
 */
export async function withdrawFamily(
  harness: HarnessReads,
  origin: Origin,
  ctx: Context,
): Promise<number> {
  const { tasks, submissions } = await harness.inspect(ctx);
  let withdrew = 0;
  for (const family of familyInputs(tasks, origin)) {
    const requestId = postRequestId(family.id);
    const queued = submissions.find(
      (submission) => submission.status === "queued" && submission.requestId === requestId,
    );
    if (queued === undefined) {
      continue;
    }
    if ((await harness.abortSubmission(queued.id, ctx, family.to)) === "aborted") {
      withdrew += 1;
    }
  }
  return withdrew;
}

/** The reap's one journal line (design § Journal), which is also the notification's body. */
export const reapLine = (origin: Origin, reason: string, withdrew: number): string =>
  `family ${originKey(origin)} reaped: ${reason}; withdrew ${String(withdrew)}`;

/** Step 3 of the reap: journal the line, then notify the operator best effort (design § Notification). */
export async function reported(
  deps: ThreadDeps,
  origin: Origin,
  reason: string,
  withdrew: number,
): Promise<void> {
  const line = reapLine(origin, reason, withdrew);
  deps.log(line);
  await notifyBestEffort(
    deps.satan,
    scheduledKey(origin.conversation),
    "SATAN threads reaped",
    line,
  );
}

/** The reap after its commit: withdraw the family's queued inputs, then journal and notify. */
export async function afterReap(
  deps: ThreadDeps,
  origin: Origin,
  reason: string,
  ctx: Context,
): Promise<void> {
  const withdrew = await withdrawFamily(deps.harness, origin, ctx);
  await reported(deps, origin, reason, withdrew);
}
