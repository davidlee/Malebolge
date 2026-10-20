// The daemon's environment (design §4.3–§4.5, DEC-079–DEC-081): one place a
// profile becomes the agent's environment, cwd and startup context. The room
// runs over pi-env's local daemon behind a recording `ssh`, so the production
// launch path (daemonConnection, directLaunch) is the one exercised.

import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  HostKeyChangedError,
  isConnectionLost,
  localDaemon,
  RemoteError,
  RemoteExecutionEnv,
} from "@earendil-works/pi-env";
import { afterEach, describe, expect, it } from "vitest";
import type { Execution } from "../src/config.ts";
import { context } from "../src/context.ts";
import {
  type DaemonEnv,
  daemonEnv,
  readRoomContext,
  requireGatewaySocket,
} from "../src/daemon-env.ts";
import { grepExtension } from "../src/grep.ts";
import type { RoomConnection } from "../src/room/connection.ts";
import {
  ChannelFailed,
  ChannelUnavailable,
  type RoomShell,
  type ShellLimits,
} from "../src/room/shell.ts";
import { FETCH_LIMITS, HEAD_LIMITS } from "../src/room/source-reader.ts";
import { registryOf } from "../src/registry.ts";
import { openSession } from "../src/session.ts";
import { tempDir } from "./fixtures.ts";
import { FAUX_MODEL, fauxModels, textOf, toolResults } from "./harness-fixture.ts";
import { DAEMON, fakeHelpers } from "./room/connection-fixture.ts";

const ROOM: RoomConnection = {
  host: "assistant",
  user: "satan",
  hostKeyAlias: "room-assistant",
  knownHosts: "/var/lib/capsule/room/assistant/known_hosts",
};

const roomExecution = (home: string): Execution => ({ profile: "room", room: ROOM, home });

const never = (): never => {
  throw new Error("not a remote env");
};

/** Whether process `pid` is still running. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A log that keeps its lines. */
function recordingLog(): { lines: string[]; log: (text: string) => void } {
  const lines: string[] = [];
  return { lines, log: (text) => lines.push(text) };
}

/**
 * An `ssh` in `dir` that appends its argv to `dir/argv`, then runs pi-env's
 * local daemon with the words pi-env put after the launch word.
 */
async function recordingSsh(dir: string): Promise<{ ssh: string; argv: () => Promise<string[]> }> {
  const ssh = join(dir, "ssh");
  const log = join(dir, "argv");
  const script = [
    "#!/bin/sh",
    `echo "$*" >> '${log}'`,
    `while [ "$#" -gt 0 ] && [ "$1" != "'${DAEMON}'" ]; do shift; done`,
    "shift",
    `exec '${localDaemon()}' "$@"`,
  ];
  await writeFile(ssh, `${script.join("\n")}\n`);
  await chmod(ssh, 0o755);
  return {
    ssh,
    argv: async () => (await readFile(log, "utf8")).trimEnd().split("\n"),
  };
}

describe("daemonEnv", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let environment: DaemonEnv | undefined;
  afterEach(async () => {
    environment?.close();
    environment = undefined;
    await cleanup?.();
  });

  it("host: NodeExecutionEnv at the launch dir, or the agent's cwd", () => {
    environment = daemonEnv({ profile: "host", cwd: "/launch" }, () => undefined);

    const env = environment.env({});
    expect(environment.cwd).toBe("/launch");
    expect(env).toBeInstanceOf(NodeExecutionEnv);
    expect(env.cwd).toBe("/launch");
    expect(environment.env({ cwd: "/elsewhere" }).cwd).toBe("/elsewhere");
  });

  it("room: RemoteExecutionEnv pi-env:daemon-room in the home, over one directLaunch connection", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const { ssh, argv } = await recordingSsh(tmp.dir);
    const helpers = fakeHelpers(ssh);
    environment = daemonEnv(roomExecution(tmp.dir), () => undefined, helpers);

    const first = environment.env({});
    const second = environment.env({});
    let printed = "";
    const pwd = await first.exec(
      ["pwd"],
      {
        onOutput: (text) => {
          printed += text;
        },
      },
      context,
    );
    const again = await second.exec(["true"], {}, context);

    expect(first).toBeInstanceOf(RemoteExecutionEnv);
    expect(first.id).toBe("pi-env:daemon-room");
    expect(environment.cwd).toBe(tmp.dir);
    expect(pwd.ok ? printed.trim() : pwd.error.message).toBe(tmp.dir);
    expect(again.ok).toBe(true);
    expect(helpers.deployed).toHaveLength(1);
    const [started, ...more] = await argv();
    expect(more).toEqual([]);
    // pi-env appends its own `serve --token …` after the launch words.
    expect(started).toContain(` '${DAEMON}' serve `);
    expect(started).not.toMatch(/\bsession\b/);
  });

  it("room: nothing starts until the first call", () => {
    const helpers = fakeHelpers("false");
    environment = daemonEnv(roomExecution("/home/satan"), () => undefined, helpers);

    environment.env({});

    expect(helpers.deployed).toEqual([]);
  });

  it("room: close stops the room's daemon", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const { ssh } = await recordingSsh(tmp.dir);
    const room = daemonEnv(roomExecution(tmp.dir), () => undefined, fakeHelpers(ssh));
    const env = room.env({});
    const { pid } = await (env instanceof RemoteExecutionEnv ? env.connection.info() : never());

    room.close();

    await expect.poll(() => alive(pid)).toBe(false);
  });
});

