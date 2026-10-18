// SATAN's MCP tools as a pi-durable extension: the durable counterpart of
// ~/notes/.pi/extensions/satan.ts, which targets the coding-agent API.
//
// Tools keep the default `replay: "unsafe"`: SATAN tools have side effects, so a
// call interrupted by a crash ends in an error result rather than rerunning.

import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { McpClient, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import { UnixSocketTransport } from "./unix-socket-transport.ts";

export const SATAN_EXTENSION = "satan";

type ObjectSchema = ReturnType<typeof Type.Unsafe<Record<string, unknown>>>;

/** Providers require an object schema, and some reject one without `properties`. */
const objectSchema = (schema: Tool["inputSchema"]): ObjectSchema =>
  Type.Unsafe<Record<string, unknown>>({
    ...schema,
    type: "object",
    properties: schema["properties"] ?? {},
  });

/** Logs one line of daemon diagnostics. */
export type Log = (text: string) => void;

/**
 * One live MCP client at a time. A client that has closed (satan-mcp restarted
 * with Emacs) is replaced on the next use; concurrent callers share the attempt.
 */
interface ReconnectingClient {
  first: Promise<McpClient>;
  get: () => Promise<McpClient>;
  close: () => Promise<void>;
}

function reconnectingClient(socketPath: string, log: Log): ReconnectingClient {
  const open = async (): Promise<McpClient> => {
    const client = new McpClient({ name: "malebolge", version: "0.0.0" });
    client.onClose(() => {
      log("satan-mcp connection closed; reconnecting on next SATAN tool call");
    });
    await client.connect(new UnixSocketTransport(socketPath));
    return client;
  };
  let current = open();
  const get = async (): Promise<McpClient> => {
    const pending = current;
    const client = await pending.catch(() => undefined);
    if (client?.connectionState === "connected") {
      return client;
    }
    if (current === pending) {
      current = open();
      // A failure reaches the caller through `current`; only success is logged here.
      current.then(
        () => {
          log("satan-mcp reconnected");
        },
        () => undefined,
      );
    }
    return current;
  };
  const close = async (): Promise<void> => {
    const client = await current.catch(() => undefined);
    await client?.close();
  };
  return { first: current, get, close };
}

const toDurableTool = (
  client: () => Promise<McpClient>,
  tool: Tool,
): ToolRegistration<ObjectSchema> =>
  defineTool({
    name: tool.name,
    description: tool.description ?? `SATAN tool: ${tool.name}`,
    parameters: objectSchema(tool.inputSchema),
    execute: async (args, _api, context) => {
      const signal = context.abortSignal;
      const result = await (await client()).callTool(
        tool.name,
        args,
        signal === undefined ? {} : { signal },
      );
      return { output: toLlmContent(result), isError: result.isError === true };
    },
  });

export interface SatanTools {
  extension: Extension;
  close: () => Promise<void>;
}

/**
 * Connect to satan-mcp at `socketPath` and wrap the tools it lists. The tool
 * list is fixed here; a call made while satan-mcp is down fails, and is never
 * retried, since SATAN tools have side effects.
 */
export async function connectSatanTools(socketPath: string, log: Log): Promise<SatanTools> {
  const connection = reconnectingClient(socketPath, log);
  const tools = (await (await connection.first).listTools()).map((tool) =>
    toDurableTool(connection.get, tool),
  );
  return {
    extension: defineExtension({ name: SATAN_EXTENSION, tools }),
    close: connection.close,
  };
}
