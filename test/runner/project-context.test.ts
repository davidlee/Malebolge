// The runner's project-context fetch over a fake room shell (VT-1, design
// §4.2): the room SourceReader's argv and limits per exec, the pick of regular
// files from `stat -L` output, and every row of the error classification.

import { ExecutionError } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { SOURCE_CAP_BYTES } from "../../src/project-context.ts";
import type { RepoConfig } from "../../src/runner/config.ts";
import { PrepareFailed, preparingFailure } from "../../src/runner/prepare.ts";
import {
  type Degradation,
  DOCTRINE_LIMITS,
  type Fetched,
  fetchProjectContext,
} from "../../src/runner/project-context.ts";
import { FETCH_LIMITS, HEAD_LIMITS, type ReadFailure } from "../../src/room/source-reader.ts";
import { ChannelFailed, ChannelUnavailable, type ShellOutput } from "../../src/room/shell.ts";
import { checkRoomClone, PREPARE_LIMITS } from "../../src/runner/room.ts";
import {
  by,
  exit,
  never,
  overflowed,
  recordingShell,
  rejection,
  type ShellAnswer,
  type ShellCall,
} from "../room/shell-fixture.ts";

const GUEST = "/g";
const REPO: RepoConfig = {
  name: "r",
  path: "/r",
  guestPath: GUEST,
  defaultBranch: "main",
  ceilings: {},
};
const APPEND = `${GUEST}/.pi/APPEND_SYSTEM.md`;
const CHAIN = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].map(
  (name) => `${GUEST}/${name}`,
);
const [, AGENTS = "", , CLAUDE = ""] = CHAIN;

/** `stat`'s `%f` for a file of each kind. */
const REGULAR = "81a4";
const FIFO = "1000";
const CHAR_DEVICE = "2000";
const DIRECTORY = "41ed";

interface Entry {
  mode: string;
  /** What `head` reads; absent: it cannot read the file. */
  text?: string;
}
const regular = (text: string): Entry => ({ mode: REGULAR, text });

const statPaths = (argv: readonly string[]): string[] => argv.slice(argv.indexOf("--") + 1);

/**
 * An honest room holding `files`, without `.doctrine/`: `stat` prints the
 * mode of each requested path present (exit 1 when any is absent), `head`
 * prints a file's text, `test -d` finds all but `.doctrine`. `overrides`
 * replace any, by command (`by`).
 */
function room(
  files: Record<string, Entry>,
  overrides: Record<string, ShellAnswer> = {},
): ShellAnswer {
  return by({
    test: (argv) => exit(argv.includes(".doctrine") ? 1 : 0),
    stat: (argv) => {
      const paths = statPaths(argv);
      const found = paths.filter((path) => path in files);
      return exit(
        found.length === paths.length ? 0 : 1,
        found.map((path) => `${files[path]?.mode ?? ""} ${path}\n`).join(""),
        found.length === paths.length ? "" : "stat: cannot statx: No such file or directory\n",
      );
    },
    head: (argv) => {
      const text = files[argv.at(-1) ?? ""]?.text;
      return text === undefined ? exit(1, "", "head: cannot open\n") : exit(0, text);
    },
    ...overrides,
  });
}

/** The fetch as a room channel runs it: its re-check over the room's shell. */
const fetchStep = fetchProjectContext(REPO, checkRoomClone);

async function fetchOver(
  answer: ShellAnswer,
  signal = never(),
): Promise<{ fetched: Fetched; calls: ShellCall[] }> {
  const { shell, calls } = recordingShell(answer);
  return { fetched: await fetchStep(shell, signal), calls };
}

const headed = (calls: readonly ShellCall[]): string[] =>
  calls.filter((call) => call.argv[0] === "head").map((call) => call.argv.at(-1) ?? "");

const STAT = ["stat", "-L", "--printf", "%f %n\\n", "--"];

