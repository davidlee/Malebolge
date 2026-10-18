// Readying the room for a preparing job (EX-2, design §5.2, §5.4): the room's
// shell over the job's daemon connection, the job branch made against real
// git through a local pi-env daemon, the base refreshed and recorded, and a
// room that is down retried with backoff up to `max_room_wait`. One
// `describe` per function; PHASE-15 appends room checks here.

import type { Connection } from "@earendil-works/pi-env";
import { afterEach, describe, expect, it } from "vitest";
import { roomRetryDelay } from "../../src/runner/backoff.ts";
import type { RepoConfig, RunnerConfig } from "../../src/runner/config.ts";
import { RunnerError } from "../../src/runner/errors.ts";
import {
  ensureJobBranch,
  PrepareFailed,
  preparingFailure,
  readyRoom,
  type ReadyDeps,
  type RoomShell,
  roomShell,
  type ShellOutput,
} from "../../src/runner/prepare.ts";
import { ChannelFailed, ChannelUnavailable, type GitChannel } from "../../src/runner/room.ts";
import type { Job, JobStore } from "../../src/runner/store.ts";
import { tempDir } from "../fixtures.ts";
import { exampleConfig } from "./config-fixture.ts";
import { localConnection, lostConnection } from "./env-fixture.ts";
import { type RoomWorld, roomWorld } from "./room-fixture.ts";
import { NEW_JOB, openTestStore, T0 } from "./store-fixture.ts";

const JOB_ID = "pj-1";
const never = (): AbortSignal => new AbortController().signal;

/** Connections a test opened; closed after it. */
const opened: Connection[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const connection of opened.splice(0)) {
    connection.close();
  }
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function open(connection: Connection): Connection {
  opened.push(connection);
  return connection;
}

/** A temp dir removed after the test. */
async function scratch(): Promise<string> {
  const tmp = await tempDir();
  cleanups.push(tmp.cleanup);
  return tmp.dir;
}

