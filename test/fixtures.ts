// Shared test fixtures: temp socket paths and a minimal MCP server over a unix
// socket, speaking the same NDJSON framing as satan-mcp.

import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, lineSplitter } from "../src/ndjson.ts";
import { connectUnix, listenUnix } from "../src/unix-socket.ts";

export type FakeTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  call: (args: Record<string, unknown>) => { text: string; isError?: boolean };
};

export type Fixture = { socketPath: string; close: () => Promise<void> };

/** A fresh directory for sockets; removed by the returned `cleanup`. */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pandaemonium-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export type LineClient = {
  send: (value: unknown) => void;
  /** Resolves with the first message, received or still to come, that matches. */
  next: <T = Record<string, unknown>>(match: (message: T) => boolean) => Promise<T>;
  received: () => readonly Record<string, unknown>[];
  close: () => void;
};

/** An NDJSON client of the daemon socket that records everything received. */
export async function lineClient(socketPath: string): Promise<LineClient> {
  const socket = await connectUnix(socketPath);
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  socket.on(
    "data",
    lineSplitter((line) => {
      messages.push(JSON.parse(line));
      for (const wake of waiters) wake();
    }),
  );
  const next = <T>(match: (message: T) => boolean) =>
    new Promise<T>((resolve) => {
      const check = () => {
        const found = (messages as T[]).find(match);
        if (found === undefined) return;
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
    });
  return {
    send: (value) => socket.write(encodeLine(value)),
    next,
    received: () => messages,
    close: () => socket.destroy(),
  };
}

type Request = { id?: number | string; method: string; params?: Record<string, unknown> };

function answer(tools: readonly FakeTool[], request: Request): unknown {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion,
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
    case "tools/call": {
      const tool = tools.find((t) => t.name === request.params?.name);
      if (!tool) return { content: [{ type: "text", text: "no such tool" }], isError: true };
      const { text, isError } = tool.call(
        (request.params?.arguments as Record<string, unknown>) ?? {},
      );
      return { content: [{ type: "text", text }], isError: isError ?? false };
    }
    default:
      return {};
  }
}

/** An MCP server on `socketPath` exposing `tools`; ignores notifications. */
export async function fakeMcpServer(
  socketPath: string,
  tools: readonly FakeTool[],
): Promise<Fixture> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on(
      "data",
      lineSplitter((line) => {
        const request = JSON.parse(line) as Request;
        if (request.id === undefined) return;
        socket.write(
          encodeLine({ jsonrpc: "2.0", id: request.id, result: answer(tools, request) }),
        );
      }),
    );
  });
  await listenUnix(server, socketPath);
  return { socketPath, close: () => closeServer(server, sockets) };
}
