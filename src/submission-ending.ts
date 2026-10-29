// How a submission ended, for the code that waits on one: the satan.post task
// today, and the bridge's inbound withdrawal notice later.

import type { SettledSubmissionRecord } from "@earendil-works/pi-durable";

/** How a post's input ended: delivered, withdrawn (never placed), or placed but unanswered. */
export type Ending =
  | { kind: "delivered" }
  | { kind: "withdrawn"; reason: string }
  | { kind: "delivered-incomplete"; reason: string };

/** What a settled record means (DEC-045): done is delivered; else its entry decides. */
export const endingOf = (record: SettledSubmissionRecord): Ending => {
  if (record.status === "done") {
    return { kind: "delivered" };
  }
  const reason = `unanswered (${record.reason})`;
  return record.type === "input" && record.entry !== undefined
    ? { kind: "delivered-incomplete", reason }
    : { kind: "withdrawn", reason };
};
