// Room down: the pause (design §5.4, amended DEC-055).

import type { ConnectionObserver } from "./env.ts";
import type { JobStore } from "./store.ts";

export interface PauseDeps {
  jobs: Pick<JobStore, "markPause">;
  now: () => number;
}

/**
 * The running job's connection observer: a lost connection marks the job
 * `pause_requested` with a `pause` event, settled before the failure is
 * rethrown. Idempotent in the store (one stop raises two lost failures).
 */
export function pausingObserver(deps: PauseDeps, jobId: string): ConnectionObserver {
  return {
    lost: async (failure): Promise<void> => {
      await deps.jobs.markPause(jobId, deps.now(), { ...failure });
    },
  };
}
