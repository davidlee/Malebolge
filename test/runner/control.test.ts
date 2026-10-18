import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { isRecord, type JsonRecord } from "../../src/json.ts";
import { parseRunnerConfig } from "../../src/runner/config.ts";
import { type ControlDeps, harnessConversations, serveControl } from "../../src/runner/control.ts";
import { StartRefused } from "../../src/runner/errors.ts";
import { gitRepoReader, type RepoReader } from "../../src/runner/git.ts";
import type { Job, NewJob } from "../../src/runner/rows.ts";
import { JobStore, openRunnerStore, type RunnerStore } from "../../src/runner/store.ts";
import { tempDir } from "../fixtures.ts";
import { openFauxHarness } from "../harness-fixture.ts";
import { exampleConfig, HOME, variant } from "./config-fixture.ts";
import { type ControlClient, controlClient, errorCode } from "./control-fixture.ts";
import { tempRepo, type TestRepo } from "./git-fixture.ts";
import { closeHarness } from "./runner-fixture.ts";
import { NEW_JOB, sequentialIds, T0 } from "./store-fixture.ts";

/** The submit fields of `NEW_JOB`, as Emacs sends them. */
const SUBMIT: JsonRecord = {
  submissionId: NEW_JOB.submissionId,
  mode: NEW_JOB.mode,
  directive: NEW_JOB.directive,
  repo: NEW_JOB.repo,
  allowedPaths: NEW_JOB.allowedPaths,
  tags: NEW_JOB.tags,
};

interface Runner {
  client: ControlClient;
  /** Another connection to the same socket. */
  connect: () => Promise<ControlClient>;
  store: RunnerStore;
  repo: TestRepo;
  socketPath: string;
  wakes: () => number;
  logs: string[];
}

interface RunnerOptions {
  enabled?: boolean;
  repos?: RepoReader;
  /** The job store the server sees, over the test's database. */
  jobs?: (store: RunnerStore) => JobStore;
}

/** A control server over an in-memory store, a passive harness and a temp repo named `satan`. */
async function runner(options: RunnerOptions = {}): Promise<Runner> {
  const repo = tempRepo();
  const { dir, cleanup } = await tempDir();
  onTestFinished(cleanup);
  const store = await openRunnerStore(":memory:", { newId: sequentialIds() });
  const { harness } = await openFauxHarness(store.storage, { resume: false });
  onTestFinished(() => closeHarness(harness));
  const config = parseRunnerConfig(variant('path = "~/dev/satan"', `path = "${repo.path}"`), HOME);
  let wakes = 0;
  let clock = T0;
  const logs: string[] = [];
  const jobs = options.jobs?.(store) ?? store.jobs;
  const deps: ControlDeps = {
    config: { ...config, enabled: options.enabled ?? true },
    jobs,
    conversations: harnessConversations(harness),
    repos: options.repos ?? gitRepoReader,
    wake: () => {
      wakes++;
    },
    now: () => clock++,
    log: (text) => {
      logs.push(text);
    },
  };
  const socketPath = join(dir, "satan-runner", "control.sock");
  const server = await serveControl(deps, socketPath);
  onTestFinished(() => server.close());
  const connect = async (): Promise<ControlClient> => {
    const client = await controlClient(socketPath);
    onTestFinished(client.close);
    return client;
  };
  return {
    client: await connect(),
    connect,
    // The server's job store: its observers see the test's writes.
    store: { ...store, jobs },
    repo,
    socketPath,
    wakes: () => wakes,
    logs,
  };
}

/** Inserts `job` straight into the store and moves it through `states`. */
async function seed(
  store: RunnerStore,
  states: Job["state"][],
  job: Partial<NewJob> = {},
): Promise<Job> {
  const { job: created } = await store.jobs.submit({ ...NEW_JOB, ...job }, T0);
  let current = created;
  for (const state of states) {
    current = await store.jobs.transition(current.id, state, T0);
  }
  return current;
}

/** A job awaiting review of `reviewedOid`. */
async function reviewed(
  store: RunnerStore,
  reviewedOid: string,
  submissionId = "sub-r",
): Promise<Job> {
  const job = await seed(store, ["preparing", "running", "collecting"], { submissionId });
  await store.db.run("UPDATE jobs SET reviewed_oid = ? WHERE id = ?", reviewedOid, job.id);
  return store.jobs.transition(job.id, "needs_review", T0);
}

