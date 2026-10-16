import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { McpClient } from "@earendil-works/pi-mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { connectSatanTools } from "../src/satan-tools.ts";
import { type Fixture, fakeMcpServer, tempDir } from "./fixtures.ts";
import {
  callThenAnswer,
  openTestHarness,
  type TestHarness,
  textOf,
  toolResults,
} from "./harness-fixture.ts";

const tools = [
  {
    name: "notes_read",
    description: "Read a note",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    call: (args: Record<string, unknown>) => ({ text: `note ${args.id}` }),
  },
  { name: "fails", call: () => ({ text: "boom", isError: true }) },
];

describe("connectSatanTools", () => {
  let cleanup: () => Promise<void>;
  let server: Fixture;
  let client: McpClient;
  let test: TestHarness | undefined;

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    server = await fakeMcpServer(join(tmp.dir, "mcp.sock"), tools);
  });

  afterEach(async () => {
    await test?.harness.close(context);
    await client?.close();
    await server.close();
    await cleanup();
  });

  const run = async (call: string, args: JsonObject) => {
    const satan = await connectSatanTools(server.socketPath);
    client = satan.client;
    test = await openTestHarness([satan.extension]);
    test.faux.setResponses(callThenAnswer(call, args, "done"));
    const settled = await (await test.root.submit({ type: "input", content: "go" }, context)).wait(
      context,
    );
    expect(settled.status).toBe("done");
    return toolResults(test.harness);
  };

  it("offers every MCP tool, with the server's description", async () => {
    const satan = await connectSatanTools(server.socketPath);
    client = satan.client;
    expect(satan.extension.tools?.map((t) => [t.name, t.description])).toEqual([
      ["notes_read", "Read a note"],
      ["fails", "SATAN tool: fails"],
    ]);
  });

  it("forwards a model's call to the MCP server and returns its content", async () => {
    const [result] = await run("notes_read", { id: "42" });
    expect(textOf(result)).toBe("note 42");
    expect(result.isError).toBe(false);
  });

  it("surfaces an MCP tool error as an error result", async () => {
    const [result] = await run("fails", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("boom");
  });

  it("rejects arguments that violate the tool's input schema before calling it", async () => {
    const [result] = await run("notes_read", {});
    expect(result.isError).toBe(true);
  });
});
