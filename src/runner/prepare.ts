// Readying the room for a preparing job (design §5.2, §5.4): the base
// refreshed into the room's clone and recorded as `base_oid`, then `job/<id>`
// made there at that oid through the job's environment. The room being down
// is retried with backoff, bounded by `max_room_wait` from when the job
// entered `preparing`; nothing here touches the conversation.

import { withAbortSignal } from "@earendil-works/chord/context";
import type { Connection } from "@earendil-works/pi-env";
import { context } from "../context.ts";
import type { JsonRecord } from "../json.ts";
import { roomRetryDelay, type Sleep } from "./backoff.ts";
import type { RepoConfig, RunnerConfig } from "./config.ts";
import { jobEnv } from "./env.ts";
import { isRunnerError, messageOf } from "./errors.ts";
import { ChannelFailed, ChannelUnavailable, type GitChannel, jobBranch } from "./room.ts";
import type { Job, JobStore } from "./store.ts";
import type { EndReason } from "./vocab.ts";

/** Preparing cannot go on; `failure` is the row's reason. */
export class PrepareFailed extends Error {
  readonly failure: JsonRecord;
  readonly endReason: EndReason;

  constructor(failure: JsonRecord & { reason: string }, endReason: EndReason = "error") {
    super(failure.reason);
    this.name = "PrepareFailed";
    this.failure = failure;
    this.endReason = endReason;
  }
}

/** What a failed preparing step records: why, and the end reason. */
export function preparingFailure(error: unknown): { failure: JsonRecord; endReason: EndReason } {
  if (error instanceof PrepareFailed) {
    return { failure: error.failure, endReason: error.endReason };
  }
  return {
    failure: { reason: failureReason(error), message: messageOf(error) },
    endReason: "error",
  };
}

function failureReason(error: unknown): string {
  if (isRunnerError(error)) {
    return error.code;
  }
  if (error instanceof ChannelFailed) {
    return "channel_failed";
  }
  return "prepare_failed";
}

// --- the room's shell ------------------------------------------------------------

export interface ShellOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an argument vector in the room's clone; ChannelUnavailable when the room is down. */
export type RoomShell = (argv: readonly string[], signal: AbortSignal) => Promise<ShellOutput>;

/**
 * A shell in the room's clone `cwd` over the job's daemon `connection`. The
 * environment turns a lost connection into an exec failure; its connection
 * reports the loss by type first, which is what makes it ChannelUnavailable.
 */
export function roomShell(connection: Connection, jobId: string, cwd: string): RoomShell {
  let losses = 0;
  const env = jobEnv({
    jobId,
    cwd,
    connection,
    observer: {
      lost: () => {
        losses++;
        return Promise.resolve();
      },
    },
  });
  return async (argv, signal) => {
    const before = losses;
    const output = { stdout: "", stderr: "" };
    const result = await env.exec(
      argv,
      {
        onOutput: (text, _context, info) => {
          output[info.stream] += text;
        },
      },
      withAbortSignal(signal, context),
    );
    if (result.ok) {
      return { code: result.value.exitCode, ...output };
    }
    const message = `${argv.join(" ")}: ${result.error.message}`;
    throw losses > before
      ? new ChannelUnavailable(message, { cause: result.error })
      : new ChannelFailed(message, { cause: result.error });
  };
}

async function succeeded(
  shell: RoomShell,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const output = await shell(argv, signal);
  if (output.code !== 0) {
    throw new ChannelFailed(
      `${argv.join(" ")} exited ${String(output.code)}: ${output.stderr.trim()}`,
    );
  }
  return output.stdout;
}

/**
 * `job/<jobId>` checked out at `baseOid` in the room's clone: made when absent,
 * switched to when already there (a redo after restart). At another oid it is
 * never moved: PrepareFailed `job_branch_moved`.
 */
export async function ensureJobBranch(
  shell: RoomShell,
  jobId: string,
  baseOid: string,
  signal: AbortSignal,
): Promise<void> {
  const branch = jobBranch(jobId);
  const found = await shell(
    ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    signal,
  );
  if (found.code === 1) {
    await succeeded(shell, ["git", "switch", "--quiet", "-c", branch, baseOid], signal);
    return;
  }
  if (found.code !== 0) {
    throw new ChannelFailed(`git rev-parse ${branch} exited ${String(found.code)}`);
  }
  const oid = found.stdout.trim();
  if (oid !== baseOid) {
    throw new PrepareFailed({ reason: "job_branch_moved", branch, baseOid, found: oid });
  }
  await succeeded(shell, ["git", "switch", "--quiet", branch], signal);
}

// --- readying, with backoff ------------------------------------------------------

export interface ReadyDeps {
  jobs: JobStore;
  channel: GitChannel;
  config: RunnerConfig;
  now: () => number;
  sleep: Sleep;
}

/** Refreshes the base into the room and records it, audited `refreshed`. */
async function recordBase(deps: ReadyDeps, job: Job, repo: RepoConfig): Promise<string> {
  const baseOid = await deps.channel.refresh(repo, job.baseRef);
  await deps.jobs.change(job.id, deps.now(), () => ({
    update: { baseOid },
    event: { kind: "refreshed", payload: { baseRef: job.baseRef, baseOid } },
  }));
  return baseOid;
}

/**
 * The room ready for preparing `job`: its base refreshed (once; a recorded
 * `base_oid` is kept) and the job branch at it. Returns the base oid. A room
 * that is down is retried until `max_room_wait` from `state_entered_at`, then
 * PrepareFailed `room_unavailable`. Stops early, rethrowing, once `signal`
 * aborts.
 */
export async function readyRoom(
  deps: ReadyDeps,
  job: Job,
  repo: RepoConfig,
  shell: RoomShell,
  signal: AbortSignal,
): Promise<string> {
  const deadline = job.stateEnteredAt + deps.config.maxima.maxRoomWaitS * 1000;
  let baseOid = job.baseOid;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      baseOid ??= await recordBase(deps, job, repo);
      await ensureJobBranch(shell, job.id, baseOid, signal);
      return baseOid;
    } catch (error) {
      if (!(error instanceof ChannelUnavailable)) {
        throw error;
      }
      const left = deadline - deps.now();
      if (left <= 0) {
        throw new PrepareFailed(
          { reason: "room_unavailable", message: error.message },
          "room_unavailable",
        );
      }
      await deps.sleep(Math.min(roomRetryDelay(attempt), left), signal);
    }
  }
}
