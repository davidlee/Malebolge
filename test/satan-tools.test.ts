import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type Extension,
  type JsonObject,
  MemoryStorage,
  type Registry,
} from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { registryOf } from "../src/registry.ts";
import {
  SATAN_EXTENSION,
  type SatanTools,
  type SatanToolsOptions,
  connectSatanTools,
  satanTools,
} from "../src/satan-tools.ts";
import {
  type FakeServerOptions,
  type FakeTool,
  type Fixture,
  fakeMcpServer,
  recorder,
  tempDir,
} from "./fixtures.ts";
import {
  callThenAnswer,
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

  /** Drive one model turn that calls `call`; returns that call's result. */
  const callTool = async (call: string, args: JsonObject): Promise<ToolResultMessage> => {
    if (test === undefined) {
      throw new Error("start first");
    }
    test.faux.setResponses(callThenAnswer(call, args, "done"));
    const settled = await (await test.root.submit({ type: "input", content: "go" }, context)).wait(
      context,
    );
    expect(settled.status).toBe("done");
    const result = (await toolResults(test.harness)).at(-1);
    if (result === undefined) {
      throw new Error("no tool result");
    }
    return result;
  };

  /** Stop the MCP server and wait until the daemon side has seen it go. */
  const stopServer = async (): Promise<void> => {
    await server?.close();
    server = undefined;
    await logs.next((line) => line.includes("closed"));
  };

  /** How many requests of `method` the server has received. */
  const received = (fixture: Fixture, method: string): number =>
    fixture.requests.items.filter((name) => name === method).length;

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

  it("refreshes by itself when a call reconnects, over one connection", async () => {
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
    expect(restarted.connections()).toBe(1);
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

  it("gives connectSatanTools an empty extension while satan-mcp is absent", async () => {
    const connected = await connectSatanTools(join(dir, "absent.sock"), logs.push);
    try {
      expect(connected.extension.tools).toEqual([]);
    } finally {
      await connected.close();
    }
  });
});
