// Spike of the room-down seam (DEC-055, RV-025 F-2/F-17): recognise pi-env's
// lost-connection failure by type where it is still typed, and record the pause
// durably on the host's adapter before pi-durable turns it into text.
// PHASE-09 builds the real one in src/runner/env.ts.

import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import {
  Connection,
  isConnectionLost,
  RemoteError,
  type RemoteInfo,
  type Reply,
  type RequestOptions,
} from "@earendil-works/pi-env";

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

/** What the seam saw of a failure, by type and fields only. */
export interface LostFailure {
  op: string;
  name: string;
  code: string;
  lost: unknown;
}

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

export interface ConnectionObserver {
  /** A request failed because the connection was lost; settles before the failure is rethrown. */
  lost: (failure: LostFailure, error: unknown) => Promise<void>;
  /** Any other failure, for the record only. */
  failed?: (op: string, error: unknown) => void;
  /** A request was sent (its id and daemon session). */
  started?: (op: string, id: number, session: number) => void;
}

/**
 * `inner`, observed: a request that fails with `isConnectionLost` reports it
 * and awaits the report before rethrowing. pi-env's `Connection` has private
 * fields, so the seam is a subclass delegating every public method; its own
 * (never started) connection has no command.
 */
export class ObservedConnection extends Connection {
  readonly #inner: Connection;
  readonly #observer: ConnectionObserver;

  constructor(inner: Connection, observer: ConnectionObserver) {
    super({ command: [] });
    this.#inner = inner;
    this.#observer = observer;
  }

  // `info` and `session` connect too: a file op resolving a path can lose the
  // connection there before it sends any request.
  override info(): Promise<RemoteInfo> {
    return this.#observe("info", () => this.#inner.info());
  }

  override session(): Promise<number> {
    return this.#observe("session", () => this.#inner.session());
  }

  override request(
    op: string,
    json: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<Reply> {
    const started = this.#observer.started;
    const observed: RequestOptions = {
      ...options,
      onStart: (id, session) => {
        options.onStart?.(id, session);
        started?.(op, id, session);
      },
    };
    return this.#observe(op, () => this.#inner.request(op, json, observed));
  }

  async #observe<T>(op: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      // isConnectionLost is `instanceof RemoteError && fields.lost === true`; never the message.
      if (error instanceof RemoteError && isConnectionLost(error)) {
        await this.#observer.lost(describeLost(op, error), error);
      } else {
        this.#observer.failed?.(op, error);
      }
      throw error;
    }
  }

  override close(): void {
    this.#inner.close();
  }

  override kill(id: number, session: number): void {
    this.#inner.kill(id, session);
  }
}

const describeLost = (op: string, error: RemoteError): LostFailure => ({
  op,
  name: error.name,
  code: error.code,
  lost: error.fields["lost"],
});
