// Promise wrappers for unix socket connect and listen.

import { connect, type Server, type Socket } from "node:net";

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
