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
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { McpClient, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import { coalesce } from "./coalesce.ts";
import { messageOf } from "./message-of.ts";
import { reconnectingClient } from "./reconnecting-client.ts";
import { registryOf } from "./registry.ts";

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

/** satan-mcp's answer: its tool list, or no tools with the state and message to log. */
type Listing =
  | { readonly tools: readonly Tool[] }
  | { readonly state: "unreachable" | "rejected"; readonly message: string };

/**
 * `work`, or a rejection as soon as `signal` aborts. A late failure of `work`
 * is handled here, so an abandoned attempt cannot surface as an unhandled rejection.
 */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("the deadline passed"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** `tools` wired to `client`, as the `satan` extension. */
const extensionOf = (client: () => Promise<McpClient>, tools: readonly Tool[]): Extension =>
  defineExtension({
    name: SATAN_EXTENSION,
    tools: tools.map((tool) => toDurableTool(client, tool)),
  });

export interface SatanTools {
  /**
   * Re-list satan-mcp's tools and install them as the `satan` extension. One read
   * runs at a time; a call made during one waits for the single read that follows
   * it, so it never gets a list older than itself.
   */
  refresh: () => Promise<void>;
  /**
   * Drop the MCP connection: closed now if it has connected, and on arrival if it
   * is still connecting — which is never waited on.
   */
  close: () => Promise<void>;
}

export interface SatanToolsOptions {
  /** How long one refresh may take, its connection attempt and tool listing together. */
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 2000;

/**
 * A handle on satan-mcp's tools, installed into `registry` as the `satan`
 * extension. Construction never connects, so a missing satan-mcp costs a
 * `refresh` and leaves the extension empty rather than failing the daemon. A
 * refresh that outlives its deadline discards the connection it was using.
 */
export function satanTools(
  socketPath: string,
  registry: Registry,
  log: Log,
  options: SatanToolsOptions = {},
): SatanTools {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  // A connection is first wanted by a read, so `refresh` exists before any reconnect can.
  const connection = reconnectingClient(socketPath, log, () => {
    void refresh();
  });
  /** What the last log said: a tool count, why there are none, or nothing yet. */
  let reported: number | "unreachable" | "rejected" | undefined;

  const listing = async (deadline: AbortSignal): Promise<Listing> => {
    try {
      const client = await within(connection.get(), deadline);
      return { tools: await client.listTools({ signal: deadline }) };
    } catch (error) {
      const why = deadline.aborted ? `timed out after ${String(deadlineMs)} ms` : messageOf(error);
      return { state: "unreachable", message: `satan-mcp unreachable: ${why}` };
    }
  };

  /** Logs a change of state: the tool count, or why there are none. */
  const report = (listed: Listing): void => {
    const state = "tools" in listed ? listed.tools.length : listed.state;
    if (state === reported) {
      return;
    }
    reported = state;
    log("tools" in listed ? `${String(listed.tools.length)} SATAN tools` : listed.message);
  };

  /**
   * Installs `listed` as the extension, or the empty one when it cannot be installed
   * (satan-mcp listing one tool twice, say): a refresh never throws.
   */
  const install = (listed: Listing): Listing => {
    try {
      registry.install(extensionOf(connection.get, "tools" in listed ? listed.tools : []));
      return listed;
    } catch (error) {
      // The empty extension admits no duplicates, so installing it cannot fail.
      registry.install(extensionOf(connection.get, []));
      return { state: "rejected", message: `satan-mcp tools rejected: ${messageOf(error)}` };
    }
  };

  /** One read: satan-mcp's list installed, or nothing when it cannot be had. */
  const read = async (): Promise<void> => {
    const deadline = AbortSignal.timeout(deadlineMs);
    const listed = await listing(deadline);
    if (deadline.aborted) {
      // A hung connect or a wedged server must not become the `current` every later call
      // awaits: a timed-out refresh discards the connection (RV-040 F-3).
      connection.reset();
    }
    // The list is satan-mcp's last answer or nothing: a failed read leaves no stale tools.
    report(install(listed));
  };

  const refresh = coalesce(read);

  return { refresh, close: connection.close };
}

/** A handle's extension in a private registry: what `connectSatanTools` gives its caller. */
export interface SatanExtension {
  extension: Extension;
  close: () => Promise<void>;
}

/**
 * A private registry holding SATAN's extension, refreshed once. Kept until the
 * daemon builds the registry once and installs the handle into it.
 */
export async function connectSatanTools(socketPath: string, log: Log): Promise<SatanExtension> {
  const registry = registryOf([]);
  const satan = satanTools(socketPath, registry, log);
  await satan.refresh();
  const extension = registry.snapshot().extension(SATAN_EXTENSION);
  if (extension === undefined) {
    throw new Error(`the ${SATAN_EXTENSION} extension was not installed`);
  }
  return { extension, close: satan.close };
}
