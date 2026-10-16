// SATAN's MCP tools as a pi-durable extension: the durable counterpart of
// ~/notes/.pi/extensions/satan.ts, which targets the coding-agent API.
//
// Tools keep the default `replay: "unsafe"`: SATAN tools have side effects, so a
// call interrupted by a crash ends in an error result rather than rerunning.

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { McpClient, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import { UnixSocketTransport } from "./unix-socket-transport.ts";

export const SATAN_EXTENSION = "satan";

/** Providers require an object schema, and some reject one without `properties`. */
const objectSchema = (schema: Tool["inputSchema"]) =>
  Type.Unsafe<Record<string, unknown>>({
    ...schema,
    type: "object",
    properties: schema?.properties ?? {},
  });

const toDurableTool = (client: McpClient, tool: Tool) =>
  defineTool({
    name: tool.name,
    description: tool.description ?? `SATAN tool: ${tool.name}`,
    parameters: objectSchema(tool.inputSchema),
    execute: async (args, _api, context) => {
      const result = await client.callTool(tool.name, args, { signal: context.abortSignal });
      return { output: toLlmContent(result), isError: result.isError === true };
    },
  });

/** Connect to satan-mcp at `socketPath` and wrap the tools it lists. */
export async function connectSatanTools(
  socketPath: string,
): Promise<{ client: McpClient; extension: Extension }> {
  const client = new McpClient({ name: "pandaemonium", version: "0.0.0" });
  await client.connect(new UnixSocketTransport(socketPath));
  const tools = (await client.listTools()).map((tool) => toDurableTool(client, tool));
  return { client, extension: defineExtension({ name: SATAN_EXTENSION, tools }) };
}
