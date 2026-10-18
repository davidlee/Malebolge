// The daemon socket: every connection gets the conversation's event stream and
// may submit to it. The Harness and its storage stay with this one process.

import { rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { type Conversation, type Harness, watchEvents } from "@earendil-works/pi-durable";
import { context } from "./context.ts";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import { type ClientMessage, type ErrorMessage, parseClientMessage } from "./protocol.ts";
import { listenUnix } from "./unix-socket.ts";

export interface Daemon {
  close: () => Promise<void>;
}

const errorMessage = (error: unknown): ErrorMessage => ({
  type: "error",
  message: error instanceof Error ? error.message : String(error),
});

async function act(conversation: Conversation, message: ClientMessage): Promise<void> {
  switch (message.type) {
    case "input":
      await conversation.submit(message, context);
      return;
    case "abort":
      await conversation.abort(context);
      return;
    case "compact":
      await conversation.compact(message.instructions, context);
      return;
  }
}

async function attach(harness: Harness, conversation: Conversation, socket: Socket): Promise<void> {
  const write = (value: unknown): void => {
    if (socket.writable) {
      socket.write(encodeLine(value));
    }
  };
  const stream = await watchEvents(harness, conversation.id, context);
  write(stream.snapshot);
  stream.start((events) => {
    for (const event of events) {
      write(event);
    }
    return Promise.resolve();
  });
  socket.on("close", () => void stream.stop());
  socket.on(
    "data",
    lineSplitter((line) => {
      Promise.resolve()
        .then(() => act(conversation, parseClientMessage(line)))
        .catch((error: unknown) => {
          write(errorMessage(error));
        });
    }),
  );
}

/** Serve `conversation` on a unix socket at `socketPath`, replacing a stale one. */
export async function serve(
  harness: Harness,
  conversation: Conversation,
  socketPath: string,
): Promise<Daemon> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    attach(harness, conversation, socket).catch((error: unknown) => {
      socket.end(encodeLine(errorMessage(error)));
    });
  });
  rmSync(socketPath, { force: true });
  await listenUnix(server, socketPath);
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
