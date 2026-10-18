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
// cancel, then a ceiling, wins over a pending pause. The run then waits for
// the room (pause.ts), keeping its seat, tenancy and connection, and resumes
// with one message (`resume-<job id>-<pause_count>`, carrying the warning when
// it is owed): a new segment, with its own pause signal, warning and timers
// re-armed from the `running` row, so waiting is never active time. Waited out
// or cancelled while waiting, the job goes to `pending_collection`.
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
import {
  awaitRoom,
  pausingObserver,
  resumeRequestId,
  roomWaitedOut,
  submitResume,
} from "./pause.ts";
import type { Meter } from "./model-gate.ts";
import { configEntry, type ResolvedPolicy, resolvePolicy } from "./policy.ts";
import { PrepareFailed, preparingFailure, readyRoom, roomShell } from "./prepare.ts";
import { composePrompt } from "./prompt.ts";
import type { RunControl } from "./scheduler.ts";
import type { Job } from "./store.ts";
import type { Tenancy } from "./tenancy.ts";
import type { EndReason } from "./vocab.ts";
import { messageOf } from "./errors.ts";
import { placed, type RunWarning, runWarning, warningOwed } from "./warning.ts";

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
    return recordCancel(deps, job.id, control, reason);
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

/** One segment's pause signal and warning, the tenant seated over them (AS-5). */
interface Seated {
  warning: RunWarning;
  /**
   * Aborted when a call ends with the job's pause marked (the guard's
   * `afterTools`). Only wakes the run: the durable mark decides. Never the
   * ceiling latch: a pause is not an exhaustion.
   */
  pause: AbortController;
}

/** What every segment of one run shares: its conversation, policy, stops and seat. */
interface Run {
  conversation: Conversation;
  policy: ResolvedPolicy;
  stops: Stops;
  /** Seats the job over a fresh pause signal and warning: the next segment's. */
  seat: () => Seated;
}

