// pi-env connections for tests: a real local daemon, one that is lost before
// it starts, and one that fails chosen calls. Also the PHASE-01 spike's pause
// table (DEC-055, RV-025 F-2/F-17), kept for the live room-stop spike; the
// runner's own mark is `JobStore.markPause`.

import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import {
  Connection,
  localDaemon,
  RemoteError,
  type RemoteInfo,
  type Reply,
  type RequestOptions,
} from "@earendil-works/pi-env";
import type { LostFailure } from "../../src/runner/env.ts";

/** A real local pi-env daemon (the binary pi-env ships for this machine). */
export const localConnection = (): Connection => new Connection({ command: [localDaemon()] });

/** A daemon that exits before it is ready: pi-env's own lost failure, deterministically. */
export const lostConnection = (): Connection => new Connection({ command: ["sh", "-c", "exit 3"] });

/** The text pi-env gives a lost connection. */
export const LOST_TEXT = "pi-env connection lost";

/** A failure typed as pi-env types a lost connection (`isConnectionLost`). */
export const lostError = (code = "unknown"): RemoteError =>
  new RemoteError({ code, message: LOST_TEXT, lost: true });

/** What a `FailingConnection` call is: `info`, `session`, or a request's op and body. */
export interface ConnectionCall {
  op: string;
  json?: Record<string, unknown>;
}

/** Which calls fail, and with what; `undefined` lets the call through. */
export type FailWhen = (call: ConnectionCall) => Error | undefined;

const STUB_INFO: RemoteInfo = {
  protocol: 1,
  version: "0",
  os: "linux",
  arch: "x86_64",
  home: "/tmp",
  tmpdir: "/tmp",
  separator: "/",
  cwd: "/tmp",
  driveCwds: {},
  pid: 0,
};

/**
 * `inner`, except the calls `failWhen` names, which reject with its error.
 * Without `inner` nothing runs: `info` and `session` answer a stub, and a
 * request that does not fail is refused.
 */
export class FailingConnection extends Connection {
  readonly #failWhen: FailWhen;
  readonly #inner: Connection | undefined;

  constructor(failWhen: FailWhen, inner?: Connection) {
    super({ command: [] });
    this.#failWhen = failWhen;
    this.#inner = inner;
  }

  override info(): Promise<RemoteInfo> {
    return this.#call({ op: "info" }, () => this.#inner?.info() ?? Promise.resolve(STUB_INFO));
  }

  override session(): Promise<number> {
    return this.#call({ op: "session" }, () => this.#inner?.session() ?? Promise.resolve(1));
  }

  override request(
    op: string,
    json: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<Reply> {
    return this.#call(
      { op, json },
      () => this.#inner?.request(op, json, options) ?? Promise.reject(new Error("no daemon")),
    );
  }

  #call<T>(call: ConnectionCall, through: () => Promise<T>): Promise<T> {
    const error = this.#failWhen(call);
    return error === undefined ? through() : Promise.reject(error);
  }

  override close(): void {
    this.#inner?.close();
  }

  override kill(id: number, session: number): void {
    this.#inner?.kill(id, session);
  }
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
