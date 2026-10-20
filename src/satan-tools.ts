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
import { registryOf } from "./registry.ts";
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
 * One live MCP client at a time, opened on first use. A client that has closed
 * (satan-mcp restarted with Emacs) is replaced on the next use; concurrent
 * callers share the attempt. `onReconnect` runs once such a replacement has
 * connected: the tools satan-mcp serves may have changed with it.
 */
interface ReconnectingClient {
  get: () => Promise<McpClient>;
  /** Abandon the current client, or a pending attempt: the next `get()` opens a fresh one. */
  reset: () => void;
  /** Abandon like `reset`, waiting only for a client that has already connected to close. */
  close: () => Promise<void>;
}

/** An attempt at a client: the connection being opened, and the client once it has one. */
interface Attempt {
  /** Resolves with the client once satan-mcp has connected; rejects if it cannot. */
  readonly opening: Promise<McpClient>;
  /** The client, once connected: a later `reset` or `close` closes it on arrival. */
  client?: McpClient;
}

function reconnectingClient(
  socketPath: string,
  log: Log,
  onReconnect: () => void,
): ReconnectingClient {
  const open = async (): Promise<McpClient> => {
    const client = new McpClient({ name: "malebolge", version: "0.0.0" });
    // A client that never connected has no connection to lose, only an attempt.
    let live = false;
    client.onClose(() => {
      if (live) {
        log("satan-mcp connection closed; reconnecting on next SATAN tool call");
      }
    });
    await client.connect(new UnixSocketTransport(socketPath));
    live = true;
    return client;
  };
  /** A fresh attempt, whose client is recorded when it arrives. */
  const begin = (): Attempt => {
    const opening = open();
    const attempt: Attempt = { opening };
    opening.then(
      (client) => {
        attempt.client = client;
      },
      () => undefined,
    );
    return attempt;
  };
  /**
   * Closes the attempt's client now if it has one, else as soon as it arrives.
   * Only the former is awaited: an attempt may never settle.
   */
  const closeAttempt = async (attempt: Attempt): Promise<void> => {
    const client = attempt.client;
    if (client !== undefined) {
      await client.close().catch(() => undefined);
      return;
    }
    attempt.opening
      .then(
        (client) => client.close(),
        () => undefined,
      )
      .catch(() => undefined);
  };
  let current: Attempt | undefined;
  const get = async (): Promise<McpClient> => {
    if (current === undefined) {
      current = begin();
      return current.opening;
    }
    const attempt = current;
    const client = await attempt.opening.catch(() => undefined);
    if (client?.connectionState === "connected") {
      return client;
    }
    if (current === attempt) {
      current = begin();
      // A failure reaches the caller through `current`; only success is logged here.
      current.opening.then(
        () => {
          log("satan-mcp reconnected");
          onReconnect();
        },
        () => undefined,
      );
    }
    return current.opening;
  };
  /** Drops the current attempt: its client is closed now, or on arrival if it has none yet. */
  const discard = async (): Promise<void> => {
    const abandoned = current;
    current = undefined;
    if (abandoned !== undefined) {
      await closeAttempt(abandoned);
    }
  };
  const reset = (): void => {
    void discard();
  };
  return { get, reset, close: discard };
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

/** satan-mcp's answer: its tool list, or the reason there is none. */
type Listing = { readonly tools: readonly Tool[] } | { readonly failure: string };

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
  /** What the last log said: a tool count, `null` for unreachable, `undefined` for nothing yet. */
  let reported: number | null | undefined;

  const extensionOf = (tools: readonly Tool[]): Extension =>
    defineExtension({
      name: SATAN_EXTENSION,
      tools: tools.map((tool) => toDurableTool(connection.get, tool)),
    });

  const listing = async (deadline: AbortSignal): Promise<Listing> => {
    try {
      const client = await within(connection.get(), deadline);
      return { tools: await client.listTools({ signal: deadline }) };
    } catch (error) {
      const timedOut = deadline.aborted;
      return { failure: timedOut ? `timed out after ${String(deadlineMs)} ms` : messageOf(error) };
    }
  };

  /** Logs a change of state: the tool count, or once that satan-mcp is unreachable. */
  const report = (listed: Listing): void => {
    if ("tools" in listed) {
      if (reported !== listed.tools.length) {
        reported = listed.tools.length;
        log(`${String(listed.tools.length)} SATAN tools`);
      }
      return;
    }
    if (reported !== null) {
      reported = null;
      log(`satan-mcp unreachable: ${listed.failure}`);
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
    registry.install(extensionOf("tools" in listed ? listed.tools : []));
    report(listed);
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
