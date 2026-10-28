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
import type { Execution, Profile } from "../src/config.ts";
import { toolsetInit } from "../src/conversations.ts";
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
import { openSession, type SessionOptions } from "../src/session.ts";
import { IndexDocument } from "../src/topics.ts";
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

/**
 * A restore for `names`: their values at call time, each unset one deleted again.
 * Call it once where the values are still pristine, run it in `afterEach`.
 */
function preservingEnv(names: readonly string[]): () => void {
  const saved = names.map((name) => [name, process.env[name]] as const);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  };
}

/** The lifecycle the two conversation describes share. */
interface EnvFixture {
  /** A fresh temp directory, removed with the fixture. */
  dir: () => Promise<string>;
  /** The `DaemonEnv` `build` makes at a fresh temp directory, closed with the fixture. */
  at: (build: (dir: string) => DaemonEnv | Promise<DaemonEnv>) => Promise<DaemonEnv>;
  /** Closes that env, restores the process environment, removes the directories. */
  reap: () => Promise<void>;
}

/**
 * A `DaemonEnv` a case builds at a fresh temp directory, the further directories
 * it needs, and the process environment a masking case sets — all released by
 * `reap` in `afterEach`.
 */
function envFixture(): EnvFixture {
  const cleanups: (() => Promise<void>)[] = [];
  const restoreEnv = preservingEnv(["SATAN_TOPIC", "MALEBOLGE_TEST_INHERITED"]);
  let environment: DaemonEnv | undefined;
  const dir = async (): Promise<string> => {
    const tmp = await tempDir();
    cleanups.push(tmp.cleanup);
    return tmp.dir;
  };
  return {
    dir,
    at: async (build): Promise<DaemonEnv> => {
      environment = await build(await dir());
      return environment;
    },
    reap: async (): Promise<void> => {
      environment?.close();
      environment = undefined;
      restoreEnv();
      for (const cleanup of cleanups.splice(0)) {
        await cleanup();
      }
    },
  };
}

/** The values a conversation's tools share: this harness, `profile`, its cwd, no parent. */
const sharedVars = (profile: Profile, cwd: string): Record<string, string> => ({
  SATAN_HARNESS: "malebolge",
  SATAN_PROFILE: profile,
  SATAN_CWD: cwd,
  SATAN_PARENT_CONVERSATION: "",
});

/**
 * Root and a `topic`-tagged second conversation each print their own conversation
 * and topic, under the values both share, `same`.
 */
async function expectOwnConversations(
  env: SessionOptions["env"],
  same: Record<string, string>,
  topic: string,
): Promise<void> {
  const test = await openTestHarness([CodingTools], undefined, env);
  closing(test.harness);
  const second = await createConversation(test.harness, toolsetInit("room", topic));
  // Only root gets an agent from `openTestHarness`; the daemon's defaults do this in production.
  await second.configure({ model: FAUX_MODEL }, context);

  expect(await bashVars(test)).toEqual({
    ...same,
    SATAN_CONVERSATION: String(test.root.id),
    SATAN_TOPIC: DEFAULT_TOPIC,
  });
  expect(await bashVars(test, second)).toEqual({
    ...same,
    SATAN_CONVERSATION: String(second.id),
    SATAN_TOPIC: topic,
  });
}

/**
 * `environment`'s tools print an inherited `SATAN_TOPIC` as empty — `[][yes]` —
 * while the foreign variable still reaches them. A fresh env, before any exec:
 * the room's daemon inherits this process's env when it starts.
 */
async function expectInheritedTopicMasked(environment: DaemonEnv): Promise<void> {
  process.env["SATAN_TOPIC"] = "inherited";
  process.env["MALEBOLGE_TEST_INHERITED"] = "yes";
  // A reader whose index lacks the conversation's id: its topic is empty, not `default`.
  const test = await openTestHarness([CodingTools], undefined, (target) =>
    environment.env({ ...target, read: unindexed }, context),
  );
  closing(test.harness);

  // Masked, yet inheriting: the foreign variable still reaches the shell.
  const text = await bashTurn(test, 'echo "[${SATAN_TOPIC}][${MALEBOLGE_TEST_INHERITED}]"');

  expect(text).toContain("[][yes]");
  expect(text).not.toContain("inherited");
}

