// Firefox's mozlz4 format (SL-008 design sec-2 "Decoding"): the 8-byte magic
// "mozLz40\0", the u32 little-endian size, then one raw LZ4 block. Every byte is
// untrusted: each read and copy is bounds-checked, refusals carry fixed text.

const MAGIC = "mozLz40\u0000"; // 8 bytes, compared as latin1 so none escapes
const MSG_HEADER = "mozlz4: bad header";
const MSG_TOO_LARGE = "mozlz4: declared size over the cap";
const MSG_TRUNCATED = "mozlz4: truncated block";
const MSG_CORRUPT = "mozlz4: corrupt block";

/** Why a mozlz4 buffer was refused. */
export type MozLz4ErrorKind = "corrupt" | "too_large";

/** A refused mozlz4 buffer: a kind and fixed text, never the input's content. */
export class MozLz4Error extends Error {
  readonly kind: MozLz4ErrorKind;
  constructor(kind: MozLz4ErrorKind, message: string) {
    super(message);
    this.name = "MozLz4Error";
    this.kind = kind;
  }
}

/** The bytes `buf` decodes to; refuses a declared size over `maxBytes`. */
export function decodeMozLz4(buf: Buffer, maxBytes: number): Buffer {
  const refuse = (refused: boolean, kind: MozLz4ErrorKind, message: string): void => {
    if (refused) {
      throw new MozLz4Error(kind, message);
    }
  };
  refuse(buf.length < MAGIC.length + 4, "corrupt", MSG_HEADER);
  refuse(buf.toString("latin1", 0, MAGIC.length) !== MAGIC, "corrupt", MSG_HEADER);
  const declared = buf.readUInt32LE(MAGIC.length);
  refuse(declared > maxBytes, "too_large", MSG_TOO_LARGE); // before any allocation
  const out = Buffer.alloc(declared);
  let pos = MAGIC.length + 4;
  let written = 0;
  // A nibble of 15 adds the extension bytes that follow, while each reads 255.
  const length = (nibble: number): number => {
    let total = nibble;
    let byte = 255;
    while (nibble === 15 && byte === 255) {
      refuse(pos >= buf.length, "corrupt", MSG_TRUNCATED);
      byte = buf.readUInt8(pos);
      pos += 1;
      total += byte;
    }
    return total;
  };
  const literals = (nibble: number): void => {
    const count = length(nibble);
    refuse(pos + count > buf.length, "corrupt", MSG_TRUNCATED);
    refuse(written + count > declared, "corrupt", MSG_CORRUPT);
    buf.copy(out, written, pos, pos + count);
    pos += count;
    written += count;
  };
  const match = (nibble: number): void => {
    refuse(pos + 2 > buf.length, "corrupt", MSG_TRUNCATED); // offset truncated
    const offset = buf.readUInt16LE(pos);
    pos += 2;
    const count = length(nibble) + 4;
    refuse(offset === 0 || offset > written, "corrupt", MSG_CORRUPT);
    refuse(written + count > declared, "corrupt", MSG_CORRUPT);
    for (let copy = 0; copy < count; copy += 1) {
      out.writeUInt8(out.readUInt8(written - offset), written); // overlap repeats
      written += 1;
    }
  };
  while (pos < buf.length) {
    const token = buf.readUInt8(pos);
    pos += 1;
    literals(token >> 4);
    if (pos < buf.length) {
      match(token & 0xf); // a block may end right after its literals
    }
  }
  refuse(written !== declared, "corrupt", MSG_CORRUPT);
  return out;
}
