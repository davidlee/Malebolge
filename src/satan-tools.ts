// SATAN's MCP tools as a pi-durable extension: the durable counterpart of
// ~/notes/.pi/extensions/satan.ts, which targets the coding-agent API.
//
// Tools keep the default `replay: "unsafe"`: SATAN tools have side effects, so a
// call interrupted by a crash ends in an error result rather than rerunning.

import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  defineTool,
  type Extension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { type CallToolResult, McpClient, type Tool, toLlmContent } from "@earendil-works/pi-mcp";
import { coalesce } from "./coalesce.ts";
import { satanIdentity } from "./conversation-context.ts";
import { messageOf } from "./message-of.ts";
import { CLOSED, reconnectingClient, type ReconnectingClient } from "./reconnecting-client.ts";
import { DEFAULT_SATAN_IDLE_MS, type PoolKey, satanPool } from "./satan-pool.ts";

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

/** The pool key a conversation's interactive calls are made under. */
export const callsOf = (conversation: ConversationId): PoolKey => ({
  conversation,
  kind: "interactive",
});

/**
 * Runs `use` over `key`'s pooled connection, holding it for the whole call: the
 * entry outlives the call by the pool's idle timeout, never shorter.
 */
type WithConnection = <T>(key: PoolKey, use: (client: McpClient) => Promise<T>) => Promise<T>;

const toDurableTool = (
  withConnection: WithConnection,
  tool: Tool,
): ToolRegistration<ObjectSchema> =>
  defineTool({
    name: tool.name,
    description: tool.description ?? `SATAN tool: ${tool.name}`,
    parameters: objectSchema(tool.inputSchema),
    execute: async (args, api, context) => {
      const signal = context.abortSignal;
      return withConnection(callsOf(api.conversationId), async (client) => {
        const result = await client.callTool(
          tool.name,
          args,
          signal === undefined ? {} : { signal },
        );
        return { output: toLlmContent(result), isError: result.isError === true };
      });
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

/** `tools` wired to `withConnection`, as the `satan` extension. */
const extensionOf = (withConnection: WithConnection, tools: readonly Tool[]): Extension =>
  defineExtension({
    name: SATAN_EXTENSION,
    tools: tools.map((tool) => toDurableTool(withConnection, tool)),
  });

export interface SatanTools {
  /**
   * Re-list satan-mcp's tools and install them as the `satan` extension. One read
   * runs at a time; a call made during one waits for the single read that follows
   * it, so it never gets a list older than itself.
   */
  refresh: () => Promise<void>;
  /** One satan-mcp tool call over `key`'s pooled connection, bounded by `deadlineMs`. */
  call: (
    key: PoolKey,
    tool: string,
    args: Record<string, unknown>,
    deadlineMs: number,
  ) => Promise<CallToolResult>;
  /**
   * Close for good: the connection goes now if it has connected, or on arrival if it
   * is still connecting (never waited on). Later calls and refreshes are refused.
   */
  close: () => Promise<void>;
}

export interface SatanToolsOptions {
  /** How long one refresh may take, its connection attempt and tool listing together. */
  deadlineMs?: number;
  /** How long a conversation's connection survives once no call is using it. */
  idleMs?: number;
}

const DEFAULT_DEADLINE_MS = 2000;

/** One conversation's connection, and whether a connection of it has been announced. */
interface Pooled {
  readonly client: ReconnectingClient;
  /** Set at its first connected `get`: the pool refreshes discovery once per entry, not per call. */
  announced: boolean;
}

/** The connections tool calls run over, and how a call holds one. */
interface Connections {
  withConnection: WithConnection;
  /** Close for good: every conversation's connection goes, and later calls are refused. */
  close: () => Promise<void>;
}

/**
 * The pool of per-conversation connections. `refresh` is discovery's, run once per
 * entry's first connection: a fresh entry after a server restart would otherwise
 * never refresh, since `onReconnect` fires only on a handle that itself saw a loss.
 * That first call answers only once the refresh has settled, so the turn's next
 * step is offered the tools satan-mcp serves now (VA-1).
 */
function connectionPool(
  socketPath: string,
  log: Log,
  refresh: () => Promise<void>,
  idleMs: number,
): Connections {
  const pool = satanPool<Pooled>({
    idleMs,
    // A pooled connection reconnects into the discovery refresh, like discovery's own.
    open: (key) => ({
      client: reconnectingClient(
        socketPath,
        log,
        () => {
          void refresh();
        },
        satanIdentity(key.conversation, key.kind),
      ),
      announced: false,
    }),
    close: (entry) => entry.client.close(),
  });
  /** Set by `close`: a call is refused with the reason a closed connection gives. */
  let shut = false;

  const withConnection: WithConnection = async (key, use) => {
    if (shut) {
      throw new Error(CLOSED);
    }
    const entry = pool.acquire(key);
    try {
      const client = await entry.client.get();
      const first = !entry.announced;
      entry.announced = true;
      try {
        return await use(client);
      } finally {
        // Once per entry, after the call: the call is neither held back by the refresh
        // nor replayed, but its result waits for it.
        if (first) {
          await refresh();
        }
      }
    } finally {
      pool.release(key);
    }
  };

  return {
    withConnection,
    close: async (): Promise<void> => {
      shut = true;
      await pool.closeAll();
    },
  };
}

/**
 * A handle on satan-mcp's tools, installed into `registry` as the `satan`
 * extension. Construction never connects, so a missing satan-mcp costs a
 * `refresh` and leaves the extension empty rather than failing the daemon. A
 * refresh that outlives its deadline discards the connection it was using.
 *
 * Discovery (`tools/list`, and the reconnect that invalidates it) is the one
 * connection `connection`; every tool call runs over its conversation's own
 * pooled connection, which announces that conversation's identity (V10).
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
  const connections = connectionPool(
    socketPath,
    log,
    () => refresh(),
    options.idleMs ?? DEFAULT_SATAN_IDLE_MS,
  );
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
   * Installs `listed` as the extension, or the empty one when pi-durable refuses the
   * list (satan-mcp listing one tool twice, say): that failure cannot escape a refresh.
   */
  const install = (listed: Listing): Listing => {
    try {
      registry.install(
        extensionOf(connections.withConnection, "tools" in listed ? listed.tools : []),
      );
      return listed;
    } catch (error) {
      // The empty extension has nothing pi-durable can refuse.
      registry.install(extensionOf(connections.withConnection, []));
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

  /** Discovery first, then every conversation's connection: neither outlives the close. */
  const close = async (): Promise<void> => {
    await connection.close();
    await connections.close();
  };

  const call: SatanTools["call"] = (key, tool, args, callDeadlineMs) => {
    const signal = AbortSignal.timeout(callDeadlineMs);
    return within(
      connections.withConnection(key, (client) => client.callTool(tool, args, { signal })),
      signal,
    );
  };

  return { refresh, call, close };
}
