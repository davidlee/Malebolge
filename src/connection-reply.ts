// The reply helpers shared by the daemon's socket and, later, the bridge
// listener: write one frame or one error, settle a first-line frame with the
// one reply it produced, and end the connection after it. They need only a
// socket and whether the connection has ended.

import type { Socket } from "node:net";
import { encodeLine } from "./ndjson.ts";
import type { ErrorMessage } from "./protocol.ts";

/** What the reply helpers need of a connection: its socket and whether it has ended. */
export interface Replying {
  socket: Socket;
  ended: boolean;
}

export const errorMessage = (error: unknown): ErrorMessage => ({
  type: "error",
  message: error instanceof Error ? error.message : String(error),
});

export function write(state: Replying, value: unknown): void {
  if (state.socket.writable) {
    state.socket.write(encodeLine(value));
  }
}

export function writeError(state: Replying, error: unknown): void {
  write(state, errorMessage(error));
}

/**
 * This connection is over: an optional final frame, the socket ended, and the
 * lines queued behind it dropped. The only daemon-side close, with an error or
 * without one.
 */
export function finish(state: Replying, value?: unknown): void {
  if (state.ended) {
    return;
  }
  state.ended = true;
  if (value !== undefined) {
    write(state, value);
  }
  state.socket.end();
}

/** This connection is over: one error, the socket ended, the lines queued behind it dropped. */
export function fail(state: Replying, error: unknown): void {
  finish(state, errorMessage(error));
}

/**
 * Answer a first-line frame with the one reply `produce` builds, then close cleanly:
 * no binding, nothing created, no durable state (DEC-007). A rejection goes through
 * `fail`, because an error left on an open connection strands the client.
 */
export async function answer<R>(state: Replying, produce: () => Promise<R>): Promise<void> {
  let reply: R;
  try {
    reply = await produce();
  } catch (error) {
    fail(state, error);
    return;
  }
  finish(state, reply);
}
