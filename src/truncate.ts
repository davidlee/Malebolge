// Truncation of text for the prompt and for tool output.

const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes, on a character boundary: a
 * multi-byte character that would straddle the cap is dropped whole.
 */
export const capUtf8 = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return { text, truncated: false };
  }
  // Back off to the start of the character the cap falls in, unless it falls between two.
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end] ?? 0)) {
    end--;
  }
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
};

export const GREP_MAX_LINE_LENGTH = 500;

/** A line cut to `maxChars` characters with pi's marker (pi core/tools/truncate.ts `truncateLine`). */
export const truncateLine = (
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } =>
  line.length <= maxChars
    ? { text: line, wasTruncated: false }
    : { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
