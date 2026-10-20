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

const tools: FakeTool[] = [
  {
    name: "notes_read",
    description: "Read a note",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    call: (args: Record<string, unknown>) => ({ text: `note ${String(args["id"])}` }),
  },
  { name: "fails", call: () => ({ text: "boom", isError: true }) },
];

/** satan-mcp after a restart: one of the old tools gone, one new tool. */
const changedTools: FakeTool[] = [
  {
    name: "notes_archive",
    description: "Archive a note",
    call: () => ({ text: "archived" }),
  },
];

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

  /** A harness over the shared registry and a handle on the socket; no refresh yet. */
  const openHandle = async (options?: SatanToolsOptions): Promise<SatanTools> => {
    test = await openFauxHarness(new MemoryStorage(), { registry });
    const handle = satanTools(socketPath, registry, logs.push, options);
    satan = handle;
    return handle;
  };

  /** A harness over the shared registry, then the handle's first refresh. */
  const start = async (): Promise<void> => {
    await (await openHandle({ deadlineMs: DEADLINE_MS })).refresh();
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

  it("installs nothing when a hung tools/list answers after the deadline", async () => {
    const hung = await restartServer(tools, { silent: ["tools/list"] });
    const handle = await openHandle({ deadlineMs: DEADLINE_MS });
    await handle.refresh();
    await hung.release();
    // Let the late answer arrive on the connection the timeout discarded.
    await new Promise((resolve) => setImmediate(resolve));
    expect(satanExtension()?.tools).toEqual([]);
    expect(logs.items.filter((line) => line.includes("SATAN tools"))).toEqual([]);
    expect(hung.connections()).toBe(1);
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
    const names = (): string[] => (satanExtension()?.tools ?? []).map((tool) => tool.name);
    const installs: string[][] = [];
    registry.subscribe(() => {
      installs.push(names());
    });
    const first = handle.refresh();
    let seenBySecond: string[] = [];
    const second = handle.refresh().then(() => {
      seenBySecond = names();
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
    // The attempt connects after the handle is closed, and is closed on arrival.
    await stalled.release();
    await stalled.ended;
    await refresh;
    expect(stalled.connections()).toBe(1);
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
