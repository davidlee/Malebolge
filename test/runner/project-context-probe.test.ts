// RV-033 F-1's probe (VT-2, EX-3): readyRoom with fetchProjectContext as its
// final step, over a real room clone and a local pi-env daemon whose PATH
// puts a directory of fake binaries first (a repo's tool set). Context files
// are real FIFOs (`mkfifo`) and devices (`/dev/zero`), directly or through a
// symlink into an ignored path; the fakes lie, print names nobody asked for,
// stream without end or never exit. Each case asserts its outcome, and that
// preparing took no longer than the sum of the timeouts of the execs it ran,
// each exec within its own timeout and its output within its caps.
//
// Hostile binaries run time-scaled (design note D-7): each exec's timeout
// reaches the real shell divided by 20 (10 s → 0.5 s, 60 s → 3 s), so the
// real pi-env timeout and kill still happen, after the production limits are
// asserted as requested. Honest binaries run unscaled: a FIFO must be skipped
// well inside head's 10 s, and never passed to it.
//
// A character device can only be reached through a symlink to /dev/zero: a
// device node in the clone needs mknod, which needs root.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_CAP_BYTES } from "../../src/project-context.ts";
import { type FinalStep, preparingFailure } from "../../src/runner/prepare.ts";
import {
  DOCTRINE_LIMITS,
  FETCH_LIMITS,
  type Fetched,
  fetchProjectContext,
  HEAD_LIMITS,
} from "../../src/runner/project-context.ts";
import { ChannelFailed, PREPARE_LIMITS, type ShellLimits } from "../../src/runner/room.ts";
import { localConnection, pathWith } from "./env-fixture.ts";
import { fakeBin, pathWithout, realBin } from "./fake-bin.ts";
import { tempDir, type TestRepo } from "./git-fixture.ts";
import { type RoomKindWorld, readying, roomKindWorld } from "./room-fixture.ts";
import { type ObservedCall, observedShell } from "./shell-fixture.ts";

/** Hostile cases: each exec's timeout is divided by this before it reaches the shell. */
const TIME_DIVISOR = 20;
/** What one exec may take past its timeout: the daemon's kill and the round trip. */
const EXEC_SLACK_MS = 1500;
/** What preparing may take past the sum of its execs' timeouts: daemon start, fake capsule, git. */
const RUN_SLACK_MS = 3000;
/** An honest stat's FIFO is skipped well inside head's 10 s timeout. */
const HONEST_STEP_MS = 3000;

const PROBE_TIMEOUT_MS = 20_000;

/**
 * The limits production requests for `argv`: the fetch's for its own execs
 * (`stat`, `head`, the doctrine step's `test -d .doctrine` and `git
 * check-ignore`, doctrine itself); preparing's for the rest (checkClone, both
 * times, and the job branch), though they run the same binaries.
 */
function limitsFor(argv: readonly string[]): ShellLimits {
  const [command, first, second] = argv;
  if (command === "doctrine") {
    return DOCTRINE_LIMITS;
  }
  if (command === "head") {
    return HEAD_LIMITS;
  }
  const fetchProbe =
    command === "stat" ||
    (command === "test" && second === ".doctrine") ||
    (command === "git" && first === "check-ignore");
  return fetchProbe ? FETCH_LIMITS : PREPARE_LIMITS;
}

interface ProbeOptions {
  /** Commits in the real repo, beyond the regular `CLAUDE.md` every probe has. */
  base?: (real: TestRepo) => void;
  /** What is made in the room's clone (untracked) before readying. */
  clone?: (clone: string) => void;
  /** Fake binaries first on the daemon's PATH, by name: each a `/bin/sh` body. */
  fakes?: (world: RoomKindWorld) => Record<string, string>;
  /** Divide each exec's timeout by TIME_DIVISOR. */
  scaled?: boolean;
  /** The daemon's PATH, from the fakes' directory; default that directory first, then the host's. */
  path?: (bin: string) => string;
}

interface ProbeRun {
  world: RoomKindWorld;
  /** readyRoom's fetched value, or what it threw. */
  outcome: { fetched: Fetched } | { error: unknown };
  calls: ObservedCall[];
  /** All of readyRoom: base refresh, clone check, job branch, fetch. */
  elapsedMs: number;
  /** The fetch alone. */
  stepMs: number;
}

