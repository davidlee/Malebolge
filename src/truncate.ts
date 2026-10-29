// Truncation of text for the prompt and for tool output.

import { capUtf8 } from "../pi-bridge/wire.ts";

// `capUtf8` lives in the bridge wire, which the daemon shares with pi; it is
// re-exported here so every daemon caller is unchanged (SL-009 design sec-4).
export { capUtf8 };

/** The head of a stream of text, up to a byte cap. */
export interface HeadKeeper {
  /** Keep what fits of `text`; whether the head is still open. */
  accept: (text: string) => boolean;
  /** What was kept. */
  readonly text: string;
  /** UTF-8 bytes kept: never more than the cap. */
  readonly bytes: number;
  /** A chunk passed the cap: it was cut and everything after is dropped. */
  readonly full: boolean;
}

/**
 * A stream's head up to `maxBytes`, kept as it arrives: the chunk that passes
 * the cap is cut on a character boundary (`capUtf8`) and later chunks are
 * dropped unseen.
 */
export function headKeeper(maxBytes: number): HeadKeeper {
  let text = "";
  let bytes = 0;
  let full = false;
  return {
    accept: (chunk): boolean => {
      if (full) {
        return false;
      }
      const size = Buffer.byteLength(chunk, "utf8");
      if (bytes + size <= maxBytes) {
        text += chunk;
        bytes += size;
        return true;
      }
      const head = capUtf8(chunk, maxBytes - bytes).text;
      text += head;
      bytes += Buffer.byteLength(head, "utf8");
      full = true;
      return false;
    },
    get text(): string {
      return text;
    },
    get bytes(): number {
      return bytes;
    },
    get full(): boolean {
      return full;
    },
  };
}

export const GREP_MAX_LINE_LENGTH = 500;

/** A line cut to `maxChars` characters with pi's marker (pi core/tools/truncate.ts `truncateLine`). */
export const truncateLine = (
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } =>
  line.length <= maxChars
    ? { text: line, wasTruncated: false }
    : { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
