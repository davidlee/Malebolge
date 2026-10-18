// One job's run (design §5.4 "Submit to review", binding order): its
// conversation ensured; the policy resolved and recorded; `preparing`; the
// room readied (base, job branch); the conversation configured and the
// prompt submitted with `requestId` = job id; `running` only once admitted
// (I16); then, the run settled, `collecting` with its end reason, and
// collection. The seated job's cancel is checked between steps: before the
// prompt is admitted it ends the job `cancelled`, after it the conversation is
// aborted and the job still collected. A ceiling (the model gate's refusal)
// trips the run's latch: the conversation is aborted here, never in the gate,
// and the job is collected with the latch's reason (DEC-057). So does the
// deadline, armed with the soft timer once `running` commits and stopped, with
// the run's one warning closed, as soon as the run settles: nothing fires into
// collection. A lost room pauses the run (DEC-055): the job's connection marks
// `pause_requested` durably, the guard replaces the call's result and, once
// the tool round is committed, signals the segment's pause (never the latch);
// the conversation is aborted here and the job goes to `waiting_room`. A
// cancel, then a ceiling, wins over a pending pause.
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
import { type CeilingLatch, ceilingLatch } from "./ceiling-latch.ts";
import { type CollectDeps, collectJob } from "./collect.ts";
import type { RepoConfig } from "./config.ts";
import { type Conversations, ensureConversation, jobConversation } from "./conversations.ts";
import { armCeilingTimers, type CeilingTimers, type Timer } from "./deadline.ts";
import { jobEnv } from "./env.ts";
import { pausingObserver } from "./pause.ts";
import type { Meter } from "./model-gate.ts";
import { configEntry, type ResolvedPolicy, resolvePolicy } from "./policy.ts";
import { PrepareFailed, preparingFailure, readyRoom, roomShell } from "./prepare.ts";
import { composePrompt } from "./prompt.ts";
import type { RunControl } from "./scheduler.ts";
import type { Job } from "./store.ts";
import type { Tenancy } from "./tenancy.ts";
import type { EndReason } from "./vocab.ts";
import { messageOf } from "./errors.ts";
import { type RunWarning, runWarning } from "./warning.ts";

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
  /** Arms the deadline and the soft timer. */
  timer: Timer;
  /** Told of what goes wrong that the run outlives (a warning not given). */
  log: (text: string) => void;
}

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

/** One running segment: its submission, warning, timers and pause signal (AS-5). */
interface Admitted {
  job: Job;
  conversation: Conversation;
  submission: Submission;
  warning: RunWarning;
  timers: CeilingTimers;
  /**
   * Aborted when a call ends with the job's pause marked (the guard's
   * `afterTool`). Only wakes the run: the durable mark decides. Never the
   * ceiling latch: a pause is not an exhaustion.
   */
  pause: AbortController;
}

/** What stops an admitted run: a cancel, or a ceiling (the gate's refusal, the deadline). */
interface Stops {
  control: RunControl;
  latch: CeilingLatch;
  /** Aborted by either stop. */
  signal: AbortSignal;
  /** Trips the latch at once, then records the deadline's `ceiling` event. */
  expire: () => void;
  /** Settles once the deadline's `ceiling` event, if any, is written. */
  expired: () => Promise<void>;
}

/** The run's stops; the deadline's `ceiling` event (once per job, B3) is written as it trips. */
function runStops(deps: RunDeps, jobId: string, control: RunControl): Stops {
  const latch = ceilingLatch();
  let recording = Promise.resolve();
  return {
    control,
    latch,
    signal: AbortSignal.any([control.signal, latch.signal]),
    expire: (): void => {
      latch.trip("ceiling_exceeded");
      recording = deps.jobs
        .recordCeiling(jobId, deps.now(), { reason: "ceiling_exceeded", source: "deadline" })
        .catch((error: unknown) => {
          deps.log(`job ${jobId}: deadline not recorded: ${messageOf(error)}`);
        });
    },
    expired: () => recording,
  };
}

/**
 * The gate's side of the seated job: a refusal trips the run's latch; a
 * warning due goes to the segment's warning; the segment's pause signal,
 * fired, is a pending pause.
 */
function meterOf(
  deps: RunDeps,
  conversation: Conversation,
  policy: ResolvedPolicy,
  latch: CeilingLatch,
  { warning, pause }: Pick<Admitted, "warning" | "pause">,
): Meter {
  return {
    conversation: conversation.id,
    ceilings: policy.ceilings,
    softThreshold: deps.config.maxima.softThreshold,
    refused: latch.trip,
    warnDue: (): void => {
      warning.due("usage");
    },
    pausePending: (): boolean => pause.signal.aborted,
  };
}

