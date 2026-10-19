// Newline-delimited JSON framing, shared by every socket in this package: the
// MCP transport, the daemon, and its clients.

import { StringDecoder } from "node:string_decoder";

export interface BoundedLineSplitterOptions {
  /** The most UTF-8 bytes one line may hold, newline excluded. */
  maxBytes: number;
  /** Each complete, non-blank line within the cap, trailing CR stripped. */
  onLine: (line: string) => void;
  /** Once per line over the cap: that line is dropped up to its newline. */
  onOversize?: () => void;
}

export interface BoundedLineSplitter {
  push: (chunk: Buffer | string) => void;
  /** UTF-8 bytes held for the line not yet terminated: never more than `maxBytes`. */
  carriedBytes: () => number;
}

/**
 * A chunk sink that splits lines while holding at most `maxBytes` of an
 * unterminated line. A line past the cap is dropped as it streams: its carry
 * is released and input is discarded up to its newline, so a line of any
 * length costs at most the cap plus the chunk in hand.
 */
export function boundedLineSplitter(options: BoundedLineSplitterOptions): BoundedLineSplitter {
  const { maxBytes, onLine, onOversize } = options;
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let carryBytes = 0;
  let discarding = false;
  const release = (): void => {
    carry = "";
    carryBytes = 0;
  };
  const endLine = (segment: string): void => {
    if (discarding) {
      discarding = false;
    } else if (carryBytes + Buffer.byteLength(segment, "utf8") > maxBytes) {
      onOversize?.();
    } else {
      const line = (carry + segment).replace(/\r$/, "");
      if (line.trim() !== "") {
        onLine(line);
      }
    }
    release();
  };
  const hold = (tail: string): void => {
    const tailBytes = Buffer.byteLength(tail, "utf8");
    if (carryBytes + tailBytes <= maxBytes) {
      carry += tail;
      carryBytes += tailBytes;
      return;
    }
    onOversize?.();
    discarding = true;
    release();
  };
  return {
    push: (chunk): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      let start = 0;
      for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n", start)) {
        endLine(text.slice(start, newline));
        start = newline + 1;
      }
      // In discard mode the tail is dropped unseen: nothing of an oversize line is held.
      if (!discarding && start < text.length) {
        hold(text.slice(start));
      }
    },
    carriedBytes: () => carryBytes,
  };
}

/** A chunk sink that calls `onLine` once per complete, non-blank line: unbounded, for the package's sockets. */
export const lineSplitter = (onLine: (line: string) => void): ((chunk: Buffer | string) => void) =>
  boundedLineSplitter({ maxBytes: Infinity, onLine }).push;

export const encodeLine = (value: unknown): string => `${JSON.stringify(value)}\n`;
