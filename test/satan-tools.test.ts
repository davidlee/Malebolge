import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type Extension,
  type JsonObject,
  MemoryStorage,
  type Registry,
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { isRecord, type JsonRecord } from "../src/json.ts";
import { registryOf } from "../src/registry.ts";
import {
  SATAN_EXTENSION,
  type SatanTools,
  type SatanToolsOptions,
  satanTools,
} from "../src/satan-tools.ts";
import { presenceOf } from "../src/wake/presence.ts";
import {
  type FakeServerOptions,
  type FakeTool,
  type Fixture,
  fakeMcpServer,
  type Initialization,
  recorder,
  tempDir,
} from "./fixtures.ts";
import {
  callThenAnswer,
  FAUX_MODEL,
  openFauxHarness,
  type TestHarness,
  textOf,
  toolResults,
} from "./harness-fixture.ts";

const notesRead: FakeTool = {
  name: "notes_read",
  description: "Read a note",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  call: (args: Record<string, unknown>) => ({ text: `note ${String(args["id"])}` }),
};

const notesArchive: FakeTool = {
  name: "notes_archive",
  description: "Archive a note",
  call: () => ({ text: "archived" }),
};

const tools: FakeTool[] = [
  notesRead,
  { name: "fails", call: () => ({ text: "boom", isError: true }) },
];

/** satan-mcp after a restart: `notes_read` kept, `fails` gone, `notes_archive` new. */
const restartedTools: FakeTool[] = [notesRead, notesArchive];

/** satan-mcp after a restart with nothing in common. */
const changedTools: FakeTool[] = [notesArchive];

/** satan-mcp listing one tool twice: pi-durable refuses an extension with two tools of a name. */
const duplicatedTools: FakeTool[] = [notesRead, notesRead];

