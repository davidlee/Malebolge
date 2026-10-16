// MCP transport over a unix socket with NDJSON framing: how satan-mcp serves.
// pi-mcp ships stdio and HTTP transports only.

import type { Socket } from "node:net";
import {
  type JsonRpcMessage,
  McpConnectionClosedError,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  parseJsonRpcMessage,
} from "@earendil-works/pi-mcp";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import { connectUnix } from "./unix-socket.ts";

/** Subscribe `listener` to `set`; the returned function unsubscribes. */
const subscribe = <T>(set: Set<T>, listener: T) => {
  set.add(listener);
  return () => void set.delete(listener);
};

export class UnixSocketTransport implements McpTransport {
  readonly #path: string;
  #socket: Socket | undefined;
  #closed = false;
  readonly #messages = new Set<McpTransportMessageListener>();
  readonly #errors = new Set<McpTransportErrorListener>();
  readonly #closes = new Set<McpTransportCloseListener>();

  constructor(path: string) {
    this.#path = path;
  }

  async start(): Promise<void> {
    const socket = await connectUnix(this.#path);
    this.#socket = socket;
    socket.on(
      "data",
      lineSplitter((line) => this.#receive(line)),
    );
    socket.on("error", (error) => this.#emitError(error));
    socket.on("close", () => this.#markClosed());
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const socket = this.#socket;
    if (this.#closed || !socket?.writable) throw new McpConnectionClosedError();
    await new Promise<void>((resolve, reject) => {
      socket.write(encodeLine(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.#socket?.end();
    this.#markClosed();
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    return subscribe(this.#messages, listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    return subscribe(this.#errors, listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    return subscribe(this.#closes, listener);
  }

  #receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(JSON.parse(line));
    } catch (error) {
      this.#emitError(error);
      return;
    }
    for (const listener of this.#messages) listener(message);
  }

  #emitError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    for (const listener of this.#errors) listener(normalized);
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closes) listener();
  }
}
