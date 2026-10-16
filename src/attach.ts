// A line-oriented client of the daemon: typed lines become messages, events
// become text. Used directly in a terminal and under Emacs comint.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { encodeLine, lineSplitter } from "./ndjson.ts";
import type { ClientMessage } from "./protocol.ts";
import { createRenderer, type Printable } from "./render.ts";
import { connectUnix } from "./unix-socket.ts";

/** What a typed line asks for; `undefined` for a blank line. */
export function commandOf(typed: string): ClientMessage | "quit" | undefined {
  const text = typed.trim();
  if (!text) return undefined;
  if (text === "/quit") return "quit";
  if (text === "/abort") return { type: "abort" };
  if (text === "/compact") return { type: "compact" };
  if (text.startsWith("/compact ")) {
    return { type: "compact", instructions: text.slice("/compact ".length).trim() };
  }
  return { type: "input", content: typed };
}

/** Attach until `input` ends, `/quit`, or the daemon closes the connection. */
export async function attach(socketPath: string, input: Readable, output: Writable): Promise<void> {
  const socket = await connectUnix(socketPath);
  output.write("[attached]\n");
  // A reset after connecting ends the session like a close does.
  socket.on("error", () => socket.destroy());
  const render = createRenderer();
  socket.on(
    "data",
    lineSplitter((line) => output.write(render(JSON.parse(line) as Printable))),
  );
  const lines = createInterface({ input, terminal: false });
  lines.on("line", (typed) => {
    const command = commandOf(typed);
    if (command === "quit") socket.end();
    else if (command) socket.write(encodeLine(command));
  });
  lines.on("close", () => socket.end());
  await new Promise<void>((resolve) => socket.on("close", resolve));
  lines.close();
  output.write("[detached]\n");
}
