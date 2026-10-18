// One job's run (design §5.4 "Submit to review", binding order): its
// conversation ensured; the policy resolved and recorded; `preparing`; the
// room readied (base, job branch); the conversation configured and the
// prompt submitted with `requestId` = job id; `running` only once admitted
// (I16); then, the run settled, `collecting` with its end reason, and
// collection. The seated job's cancel is checked between steps: before the
// prompt is admitted it ends the job `cancelled`, after it the conversation is
// aborted and the job still collected.
//
// EVD-008: every harness call here and every store call are made outside one
// another's transactions; nothing is called from inside a `decide`.

import { withAbortSignal } from "@earendil-works/chord/context";
import type {
  Conversation,
  Extension,
  Harness,
  SettledSubmissionRecord,
  Submission,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Connection } from "@earendil-works/pi-env";
import { parseModel } from "../config.ts";
import { context } from "../context.ts";
import type { JsonRecord } from "../json.ts";
import type { Sleep } from "./backoff.ts";
import { type CollectDeps, collectJob } from "./collect.ts";
import type { RepoConfig } from "./config.ts";
import { type Conversations, ensureConversation, jobConversation } from "./conversations.ts";
import { type ConnectionObserver, jobEnv } from "./env.ts";
import { configEntry, type ResolvedPolicy, resolvePolicy } from "./policy.ts";
import { PrepareFailed, preparingFailure, readyRoom, roomShell } from "./prepare.ts";
import { composePrompt } from "./prompt.ts";
import type { RunControl } from "./scheduler.ts";
import type { Job } from "./store.ts";
import type { Tenancy } from "./tenancy.ts";
import type { EndReason } from "./vocab.ts";
import { messageOf } from "./errors.ts";

export interface RunDeps extends CollectDeps {
  harness: Pick<Harness, "conversation" | "commit">;
  conversations: Conversations;
  tenancy: Tenancy;
  /** A daemon connection into `repo`'s room: one per job, closed when its run settles. */
  connect: (repo: RepoConfig) => Connection;
  /** What a job's conversation selects: its tools and the guard (installed at open). */
  extensions: readonly Extension[];
  /** The corpus prompt text, read per job. */
  readPrompt: () => Promise<string>;
  now: () => number;
  sleep: Sleep;
}

/**
 * The running job's connection observer. PHASE-07: a lost connection while
 * running is only a tool error the model sees; PHASE-09 makes it a pause.
 */
const RUNNING_OBSERVER: ConnectionObserver = { lost: () => Promise.resolve() };

/** How a settled run ended, absent a stop the runner asked for. */
export const endReasonOf = (record: Pick<SubmissionRecord, "status">): EndReason =>
  record.status === "done" ? "completed" : "error";

/** How the admitted run ended: the `collecting` transition's payload and end reason. */
interface Ending {
  payload: JsonRecord;
  endReason: EndReason;
}

/**
 * A settled submission's ending. Its `reason` is kept as `submissionReason`:
 * a payload's `reason` names why the job moved (a cancel's included).
 */
function settledEnding(record: SettledSubmissionRecord): Ending {
  return {
    payload: {
      submission: record.status,
      ...(record.reason === undefined ? {} : { submissionReason: record.reason }),
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    },
    endReason: endReasonOf(record),
  };
}

// --- ending before anything ran ---------------------------------------------------

/** A queued or preparing job ends: `cancelled` when asked, else `failed` for `error`. */
async function endUnrun(
  deps: RunDeps,
  job: Job,
  control: RunControl,
  error?: unknown,
): Promise<Job> {
  const reason = control.cancelReason;
  if (reason !== undefined) {
    const cancelled = await deps.jobs.cancel(job.id, deps.now(), { reason });
    control.cancelled(cancelled);
    return cancelled;
  }
  const { failure, endReason } = preparingFailure(error);
  return deps.jobs.transition(
    job.id,
    "failed",
    deps.now(),
    { ...failure, endReason },
    {
      endReason,
      failure,
    },
  );
}

/** What preparing a job needs from config. */
interface Resolved {
  policy: ResolvedPolicy;
  repo: RepoConfig;
}

/** The policy recorded (audited `policy`), then `preparing`. */
async function startPreparing(
  deps: RunDeps,
  job: Job,
): Promise<{ job: Job; resolved?: Resolved; error?: unknown }> {
  let resolved: Resolved;
  try {
    resolved = {
      policy: resolvePolicy(deps.config, job),
      repo: configEntry(deps.config.repos, "repo", job.repo),
    };
  } catch (error) {
    // queued cannot fail; the job fails from preparing, without a policy.
    return { job: await deps.jobs.transition(job.id, "preparing", deps.now()), error };
  }
  const record = { ...resolved.policy };
  await deps.jobs.change(job.id, deps.now(), () => ({
    update: { policy: record },
    event: { kind: "policy", payload: record },
  }));
  return { job: await deps.jobs.transition(job.id, "preparing", deps.now()), resolved };
}