/** One running segment: its submission, warning, timers and pause signal. */
interface Admitted extends Seated {
  run: Run;
  job: Job;
  submission: Submission;
  timers: CeilingTimers;
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
  { warning, pause }: Seated,
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

/** The run over `conversation`: one env on the job's connection, observed for a lost room. */
function openRun(
  deps: RunDeps,
  job: Job & { conversationId: string },
  { policy, repo }: Resolved,
  conversation: Conversation,
  connection: Connection,
  stops: Stops,
): Run {
  const env = jobEnv({
    jobId: job.id,
    cwd: repo.guestPath,
    connection,
    observer: pausingObserver(deps, job.id),
  });
  const seat = (): Seated => {
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
    const seated = { pause, warning };
    deps.tenancy.enter({
      id: job.id,
      conversationId: job.conversationId,
      allowedPaths: job.allowedPaths,
      root: repo.guestPath,
      paused: () => {
        pause.abort();
      },
      env,
      meter: meterOf(deps, conversation, policy, stops.latch, seated),
    });
    return seated;
  };
  return { conversation, policy, stops, seat };
}

/** The segment whose `submission` was admitted and recorded `running`: its timers armed. */
function armed(
  deps: RunDeps,
  run: Run,
  seated: Seated,
  running: Job,
  submission: Submission,
): Admitted {
  const timers = armCeilingTimers({
    job: running,
    ceilings: run.policy.ceilings,
    softThreshold: deps.config.maxima.softThreshold,
    now: deps.now(),
    timer: deps.timer,
    expire: run.stops.expire,
    warn: () => {
      seated.warning.due("wall_clock");
    },
  });
  return { ...seated, run, job: running, submission, timers };
}

/** Steps 3-7: the room readied, the tenant seated, the prompt admitted, `running`. */
async function admit(
  deps: RunDeps,
  job: Job,
  resolved: Resolved,
  connection: Connection,
  stops: Stops,
): Promise<Admitted> {
  const { control } = stops;
  const { policy, repo } = resolved;
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
  const run = openRun(deps, { ...job, conversationId }, resolved, conversation, connection, stops);
  const seated = run.seat();
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
  return armed(deps, run, seated, running, submission);
}

// --- running to collecting --------------------------------------------------------

/** The segment's submission settled; a cancel, a ceiling or a pause aborts the conversation first. */
async function settleSubmission(segment: Admitted): Promise<SettledSubmissionRecord> {
  const { conversation, stops } = segment.run;
  const stop = AbortSignal.any([stops.signal, segment.pause.signal]);
  try {
    return await segment.submission.wait(withAbortSignal(stop, context));
  } catch (error) {
    if (!stop.aborted) {
      throw error;
    }
  }
  await conversation.abort(context);
  return segment.submission.wait(context);
}

/**
 * How the segment ended. Never throws (I12): a settlement that fails other
 * than by a cancel still ends the run, `end_reason = error`.
 */
async function settle(segment: Admitted): Promise<Ending> {
  try {
    return settledEnding(await settleSubmission(segment));
  } catch (error) {
    return { payload: { reason: "settle_failed", message: messageOf(error) }, endReason: "error" };
  }
}

/**
 * A warning that started a run of its own (submitted as the run settled, to
 * an idle conversation) is aborted: the segment is over.
 */
async function endStrayWarning(segment: Admitted, warning: Submission | undefined): Promise<void> {
  if (warning === undefined) {
    return;
  }
  const { status } = await warning.status(context);
  if (status === "queued" || status === "placed") {
    await segment.run.conversation.abort(context);
    await warning.wait(context);
  }
}

/** A settled segment: how it ended, and the warning steer it gave, if any. */
interface SegmentEnd {
  ending: Ending;
  warning: Submission | undefined;
}

/**
 * The segment settled; then its timers stopped, its warning closed and the
 * deadline's event written, so nothing fires into collection or the wait.
 */
async function settleSegment(deps: RunDeps, segment: Admitted): Promise<SegmentEnd> {
  const ending = await settle(segment);
  segment.timers.stop();
  const warning = await segment.warning.close();
  await endStrayWarning(segment, warning).catch((error: unknown) => {
    deps.log(`job ${segment.job.id}: warning not ended: ${messageOf(error)}`);
  });
  await segment.run.stops.expired();
  return { ending, warning };
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

/** Records the cancel `control` asked for, and answers it. */
async function recordCancel(
  deps: RunDeps,
  id: string,
  control: RunControl,
  reason: string,
  payload: JsonRecord = {},
): Promise<Job> {
  const cancelled = await deps.jobs.cancel(id, deps.now(), { ...payload, reason });
  control.cancelled(cancelled);
  return cancelled;
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
    return recordCancel(deps, job.id, control, reason, ending.payload);
  }
  const { payload, endReason } = ceilingEnding(ending, latch);
  return deps.jobs.transition(job.id, "collecting", deps.now(), payload, { endReason });
}

// --- waiting for the room, and the resume (DEC-055) -----------------------------

/**
 * The run's warning across its segments (AS-2): whether it was ever due, and
 * the last submission that carried it (the steer, or a resume message).
 */
interface WarningTrail {
  due: boolean;
  carrier: Submission | undefined;
}

/** Whether the next resume message owes the warning: due or given, and none placed. */
async function owesWarning({ due, carrier }: WarningTrail): Promise<boolean> {
  const receipt = carrier === undefined ? undefined : { placed: await placed(carrier) };
  return warningOwed(due || carrier !== undefined, receipt);
}

/** How a waiting episode ended: resumed into a new segment, or the job left to collection. */
type Waited = { resumed: Admitted; carried: boolean } | { ended: Job };

/**
 * The waiting episode of `waiting` (the job as `waiting_room` recorded it):
 * the room probed; on reachable, the resume message admitted, then `running`
 * and the timers re-armed from that row. Waited out, or cancelled, the job
 * goes to `pending_collection`; collection is the scheduler's retry.
 */
async function awaitResume(
  deps: RunDeps,
  run: Run,
  waiting: Job,
  trail: WarningTrail,
): Promise<Waited> {
  const { control } = run.stops;
  const outcome = await awaitRoom(deps, waiting, control.signal);
  if (outcome === "timed_out") {
    return { ended: await roomWaitedOut(deps, waiting.id) };
  }
  const reason = control.cancelReason;
  if (reason !== undefined) {
    return { ended: await recordCancel(deps, waiting.id, control, reason) };
  }
  const seated = run.seat();
  const withWarning = await owesWarning(trail);
  const submission = await submitResume(
    { conversation: run.conversation, jobs: deps.jobs, jobId: waiting.id, now: deps.now },
    { pauseCount: waiting.pauseCount, withWarning },
  );
  const running = await deps.jobs.transition(waiting.id, "running", deps.now(), {
    submissionId: String(submission.id),
    requestId: resumeRequestId(waiting.id, waiting.pauseCount),
  });
  return { resumed: armed(deps, run, seated, running, submission), carried: withWarning };
}

/**
 * Runs segments from `first` until one ends other than by a pause, or a
 * waiting episode ends without a resume. Each segment's own settlement is the
 * one awaited; a paused one's (`unanswered`) is recorded, never an end reason.
 */
async function runSegments(deps: RunDeps, first: Admitted): Promise<Job> {
  let segment = first;
  let trail: WarningTrail = { due: false, carrier: undefined };
  for (;;) {
    const { ending, warning } = await settleSegment(deps, segment);
    trail = { due: trail.due || segment.warning.wasDue(), carrier: warning ?? trail.carrier };
    const after = await afterSegment(deps, segment.job, ending, segment.run.stops);
    if (after.state !== "waiting_room") {
      return after;
    }
    const waited = await awaitResume(deps, segment.run, after, trail);
    if ("ended" in waited) {
      return waited.ended;
    }
    segment = waited.resumed;
    if (waited.carried) {
      trail = { ...trail, carrier: segment.submission };
    }
  }
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
  // The seat, tenancy and connection outlive every segment and waiting episode (AS-4).
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
    settled = await runSegments(deps, admitted);
  } finally {
    deps.tenancy.leave(job.id);
    connection.close();
  }
  // Waited out or cancelled while waiting: pending_collection, the scheduler's to collect.
  return settled.state === "collecting" ? collectJob(deps, settled.id, deps.now()) : settled;
}