/** A ChannelFailed as the shell gives an exec's failure: pi-env's `code` as its cause. */
const failed = (code: ExecutionError["code"]): ChannelFailed =>
  new ChannelFailed(`exec: ${code}`, { cause: new ExecutionError(code, code) });

const throwing =
  (error: unknown): (() => never) =>
  () => {
    throw error;
  };

describe("fetchProjectContext's room reader (VT-1, design §4.2)", () => {
  it("bounds every fetch exec: 10 s, 4 KiB of stderr; stdout 4 KiB for stat, the cap + 1 for head", () => {
    expect(FETCH_LIMITS).toEqual({ timeoutS: 10, maxStdoutBytes: 4096, maxStderrBytes: 4096 });
    expect(HEAD_LIMITS).toEqual({
      timeoutS: 10,
      maxStdoutBytes: SOURCE_CAP_BYTES + 1,
      maxStderrBytes: 4096,
    });
  });

  it("runs one stat -L per directory and per APPEND_SYSTEM, head -c 65537 per read, all from the clone, all limited", async () => {
    const { fetched, calls } = await fetchOver(room({ [AGENTS]: regular("agents") }));

    expect(calls).toEqual([
      { argv: ["test", "-d", ".doctrine"], cwd: undefined, limits: FETCH_LIMITS },
      { argv: [...STAT, ...CHAIN], cwd: undefined, limits: FETCH_LIMITS },
      { argv: ["head", "-c", "65537", "--", AGENTS], cwd: undefined, limits: HEAD_LIMITS },
      { argv: [...STAT, APPEND], cwd: undefined, limits: FETCH_LIMITS },
    ]);
    expect(fetched).toEqual({
      sources: [{ origin: { path: AGENTS }, text: "agents" }],
      degraded: [],
    });
  });

  it("sources in render order: APPEND_SYSTEM, then the chain's first regular file", async () => {
    const { fetched } = await fetchOver(
      room({
        [APPEND]: regular("append"),
        [AGENTS]: regular("agents"),
        [CLAUDE]: regular("claude"),
      }),
    );

    expect(fetched.sources).toEqual([
      { origin: { path: APPEND }, text: "append" },
      { origin: { path: AGENTS }, text: "agents" },
    ]);
  });

  describe("picks only names stat reports as regular files", () => {
    it.each([
      ["a FIFO", FIFO],
      ["a character device", CHAR_DEVICE],
      ["a directory", DIRECTORY],
    ])("%s under a chain name or at APPEND_SYSTEM is never passed to head", async (_case, mode) => {
      const { fetched, calls } = await fetchOver(
        room({
          [APPEND]: { mode, text: "blocks" },
          [AGENTS]: { mode, text: "blocks" },
          [CLAUDE]: regular("claude"),
        }),
      );

      expect(headed(calls)).toEqual([CLAUDE]);
      expect(fetched).toEqual({
        sources: [{ origin: { path: CLAUDE }, text: "claude" }],
        degraded: [],
      });
    });

    it("stat exit 1 with partial output: the printed names are used", async () => {
      const { fetched } = await fetchOver(
        room(
          { [AGENTS]: regular("agents"), [CLAUDE]: regular("claude") },
          { stat: () => exit(1, `${REGULAR} ${CLAUDE}\n`, "stat: cannot statx\n") },
        ),
      );

      expect(fetched.sources.map((source) => source.origin)).toEqual([{ path: CLAUDE }]);
      expect(fetched.degraded).toEqual([]);
    });

    it("ignores names it did not ask for, and lines that do not parse", async () => {
      const printed = [
        `${REGULAR} /etc/passwd`,
        `${REGULAR} AGENTS.md`,
        `${REGULAR} ${GUEST}/EVIL.md`,
        `${REGULAR} ${GUEST}/./AGENTS.md`,
        `zz ${AGENTS}`,
        REGULAR,
        `${REGULAR}${AGENTS}`,
        "",
        `${REGULAR} ${CLAUDE}`,
      ].join("\n");
      const { calls } = await fetchOver(
        room({ [CLAUDE]: regular("claude") }, { stat: () => exit(0, printed) }),
      );

      expect(headed(calls)).toEqual([CLAUDE]);
    });
  });

  describe("classifies each failure (design §4.2 table)", () => {
    /** Where a failure is injected: the chain's stat, or head on AGENTS.md (CLAUDE.md then read). */
    const at: Record<"stat" | "head", { command: string; source: string; sources: string[] }> = {
      stat: { command: "stat", source: GUEST, sources: [] },
      head: { command: "head", source: AGENTS, sources: [CLAUDE] },
    };

    /** `answer` for the exec `where` names; the room's honest answer for the rest. */
    function failing(where: keyof typeof at, answer: () => ShellOutput): ShellAnswer {
      const honest = room({ [AGENTS]: regular("agents"), [CLAUDE]: regular("claude") });
      return (argv) =>
        argv[0] === at[where].command && argv.includes(AGENTS) ? answer() : honest(argv);
    }

    describe.each(["stat", "head"] as const)("through %s", (where) => {
      it.each([
        ["ChannelUnavailable", new ChannelUnavailable("room down")],
        [
          "ChannelUnavailable with a spawn_error cause (a room lost starting the exec)",
          new ChannelUnavailable("lost", { cause: new ExecutionError("spawn_error", "spawn") }),
        ],
        ["ChannelFailed host_key", new ChannelFailed("untrusted", { reason: "host_key" })],
        ["anything not a channel error (a bug)", new TypeError("bug")],
      ])("%s is rethrown", async (_case, error) => {
        expect(await rejection(fetchOver(failing(where, throwing(error))))).toBe(error);
      });

      it.each([
        ["spawn_error: missing", failed("spawn_error"), { reason: "missing" }],
        ["timeout: timeout", failed("timeout"), { reason: "timeout" }],
        ["any other code: error", failed("unknown"), { reason: "error", code: "unknown" }],
        [
          "a ChannelFailed without an exec cause: error, its reason",
          new ChannelFailed("refused", { reason: "channel_refusal" }),
          { reason: "error", code: "channel_refusal" },
        ],
      ])("ChannelFailed %s; that source omitted", async (_case, error, degradation) => {
        const { fetched } = await fetchOver(failing(where, throwing(error)));

        expect(fetched.degraded).toEqual([{ source: at[where].source, ...degradation }]);
        expect(fetched.sources.map((source) => source.origin)).toEqual(
          at[where].sources.map((path) => ({ path })),
        );
      });
    });

    it("stat overflowed: overflow, the directory's names omitted", async () => {
      const { fetched, calls } = await fetchOver(
        failing("stat", () => overflowed(`${REGULAR} ${AGENTS}\n`)),
      );

      expect(fetched).toEqual({ sources: [], degraded: [{ source: GUEST, reason: "overflow" }] });
      expect(headed(calls)).toEqual([]);
    });

    it("stat exiting with a code it does not name: error with the code and stderr", async () => {
      const { fetched } = await fetchOver(
        failing("stat", () => exit(2, `${REGULAR} ${AGENTS}\n`, "stat: bad option\n")),
      );

      expect(fetched).toEqual({
        sources: [],
        degraded: [{ source: GUEST, reason: "error", code: 2, stderr: "stat: bad option\n" }],
      });
    });

    it("an APPEND_SYSTEM stat failure names the file", async () => {
      const { fetched } = await fetchOver(
        room(
          {},
          {
            stat: (argv) =>
              argv.includes(APPEND) ? throwing(failed("timeout"))() : exit(1, "", ""),
          },
        ),
      );

      expect(fetched.degraded).toEqual([{ source: APPEND, reason: "timeout" }]);
    });

    it("head overflowed: the head is the source, truncated with its marker, not degraded", async () => {
      const head = "a".repeat(SOURCE_CAP_BYTES + 1);
      const { fetched } = await fetchOver(failing("head", () => overflowed(head)));

      expect(fetched.degraded).toEqual([]);
      expect(fetched.sources).toEqual([
        {
          origin: { path: AGENTS },
          text: `${"a".repeat(SOURCE_CAP_BYTES)}\n[truncated at ${String(SOURCE_CAP_BYTES)} bytes]`,
        },
      ]);
    });

    it("head exiting non-zero: the chain takes the next name, not degraded", async () => {
      const { fetched } = await fetchOver(failing("head", () => exit(1, "", "Permission denied")));

      expect(fetched).toEqual({
        sources: [{ origin: { path: CLAUDE }, text: "claude" }],
        degraded: [],
      });
    });

    it("degradations gather across execs, each naming its source", async () => {
      const { fetched } = await fetchOver(
        room(
          { [AGENTS]: regular("agents"), [CLAUDE]: regular("claude") },
          {
            head: (argv) => throwing(failed(argv.includes(AGENTS) ? "timeout" : "unknown"))(),
            stat: (argv) =>
              argv.includes(APPEND)
                ? throwing(failed("spawn_error"))()
                : exit(0, `${REGULAR} ${AGENTS}\n${REGULAR} ${CLAUDE}\n`),
          },
        ),
      );

      expect(fetched).toEqual({
        sources: [],
        degraded: [
          { source: AGENTS, reason: "timeout" },
          { source: CLAUDE, reason: "error", code: "unknown" },
          { source: APPEND, reason: "missing" },
        ] satisfies Degradation[],
      });
    });
  });

  describe("the caller's abort is tested before the table", () => {
    it.each(["stat", "head"])(
      "an abort during %s, which the shell reports as ChannelFailed aborted, is rethrown: no Fetched",
      async (command) => {
        const stop = new AbortController();
        const aborted = new ChannelFailed("exec: aborted", {
          cause: new ExecutionError("aborted", "aborted"),
        });
        const honest = room({ [AGENTS]: regular("agents") });
        const answer: ShellAnswer = (argv) => {
          if (argv[0] === command) {
            stop.abort();
            throw aborted;
          }
          return honest(argv);
        };

        expect(await rejection(fetchOver(answer, stop.signal))).toBe(aborted);
      },
    );
  });
});

