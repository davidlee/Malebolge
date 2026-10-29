// The withhold policy table, the only src place a question is named (CON-001),
// and the pre-filter over full answers (SL-007 design, § The pre-filter).

import type { Classification, ClassifyOutcome, Unclassified } from "./source.ts";

/** Withhold when a named question's noul reaches its threshold. Tuned with IMP-003. */
export const WITHHOLD_POLICY = [
  { question: "agent_directive", atLeast: 0.5 },
  { question: "deception_cues", atLeast: 0.5 },
] as const;

/** A question the policy table names. */
export type PolicyQuestion = (typeof WITHHOLD_POLICY)[number]["question"];

/** What `mail_report` accepts. */
export const REPORT_KINDS = [
  "instructions_to_agent",
  "phishing",
  "impersonation",
  "malware",
  "other",
] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

/** Why a message is withheld; `undefined` means it is shown. */
export type Withheld =
  | { reason: "reported"; detail: ReportKind }
  | { reason: "unclassified"; detail: Unclassified }
  | { reason: "missing_question"; detail: PolicyQuestion }
  | { reason: "hostile"; detail: PolicyQuestion; score: number };

/** One question's answer as the contract allows it. */
type Answer = Classification["answers"][string];

/** The answer's noul, or undefined when the question is absent or answered in another shape. */
const noulOf = (answer: Answer | undefined): number | undefined =>
  answer !== undefined && "noul" in answer ? answer.noul : undefined;

/** Why this message is withheld, or undefined when it is shown. Pure. */
export function withholding(
  outcome: ClassifyOutcome,
  reported: ReportKind | undefined,
): Withheld | undefined {
  if (reported !== undefined) {
    return { reason: "reported", detail: reported };
  }
  if (!("classified" in outcome)) {
    return { reason: "unclassified", detail: outcome.unclassified };
  }
  const { answers } = outcome.classified;
  // Every question must be present as a noul before any hostility check: a row-by-row
  // loop would answer hostile for an earlier row and never notice a later one missing.
  const absent = WITHHOLD_POLICY.find((row) => noulOf(answers[row.question]) === undefined);
  if (absent !== undefined) {
    return { reason: "missing_question", detail: absent.question };
  }
  for (const row of WITHHOLD_POLICY) {
    const noul = noulOf(answers[row.question]);
    if (noul !== undefined && noul >= row.atLeast) {
      return { reason: "hostile", detail: row.question, score: noul };
    }
  }
  return undefined;
}
