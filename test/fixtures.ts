// Shared test fixtures: temp socket paths and a minimal MCP server over a unix
// socket, speaking the same NDJSON framing as satan-mcp.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, type JsonRecord } from "../src/json.ts";
import { encodeLine, lineSplitter } from "../src/ndjson.ts";
import { connectUnix, listenUnix } from "../src/unix-socket.ts";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: JsonRecord;
  call: (args: JsonRecord) => { text: string; isError?: boolean };
}

export interface Fixture {
  socketPath: string;
  close: () => Promise<void>;
  /** Answer every withheld request and stop withholding: a later request is answered at once. */
  release: () => Promise<void>;
  /** Connections accepted so far: a second one means the client opened a fresh connection. */
  connections: () => number;
  /** Resolves when the first accepted connection ends: a client hung up. */
  ended: Promise<void>;
  /** Methods of the requests received so far, and a wait for one that matches. */
  requests: Recorder<string>;
  /** Answer later requests with `tools` in place of the ones the server was made with. */
  serve: (tools: readonly FakeTool[]) => void;
}

export interface FakeServerOptions {
  /** Methods whose answer is withheld until `release` (a stalled connect, a hung list). */
  silent?: readonly string[];
}

/** A fresh directory for sockets; removed by the returned `cleanup`. */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "malebolge-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A child node process, killed by `kill` (SIGKILL: no handler runs); idempotent. */
export interface Child {
  kill: () => Promise<void>;
}

/**
 * Runs ES module `source` in a child node process and resolves once it prints
 * a line; its imports are absolute. For holders that must die without cleanup.
 */
export async function childProcess(source: string): Promise<Child> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit");
  await Promise.race([
    once(child.stdout, "data"),
    exited.then(() => {
      throw new Error("child exited before it was ready");
    }),
  ]);
  return {
    kill: async (): Promise<void> => {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

/** `file` (relative to test/) as an import specifier a child process can use. */
export const sourceUrl = (file: string): string =>
  JSON.stringify(new URL(file, import.meta.url).href);

export async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
}

export interface LineClient<T> {
  send: (value: unknown) => void;
  /** Resolves with the first message, received or still to come, that matches. */
  next: Recorder<T>["next"];
  received: () => readonly T[];
  close: () => void;
}

export interface Recorder<T> {
  items: readonly T[];
  push: (item: T) => void;
  /** Resolves with the first item, received or still to come, that matches. */
  next: {
    <U extends T>(match: (item: T) => item is U): Promise<U>;
    (match: (item: T) => boolean): Promise<T>;
  };
}

/** Items in arrival order, and a wait for the first that matches, received or still to come. */
export function recorder<T>(): Recorder<T> {
  const items: T[] = [];
  const waiters = new Set<() => void>();
  const push = (item: T): void => {
    items.push(item);
    for (const wake of waiters) {
      wake();
    }
  };
  function next<U extends T>(match: (item: T) => item is U): Promise<U>;
  function next(match: (item: T) => boolean): Promise<T>;
  function next(match: (item: T) => boolean): Promise<T> {
    return new Promise<T>((resolve) => {
      const check = (): void => {
        const found = items.find(match);
        if (found === undefined) {
          return;
        }
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
    });
  }
  return { items, push, next };
}

/**
 * An NDJSON client of the daemon socket that records everything received,
 * each line parsed and then checked by `decode`.
 */
export async function lineClient<T>(
  socketPath: string,
  decode: (value: unknown) => T,
): Promise<LineClient<T>> {
  const socket = await connectUnix(socketPath);
  const messages = recorder<T>();
  socket.on(
    "data",
    lineSplitter((line) => {
      messages.push(decode(JSON.parse(line)));
    }),
  );
  return {
    send: (value): void => {
      socket.write(encodeLine(value));
    },
    next: messages.next,
    received: () => messages.items,
    close: (): void => {
      socket.destroy();
    },
  };
}

interface Request {
  id: number | string;
  method: string;
  params: JsonRecord;
}

/** A JSON-RPC request; `undefined` for a notification, which has no id. */
function requestOf(line: string): Request | undefined {
  const message: unknown = JSON.parse(line);
  if (!isRecord(message)) {
    throw new Error(`not a JSON-RPC message: ${line}`);
  }
  const { id, method, params } = message;
  if (typeof id !== "number" && typeof id !== "string") {
    return undefined;
  }
  if (typeof method !== "string") {
    throw new Error(`no method: ${line}`);
  }
  return { id, method, params: isRecord(params) ? params : {} };
}

const textResult = (text: string, isError: boolean): JsonRecord => ({
  content: [{ type: "text", text }],
  isError,
});

function callResult(tools: readonly FakeTool[], params: JsonRecord): JsonRecord {
  const tool = tools.find((t) => t.name === params["name"]);
  if (tool === undefined) {
    return textResult("no such tool", true);
  }
  const args = params["arguments"];
  const { text, isError } = tool.call(isRecord(args) ? args : {});
  return textResult(text, isError ?? false);
}

function answer(tools: readonly FakeTool[], request: Request): JsonRecord {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params["protocolVersion"],
        capabilities: { tools: {} },
        serverInfo: { name: "fake-satan", version: "0" },
      };
    case "tools/list":
      return {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema: inputSchema ?? { type: "object", properties: {} },
        })),
      };
    case "tools/call":
      return callResult(tools, request.params);
    default:
      return {};
  }
}

/** Resolves once `socket` has handed `line` on, or could not write it at all. */
function writeLine(socket: Socket, line: string): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.write(line, () => {
      resolve();
    });
  });
}

/** An MCP server on `socketPath` exposing `tools`; ignores notifications. */
export async function fakeMcpServer(
  socketPath: string,
  tools: readonly FakeTool[],
  options: FakeServerOptions = {},
): Promise<Fixture> {
  const silent = new Set(options.silent ?? []);
  const withheld: (() => Promise<void>)[] = [];
  const requests = recorder<string>();
  const sockets = new Set<Socket>();
  let served = tools;
  let connections = 0;
  /** Resolves when the first accepted connection ends. */
  let hungUp = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    hungUp = resolve;
  });
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      hungUp();
    });
    // A client that gave up before the answer arrived closes its end; that is not our failure.
    socket.on("error", () => undefined);
    socket.on(
      "data",
      lineSplitter((line) => {
        const request = requestOf(line);
        if (request === undefined) {
          return;
        }
        requests.push(request.method);
        // Answered as of the request, so a withheld answer is the one the server had then.
        const result = answer(served, request);
        const send = (): Promise<void> =>
          writeLine(socket, encodeLine({ jsonrpc: "2.0", id: request.id, result }));
        if (silent.has(request.method)) {
          withheld.push(send);
        } else {
          void send();
        }
      }),
    );
  });
  await listenUnix(server, socketPath);
  return {
    socketPath,
    close: () => closeServer(server, sockets),
    release: async (): Promise<void> => {
      silent.clear();
      await Promise.all(withheld.splice(0).map((send) => send()));
    },
    connections: () => connections,
    ended,
    requests,
    serve: (next): void => {
      served = next;
    },
  };
}
