// Promise wrappers for unix socket connect and listen, and the generic half of
// a unix socket server: connection tracking, stale-socket removal, close.

import { rmSync } from "node:fs";
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

export interface UnixServer {
  /** Destroys every open connection and stops listening; idempotent. */
  close: () => Promise<void>;
}

/**
 * Listens at `path`, replacing whatever file is there, and hands each
 * connection to `onConnection`. A connection error destroys that connection.
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
  rmSync(path, { force: true });
  await listenUnix(server, path);
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
