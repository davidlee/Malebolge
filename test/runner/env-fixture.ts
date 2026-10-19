// The runner's connection facts for tests, and the PHASE-01 spike's pause
// table (DEC-055, RV-025 F-2/F-17), kept for the live room-stop spike; the
// runner's own mark is `JobStore.markPause`. Room-level connections are in
// test/room/connection-fixture.ts.

import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { Launch, LostFailure, RoomConnection } from "../../src/room/connection.ts";
import type { RunnerConfig } from "../../src/runner/config.ts";
import { daemonLaunch, roomConnection } from "../../src/runner/door.ts";

/** The configured connection facts, and repo `satan`'s launch. */
export function doorFacts(config: RunnerConfig): { facts: RoomConnection; launch: Launch } {
  const repo = config.repos.get("satan");
  if (repo === undefined) {
    throw new Error("fixture has no repo satan");
  }
  return { facts: roomConnection(config), launch: daemonLaunch(config, repo) };
}

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
