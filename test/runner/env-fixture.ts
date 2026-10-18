// Spike of the room-down seam (DEC-055, RV-025 F-2/F-17): the pause recorded
// durably on the host's adapter when src/runner/env.ts's JobConnection sees a
// lost connection. PHASE-09 builds the real mark in the runner store.

import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { LostFailure } from "../../src/runner/env.ts";

export const PAUSE_SCHEMA = `
CREATE TABLE IF NOT EXISTS runner_jobs (
  id TEXT PRIMARY KEY,
  pause_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
)`;

/** `pause_requested = 1` and its event, in one host transaction on the shared adapter. */
export async function markPause(
  db: SqliteDatabase,
  job: string,
  failure: LostFailure,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO runner_jobs (id, pause_requested) VALUES (?, 1) " +
        "ON CONFLICT (id) DO UPDATE SET pause_requested = 1",
      job,
    );
    await tx.run(
      "INSERT INTO job_events (job, kind, payload) VALUES (?, 'pause_requested', ?)",
      job,
      JSON.stringify(failure),
    );
  });
}

export async function pauseRequested(db: SqliteDatabase, job: string): Promise<boolean> {
  const row = await db.get<{ pause_requested: number }>(
    "SELECT pause_requested FROM runner_jobs WHERE id = ?",
    job,
  );
  return row?.pause_requested === 1;
}
