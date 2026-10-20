// One live MCP client at a time, replaced on demand (SL-028 design §4.3): the
// connection half of the SATAN tools, apart from what is installed from it.

import { McpClient } from "@earendil-works/pi-mcp";
import { UnixSocketTransport } from "./unix-socket-transport.ts";

/**
 * One live MCP client, opened on first use. A client that has closed
 * (satan-mcp restarted with Emacs) is replaced on the next use; concurrent
 * callers share the attempt. `onReconnect` runs once such a replacement has
 * connected: the tools satan-mcp serves may have changed with it.
 */
export interface ReconnectingClient {
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

export function reconnectingClient(
  socketPath: string,
  log: (text: string) => void,
  onReconnect: () => void,
): ReconnectingClient {
  /** Clients in service: one whose close this handle did not cause is a drop worth reporting. */
  const inService = new WeakSet<McpClient>();
  const open = async (): Promise<McpClient> => {
    const client = new McpClient({ name: "malebolge", version: "0.0.0" });
    client.onClose(() => {
      // A client that never connected has no connection to lose, only an attempt.
      if (inService.has(client)) {
        log("satan-mcp connection closed; reconnecting on next SATAN tool call");
      }
    });
    await client.connect(new UnixSocketTransport(socketPath));
    inService.add(client);
    return client;
  };
  /** Retires a client this handle is closing, so that its close is not reported as a drop. */
  const retire = (client: McpClient): void => {
    inService.delete(client);
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
      retire(client);
      await client.close().catch(() => undefined);
      return;
    }
    attempt.opening
      .then(
        (client) => {
          // Arrived after we gave up on it: closed on arrival, and not reported as a drop.
          retire(client);
          return client.close();
        },
        () => undefined,
      )
      .catch(() => undefined);
  };
  let current: Attempt | undefined;
  const get = async (): Promise<McpClient> => {
    const attempt = (current ??= begin());
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
    // An attempt discarded while we waited (reset or close) falls forward to a fresh one.
    current ??= begin();
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
