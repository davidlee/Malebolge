// Job stores for tests: in-memory, closed when the test finishes, minting
// predictable ids.

import { onTestFinished } from "vitest";
import { context } from "../../src/context.ts";
import type { JobIdFactory } from "../../src/runner/ids.ts";
import type { NewJob } from "../../src/runner/rows.ts";
import { openRunnerStore, type RunnerStore } from "../../src/runner/store.ts";

export const T0 = Date.parse("2026-10-18T07:38:01.165Z");

/** A validated submission. */
export const NEW_JOB: NewJob = {
  submissionId: "sub-1",
  mode: "fix",
  directive: "Fix the parser.",
  repo: "satan",
  baseRef: "main",
  allowedPaths: ["src/"],
  tags: ["parser"],
  context: { inbox: "entry-1" },
  source: { from: "inbox" },
  ceilings: { model_requests: 5 },
};

/** `pj-1`, `pj-2`, … */
export function sequentialIds(): JobIdFactory {
  let next = 0;
  return () => `pj-${String(++next)}`;
}

/** An in-memory runner store, closed (pi storage and database) after the test. */
export async function openTestStore(): Promise<RunnerStore> {
  const store = await openRunnerStore(":memory:", { newId: sequentialIds() });
  onTestFinished(() => store.storage.close(context));
  return store;
}
