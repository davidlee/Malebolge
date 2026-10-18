// The runner's store (design §5.3; DEC-052, DEC-054, DEC-057): one SQLite file
// behind one node:sqlite adapter, shared by pi-durable (tables prefixed `pi_`)
// and the host's job tables. The runner is the sole schema owner and migrator.
// Every job write runs in one host transaction with its `job_events` row; all
// work inside a transaction uses its handle, never `db` (that deadlocks).

import {
  type SqliteDatabase,
  type SqliteExecutor,
  SqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { setDefined } from "../fields.ts";
import type { JsonRecord } from "../json.ts";
import { RunnerError } from "./errors.ts";
import { type JobIdFactory, systemJobIds } from "./ids.ts";
import { cancel, type JobPatch, markPauseRequested, transition } from "./jobs.ts";
import type { ListRequest } from "./protocol.ts";
import {
  columnOf,
  decodeEvent,
  decodeJob,
  decodeSchemaVersion,
  encodeEvent,
  encodeJob,
  type Job,
  type JobEvent,
  type NewEvent,
  type NewJob,
  type Row,
} from "./rows.ts";
import type { EventKind, JobState } from "./vocab.ts";

export type { Job, JobEvent, NewJob } from "./rows.ts";

/** pi-durable's table prefix in the shared file. */
export const PI_PREFIX = "pi_";

// --- schema ----------------------------------------------------------------------

/** v1: the §5.3 DDL, plus `ceilings` (submit-time lowered ceilings, OQ-A) and the append-only triggers. */
const V1 = `
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,          -- pj-<ULID>
  submission_id   TEXT NOT NULL UNIQUE,      -- idempotent submit
  conversation_id TEXT UNIQUE,               -- pi-durable conversation; null until created
  state           TEXT NOT NULL CHECK (state IN ('queued','preparing','running',
                    'waiting_room','collecting','pending_collection','needs_review',
                    'promoted','rejected','cancelled','failed')),
  mode            TEXT NOT NULL,
  directive       TEXT NOT NULL,
  repo            TEXT NOT NULL,
  base_ref        TEXT NOT NULL,             -- resolved branch name
  allowed_paths   TEXT NOT NULL,             -- JSON array
  tags            TEXT NOT NULL DEFAULT '[]',
  context         TEXT NOT NULL DEFAULT '{}',
  source          TEXT NOT NULL DEFAULT '{}',
  ceilings        TEXT NOT NULL DEFAULT '{}', -- submit-time lowered ceilings, JSON
  policy          TEXT,                      -- resolved ladder output, JSON
  base_oid        TEXT,                      -- set at refresh
  end_reason      TEXT,                      -- completed|ceiling_exceeded|usage_unavailable|cancelled|room_unavailable|error
  pause_requested INTEGER NOT NULL DEFAULT 0, -- written by the env wrapper
  pause_count     INTEGER NOT NULL DEFAULT 0, -- waiting episodes; names resume messages
  state_entered_at TEXT NOT NULL,           -- set on every transition; bounds waits
  running_since   TEXT,                      -- start of the current running segment
  active_ms       INTEGER NOT NULL DEFAULT 0, -- closed running segments
  model_requests  INTEGER NOT NULL DEFAULT 0, -- provider attempts, counted by the model gate
  reviewed_oid    TEXT,                      -- immutable once set
  quarantine_ref  TEXT,
  class           TEXT,                      -- complete|partial|no_changes|path_violation|error
  failure         TEXT,                      -- reason for failed/cancelled, JSON
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  announced_at    TEXT                       -- failed/cancelled notice acked by Emacs
);
CREATE INDEX jobs_state_created ON jobs(state, created_at);

CREATE TABLE job_events (                    -- append-only audit (DEC-057)
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL REFERENCES jobs(id),
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,                     -- submitted|transition|policy|blocked_tool|warning|ceiling|pause|resume|collected|classified|disposition|...
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER job_events_no_update BEFORE UPDATE ON job_events
  BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
CREATE TRIGGER job_events_no_delete BEFORE DELETE ON job_events
  BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
`;

/**
 * `MIGRATIONS[i]` takes the job schema from version i to i + 1. BINDING: a
 * shipped migration is never edited or reordered; new ones append.
 */
export const MIGRATIONS: readonly string[] = [V1];

/**
 * Brings `db`'s job schema to `migrations.length`: every pending migration
 * and the version bump in one transaction. A newer schema refuses (fail
 * closed: a newer runner wrote it).
 */
export async function migrate(
  db: SqliteDatabase,
  migrations: readonly string[] = MIGRATIONS,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec("CREATE TABLE IF NOT EXISTS job_schema (version INTEGER NOT NULL)");
    await tx.run(
      "INSERT INTO job_schema (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM job_schema)",
    );
    const version = decodeSchemaVersion(await tx.all<JsonRecord>("SELECT version FROM job_schema"));
    if (version > migrations.length) {
      throw new Error(
        `job schema version ${String(version)} is newer than this runner's ${String(migrations.length)}`,
      );
    }
    for (const migration of migrations.slice(version)) {
      await tx.exec(migration);
    }
    await tx.run("UPDATE job_schema SET version = ?", migrations.length);
  });
}

