// SL-009 PHASE-09: a fake bridge daemon on a private unix socket. It records
// the lines each client sends (parsed JSON) and lets a test answer with the
// real daemon frames (wire.ts), stay silent, or hang up. There are no timers
// inside: tests drive deadlines with vitest's fake ones.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import type { DaemonFrame } from "../pi-bridge/wire.ts";

/** One accepted client connection, as a test sees it. */
export interface FakeConn {
  /** Every line received so far, each parsed from JSON. */
  lines: () => readonly unknown[];
  /** The first line not yet taken, or the next one to arrive. */
  nextLine: () => Promise<unknown>;
  /** Write one daemon frame as a line. */
  reply: (frame: DaemonFrame) => void;
  /** Hang up on the client. */
  end: () => void;
  /** Resolves when the socket closed, whichever side closed it. */
  closed: Promise<void>;
}

/** A unix-socket server the bridge can talk to in place of SATAN. */
export interface FakeDaemon {
  /** The socket path clients connect to. */
  path: string;
  /** The first connection not yet taken, or the next one to arrive. */
  nextConnection: () => Promise<FakeConn>;
  /** Every accepted connection so far, in arrival order. */
  connections: () => readonly FakeConn[];
  /** Destroy what is open, close the server, remove the socket's directory. */
  close: () => Promise<void>;
}

/** Items in arrival order, and a wait for the first not yet taken. */
interface Lineup<T> {
  readonly seen: () => readonly T[];
  readonly add: (item: T) => void;
  readonly take: () => Promise<T>;
}

/** Items in arrival order: `take` yields the first not yet taken, or waits for the next. */
function lineup<T>(): Lineup<T> {
  const seen: T[] = [];
  const untaken: T[] = [];
  const waiting: ((item: T) => void)[] = [];
  return {
    seen: (): readonly T[] => seen,
    add: (item: T): void => {
      seen.push(item);
      const wake = waiting.shift();
      if (wake === undefined) {
        untaken.push(item);
        return;
      }
      wake(item);
    },
    take: (): Promise<T> => {
      const item = untaken.shift();
      return item === undefined
        ? new Promise<T>((resolve) => {
            waiting.push(resolve);
          })
        : Promise.resolve(item);
    },
  };
}

/** `line` as JSON: what a client sent. */
function parsed(line: string): unknown {
  const value: unknown = JSON.parse(line);
  return value;
}

/** The socket's close, armed before it can happen. */
function closeOf(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    socket.once("close", () => {
      resolve();
    });
  });
}

/** One connection as the test sees it: its lines, and the two ways to answer. */
function connOf(socket: Socket, lines: Lineup<unknown>): FakeConn {
  return {
    lines: lines.seen,
    nextLine: lines.take,
    reply: (frame: DaemonFrame): void => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(frame)}\n`);
      }
    },
    end: (): void => {
      socket.destroy();
    },
    closed: closeOf(socket),
  };
}

/** Listen on a fresh socket path, and take the daemon down when the test ends. */
export async function fakeDaemon(): Promise<FakeDaemon> {
  const dir = await mkdtemp(join(tmpdir(), "malebolge-bridge-"));
  return fakeDaemonAt(join(dir, "bridge.sock"));
}

/**
 * Listen on `path`, and take the daemon down when the test ends. A test that
 * needs connects to fail for a while (`ECONNREFUSED`, nothing listening) then
 * succeed uses this to open the socket mid-test.
 */
export async function fakeDaemonAt(path: string): Promise<FakeDaemon> {
  const dir = dirname(path);
  const connections = lineup<FakeConn>();
  const sockets: Socket[] = [];

  const server = createServer((socket: Socket) => {
    sockets.push(socket);
    // A client that hangs up mid-write is what the tests are about, not an error.
    socket.on("error", (): void => {
      // Swallowed: the close is the signal.
    });
    socket.setEncoding("utf8");
    const lines = lineup<unknown>();
    let pending = "";
    socket.on("data", (chunk: string) => {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        if (part !== "") {
          lines.add(parsed(part));
        }
      }
    });
    connections.add(connOf(socket, lines));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: Error) => {
      reject(error);
    });
    server.listen(path, () => {
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await rm(dir, { recursive: true, force: true });
    })();
    return closing;
  };
  onTestFinished(close);

  return {
    path,
    nextConnection: connections.take,
    connections: connections.seen,
    close,
  };
}
