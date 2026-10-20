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
  connectSatanTools,
  satanTools,
} from "../src/satan-tools.ts";
import { type FakeTool, type Fixture, fakeMcpServer, recorder, tempDir } from "./fixtures.ts";
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

  /** A harness over the shared registry, then the handle's first refresh. */
  const start = async (): Promise<void> => {
    test = await openFauxHarness(new MemoryStorage(), { registry });
    satan = satanTools(socketPath, registry, logs.push);
    await satan.refresh();
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

  it("installs every MCP tool, with the server's description", async () => {
    await start();
    expect(satanExtension()?.tools?.map((tool) => [tool.name, tool.description])).toEqual([
      ["notes_read", "Read a note"],
      ["fails", "SATAN tool: fails"],
    ]);
  });

  it("makes a tool installed after the harness opened callable on the next turn", async () => {
    test = await openFauxHarness(new MemoryStorage(), { registry });
    satan = satanTools(socketPath, registry, logs.push);
    await satan.refresh();
    expect(textOf(await callTool("notes_read", { id: "42" }))).toBe("note 42");
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
    test = await openFauxHarness(new MemoryStorage(), { registry });
    satan = satanTools(join(dir, "absent.sock"), registry, logs.push);
    await satan.refresh();
    await satan.refresh();
    expect(satanExtension()?.tools).toEqual([]);
    expect(logs.items.filter((line) => line.includes("satan-mcp unreachable"))).toHaveLength(1);
    expect(logs.items.filter((line) => line.includes("SATAN tools"))).toEqual([]);
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
