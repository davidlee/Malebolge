// The runner's project-context fetch over a fake room shell (VT-1, design
// §4.2): the room SourceReader's argv and limits per exec, the pick of regular
// files from `stat -L` output, and every row of the error classification.

import { ExecutionError } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { SOURCE_CAP_BYTES } from "../../src/project-context.ts";
import type { RepoConfig } from "../../src/runner/config.ts";
import {
  type Degradation,
  FETCH_LIMITS,
  type Fetched,
  fetchProjectContext,
  HEAD_LIMITS,
} from "../../src/runner/project-context.ts";
import { ChannelFailed, ChannelUnavailable, type ShellOutput } from "../../src/runner/room.ts";
import {
  by,
  exit,
  never,
  overflowed,
  recordingShell,
  rejection,
  type ShellAnswer,
  type ShellCall,
} from "./shell-fixture.ts";

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
 * An honest room holding `files`: `stat` prints the mode of each requested
 * path present (exit 1 when any is absent), `head` prints a file's text.
 * `overrides` replace either, by command.
 */
function room(
  files: Record<string, Entry>,
  overrides: Record<string, ShellAnswer> = {},
): ShellAnswer {
  return by({
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

async function fetchOver(
  answer: ShellAnswer,
  signal = never(),
): Promise<{ fetched: Fetched; calls: ShellCall[] }> {
  const { shell, calls } = recordingShell(answer);
  return { fetched: await fetchProjectContext(REPO)(shell, signal), calls };
}

const headed = (calls: readonly ShellCall[]): string[] =>
  calls.filter((call) => call.argv[0] === "head").map((call) => call.argv.at(-1) ?? "");

const STAT = ["stat", "-L", "--printf", "%f %n\\n", "--"];

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
    const failed = (code: ExecutionError["code"]): ChannelFailed =>
      new ChannelFailed(`exec: ${code}`, { cause: new ExecutionError(code, code) });

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

    const throwing =
      (error: unknown): (() => never) =>
      () => {
        throw error;
      };

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
