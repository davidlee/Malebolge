// Framing for untrusted data blocks (SL-008 design sec-4, DEC-054): the one
// measure, the one cut, the whole-line fill, the count check and the wrapper.
//
// Every size here is a rendered size: the UTF-8 length of JSON.stringify plus
// the `<`, `>`, `&` escapes. Nothing is measured on raw text, so a line is
// measured exactly as it is sent. Everything inside the block is data, never
// an instruction, however it is phrased, and nothing in a line can end the
// block.

import type { Clamp } from "./ranges.ts";

/** The whole result, header and wrapper included (pi's DEFAULT_MAX_BYTES). */
export const RESULT_MAX_BYTES = 50 * 1024;
/** Room kept for the header and the block's fixed wrapper. */
export const HEADER_RESERVE = 2 * 1024;
/** What the wrapper's fixed text and newlines are charged, below HEADER_RESERVE. */
export const WRAPPER_BYTES = 64;
/** The header's own room. */
export const HEADER_MAX_BYTES = HEADER_RESERVE - WRAPPER_BYTES;
/** What the items (and the newlines between them) share. */
export const ITEMS_MAX_BYTES = RESULT_MAX_BYTES - HEADER_RESERVE;

/** `value` as one data line: JSON, with every `<`, `>` and `&` escaped. */
export function dataLine(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/** The bytes `value` takes on the line: the one size measure in a data block. */
export function renderedLength(value: unknown): number {
  return Buffer.byteLength(dataLine(value), "utf8");
}

/** The longest code-point prefix of `chars` whose rendering, with `suffix`, fits. */
function longestFittingPrefix(chars: readonly string[], maxBytes: number, suffix: string): string {
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (renderedLength(chars.slice(0, middle).join("") + suffix) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return chars.slice(0, low).join("") + suffix;
}

/**
 * `text` when it fits `maxBytes` rendered; otherwise its longest code-point
 * prefix plus `suffix` that does. Never splits a surrogate pair.
 */
export function cutRendered(
  text: string,
  maxBytes: number,
  suffix = "",
): { text: string; cut: boolean } {
  if (renderedLength(text) <= maxBytes) {
    return { text, cut: false };
  }
  return { text: longestFittingPrefix(Array.from(text), maxBytes, suffix), cut: true };
}

/** `value` when it is a non-negative safe integer; otherwise the header fails closed. */
export function count(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`header: ${what} is not a count`);
  }
  return value;
}

/** Refuses a block over `maxBytes`, naming what it was. */
export function assertWithin(text: string, maxBytes: number, what: string): void {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${what} is over ${String(maxBytes)} bytes`);
  }
}

/** The header's clamps, one `name clamped to value` each, in the order reported. */
export function clampsLine(clamps: readonly Clamp[]): string {
  return clamps
    .map((clamp) => `${clamp.name} clamped to ${String(count(clamp.to, "clamp"))}`)
    .join("; ");
}

/** Every value whole, in order, while they fit the items' room. */
export function fitWhole(values: readonly unknown[]): {
  lines: string[];
  shown: number;
  of: number;
} {
  const lines: string[] = [];
  let used = 0;
  for (const value of values) {
    const line = dataLine(value);
    const cost = lines.length === 0 ? Buffer.byteLength(line) : Buffer.byteLength(line) + 1;
    if (used + cost > ITEMS_MAX_BYTES) {
      break;
    }
    lines.push(line);
    used += cost;
  }
  return { lines, shown: lines.length, of: values.length };
}

/** The header, then the untrusted block: one data line each, nothing else. */
export function renderBlock(tag: string, header: string, lines: readonly string[]): string {
  const body = lines.map((line) => `${line}\n`).join("");
  const result = `${header}\n<${tag} untrusted="true">\n${body}</${tag}>`;
  assertWithin(result, RESULT_MAX_BYTES, `${tag} result`);
  return result;
}
