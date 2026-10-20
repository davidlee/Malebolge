// One live MCP client at a time, replaced on demand (SL-028 design §4.3): the
// connection half of the SATAN tools, apart from what is installed from it.

import { McpClient } from "@earendil-works/pi-mcp";
import { UnixSocketTransport } from "./unix-socket-transport.ts";

/** What a caller gets once `close` has run: the handle is finished, not reconnecting. */
const CLOSED = "satan-mcp client is closed";

/** An attempt at a client: the connection being opened, and the client once it has one. */
interface Attempt {
  /** Resolves with the client once satan-mcp has connected; rejects if it cannot. */
  readonly opening: Promise<McpClient>;
  /** The client, once connected: a later `reset` or `close` closes it on arrival. */
  client?: McpClient;
}

/**
 * One live MCP client at a time, opened on first use. A client that has closed
 * (satan-mcp restarted with Emacs) is replaced on the next use, and concurrent
 * callers share the attempt.
 */
export interface ReconnectingClient {
  get: () => Promise<McpClient>;
  /** Abandon the current client, or a pending attempt: the next `get()` opens a fresh one. */
  reset: () => void;
  /** Close for good: no attempt is begun again, and a waiting `get()` gives up. */
  close: () => Promise<void>;
}

/** Which closes of a client are worth reporting: the ones this handle did not cause. */
interface Drops {
  /** Watches `client`, now in service: its close is reported unless retired first. */
  watch: (client: McpClient) => void;
  /** Stops watching `client`: this handle is closing it itself. */
  retire: (client: McpClient) => void;
}

function dropsOf(log: (text: string) => void): Drops {
  const inService = new WeakSet<McpClient>();
  return {
    watch: (client): void => {
      inService.add(client);
      client.onClose(() => {
        if (inService.has(client)) {
          log("satan-mcp connection closed; reconnecting on next SATAN tool call");
        }
      });
    },
    retire: (client): void => {
      inService.delete(client);
    },
  };
}

/** A client at `socketPath`, in service once it has connected. */
async function connect(socketPath: string, drops: Drops): Promise<McpClient> {
  const client = new McpClient({ name: "malebolge", version: "0.0.0" });
  await client.connect(new UnixSocketTransport(socketPath));
  // Watched only now: a client that never connected has no connection to lose.
  drops.watch(client);
  return client;
}

/** An attempt of `open`, whose client is recorded when it arrives. */
function begin(open: () => Promise<McpClient>): Attempt {
  const opening = open();
  const attempt: Attempt = { opening };
  opening.then(
    (client) => {
      attempt.client = client;
    },
    () => undefined,
  );
  return attempt;
}

/**
 * A client at `socketPath` that reconnects on demand. `onReconnect` runs once a
 * replacement connection has connected: the tools satan-mcp serves may have
 * changed with it.
 */
export function reconnectingClient(
  socketPath: string,
  log: (text: string) => void,
  onReconnect: () => void,
): ReconnectingClient {
  const drops = dropsOf(log);
  const open = (): Promise<McpClient> => connect(socketPath, drops);
  /** Closes a client this handle is done with, retired so its close is not reported. */
  const closeNow = (client: McpClient): Promise<void> => {
    drops.retire(client);
    return client.close().catch(() => undefined);
  };
  /** Closes the attempt's client now if it has one, else as soon as it arrives. */
  const closeAttempt = async (attempt: Attempt): Promise<void> => {
    const client = attempt.client;
    if (client === undefined) {
      // Never waited for: an attempt may not settle, so a late client is closed on arrival.
      void attempt.opening.then(
        (late) => closeNow(late),
        () => undefined,
      );
      return;
    }
    await closeNow(client);
  };
  let current: Attempt | undefined;
  /** Set by `close`: the handle is finished, so no attempt is ever begun again. */
  let shut = false;
  /** Whether `close` has run; read through a call so it is not narrowed across awaits. */
  const closed = (): boolean => shut;
  /** Reports a replacement connection, which the tools may have changed with. */
  const reconnected = (): void => {
    log("satan-mcp reconnected");
    onReconnect();
  };
  const get = async (): Promise<McpClient> => {
    if (closed()) {
      throw new Error(CLOSED);
    }
    const attempt = (current ??= begin(open));
    const client = await attempt.opening.catch(() => undefined);
    // close() may have run while we waited: its attempt is discarded, and nothing reconnects.
    if (closed()) {
      throw new Error(CLOSED);
    }
    if (client?.connectionState === "connected") {
      return client;
    }
    if (current === attempt) {
      current = begin(open);
      // A failure reaches the caller through `current`; only success is reported here.
      void current.opening.then(reconnected, () => undefined);
    }
    // An attempt discarded while we waited (reset) falls forward to a fresh one.
    current ??= begin(open);
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
  const close = async (): Promise<void> => {
    shut = true;
    await discard();
  };
  return { get, reset, close };
}
