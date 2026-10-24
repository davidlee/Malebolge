// The daemon's environment (design §4.3–§4.5, DEC-079–DEC-081): one place a
// profile becomes the agent's environment, cwd and startup context. The room
// runs over pi-env's local daemon behind a recording `ssh`, so the production
// launch path (daemonConnection, directLaunch) is the one exercised.

import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type ConversationId,
  type EnvTarget,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
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
import { DEFAULT_TOPIC } from "../src/protocol.ts";
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
import { assignTopic, IndexDocument } from "../src/topics.ts";
import { tempDir } from "./fixtures.ts";
import {
  callThenAnswer,
  closing,
  createConversation,
  FAUX_MODEL,
  fauxModels,
  openTestHarness,
  type TestHarness,
  textOf,
  toolResults,
} from "./harness-fixture.ts";
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
 * An index that holds nothing: root is always indexed `default` (DEC-015), so
 * a case that needs an id the index lacks reads through this one.
 */
const unindexed: EnvTarget["read"] = {
  snapshot: () => Promise.resolve(IndexDocument.definition.initial()),
  snapshotAsOf: () => Promise.resolve(IndexDocument.definition.initial()),
};

/** A branded id for `envTarget`: no case here depends on the number. */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- no decimal literal is a branded id
const ANY_ID = 1 as ConversationId;

/** An `EnvTarget` as the harness builds one: no cwd unless the case sets one, the index above. */
const envTarget = (cwd?: string, read: EnvTarget["read"] = unindexed): EnvTarget => ({
  conversationId: ANY_ID,
  ...(cwd === undefined ? {} : { cwd }),
  read,
});

/** The environment `environment` builds for `target`: both arms build one, never none. */
async function built(environment: DaemonEnv, target: EnvTarget): Promise<ExecutionEnv> {
  const env = await environment.env(target, context);
  if (env === undefined) {
    throw new Error("the daemon's env hook built no environment");
  }
  return env;
}

/** What one exec through `env` printed, stdout and stderr alike, trimmed. */
async function printed(
  env: ExecutionEnv,
  argv: readonly string[],
  options?: ShellExecOptions,
): Promise<string> {
  let text = "";
  const result = await env.exec(
    argv,
    {
      ...options,
      onOutput: (chunk) => {
        text += chunk;
      },
    },
    context,
  );
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return text.trim();
}

/** The six variables as bash expands them: one `NAME=value` line each. */
const PRINT_VARS =
  'printf "%s\\n" "SATAN_HARNESS=$SATAN_HARNESS" "SATAN_PROFILE=$SATAN_PROFILE"' +
  ' "SATAN_CONVERSATION=$SATAN_CONVERSATION" "SATAN_CWD=$SATAN_CWD"' +
  ' "SATAN_TOPIC=$SATAN_TOPIC" "SATAN_PARENT_CONVERSATION=$SATAN_PARENT_CONVERSATION"';

/** The `SATAN_*` values `text` holds, one per line. */
function varsOf(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const [, name = "", value = ""] = /^(SATAN_[A-Z_]+)=(.*)$/.exec(line.trim()) ?? [];
    if (name !== "") {
      vars[name] = value;
    }
  }
  return vars;
}

/** One bash turn in `conversation` (default: root): the text its tool result carries. */
async function bashTurn(
  test: TestHarness,
  command: string,
  conversation?: Conversation,
): Promise<string> {
  test.faux.setResponses(callThenAnswer("bash", { command }, "done"));
  const turn = conversation ?? test.root;
  await (await turn.submit({ type: "input", content: "run it" }, context)).wait(context);
  return (await toolResults(test.harness, conversation)).map(textOf).join("\n");
}

