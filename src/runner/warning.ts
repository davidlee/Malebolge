// The one warning (design §5.4 "One warning", DEC-057): a steer with
// `requestId` `warn-<job id>`, so a resubmit returns the admitted submission;
// its `job_events` row is the receipt of admission and carries the
// submission's id. Delivery is placement, read from the submission record:
// `Harness.submission(id).status()` has an `entry` once placed. Neither read
// enables scheduling.
//
// Binding order: admission, then receipt. A crash between them is recovery's
// "no receipt" row (PHASE-10), which resubmits the same `requestId`.

import type { Conversation, Harness, Submission, SubmissionId } from "@earendil-works/pi-durable";
import { context } from "../context.ts";
import { messageOf } from "./errors.ts";
import type { JobStore } from "./store.ts";

/** The warning's text: a runner constant (OQ-C); PHASE-09's resume message reuses it. */
export const WARNING_TEXT =
  "Ceiling near: this job is about to be stopped. Commit your work in progress and write your notes now.";

/** The warning's `requestId`: the one spelling of `warn-<job id>`. */
export const warningRequestId = (jobId: string): string => `warn-${jobId}`;

/** What made the warning due: a gate admission, or the wall-clock soft timer. */
export type DueTrigger = "usage" | "wall_clock";

/** What a receipt names as the warning's occasion: its due trigger, or a resume message carrying it. */
export type WarningTrigger = DueTrigger | "resume";

export interface WarningDeps {
  conversation: Pick<Conversation, "submit">;
  jobs: Pick<JobStore, "appendEvent">;
  jobId: string;
  now: () => number;
}

/**
 * The warning's receipt: a `warning` event naming the admitted submission that
 * carries it (the steer, or a resume message), written after admission.
 */
export async function recordWarning(
  deps: Omit<WarningDeps, "conversation">,
  requestId: string,
  submission: Pick<Submission, "id">,
  trigger: WarningTrigger,
): Promise<void> {
  await deps.jobs.appendEvent(deps.jobId, deps.now(), "warning", {
    requestId,
    submissionId: String(submission.id),
    trigger,
  });
}

/** Submits the warning steer, then writes its receipt. */
export async function submitWarning(deps: WarningDeps, trigger: DueTrigger): Promise<Submission> {
  const requestId = warningRequestId(deps.jobId);
  const submission = await deps.conversation.submit(
    { type: "input", content: WARNING_TEXT, whenBusy: "steer", requestId },
    context,
  );
  await recordWarning(deps, requestId, submission, trigger);
  return submission;
}

/** Whether `submission` reached the transcript: its record carries an entry. Read-only. */
export const placed = async (submission: Pick<Submission, "status">): Promise<boolean> =>
  (await submission.status(context)).entry !== undefined;

/** Whether the warning reached the transcript: its record carries an entry. Read-only. */
export async function warningPlaced(
  harness: Pick<Harness, "submission">,
  submissionId: SubmissionId,
): Promise<boolean> {
  const submission = await harness.submission(submissionId, context);
  return submission !== undefined && (await placed(submission));
}

/**
 * Whether a resume message owes the warning (DEC-057): its threshold passed
 * and no placed warning is on record (no receipt, or one whose submission has
 * no entry). The one predicate for the run and for restart recovery.
 */
export const warningOwed = (thresholdPassed: boolean, receipt?: { placed: boolean }): boolean =>
  thresholdPassed && receipt?.placed !== true;

/** A run's one warning. */
export interface RunWarning {
  /** The warning is due: given once per run, and never if already on record. */
  due: (trigger: DueTrigger) => void;
  /** Whether it was ever made due, given or not: the threshold passed (AS-2). */
  wasDue: () => boolean;
  /**
   * No warning is given from now on. Resolves, once one in progress is
   * admitted and receipted, to its submission; `undefined` when none was given.
   */
  close: () => Promise<Submission | undefined>;
}

export interface RunWarningDeps extends WarningDeps {
  jobs: Pick<JobStore, "appendEvent" | "events">;
  /** The run is being stopped (a cancel, a ceiling): a warning is then moot. */
  stop: AbortSignal;
  /** Told of a warning that could not be given; the run goes on (I12). */
  failed: (message: string) => void;
}

/**
 * The run's warning. `due` may be called from inside a pi task (the model
 * gate): the steer is submitted from a later microtask, never from the
 * caller's stack, and the caller never waits on it.
 */
export function runWarning(deps: RunWarningDeps): RunWarning {
  let given: Promise<Submission | undefined> | undefined;
  let closed = false;
  let madeDue = false;
  async function give(trigger: DueTrigger): Promise<Submission | undefined> {
    const events = await deps.jobs.events(deps.jobId);
    // Checked after the last wait before submitting: a close or a stop in
    // between withholds the warning.
    if (closed || deps.stop.aborted || events.some((event) => event.kind === "warning")) {
      return undefined;
    }
    return submitWarning(deps, trigger);
  }
  return {
    due: (trigger): void => {
      madeDue = true;
      if (closed || given !== undefined) {
        return;
      }
      // Not from the caller's stack: a microtask first, never awaited by it.
      given = Promise.resolve()
        .then(() => give(trigger))
        .catch((error: unknown) => {
          deps.failed(messageOf(error));
          return undefined;
        });
    },
    wasDue: () => madeDue,
    close: (): Promise<Submission | undefined> => {
      closed = true;
      return given ?? Promise.resolve(undefined);
    },
  };
}