describe("satanTools", () => {
  const DEADLINE_MS = 100;
  let cleanup: () => Promise<void>;
  let dir: string;
  let socketPath: string;
  let server: Fixture | undefined;
  let satan: SatanTools | undefined;
  let test: TestHarness | undefined;
  let logs: ReturnType<typeof recorder<string>>;
  let registry: Registry;

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    dir = tmp.dir;
    socketPath = join(dir, "mcp.sock");
    server = await fakeMcpServer(socketPath, tools);
    logs = recorder<string>();
    registry = registryOf([]);
  });

  afterEach(async () => {
    await test?.harness.close(context);
    await satan?.close();
    await server?.close();
    await cleanup();
  });

  /** The `satan` extension as installed in the shared registry, if any. */
  const satanExtension = (): Extension | undefined =>
    registry.snapshot().extension(SATAN_EXTENSION);

  /** The tool names installed as the `satan` extension, in order. */
  const toolNames = (): string[] => (satanExtension()?.tools ?? []).map((tool) => tool.name);

  /** A harness over the shared registry and a handle on the socket; no refresh yet. */
  const openHandle = async (options?: SatanToolsOptions): Promise<SatanTools> => {
    test = await openFauxHarness(new MemoryStorage(), { registry });
    const handle = satanTools(socketPath, registry, logs.push, options);
    satan = handle;
    return handle;
  };

  /** A harness over the shared registry, then the handle's first refresh. */
  const start = async (): Promise<SatanTools> => {
    const handle = await openHandle({ deadlineMs: DEADLINE_MS });
    await handle.refresh();
    return handle;
  };

  /** Replace the running server with one serving `tools` under `options`. */
  const restartServer = async (
    served: readonly FakeTool[],
    options?: FakeServerOptions,
  ): Promise<Fixture> => {
    await server?.close();
    server = await fakeMcpServer(socketPath, served, options);
    return server;
  };

  /** Drive one model turn of `conversation` that calls `call`; returns that call's result. */
  const callOn = async (
    conversation: Conversation,
    call: string,
    args: JsonObject,
  ): Promise<ToolResultMessage> => {
    if (test === undefined) {
      throw new Error("start first");
    }
    test.faux.setResponses(callThenAnswer(call, args, "done"));
    const settled = await (
      await conversation.submit({ type: "input", content: "go" }, context)
    ).wait(context);
    expect(settled.status).toBe("done");
    const result = (await toolResults(test.harness, conversation)).at(-1);
    if (result === undefined) {
      throw new Error("no tool result");
    }
    return result;
  };

  /**
   * Drive one model turn of `conversation` that makes `calls` in order, one per step;
   * returns their results, oldest first.
   */
  const turnOn = async (
    conversation: Conversation,
    calls: readonly (readonly [string, JsonObject])[],
  ): Promise<ToolResultMessage[]> => {
    if (test === undefined) {
      throw new Error("start first");
    }
    test.faux.setResponses([
      ...calls.map(([call, args], index) =>
        fauxAssistantMessage([fauxToolCall(call, args, { id: `call-${String(index + 1)}` })], {
          stopReason: "toolUse",
        }),
      ),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const settled = await (
      await conversation.submit({ type: "input", content: "go" }, context)
    ).wait(context);
    expect(settled.status).toBe("done");
    return (await toolResults(test.harness, conversation)).slice(-calls.length);
  };

  /** The root conversation's turn, which is what most tests drive. */
  const callTool = (call: string, args: JsonObject): Promise<ToolResultMessage> => {
    if (test === undefined) {
      throw new Error("start first");
    }
    return callOn(test.root, call, args);
  };

  /** A fresh conversation: its tool calls must not share the root's connection. */
  const anotherConversation = async (): Promise<Conversation> => {
    if (test === undefined) {
      throw new Error("start first");
    }
    return test.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: FAUX_MODEL } },
      context,
    );
  };

  /** Stop the MCP server and wait until every daemon-side connection has seen it go. */
  const stopServer = async (): Promise<void> => {
    const closes = (): number => logs.items.filter((line) => line.includes("closed")).length;
    // Every connection open now reports its own close: discovery's and each pooled one's.
    const expected = closes() + (server?.openConnections() ?? 0);
    await server?.close();
    server = undefined;
    await waitFor(() => closes() >= expected, "every connection to see the server go");
  };

  /** How many requests of `method` the server has received. */
  const received = (fixture: Fixture, method: string): number =>
    fixture.requests.items.filter((name) => name === method).length;

  /** The running server; every test that makes a call has one. */
  const running = (): Fixture => {
    if (server === undefined) {
      throw new Error("no server");
    }
    return server;
  };

  /** The `experimental.satan` an initialize announced, or none. */
  const announced = (initialization: Initialization): JsonRecord | undefined => {
    const experimental = initialization.capabilities["experimental"];
    const satan = isRecord(experimental) ? experimental["satan"] : undefined;
    return isRecord(satan) ? satan : undefined;
  };

  /** The identities announced, in arrival order: one per pooled connection, none for discovery. */
  const identitiesOf = (fixture: Fixture): JsonRecord[] =>
    fixture.initializations.items.flatMap((item) => {
      const identity = announced(item);
      return identity === undefined ? [] : [identity];
    });

  /** The discovery connection: the initialize that announced no identity, and the only one. */
  const discoveryOf = (fixture: Fixture): Initialization => {
    const anonymous = fixture.initializations.items.filter((item) => announced(item) === undefined);
    const [discovery] = anonymous;
    if (discovery === undefined || anonymous.length > 1) {
      throw new Error(`expected one discovery connection, found ${String(anonymous.length)}`);
    }
    return discovery;
  };

  /** The identity `conversation`'s pooled connections announce (EX-2). */
  const identityOf = (conversation: Conversation): JsonRecord => ({
    conversation: String(conversation.id),
    kind: "interactive",
  });

  /** How long a wait for something no log and no request announces may take. */
  const WAIT_MS = 2000;

  /** Wait, polling, until `ready()` holds; throws naming `what` when it never does. */
  const waitFor = async (ready: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + WAIT_MS;
    while (!ready()) {
      if (Date.now() > deadline) {
        throw new Error(`waited ${String(WAIT_MS)} ms for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  it("installs every MCP tool, with the server's description", async () => {
    await start();
    expect(satanExtension()?.tools?.map((tool) => [tool.name, tool.description])).toEqual([
      ["notes_read", "Read a note"],
      ["fails", "SATAN tool: fails"],
    ]);
  });

  it("forwards a model's call to the MCP server and returns its content", async () => {
    await start();
    const result = await callTool("notes_read", { id: "42" });
    expect(textOf(result)).toBe("note 42");
    expect(result.isError).toBe(false);
  });

  it("surfaces an MCP tool error as an error result", async () => {
    await start();
    const result = await callTool("fails", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("boom");
  });

  it("rejects arguments that violate the tool's input schema before calling it", async () => {
    await start();
    const result = await callTool("notes_read", {});
    expect(result.isError).toBe(true);
  });

  it("reconnects on the next call after the MCP server restarts", async () => {
    await start();
    await stopServer();
    server = await fakeMcpServer(socketPath, tools);
    const result = await callTool("notes_read", { id: "7" });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("note 7");
  });

  it("fails a call while the MCP server is down, then recovers once it is back", async () => {
    await start();
    await stopServer();
    expect((await callTool("notes_read", { id: "1" })).isError).toBe(true);
    server = await fakeMcpServer(socketPath, tools);
    expect(textOf(await callTool("notes_read", { id: "2" }))).toBe("note 2");
  });

  it("installs no tools and reports unreachable once while satan-mcp is absent", async () => {
    await server?.close();
    server = undefined;
    const handle = await openHandle();
    await handle.refresh();
    await handle.refresh();
    expect(satanExtension()?.tools).toEqual([]);
    expect(logs.items.filter((line) => line.includes("satan-mcp unreachable"))).toHaveLength(1);
    expect(logs.items.filter((line) => line.includes("SATAN tools"))).toEqual([]);
  });

  it("logs one line for a wedged list, not a drop per refresh", async () => {
    const wedged = await restartServer(tools, { silent: ["tools/list"] });
    const handle = await openHandle({ deadlineMs: DEADLINE_MS });
    await handle.refresh();
    await handle.refresh();
    await handle.refresh();
    expect(logs.items).toEqual([
      `satan-mcp unreachable: timed out after ${String(DEADLINE_MS)} ms`,
    ]);
    expect(wedged.connections()).toBe(3);
  });

  it("does not report the connection it closed itself", async () => {
    const handle = await start();
    await handle.close();
    expect(logs.items).toEqual(["2 SATAN tools"]);
  });

  it("times out a hung tools/list, then lists over a fresh connection", async () => {
    const hung = await restartServer(tools, { silent: ["tools/list"] });
    const handle = await openHandle({ deadlineMs: DEADLINE_MS });
    await handle.refresh();
    expect(satanExtension()?.tools).toEqual([]);
    expect(logs.items).toContain(
      `satan-mcp unreachable: timed out after ${String(DEADLINE_MS)} ms`,
    );
    await hung.release();
    await handle.refresh();
    expect(satanExtension()?.tools?.map((tool) => tool.name)).toEqual(["notes_read", "fails"]);
    expect(hung.connections()).toBe(2);
  });

  it("times out a stalled connect, then connects again once satan-mcp answers", async () => {
    const stalled = await restartServer(tools, { silent: ["initialize"] });
    const handle = await openHandle({ deadlineMs: DEADLINE_MS });
    await handle.refresh();
    expect(satanExtension()?.tools).toEqual([]);
    await stalled.release();
    await handle.refresh();
    expect(satanExtension()?.tools?.map((tool) => tool.name)).toEqual(["notes_read", "fails"]);
    expect(stalled.connections()).toBe(2);
  });

  it("coalesces refreshes made during a read into one more read", async () => {
    const held = await restartServer(tools, { silent: ["tools/list"] });
    const handle = await openHandle();
    let installs = 0;
    registry.subscribe(() => {
      installs += 1;
    });
    const seen: number[] = [];
    const refresh = (): Promise<void> =>
      handle.refresh().then(() => {
        seen.push(installs);
      });
    const all = Promise.all([refresh(), refresh(), refresh()]);
    await held.release();
    await all;
    // The first call had its own read; the other two shared the read that followed it.
    expect(seen).toEqual([1, 2, 2]);
    expect(received(held, "tools/list")).toBe(2);
    expect(satanExtension()?.tools?.map((tool) => tool.name)).toEqual(["notes_read", "fails"]);
  });

  it("gives a caller the list satan-mcp has when its own read runs", async () => {
    const held = await restartServer(tools, { silent: ["tools/list"] });
    const handle = await openHandle();
    const installs: string[][] = [];
    registry.subscribe(() => {
      installs.push(toolNames());
    });
    const first = handle.refresh();
    let seenBySecond: string[] = [];
    const second = handle.refresh().then(() => {
      seenBySecond = toolNames();
    });
    // Read 1 is at the server, which will answer it with the tools it has now.
    await held.requests.next((method) => method === "tools/list");
    held.serve(changedTools);
    await held.release();
    await first;
    await second;
    expect(installs).toEqual([["notes_read", "fails"], ["notes_archive"]]);
    expect(seenBySecond).toEqual(["notes_archive"]);
  });

  it("does not keep a timed-out read in flight", async () => {
    const held = await restartServer(tools, { silent: ["tools/list"] });
    const handle = await openHandle({ deadlineMs: DEADLINE_MS });
    await Promise.all([handle.refresh(), handle.refresh()]);
    expect(received(held, "tools/list")).toBe(2);
    expect(satanExtension()?.tools).toEqual([]);
  });

  it("closes without waiting for an attempt still trying to connect", async () => {
    const stalled = await restartServer(tools, { silent: ["initialize"] });
    const handle = await openHandle();
    const refresh = handle.refresh();
    await stalled.requests.next((method) => method === "initialize");
    await handle.close();
    // The attempt connects after the handle is closed, and is closed on arrival:
    // nothing reconnects, and the read that waited on it gives up.
    await stalled.release();
    await stalled.ended;
    await refresh;
    expect(stalled.connections()).toBe(1);
    expect(toolNames()).toEqual([]);
  });

  it("refuses a call, and installs nothing on a refresh, once closed", async () => {
    const handle = await start();
    await handle.close();
    const result = await callTool("notes_read", { id: "1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/satan-mcp client is closed/);
    await handle.refresh();
    expect(toolNames()).toEqual([]);
    expect(logs.items.filter((line) => line.includes("satan-mcp client is closed"))).toHaveLength(
      1,
    );
  });

  it("fails a call normally when the attempt it waited on was discarded", async () => {
    // Long enough for a call to join the attempt the read begins.
    const handle = await openHandle({ deadlineMs: 300 });
    await handle.refresh();
    await stopServer();
    const stalled = await restartServer(tools, { silent: ["initialize"] });
    const read = handle.refresh(); // begins the stalled attempt, and times out at 300 ms
    await stalled.requests.next((method) => method === "initialize");
    const call = callTool("notes_read", { id: "5" }); // waits on that same attempt
    await read; // the deadline discards the attempt under both of them
    await stalled.close(); // and it then fails to connect
    const result = await call;
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/opening/);
    // The handle falls forward: a server that is back serves the next turn.
    await restartServer(tools);
    await handle.refresh();
    expect(textOf(await callTool("notes_read", { id: "6" }))).toBe("note 6");
  });

  it("tries one connection per refresh while satan-mcp hangs up", async () => {
    const failing = await restartServer(tools, { hangUp: true });
    const handle = await openHandle({ deadlineMs: DEADLINE_MS });
    await handle.refresh();
    expect(failing.connections()).toBe(1);
    await handle.refresh();
    expect(failing.connections()).toBe(2);
    expect(toolNames()).toEqual([]);
  });

  it("does not announce the first connection after an absence", async () => {
    await restartServer(tools, { hangUp: true });
    const handle = await openHandle({ deadlineMs: DEADLINE_MS });
    await handle.refresh();
    const back = await restartServer(tools);
    await handle.refresh();
    expect(toolNames()).toEqual(["notes_read", "fails"]);
    expect(logs.items.filter((line) => line.includes("reconnected"))).toEqual([]);
    expect(received(back, "tools/list")).toBe(1);
  });

  it("does not announce a replacement that close() cuts short", async () => {
    const handle = await start();
    await stopServer();
    const back = await restartServer(tools, { silent: ["initialize"] });
    const read = handle.refresh(); // notices the closed client, and begins the replacement
    await back.requests.next((method) => method === "initialize");
    await handle.close();
    await back.release(); // the replacement connects after all, and is closed on arrival
    await back.ended;
    await read;
    expect(logs.items.filter((line) => line.includes("reconnected"))).toEqual([]);
  });

  it("announces the connection that recovers satan-mcp after a lost client", async () => {
    await start();
    await stopServer();
    // The call made while it is down replaces the lost client, and that replacement fails.
    expect((await callTool("notes_read", { id: "1" })).isError).toBe(true);
    await restartServer(restartedTools);
    const lists = recorder<string[]>();
    registry.subscribe(() => {
      lists.push(toolNames());
    });
    // A tool both sets have: calling it is what finds satan-mcp back.
    expect(textOf(await callTool("notes_read", { id: "2" }))).toBe("note 2");
    expect(await lists.next((names) => names.includes("notes_archive"))).toEqual([
      "notes_read",
      "notes_archive",
    ]);
  });

  it("refreshes by itself when a call reconnects, over one connection per role", async () => {
    await start();
    await stopServer();
    const restarted = await restartServer(restartedTools);
    const lists = recorder<string[]>();
    registry.subscribe(() => {
      lists.push(toolNames());
    });
    // A tool both sets have: calling it is what finds satan-mcp back.
    expect(textOf(await callTool("notes_read", { id: "9" }))).toBe("note 9");
    expect(await lists.next((names) => names.includes("notes_archive"))).toEqual([
      "notes_read",
      "notes_archive",
    ]);
    // One connection per role: the call's own pooled connection, and the discovery one
    // the refresh it starts reopens. The refresh neither adds a third nor replays the call.
    expect(restarted.connections()).toBe(2);
    expect(textOf(await callTool("notes_archive", {}))).toBe("archived");
  });

  it("fails a call to a tool the refreshed list no longer has", async () => {
    await start();
    await stopServer();
    await restartServer([notesRead]);
    await satan?.refresh();
    expect(toolNames()).toEqual(["notes_read"]);
    const result = await callTool("fails", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not available/);
  });

  it("installs nothing and reports once when satan-mcp lists a tool twice", async () => {
    await start();
    await stopServer();
    await restartServer(duplicatedTools);
    // This refresh lists the duplicates, and the one its reconnect starts shares the state.
    await satan?.refresh();
    expect(toolNames()).toEqual([]);
    expect(logs.items.filter((line) => line.includes("tools rejected"))).toEqual([
      "satan-mcp tools rejected: Extension satan has two tools named notes_read",
    ]);
    // A different reason for the same empty state is worth its own line.
    await stopServer();
    await satan?.refresh();
    expect(logs.items.filter((line) => line.includes("satan-mcp unreachable"))).toHaveLength(1);
  });

  it("does not announce a stand-in that a timeout discarded", async () => {
    const handle = await start();
    await stopServer();
    const stalled = await restartServer(tools, { silent: ["initialize"] });
    await handle.refresh(); // times out, discarding the stand-in it began
    await stalled.release(); // the stand-in connects after all...
    await stalled.ended; // ...and is closed on arrival
    expect(logs.items.filter((line) => line.includes("reconnected"))).toEqual([]);
    // The loss is still armed: the next connection standing in for it is announced.
    await handle.refresh();
    expect(logs.items.filter((line) => line.includes("reconnected"))).toHaveLength(1);
    expect(toolNames()).toEqual(["notes_read", "fails"]);
  });

  it("installs the changed tool set once satan-mcp restarts with different tools", async () => {
    await start();
    await stopServer();
    server = await fakeMcpServer(socketPath, changedTools);
    await satan?.refresh();
    expect(satanExtension()?.tools?.map((tool) => tool.name)).toEqual(["notes_archive"]);
    expect(logs.items.filter((line) => line.includes("SATAN tools"))).toEqual([
      "2 SATAN tools",
      "1 SATAN tools",
    ]);
    expect(textOf(await callTool("notes_archive", {}))).toBe("archived");
  });

  it("makes two calls of one conversation over one pooled connection (V11)", async () => {
    await start();
    const conversation = await anotherConversation();
    expect(textOf(await callOn(conversation, "notes_read", { id: "1" }))).toBe("note 1");
    expect(textOf(await callOn(conversation, "notes_read", { id: "2" }))).toBe("note 2");
    const fixture = running();
    // Discovery's connection, and the one connection both calls were made over.
    expect(fixture.connections()).toBe(2);
    // One initialize announced an identity: that one connection's, for that conversation.
    expect(identitiesOf(fixture)).toEqual([identityOf(conversation)]);
  });

  it("closes every pooled connection when the handle closes (V11)", async () => {
    const handle = await start();
    const first = await anotherConversation();
    const second = await anotherConversation();
    expect(textOf(await callOn(first, "notes_read", { id: "1" }))).toBe("note 1");
    expect(textOf(await callOn(second, "notes_read", { id: "2" }))).toBe("note 2");
    // Discovery's connection, and one pooled connection per conversation.
    expect(running().openConnections()).toBe(3);
    await handle.close();
    // Taken off the handle it closed, so the afterEach has nothing left to close.
    satan = undefined;
    await waitFor(() => running().openConnections() === 0, "every connection to close");
  });

  it("announces each conversation's identity on the connection its calls use (V10)", async () => {
    await start();
    const first = await anotherConversation();
    const second = await anotherConversation();
    expect(textOf(await callOn(first, "notes_read", { id: "1" }))).toBe("note 1");
    expect(textOf(await callOn(second, "notes_read", { id: "2" }))).toBe("note 2");
    const fixture = running();
    // One connection for discovery, and one per conversation that made a call.
    expect(fixture.connections()).toBe(3);
    // Discovery is the connection that announced nothing, whichever one it turned out to be.
    const discovery = discoveryOf(fixture);
    expect(identitiesOf(fixture)).toEqual([identityOf(first), identityOf(second)]);
    // Discovery lists; the calls went over the pooled connections, not over it.
    expect(discovery.methods).toContain("tools/list");
    expect(discovery.methods).not.toContain("tools/call");
    expect(received(fixture, "tools/call")).toBe(2);
  });

  it("repeats the identity on the replacement connection after a restart (EX-1, V10)", async () => {
    await start();
    const conversation = await anotherConversation();
    expect(textOf(await callOn(conversation, "notes_read", { id: "1" }))).toBe("note 1");
    await stopServer();
    const back = await restartServer(tools);
    expect(textOf(await callOn(conversation, "notes_read", { id: "2" }))).toBe("note 2");
    // The pooled connection came back announcing the same conversation.
    expect(back.initializations.items.map(announced)).toContainEqual(identityOf(conversation));
  });

  it("offers the restarted tool set within the running turn once the old entry idled out (V12)", async () => {
    const handle = await openHandle({ deadlineMs: DEADLINE_MS, idleMs: 50 });
    await handle.refresh();
    expect(toolNames()).toEqual(["notes_read", "fails"]);
    const conversation = await anotherConversation();
    expect(textOf(await callOn(conversation, "notes_read", { id: "1" }))).toBe("note 1");
    // Nothing but discovery is left once the call's entry idles out: the pool closed it.
    const before = running();
    await waitFor(() => before.openConnections() === 1, "the pooled connection to idle out");
    await stopServer();
    const back = await restartServer(restartedTools);
    // One running turn: the fresh entry's first call, then a tool only the new set has.
    const results = await turnOn(conversation, [
      ["notes_read", { id: "2" }],
      ["notes_archive", {}],
    ]);
    // The fresh entry's first call answered once its refresh had settled (RV-060 F-3, VA-1):
    // the turn's very next step was offered the restarted tool set.
    expect(results.map(textOf)).toEqual(["note 2", "archived"]);
    expect(toolNames()).toEqual(["notes_read", "notes_archive"]);
    expect(received(back, "tools/list")).toBeLessThanOrEqual(2);
    expect(back.initializations.items.map(announced)).toContainEqual(identityOf(conversation));
  });

  it("refreshes once when a live pooled connection reconnects (V12)", async () => {
    const handle = await openHandle({ deadlineMs: DEADLINE_MS, idleMs: 60_000 });
    await handle.refresh();
    const conversation = await anotherConversation();
    expect(textOf(await callOn(conversation, "notes_read", { id: "1" }))).toBe("note 1");
    await stopServer();
    const back = await restartServer(restartedTools);
    expect(textOf(await callOn(conversation, "notes_read", { id: "2" }))).toBe("note 2");
    await waitFor(() => toolNames().includes("notes_archive"), "the refreshed tool set");
    expect(toolNames()).toEqual(["notes_read", "notes_archive"]);
    expect(textOf(await callOn(conversation, "notes_archive", {}))).toBe("archived");
    // The replacement connection is the pooled one, and the refresh it started listed once.
    expect(back.initializations.items.map(announced)).toContainEqual(identityOf(conversation));
    expect(received(back, "tools/list")).toBeLessThanOrEqual(2);
  });

  describe("call", () => {
    const CALL_DEADLINE_MS = 50;

    it("calls over a scheduled connection apart from the conversation's interactive one", async () => {
      const handle = await start();
      const conversation = await anotherConversation();
      expect(textOf(await callOn(conversation, "notes_read", { id: "1" }))).toBe("note 1");
      const key = { conversation: conversation.id, kind: "scheduled" } as const;
      const result = await handle.call(key, "notes_read", { id: "2" }, DEADLINE_MS);
      // A satan-mcp answer is assignable to the presence reader's input type.
      presenceOf(result);
      expect(result.content).toEqual([{ type: "text", text: "note 2" }]);
      const fixture = running();
      // Discovery, the interactive connection, and the scheduled one.
      expect(fixture.connections()).toBe(3);
      expect(identitiesOf(fixture)).toEqual([
        identityOf(conversation),
        { conversation: String(conversation.id), kind: "scheduled" },
      ]);
    });

    it("rejects a call that outlives deadlineMs", async () => {
      const hung = await restartServer(tools, { silent: ["tools/call"] });
      const handle = await start();
      const key = { conversation: (await anotherConversation()).id, kind: "scheduled" } as const;
      await expect(handle.call(key, "notes_read", { id: "1" }, CALL_DEADLINE_MS)).rejects.toThrow(
        "the deadline passed",
      );
      await hung.release();
    });

    it("rejects a call made after close", async () => {
      const handle = await start();
      const key = { conversation: (await anotherConversation()).id, kind: "scheduled" } as const;
      await handle.close();
      satan = undefined;
      await expect(handle.call(key, "notes_read", { id: "1" }, DEADLINE_MS)).rejects.toThrow();
    });
  });
});
