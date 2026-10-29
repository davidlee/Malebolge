// VT-2: the withhold policy table and the pre-filter over full answers. Question
// names and thresholds come from WITHHOLD_POLICY, never from literals here.

import { describe, expect, it } from "vitest";
import { REPORT_KINDS, WITHHOLD_POLICY, withholding } from "../../src/mail/policy.ts";
import type { ClassifyOutcome, Unclassified } from "../../src/mail/source.ts";
import { loadData, mustCheck, setAt } from "./mail-fixtures.ts";

const TEMPLATE = loadData("classify", "contract/classify.json");

/** A policy question's answer just below its threshold. */
function below(row: (typeof WITHHOLD_POLICY)[number]): [string, unknown] {
  return [row.question, { noul: row.atLeast - 0.01 }];
}

/** Every policy question answered below its threshold (given a fresh array each call). */
function belowAll(): [string, unknown][] {
  return WITHHOLD_POLICY.map(below);
}

/** `belowAll`, except that `question` is answered by `answer`. */
function withAnswer(question: string, answer: unknown): [string, unknown][] {
  return [...belowAll().filter(([name]) => name !== question), [question, answer]];
}

/** A classified outcome whose answers are `entries`, from the contract fixture. */
function classified(entries: readonly (readonly [string, unknown])[]): ClassifyOutcome {
  const answers = Object.fromEntries(entries);
  return { id: "Msg1", classified: mustCheck("classify", setAt(TEMPLATE, ["answers"], answers)) };
}

describe("withholding", () => {
  describe("reported", () => {
    it.each(REPORT_KINDS)("reports %s before a hostile classification", (kind) => {
      const hostile = classified(
        WITHHOLD_POLICY.map((row): [string, unknown] => [row.question, { noul: 1 }]),
      );

      expect(withholding(hostile, kind)).toEqual({ reason: "reported", detail: kind });
    });

    it("reports before an unclassified outcome", () => {
      expect(withholding({ id: "Msg1", unclassified: "too_large" }, "phishing")).toEqual({
        reason: "reported",
        detail: "phishing",
      });
    });
  });

  describe("unclassified", () => {
    it.each(["too_large", "unavailable", "failed"] as const)(
      "withholds with unclassified: %s",
      (reason) => {
        const unclassified: Unclassified = reason;

        expect(withholding({ id: "Msg1", unclassified }, undefined)).toEqual({
          reason: "unclassified",
          detail: reason,
        });
      },
    );
  });

  describe("missing_question", () => {
    it.each(WITHHOLD_POLICY)(
      `withholds with missing_question when $question's answer is absent`,
      (row) => {
        const answers = belowAll().filter(([name]) => name !== row.question);

        expect(withholding(classified(answers), undefined)).toEqual({
          reason: "missing_question",
          detail: row.question,
        });
      },
    );

    it.each([
      { name: "choice", answer: { choice: "payment_due", confidence: 0.7 } },
      { name: "score", answer: { score: 0.9, confidence: 0.6 } },
    ])("withholds with missing_question for a $name answer, not a noul", ({ answer }) => {
      for (const row of WITHHOLD_POLICY) {
        expect(withholding(classified(withAnswer(row.question, answer)), undefined)).toEqual({
          reason: "missing_question",
          detail: row.question,
        });
      }
    });

    it("withholds missing_question for a later absent row, however hostile an earlier one", () => {
      const [hostile, absent] = WITHHOLD_POLICY;
      const answers = withAnswer(hostile.question, { noul: 1 }).filter(
        ([name]) => name !== absent.question,
      );

      expect(withholding(classified(answers), undefined)).toEqual({
        reason: "missing_question",
        detail: absent.question,
      });
    });

    it("names the first missing_question in WITHHOLD_POLICY order when both are absent", () => {
      expect(withholding(classified([]), undefined)).toEqual({
        reason: "missing_question",
        detail: WITHHOLD_POLICY[0].question,
      });
    });
  });

  describe("hostile", () => {
    it.each(WITHHOLD_POLICY)("withholds a hostile $question at its threshold", (row) => {
      const answers = withAnswer(row.question, { noul: row.atLeast });

      expect(withholding(classified(answers), undefined)).toEqual({
        reason: "hostile",
        detail: row.question,
        score: row.atLeast,
      });
    });

    it("names the first hostile row in WITHHOLD_POLICY order when both are above", () => {
      const answers = WITHHOLD_POLICY.map((row): [string, unknown] => [
        row.question,
        { noul: row.atLeast + 0.1 },
      ]);

      expect(withholding(classified(answers), undefined)).toEqual({
        reason: "hostile",
        detail: WITHHOLD_POLICY[0].question,
        score: WITHHOLD_POLICY[0].atLeast + 0.1,
      });
    });
  });

  describe("shown", () => {
    it("shows an item whose every policy answer is below its threshold", () => {
      expect(withholding(classified(belowAll()), undefined)).toBeUndefined();
    });

    it("shows an item with a non-policy question at 1.0, which is ignored", () => {
      const extra: [string, unknown] = ["recipient_action_requested", { noul: 1 }];

      expect(withholding(classified([...belowAll(), extra]), undefined)).toBeUndefined();
    });
  });
});
