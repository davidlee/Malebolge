// The control socket (design §5.2, DEC-058): one JSON request per line on a
// same-uid unix socket in its own 0700 directory, answered by one response
// echoing its `requestId`; `watch` then streams `job_changed` frames. Requests
// are parsed in full by protocol.ts before any effect. A refusal (RunnerError)
// is answered with its code; any other failure is a bug or a broken host: it
// is logged and the connection dropped, unanswered (the code set is closed).
// Nothing here writes a real repo (I3): `RepoReader` only reads.

import { chmod, mkdir, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { dirname } from "node:path";
import type { Harness } from "@earendil-works/pi-durable";
import { context } from "../context.ts";
import type { JsonRecord } from "../json.ts";
import { encodeLine, lineSplitter } from "../ndjson.ts";
import { connectUnix, serveUnix, type UnixServer } from "../unix-socket.ts";
import type { RunnerConfig } from "./config.ts";
import { isRunnerError, RunnerError, StartRefused } from "./errors.ts";
import { checkBaseRef, type RepoReader } from "./git.ts";
import { transition } from "./jobs.ts";
import { configEntry } from "./policy.ts";
import {
  checkSubmit,
  encodeError,
  encodeOk,
  parseRequest,
  peekRequestId,
  type Request,
  type SubmitRequest,
} from "./protocol.ts";
import type { Decide, Job, JobStore, NewJob } from "./store.ts";
import { isReplayed, jobChangedFrame, REPLAY_STATES, resultBody, summary } from "./views.ts";
import type { JobState } from "./vocab.ts";

/**
 * Creates a job's pi-durable conversation; its id as `jobs.conversation_id`
 * text (pi's ids are branded numbers, the column is TEXT).
 */
export interface Conversations {
  create: () => Promise<string>;
}

/** Ends job `jobId` for `reason`. */
export type CancelJob = (jobId: string, reason: string, now: number) => Promise<Job>;

export interface ControlDeps {
  config: RunnerConfig;
  jobs: JobStore;
  conversations: Conversations;
  repos: RepoReader;
  /** Tells the scheduler a job was queued. */
  wake: () => void;
  /** Defaults to the store's cancel; the scheduler's aborts a run first. */
  cancel?: CancelJob;
  now: () => number;
  log: (text: string) => void;
}

/** Ownerless conversations on `harness`. Creating one schedules nothing (I14). */
export function harnessConversations(harness: Harness): Conversations {
  return {
    create: async () =>
      String((await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id),
  };
}

// --- operations ------------------------------------------------------------------

type Op = Request["op"];
type OpRequest<K extends Op> = Extract<Request, { op: K }>;

/** One client connection. */
interface Connection {
  deps: ControlDeps;
  send: (value: unknown) => void;
  /** Runs `cleanup` when the connection closes (now, if it has). */
  onClose: (cleanup: () => void) => void;
}

/** Answers `request` on `connection`. */
type Operation<K extends Op> = (request: OpRequest<K>, connection: Connection) => Promise<void>;

/** The ok body for `request`. */
type Query<K extends Op> = (request: OpRequest<K>, deps: ControlDeps) => Promise<JsonRecord>;

/** `query` as an operation answering with its body. */
function answered<K extends Op>(query: Query<K>): Operation<K> {
  return async function answer(request, connection): Promise<void> {
    connection.send(encodeOk(request.requestId, await query(request, connection.deps)));
  };
}

async function known(jobs: JobStore, jobId: string): Promise<Job> {
  const job = await jobs.get(jobId);
  if (job === undefined) {
    throw new RunnerError("unknown_job", `no job ${jobId}`);
  }
  return job;
}

const submitted = (job: Job): JsonRecord => ({ jobId: job.id, state: job.state });

/** `request` checked against config and the real repo: the job to store. */
async function admit(request: SubmitRequest, deps: ControlDeps): Promise<NewJob> {
  const checked = checkSubmit(request, deps.config);
  const repo = configEntry(deps.config.repos, "repo", checked.repo);
  return {
    submissionId: checked.submissionId,
    mode: checked.mode,
    directive: checked.directive,
    repo: checked.repo,
    allowedPaths: checked.allowedPaths,
    baseRef: await checkBaseRef(
      deps.repos,
      { name: checked.repo, path: repo.path },
      checked.baseRef,
    ),
    tags: checked.tags,
    context: checked.context,
    source: checked.source,
    ceilings: checked.ceilings,
  };
}

/**
 * Design §5.4 "Submit to review": validate, insert (conversation null) with
 * its event, create the conversation, record its id, wake. A known
 * `submissionId` answers with its job before any validation.
 */
async function submit(request: SubmitRequest, deps: ControlDeps): Promise<JsonRecord> {
  if (!deps.config.enabled) {
    throw new RunnerError("runner_disabled", "the runner is disabled (enabled = false)");
  }
  const existing = await deps.jobs.bySubmission(request.submissionId);
  if (existing !== undefined) {
    return submitted(existing);
  }
  const { job, created } = await deps.jobs.submit(await admit(request, deps), deps.now());
  if (created) {
    const conversationId = await deps.conversations.create();
    await deps.jobs.change(job.id, deps.now(), () => ({
      update: { conversationId },
      event: { kind: "conversation", payload: { conversationId } },
    }));
    deps.wake();
  }
  return submitted(job);
}

/** The store's cancel, the reason recorded on the transition. */
function storeCancel(jobs: JobStore): CancelJob {
  return function cancel(jobId, reason, now): Promise<Job> {
    return jobs.cancel(jobId, now, { reason });
  };
}

async function cancelJob(request: OpRequest<"cancel">, deps: ControlDeps): Promise<JsonRecord> {
  const cancel = deps.cancel ?? storeCancel(deps.jobs);
  const job = await cancel(request.jobId, request.reason, deps.now());
  return { state: job.state };
}

/** Why `branch` is not the receipt for `job`; `undefined` when it is. */
async function receiptMismatch(
  job: Job,
  branch: string,
  deps: ControlDeps,
): Promise<string | undefined> {
  const expected = `satan/patch/${job.id}`;
  if (branch !== expected) {
    return `${branch} is not ${expected}`;
  }
  const repo = configEntry(deps.config.repos, "repo", job.repo);
  const found = await deps.repos.resolveBranch(repo.path, branch);
  const reviewed = job.reviewedOid ?? "nothing";
  return found !== undefined && found === job.reviewedOid
    ? undefined
    : `${branch} is ${found ?? "absent"}, reviewed ${reviewed}`;
}

/** I8: a promotion's branch must hold exactly the reviewed commit. Audited either way. */
async function verifyReceipt(job: Job, branch: string, deps: ControlDeps): Promise<JsonRecord> {
  const mismatch = await receiptMismatch(job, branch, deps);
  if (mismatch !== undefined) {
    await deps.jobs.appendEvent(job.id, deps.now(), "disposition", {
      disposition: "promoted",
      branch,
      outcome: "receipt_mismatch",
      message: mismatch,
    });
    throw new RunnerError("receipt_mismatch", mismatch);
  }
  return { disposition: "promoted", branch, verifiedOid: job.reviewedOid };
}

async function reportDisposition(
  request: OpRequest<"report-disposition">,
  deps: ControlDeps,
): Promise<JsonRecord> {
  const job = await known(deps.jobs, request.jobId);
  // Legality first, so a refused move reads no repo; the store re-checks in its transaction.
  transition(job, request.disposition, deps.now());
  const payload =
    request.disposition === "promoted"
      ? await verifyReceipt(job, request.branch, deps)
      : { disposition: "rejected" };
  const next = await deps.jobs.transition(job.id, request.disposition, deps.now(), payload);
  return { state: next.state };
}

const NOTICE_STATES: readonly JobState[] = ["failed", "cancelled"];

/** Marks each job's failure notice announced. Every id is checked before any is written. */
async function ack(request: OpRequest<"ack">, deps: ControlDeps): Promise<JsonRecord> {
  const jobs = await Promise.all(request.jobIds.map((jobId) => known(deps.jobs, jobId)));
  const noNotice = jobs.find((job) => !NOTICE_STATES.includes(job.state));
  if (noNotice !== undefined) {
    throw new RunnerError(
      "invalid_transition",
      `${noNotice.id} is ${noNotice.state}: only failed or cancelled notices are acked`,
    );
  }
  for (const job of jobs) {
    const now = deps.now();
    const announce: Decide = (current) =>
      current.announcedAt === undefined
        ? { update: { announcedAt: now }, event: { kind: "announced", payload: {} } }
        : undefined;
    await deps.jobs.change(job.id, now, announce);
  }
  return {};
}

/**
 * Answers, then replays every job a client must act on, then streams each
 * transition. BINDING order: subscribe before reading the replay set, so no
 * transition falls between them; transitions seen during the replay are held
 * and sent after it, so a replayed state never follows a newer one.
 */
async function watch(request: OpRequest<"watch">, connection: Connection): Promise<void> {
  const { deps, send } = connection;
  send(encodeOk(request.requestId, {}));
  let held: Job[] | undefined = [];
  const unsubscribe = deps.jobs.observe((job, kind) => {
    if (kind !== "transition") {
      return;
    }
    if (held === undefined) {
      send(jobChangedFrame(job));
    } else {
      held.push(job);
    }
  });
  connection.onClose(unsubscribe);
  const replay = await deps.jobs.list({ states: [...REPLAY_STATES] });
  for (const job of [...replay.filter(isReplayed), ...held]) {
    send(jobChangedFrame(job));
  }
  held = undefined;
}

const OPERATIONS: { [K in Op]: Operation<K> } = {
  submit: answered(submit),
  cancel: answered(cancelJob),
  status: answered(async (request, deps) => ({
    job: summary(await known(deps.jobs, request.jobId)),
  })),
  list: answered(async (request, deps) => ({ jobs: (await deps.jobs.list(request)).map(summary) })),
  result: answered(async (request, deps) => resultBody(await known(deps.jobs, request.jobId))),
  "report-disposition": answered(reportDisposition),
  ack: answered(ack),
  watch,
};

function run<K extends Op>(request: OpRequest<K>, connection: Connection): Promise<void> {
  const operation: Operation<K> = OPERATIONS[request.op];
  return operation(request, connection);
}

/** Answers one line; rethrows anything that is not a refusal. */
async function answerLine(line: string, connection: Connection): Promise<void> {
  try {
    await run(parseRequest(line), connection);
  } catch (error) {
    if (!isRunnerError(error)) {
      throw error;
    }
    connection.send(encodeError(peekRequestId(line), error.code, error.message));
  }
}

function serveConnection(deps: ControlDeps, socket: Socket): void {
  const connection: Connection = {
    deps,
    send: (value) => {
      if (socket.writable) {
        socket.write(encodeLine(value));
      }
    },
    onClose: (cleanup) => {
      if (socket.destroyed) {
        cleanup();
        return;
      }
      socket.once("close", cleanup);
    },
  };
  socket.on(
    "data",
    lineSplitter((line) => {
      answerLine(line, connection).catch((error: unknown) => {
        deps.log(
          `control: dropping connection: ${error instanceof Error ? error.message : String(error)}`,
        );
        socket.destroy();
      });
    }),
  );
}

// --- the socket ------------------------------------------------------------------

/** The socket's directory, made 0700 if absent; refused unless ours and closed to others. */
async function prepareDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { uid, mode } = await stat(dir);
  if (uid !== process.getuid?.() || (mode & 0o077) !== 0) {
    throw new StartRefused(
      `${dir} must be owned by this user and closed to group and other (mode ${(mode & 0o777).toString(8)}, uid ${String(uid)})`,
    );
  }
}

/** One consumer: refuses when a server already answers at `path`. */
async function refuseIfLive(path: string): Promise<void> {
  const live = await connectUnix(path).then(
    (socket) => {
      socket.destroy();
      return true;
    },
    () => false,
  );
  if (live) {
    throw new StartRefused(`a runner already serves ${path}`);
  }
}

/**
 * Serves the control socket at `socketPath`. Refuses (StartRefused) when its
 * directory is open to others or another server answers there; a stale
 * socket file is replaced. The 0700 directory closes the window before chmod.
 */
export async function serveControl(deps: ControlDeps, socketPath: string): Promise<UnixServer> {
  await prepareDirectory(dirname(socketPath));
  await refuseIfLive(socketPath);
  const server = await serveUnix(socketPath, (socket) => {
    serveConnection(deps, socket);
  });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}
