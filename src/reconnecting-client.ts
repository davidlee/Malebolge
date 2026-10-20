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
  /** Set when this handle gives up on it: a client that arrives then is no longer news. */
  abandoned?: boolean;
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
  /** Watches `client`, now in service: its close is reported, and counts as a loss. */
  watch: (client: McpClient) => void;
  /** Closes `client` on this handle's behalf: retired first, so its close is not reported. */
  close: (client: McpClient) => Promise<void>;
}

function dropsOf(log: (text: string) => void, onLoss: () => void): Drops {
  const inService = new WeakSet<McpClient>();
  return {
    watch: (client): void => {
      inService.add(client);
      client.onClose(() => {
        if (!inService.has(client)) {
          return;
        }
        inService.delete(client);
        log("satan-mcp connection closed; reconnecting on next SATAN tool call");
        onLoss();
      });
    },
    close: (client): Promise<void> => {
      inService.delete(client);
      return client.close().catch(() => undefined);
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

/** What an attempt came to: the client it connected, or what stopped it. */
type Outcome = { readonly client: McpClient } | { readonly error: Error };

/** The outcome of `opening`, with a rejection that is not an `Error` normalised. */
async function outcomeOf(opening: Promise<McpClient>): Promise<Outcome> {
  try {
    return { client: await opening };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
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
 * Closes the attempt's client now if it has one, else as soon as it arrives. Only the
 * former is awaited: an attempt may never settle.
 */
async function closeAttempt(attempt: Attempt, drops: Drops): Promise<void> {
  const client = attempt.client;
  if (client === undefined) {
    // Never waited for: an attempt may not settle, so a late client is closed on arrival.
    void attempt.opening.then(drops.close, () => undefined);
    return;
  }
  await drops.close(client);
}

/**
 * A client at `socketPath` that reconnects on demand. `onReconnect` runs once a
 * connection the handle had is lost and another stands in for it: the tools
 * satan-mcp serves may have changed with it.
 */
export function reconnectingClient(
  socketPath: string,
  log: (text: string) => void,
  onReconnect: () => void,
): ReconnectingClient {
  /** Whether a client has been lost since the last announcement: the tools may have changed. */
  let lost = false;
  const drops = dropsOf(log, () => {
    lost = true;
  });
  const open = (): Promise<McpClient> => connect(socketPath, drops);
  let current: Attempt | undefined;
  /** Set by `close`: the handle is finished, so no attempt is ever begun again. */
  let shut = false;
  /** Whether `close` has run; read through a call so it is not narrowed across awaits. */
  const closed = (): boolean => shut;
  /** Throws once `close` has run: nothing is begun, and a waiter gives up. */
  const assertOpen = (): void => {
    if (closed()) {
      throw new Error(CLOSED);
    }
  };
  /**
   * Reports a connection that stands in for a lost one, once: the tools satan-mcp
   * serves may have changed. Silent if the handle closed meanwhile, or if the attempt
   * was abandoned — `lost` then stays armed for the next connection.
   */
  const reconnected = (attempt: Attempt): void => {
    if (!lost || closed() || attempt.abandoned === true) {
      return;
    }
    lost = false;
    log("satan-mcp reconnected");
    onReconnect();
  };
  /**
   * Records `attempt` as the current one, forgetting it again if it never connects: a
   * failed attempt must not become what later callers wait on. A connection that does
   * stand in for a lost one is offered to `reconnected`.
   */
  const record = (attempt: Attempt): Attempt => {
    current = attempt;
    void attempt.opening.then(
      () => {
        reconnected(attempt);
      },
      () => {
        if (current === attempt) {
          current = undefined;
        }
      },
    );
    return attempt;
  };
  const get = async (): Promise<McpClient> => {
    assertOpen();
    const attempt = (current ??= record(begin(open)));
    const outcome = await outcomeOf(attempt.opening);
    // close() may have run while we waited: that attempt is discarded, and nothing reconnects.
    assertOpen();
    if ("error" in outcome) {
      // It never connected, so no client is being replaced and no second attempt is made:
      // the next caller opens the one connection it needs.
      throw outcome.error;
    }
    if (outcome.client.connectionState === "connected") {
      return outcome.client;
    }
    // A client that connected and then closed is being replaced: the tools may have
    // changed with it, so its replacement is offered to `reconnected`.
    if (current === attempt) {
      record(begin(open));
    }
    // An attempt discarded while we waited (reset) falls forward to a fresh one.
    current ??= record(begin(open));
    return current.opening;
  };
  /** Drops the current attempt, abandoned: its client is closed now, or on arrival. */
  const discard = async (): Promise<void> => {
    const attempt = current;
    current = undefined;
    if (attempt !== undefined) {
      attempt.abandoned = true;
      await closeAttempt(attempt, drops);
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