describe("room faults at the tool seam, the daemon's reword (design §4.4)", () => {
  let environment: DaemonEnv | undefined;
  afterEach(() => {
    environment?.close();
    environment = undefined;
  });

  /** The tool results of a session running bash, then grep, then answering. */
  async function bashThenGrep(env: DaemonEnv): Promise<string[]> {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "true" }, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxToolCall("grep", { pattern: "x" }, { id: "call-2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("carried on")]),
    ]);
    const session = await openSession(new MemoryStorage(), {
      models,
      registry: registryOf([CodingTools, grepExtension]),
      agent: { model: FAUX_MODEL, cwd: env.cwd },
      env: env.env,
    });
    await (await session.root.submit({ type: "input", content: "go" }, context)).wait(context);
    const results = await toolResults(session.harness);
    const page = await session.root.entries({}, 50, undefined, context);
    await session.harness.close(context);
    expect(JSON.stringify(page.items)).toContain("carried on");
    for (const result of results) {
      expect(result.isError).toBe(true);
    }
    return results.map(textOf);
  }

  it("a lost room: bash and grep each answer `room unavailable`, and the session carries on", async () => {
    const { lines, log } = recordingLog();
    environment = daemonEnv(roomExecution("/home/satan"), log, fakeHelpers("false"));

    const [bash, grep, ...rest] = await bashThenGrep(environment);

    expect(rest).toEqual([]);
    expect(bash).toContain("room unavailable: ");
    // A lost room reaches grep as a thrown env error, not spawn_error: the
    // harness reports it, worded at the seam all the same.
    expect(grep).toContain("room unavailable: ");
    expect(lines.some((line) => line.startsWith("room unavailable: "))).toBe(true);
  });

  it("the reworded error keeps its type and fields: still a lost connection", async () => {
    environment = daemonEnv(roomExecution("/home/satan"), () => undefined, fakeHelpers("false"));
    const env = environment.env({});

    const error: unknown = await (env instanceof RemoteExecutionEnv
      ? env.connection.info()
      : never()
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RemoteError);
    expect(isConnectionLost(error)).toBe(true);
    expect(error instanceof RemoteError && error.message).toMatch(/^room unavailable: /);
  });

  it("a host key the room fails: `room host key untrusted`, never unavailable, logged every call", async () => {
    const { lines, log } = recordingLog();
    const helpers = fakeHelpers("ssh", () => new HostKeyChangedError("changed"));
    environment = daemonEnv(roomExecution("/home/satan"), log, helpers);

    const results = await bashThenGrep(environment);

    for (const text of results) {
      expect(text).toContain("room host key untrusted: ");
      expect(text).not.toContain("room unavailable");
    }
    expect(lines.filter((line) => line.startsWith("room host key untrusted: ")).length).toBe(
      results.length,
    );
    expect(lines.some((line) => line.includes("room unavailable"))).toBe(false);
  });
});

