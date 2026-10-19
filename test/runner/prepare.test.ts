// Readying the room for a preparing job (EX-2, design §5.2, §5.4): the job
// branch made against real git through a local pi-env daemon, the base refreshed and recorded, and a
// room that is down retried with backoff up to `max_room_wait`. One
// `describe` per function; PHASE-15 appends room checks here.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { roomRetryDelay } from "../../src/runner/backoff.ts";
import type { RepoConfig, RunnerConfig } from "../../src/runner/config.ts";
import { RunnerError } from "../../src/runner/errors.ts";
import {
  ensureJobBranch,
  type FinalStep,
  PrepareFailed,
  preparingFailure,
  readyRoom,
  type ReadyDeps,
} from "../../src/runner/prepare.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  type CloneDefect,
  checkRoomClone,
  cleanRoomClone,
  type GitChannel,
  PREPARE_LIMITS,
  type RoomShell,
  type ShellOutput,
} from "../../src/runner/room.ts";
import { fetchProjectContext } from "../../src/runner/project-context.ts";
import { roomShell } from "../../src/runner/shell.ts";
import type { Job, JobStore } from "../../src/runner/store.ts";
import { localConnection } from "../room/connection-fixture.ts";
import { exampleConfig } from "./config-fixture.ts";
import {
  readying,
  type RoomKindWorld,
  type RoomWorld,
  roomKindWorld,
  roomWorld,
} from "./room-fixture.ts";
import {
  by,
  exit,
  never,
  overflowed,
  recordingShell,
  rejection,
  type ShellAnswer,
  shellKit,
} from "./shell-fixture.ts";
import { NEW_JOB, openTestStore, T0 } from "./store-fixture.ts";

const JOB_ID = "pj-1";
const { open, scratch } = shellKit();
const BASE = "b".repeat(40);

