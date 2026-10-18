// Shared parts of the env-gated live checks against the deployed runner
// (live-smoke.ts, live-host-key.ts; SL-023 PHASE-12 EX-6, EX-10): the gate, the
// smoke's request, following a job over the control socket, the scratch
// instance's config and tampered known_hosts, and reading a store's audit.
// Not a test: the scripts that use it are run by a human, never by `just check`.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { parse, stringify } from "smol-toml";
import { isRecord, type JsonRecord } from "../../src/json.ts";
import type { Env } from "../../src/runner/errors.ts";
import { TERMINAL } from "../../src/runner/jobs.ts";
import { type RunnerPaths, runnerPaths } from "../../src/runner/start.ts";

/** Refuses unless the caller opted in: these scripts drive the live room. */
export function requireLive(env: Env): void {
  if (env["SATAN_RUNNER_LIVE"] !== "1") {
    throw new Error("live check: set SATAN_RUNNER_LIVE=1 to run against the deployed room");
  }
}

/**
 * The deployed runner's config, socket and store, by the runner's own rules;
 * the config is the unit's (features/satan/runner.nix) unless the caller names one.
 */
export function deployedPaths(env: Env): RunnerPaths {
  const home = env["HOME"] ?? "";
  return runnerPaths({
    SATAN_RUNNER_CONFIG: join(home, ".config", "satan-runner", "config.toml"),
    ...env,
  });
}

/** `response` when it is ok; otherwise an Error naming `op` and the refusal. */
export function answered(response: JsonRecord, op: string): JsonRecord {
  if (response["ok"] !== true) {
    throw new Error(`${op} refused: ${JSON.stringify(response["error"] ?? response)}`);
  }
  return response;
}

export interface SmokeOptions {
  submissionId: string;
  /** Written into SMOKE.md, so each run's commit is its own. */
  date: string;
  /** Sleep first, long enough for the operator to stop the room mid-run. */
  slow: boolean;
}

/** The smoke's `submit` fields: one `fix` job on goad-walk, one exact file. */
export function smokeSubmit({ submissionId, date, slow }: SmokeOptions): JsonRecord & {
  directive: string;
} {
  const task =
    `Create the file SMOKE.md at the repository root containing exactly one line, ` +
    `\`runner smoke ${date}\`, and commit it. Change nothing else.`;
  return {
    submissionId,
    mode: "fix",
    repo: "goad-walk",
    allowedPaths: ["SMOKE.md"],
    directive: slow ? `First run \`sleep 120\` in the shell. Then: ${task}` : task,
  };
}

/** A job awaiting review, or one that ended: the smoke follows a job until then. */
const SETTLED: readonly string[] = ["needs_review", ...TERMINAL];

export interface FollowOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Called once per state the job is seen in, in order. */
  onState: (state: string, job: JsonRecord) => void;
}

type Call = (op: string, fields?: JsonRecord) => Promise<JsonRecord>;

/** The job's summary from a `status` response; fails on a refusal. */
function jobOf(response: JsonRecord): JsonRecord {
  const job = answered(response, "status")["job"];
  if (!isRecord(job)) {
    throw new Error(`status has no job: ${JSON.stringify(response)}`);
  }
  return job;
}

/** Polls `status` for `jobId` until it settles; resolves with its last summary. */
export async function followJob(
  client: { call: Call },
  jobId: string,
  { intervalMs, timeoutMs, onState }: FollowOptions,
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    const job = jobOf(await client.call("status", { jobId }));
    const state = String(job["state"]);
    if (state !== last) {
      last = state;
      onState(state, job);
    }
    if (SETTLED.includes(state)) {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${String(timeoutMs)} ms, job ${jobId} ${state}`);
    }
    await sleep(intervalMs);
  }
}

/** Where the key body sits in a known_hosts line: past the type's own prefix. */
const TAMPER_FROM_END = 10;

/**
 * `text` with one base64 character of `alias`'s key changed: the line still
 * parses, the key is another one. Every other line is left as is.
 */
export function tamperKnownHosts(text: string, alias: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.split(" ")[0] === alias);
  const [host, type, body, ...rest] = lines[index]?.split(" ") ?? [];
  if (host === undefined || type === undefined || body === undefined) {
    throw new Error(`known_hosts has no key line for ${alias}`);
  }
  const at = body.length - TAMPER_FROM_END;
  const swapped = body[at] === "A" ? "B" : "A";
  const tampered = [host, type, body.slice(0, at) + swapped + body.slice(at + 1), ...rest];
  return lines.map((line, i) => (i === index ? tampered.join(" ") : line)).join("\n");
}

/** The deployed config `text`, enabled and reading `knownHosts`; nothing else changes. */
export function scratchConfig(text: string, knownHosts: string): string {
  const doc = parse(text);
  const door = doc["door"];
  if (!isRecord(door)) {
    throw new Error("config has no [door] table");
  }
  return stringify({ ...doc, enabled: true, door: { ...door, known_hosts: knownHosts } });
}

export interface JobEvent {
  kind: string;
  payload: JsonRecord;
}

const failedTransition = (events: readonly JobEvent[]): JobEvent | undefined =>
  events.find((event) => event.kind === "transition" && event.payload["to"] === "failed");

const paused = (events: readonly JobEvent[]): boolean =>
  events.some((event) => event.kind === "transition" && event.payload["to"] === "waiting_room");

/** EX-10c: the job failed `host_key` out of `preparing`, and never paused. */
export function hostKeyVerdict(
  events: readonly JobEvent[],
): { ok: true } | { ok: false; why: string } {
  if (paused(events)) {
    return { ok: false, why: "the job paused (waiting_room): a host key failure must not" };
  }
  const failed = failedTransition(events);
  if (failed === undefined) {
    return { ok: false, why: "the job never failed" };
  }
  const { from, reason } = failed.payload;
  if (from !== "preparing" || reason !== "host_key") {
    return { ok: false, why: `failed from ${String(from)}, reason ${String(reason)}` };
  }
  return { ok: true };
}

/** Job `jobId`'s audit, read from the store at `path` without writing to it. */
export function readJobEvents(path: string, jobId: string): (JobEvent & { at: string })[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT at, kind, payload FROM job_events WHERE job_id = ? ORDER BY seq")
      .all(jobId);
    return rows.map((row) => {
      const payload: unknown = JSON.parse(String(row["payload"]));
      return {
        at: String(row["at"]),
        kind: String(row["kind"]),
        payload: isRecord(payload) ? payload : {},
      };
    });
  } finally {
    db.close();
  }
}

/** The hex sha256 of the file at `path`. */
export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Resolves once `path` exists; fails after `timeoutMs`. */
export async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`${path} did not appear within ${String(timeoutMs)} ms`, { cause: error });
      }
    }
    await sleep(200);
  }
}

/** One log line, stamped with the wall clock. */
export const log = (text: string): void => {
  console.log(`[${new Date().toISOString()}] ${text}`);
};
