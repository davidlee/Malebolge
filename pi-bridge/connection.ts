// SL-009 design sec-2/sec-7: one client connection to the bridge socket, as
// JSON lines. Shared by the extension shell and the command; node-only.
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  BRIDGE_LINE_MAX_BYTES,
  DAEMON_FRAMES,
  type BoundFrame,
  type DaemonFrame,
  type FirstLineFrame,
  parseFrame,
} from "./wire.ts";

export interface ConnectionHandlers {
  /** One daemon frame, parsed against DAEMON_FRAMES. */
  onFrame: (frame: DaemonFrame) => void;
  /**
   * The connection is gone (connect failure, drop, or an unreadable daemon
   * line). Called at most once, and never after a local `close()`.
   * `connected` is whether the socket had connected.
   */
  onClose: (reason: string, connected: boolean) => void;
}

export interface LineConnection {
  send: (frame: BoundFrame) => void;
  /** Destroy the socket; no `onClose` follows. */
  close: () => void;
}

/** Connect to `path` and write `first` as the first line. */
export function openConnection(
  path: string,
  first: FirstLineFrame,
  handlers: ConnectionHandlers,
): LineConnection {
  const socket = createConnection(path);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let connected = false;
  let gone = false;

  /** Drop every listener and the socket: nothing more is read or reported by us. */
  const discard = (): void => {
    socket.removeAllListeners();
    socket.destroy();
  };

  /** The one end of this connection that reports: at most once, never after `close()`. */
  const finish = (reason: string): void => {
    if (gone) {
      return;
    }
    gone = true;
    discard();
    handlers.onClose(reason, connected);
  };

  /** A daemon line the client cannot read ends the connection; the reason is the report. */
  const unreadable = (reason: string): void => {
    finish(`daemon sent an unreadable frame: ${reason}`);
  };

  /** Hand `text` to the parser; whether reading may continue. */
  const take = (text: string): boolean => {
    if (gone) {
      return false; // a handler closed it mid-chunk: the rest is not ours to read
    }
    if (Buffer.byteLength(text, "utf8") > BRIDGE_LINE_MAX_BYTES) {
      unreadable(`a line over ${String(BRIDGE_LINE_MAX_BYTES)} bytes`);
      return false;
    }
    const read = parseFrame(DAEMON_FRAMES, text);
    if (!read.ok) {
      unreadable(read.refused.reason);
      return false;
    }
    handlers.onFrame(read.frame);
    return true;
  };

  socket.on("connect", () => {
    connected = true;
  });
  socket.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let end = pending.indexOf("\n");
    while (end >= 0) {
      const text = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!take(text)) {
        return;
      }
      end = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > BRIDGE_LINE_MAX_BYTES) {
      unreadable(`a line over ${String(BRIDGE_LINE_MAX_BYTES)} bytes`);
    }
  });
  socket.on("error", (error: Error) => {
    finish(error.message);
  });
  socket.on("close", () => {
    finish("connection closed");
  });

  // net buffers a write made before the connect completes, so the first line goes at once.
  socket.write(`${JSON.stringify(first)}\n`);

  return {
    send: (frame: BoundFrame): void => {
      if (!gone) {
        socket.write(`${JSON.stringify(frame)}\n`);
      }
    },
    close: (): void => {
      if (!gone) {
        gone = true;
        discard();
      }
    },
  };
}
