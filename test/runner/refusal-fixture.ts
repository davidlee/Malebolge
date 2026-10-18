// What a runner operation refused with: the RunnerError code, or a sentinel
// naming what happened instead, so a wrong outcome fails with a readable diff.

import { isRunnerError } from "../../src/runner/errors.ts";

const codeOfError = (error: unknown): string =>
  isRunnerError(error) ? error.code : `not a RunnerError: ${String(error)}`;

/** The `RunnerError` code `run` throws. */
export function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return codeOfError(error);
  }
  return "did not throw";
}

/** The `RunnerError` code `promise` rejects with. */
export async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return codeOfError(error);
  }
  return "did not reject";
}
