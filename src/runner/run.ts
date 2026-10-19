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
// cancel, then a ceiling, wins over a pending pause. A lost connection whose
// start failed the host-key check is no pause (EX-5): it trips the latch, so
// the run is aborted and collected, `end_reason = error`, reason `host_key`. The run then waits for
// the room (pause.ts), keeping its seat, tenancy and connection, and resumes
// with one message (`resume-<job id>-<pause_count>`, carrying the warning when
// it is owed): a new segment, with its own pause signal, warning and timers
// re-armed from the `running` row, so waiting is never active time. Waited out
// or cancelled while waiting, the job goes to `pending_collection`.
//
// A run is entered at its prompt (`runJob`, a queued job) or, after a
// restart, wherever the recovery table puts it (rejoin.ts): `superviseRun`
// and the segment loop are the same for both. A run whose runner is shutting
// down (`stopping`) writes no ending its own stop caused: its row stays as a
// crash would leave it, for restart recovery.
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
} from "@earendil-works/pi-durable";
import type { Connection } from "@earendil-works/pi-env";
import { parseModel } from "../models.ts";
import { context } from "../context.ts";
import type { JsonRecord } from "../json.ts";
import type { Sleep } from "./backoff.ts";
import { type CeilingLatch, ceilingLatch } from "./ceiling-latch.ts";
import { type CollectDeps, collectJob } from "./collect.ts";
import type { RepoConfig } from "./config.ts";
import { type Conversations, ensureConversation, jobConversation } from "./conversations.ts";
import { armCeilingTimers, type CeilingTimers, type Timer } from "./deadline.ts";
import { type Ending, enterCollecting, latchedEnding, settledEnding } from "./ending.ts";
import { jobEnv } from "./env.ts";
import {
  awaitRoom,
  pausingObserver,
  resumeRequestId,
  roomProbeFailed,
  type RoomWait,
  roomWaitedOut,
  submitResume,
} from "./pause.ts";
import type { Meter } from "./model-gate.ts";
import { configEntry, type ResolvedPolicy, resolvePolicy } from "./policy.ts";
import { PrepareFailed, preparingFailure, readyRoom } from "./prepare.ts";
import { composePrompt } from "./prompt.ts";
import { type Degradation, fetchProjectContext } from "./project-context.ts";
import { ChannelFailed } from "./room.ts";
import { roomShell } from "./shell.ts";
import type { RunControl } from "./scheduler.ts";
import type { Job } from "./store.ts";
import type { Tenancy } from "./tenancy.ts";
import { messageOf } from "./errors.ts";
import { placed, type RunWarning, runWarning, warningOwed } from "./warning.ts";

export interface RunDeps extends CollectDeps {
  harness: Pick<Harness, "conversation" | "commit">;
  conversations: Conversations;
  tenancy: Tenancy;
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
  /**
   * Aborted once the runner is shutting down. A harness call that then fails
   * ends nothing: the run gives up, its row left as it stands, for restart
   * recovery (DEC-054), as a crash would leave it.
   */
  stopping: AbortSignal;
}

// --- ending before anything ran ---------------------------------------------------

