// The job in the room (one at a time, DEC-056): what the harness's env
// factory, the guard and the model gate see of it. The scheduler seats a job
// before its first turn and unseats it when its run settles; the harness and
// the guard, built before any job runs, look it up by conversation id; the
// gate, which pi tells no conversation, charges whoever is seated.

import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { conversationText } from "./durable-ids.ts";
import type { GuardedJob } from "./guard.ts";
import type { GateJob } from "./model-gate.ts";

export interface Tenant extends GuardedJob, GateJob {
  /** The job's conversation, as row text. */
  conversationId: string;
  env: ExecutionEnv;
}

export interface Tenancy {
  /** For `HarnessOptions.env`: the tenant's env for its conversation; none for any other. */
  env: (target: Pick<EnvTarget, "conversationId">) => ExecutionEnv | undefined;
  /** For the guard's `currentJob`. */
  guarded: (conversationId: string) => GuardedJob | undefined;
  /** For the model gate's `seated`: the tenant, if any. */
  seated: () => Tenant | undefined;
  enter: (tenant: Tenant) => void;
  /** Unseats job `jobId`; a no-op when another job is seated. */
  leave: (jobId: string) => void;
}

export function roomTenancy(): Tenancy {
  let tenant: Tenant | undefined;
  const of = (conversationId: string): Tenant | undefined =>
    tenant?.conversationId === conversationId ? tenant : undefined;
  function env(target: Pick<EnvTarget, "conversationId">): ExecutionEnv | undefined {
    return of(conversationText(target.conversationId))?.env;
  }
  function guarded(conversationId: string): GuardedJob | undefined {
    const seated = of(conversationId);
    return seated === undefined
      ? undefined
      : {
          id: seated.id,
          allowedPaths: seated.allowedPaths,
          root: seated.root,
          paused: seated.paused,
        };
  }
  function enter(next: Tenant): void {
    tenant = next;
  }
  function leave(jobId: string): void {
    if (tenant?.id === jobId) {
      tenant = undefined;
    }
  }
  return { env, guarded, seated: () => tenant, enter, leave };
}
