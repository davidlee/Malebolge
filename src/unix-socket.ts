// Promise wrappers for unix socket connect and listen, and the generic half of
// a unix socket server: claiming the path, connection tracking, close.

import { rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";

/** Connect to `path`; rejects if nothing accepts there. */
export async function connectUnix(path: string): Promise<Socket> {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

export async function listenUnix(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

/** Another server answers at `path`. */
export class SocketInUse extends Error {
  constructor(path: string) {
    super(`a server already answers at ${path}`);
    this.name = "SocketInUse";
  }
}

const codeOf = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

/** What answers at `path`: a server, nothing (a stale socket), or no file; other errors propagate. */
async function probeUnix(path: string): Promise<"live" | "stale" | "gone"> {
  try {
    (await connectUnix(path)).destroy();
    return "live";
  } catch (error) {
    switch (codeOf(error)) {
      case "ECONNREFUSED":
        return "stale";
      case "ENOENT":
        return "gone";
      default:
        throw error;
    }
  }
}

/**
 * Listens at `path`; on EADDRINUSE, probes it (design §4.4). A live server
 * there is SocketInUse; only a stale socket is unlinked, and a path gone
 * meanwhile is listened on again.
 */
async function claimUnix(server: Server, path: string): Promise<void> {
  try {
    await listenUnix(server, path);
    return;
  } catch (error) {
    if (codeOf(error) !== "EADDRINUSE") {
      throw error;
    }
  }
  const found = await probeUnix(path);
  if (found === "live") {
    throw new SocketInUse(path);
  }
  if (found === "stale") {
    await rm(path, { force: true });
  }
  await listenUnix(server, path);
}

export interface UnixServer {
  /** Destroys every open connection and stops listening; idempotent. */
  close: () => Promise<void>;
}

/**
 * Claims `path` (claimUnix: SocketInUse if a server answers there, a stale
 * socket replaced) and hands each connection to `onConnection`. A connection
 * error destroys that connection.
 */
export async function serveUnix(
  path: string,
  onConnection: (socket: Socket) => void,
): Promise<UnixServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    onConnection(socket);
  });
  await claimUnix(server, path);
  let closing: Promise<void> | undefined;
  return {
    close: (): Promise<void> => {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resolve();
        });
      });
      return closing;
    },
  };
}