/** `environment`'s env build rejects with `bug`: a failed index read is never an empty context. */
async function expectFailedRead(environment: DaemonEnv, bug: Error): Promise<void> {
  const read: EnvTarget["read"] = {
    snapshot: () => Promise.reject(bug),
    snapshotAsOf: () => Promise.reject(bug),
  };

  await expect(environment.env({ ...envTarget(), read }, context)).rejects.toBe(bug);
}

/** `environment`'s conversation's topic reaches its tools; a per-exec `env` wins over it. */
async function expectPerExecEnvWins(environment: DaemonEnv): Promise<void> {
  const test = await openTestHarness([], undefined, environment.env);
  closing(test.harness);
  const env = await built(environment, { conversationId: test.root.id, read: test.harness });

  expect(await printed(env, ["printenv", "SATAN_TOPIC"])).toBe(DEFAULT_TOPIC);
  expect(
    await printed(env, ["printenv", "SATAN_TOPIC"], { env: { SATAN_TOPIC: "explicit" } }),
  ).toBe("explicit");
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
  const fixture = envFixture();
  afterEach(fixture.reap);

  /** A host `DaemonEnv` at a fresh directory. */
  const hostAt = (): Promise<DaemonEnv> =>
    fixture.at((dir) => daemonEnv({ profile: "host", cwd: dir }, () => undefined));

  it("host: root's and a second conversation's bash each see their own conversation", async () => {
    const host = await hostAt();

    await expectOwnConversations(host.env, sharedVars("host", host.cwd), "work");
  });

  it("host: an inherited SATAN_TOPIC is masked, printed empty rather than absent", async () => {
    await expectInheritedTopicMasked(await hostAt());
  });

  it("host: a failed index read fails the env build, never an empty context", async () => {
    await expectFailedRead(await hostAt(), new TypeError("bug"));
  });

  it("host: an exec's own env wins over the conversation's", async () => {
    await expectPerExecEnvWins(await hostAt());
  });
});

describe("room conversation env (SL-004 design sec-3)", () => {
  const fixture = envFixture();
  afterEach(fixture.reap);

  /** A room `DaemonEnv` at a fresh directory, over a recording `ssh`. */
  const roomAt = (): Promise<DaemonEnv> =>
    fixture.at(async (dir) => {
      const { ssh } = await recordingSsh(dir);
      return daemonEnv(roomExecution(dir), () => undefined, fakeHelpers(ssh));
    });

  it("room: every conversation's env is a RemoteExecutionEnv pi-env:daemon-room", async () => {
    const room = await roomAt();
    const captured: ExecutionEnv[] = [];
    // The hook runs per tool attempt and per prompt preparation: keep them all.
    const capture: SessionOptions["env"] = async (target) => {
      const env = await built(room, target);
      captured.push(env);
      return env;
    };

    // No agent cwd on the room's conversations: the room user's home (DEC-022).
    await expectOwnConversations(capture, sharedVars("room", room.cwd), "work");

    // One id for every conversation: it names the file namespace (RFC-002).
    expect(new Set(captured.map((env) => env.id))).toEqual(new Set(["pi-env:daemon-room"]));
    for (const env of captured) {
      expect(env).toBeInstanceOf(RemoteExecutionEnv);
    }
  });

  it("room: the agent's cwd wins over the room user's home", async () => {
    const room = await roomAt();
    // A real directory: the daemon execs in this cwd, so it must exist (DEC-022).
    const elsewhere = await fixture.dir();

    const env = await built(room, envTarget(elsewhere));

    expect(env.cwd).toBe(elsewhere);
    expect(env.cwd).not.toBe(room.cwd);
    expect(await printed(env, ["printenv", "SATAN_CWD"])).toBe(elsewhere);
  });

  it("room: an inherited SATAN_TOPIC is masked, printed empty rather than absent", async () => {
    await expectInheritedTopicMasked(await roomAt());
  });

  it("room: a failed index read fails the env build, never an empty context", async () => {
    await expectFailedRead(await roomAt(), new TypeError("bug"));
  });

  it("room: an exec's own env wins over the conversation's", async () => {
    await expectPerExecEnvWins(await roomAt());
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
      profile: "room",
      log: () => undefined,
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