/** Rejection of `promise`, or a failure if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("roomShell", () => {
  const shellIn = (connection: Connection, cwd: string): RoomShell =>
    roomShell(open(connection), JOB_ID, cwd);

  it("answers the exit code and captures stdout and stderr", async () => {
    const shell = shellIn(localConnection(), await scratch());

    const output = await shell(["sh", "-c", "echo out; echo err >&2; exit 3"], never());

    expect(output).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("a lost daemon connection is ChannelUnavailable: the room is down", async () => {
    const shell = shellIn(lostConnection(), await scratch());

    expect(await rejection(shell(["true"], never()))).toBeInstanceOf(ChannelUnavailable);
  });

  it("an exec that fails on a live connection is ChannelFailed: not retried", async () => {
    const shell = shellIn(localConnection(), `${await scratch()}/absent`);

    expect(await rejection(shell(["true"], never()))).toBeInstanceOf(ChannelFailed);
  });
});

describe("ensureJobBranch (real git through a local daemon)", () => {
  interface BranchWorld {
    world: RoomWorld;
    shell: RoomShell;
    base: string;
    git: (...args: string[]) => string;
  }

  function branchWorld(): BranchWorld {
    const world = roomWorld({ guestAtClone: true });
    const shell = roomShell(open(localConnection()), JOB_ID, world.room.path);
    const git = world.room.git;
    return { world, shell, base: git("rev-parse", "HEAD"), git };
  }

  it("makes job/<id> at base_oid and checks it out when absent", async () => {
    const { shell, base, git } = branchWorld();

    await ensureJobBranch(shell, JOB_ID, base, never());

    expect(git("rev-parse", `job/${JOB_ID}`)).toBe(base);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe(`job/${JOB_ID}`);
  });

  it("switches to job/<id> already at base_oid, leaving it there", async () => {
    const { shell, base, git } = branchWorld();
    git("branch", `job/${JOB_ID}`, base);

    await ensureJobBranch(shell, JOB_ID, base, never());

    expect(git("rev-parse", `job/${JOB_ID}`)).toBe(base);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe(`job/${JOB_ID}`);
  });

  it("never moves job/<id> found at another oid: PrepareFailed job_branch_moved", async () => {
    const { world, shell, base, git } = branchWorld();
    const moved = world.guestJob(JOB_ID, "stray.txt");
    git("switch", "--quiet", "work");

    const error = await rejection(ensureJobBranch(shell, JOB_ID, base, never()));

    expect(error).toBeInstanceOf(PrepareFailed);
    expect(preparingFailure(error).failure).toEqual({
      reason: "job_branch_moved",
      branch: `job/${JOB_ID}`,
      baseOid: base,
      found: moved,
    });
    expect(git("rev-parse", `job/${JOB_ID}`)).toBe(moved);
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("work");
  });
});

describe("readyRoom", () => {
  const BASE = "b".repeat(40);
  type Step = () => string;
  const down = (): never => {
    throw new ChannelUnavailable("room down");
  };

  interface ReadyWorld {
    deps: ReadyDeps;
    jobs: JobStore;
    job: Job;
    /** Refresh calls so far. */
    refreshes: () => number;
    slept: number[];
    shellCalls: string[][];
    shell: RoomShell;
  }

  interface ReadyOptions {
    /** Each refresh call takes the next step; the last repeats. Default: BASE. */
    refresh?: Step[];
    /** Each shell call takes the next answer; the last repeats. Default: branch absent, made. */
    shell?: (() => ShellOutput)[];
    baseOid?: string;
    maxRoomWaitS?: number;
    /** Called on each pause, after the clock moves. */
    onSleep?: () => void;
  }

  async function readyWorld(options: ReadyOptions = {}): Promise<ReadyWorld> {
    const { jobs } = await openTestStore();
    const { job: queued } = await jobs.submit(NEW_JOB, T0);
    const job = await jobs.transition(
      queued.id,
      "preparing",
      T0,
      {},
      options.baseOid === undefined ? {} : { baseOid: options.baseOid },
    );
    const refreshSteps = options.refresh ?? [(): string => BASE];
    let refreshes = 0;
    const channel: GitChannel = {
      refresh: () => {
        const next = refreshSteps[Math.min(refreshes++, refreshSteps.length - 1)];
        return Promise.resolve().then(() => next?.() ?? BASE);
      },
      collect: () => Promise.reject(new Error("not in preparing")),
      reachable: () => Promise.resolve(true),
    };
    const answers = options.shell ?? [
      (): ShellOutput => ({ code: 1, stdout: "", stderr: "" }),
      (): ShellOutput => ({ code: 0, stdout: "", stderr: "" }),
    ];
    const shellCalls: string[][] = [];
    const shell: RoomShell = (argv) => {
      const answer = answers[Math.min(shellCalls.length, answers.length - 1)];
      shellCalls.push([...argv]);
      return Promise.resolve().then(() => answer?.() ?? { code: 0, stdout: "", stderr: "" });
    };
    const example = exampleConfig();
    const config: RunnerConfig = {
      ...example,
      maxima: { ...example.maxima, maxRoomWaitS: options.maxRoomWaitS ?? 60 },
    };
    let clock = T0;
    const slept: number[] = [];
    const deps: ReadyDeps = {
      jobs,
      channel,
      config,
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        options.onSleep?.();
        return Promise.resolve();
      },
    };
    return { deps, jobs, job, refreshes: () => refreshes, slept, shellCalls, shell };
  }

  /** The channel and shell are faked: the repo is only passed through. */
  const REPO: RepoConfig = { path: "/r", guestPath: "/g", defaultBranch: "main", ceilings: {} };

  const ready = (w: ReadyWorld, signal = never()): Promise<string> =>
    readyRoom(w.deps, w.job, REPO, w.shell, signal);

  it("refreshes the base once, records it with a refreshed event, and makes the job branch at it", async () => {
    const w = await readyWorld();

    expect(await ready(w)).toBe(BASE);

    expect(w.refreshes()).toBe(1);
    expect((await w.jobs.get(w.job.id))?.baseOid).toBe(BASE);
    const events = await w.jobs.events(w.job.id);
    expect(
      events.filter((event) => event.kind === "refreshed").map((event) => event.payload),
    ).toEqual([{ baseRef: w.job.baseRef, baseOid: BASE }]);
    expect(w.shellCalls.at(-1)).toEqual([
      "git",
      "switch",
      "--quiet",
      "-c",
      `job/${w.job.id}`,
      BASE,
    ]);
  });

  it("keeps a recorded base_oid: no second refresh", async () => {
    const recorded = "c".repeat(40);
    const w = await readyWorld({ baseOid: recorded });

    expect(await ready(w)).toBe(recorded);

    expect(w.refreshes()).toBe(0);
  });

  it("retries a room down at refresh with backoff, recording the base once", async () => {
    const w = await readyWorld({ refresh: [down, down, (): string => BASE] });

    expect(await ready(w)).toBe(BASE);

    expect(w.slept).toEqual([roomRetryDelay(0), roomRetryDelay(1)]);
    expect(w.refreshes()).toBe(3);
    const refreshed = (await w.jobs.events(w.job.id)).filter((event) => event.kind === "refreshed");
    expect(refreshed).toHaveLength(1);
  });

  it("retries a room down in the shell without refreshing again", async () => {
    const w = await readyWorld({
      shell: [
        down,
        (): ShellOutput => ({ code: 1, stdout: "", stderr: "" }),
        (): ShellOutput => ({ code: 0, stdout: "", stderr: "" }),
      ],
    });

    expect(await ready(w)).toBe(BASE);

    expect(w.slept).toEqual([roomRetryDelay(0)]);
    expect(w.refreshes()).toBe(1);
  });

  it("past max_room_wait from state_entered_at: PrepareFailed room_unavailable, pauses capped by the time left", async () => {
    const w = await readyWorld({ refresh: [down], maxRoomWaitS: 2.5 });

    const error = await rejection(ready(w));

    expect(w.slept).toEqual([1000, 1500]);
    expect(error).toBeInstanceOf(PrepareFailed);
    const { failure, endReason } = preparingFailure(error);
    expect(failure).toMatchObject({ reason: "room_unavailable" });
    expect(endReason).toBe("room_unavailable");
  });

  it("does not retry ChannelFailed", async () => {
    const failed = new ChannelFailed("refused");
    const w = await readyWorld({
      refresh: [
        (): never => {
          throw failed;
        },
      ],
    });

    expect(await rejection(ready(w))).toBe(failed);
    expect(w.slept).toEqual([]);
  });

  it("stops before the next attempt once its signal aborts", async () => {
    const stop = new AbortController();
    const w = await readyWorld({
      refresh: [down],
      onSleep: () => {
        stop.abort();
      },
    });

    await rejection(ready(w, stop.signal));

    expect(w.refreshes()).toBe(1);
    expect(w.slept).toHaveLength(1);
  });
});

describe("preparingFailure", () => {
  it.each([
    [
      "PrepareFailed keeps its failure and end reason",
      new PrepareFailed({ reason: "room_unavailable", message: "down" }, "room_unavailable"),
      { reason: "room_unavailable", message: "down" },
      "room_unavailable",
    ],
    [
      "a RunnerError is its code",
      new RunnerError("base_ref_invalid", "not a branch"),
      { reason: "base_ref_invalid", message: "not a branch" },
      "error",
    ],
    [
      "ChannelFailed is channel_failed",
      new ChannelFailed("exited 1"),
      { reason: "channel_failed", message: "exited 1" },
      "error",
    ],
    [
      "anything else is prepare_failed",
      "odd",
      { reason: "prepare_failed", message: "odd" },
      "error",
    ],
  ] as const)("%s", (_title, error, failure, endReason) => {
    expect(preparingFailure(error)).toEqual({ failure, endReason });
  });
});