describe("fetchProjectContext's doctrine step (VT-1, design §4.3)", () => {
  const DOCTRINE = ["doctrine", "prompt", "resolve", "--role", "orchestrator"];
  const BOOT = { command: DOCTRINE.join(" ") };
  const RECHECK = [
    { argv: ["test", "-d", `${GUEST}/.git`], cwd: "/", limits: PREPARE_LIMITS },
    {
      argv: ["git", "status", "--porcelain", "--untracked-files=normal"],
      cwd: undefined,
      limits: PREPARE_LIMITS,
    },
  ];

  /** A room with `.doctrine/`, its boot ignored, doctrine printing a boot, and `AGENTS.md`. */
  const doctrineRoom = (overrides: Record<string, ShellAnswer> = {}): ShellAnswer =>
    room(
      { [AGENTS]: regular("agents") },
      {
        test: () => exit(0),
        "check-ignore": () => exit(0),
        doctrine: () => exit(0, "boot\n"),
        ...overrides,
      },
    );

  /** `answer` for `test -d .doctrine`, the re-check's `test -d <guest>/.git` finding it. */
  const doctrineDir =
    (answer: ShellAnswer): ShellAnswer =>
    (argv) =>
      argv.includes(".doctrine") ? answer(argv) : exit(0);

  const commands = (calls: readonly ShellCall[]): string[] =>
    calls.map((call) => call.argv.slice(0, 2).join(" "));

  /** Whether the fetch ran anything that cleans the clone (preparing never does). */
  const cleaned = (calls: readonly ShellCall[]): boolean =>
    calls.some((call) => call.argv[0] === "git" && ["reset", "clean"].includes(call.argv[1] ?? ""));

  const agents = { origin: { path: AGENTS }, text: "agents" };

  it("bounds doctrine at 60 s, the cap + 1 bytes of stdout, 4 KiB of stderr", () => {
    expect(DOCTRINE_LIMITS).toEqual({
      timeoutS: 60,
      maxStdoutBytes: SOURCE_CAP_BYTES + 1,
      maxStderrBytes: 4096,
    });
  });

  it("tests for .doctrine/ and its ignored boot, runs doctrine, re-checks the clone, then reads the chain; all limited", async () => {
    const { fetched, calls } = await fetchOver(doctrineRoom());

    expect(calls.slice(0, 5)).toEqual([
      { argv: ["test", "-d", ".doctrine"], cwd: undefined, limits: FETCH_LIMITS },
      {
        argv: ["git", "check-ignore", "-q", ".doctrine/state/boot.md"],
        cwd: undefined,
        limits: FETCH_LIMITS,
      },
      { argv: DOCTRINE, cwd: undefined, limits: DOCTRINE_LIMITS },
      ...RECHECK,
    ]);
    expect(commands(calls.slice(5))).toEqual(["stat -L", "head -c", "stat -L"]);
    expect(fetched).toEqual({ sources: [{ origin: BOOT, text: "boot\n" }, agents], degraded: [] });
  });

  it("places the boot after APPEND_SYSTEM and before the chain", async () => {
    const { fetched } = await fetchOver(
      room(
        { [APPEND]: regular("append"), [AGENTS]: regular("agents") },
        { test: () => exit(0), "check-ignore": () => exit(0), doctrine: () => exit(0, "boot") },
      ),
    );

    expect(fetched.sources.map((source) => source.origin)).toEqual([
      { path: APPEND },
      BOOT,
      { path: AGENTS },
    ]);
  });

  it("no .doctrine/ (test -d exit 1): no doctrine exec, no degradation", async () => {
    const { fetched, calls } = await fetchOver(doctrineRoom({ test: doctrineDir(() => exit(1)) }));

    expect(commands(calls)).not.toContain("git check-ignore");
    expect(calls.map((call) => call.argv[0])).not.toContain("doctrine");
    expect(fetched).toEqual({ sources: [agents], degraded: [] });
  });

  it("boot not ignored (check-ignore exit 1): boot_not_ignored, no doctrine exec, the chain read", async () => {
    const { fetched, calls } = await fetchOver(doctrineRoom({ "check-ignore": () => exit(1) }));

    expect(calls.map((call) => call.argv[0])).not.toContain("doctrine");
    expect(fetched).toEqual({
      sources: [agents],
      degraded: [{ source: "doctrine", reason: "boot_not_ignored" }],
    });
  });

  it("check-ignore exiting 128 (not a repo, a bad pattern): error with its code and stderr", async () => {
    const { fetched, calls } = await fetchOver(
      doctrineRoom({ "check-ignore": () => exit(128, "", "fatal: not a git repository\n") }),
    );

    expect(calls.map((call) => call.argv[0])).not.toContain("doctrine");
    expect(fetched).toEqual({
      sources: [agents],
      degraded: [
        { source: "doctrine", reason: "error", code: 128, stderr: "fatal: not a git repository\n" },
      ],
    });
  });

  describe("each doctrine outcome is followed by the re-check, and the job continues", () => {
    const capped = "b".repeat(SOURCE_CAP_BYTES);
    it.each([
      [
        "overflowed: the head, truncated with its marker, not degraded",
        (): ShellOutput => overflowed(`${capped}b`),
        [{ origin: BOOT, text: `${capped}\n[truncated at ${String(SOURCE_CAP_BYTES)} bytes]` }],
        [],
      ],
      [
        "exit 0 with nothing but whitespace: empty",
        (): ShellOutput => exit(0, " \n\t\n"),
        [],
        [{ source: "doctrine", reason: "empty" }],
      ],
      [
        "exit 0 with nothing: empty",
        (): ShellOutput => exit(0),
        [],
        [{ source: "doctrine", reason: "empty" }],
      ],
      [
        "a non-zero exit: exit, its code and stderr",
        (): ShellOutput => exit(2, "half a boot", "no such role\n"),
        [],
        [{ source: "doctrine", reason: "exit", code: 2, stderr: "no such role\n" }],
      ],
      [
        "spawn_error (no doctrine on PATH): missing",
        throwing(failed("spawn_error")),
        [],
        [{ source: "doctrine", reason: "missing" }],
      ],
      [
        "timeout: timeout",
        throwing(failed("timeout")),
        [],
        [{ source: "doctrine", reason: "timeout" }],
      ],
      [
        "any other code: error",
        throwing(failed("unknown")),
        [],
        [{ source: "doctrine", reason: "error", code: "unknown" }],
      ],
    ] satisfies [string, ShellAnswer, Fetched["sources"], Degradation[]][])(
      "%s",
      async (_case, doctrine, boot, degraded) => {
        const { fetched, calls } = await fetchOver(doctrineRoom({ doctrine }));

        expect(calls.slice(3, 5)).toEqual(RECHECK);
        expect(fetched).toEqual({ sources: [...boot, agents], degraded });
      },
    );
  });

  describe("the re-check fails closed: dirty_clone, never a clean", () => {
    async function recheckFailure(
      overrides: Record<string, ShellAnswer>,
    ): Promise<{ error: unknown; calls: ShellCall[] }> {
      const { shell, calls } = recordingShell(doctrineRoom(overrides));
      const error = await rejection(fetchStep(shell, never()));
      expect(cleaned(calls)).toBe(false);
      expect(commands(calls)).not.toContain("stat -L");
      return { error, calls };
    }

    const reCheckTest =
      (answer: ShellAnswer): ShellAnswer =>
      (argv) =>
        argv.includes(".doctrine") ? exit(0) : answer(argv);

    it.each([
      [
        "doctrine left an untracked file: its path",
        { status: (): ShellOutput => exit(0, "?? stray.txt\n") },
        {
          reason: "dirty_clone",
          paths: ["stray.txt"],
        },
      ],
      [
        "status overflowed: the head's complete lines",
        { status: (): ShellOutput => overflowed("?? a\n?? b") },
        {
          reason: "dirty_clone",
          paths: ["a"],
        },
      ],
      [
        "status timed out: no paths",
        { status: throwing(failed("timeout")) },
        {
          reason: "dirty_clone",
          paths: [],
        },
      ],
      [
        "status exited non-zero: no paths",
        { status: (): ShellOutput => exit(128, "", "fatal\n") },
        {
          reason: "dirty_clone",
          paths: [],
        },
      ],
      [
        "status failed otherwise: no paths",
        { status: throwing(failed("unknown")) },
        {
          reason: "dirty_clone",
          paths: [],
        },
      ],
      [
        "test -d <guest>/.git overflowed: no paths",
        { test: reCheckTest(() => overflowed("y\n")) },
        {
          reason: "dirty_clone",
          paths: [],
        },
      ],
      [
        "doctrine removed .git: guest_path_invalid, as the check before it",
        {
          test: reCheckTest(() => exit(1)),
        },
        { reason: "guest_path_invalid", guestPath: GUEST },
      ],
    ] satisfies [string, Record<string, ShellAnswer>, Record<string, unknown>][])(
      "%s",
      async (_case, overrides, failure) => {
        const { error } = await recheckFailure(overrides);

        expect(error).toBeInstanceOf(PrepareFailed);
        expect(preparingFailure(error).failure).toEqual(failure);
      },
    );

    it.each([
      ["ChannelUnavailable (readyRoom retries)", new ChannelUnavailable("room down")],
      ["ChannelFailed host_key", new ChannelFailed("untrusted", { reason: "host_key" })],
    ])("%s from the re-check is rethrown", async (_case, thrown) => {
      const { error } = await recheckFailure({ status: throwing(thrown) });

      expect(error).toBe(thrown);
    });

    it("the re-check runs even when doctrine failed", async () => {
      const { error, calls } = await recheckFailure({
        doctrine: throwing(failed("timeout")),
        status: () => exit(0, "?? half-written\n"),
      });

      expect(preparingFailure(error).failure).toEqual({
        reason: "dirty_clone",
        paths: ["half-written"],
      });
      expect(calls.slice(3, 5)).toEqual(RECHECK);
    });
  });

  it.each([
    ["ChannelUnavailable", new ChannelUnavailable("room down")],
    ["ChannelFailed host_key", new ChannelFailed("untrusted", { reason: "host_key" })],
  ])("%s from doctrine is rethrown before any re-check", async (_case, thrown) => {
    const { shell, calls } = recordingShell(doctrineRoom({ doctrine: throwing(thrown) }));

    expect(await rejection(fetchStep(shell, never()))).toBe(thrown);
    expect(calls.map((call) => call.argv[0])).toEqual(["test", "git", "doctrine"]);
  });

  it("the caller's abort during doctrine is rethrown before any re-check", async () => {
    const stop = new AbortController();
    const aborted = new ChannelFailed("exec: aborted", {
      cause: new ExecutionError("aborted", "aborted"),
    });
    const { shell, calls } = recordingShell(
      doctrineRoom({
        doctrine: () => {
          stop.abort();
          throw aborted;
        },
      }),
    );

    expect(await rejection(fetchStep(shell, stop.signal))).toBe(aborted);
    expect(calls.map((call) => call.argv[0])).toEqual(["test", "git", "doctrine"]);
  });

  describe.each([
    ["test -d .doctrine", "test"],
    ["git check-ignore", "check-ignore"],
  ])("classifies %s's failures as §4.2's table, source doctrine", (_name, command) => {
    /** `answer` for the step `command` names; the doctrine room for the rest. */
    const at = (answer: ShellAnswer): Record<string, ShellAnswer> => ({
      [command]: command === "test" ? doctrineDir(answer) : answer,
    });

    it.each([
      ["ChannelUnavailable", new ChannelUnavailable("room down")],
      [
        "ChannelUnavailable with a spawn_error cause",
        new ChannelUnavailable("lost", { cause: new ExecutionError("spawn_error", "spawn") }),
      ],
      ["ChannelFailed host_key", new ChannelFailed("untrusted", { reason: "host_key" })],
      ["anything not a channel error (a bug)", new TypeError("bug")],
    ])("%s is rethrown", async (_case, error) => {
      expect(await rejection(fetchOver(doctrineRoom(at(throwing(error)))))).toBe(error);
    });

    it.each([
      ["spawn_error: missing", throwing(failed("spawn_error")), { reason: "missing" }],
      ["timeout: timeout", throwing(failed("timeout")), { reason: "timeout" }],
      ["overflowed: overflow", (): ShellOutput => overflowed("y\ny\n"), { reason: "overflow" }],
      ["any other code: error", throwing(failed("unknown")), { reason: "error", code: "unknown" }],
      [
        "an exit it does not name: error",
        (): ShellOutput => exit(2, "", "bad\n"),
        {
          reason: "error",
          code: 2,
          stderr: "bad\n",
        },
      ],
    ] satisfies [string, ShellAnswer, ReadFailure][])(
      "%s; no doctrine exec, the chain read",
      async (_case, answer, failure) => {
        const { fetched, calls } = await fetchOver(doctrineRoom(at(answer)));

        expect(calls.map((call) => call.argv[0])).not.toContain("doctrine");
        expect(fetched).toEqual({
          sources: [agents],
          degraded: [{ source: "doctrine", ...failure }],
        });
      },
    );
  });
});