describe("the room's startup context (design §4.5, DEC-080)", () => {
  it("RV-035 F-4: readContext over a DaemonConnection failing HostKeyFailure logs untrusted, never unavailable", async () => {
    const { lines, log } = recordingLog();
    const helpers = fakeHelpers("ssh", () => new HostKeyChangedError("changed"));
    const environment = daemonEnv(roomExecution("/home/satan"), log, helpers);

    const sources = await environment.readContext();
    environment.close();

    expect(sources).toEqual([]);
    expect(lines.some((line) => line.startsWith("room host key untrusted: "))).toBe(true);
    expect(lines.some((line) => line.includes("room unavailable"))).toBe(false);
  });

  it("reads the home only, every exec bounded by FETCH_LIMITS or HEAD_LIMITS", async () => {
    const calls: { argv: readonly string[]; limits: ShellLimits | undefined }[] = [];
    const shell: RoomShell = (argv, _signal, _cwd, limits) => {
      calls.push({ argv, limits });
      const agents = "/home/satan/AGENTS.md";
      const stat = argv.includes(agents) ? `81a4 ${agents}\n` : "";
      const stdout = argv[0] === "stat" ? stat : "be kind\n";
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };

    const sources = await readRoomContext(shell, "/home/satan", () => undefined);

    expect(sources.map((source) => source.origin)).toEqual([{ path: "/home/satan/AGENTS.md" }]);
    expect(calls.length).toBeGreaterThan(0);
    for (const { argv, limits } of calls) {
      expect([FETCH_LIMITS, HEAD_LIMITS]).toContainEqual(limits);
      const paths = argv.filter((word) => word.startsWith("/"));
      for (const path of paths) {
        expect(path.startsWith("/home/satan/")).toBe(true);
      }
    }
  });

  it.each([
    ["ChannelUnavailable", new ChannelUnavailable("down"), "room unavailable: down"],
    [
      "ChannelFailed host_key",
      new ChannelFailed("changed", { reason: "host_key" }),
      "room host key untrusted: changed",
    ],
  ])("%s: no sources, logged, the daemon carries on", async (_name, error, logged) => {
    const { lines, log } = recordingLog();
    const shell: RoomShell = () => Promise.reject(error);

    expect(await readRoomContext(shell, "/home/satan", log)).toEqual([]);
    expect(lines).toContain(logged);
  });

  it("any other error is a bug: rethrown, not read as an empty context", async () => {
    const bug = new TypeError("bug");
    const shell: RoomShell = () => Promise.reject(bug);

    await expect(readRoomContext(shell, "/home/satan", () => undefined)).rejects.toBe(bug);
  });

  it("a failed read is logged and skipped, not fatal", async () => {
    const { lines, log } = recordingLog();
    const shell: RoomShell = () => Promise.resolve({ code: 2, stdout: "", stderr: "denied" });

    expect(await readRoomContext(shell, "/home/satan", log)).toEqual([]);
    expect(lines).toContain("project context: /home/satan: error (exit 2): denied");
  });

  it("host: reads project context from the launch dir with the node reader", async () => {
    const tmp = await tempDir();
    await writeFile(join(tmp.dir, "AGENTS.md"), "be kind\n");
    const environment = daemonEnv({ profile: "host", cwd: tmp.dir }, () => undefined);

    const sources = await environment.readContext();
    await tmp.cleanup();

    expect(sources.map((source) => source.origin)).toContainEqual({
      path: join(tmp.dir, "AGENTS.md"),
    });
  });
});

describe("requireGatewaySocket (design §4.4)", () => {
  const room = (gatewaySocket?: string): Execution => ({
    ...roomExecution("/home/satan"),
    ...(gatewaySocket === undefined ? {} : { gatewaySocket }),
  });

  it("refuses startup when the gateway socket is missing, naming it", () => {
    expect(() => {
      requireGatewaySocket(room("/run/gw.sock"), () => false);
    }).toThrow("gateway socket missing: /run/gw.sock (llm-gateway client listener)");
  });

  it("passes a present socket, an unset one, and the host profile", () => {
    expect(() => {
      requireGatewaySocket(room("/run/gw.sock"), () => true);
      requireGatewaySocket(room(), () => false);
      requireGatewaySocket({ profile: "host", cwd: "/" }, () => false);
    }).not.toThrow();
  });
});