/** Steps 3-7: the room readied, the tenant seated, the prompt admitted, `running`. */
async function admit(
  deps: RunDeps,
  job: Job,
  { policy, repo }: Resolved,
  connection: Connection,
  stops: Stops,
): Promise<Admitted> {
  const { control } = stops;
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
  const pause = new AbortController();
  const warning = runWarning({
    conversation,
    jobs: deps.jobs,
    jobId: job.id,
    now: deps.now,
    stop: stops.signal,
    failed: (message) => {
      deps.log(`job ${job.id}: warning not given: ${message}`);
    },
  });
  deps.tenancy.enter({
    id: job.id,
    conversationId,
    allowedPaths: job.allowedPaths,
    root: repo.guestPath,
    paused: () => {
      pause.abort();
    },
    env: jobEnv({
      jobId: job.id,
      cwd: repo.guestPath,
      connection,
      observer: pausingObserver(deps, job.id),
    }),
    meter: meterOf(deps, conversation, policy, stops.latch, { warning, pause }),
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
  const timers = armCeilingTimers({
    job: running,
    ceilings: policy.ceilings,
    softThreshold: deps.config.maxima.softThreshold,
    now: deps.now(),
    timer: deps.timer,
    expire: stops.expire,
    warn: () => {
      warning.due("wall_clock");
    },
  });
  return { job: running, conversation, submission, warning, timers, pause };
}

// --- running to collecting --------------------------------------------------------

/** The admitted prompt's settlement; a cancel, a ceiling or a pause aborts the conversation first. */
async function settleSubmission(
  admitted: Admitted,
  stops: Stops,
): Promise<SettledSubmissionRecord> {
  const stop = AbortSignal.any([stops.signal, admitted.pause.signal]);
  try {
    return await admitted.submission.wait(withAbortSignal(stop, context));
  } catch (error) {
    if (!stop.aborted) {
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
async function settle(admitted: Admitted, stops: Stops): Promise<Ending> {
  try {
    return settledEnding(await settleSubmission(admitted, stops));
  } catch (error) {
    return { payload: { reason: "settle_failed", message: messageOf(error) }, endReason: "error" };
  }
}

/**
 * A warning that started a run of its own (submitted as the run settled, to
 * an idle conversation) is aborted: the job's run is over.
 */
async function endStrayWarning(admitted: Admitted, warning: Submission | undefined): Promise<void> {
  if (warning === undefined) {
    return;
  }
  const { status } = await warning.status(context);
  if (status === "queued" || status === "placed") {
    await admitted.conversation.abort(context);
    await warning.wait(context);
  }
}

/**
 * The run settled; then its timers stopped, its warning closed and the
 * deadline's event written, so nothing fires into collection.
 */
async function settleRun(deps: RunDeps, admitted: Admitted, stops: Stops): Promise<Ending> {
  try {
    return await settle(admitted, stops);
  } finally {
    admitted.timers.stop();
    await endStrayWarning(admitted, await admitted.warning.close()).catch((error: unknown) => {
      deps.log(`job ${admitted.job.id}: warning not ended: ${messageOf(error)}`);
    });
    await stops.expired();
  }
}

/** `ending`, unless a ceiling tripped: then its reason, recorded as `ceiling`. */
function ceilingEnding(ending: Ending, latch: CeilingLatch): Ending {
  const ceiling = latch.reason();
  return ceiling === undefined
    ? ending
    : { payload: { ...ending.payload, ceiling }, endReason: ceiling };
}

/**
 * Where the settled segment goes: a cancel, then a ceiling, to `collecting`
 * (`toCollecting`); else, if the job's pause is marked (the durable record,
 * whatever woke the run), to `waiting_room`, the submission's settlement
 * recorded but never an end reason; else to `collecting`.
 */
async function afterSegment(deps: RunDeps, job: Job, ending: Ending, stops: Stops): Promise<Job> {
  const stopped = stops.control.cancelReason !== undefined || stops.latch.reason() !== undefined;
  if (!stopped && (await deps.jobs.get(job.id))?.pauseRequested === true) {
    return deps.jobs.transition(job.id, "waiting_room", deps.now(), ending.payload);
  }
  return toCollecting(deps, job, ending, stops);
}

/** `collecting`, with the end reason the ending gives; a cancel wins over a ceiling. */
async function toCollecting(
  deps: RunDeps,
  job: Job,
  ending: Ending,
  { control, latch }: Stops,
): Promise<Job> {
  const reason = control.cancelReason;
  if (reason !== undefined) {
    const cancelled = await deps.jobs.cancel(job.id, deps.now(), { ...ending.payload, reason });
    control.cancelled(cancelled);
    return cancelled;
  }
  const { payload, endReason } = ceilingEnding(ending, latch);
  return deps.jobs.transition(job.id, "collecting", deps.now(), payload, { endReason });
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
  const stops = runStops(deps, job.id, control);
  let settled: Job;
  try {
    let admitted: Admitted;
    try {
      admitted = await admit(deps, preparing.job, resolved, connection, stops);
    } catch (error) {
      return await endUnrun(deps, preparing.job, control, error);
    }
    settled = await afterSegment(deps, admitted.job, await settleRun(deps, admitted, stops), stops);
  } finally {
    deps.tenancy.leave(job.id);
    connection.close();
  }
  // Paused: the job holds the seat in waiting_room (the waiting episode is PHASE-09 batch B).
  return settled.state === "waiting_room" ? settled : collectJob(deps, settled.id, deps.now());
}
