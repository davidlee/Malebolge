// Shared helpers for the bookmark tests: mozlz4 framing and a literal-only LZ4
// encoder, so a test (or a later phase) can build real mozlz4 buffers without a
// compressor. Nothing here knows how the decoder works; it only builds inputs.

/** Firefox's mozlz4 magic: "mozLz40" followed by a NUL. */
const MAGIC = Buffer.from("mozLz40\0", "latin1");

/** `declared` as the header's 4-byte little-endian field. */
function declaredSize(declared: number): Buffer {
  const field = Buffer.alloc(4);
  field.writeUInt32LE(declared, 0);
  return field;
}

/**
 * The LZ4 length-extension bytes for a length of 15 or more: the excess over 15
 * in 255-byte steps, ending with the last step's remainder (so 15 gives [0x00],
 * 270 gives [0xFF, 0x00], 300 gives [0xFF, 0x1E]). Shorter lengths add none.
 */
function extensionBytes(length: number): number[] {
  if (length < 15) {
    return [];
  }
  const bytes: number[] = [];
  let rest = length - 15;
  while (rest >= 255) {
    bytes.push(255);
    rest -= 255;
  }
  bytes.push(rest);
  return bytes;
}

/**
 * `data` as mozlz4: magic, its byte length as the declared size, then one
 * sequence of literals only. Empty data is the header plus the token 0x00.
 */
export function encodeMozLz4(data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const token = Buffer.from([Math.min(bytes.length, 15) << 4, ...extensionBytes(bytes.length)]);
  return Buffer.concat([MAGIC, declaredSize(bytes.length), token, bytes]);
}

/** Magic, `declared` as the size, then `block` bytes verbatim: a hand-built vector. */
export function mozlz4Frame(declared: number, block: readonly number[] | Buffer): Buffer {
  const blockBytes = Buffer.isBuffer(block) ? block : Buffer.from(block);
  return Buffer.concat([MAGIC, declaredSize(declared), blockBytes]);
}