const ok = (response: JsonRecord): JsonRecord => {
  expect(response).toMatchObject({ ok: true });
  return response;
};

describe("the socket: own directory 0700, socket 0600, one server", () => {
  it("creates the directory 0700 and the socket 0600", async () => {
    const { socketPath } = await runner();
    expect((await stat(join(socketPath, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses to start in a directory open to group or other", async () => {
    const { dir, cleanup } = await tempDir();
    onTestFinished(cleanup);
    const open = join(dir, "satan-runner");
    await mkdir(open);
    await chmod(open, 0o750);
    await expect(serveControl(depsOf(await runner()), join(open, "control.sock"))).rejects.toThrow(
      StartRefused,
    );
  });

  it("replaces a stale socket file nobody answers on", async () => {
    const { dir, cleanup } = await tempDir();
    onTestFinished(cleanup);
    const socketPath = join(dir, "satan-runner", "control.sock");
    await mkdir(join(dir, "satan-runner"), { mode: 0o700 });
    await writeFile(socketPath, "stale");
    const server = await serveControl(depsOf(await runner()), socketPath);
    onTestFinished(() => server.close());
    const client = await controlClient(socketPath);
    onTestFinished(client.close);
    ok(await client.call("list"));
  });

  it("refuses to start while a live server holds the path", async () => {
    const live = await runner();
    await expect(serveControl(depsOf(live), live.socketPath)).rejects.toThrow(StartRefused);
    ok(await live.client.call("list"));
  });
});

/** Minimal deps over `runner`'s store, for a second server. */
function depsOf(runner: Pick<Runner, "store">): ControlDeps {
  return {
    config: exampleConfig(),
    jobs: runner.store.jobs,
    conversations: { create: () => Promise.resolve("unused") },
    repos: gitRepoReader,
    wake: () => undefined,
    now: () => T0,
    log: () => undefined,
  };
}

describe("schema refusal: the full schema before any effect", () => {
  it("refuses an unknown key, an unknown op and a missing requestId with invalid_request", async () => {
    const { client } = await runner();
    expect(errorCode(await client.call("status", { jobId: "pj-1", extra: 1 }))).toBe(
      "invalid_request",
    );
    expect(errorCode(await client.call("promote", { jobId: "pj-1" }))).toBe("invalid_request");
    client.send({ op: "list" });
    const refused = await client.next((message) => message["requestId"] === null);
    expect(errorCode(refused)).toBe("invalid_request");
  });

  it("refuses a malformed baseRef with base_ref_invalid", async () => {
    const { client, store } = await runner();
    const response = await client.call("submit", { ...SUBMIT, baseRef: "a..b" });
    expect(errorCode(response)).toBe("base_ref_invalid");
    expect(await store.jobs.list()).toEqual([]);
  });
});

describe("submit", () => {
  it("queues the job, records its conversation, audits both and wakes the scheduler once", async () => {
    const { client, store, wakes } = await runner();
    const response = ok(await client.call("submit", SUBMIT));
    expect(response).toMatchObject({ jobId: "pj-1", state: "queued" });
    const row = await store.db.get<JsonRecord>(
      "SELECT conversation_id, base_ref FROM jobs WHERE id = 'pj-1'",
    );
    expect(row?.["conversation_id"]).toEqual(expect.any(String));
    expect(row?.["base_ref"]).toBe("main");
    const kinds = (await store.jobs.events("pj-1")).map((event) => event.kind);
    expect(kinds).toEqual(["submitted", "conversation"]);
    expect(wakes()).toBe(1);
  });

  it("answers the same submissionId with the existing job: one row, no second wake", async () => {
    const { client, store, wakes } = await runner();
    const first = ok(await client.call("submit", SUBMIT));
    const again = ok(await client.call("submit", { ...SUBMIT, directive: "Other." }));
    expect(again["jobId"]).toBe(first["jobId"]);
    expect(await store.jobs.list()).toHaveLength(1);
    expect(wakes()).toBe(1);
  });

  it("returns the existing job even when its base branch has since gone", async () => {
    const { client, repo } = await runner();
    repo.git("branch", "topic");
    const first = ok(await client.call("submit", { ...SUBMIT, baseRef: "topic" }));
    repo.git("branch", "-D", "topic");
    const again = ok(await client.call("submit", { ...SUBMIT, baseRef: "topic" }));
    expect(again["jobId"]).toBe(first["jobId"]);
  });

  it("takes an existing branch as baseRef", async () => {
    const { client, store, repo } = await runner();
    repo.git("branch", "topic");
    ok(await client.call("submit", { ...SUBMIT, baseRef: "topic" }));
    expect((await store.jobs.get("pj-1"))?.baseRef).toBe("topic");
  });

  it.each([
    ["a nonexistent branch", "nope"],
    ["HEAD", "HEAD"],
    ["a tag", "v1"],
    ["an oid", "oid"],
  ])("refuses %s as baseRef with base_ref_invalid", async (_label, baseRef) => {
    const { client, store, repo, wakes } = await runner();
    repo.git("tag", "v1");
    const ref = baseRef === "oid" ? repo.git("rev-parse", "HEAD") : baseRef;
    expect(errorCode(await client.call("submit", { ...SUBMIT, baseRef: ref }))).toBe(
      "base_ref_invalid",
    );
    expect(await store.jobs.list()).toEqual([]);
    expect(wakes()).toBe(0);
  });

  it("refuses an unknown repo with invalid_request and a raised ceiling with ceiling_above_maximum", async () => {
    const { client, store } = await runner();
    expect(errorCode(await client.call("submit", { ...SUBMIT, repo: "elsewhere" }))).toBe(
      "invalid_request",
    );
    const raised = { ...SUBMIT, ceilings: { model_requests: 500 } };
    expect(errorCode(await client.call("submit", raised))).toBe("ceiling_above_maximum");
    expect(await store.jobs.list()).toEqual([]);
  });

  it("writes nothing to the real repo (I3)", async () => {
    const { client, repo } = await runner();
    const before = repo.snapshot();
    ok(await client.call("submit", SUBMIT));
    await client.call("submit", { ...SUBMIT, submissionId: "sub-2", baseRef: "nope" });
    expect(repo.snapshot()).toBe(before);
  });
});

describe("enabled = false: the kill switch refuses submit only", () => {
  it("refuses submit with runner_disabled and writes no row; reads still answer", async () => {
    const { client, store } = await runner({ enabled: false });
    expect(errorCode(await client.call("submit", SUBMIT))).toBe("runner_disabled");
    expect(await store.jobs.list()).toEqual([]);
    const job = await seed(store, []);
    expect(ok(await client.call("status", { jobId: job.id }))["job"]).toMatchObject({
      jobId: job.id,
      state: "queued",
    });
    expect(ok(await client.call("list"))["jobs"]).toHaveLength(1);
    expect(ok(await client.call("result", { jobId: job.id }))).toMatchObject({ state: "queued" });
  });
});

describe("cancel, status, list, result", () => {
  it("cancels a queued job, recording the reason", async () => {
    const { client, store } = await runner();
    const job = await seed(store, []);
    const response = ok(await client.call("cancel", { jobId: job.id, reason: "superseded" }));
    expect(response).toMatchObject({ state: "cancelled" });
    expect((await store.jobs.events(job.id)).at(-1)?.payload).toMatchObject({
      reason: "superseded",
    });
  });

  it("refuses to cancel a terminal job (invalid_transition) or an unknown one (unknown_job)", async () => {
    const { client, store } = await runner();
    const job = await seed(store, ["cancelled"]);
    expect(errorCode(await client.call("cancel", { jobId: job.id, reason: "x" }))).toBe(
      "invalid_transition",
    );
    expect(errorCode(await client.call("cancel", { jobId: "pj-404", reason: "x" }))).toBe(
      "unknown_job",
    );
    expect(errorCode(await client.call("status", { jobId: "pj-404" }))).toBe("unknown_job");
    expect(errorCode(await client.call("result", { jobId: "pj-404" }))).toBe("unknown_job");
  });

  it("lists summaries in creation order, filtered by state and limited", async () => {
    const { client, store } = await runner();
    await seed(store, [], { submissionId: "a" });
    await seed(store, ["cancelled"], { submissionId: "b" });
    await seed(store, [], { submissionId: "c" });
    const ids = (response: JsonRecord): unknown[] => {
      const jobs: unknown = response["jobs"];
      return Array.isArray(jobs) ? jobs.filter(isRecord).map((job) => job["jobId"]) : [];
    };
    expect(ids(ok(await client.call("list")))).toEqual(["pj-1", "pj-2", "pj-3"]);
    expect(ids(ok(await client.call("list", { states: ["queued"], limit: 1 })))).toEqual(["pj-1"]);
  });

  it("answers result with what the row holds", async () => {
    const { client, store, repo } = await runner();
    const job = await reviewed(store, repo.git("rev-parse", "HEAD"));
    expect(ok(await client.call("result", { jobId: job.id }))).toMatchObject({
      jobId: job.id,
      state: "needs_review",
      reviewedOid: repo.git("rev-parse", "HEAD"),
      usage: { modelRequests: 0 },
    });
  });
});

describe("report-disposition: promoted verifies the receipt read-only (I8)", () => {
  it("promotes when satan/patch/<id> resolves to the reviewed oid", async () => {
    const { client, store, repo } = await runner();
    const job = await reviewed(store, repo.git("rev-parse", "HEAD"));
    const branch = `satan/patch/${job.id}`;
    repo.git("branch", branch);
    const before = repo.snapshot();
    const response = await client.call("report-disposition", {
      jobId: job.id,
      disposition: "promoted",
      branch,
    });
    expect(ok(response)).toMatchObject({ state: "promoted" });
    expect((await store.jobs.events(job.id)).at(-1)?.payload).toMatchObject({
      disposition: "promoted",
      branch,
      verifiedOid: job.reviewedOid,
    });
    expect(repo.snapshot()).toBe(before);
  });

  it.each([
    ["has moved", "moved"],
    ["is absent", "absent"],
    ["is not the job's branch", "wrong"],
  ])("refuses with receipt_mismatch when the branch %s", async (_label, how) => {
    const { client, store, repo } = await runner();
    const job = await reviewed(store, repo.git("rev-parse", "HEAD"));
    const branch = `satan/patch/${job.id}`;
    if (how === "moved") {
      repo.git("checkout", "--quiet", "-b", branch);
      repo.commit("MORE");
    }
    if (how === "wrong") {
      repo.git("branch", "elsewhere");
    }
    const before = repo.snapshot();
    const response = await client.call("report-disposition", {
      jobId: job.id,
      disposition: "promoted",
      branch: how === "wrong" ? "elsewhere" : branch,
    });
    expect(errorCode(response)).toBe("receipt_mismatch");
    expect((await store.jobs.get(job.id))?.state).toBe("needs_review");
    expect((await store.jobs.events(job.id)).at(-1)).toMatchObject({
      kind: "disposition",
      payload: { disposition: "promoted", outcome: "receipt_mismatch" },
    });
    expect(repo.snapshot()).toBe(before);
  });

  it("records a rejection", async () => {
    const { client, store, repo } = await runner();
    const job = await reviewed(store, repo.git("rev-parse", "HEAD"));
    const response = await client.call("report-disposition", {
      jobId: job.id,
      disposition: "rejected",
    });
    expect(ok(response)).toMatchObject({ state: "rejected" });
  });

  it("refuses a disposition for a job not awaiting review, before reading the repo", async () => {
    const reads: string[] = [];
    const repos: RepoReader = {
      ...gitRepoReader,
      resolveBranch: (path, name) => {
        reads.push(name);
        return gitRepoReader.resolveBranch(path, name);
      },
    };
    const { client, store } = await runner({ repos });
    const job = await seed(store, []);
    const response = await client.call("report-disposition", {
      jobId: job.id,
      disposition: "promoted",
      branch: `satan/patch/${job.id}`,
    });
    expect(errorCode(response)).toBe("invalid_transition");
    expect(reads).toEqual([]);
    expect(
      errorCode(
        await client.call("report-disposition", { jobId: "pj-404", disposition: "rejected" }),
      ),
    ).toBe("unknown_job");
  });
});

describe("watch and ack", () => {
  const frameOf =
    (state: string) =>
    (message: JsonRecord): boolean =>
      message["event"] === "job_changed" &&
      JSON.stringify(message["job"]).includes(`"state":"${state}"`);

  it("replays needs_review and unacked failed jobs, not an acked cancelled one", async () => {
    const { client, store, repo } = await runner();
    const review = await reviewed(store, repo.git("rev-parse", "HEAD"));
    const failed = await seed(store, ["preparing", "failed"], { submissionId: "f" });
    const acked = await seed(store, ["cancelled"], { submissionId: "c" });
    ok(await client.call("ack", { jobIds: [acked.id] }));
    await seed(store, [], { submissionId: "q" });
    ok(await client.call("watch"));
    await client.next(frameOf("needs_review"));
    await client.next(frameOf("failed"));
    const replayed = client.frames().map((frame) => JSON.stringify(frame["job"]));
    expect(replayed).toHaveLength(2);
    expect(replayed.join()).toContain(review.id);
    expect(replayed.join()).toContain(failed.id);
  });

  it("streams job_changed on every transition until the client goes", async () => {
    const { client, store } = await runner();
    ok(await client.call("watch"));
    const job = await seed(store, ["preparing"]);
    await client.next(frameOf("preparing"));
    await store.jobs.transition(job.id, "failed", T0);
    await client.next(frameOf("failed"));
    client.close();
    await client.closed;
    await store.jobs.transition((await seed(store, [], { submissionId: "x" })).id, "preparing", T0);
  });

  it("ack sets announced_at, after which a reconnecting watch no longer replays the job", async () => {
    const { client, connect, store } = await runner();
    const failed = await seed(store, ["preparing", "failed"], { submissionId: "f" });
    const other = await seed(store, ["cancelled"], { submissionId: "c" });
    ok(await client.call("ack", { jobIds: [failed.id] }));
    const row = await store.db.get<JsonRecord>(
      "SELECT announced_at FROM jobs WHERE id = ?",
      failed.id,
    );
    expect(row?.["announced_at"]).toEqual(expect.any(String));
    ok(await client.call("ack", { jobIds: [failed.id] }));
    const announced = (await store.jobs.events(failed.id)).filter((e) => e.kind === "announced");
    expect(announced).toHaveLength(1);
    const again = await connect();
    ok(await again.call("watch"));
    await again.next(frameOf("cancelled"));
    expect(again.frames().map((frame) => JSON.stringify(frame["job"]))).toEqual([
      expect.stringContaining(other.id),
    ]);
  });

  it("refuses to ack a job that is not failed or cancelled, or an unknown one, writing none", async () => {
    const { client, store } = await runner();
    const failed = await seed(store, ["preparing", "failed"], { submissionId: "f" });
    const queued = await seed(store, [], { submissionId: "q" });
    expect(errorCode(await client.call("ack", { jobIds: [failed.id, queued.id] }))).toBe(
      "invalid_transition",
    );
    expect(errorCode(await client.call("ack", { jobIds: [failed.id, "pj-404"] }))).toBe(
      "unknown_job",
    );
    expect((await store.jobs.get(failed.id))?.announcedAt).toBeUndefined();
  });

  it("subscribes before reading the replay set, and orders live frames after it", async () => {
    /** Writes made while the server reads its replay set: just before, and just after. */
    const race: { before?: () => Promise<unknown>; after?: () => Promise<unknown> } = {};
    class RacingStore extends JobStore {
      override async list(...args: Parameters<JobStore["list"]>): Promise<Job[]> {
        await race.before?.();
        const rows = await super.list(...args);
        await race.after?.();
        return rows;
      }
    }
    const { client, store, repo } = await runner({
      jobs: ({ db }) => new RacingStore(db, sequentialIds()),
    });
    const review = await reviewed(store, repo.git("rev-parse", "HEAD"));
    const queued = await seed(store, [], { submissionId: "q" });
    race.before = (): Promise<Job> => store.jobs.transition(queued.id, "preparing", T0);
    race.after = (): Promise<Job> => store.jobs.transition(review.id, "rejected", T0);
    ok(await client.call("watch"));
    await client.next(frameOf("rejected"));
    const frames = client.frames().map((frame) => JSON.stringify(frame["job"]));
    expect(frames).toEqual([
      expect.stringContaining('"state":"needs_review"'),
      expect.stringContaining('"state":"preparing"'),
      expect.stringContaining('"state":"rejected"'),
    ]);
  });
});

describe("failures that are not refusals", () => {
  it("logs, answers nothing and drops the connection; the server keeps serving", async () => {
    const broken: RepoReader = {
      checkBranchName: () => Promise.reject(new Error("git exploded")),
      resolveBranch: () => Promise.reject(new Error("git exploded")),
    };
    const { client, connect, logs } = await runner({ repos: broken });
    client.send({ op: "submit", requestId: "r1", ...SUBMIT });
    await client.closed;
    expect(client.frames()).toEqual([]);
    expect(logs.join("\n")).toContain("git exploded");
    ok(await (await connect()).call("list"));
  });
});
