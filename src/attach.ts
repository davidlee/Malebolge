// A line-oriented client of the daemon: typed lines become messages, events
// become text. Used directly in a terminal and under Emacs comint.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import type { ClientMessage } from "./protocol.ts";
import { createRenderer, toPrintable } from "./render.ts";
import { type ConnectWait, codeOf, connectUnixWaiting } from "./unix-socket.ts";

/** What a typed line asks for; `undefined` for a blank line. */
export function commandOf(typed: string): ClientMessage | "quit" | undefined {
  const text = typed.trim();
  if (text === "") {
    return undefined;
  }
  if (text === "/quit") {
    return "quit";
  }
  if (text === "/abort") {
    return { type: "abort" };
  }
  if (text === "/compact") {
    return { type: "compact" };
  }
  if (text.startsWith("/compact ")) {
    return { type: "compact", instructions: text.slice("/compact ".length).trim() };
  }
  return { type: "input", content: typed };
}

/**
 * Attach until `input` ends, `/quit`, or the daemon closes the connection.
 * Waits for the daemon to start listening (design §4.2), for `wait`'s bound;
 * if none answers, says so on `output` and rejects with the connect error.
 */
export async function attach(
  socketPath: string,
  input: Readable,
  output: Writable,
  wait: ConnectWait = { intervalMs: 200, timeoutMs: 10_000 },
): Promise<void> {
  const socket = await connectUnixWaiting(socketPath, wait).catch((error: unknown) => {
    const cause = String(codeOf(error) ?? error);
    output.write(`[cannot connect to ${socketPath}: ${cause}]\n`);
    throw error;
  });
  output.write("[attached]\n");
  // A reset after connecting ends the session like a close does.
  socket.on("error", () => socket.destroy());
  const render = createRenderer();
  socket.on(
    "data",
    lineSplitter((line) => output.write(render(toPrintable(JSON.parse(line))))),
  );
  const lines = createInterface({ input, terminal: false });
  lines.on("line", (typed) => {
    const command = commandOf(typed);
    if (command === "quit") {
      socket.end();
    } else if (command !== undefined) {
      socket.write(encodeLine(command));
    }
  });
  lines.on("close", () => socket.end());
  await new Promise<void>((resolve) => socket.on("close", resolve));
  lines.close();
  output.write("[detached]\n");
}