// --- statements ----------------------------------------------------------------

async function insert(tx: SqliteExecutor, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  await tx.run(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ...Object.values(row),
  );
}

/** Writes the `fields` of `job` to its row. */
async function updateJob(tx: SqliteExecutor, job: Job, fields: readonly string[]): Promise<void> {
  const columns = fields.map(columnOf);
  const changed = Object.entries(encodeJob(job)).filter(([column]) => columns.includes(column));
  await tx.run(
    `UPDATE jobs SET ${changed.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
    ...changed.map(([, value]) => value),
    job.id,
  );
}

async function selectJob(
  executor: SqliteExecutor,
  column: "id" | "submission_id",
  value: string,
): Promise<Job | undefined> {
  const row = await executor.get<JsonRecord>(`SELECT * FROM jobs WHERE ${column} = ?`, value);
  return row === undefined ? undefined : decodeJob(row);
}

async function requireJob(tx: SqliteExecutor, id: string): Promise<Job> {
  const job = await selectJob(tx, "id", id);
  if (job === undefined) {
    throw new RunnerError("unknown_job", `no job ${id}`);
  }
  return job;
}

// --- the job store ---------------------------------------------------------------

/** The fields one change writes: absent fields are unchanged, `null` clears. */
export type JobUpdate = Partial<JobPatch> &
  Partial<
    Pick<
      Job,
      | "conversationId"
      | "announcedAt"
      | "policy"
      | "baseOid"
      | "reviewedOid"
      | "quarantineRef"
      | "class"
      | "failure"
    >
  >;

/** A row change and the event recording it. */
export interface Change {
  update: JobUpdate;
  event: Pick<NewEvent, "kind" | "payload">;
}

/** What a change makes of the current job; `undefined` writes nothing. */
export type Decide = (job: Job) => Change | undefined;

export interface Submitted {
  job: Job;
  /** `false` when the submission id was already known: `job` is the first one. */
  created: boolean;
}

export type JobFilter = Pick<ListRequest, "states" | "limit">;

/** What the model gate makes of a request: count it, or refuse it with the `ceiling` event's payload. */
export type RequestVerdict = { kind: "admit" } | { kind: "refuse"; ceiling: JsonRecord };

/** Told of each committed job write: the job as written and its event's kind. */
export type JobListener = (job: Job, kind: EventKind) => void;

/** `job` with `update` applied at `now`. */
function applyUpdate(job: Job, update: JobUpdate, now: number): Job {
  const { runningSince, ...rest } = update;
  const next: Job = { ...job, ...rest, updatedAt: now };
  if (runningSince === null) {
    delete next.runningSince;
    return next;
  }
  return setDefined(next, { runningSince });
}

/**
 * A transition's change: the patch, with any `fields` written alongside it,
 * recorded with where it came from and went.
 */
function transitionChange(
  job: Job,
  patch: JobPatch,
  payload: JsonRecord = {},
  fields: JobUpdate = {},
): Change {
  return {
    update: { ...fields, ...patch },
    event: {
      kind: "transition",
      payload: setDefined<JsonRecord>(
        { ...payload, from: job.state, to: patch.state },
        { endReason: patch.endReason },
      ),
    },
  };
}

/** The host's jobs and their audit. Writes enact jobs.ts patches; legality lives there. */
export class JobStore {
  readonly #db: SqliteDatabase;
  readonly #newId: JobIdFactory;
  readonly #listeners = new Set<JobListener>();

  constructor(db: SqliteDatabase, newId: JobIdFactory = systemJobIds) {
    this.#db = db;
    this.#newId = newId;
  }

  /** Inserts a queued job and its `submitted` event, or returns the job already holding the submission id. */
  async submit(newJob: NewJob, now: number): Promise<Submitted> {
    const submitted = await this.#db.transaction(async (tx): Promise<Submitted> => {
      const existing = await selectJob(tx, "submission_id", newJob.submissionId);
      if (existing !== undefined) {
        return { job: existing, created: false };
      }
      const job: Job = {
        ...newJob,
        id: this.#newId(now),
        state: "queued",
        stateEnteredAt: now,
        activeMs: 0,
        pauseRequested: false,
        pauseCount: 0,
        modelRequests: 0,
        createdAt: now,
        updatedAt: now,
      };
      await insert(tx, "jobs", encodeJob(job));
      const payload: JsonRecord = { ...newJob };
      await insert(
        tx,
        "job_events",
        encodeEvent({ jobId: job.id, at: now, kind: "submitted", payload }),
      );
      return { job, created: true };
    });
    if (submitted.created) {
      this.#notify(submitted.job, "submitted");
    }
    return submitted;
  }

  /**
   * The one read-modify-write path: reads job `id`, applies what `decide`
   * makes of it and appends its event, in one transaction. `updated_at`
   * becomes `now`, the event's time.
   */
  async change(id: string, now: number, decide: Decide): Promise<Job> {
    const { job, kind } = await this.#db.transaction(
      async (tx): Promise<{ job: Job; kind?: EventKind }> => {
        const job = await requireJob(tx, id);
        const change = decide(job);
        if (change === undefined) {
          return { job };
        }
        const next = applyUpdate(job, change.update, now);
        await updateJob(tx, next, [...Object.keys(change.update), "updatedAt"]);
        await insert(tx, "job_events", encodeEvent({ jobId: id, at: now, ...change.event }));
        return { job: next, kind: change.event.kind };
      },
    );
    if (kind !== undefined) {
      this.#notify(job, kind);
    }
    return job;
  }

  /**
   * Calls `listener` after each committed job write (a created job, a change
   * that wrote), never inside the transaction. Returns the unsubscribe.
   */
  observe(listener: JobListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** A listener owns its failures: one that throws is skipped, the write stands. */
  #notify(job: Job, kind: EventKind): void {
    for (const listener of this.#listeners) {
      try {
        listener(job, kind);
      } catch {
        // The write has committed; a listener's bug must not report it as failed.
      }
    }
  }

  /** Moves job `id` to `to`; `payload` adds to the event, `fields` (an outcome) to the row. */
  transition(
    id: string,
    to: JobState,
    now: number,
    payload?: JsonRecord,
    fields?: JobUpdate,
  ): Promise<Job> {
    return this.change(id, now, (job) =>
      transitionChange(job, transition(job, to, now), payload, fields),
    );
  }

  /** Cancels job `id`; `payload` (e.g. the reason) adds to the event. */
  cancel(id: string, now: number, payload?: JsonRecord): Promise<Job> {
    return this.change(id, now, (job) => transitionChange(job, cancel(job, now), payload));
  }

  /** Records a room-down pause request once; `failure` is the event payload. */
  markPause(id: string, now: number, failure: JsonRecord): Promise<Job> {
    return this.change(id, now, (job) => {
      const update = markPauseRequested(job);
      return update === undefined
        ? undefined
        : { update, event: { kind: "pause", payload: failure } };
    });
  }

  /**
   * The model gate's durable count, in one transaction: reads job `id`, and as
   * `judge` decides either counts one model request (no event: a count is not
   * an enacted change, AS-6) or appends the job's one `ceiling` event, unless
   * it already has one. The judge decides; the store only enacts.
   */
  admitModelRequest<V extends RequestVerdict>(
    id: string,
    now: number,
    judge: (job: Job) => V,
  ): Promise<{ job: Job; verdict: V }> {
    return this.#db.transaction(async (tx) => {
      const job = await requireJob(tx, id);
      const verdict = judge(job);
      if (verdict.kind === "admit") {
        await tx.run("UPDATE jobs SET model_requests = model_requests + 1 WHERE id = ?", id);
        return { job: { ...job, modelRequests: job.modelRequests + 1 }, verdict };
      }
      const logged = await tx.get(
        "SELECT 1 FROM job_events WHERE job_id = ? AND kind = 'ceiling' LIMIT 1",
        id,
      );
      if (logged === undefined) {
        await insert(
          tx,
          "job_events",
          encodeEvent({ jobId: id, at: now, kind: "ceiling", payload: verdict.ceiling }),
        );
      }
      return { job, verdict };
    });
  }

  /** An event that changes no row (a warning receipt, a blocked tool, …). */
  appendEvent(id: string, now: number, kind: EventKind, payload: JsonRecord): Promise<void> {
    return this.#db.transaction(async (tx) => {
      await requireJob(tx, id);
      await insert(tx, "job_events", encodeEvent({ jobId: id, at: now, kind, payload }));
    });
  }

  get(id: string): Promise<Job | undefined> {
    return selectJob(this.#db, "id", id);
  }

  bySubmission(submissionId: string): Promise<Job | undefined> {
    return selectJob(this.#db, "submission_id", submissionId);
  }

  /** Jobs in creation order, optionally only in `states` and at most `limit`. */
  async list(filter: JobFilter = {}): Promise<Job[]> {
    const { states, limit } = filter;
    const where =
      states === undefined ? "" : `WHERE state IN (${states.map(() => "?").join(", ")})`;
    const limitClause = limit === undefined ? "" : "LIMIT ?";
    const rows = await this.#db.all<JsonRecord>(
      `SELECT * FROM jobs ${where} ORDER BY created_at, id ${limitClause}`,
      ...(states ?? []),
      ...(limit === undefined ? [] : [limit]),
    );
    return rows.map(decodeJob);
  }

  /** Job `id`'s events, oldest first. */
  async events(id: string): Promise<JobEvent[]> {
    const rows = await this.#db.all<JsonRecord>(
      "SELECT * FROM job_events WHERE job_id = ? ORDER BY seq",
      id,
    );
    return rows.map(decodeEvent);
  }
}

// --- opening ---------------------------------------------------------------------

export interface RunnerStore {
  /** The one adapter; host writes from inside a pi transaction never settle. */
  db: SqliteDatabase;
  /** pi-durable's storage on `db`. Closing it closes `db`. */
  storage: SqliteStorage;
  jobs: JobStore;
}

export interface RunnerStoreOptions {
  newId?: JobIdFactory;
}

/**
 * Opens the runner's SQLite file (`":memory:"` in tests). BINDING order: the
 * job schema is migrated before pi-durable opens its storage on the same
 * adapter (I2).
 */
export async function openRunnerStore(
  path: string,
  options: RunnerStoreOptions = {},
): Promise<RunnerStore> {
  const db = await openNodeSqliteDatabase(path);
  await db.exec("PRAGMA foreign_keys = ON");
  await migrate(db);
  const storage = await SqliteStorage.open(db, { prefix: PI_PREFIX });
  return { db, storage, jobs: new JobStore(db, options.newId) };
}
