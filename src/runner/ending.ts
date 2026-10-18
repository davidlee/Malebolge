// How an admitted run ends (design §5.4 "Submit to review", "Ceilings"): the
// `collecting` transition's payload and end reason. Shared by the run
// (run.ts) and restart recovery (recover.ts: a settled run whose `collecting`
// was never written).

import type { SettledSubmissionRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import type { JsonRecord } from "../json.ts";
import type { LatchReason } from "./ceiling-latch.ts";
import type { Job, JobStore } from "./store.ts";
import type { EndReason } from "./vocab.ts";

/** How a settled run ended, absent a stop the runner asked for. */
export const endReasonOf = (record: Pick<SubmissionRecord, "status">): EndReason =>
  record.status === "done" ? "completed" : "error";

/** How the admitted run ended: the `collecting` transition's payload and end reason. */
export interface Ending {
  payload: JsonRecord;
  endReason: EndReason;
}

/**
 * A settled submission's ending. Its `reason` is kept as `submissionReason`:
 * a payload's `reason` names why the job moved (a cancel's included).
 */
export function settledEnding(record: SettledSubmissionRecord): Ending {
  return {
    payload: {
      submission: record.status,
      ...(record.reason === undefined ? {} : { submissionReason: record.reason }),
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    },
    endReason: endReasonOf(record),
  };
}

/** `ending`, unless a ceiling stopped the run: then its reason, recorded as `ceiling`. */
export function ceilingEnding(ending: Ending, ceiling: EndReason | undefined): Ending {
  return ceiling === undefined
    ? ending
    : { payload: { ...ending.payload, ceiling }, endReason: ceiling };
}

/**
 * `ending`, unless the run's latch stopped it: a ceiling as `ceilingEnding`;
 * a trust failure as `end_reason = error`, the payload's reason `host_key`.
 */
export function latchedEnding(ending: Ending, latched: LatchReason | undefined): Ending {
  return latched === "host_key"
    ? { payload: { ...ending.payload, reason: latched }, endReason: "error" }
    : ceilingEnding(ending, latched);
}

/** `collecting`, with `ending`'s payload and end reason; the run's and recovery's one write. */
export const enterCollecting = (
  deps: { jobs: Pick<JobStore, "transition">; now: () => number },
  id: string,
  { payload, endReason }: Ending,
): Promise<Job> => deps.jobs.transition(id, "collecting", deps.now(), payload, { endReason });
