import { type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { describe, expect, it, onTestFinished } from "vitest";
import { context } from "../../src/context.ts";
import type { JsonRecord } from "../../src/json.ts";
import { columnOf, JOB_FIELDS } from "../../src/runner/rows.ts";
import {
  type JobStore,
  MIGRATIONS,
  migrate,
  openRunnerStore,
  PI_PREFIX,
  type RequestVerdict,
} from "../../src/runner/store.ts";
import { JOB_STATES } from "../../src/runner/vocab.ts";
import { openFauxHarness } from "../harness-fixture.ts";
import { closeHarness } from "./runner-fixture.ts";
import { NEW_JOB, openTestStore, sequentialIds, T0 } from "./store-fixture.ts";
import { rejectionCode } from "./refusal-fixture.ts";

/** The §5.3 `jobs` columns in DDL order, `ceilings` after `source` (OQ-A). */
const JOBS_COLUMNS = [
  "id",
  "submission_id",
  "conversation_id",
  "state",
  "mode",
  "directive",
  "repo",
  "base_ref",
  "allowed_paths",
  "tags",
  "context",
  "source",
  "ceilings",
  "policy",
  "base_oid",
  "end_reason",
  "pause_requested",
  "pause_count",
  "state_entered_at",
  "running_since",
  "active_ms",
  "model_requests",
  "reviewed_oid",
  "quarantine_ref",
  "class",
  "failure",
  "created_at",
  "updated_at",
  "started_at",
  "finished_at",
  "announced_at",
];

const HOST_OBJECTS = [
  "job_events",
  "job_events_no_delete",
  "job_events_no_update",
  "job_schema",
  "jobs",
  "jobs_state_created",
  "sqlite_autoindex_jobs_1",
  "sqlite_autoindex_jobs_2",
  "sqlite_autoindex_jobs_3",
  "sqlite_sequence",
];

/** A bare in-memory database, closed after the test. */
async function openBareDb(): Promise<SqliteDatabase> {
  const db = await openNodeSqliteDatabase(":memory:");
  onTestFinished(() => db.close());
  return db;
}

interface SchemaObject {
  name: string;
  /** The table it belongs to (itself, for a table). */
  table: string;
}

async function schemaObjects(db: SqliteDatabase): Promise<SchemaObject[]> {
  return db.all<SchemaObject>('SELECT name, tbl_name AS "table" FROM sqlite_master ORDER BY name');
}

const namesOf = (objects: readonly SchemaObject[]): string[] => objects.map(({ name }) => name);

async function schemaVersions(db: SqliteDatabase): Promise<number[]> {
  const rows = await db.all<{ version: number }>("SELECT version FROM job_schema");
  return rows.map((row) => row.version);
}

async function rawRow(db: SqliteDatabase, id: string): Promise<JsonRecord | undefined> {
  return db.get<JsonRecord>("SELECT * FROM jobs WHERE id = ?", id);
}

/** A database refusing every new event. */
const refuseEvents = (db: SqliteDatabase): Promise<void> =>
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON job_events BEGIN SELECT RAISE(ABORT, 'boom'); END");

describe("migrate", () => {
  it("creates job_schema, jobs, job_events, the index and both triggers at the latest version", async () => {
    const db = await openBareDb();
    await migrate(db);
    expect(namesOf(await schemaObjects(db))).toEqual(HOST_OBJECTS);
    expect(await schemaVersions(db)).toEqual([MIGRATIONS.length]);
  });

  it("lays out the jobs columns in the §5.3 order, which the codec follows", async () => {
    const db = await openBareDb();
    await migrate(db);
    const columns = await db.all<{ name: string }>("PRAGMA table_info(jobs)");
    expect(columns.map((column) => column.name)).toEqual(JOBS_COLUMNS);
    expect(JOB_FIELDS.map(columnOf)).toEqual(JOBS_COLUMNS);
  });

  it("admits every job state in the state CHECK", async () => {
    const db = await openBareDb();
    await migrate(db);
    const jobs = await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'jobs'");
    for (const state of JOB_STATES) {
      expect(jobs?.sql).toContain(`'${state}'`);
    }
  });

  it("is a no-op when the schema is current", async () => {
    const db = await openBareDb();
    await migrate(db);
    await migrate(db);
    expect(await schemaVersions(db)).toEqual([MIGRATIONS.length]);
    expect(namesOf(await schemaObjects(db))).toEqual(HOST_OBJECTS);
  });

  it("refuses a schema written by a newer runner", async () => {
    const db = await openBareDb();
    await migrate(db);
    await db.run("UPDATE job_schema SET version = ?", MIGRATIONS.length + 1);
    await expect(migrate(db)).rejects.toThrow(/newer/);
  });

  it("refuses a job_schema holding other than one row", async () => {
    const db = await openBareDb();
    await migrate(db);
    await db.run("INSERT INTO job_schema (version) VALUES (0)");
    await expect(migrate(db)).rejects.toThrow(/job_schema/);
  });

  it("rolls a failing migration back, leaving version and tables unchanged", async () => {
    const db = await openBareDb();
    await migrate(db);
    const failing = [...MIGRATIONS, "CREATE TABLE extra (a); INSERT INTO nowhere VALUES (1);"];
    await expect(migrate(db, failing)).rejects.toThrow(/nowhere/);
    expect(await schemaVersions(db)).toEqual([MIGRATIONS.length]);
    expect(namesOf(await schemaObjects(db))).toEqual(HOST_OBJECTS);
  });
});

describe("submit: idempotent by submission_id", () => {
  it("inserts a queued job and one submitted event carrying the request", async () => {
    const { jobs } = await openTestStore();
    const { job, created } = await jobs.submit(NEW_JOB, T0);
    expect(created).toBe(true);
    expect(job).toEqual({
      ...NEW_JOB,
      id: "pj-1",
      state: "queued",
      stateEnteredAt: T0,
      activeMs: 0,
      pauseRequested: false,
      pauseCount: 0,
      modelRequests: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await jobs.get("pj-1")).toEqual(job);
    expect(await jobs.events("pj-1")).toEqual([
      { seq: 1, jobId: "pj-1", at: T0, kind: "submitted", payload: { ...NEW_JOB } },
    ]);
  });

  it("returns the first job for a repeated submission_id, even with other fields, and writes no event", async () => {
    const { jobs } = await openTestStore();
    const first = await jobs.submit(NEW_JOB, T0);
    const again = await jobs.submit({ ...NEW_JOB, directive: "Something else." }, T0 + 5);
    expect(again).toEqual({ job: first.job, created: false });
    expect(await jobs.events(first.job.id)).toHaveLength(1);
    expect(await jobs.bySubmission(NEW_JOB.submissionId)).toEqual(first.job);
  });

  it("gives a different submission_id a new job", async () => {
    const { jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    const second = await jobs.submit({ ...NEW_JOB, submissionId: "sub-2" }, T0 + 1);
    expect(second.created).toBe(true);
    expect(second.job.id).toBe("pj-2");
  });
});

describe("job_events is append-only", () => {
  it("refuses UPDATE on job_events and keeps the row", async () => {
    const { db, jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    const before = await jobs.events("pj-1");
    await expect(db.run("UPDATE job_events SET kind = 'warning'")).rejects.toThrow(
      /job_events is append-only/,
    );
    expect(await jobs.events("pj-1")).toEqual(before);
  });

  it("refuses DELETE on job_events and keeps the row", async () => {
    const { db, jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    const before = await jobs.events("pj-1");
    await expect(db.run("DELETE FROM job_events")).rejects.toThrow(/job_events is append-only/);
    expect(await jobs.events("pj-1")).toEqual(before);
  });
});

describe("the transition writer", () => {
  it("maintains state_entered_at, running_since, active_ms and pause_count through a run", async () => {
    const { jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    await jobs.transition("pj-1", "preparing", T0 + 10);
    const running = await jobs.transition("pj-1", "running", T0 + 20);
    expect(running).toMatchObject({ startedAt: T0 + 20, runningSince: T0 + 20 });
    await jobs.markPause("pj-1", T0 + 25, { op: "exec" });
    const waiting = await jobs.transition("pj-1", "waiting_room", T0 + 120);
    expect(waiting).toMatchObject({
      state: "waiting_room",
      stateEnteredAt: T0 + 120,
      activeMs: 100,
      pauseRequested: false,
      pauseCount: 1,
    });
    expect(waiting.runningSince).toBeUndefined();
    const resumed = await jobs.transition("pj-1", "running", T0 + 500);
    expect(resumed).toMatchObject({ runningSince: T0 + 500, startedAt: T0 + 20 });
    await jobs.transition("pj-1", "collecting", T0 + 550);
    await jobs.transition("pj-1", "needs_review", T0 + 600);
    const promoted = await jobs.transition("pj-1", "promoted", T0 + 700);
    expect(promoted).toMatchObject({
      finishedAt: T0 + 700,
      activeMs: 150,
      stateEnteredAt: T0 + 700,
    });
    expect(await jobs.get("pj-1")).toEqual(promoted);
  });

  it("writes exactly one event per change, at the row's updated_at", async () => {
    const { jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    const job = await jobs.transition("pj-1", "preparing", T0 + 10, { reason: "scheduled" });
    const events = await jobs.events("pj-1");
    expect(events.map((event) => event.kind)).toEqual(["submitted", "transition"]);
    expect(events[1]).toMatchObject({
      at: job.updatedAt,
      payload: { reason: "scheduled", from: "queued", to: "preparing" },
    });
  });

  it("writes collection's outcome fields with a transition, in its one event", async () => {
    const { jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    await jobs.transition("pj-1", "preparing", T0 + 1);
    await jobs.transition("pj-1", "running", T0 + 2);
    await jobs.transition("pj-1", "collecting", T0 + 3);
    await jobs.change("pj-1", T0 + 4, () => ({
      update: { reviewedOid: "abc", quarantineRef: "refs/q/job/pj-1" },
      event: { kind: "collected", payload: {} },
    }));
    const failure = { reason: "path_violation", offending: ["out/x"] };
    const job = await jobs.transition(
      "pj-1",
      "failed",
      T0 + 5,
      { class: "path_violation" },
      {
        class: "path_violation",
        failure,
      },
    );
    expect(await jobs.get("pj-1")).toEqual(job);
    expect(job).toMatchObject({
      state: "failed",
      reviewedOid: "abc",
      quarantineRef: "refs/q/job/pj-1",
      class: "path_violation",
      failure,
      finishedAt: T0 + 5,
    });
    expect((await jobs.events("pj-1")).map((event) => event.kind).slice(-2)).toEqual([
      "collected",
      "transition",
    ]);
  });

  it("refuses an illegal move with invalid_transition, row and events unchanged", async () => {
    const { db, jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    const before = await rawRow(db, "pj-1");
    expect(await rejectionCode(jobs.transition("pj-1", "running", T0 + 1))).toBe(
      "invalid_transition",
    );
    expect(await rawRow(db, "pj-1")).toEqual(before);
    expect(await jobs.events("pj-1")).toHaveLength(1);
  });

  it("refuses an unknown id with unknown_job", async () => {
    const { jobs } = await openTestStore();
    expect(await rejectionCode(jobs.transition("pj-404", "preparing", T0))).toBe("unknown_job");
    expect(await rejectionCode(jobs.appendEvent("pj-404", T0, "warning", {}))).toBe("unknown_job");
  });

  it("records a pause once however many failures report it", async () => {
    const { jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    await jobs.transition("pj-1", "preparing", T0 + 1);
    await jobs.transition("pj-1", "running", T0 + 2);
    await jobs.markPause("pj-1", T0 + 3, { op: "exec", code: "lost" });
    const job = await jobs.markPause("pj-1", T0 + 4, { op: "read", code: "lost" });
    expect(job).toMatchObject({ pauseRequested: true, updatedAt: T0 + 3 });
    const pauses = (await jobs.events("pj-1")).filter((event) => event.kind === "pause");
    expect(pauses).toEqual([
      { seq: 4, jobId: "pj-1", at: T0 + 3, kind: "pause", payload: { op: "exec", code: "lost" } },
    ]);
  });

  it("stamps end_reason cancelled on cancel", async () => {
    const { jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    const job = await jobs.cancel("pj-1", T0 + 9);
    expect(job).toMatchObject({ state: "cancelled", endReason: "cancelled", finishedAt: T0 + 9 });
    expect((await jobs.events("pj-1")).at(-1)?.payload).toEqual({
      from: "queued",
      to: "cancelled",
      endReason: "cancelled",
    });
  });

  it("appends an event without changing the row", async () => {
    const { db, jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    const before = await rawRow(db, "pj-1");
    await jobs.appendEvent("pj-1", T0 + 7, "warning", { ceiling: "tokens" });
    expect(await rawRow(db, "pj-1")).toEqual(before);
    expect((await jobs.events("pj-1")).at(-1)).toEqual({
      seq: 2,
      jobId: "pj-1",
      at: T0 + 7,
      kind: "warning",
      payload: { ceiling: "tokens" },
    });
  });
});

describe("state and event commit in one transaction", () => {
  it("leaves the job row byte-identical when its event cannot be written", async () => {
    const { db, jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    await jobs.transition("pj-1", "preparing", T0 + 1);
    await jobs.transition("pj-1", "running", T0 + 2);
    const before = await rawRow(db, "pj-1");
    await refuseEvents(db);
    await expect(jobs.transition("pj-1", "waiting_room", T0 + 50)).rejects.toThrow(/boom/);
    expect(await rawRow(db, "pj-1")).toEqual(before);
  });

  it("leaves no job when its submitted event cannot be written", async () => {
    const { db, jobs } = await openTestStore();
    await refuseEvents(db);
    await expect(jobs.submit(NEW_JOB, T0)).rejects.toThrow(/boom/);
    expect(await jobs.list()).toEqual([]);
  });
});

describe("reads", () => {
  it("lists jobs in creation order, filtered by state and limited", async () => {
    const { jobs } = await openTestStore();
    for (const [index, submissionId] of ["a", "b", "c"].entries()) {
      await jobs.submit({ ...NEW_JOB, submissionId }, T0 + index);
    }
    await jobs.cancel("pj-2", T0 + 10);
    const ids = async (filter?: Parameters<typeof jobs.list>[0]): Promise<string[]> =>
      (await jobs.list(filter)).map((job) => job.id);
    expect(await ids()).toEqual(["pj-1", "pj-2", "pj-3"]);
    expect(await ids({ states: ["queued"] })).toEqual(["pj-1", "pj-3"]);
    expect(await ids({ states: ["cancelled", "queued"], limit: 2 })).toEqual(["pj-1", "pj-2"]);
    expect(await ids({ states: [] })).toEqual([]);
  });

  it("reads nothing for an unknown id or submission", async () => {
    const { jobs } = await openTestStore();
    expect(await jobs.get("pj-404")).toBeUndefined();
    expect(await jobs.bySubmission("nope")).toBeUndefined();
    expect(await jobs.events("pj-404")).toEqual([]);
  });

  it("refuses a corrupt row", async () => {
    const { db, jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    await db.run("UPDATE jobs SET created_at = '2026-10-18' WHERE id = 'pj-1'");
    await expect(jobs.get("pj-1")).rejects.toThrow(/corrupt jobs row "pj-1": created_at/);
  });
});

describe("one adapter shared with pi-durable under prefix pi_", () => {
  it("keeps pi's objects under the prefix beside the host tables, both readable", async () => {
    const { db, storage, jobs } = await openRunnerStore(":memory:", { newId: sequentialIds() });
    const { harness, root } = await openFauxHarness(storage);
    onTestFinished(() => closeHarness(harness));
    await jobs.submit(NEW_JOB, T0);

    const objects = await schemaObjects(db);
    const isPi = ({ table }: SchemaObject): boolean => table.startsWith(PI_PREFIX);
    const pi = namesOf(objects.filter(isPi));
    expect(namesOf(objects.filter((object) => !isPi(object)))).toEqual(HOST_OBJECTS);
    expect(pi.length).toBeGreaterThan(0);
    expect(pi.every((name) => /^(?:sqlite_autoindex_)?pi_/.test(name))).toBe(true);
    expect((await storage.conversation(root.id, context))?.id).toBe(root.id);
    expect((await jobs.get("pj-1"))?.state).toBe("queued");
  });
});

describe("conversation and announcement writes", () => {
  it("records a conversation id and an announcement, each with its event", async () => {
    const { db, jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    await jobs.change("pj-1", T0 + 1, () => ({
      update: { conversationId: "conv-1" },
      event: { kind: "conversation", payload: { conversationId: "conv-1" } },
    }));
    await jobs.cancel("pj-1", T0 + 2, { reason: "no longer needed" });
    const acked = await jobs.change("pj-1", T0 + 3, () => ({
      update: { announcedAt: T0 + 3 },
      event: { kind: "announced", payload: {} },
    }));
    expect(acked).toMatchObject({ conversationId: "conv-1", announcedAt: T0 + 3 });
    expect(await jobs.get("pj-1")).toEqual(acked);
    expect(await rawRow(db, "pj-1")).toMatchObject({
      conversation_id: "conv-1",
      announced_at: new Date(T0 + 3).toISOString(),
    });
    const events = await jobs.events("pj-1");
    expect(events.map((event) => event.kind)).toEqual([
      "submitted",
      "conversation",
      "transition",
      "announced",
    ]);
    expect(events[2]?.payload).toMatchObject({ reason: "no longer needed", to: "cancelled" });
  });
});

describe("policy writes", () => {
  it("records the resolved policy on the row with its policy event", async () => {
    const { db, jobs } = await openTestStore();
    await jobs.submit(NEW_JOB, T0);
    const policy = { model: "gateway/m", ceilings: { tokens: 10 }, promptFragments: [] };

    const job = await jobs.change("pj-1", T0 + 1, () => ({
      update: { policy },
      event: { kind: "policy", payload: policy },
    }));

    expect(job.policy).toEqual(policy);
    expect(await jobs.get("pj-1")).toEqual(job);
    expect(JSON.parse(String((await rawRow(db, "pj-1"))?.["policy"]))).toEqual(policy);
    expect((await jobs.events("pj-1")).at(-1)).toMatchObject({ kind: "policy", payload: policy });
  });
});

describe("observe: committed writes, after commit", () => {
  type Seen = [jobId: string, state: string, kind: string];

  /** The store and every notification it gives, as `[id, state, kind]`. */
  async function observed(): Promise<{ jobs: JobStore; seen: Seen[]; stop: () => void }> {
    const { jobs } = await openTestStore();
    const seen: Seen[] = [];
    const stop = jobs.observe((job, kind) => {
      seen.push([job.id, job.state, kind]);
    });
    return { jobs, seen, stop };
  }

  it("notifies once per created job and per change that wrote", async () => {
    const { jobs, seen } = await observed();
    await jobs.submit(NEW_JOB, T0);
    await jobs.transition("pj-1", "preparing", T0 + 1);
    await jobs.appendEvent("pj-1", T0 + 2, "warning", {});
    expect(seen).toEqual([
      ["pj-1", "queued", "submitted"],
      ["pj-1", "preparing", "transition"],
    ]);
  });

  it("is silent for an idempotent submit, a no-op change and a refused one", async () => {
    const { jobs, seen } = await observed();
    await jobs.submit(NEW_JOB, T0);
    seen.length = 0;
    await jobs.submit(NEW_JOB, T0 + 1);
    await jobs.change("pj-1", T0 + 2, () => undefined);
    await expect(jobs.transition("pj-1", "running", T0 + 3)).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("is silent for a write whose transaction rolls back", async () => {
    const { db, jobs } = await openTestStore();
    const seen: string[] = [];
    jobs.observe((job) => seen.push(job.state));
    await refuseEvents(db);
    await expect(jobs.submit(NEW_JOB, T0)).rejects.toThrow(/boom/);
    expect(seen).toEqual([]);
  });

  it("stops notifying once unsubscribed", async () => {
    const { jobs, seen, stop } = await observed();
    stop();
    await jobs.submit(NEW_JOB, T0);
    expect(seen).toEqual([]);
  });

  it("keeps the write and the other listeners when a listener throws", async () => {
    const { jobs, seen } = await observed();
    jobs.observe(() => {
      throw new Error("listener bug");
    });
    const { job } = await jobs.submit(NEW_JOB, T0);
    expect(job.state).toBe("queued");
    expect(await jobs.get("pj-1")).toEqual(job);
    expect(seen).toHaveLength(1);
  });
});

describe("admitModelRequest: the gate's durable count (DEC-057)", () => {
  const refuse: RequestVerdict = { kind: "refuse", ceiling: { reason: "ceiling_exceeded" } };

  it("an admission counts one model request, with no event", async () => {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);
    const seen: number[] = [];

    const first = await jobs.admitModelRequest(job.id, T0 + 1, (row) => {
      seen.push(row.modelRequests);
      return { kind: "admit" };
    });
    await jobs.admitModelRequest(job.id, T0 + 2, () => ({ kind: "admit" }));

    expect(first.job.modelRequests).toBe(1);
    expect(seen).toEqual([0]);
    expect((await jobs.get(job.id))?.modelRequests).toBe(2);
    expect((await jobs.events(job.id)).map((event) => event.kind)).toEqual(["submitted"]);
  });

  it("a refusal counts nothing and appends one ceiling event per job, however often", async () => {
    const { jobs } = await openTestStore();
    const { job } = await jobs.submit(NEW_JOB, T0);

    const refused = await jobs.admitModelRequest(job.id, T0 + 1, () => refuse);
    await jobs.admitModelRequest(job.id, T0 + 2, () => refuse);

    expect(refused.verdict).toBe(refuse);
    expect((await jobs.get(job.id))?.modelRequests).toBe(0);
    const ceilings = (await jobs.events(job.id)).filter((event) => event.kind === "ceiling");
    expect(ceilings).toMatchObject([{ at: T0 + 1, payload: { reason: "ceiling_exceeded" } }]);
  });

  it("refuses an unknown id with unknown_job", async () => {
    const { jobs } = await openTestStore();
    expect(
      await rejectionCode(jobs.admitModelRequest("pj-404", T0, () => ({ kind: "admit" }))),
    ).toBe("unknown_job");
  });
});