/** A queued or preparing job ends: `cancelled` when asked, else `failed` for `error`. */
export async function endUnrun(
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
export interface Resolved {
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
export interface Seated {
  warning: RunWarning;
  /**
   * Aborted when a call ends with the job's pause marked (the guard's
   * `afterTools`). Only wakes the run: the durable mark decides. Never the
   * ceiling latch: a pause is not an exhaustion.
   */
  pause: AbortController;
}

/** What every segment of one run shares: its conversation, policy, stops and seat. */
export interface Run {
  conversation: Conversation;
  policy: ResolvedPolicy;
  /** The job's repo, as resolved for the run: the waiting episode probes through it. */
  repo: RepoConfig;
  stops: Stops;
  /** Seats the job over a fresh pause signal and warning: the next segment's. */
  seat: () => Seated;
}

/** One running segment: its submission, warning, timers and pause signal. */
export interface Admitted extends Seated {
  run: Run;
  job: Job;
  submission: Submission;
  timers: CeilingTimers;
}

/** What stops an admitted run: a cancel, or a ceiling (the gate's refusal, the deadline). */
export interface Stops {
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
export function openRun(
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
    observer: pausingObserver(deps, job.id, () => {
      stops.latch.trip("host_key");
    }),
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
  return { conversation, policy, repo, stops, seat };
}

/** The segment whose `submission` was admitted and recorded `running`: its timers armed. */
export function armed(
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

/** A segment with no timers: one the run aborts at once (a recorded pause, restart row 6). */
export const unarmed = (run: Run, seated: Seated, job: Job, submission: Submission): Admitted => ({
  ...seated,
  run,
  job,
  submission,
  timers: { stop: () => undefined },
});

/** One audited event (and one log line) per source the fetch could not read; the job runs on. */
async function recordDegradations(
  deps: RunDeps,
  jobId: string,
  degraded: readonly Degradation[],
): Promise<void> {
  for (const degradation of degraded) {
    await deps.jobs.appendEvent(jobId, deps.now(), "context_degraded", { ...degradation });
    const code = degradation.code === undefined ? "" : ` ${String(degradation.code)}`;
    deps.log(`job ${jobId}: context degraded: ${degradation.source} ${degradation.reason}${code}`);
  }
}

/**
 * Steps 3-7: the room readied and its project context fetched, the tenant
 * seated, the prompt (with that context) admitted, `running`. The fetch's
 * degradations are audited once, after the ready loop.
 */
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
  // The fetch is the last step of the ready loop: a retried attempt's data is dropped.
  const { value: fetched } = await readyRoom(
    deps,
    job,
    repo,
    shell,
    control.signal,
    fetchProjectContext(repo, deps.channel.checkClone),
  );
  await recordDegradations(deps, job.id, fetched.degraded);
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
  const prompt = composePrompt(
    await deps.readPrompt(),
    policy,
    { ...job, cwd: repo.guestPath },
    fetched.sources,
  );
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
 * than by a cancel still ends the run, `end_reason = error`; unless the
 * runner is shutting down, when it is restart's to recover.
 */
async function settle(deps: RunDeps, segment: Admitted): Promise<Ending> {
  try {
    return settledEnding(await settleSubmission(segment));
  } catch (error) {
    if (deps.stopping.aborted) {
      throw error;
    }
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
  const ending = await settle(deps, segment);
  segment.timers.stop();
  const warning = await segment.warning.close();
  await endStrayWarning(segment, warning).catch((error: unknown) => {
    deps.log(`job ${segment.job.id}: warning not ended: ${messageOf(error)}`);
  });
  await segment.run.stops.expired();
  return { ending, warning };
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
  return enterCollecting(deps, job.id, latchedEnding(ending, latch.reason()));
}

// --- waiting for the room, and the resume (DEC-055) -----------------------------

/**
 * The run's warning across its segments (AS-2): whether it was ever due, and
 * the last submission that carried it (the steer, or a resume message).
 */
export interface WarningTrail {
  due: boolean;
  carrier: Submission | undefined;
}

/** Whether the next resume message owes the warning: due or given, and none placed. */
async function owesWarning({ due, carrier }: WarningTrail): Promise<boolean> {
  const receipt = carrier === undefined ? undefined : { placed: await placed(carrier) };
  return warningOwed(due || carrier !== undefined, receipt);
}

/** Where a run's segment loop goes next: a segment and the trail before it, or the job at rest. */
export type Entered = { segment: Admitted; trail: WarningTrail } | { ended: Job };

/**
 * The waiting episode of `waiting` (the job as `waiting_room` recorded it):
 * the room probed; on reachable, the resume message admitted (carrying the
 * warning when `withWarning`, by default when the trail owes it), then
 * `running` and the timers re-armed from that row. Waited out, or cancelled,
 * the job goes to `pending_collection`; collection is the scheduler's retry. A
 * probe `ChannelFailed` ends the run: `collecting`, collected by the caller.
 */
export async function awaitResume(
  deps: RunDeps,
  run: Run,
  waiting: Job,
  trail: WarningTrail,
  withWarning?: boolean,
): Promise<Entered> {
  const { control } = run.stops;
  let outcome: RoomWait;
  try {
    outcome = await awaitRoom(deps, run.repo, waiting, control.signal);
  } catch (error) {
    if (error instanceof ChannelFailed) {
      return { ended: await roomProbeFailed(deps, waiting.id, error) };
    }
    throw error;
  }
  if (outcome === "timed_out") {
    return { ended: await roomWaitedOut(deps, waiting.id) };
  }
  const reason = control.cancelReason;
  if (reason !== undefined) {
    return { ended: await recordCancel(deps, waiting.id, control, reason) };
  }
  const seated = run.seat();
  const carries = withWarning ?? (await owesWarning(trail));
  const submission = await submitResume(
    { conversation: run.conversation, jobs: deps.jobs, jobId: waiting.id, now: deps.now },
    { pauseCount: waiting.pauseCount, withWarning: carries },
  );
  const running = await deps.jobs.transition(waiting.id, "running", deps.now(), {
    submissionId: String(submission.id),
    requestId: resumeRequestId(waiting.id, waiting.pauseCount),
  });
  return {
    segment: armed(deps, run, seated, running, submission),
    trail: carries ? { ...trail, carrier: submission } : trail,
  };
}

/**
 * Runs segments from `entered` until one ends other than by a pause, or a
 * waiting episode ends without a resume. Each segment's own settlement is the
 * one awaited; a paused one's (`unanswered`) is recorded, never an end reason.
 */
async function runSegments(deps: RunDeps, entered: Entered): Promise<Job> {
  let next = entered;
  while ("segment" in next) {
    const { segment } = next;
    const { ending, warning } = await settleSegment(deps, segment);
    const trail = {
      due: next.trail.due || segment.warning.wasDue(),
      carrier: warning ?? next.trail.carrier,
    };
    const after = await afterSegment(deps, segment.job, ending, segment.run.stops);
    if (after.state !== "waiting_room") {
      return after;
    }
    next = await awaitResume(deps, segment.run, after, trail);
  }
  return next.ended;
}

/** A run with no warning on its trail yet: a queued job's. */
export const NO_TRAIL: WarningTrail = { due: false, carrier: undefined };

/**
 * Supervises job `job`'s run: its connection and stops opened, the run
 * entered (`enter`), its segments run, the job collected once `collecting`.
 * The seat, tenancy and connection outlive every segment and waiting episode
 * (AS-4). Waited out or cancelled while waiting, the job is left
 * `pending_collection`, the scheduler's to collect.
 */
export async function superviseRun(
  deps: RunDeps,
  job: Job,
  { repo }: Resolved,
  control: RunControl,
  enter: (connection: Connection, stops: Stops) => Promise<Entered>,
): Promise<Job> {
  const connection = deps.connect(repo);
  const stops = runStops(deps, job.id, control);
  let settled: Job;
  try {
    settled = await runSegments(deps, await enter(connection, stops));
  } finally {
    deps.tenancy.leave(job.id);
    connection.close();
  }
  return settled.state === "collecting" ? collectJob(deps, settled.id, deps.now()) : settled;
}

/**
 * The preparing job's room readied and its prompt admitted, or the job ended
 * before; unless the runner is shutting down, when it stays `preparing`.
 */
export async function prepareAndAdmit(
  deps: RunDeps,
  job: Job,
  resolved: Resolved,
  connection: Connection,
  stops: Stops,
): Promise<Entered> {
  try {
    return { segment: await admit(deps, job, resolved, connection, stops), trail: NO_TRAIL };
  } catch (error) {
    if (deps.stopping.aborted) {
      throw error;
    }
    return { ended: await endUnrun(deps, job, stops.control, error) };
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
  return superviseRun(deps, preparing.job, resolved, control, (connection, stops) =>
    prepareAndAdmit(deps, preparing.job, resolved, connection, stops),
  );
}
