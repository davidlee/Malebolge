import { join } from "node:path";
import { McpClient, McpConnectionClosedError } from "@earendil-works/pi-mcp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnixSocketTransport } from "../src/unix-socket-transport.ts";
import { type FakeTool, type Fixture, fakeMcpServer, tempDir } from "./fixtures.ts";

const echo: FakeTool = {
  name: "echo",
  call: (args: Record<string, unknown>) => ({ text: String(args["text"]) }),
};

describe("UnixSocketTransport", () => {
  let cleanup: () => Promise<void>;
  let server: Fixture;
  let client: McpClient;

  beforeEach(async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    server = await fakeMcpServer(join(tmp.dir, "mcp.sock"), [echo]);
    client = new McpClient({ name: "test", version: "0" });
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await cleanup();
  });

  it("carries an MCP session: initialize, list and call tools", async () => {
    const init = await client.connect(new UnixSocketTransport(server.socketPath));
    expect(init.serverInfo.name).toBe("fake-satan");
    expect((await client.listTools()).map((t) => t.name)).toEqual(["echo"]);
    const result = await client.callTool("echo", { text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("rejects start when nothing listens on the path", async () => {
    const missing = new UnixSocketTransport(`${server.socketPath}.missing`);
    await expect(missing.start()).rejects.toThrow(/ENOENT|ECONNREFUSED/);
  });

  it("reports close when the server goes away, and refuses later sends", async () => {
    const transport = new UnixSocketTransport(server.socketPath);
    const closed = new Promise<void>((resolve) => transport.onClose(resolve));
    await transport.start();
    await server.close();
    await closed;
    await expect(
      transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).rejects.toBeInstanceOf(McpConnectionClosedError);
  });
});