/** A symlink `name` → `target` committed in `real`. */
function commitLink(real: TestRepo, name: string, target: string): void {
  const path = join(real.path, name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  real.git("add", "--", name);
  real.git("commit", "--quiet", "--no-verify", "-m", `link ${name}`);
}

/** A file `name` holding `text`, committed in `real`. */
function commitText(real: TestRepo, name: string, text: string): void {
  const path = join(real.path, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  real.git("add", "--", name);
  real.git("commit", "--quiet", "--no-verify", "-m", `add ${name}`);
}

/** A FIFO at `path`, parent directories made. */
function fifo(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync("mkfifo", [path]);
}

async function probe(options: ProbeOptions = {}): Promise<ProbeRun> {
  const world = roomKindWorld({ guestAtClone: true });
  world.real.commit("CLAUDE.md");
  options.base?.(world.real);
  options.clone?.(world.room.path);
  const bin = tempDir("mb-bin-");
  for (const [name, body] of Object.entries(options.fakes?.(world) ?? {})) {
    fakeBin(bin, name, body);
  }
  let calls: ObservedCall[] = [];
  const r = await readying(world, {
    connect: () => localConnection((options.path ?? pathWith)(bin)),
    wrap: (shell) => {
      const observed = observedShell(shell, {
        timeScale: options.scaled === true ? 1 / TIME_DIVISOR : 1,
      });
      calls = observed.calls;
      return observed.shell;
    },
  });
  const fetch = fetchProjectContext(world.repo, world.channel.checkClone);
  let stepMs = 0;
  const timed: FinalStep<Fetched> = async (shell, signal) => {
    const start = performance.now();
    try {
      return await fetch(shell, signal);
    } finally {
      stepMs = performance.now() - start;
    }
  };
  const start = performance.now();
  let outcome: ProbeRun["outcome"];
  try {
    outcome = { fetched: (await r.readyWith(timed)).value };
  } catch (error) {
    outcome = { error };
  }
  return { world, outcome, calls, elapsedMs: performance.now() - start, stepMs };
}

/**
 * F-1's criterion for `run`: every exec requested its production limits, its
 * output stayed within their caps, and it took no longer than the timeout it
 * was given; preparing took no longer than the sum of those timeouts.
 */
function expectBounded(run: ProbeRun): void {
  expect(run.calls.length).toBeGreaterThan(0);
  let boundMs = RUN_SLACK_MS;
  for (const call of run.calls) {
    const limits = limitsFor(call.argv);
    expect(call.limits, call.argv.join(" ")).toBe(limits);
    expect(call.stdoutBytes).toBeLessThanOrEqual(limits.maxStdoutBytes ?? 0);
    expect(call.stderrBytes).toBeLessThanOrEqual(limits.maxStderrBytes ?? 0);
    const timeoutMs = (call.passedTimeoutS ?? Infinity) * 1000;
    expect(call.ms, call.argv.join(" ")).toBeLessThanOrEqual(timeoutMs + EXEC_SLACK_MS);
    boundMs += timeoutMs;
  }
  expect(run.elapsedMs).toBeLessThanOrEqual(boundMs);
}

function fetched(run: ProbeRun): Fetched {
  if ("error" in run.outcome) {
    throw new Error(`readyRoom threw: ${String(run.outcome.error)}`);
  }
  return run.outcome.fetched;
}

function failure(run: ProbeRun): ReturnType<typeof preparingFailure> & { error: unknown } {
  if (!("error" in run.outcome)) {
    throw new Error("readyRoom did not throw");
  }
  return { ...preparingFailure(run.outcome.error), error: run.outcome.error };
}

const at = (run: ProbeRun, name: string): string => join(run.world.room.path, name);

const headed = (run: ProbeRun): string[] =>
  run.calls.filter((call) => call.argv[0] === "head").map((call) => call.argv.at(-1) ?? "");

/** The fall-through every probe has: `CLAUDE.md`, as `commit` writes it. */
const claude = (run: ProbeRun): Fetched["sources"][number] => ({
  origin: { path: at(run, "CLAUDE.md") },
  text: "CLAUDE.md\n",
});

const TRUNCATED = `\n[truncated at ${String(SOURCE_CAP_BYTES)} bytes]`;

/** A fake that, for the args after `--`, prints each as a regular file. */
const LYING_STAT = `after=
for a in "$@"; do
  if [ -n "$after" ]; then printf '81a4 %s\\n' "$a"; fi
  if [ "$a" = "--" ]; then after=1; fi
done`;

describe("fetchProjectContext in readyRoom over a hostile room (VT-2, RV-033 F-1)", {
  timeout: PROBE_TIMEOUT_MS,
}, () => {
  it("the PATH fixture: a fake first on the daemon's PATH is the one the room shell runs", async () => {
    const run = await probe({ fakes: () => ({ head: "printf 'from the fake head'" }) });

    expect(fetched(run).sources).toEqual([
      { origin: { path: at(run, "CLAUDE.md") }, text: "from the fake head" },
    ]);
  });

  describe("honest binaries: a FIFO or device is never opened, and skipping it is prompt", () => {
    /** Unscaled: the fetch well under head's 10 s, no head argv for `skipped`, CLAUDE.md read. */
    function expectSkipped(run: ProbeRun, skipped: string): void {
      const target = statSync(at(run, skipped));
      expect(target.isFIFO() || target.isCharacterDevice()).toBe(true);
      expectBounded(run);
      expect(run.stepMs).toBeLessThan(HONEST_STEP_MS);
      expect(headed(run)).not.toContain(at(run, skipped));
      expect(fetched(run)).toEqual({ sources: [claude(run)], degraded: [] });
    }

    it("P1: a FIFO named AGENTS.md, untracked in the clone (mkfifo)", async () => {
      const run = await probe({
        clone: (clone) => {
          fifo(join(clone, "AGENTS.md"));
        },
      });

      expectSkipped(run, "AGENTS.md");
    });

    it("P2: AGENTS.md a committed symlink to a FIFO under an ignored path", async () => {
      const run = await probe({
        base: (real) => {
          commitText(real, ".gitignore", "ignored/\n");
          commitLink(real, "AGENTS.md", "ignored/fifo");
        },
        clone: (clone) => {
          fifo(join(clone, "ignored", "fifo"));
        },
      });

      expectSkipped(run, "AGENTS.md");
    });

    it("P3: AGENTS.md a committed symlink to /dev/zero", async () => {
      const run = await probe({
        base: (real) => {
          commitLink(real, "AGENTS.md", "/dev/zero");
        },
      });

      expectSkipped(run, "AGENTS.md");
    });

    it.each([
      [
        "a FIFO (mkfifo)",
        {
          clone: (clone: string): void => {
            fifo(join(clone, ".pi", "APPEND_SYSTEM.md"));
          },
        },
      ],
      [
        "a committed symlink to /dev/zero",
        {
          base: (real: TestRepo): void => {
            commitLink(real, ".pi/APPEND_SYSTEM.md", "/dev/zero");
          },
        },
      ],
    ])("P4: .pi/APPEND_SYSTEM.md as %s", async (_case, options) => {
      const run = await probe(options);

      expectSkipped(run, ".pi/APPEND_SYSTEM.md");
    });
  });

  describe("hostile binaries, time-scaled", () => {
    it("P5: a lying stat (every name regular): head on a FIFO is stopped by its timeout, then CLAUDE.md is read", async () => {
      const run = await probe({
        scaled: true,
        clone: (clone) => {
          fifo(join(clone, "AGENTS.md"));
        },
        fakes: () => ({ stat: LYING_STAT }),
      });

      expectBounded(run);
      expect(fetched(run)).toEqual({
        sources: [claude(run)],
        degraded: [{ source: at(run, "AGENTS.md"), reason: "timeout" }],
      });
      const blocked = run.calls.find((call) => call.argv.at(-1) === at(run, "AGENTS.md"));
      expect(blocked?.limits?.timeoutS).toBe(HEAD_LIMITS.timeoutS);
      expect(blocked?.passedTimeoutS).toBe(HEAD_LIMITS.timeoutS / TIME_DIVISOR);
    });

    it("P5: a lying stat over a symlink to /dev/zero: head's cap + 1 bytes, truncated, bounded", async () => {
      const run = await probe({
        scaled: true,
        base: (real) => {
          commitLink(real, "AGENTS.md", "/dev/zero");
        },
        fakes: () => ({ stat: LYING_STAT }),
      });

      expectBounded(run);
      expect(fetched(run)).toEqual({
        sources: [
          {
            origin: { path: at(run, "AGENTS.md") },
            text: `${"\0".repeat(SOURCE_CAP_BYTES)}${TRUNCATED}`,
          },
        ],
        degraded: [],
      });
    });

    it("P6: a stat printing names nobody asked for: none of them is read", async () => {
      const run = await probe({
        scaled: true,
        base: (real) => real.commit("EVIL.md"),
        fakes: (world) => ({
          stat: `printf '81a4 /etc/passwd\\n81a4 %s/EVIL.md\\n' '${world.room.path}'
exec ${realBin("stat")} "$@"`,
        }),
      });

      expectBounded(run);
      expect(headed(run)).toEqual([at(run, "CLAUDE.md")]);
      expect(fetched(run)).toEqual({ sources: [claude(run)], degraded: [] });
    });

    it("P7: a head streaming without end: the cap's head, truncated, promptly", async () => {
      const run = await probe({ scaled: true, fakes: () => ({ head: "exec yes" }) });

      expectBounded(run);
      expect(run.stepMs).toBeLessThan(HONEST_STEP_MS);
      const { sources, degraded } = fetched(run);
      expect(degraded).toEqual([]);
      expect(sources).toEqual([
        {
          origin: { path: at(run, "CLAUDE.md") },
          text: `${"y\n".repeat(SOURCE_CAP_BYTES / 2)}${TRUNCATED}`,
        },
      ]);
    });

    it("P8: a head that never exits: a timeout per source, each bounded", async () => {
      const run = await probe({
        scaled: true,
        base: (real) => real.commit("AGENTS.md"),
        fakes: () => ({ head: "exec sleep 30" }),
      });

      expectBounded(run);
      expect(fetched(run)).toEqual({
        sources: [],
        degraded: [
          { source: at(run, "AGENTS.md"), reason: "timeout" },
          { source: at(run, "CLAUDE.md"), reason: "timeout" },
        ],
      });
    });

    it.each([
      ["streaming without end: overflow", "exec yes", "overflow"],
      ["never exiting: timeout", "exec sleep 30", "timeout"],
    ])("P9: a stat %s, for the directory and for APPEND_SYSTEM", async (_case, body, reason) => {
      const run = await probe({ scaled: true, fakes: () => ({ stat: body }) });

      expectBounded(run);
      expect(headed(run)).toEqual([]);
      expect(fetched(run)).toEqual({
        sources: [],
        degraded: [
          { source: run.world.room.path, reason },
          { source: at(run, ".pi/APPEND_SYSTEM.md"), reason },
        ],
      });
    });

    it("P10: a test that never exits on -d <guest>/.git: checkClone times out, preparing fails within one 60 s timeout", async () => {
      const run = await probe({
        scaled: true,
        fakes: (world) => ({
          test: `if [ "$1" = "-d" ] && [ "$2" = "${world.room.path}/.git" ]; then exec sleep 30; fi
exec ${realBin("test")} "$@"`,
        }),
      });

      expectBounded(run);
      const { failure: why, error } = failure(run);
      expect(why).toMatchObject({ reason: "channel_failed" });
      expect(error).toBeInstanceOf(ChannelFailed);
      expect(run.calls.map((call) => call.argv[0])).toEqual(["test"]);
      expect(run.calls[0]?.passedTimeoutS).toBe(PREPARE_LIMITS.timeoutS / TIME_DIVISOR);
    });

    it.each([
      ["never exits: preparing fails channel_failed", "exec sleep 30", "channel_failed"],
      ["streams without end: dirty_clone", "exec yes", "dirty_clone"],
    ])("P11: a git whose status in checkClone %s, bounded", async (_case, hostile, reason) => {
      const run = await probe({
        scaled: true,
        fakes: () => ({
          git: `if [ "$1" = "status" ]; then ${hostile}; fi
exec ${realBin("git")} "$@"`,
        }),
      });

      expectBounded(run);
      expect(failure(run).failure).toMatchObject({ reason });
      expect(run.calls.map((call) => call.argv.slice(0, 2))).toEqual([
        ["test", "-d"],
        ["git", "status"],
      ]);
    });

    it.each([
      ["rev-parse", "never exits", "exec sleep 30"],
      ["rev-parse", "streams without end", "exec yes"],
      ["switch", "never exits", "exec sleep 30"],
      ["switch", "streams without end", "exec yes"],
    ])(
      "P16: a git whose %s in ensureJobBranch %s: preparing fails channel_failed, the fetch not run, bounded",
      async (subcommand, _case, hostile) => {
        const run = await probe({
          scaled: true,
          fakes: () => ({
            git: `if [ "$1" = "${subcommand}" ]; then ${hostile}; fi
exec ${realBin("git")} "$@"`,
          }),
        });

        expectBounded(run);
        const { failure: why, error } = failure(run);
        expect(why).toMatchObject({ reason: "channel_failed" });
        expect(error).toBeInstanceOf(ChannelFailed);
        const last = run.calls.at(-1);
        expect(last?.argv.slice(0, 2)).toEqual(["git", subcommand]);
        expect(last?.passedTimeoutS).toBe(PREPARE_LIMITS.timeoutS / TIME_DIVISOR);
        expect(run.stepMs).toBe(0);
      },
    );
  });

  describe("doctrine's boot and the clone re-check (design §4.3)", () => {
    /** `real` with doctrine set up: a committed `.doctrine/`, its state ignored. */
    function doctrineRepo(real: TestRepo, ignore = ".doctrine/state/\n"): void {
      real.commit(".doctrine/config.toml");
      if (ignore !== "") {
        commitText(real, ".gitignore", ignore);
      }
      real.commit("AGENTS.md");
    }

    /** A fake doctrine as the real one behaves: the boot written to its ignored file, and printed. */
    const WRITES_BOOT = `mkdir -p .doctrine/state
printf 'the boot\\n' > .doctrine/state/boot.md
exec ${realBin("cat")} .doctrine/state/boot.md`;

    const doctrineCall = (run: ProbeRun): ObservedCall | undefined =>
      run.calls.find((call) => call.argv[0] === "doctrine");

    /** The execs after doctrine, up to the chain: the re-check. */
    const recheck = (run: ProbeRun): string[][] => {
      const after = run.calls.findIndex((call) => call.argv[0] === "doctrine") + 1;
      return run.calls.slice(after, after + 2).map((call) => call.argv.slice(0, 2));
    };
    const RECHECK = [
      ["test", "-d"],
      ["git", "status"],
    ];

    const agentsMd = (run: ProbeRun): Fetched["sources"][number] => ({
      origin: { path: at(run, "AGENTS.md") },
      text: "AGENTS.md\n",
    });
    const BOOT = { command: "doctrine prompt resolve --role orchestrator" };

    it("P12: a doctrine writing its ignored boot and printing it: a source before AGENTS.md, the clone still clean", async () => {
      const run = await probe({
        scaled: true,
        base: (real) => {
          doctrineRepo(real);
        },
        fakes: () => ({ doctrine: WRITES_BOOT }),
      });

      expectBounded(run);
      expect(fetched(run)).toEqual({
        sources: [{ origin: BOOT, text: "the boot\n" }, agentsMd(run)],
        degraded: [],
      });
      expect(recheck(run)).toEqual(RECHECK);
      expect(existsSync(at(run, ".doctrine/state/boot.md"))).toBe(true);
    });

    it("P12: a doctrine streaming without end: the cap's head, truncated, promptly", async () => {
      const run = await probe({
        scaled: true,
        base: (real) => {
          doctrineRepo(real);
        },
        fakes: () => ({ doctrine: "exec yes" }),
      });

      expectBounded(run);
      expect(run.stepMs).toBeLessThan(HONEST_STEP_MS);
      expect(fetched(run)).toEqual({
        sources: [
          { origin: BOOT, text: `${"y\n".repeat(SOURCE_CAP_BYTES / 2)}${TRUNCATED}` },
          agentsMd(run),
        ],
        degraded: [],
      });
    });

    it("P12: a doctrine that never exits: timeout within one 60 s timeout, then the re-check, the job going on", async () => {
      const run = await probe({
        scaled: true,
        base: (real) => {
          doctrineRepo(real);
        },
        fakes: () => ({ doctrine: "exec sleep 30" }),
      });

      expectBounded(run);
      expect(doctrineCall(run)?.passedTimeoutS).toBe(DOCTRINE_LIMITS.timeoutS / TIME_DIVISOR);
      expect(recheck(run)).toEqual(RECHECK);
      expect(fetched(run)).toEqual({
        sources: [agentsMd(run)],
        degraded: [{ source: "doctrine", reason: "timeout" }],
      });
    });

    it("P12: a doctrine leaving an untracked file: PrepareFailed dirty_clone, the file left there (never cleaned)", async () => {
      const run = await probe({
        scaled: true,
        base: (real) => {
          doctrineRepo(real);
        },
        fakes: () => ({ doctrine: `printf stray > stray.txt\n${WRITES_BOOT}` }),
      });

      expectBounded(run);
      expect(failure(run).failure).toEqual({ reason: "dirty_clone", paths: ["stray.txt"] });
      expect(existsSync(at(run, "stray.txt"))).toBe(true);
      expect(run.calls.some((call) => ["reset", "clean"].includes(call.argv[1] ?? ""))).toBe(false);
    });

    it("P13: a git whose status never exits once doctrine has run: dirty_clone, no paths, bounded", async () => {
      const marker = join(tempDir("mb-mark-"), "doctrine-ran");
      const run = await probe({
        scaled: true,
        base: (real) => {
          doctrineRepo(real);
        },
        fakes: () => ({
          doctrine: `touch '${marker}'\n${WRITES_BOOT}`,
          git: `if [ "$1" = "status" ] && [ -e '${marker}' ]; then exec sleep 30; fi
exec ${realBin("git")} "$@"`,
        }),
      });

      expectBounded(run);
      expect(failure(run).failure).toEqual({ reason: "dirty_clone", paths: [] });
      const status = run.calls.filter((call) => call.argv[1] === "status");
      expect(status.map((call) => call.rejected)).toEqual([false, true]);
      expect(status[1]?.passedTimeoutS).toBe(PREPARE_LIMITS.timeoutS / TIME_DIVISOR);
    });

    it.each([
      ["streaming without end: overflow", "exec yes", "overflow"],
      ["never exiting: timeout", "exec sleep 30", "timeout"],
    ])(
      "P14: a test %s on -d .doctrine: degraded, doctrine not run, the chain read",
      async (_case, hostile, reason) => {
        const run = await probe({
          scaled: true,
          base: (real) => {
            doctrineRepo(real);
          },
          fakes: () => ({
            doctrine: WRITES_BOOT,
            test: `if [ "$1" = "-d" ] && [ "$2" = ".doctrine" ]; then ${hostile}; fi
exec ${realBin("test")} "$@"`,
          }),
        });

        expectBounded(run);
        expect(doctrineCall(run)).toBeUndefined();
        expect(fetched(run)).toEqual({
          sources: [agentsMd(run)],
          degraded: [{ source: "doctrine", reason }],
        });
      },
    );

    it.each([
      ["streaming without end: overflow", "exec yes", "overflow"],
      ["never exiting: timeout", "exec sleep 30", "timeout"],
    ])(
      "P14: a git check-ignore %s: degraded, doctrine not run, the chain read",
      async (_case, hostile, reason) => {
        const run = await probe({
          scaled: true,
          base: (real) => {
            doctrineRepo(real);
          },
          fakes: () => ({
            doctrine: WRITES_BOOT,
            git: `if [ "$1" = "check-ignore" ]; then ${hostile}; fi
exec ${realBin("git")} "$@"`,
          }),
        });

        expectBounded(run);
        const ignore = run.calls.find((call) => call.argv[1] === "check-ignore");
        expect(ignore?.passedTimeoutS).toBe(FETCH_LIMITS.timeoutS / TIME_DIVISOR);
        expect(doctrineCall(run)).toBeUndefined();
        expect(fetched(run)).toEqual({
          sources: [agentsMd(run)],
          degraded: [{ source: "doctrine", reason }],
        });
      },
    );

    it("P15: no doctrine on the daemon's PATH: missing (pi-env's spawn_error), then the re-check, the chain read", async () => {
      const run = await probe({
        base: (real) => {
          doctrineRepo(real);
        },
        path: (bin) => pathWithout("doctrine", bin),
      });

      expectBounded(run);
      expect(doctrineCall(run)?.rejected).toBe(true);
      expect(recheck(run)).toEqual(RECHECK);
      expect(fetched(run)).toEqual({
        sources: [agentsMd(run)],
        degraded: [{ source: "doctrine", reason: "missing" }],
      });
    });

    it(".doctrine/ present, its boot not ignored: boot_not_ignored, doctrine not run, the chain read", async () => {
      const run = await probe({
        base: (real) => {
          doctrineRepo(real, "");
        },
        fakes: () => ({ doctrine: WRITES_BOOT }),
      });

      expectBounded(run);
      expect(doctrineCall(run)).toBeUndefined();
      expect(fetched(run)).toEqual({
        sources: [agentsMd(run)],
        degraded: [{ source: "doctrine", reason: "boot_not_ignored" }],
      });
    });
  });
});