/** For a faked channel and shell: the repo is only passed through. */
const REPO: RepoConfig = {
  name: "r",
  path: "/r",
  guestPath: "/g",
  defaultBranch: "main",
  ceilings: {},
};

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
    /** Clone checks so far. */
    checks: () => number;
    /** Clone cleans tried so far (preparing never cleans). */
    cleans: () => number;
    slept: number[];
    shellCalls: string[][];
    shell: RoomShell;
  }

  interface ReadyOptions {
    /** Each refresh call takes the next step; the last repeats. Default: BASE. */
    refresh?: Step[];
    /** Each shell call takes the next answer; the last repeats. Default: branch absent, made. */
    shell?: (() => ShellOutput)[];
    /** Answers each shell call by its argv instead of `shell`'s sequence. */
    answer?: ShellAnswer;
    baseOid?: string;
    maxRoomWaitS?: number;
    /** Called on each pause, after the clock moves. */
    onSleep?: () => void;
    /** What every clone check finds; default none. */
    defect?: CloneDefect;
    /** The clone check run on each attempt; default: finds `defect`. */
    checkClone?: GitChannel["checkClone"];
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
    let checks = 0;
    let cleans = 0;
    const channel: GitChannel = {
      refresh: () => {
        const next = refreshSteps[Math.min(refreshes++, refreshSteps.length - 1)];
        return Promise.resolve().then(() => next?.() ?? BASE);
      },
      collect: () => Promise.reject(new Error("not in preparing")),
      reachable: () => Promise.resolve(true),
      checkClone: (shell, repo, signal) => {
        checks++;
        return options.checkClone?.(shell, repo, signal) ?? Promise.resolve(options.defect);
      },
      cleanClone: () => {
        cleans++;
        return Promise.reject(new Error("preparing never cleans"));
      },
    };
    const answers = options.shell ?? [(): ShellOutput => exit(1), (): ShellOutput => exit(0)];
    const shellCalls: string[][] = [];
    const shell: RoomShell = (argv) => {
      const answer = answers[Math.min(shellCalls.length, answers.length - 1)];
      shellCalls.push([...argv]);
      const { answer: byArgv } = options;
      return Promise.resolve().then(() =>
        byArgv === undefined ? (answer?.() ?? exit(0)) : byArgv(argv),
      );
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
    return {
      deps,
      jobs,
      job,
      refreshes: () => refreshes,
      checks: () => checks,
      cleans: () => cleans,
      slept,
      shellCalls,
      shell,
    };
  }

  const readyWith = <T>(
    w: ReadyWorld,
    finalStep: FinalStep<T>,
    signal = never(),
  ): Promise<{ baseOid: string; value: T }> =>
    readyRoom(w.deps, w.job, REPO, w.shell, signal, finalStep);

  const ready = async (w: ReadyWorld, signal = never()): Promise<string> =>
    (await readyWith(w, () => Promise.resolve(undefined), signal)).baseOid;

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
      shell: [down, (): ShellOutput => exit(1), (): ShellOutput => exit(0)],
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
    expect(failure).toMatchObject({ reason: "room_unavailable", channel: "channel_unavailable" });
    expect(endReason).toBe("room_unavailable");
  });

  it("retries a verb past its bound within max_room_wait, then fails audited channel_timeout", async () => {
    const timedOut = (): never => {
      throw new ChannelUnavailable("capsule push: timed out", { reason: "channel_timeout" });
    };
    const w = await readyWorld({ refresh: [timedOut], maxRoomWaitS: 2.5 });

    const { failure } = preparingFailure(await rejection(ready(w)));

    expect(w.slept).toEqual([1000, 1500]);
    expect(failure).toMatchObject({ reason: "room_unavailable", channel: "channel_timeout" });
  });

  it("checks the clone after the base and before the branch, on every attempt", async () => {
    const w = await readyWorld({
      shell: [
        (): ShellOutput => {
          throw new ChannelUnavailable("room down");
        },
        (): ShellOutput => exit(1),
        (): ShellOutput => exit(0),
      ],
    });

    await ready(w);

    expect(w.checks()).toBe(2);
    expect(w.refreshes()).toBe(1);
  });

  it("a clone defect fails preparing with it, before any branch work", async () => {
    const defect: CloneDefect = { reason: "dirty_clone", paths: ["x"] };
    const w = await readyWorld({ defect });

    const error = await rejection(ready(w));

    expect(preparingFailure(error)).toEqual({ failure: defect, endReason: "error" });
    expect(w.shellCalls).toEqual([]);
    expect(w.slept).toEqual([]);
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

  // A preparing exec past PREPARE_LIMITS.timeoutS, as the shell reports it.
  const timedOut = (): never => {
    throw new ChannelFailed("git: timeout", { cause: new ExecutionError("timeout", "timeout:60") });
  };

  it.each([
    ["checkRoomClone", { checkClone: checkRoomClone, shell: [timedOut] }],
    ["ensureJobBranch", { shell: [timedOut] }],
  ])("a timeout in %s fails preparing channel_failed, never retried", async (_case, options) => {
    const w = await readyWorld(options);

    const error = await rejection(ready(w));

    expect(preparingFailure(error)).toMatchObject({
      failure: { reason: "channel_failed" },
      endReason: "error",
    });
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

  describe("its FinalStep (VT-3, design §4.2)", () => {
    it("runs last, after the job branch, with the loop's shell and signal; its value is returned beside the base", async () => {
      const w = await readyWorld();
      const stop = new AbortController();
      const seen: { shell: RoomShell; signal: AbortSignal; callsBefore: string[][] }[] = [];

      const readied = await readyWith(
        w,
        (shell, signal) => {
          seen.push({ shell, signal, callsBefore: w.shellCalls.map((argv) => [...argv]) });
          return Promise.resolve("fetched");
        },
        stop.signal,
      );

      expect(readied).toEqual({ baseOid: BASE, value: "fetched" });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.shell).toBe(w.shell);
      expect(seen[0]?.signal).toBe(stop.signal);
      expect(seen[0]?.callsBefore.map((argv) => argv[1])).toEqual(["rev-parse", "switch"]);
    });

    it("a ChannelUnavailable inside the step is retried, and the failed attempt's data is discarded", async () => {
      // Attempt 1 makes the branch; attempt 2 finds it at the base and switches.
      const w = await readyWorld({
        shell: [
          (): ShellOutput => exit(1),
          (): ShellOutput => exit(0),
          (): ShellOutput => exit(0, `${BASE}\n`),
          (): ShellOutput => exit(0),
        ],
      });
      let attempts = 0;
      const step: FinalStep<string[]> = () => {
        const degraded = [`attempt ${String(++attempts)}`];
        if (attempts === 1) {
          // A room lost while starting an exec: a spawn_error cause, still a retry.
          return Promise.reject(
            new ChannelUnavailable("lost", {
              cause: new ExecutionError("spawn_error", "spawn"),
            }),
          );
        }
        return Promise.resolve(degraded);
      };

      const readied = await readyWith(w, step);

      expect(readied).toEqual({ baseOid: BASE, value: ["attempt 2"] });
      expect(w.slept).toEqual([roomRetryDelay(0)]);
      expect(w.refreshes()).toBe(1);
      expect(w.checks()).toBe(2);
    });

    it.each([
      ["a ChannelFailed", new ChannelFailed("host key", { reason: "host_key" })],
      ["a PrepareFailed", new PrepareFailed({ reason: "dirty_clone", paths: [] })],
    ])("%s from the step propagates, never retried", async (_case, failure) => {
      const w = await readyWorld();

      expect(await rejection(readyWith(w, () => Promise.reject(failure)))).toBe(failure);
      expect(w.slept).toEqual([]);
    });

    it("fetchProjectContext as the step: its re-check is the channel's, a defect after doctrine fails preparing, unretried, never cleaned", async () => {
      const defect: CloneDefect = { reason: "dirty_clone", paths: ["doctrine-wrote-this"] };
      let checked = 0;
      const w = await readyWorld({
        answer: by({ doctrine: () => exit(0, "boot") }),
        checkClone: () => Promise.resolve(checked++ === 0 ? undefined : defect),
      });

      const error = await rejection(
        readyWith(w, fetchProjectContext(REPO, w.deps.channel.checkClone)),
      );

      expect(preparingFailure(error).failure).toEqual(defect);
      expect(w.checks()).toBe(2);
      expect(w.slept).toEqual([]);
      expect(w.cleans()).toBe(0);
      expect(w.shellCalls.filter((argv) => ["reset", "clean"].includes(argv[1] ?? ""))).toEqual([]);
    });
  });
});

describe("readyRoom over a room's clone: checked, never cleaned (VT-7, EX-6)", () => {
  function world(): RoomKindWorld {
    return roomKindWorld({ guestAtClone: true });
  }

  /** The clone as `git status` sees it, and whether `job/<id>` exists. */
  const tree = (w: RoomKindWorld, jobId: string): { status: string; branch: boolean } => {
    let branch = true;
    try {
      w.room.git("rev-parse", "--verify", "--quiet", `refs/heads/job/${jobId}`);
    } catch {
      branch = false;
    }
    return { status: w.room.git("status", "--porcelain", "--ignored"), branch };
  };

  it("a fresh unborn clone takes git switch -c job/<id> <oid> at the oid push delivered", async () => {
    const w = world();
    const r = await readying(w);

    const base = await r.ready();

    expect(base).toBe(w.real.git("rev-parse", "main"));
    expect(w.room.git("symbolic-ref", "--short", "HEAD")).toBe(`job/${r.job.id}`);
    expect(w.room.git("rev-parse", "HEAD")).toBe(base);
  });

  it.each([
    ["has no .git", async (): Promise<string> => scratch()],
    ["is absent", async (): Promise<string> => `${await scratch()}/absent`],
  ])("a guest_path that %s: failed(error), guest_path_invalid", async (_case, path) => {
    const w = world();
    const r = await readying(w);
    const guestPath = await path();

    const { failure, endReason } = preparingFailure(
      await rejection(r.ready({ ...w.repo, guestPath })),
    );

    expect(failure).toEqual({ reason: "guest_path_invalid", guestPath });
    expect(endReason).toBe("error");
  });

  it("an untracked file is dirty_clone, its paths audited, the tree left as found", async () => {
    const w = world();
    const r = await readying(w);
    writeFileSync(join(w.room.path, "notes.txt"), "residue\n");
    mkdirSync(join(w.room.path, "nested"));
    writeFileSync(join(w.room.path, "nested", "a.txt"), "residue\n");
    const before = tree(w, r.job.id);

    const error = await rejection(r.ready());

    expect(error).toBeInstanceOf(PrepareFailed);
    expect(preparingFailure(error)).toEqual({
      failure: { reason: "dirty_clone", paths: ["nested/", "notes.txt"] },
      endReason: "error",
    });
    expect(tree(w, r.job.id)).toEqual(before);
    expect(before.branch).toBe(false);
  });

  it("a git status past PREPARE_LIMITS' stdout cap is dirty_clone, its paths the complete head", async () => {
    const w = world();
    // 2000 untracked files, each a 44-byte porcelain line "?? <40 chars>\n": 88 000 bytes.
    const names = Array.from(
      { length: 2000 },
      (_, i) => `untracked-${String(i).padStart(30, "0")}`,
    );
    for (const name of names) {
      writeFileSync(join(w.room.path, name), "");
    }

    const shell = roomShell(open(localConnection()), JOB_ID, w.room.path);

    const defect = await checkRoomClone(shell, w.repo, never());

    expect(defect?.reason).toBe("dirty_clone");
    const paths = defect?.reason === "dirty_clone" ? defect.paths : [];
    // The 64 KiB head holds floor(65_536 / 44) complete lines.
    expect(paths).toEqual(names.slice(0, Math.floor(PREPARE_LIMITS.maxStdoutBytes / 44)));
  });

  it("an ignored file is not dirty: the job branch is made", async () => {
    const w = world();
    const r = await readying(w);
    writeFileSync(join(w.room.path, ".git", "info", "exclude"), "cache/\n");
    mkdirSync(join(w.room.path, "cache"));
    writeFileSync(join(w.room.path, "cache", "built.o"), "cached\n");

    await r.ready();

    expect(w.room.git("symbolic-ref", "--short", "HEAD")).toBe(`job/${r.job.id}`);
    expect(w.room.git("status", "--porcelain", "--ignored")).toBe("!! cache/");
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
      "a ChannelFailed refusal is channel_refusal, audited apart (a runner bug)",
      new ChannelFailed("exited 2", { reason: "channel_refusal" }),
      { reason: "channel_refusal", message: "exited 2" },
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

describe("preparing execs carry PREPARE_LIMITS (VT-2, design §4.2)", () => {
  it("are bounded to 60 s, 64 KiB of stdout and 4 KiB of stderr", () => {
    expect(PREPARE_LIMITS).toEqual({ timeoutS: 60, maxStdoutBytes: 65_536, maxStderrBytes: 4096 });
  });

  it("checkRoomClone passes PREPARE_LIMITS on test -d and git status", async () => {
    const { shell, calls } = recordingShell(by());

    expect(await checkRoomClone(shell, REPO, never())).toBeUndefined();

    expect(calls.map((call) => [call.argv[0], call.argv[1], call.limits])).toEqual([
      ["test", "-d", PREPARE_LIMITS],
      ["git", "status", PREPARE_LIMITS],
    ]);
    expect(calls.every((call) => call.limits === PREPARE_LIMITS)).toBe(true);
  });

  const REV_PARSE = ["git", "rev-parse", "--verify", "--quiet", `refs/heads/job/${JOB_ID}`];

  it.each([
    ["absent: switch -c", exit(1), ["git", "switch", "--quiet", "-c", `job/${JOB_ID}`, BASE]],
    ["at the base: switch", exit(0, `${BASE}\n`), ["git", "switch", "--quiet", `job/${JOB_ID}`]],
  ])(
    "ensureJobBranch passes PREPARE_LIMITS on rev-parse and switch, branch %s",
    async (_case, found, switched) => {
      const { shell, calls } = recordingShell(by({ "rev-parse": () => found }));

      await ensureJobBranch(shell, JOB_ID, BASE, never());

      expect(calls).toEqual([
        { argv: REV_PARSE, cwd: undefined, limits: PREPARE_LIMITS },
        { argv: switched, cwd: undefined, limits: PREPARE_LIMITS },
      ]);
    },
  );

  it("cleanRoomClone passes no limits: it runs after collect, outside preparing", async () => {
    const { shell, calls } = recordingShell(by());

    await cleanRoomClone(shell, never());

    expect(calls.map((call) => [call.argv[1], call.limits])).toEqual([
      ["reset", undefined],
      ["clean", undefined],
    ]);
  });

  it.each([
    ["its complete lines", " M a.txt\n?? new/\n?? partial-na", ["a.txt", "new/"]],
    ["no complete line", "?? partial-na", []],
  ])("a git status that overflows is dirty_clone, paths from %s", async (_case, head, paths) => {
    const { shell } = recordingShell(by({ status: () => overflowed(head) }));

    expect(await checkRoomClone(shell, REPO, never())).toEqual({ reason: "dirty_clone", paths });
  });

  it.each([
    [
      "test -d",
      "test",
      (shell: RoomShell): Promise<unknown> => checkRoomClone(shell, REPO, never()),
    ],
    [
      "git rev-parse",
      "rev-parse",
      (shell: RoomShell): Promise<unknown> => ensureJobBranch(shell, JOB_ID, BASE, never()),
    ],
    [
      "git switch",
      "switch",
      (shell: RoomShell): Promise<unknown> => ensureJobBranch(shell, JOB_ID, BASE, never()),
    ],
  ])(
    "%s that overflows is ChannelFailed: no overflow is expected there",
    async (_case, command, step) => {
      const { shell } = recordingShell(by({ [command]: () => overflowed("x") }));

      const error = await rejection(step(shell));

      expect(error).toBeInstanceOf(ChannelFailed);
      expect(error).toMatchObject({ reason: "channel_failed" });
      expect(error instanceof Error ? error.message : "").toMatch(/output overflowed$/);
    },
  );
});
