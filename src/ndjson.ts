// Newline-delimited JSON framing, shared by every socket in this package: the
// MCP transport, the daemon, and its clients.

import { StringDecoder } from "node:string_decoder";

/** A chunk sink that calls `onLine` once per complete, non-blank line. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (chunk) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line.trim() !== "") {
        onLine(line);
      }
      newline = pending.indexOf("\n");
    }
  };
}

export const encodeLine = (value: unknown): string => `${JSON.stringify(value)}\n`;
