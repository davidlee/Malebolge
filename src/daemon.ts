// The daemon socket: every connection gets the conversation's event stream and
// may submit to it. The Harness and its storage stay with this one process.

import type { Socket } from "node:net";
import { type Conversation, watchEvents } from "@earendil-works/pi-durable";
import { context } from "./context.ts";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import { type ClientMessage, type ErrorMessage, parseClientMessage } from "./protocol.ts";
import type { Session } from "./session.ts";
import { serveUnix, type UnixServer } from "./unix-socket.ts";

export type Daemon = UnixServer;

const errorMessage = (error: unknown): ErrorMessage => ({
  type: "error",
  message: error instanceof Error ? error.message : String(error),
});

async function act(
  conversation: Conversation,
  message: ClientMessage,
  beforeInput: () => Promise<void>,
): Promise<void> {
  switch (message.type) {
    case "input":
      await beforeInput();
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

async function attach(
  session: Promise<Session>,
  socket: Socket,
  beforeInput: () => Promise<void>,
): Promise<void> {
  const { harness, root: conversation } = await session;
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
        .then(() => act(conversation, parseClientMessage(line), beforeInput))
        .catch((error: unknown) => {
          write(errorMessage(error));
        });
    }),
  );
}

/**
 * Serve `session` on a unix socket at `socketPath`: SocketInUse if a server
 * answers there, a stale socket replaced (serveUnix). Each connection waits for
 * the session; every input runs `beforeInput` first.
 */
export function serve(
  session: Promise<Session>,
  socketPath: string,
  beforeInput: () => Promise<void>,
): Promise<Daemon> {
  return serveUnix(socketPath, (socket) => {
    attach(session, socket, beforeInput).catch((error: unknown) => {
      socket.end(encodeLine(errorMessage(error)));
    });
  });
}
