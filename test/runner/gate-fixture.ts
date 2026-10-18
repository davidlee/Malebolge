// Spike of the model gate (design §6 OQ-1, DEC-057): a Models view whose two
// provider entry points pass a durable request budget before any provider call.
// PHASE-08 builds the real one in src/runner/model-gate.ts.

import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";

export type EntryPoint = "streamSimple" | "completeSimple";

/** One row per admitted provider request: the durable attempt counter. */
export const ATTEMPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS runner_attempts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_point TEXT NOT NULL
)`;

/** The gate's refusal, as the model run sees it. Not provider-retryable wording. */
export const GATE_REFUSAL = "model gate refused the request: request ceiling reached";

export type Gate = {
  /** Count the request durably, or throw once `budget` requests were admitted. */
  admit: (entryPoint: EntryPoint) => Promise<void>;
  /** Admitted requests, oldest first. */
  attempts: () => Promise<EntryPoint[]>;
};

export function requestGate(db: SqliteDatabase, budget: number): Gate {
  return {
    admit: (entryPoint) =>
      db.transaction(async (tx) => {
        const row = await tx.get<{ n: number }>("SELECT count(*) AS n FROM runner_attempts");
        if ((row?.n ?? 0) >= budget) throw new Error(GATE_REFUSAL);
        await tx.run("INSERT INTO runner_attempts (entry_point) VALUES (?)", entryPoint);
      }),
    attempts: async () =>
      (
        await db.all<{ entry_point: EntryPoint }>(
          "SELECT entry_point FROM runner_attempts ORDER BY seq",
        )
      ).map((row) => row.entry_point),
  };
}

/**
 * `real` with `streamSimple` and `completeSimple` behind `gate`; everything else
 * passes through. A refusal ends the stream with an error message and no
 * provider call, as a provider setup failure would. `completeSimple` is
 * pi-ai's own definition, the gated stream's result.
 */
export function gatedModels(real: Models, gate: Gate): Models {
  const gated = (entryPoint: EntryPoint, ...args: Parameters<Models["streamSimple"]>) =>
    lazyStream(args[0], async () => {
      await gate.admit(entryPoint);
      return real.streamSimple(...args);
    });
  const overrides: Partial<Models> = {
    streamSimple: (...args) => gated("streamSimple", ...args),
    completeSimple: (...args) => gated("completeSimple", ...args).result(),
  };
  return new Proxy(real, {
    get(target, key) {
      if (key in overrides) return overrides[key as keyof Models];
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