/** The variables one bash turn in `conversation` (default: root) ran with. */
async function bashVars(
  test: TestHarness,
  conversation?: Conversation,
): Promise<Record<string, string>> {
  return varsOf(await bashTurn(test, PRINT_VARS, conversation));
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

  it("host: NodeExecutionEnv at the launch dir, or the agent's cwd", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    environment = daemonEnv({ profile: "host", cwd: "/launch" }, () => undefined);

    const env = await built(environment, envTarget());
    expect(environment.cwd).toBe("/launch");
    expect(env).toBeInstanceOf(NodeExecutionEnv);
    expect(env.cwd).toBe("/launch");

    // A real directory: exec spawns in this cwd, so it must exist (DEC-022).
    const agent = await built(environment, envTarget(tmp.dir));
    expect(agent.cwd).toBe(tmp.dir);
    expect(await printed(agent, ["printenv", "SATAN_CWD"])).toBe(tmp.dir);
  });

  it("room: RemoteExecutionEnv pi-env:daemon-room in the home, over one directLaunch connection", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const { ssh, argv } = await recordingSsh(tmp.dir);
    const helpers = fakeHelpers(ssh);
    environment = daemonEnv(roomExecution(tmp.dir), () => undefined, helpers);

    const first = await built(environment, envTarget());
    const second = await built(environment, envTarget());
    const pwd = await printed(first, ["pwd"]);
    const again = await second.exec(["true"], {}, context);

    expect(first).toBeInstanceOf(RemoteExecutionEnv);
    expect(first.id).toBe("pi-env:daemon-room");
    expect(environment.cwd).toBe(tmp.dir);
    expect(pwd).toBe(tmp.dir);
    expect(again.ok).toBe(true);
    expect(helpers.deployed).toHaveLength(1);
    const [started, ...more] = await argv();
    expect(more).toEqual([]);
    // pi-env appends its own `serve --token …` after the launch words.
    expect(started).toContain(` '${DAEMON}' serve `);
    expect(started).not.toMatch(/\bsession\b/);
  });

  it("room: nothing starts until the first call", async () => {
    const helpers = fakeHelpers("false");
    environment = daemonEnv(roomExecution("/home/satan"), () => undefined, helpers);

    await built(environment, envTarget());

    expect(helpers.deployed).toEqual([]);
  });

  it("room: close stops the room's daemon", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const { ssh } = await recordingSsh(tmp.dir);
    const room = daemonEnv(roomExecution(tmp.dir), () => undefined, fakeHelpers(ssh));
    const env = await built(room, envTarget());
    const { pid } = await (env instanceof RemoteExecutionEnv ? env.connection.info() : never());

    room.close();

    await expect.poll(() => alive(pid)).toBe(false);
  });
});

describe("host conversation env (SL-004 design sec-3)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let environment: DaemonEnv | undefined;
  // The masking case sets these: the host's tools inherit this process's env.
  const inherited = (["SATAN_TOPIC", "MALEBOLGE_TEST_INHERITED"] as const).map(
    (name) => [name, process.env[name]] as const,
  );
  afterEach(async () => {
    environment?.close();
    environment = undefined;
    for (const [name, value] of inherited) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
    await cleanup?.();
  });

  /** A host `DaemonEnv` at a fresh directory, its fixtures released after the test. */
  async function hostAt(): Promise<DaemonEnv> {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const host = daemonEnv({ profile: "host", cwd: tmp.dir }, () => undefined);
    environment = host;
    return host;
  }

  it("host: root's and a second conversation's bash each see their own conversation", async () => {
    const host = await hostAt();
    const test = await openTestHarness([CodingTools], undefined, host.env);
    closing(test.harness);
    const second = await createConversation(test.harness, assignTopic("work"));
    // Only root gets an agent from `openTestHarness`; the daemon's defaults do this in production.
    await second.configure({ model: FAUX_MODEL }, context);
    const same = {
      SATAN_HARNESS: "malebolge",
      SATAN_PROFILE: "host",
      SATAN_CWD: host.cwd,
      SATAN_PARENT_CONVERSATION: "",
    };

    expect(await bashVars(test)).toEqual({
      ...same,
      SATAN_CONVERSATION: String(test.root.id),
      SATAN_TOPIC: DEFAULT_TOPIC,
    });
    expect(await bashVars(test, second)).toEqual({
      ...same,
      SATAN_CONVERSATION: String(second.id),
      SATAN_TOPIC: "work",
    });
  });

  it("host: an inherited SATAN_TOPIC is masked, printed empty rather than absent", async () => {
    process.env["SATAN_TOPIC"] = "inherited";
    process.env["MALEBOLGE_TEST_INHERITED"] = "yes";
    const host = await hostAt();
    // A reader whose index lacks the conversation's id: its topic is empty, not `default`.
    const test = await openTestHarness([CodingTools], undefined, (target) =>
      host.env({ ...target, read: unindexed }, context),
    );
    closing(test.harness);

    // Masked, yet inheriting: the foreign variable still reaches the shell.
    const text = await bashTurn(test, 'echo "[${SATAN_TOPIC}][${MALEBOLGE_TEST_INHERITED}]"');

    expect(text).toContain("[][yes]");
    expect(text).not.toContain("inherited");
  });

  it("host: a failed index read fails the env build, never an empty context", async () => {
    const bug = new TypeError("bug");
    const host = await hostAt();
    const read: EnvTarget["read"] = {
      snapshot: () => Promise.reject(bug),
      snapshotAsOf: () => Promise.reject(bug),
    };

    await expect(host.env({ ...envTarget(), read }, context)).rejects.toBe(bug);
  });

  it("host: an exec's own env wins over the conversation's", async () => {
    const host = await hostAt();
    const test = await openTestHarness([], undefined, host.env);
    closing(test.harness);
    const env = await built(host, { conversationId: test.root.id, read: test.harness });

    expect(await printed(env, ["printenv", "SATAN_TOPIC"])).toBe(DEFAULT_TOPIC);
    expect(
      await printed(env, ["printenv", "SATAN_TOPIC"], { env: { SATAN_TOPIC: "explicit" } }),
    ).toBe("explicit");
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
    const env = await built(environment, envTarget());

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
