import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { connectSatanTools, type SatanTools } from "../src/satan-tools.ts";
import { type FakeTool, type Fixture, fakeMcpServer, recorder, tempDir } from "./fixtures.ts";
import {
  callThenAnswer,
  openTestHarness,
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

describe("connectSatanTools", () => {
  let cleanup: () => Promise<void>;
  let socketPath: string;
  let server: Fixture | undefined;
  let satan: SatanTools | undefined;
  let test: TestHarness | undefined;
  let logs: ReturnType<typeof recorder<string>>;

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    socketPath = join(tmp.dir, "mcp.sock");
    server = await fakeMcpServer(socketPath, tools);
    logs = recorder<string>();
  });

  afterEach(async () => {
    await test?.harness.close(context);
    await satan?.close();
    await server?.close();
    await cleanup();
  });

  const connect = async (): Promise<void> => {
    satan = await connectSatanTools(socketPath, logs.push);
    test = await openTestHarness([satan.extension]);
  };

  /** Drive one model turn that calls `call`; returns that call's result. */
  const callTool = async (call: string, args: JsonObject): Promise<ToolResultMessage> => {
    if (test === undefined) {
      throw new Error("connect first");
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

  it("offers every MCP tool, with the server's description", async () => {
    satan = await connectSatanTools(socketPath, logs.push);
    expect(satan.extension.tools?.map((t) => [t.name, t.description])).toEqual([
      ["notes_read", "Read a note"],
      ["fails", "SATAN tool: fails"],
    ]);
  });

  it("forwards a model's call to the MCP server and returns its content", async () => {
    await connect();
    const result = await callTool("notes_read", { id: "42" });
    expect(textOf(result)).toBe("note 42");
    expect(result.isError).toBe(false);
  });

  it("surfaces an MCP tool error as an error result", async () => {
    await connect();
    const result = await callTool("fails", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("boom");
  });

  it("rejects arguments that violate the tool's input schema before calling it", async () => {
    await connect();
    const result = await callTool("notes_read", {});
    expect(result.isError).toBe(true);
  });

  it("reconnects on the next call after the MCP server restarts", async () => {
    await connect();
    await stopServer();
    server = await fakeMcpServer(socketPath, tools);
    const result = await callTool("notes_read", { id: "7" });
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("note 7");
  });

  it("fails a call while the MCP server is down, then recovers once it is back", async () => {
    await connect();
    await stopServer();
    expect((await callTool("notes_read", { id: "1" })).isError).toBe(true);
    server = await fakeMcpServer(socketPath, tools);
    expect(textOf(await callTool("notes_read", { id: "2" }))).toBe("note 2");
  });
});