interface Admitted {
  job: Job;
  conversation: Conversation;
  submission: Submission;
}

/** Steps 3-7: the room readied, the tenant seated, the prompt admitted, `running`. */
async function admit(
  deps: RunDeps,
  job: Job,
  { policy, repo }: Resolved,
  connection: Connection,
  control: RunControl,
): Promise<Admitted> {
  const conversationId = job.conversationId;
  const conversation =
    conversationId === undefined ? undefined : await jobConversation(deps.harness, conversationId);
  if (conversationId === undefined || conversation === undefined) {
    throw new PrepareFailed({
      reason: "conversation_missing",
      conversationId: conversationId ?? null,
    });
  }
  const shell = roomShell(connection, job.id, repo.guestPath);
  await readyRoom(deps, job, repo, shell, control.signal);
  deps.tenancy.enter({
    id: job.id,
    conversationId,
    allowedPaths: job.allowedPaths,
    root: repo.guestPath,
    env: jobEnv({ jobId: job.id, cwd: repo.guestPath, connection, observer: RUNNING_OBSERVER }),
  });
  await conversation.configure(
    {
      model: parseModel(policy.model),
      thinkingLevel: policy.thinkingLevel ?? null,
      extensions: deps.extensions,
      cwd: repo.guestPath,
    },
    context,
  );
  const prompt = composePrompt(await deps.readPrompt(), policy, job);
  if (control.cancelReason !== undefined) {
    throw new Error("cancelled before admission");
  }
  const submission = await conversation.submit(
    { type: "input", content: prompt, requestId: job.id },
    context,
  );
  const running = await deps.jobs.transition(job.id, "running", deps.now(), {
    submissionId: String(submission.id),
    requestId: job.id,
  });
  return { job: running, conversation, submission };
}

// --- running to collecting --------------------------------------------------------

/** The admitted prompt's settlement; a cancel aborts the conversation first. */
async function settleSubmission(
  admitted: Admitted,
  control: RunControl,
): Promise<SettledSubmissionRecord> {
  try {
    return await admitted.submission.wait(withAbortSignal(control.signal, context));
  } catch (error) {
    if (!control.signal.aborted) {
      throw error;
    }
  }
  await admitted.conversation.abort(context);
  return admitted.submission.wait(context);
}

/**
 * How the admitted run ended. Never throws (I12): a settlement that fails
 * other than by a cancel still ends the run, `end_reason = error`.
 */
async function settle(admitted: Admitted, control: RunControl): Promise<Ending> {
  try {
    return settledEnding(await settleSubmission(admitted, control));
  } catch (error) {
    return { payload: { reason: "settle_failed", message: messageOf(error) }, endReason: "error" };
  }
}

/** `collecting`, with the end reason the ending (or a cancel) gives. */
async function toCollecting(
  deps: RunDeps,
  job: Job,
  ending: Ending,
  control: RunControl,
): Promise<Job> {
  const reason = control.cancelReason;
  if (reason !== undefined) {
    const cancelled = await deps.jobs.cancel(job.id, deps.now(), { ...ending.payload, reason });
    control.cancelled(cancelled);
    return cancelled;
  }
  return deps.jobs.transition(job.id, "collecting", deps.now(), ending.payload, {
    endReason: ending.endReason,
  });
}

/** Runs the seated `queued` job to a resting state. */
export async function runJob(deps: RunDeps, queued: Job, control: RunControl): Promise<Job> {
  const job = await ensureConversation(deps.jobs, deps.conversations, queued, deps.now());
  if (control.cancelReason !== undefined) {
    return endUnrun(deps, job, control);
  }
  const preparing = await startPreparing(deps, job);
  const { resolved } = preparing;
  if (resolved === undefined) {
    return endUnrun(deps, preparing.job, control, preparing.error);
  }
  const connection = deps.connect(resolved.repo);
  let collecting: Job;
  try {
    let admitted: Admitted;
    try {
      admitted = await admit(deps, preparing.job, resolved, connection, control);
    } catch (error) {
      return await endUnrun(deps, preparing.job, control, error);
    }
    collecting = await toCollecting(deps, admitted.job, await settle(admitted, control), control);
  } finally {
    deps.tenancy.leave(job.id);
    connection.close();
  }
  return collectJob(deps, collecting.id, deps.now());
}
