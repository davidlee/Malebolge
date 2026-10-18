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
export type WarningTrigger = "usage" | "wall_clock";

export interface WarningDeps {
  conversation: Pick<Conversation, "submit">;
  jobs: Pick<JobStore, "appendEvent">;
  jobId: string;
  now: () => number;
}

/** Submits the warning steer, then writes its receipt. */
export async function submitWarning(
  deps: WarningDeps,
  trigger: WarningTrigger,
): Promise<Submission> {
  const requestId = warningRequestId(deps.jobId);
  const submission = await deps.conversation.submit(
    { type: "input", content: WARNING_TEXT, whenBusy: "steer", requestId },
    context,
  );
  await deps.jobs.appendEvent(deps.jobId, deps.now(), "warning", {
    requestId,
    submissionId: String(submission.id),
    trigger,
  });
  return submission;
}

/** Whether the warning reached the transcript: its record carries an entry. Read-only. */
export async function warningPlaced(
  harness: Pick<Harness, "submission">,
  submissionId: SubmissionId,
): Promise<boolean> {
  const submission = await harness.submission(submissionId, context);
  return (await submission?.status(context))?.entry !== undefined;
}

/** A run's one warning. */
export interface RunWarning {
  /** The warning is due: given once per run, and never if already on record. */
  due: (trigger: WarningTrigger) => void;
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
  async function give(trigger: WarningTrigger): Promise<Submission | undefined> {
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
    close: (): Promise<Submission | undefined> => {
      closed = true;
      return given ?? Promise.resolve(undefined);
    },
  };
}
