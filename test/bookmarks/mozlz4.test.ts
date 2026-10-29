// VT-1: the real scratchpad.jsonlz4 backup decodes to the independent
// decoder's stored bytes and parses as a places container.
// VT-2: every refusal — corrupt magic, truncation, offset, overrun, size
// mismatch, truncated length extension — and too_large over the cap.
// VT-3: LZ4 block boundary vectors — overlapping matches, literal and match
// length extensions at 15 and 255, a final literals-only sequence.
// VT-4: the literal-only encoder round-trips through the decoder.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decodeMozLz4, MozLz4Error, type MozLz4ErrorKind } from "../../src/bookmarks/mozlz4.ts";
import { encodeMozLz4, mozlz4Frame } from "./bookmark-fixtures.ts";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const MAX_BYTES = 64 * 1024 * 1024;

/** A fixture under `test/bookmarks/fixtures/`, as bytes. */
function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

/** `buf` through the decoder, at the cap every other test shares unless it says otherwise. */
function decode(buf: Buffer, maxBytes = MAX_BYTES): Buffer {
  return decodeMozLz4(buf, maxBytes);
}

/** The error a refused buffer raises; any other throw is rethrown as the failure. */
function refusal(run: () => unknown): MozLz4Error {
  try {
    run();
  } catch (error) {
    if (error instanceof MozLz4Error) {
      return error;
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("refused with something that is not an Error");
  }
  throw new Error("expected a refusal, but the buffer decoded");
}

/** Asserts a refusal of `kind`: the error's class first, then its kind. */
function expectRefusal(run: () => unknown, kind: MozLz4ErrorKind): void {
  expect(run).toThrow(MozLz4Error);
  expect(refusal(run).kind).toBe(kind);
}

/** The `type` a parsed places document names, if it is an object with one. */
function placesType(doc: unknown): unknown {
  if (typeof doc !== "object" || doc === null) {
    return undefined;
  }
  return "type" in doc ? doc.type : undefined;
}

/** A deterministic ASCII string of exactly `length` bytes, for the length vectors. */
function repeatTo(length: number): string {
  return "abcdefghij".repeat(Math.ceil(length / 10)).slice(0, length);
}

// ------------------------------------------------------------------------- VT-1

describe("decodeMozLz4: the scratchpad.jsonlz4 backup", () => {
  it("decodes the scratchpad.jsonlz4 to the independent decoder's bytes", () => {
    const compressed = fixture("scratchpad.jsonlz4");
    const expected = fixture("scratchpad.json");
    expect(decode(compressed).equals(expected)).toBe(true);
  });

  it("decodes the scratchpad.jsonlz4 to JSON that parses as a places container", () => {
    const text = decode(fixture("scratchpad.jsonlz4")).toString("utf8");
    const doc: unknown = JSON.parse(text);
    expect(placesType(doc)).toBe("text/x-moz-place-container");
  });
});

// ------------------------------------------------------------------------- VT-2

describe("decodeMozLz4 refusals: corrupt magic and truncation", () => {
  it("refuses a changed magic byte (corrupt)", () => {
    const buf = mozlz4Frame(1, [0x10, 0x61]);
    buf[0] = 0x6e; // "nozLz40\0"
    expectRefusal(() => decode(buf), "corrupt");
  });

  it("refuses a buffer shorter than the header (corrupt)", () => {
    // 11 bytes: too short for magic plus a 4-byte size.
    expectRefusal(() => decode(Buffer.alloc(11)), "corrupt");
  });

  it("refuses literals running past the input (corrupt)", () => {
    // token 0x50: 5 literals declared, but only 3 bytes follow.
    expectRefusal(() => decode(mozlz4Frame(5, [0x50, 0x61, 0x62, 0x63])), "corrupt");
  });

  it("refuses a truncated match offset (corrupt)", () => {
    // token 0x10: 1 literal "a", then a single offset byte.
    expectRefusal(() => decode(mozlz4Frame(6, [0x10, 0x61, 0x01])), "corrupt");
  });
});

describe("decodeMozLz4 refusals: corrupt match offsets", () => {
  it("refuses match offset 0 (corrupt)", () => {
    // token 0x10: 1 literal "a", then offset 0.
    expectRefusal(() => decode(mozlz4Frame(5, [0x10, 0x61, 0x00, 0x00])), "corrupt");
  });

  it("refuses a match offset beyond the bytes written (corrupt)", () => {
    // token 0x20: literals "ab", then offset 3 with only 2 bytes written.
    expectRefusal(() => decode(mozlz4Frame(6, [0x20, 0x61, 0x62, 0x03, 0x00])), "corrupt");
  });
});

describe("decodeMozLz4 refusals: corrupt runs past the declared size", () => {
  it("refuses literals past the declared size (corrupt)", () => {
    // token 0x50: 5 literals, declared 3.
    expectRefusal(() => decode(mozlz4Frame(3, [0x50, 0x61, 0x62, 0x63, 0x64, 0x65])), "corrupt");
  });

  it("refuses a match past the declared size (corrupt)", () => {
    // token 0x20: literals "ab", offset 2, match 0+4=4 → 6 bytes, declared 5.
    expectRefusal(() => decode(mozlz4Frame(5, [0x20, 0x61, 0x62, 0x02, 0x00])), "corrupt");
  });

  it("refuses a block that ends short of the declared size (corrupt)", () => {
    // token 0x20: literals "ab", then the input ends at 2 of 5 declared bytes.
    expectRefusal(() => decode(mozlz4Frame(5, [0x20, 0x61, 0x62])), "corrupt");
  });
});

describe("decodeMozLz4 refusals: corrupt truncated length extensions", () => {
  it("refuses a literal extension cut off at the token (corrupt)", () => {
    // token 0xF0: literal length 15, with no extension byte.
    expectRefusal(() => decode(mozlz4Frame(15, [0xf0])), "corrupt");
  });

  it("refuses a literal extension cut off after 0xFF (corrupt)", () => {
    // token 0xF0: 15 + 255 literals, with no next extension byte.
    expectRefusal(() => decode(mozlz4Frame(270, [0xf0, 0xff])), "corrupt");
  });

  it("refuses a match extension cut off after the offset (corrupt)", () => {
    // token 0x1F: 1 literal "a", offset 1, match 15+4, no extension byte.
    expectRefusal(() => decode(mozlz4Frame(20, [0x1f, 0x61, 0x01, 0x00])), "corrupt");
  });

  it("refuses a match extension cut off after 0xFF (corrupt)", () => {
    // token 0x1F: 1 literal "a", offset 1, match extension 0xFF then the end.
    expectRefusal(() => decode(mozlz4Frame(275, [0x1f, 0x61, 0x01, 0x00, 0xff])), "corrupt");
  });
});

describe("decodeMozLz4 refusals: too_large over the cap", () => {
  it("refuses a declared size over maxBytes (too_large)", () => {
    // declared 4 with a cap of 3; the block itself would decode 2 bytes.
    expectRefusal(() => decode(mozlz4Frame(4, [0x20, 0x61, 0x62]), 3), "too_large");
  });

  it("refuses a 0xFFFFFFFF declared size from the header alone (too_large)", () => {
    expectRefusal(() => decode(mozlz4Frame(0xff_ff_ff_ff, [])), "too_large");
  });

  it("refuses a buffer both over the cap and corrupt as too_large", () => {
    // declared 0xFFFFFFFF with a block that is a truncated extension: the cap wins.
    const buf = mozlz4Frame(0xff_ff_ff_ff, [0xf0, 0xff]);
    expectRefusal(() => decode(buf), "too_large");
  });

  it("refuses a declared size over maxBytes before allocating (too_large)", () => {
    const frame = mozlz4Frame(4, [0x20, 0x61, 0x62]);
    const alloc = vi.spyOn(Buffer, "alloc");
    const allocUnsafe = vi.spyOn(Buffer, "allocUnsafe");
    try {
      expectRefusal(() => decode(frame, 3), "too_large");
      expect(alloc).not.toHaveBeenCalled();
      expect(allocUnsafe).not.toHaveBeenCalled();
    } finally {
      alloc.mockRestore();
      allocUnsafe.mockRestore();
    }
  });

  it("decodes a declared size equal to maxBytes", () => {
    // token 0x20: literals "ab", declared 2, cap 2.
    expect(decode(mozlz4Frame(2, [0x20, 0x61, 0x62]), 2)).toEqual(Buffer.from("ab"));
  });
});

describe("decodeMozLz4 refusals: fixed text only", () => {
  it("gives two bad-magic inputs the same message", () => {
    const first = mozlz4Frame(1, [0x10, 0x61]);
    first[0] = 0x6e;
    const second = mozlz4Frame(1, [0x10, 0x61]);
    second[7] = 0x01;
    expect(refusal(() => decode(first)).message).toBe(refusal(() => decode(second)).message);
  });

  it("gives two offset-0 inputs with different literals the same message", () => {
    const first = mozlz4Frame(5, [0x10, 0x61, 0x00, 0x00]);
    const second = mozlz4Frame(5, [0x10, 0x62, 0x00, 0x00]);
    expect(refusal(() => decode(first)).message).toBe(refusal(() => decode(second)).message);
  });
});

// ------------------------------------------------------------------------- VT-3

describe("decodeMozLz4: overlap of an offset-1 and an offset-2 match", () => {
  it("repeats one byte with an offset-1 match (length 6)", () => {
    // token 0x12: 1 literal "a", match 2+4=6 at offset 1 → 7 bytes.
    const block = [0x12, 0x61, 0x01, 0x00];
    expect(decode(mozlz4Frame(7, block))).toEqual(Buffer.from("a".repeat(7)));
  });

  it("repeats two bytes with an offset-2 overlap (length 6)", () => {
    // token 0x22: literals "ab", match 2+4=6 at offset 2 → 8 bytes.
    const block = [0x22, 0x61, 0x62, 0x02, 0x00];
    expect(decode(mozlz4Frame(8, block))).toEqual(Buffer.from("abababab"));
  });
});

describe("decodeMozLz4: literal length extensions at 15 and 255", () => {
  it("reads a 15-literal run terminated by a zero extension byte", () => {
    // token 0xF0: 15 literals, extension 0x00 (15 + 0), then the 15 bytes.
    const block = Buffer.concat([Buffer.from([0xf0, 0x00]), Buffer.from("abcdefghijklmno")]);
    expect(decode(mozlz4Frame(15, block))).toEqual(Buffer.from("abcdefghijklmno"));
  });

  it("reads a 270-literal run: 15 + 0xFF + 0x00", () => {
    // token 0xF0: 15 literals, extensions 0xFF 0x00 (15 + 255 + 0), then the bytes.
    const block = Buffer.concat([Buffer.from([0xf0, 0xff, 0x00]), Buffer.from(repeatTo(270))]);
    expect(decode(mozlz4Frame(270, block))).toEqual(Buffer.from(repeatTo(270)));
  });

  it("reads a 273-literal run: 15 + 0xFF + 0x03", () => {
    // token 0xF0: 15 literals, extensions 0xFF 0x03 (15 + 255 + 3), then the bytes.
    const block = Buffer.concat([Buffer.from([0xf0, 0xff, 0x03]), Buffer.from(repeatTo(273))]);
    expect(decode(mozlz4Frame(273, block))).toEqual(Buffer.from(repeatTo(273)));
  });
});

describe("decodeMozLz4: match length extensions at 15 and 255", () => {
  it("reads a 19-byte match: 15 + 4 with a zero extension byte", () => {
    // token 0x1F: 1 literal "a", offset 1, match 15+4=19, extension 0x00 → 20 bytes.
    const block = [0x1f, 0x61, 0x01, 0x00, 0x00];
    expect(decode(mozlz4Frame(20, block))).toEqual(Buffer.from("a".repeat(20)));
  });

  it("reads a 274-byte match: 15 + 255 + 4", () => {
    // token 0x1F: 1 literal "a", offset 1, match 15+255+4=274 → 275 bytes.
    const block = [0x1f, 0x61, 0x01, 0x00, 0xff, 0x00];
    expect(decode(mozlz4Frame(275, block))).toEqual(Buffer.from("a".repeat(275)));
  });
});

describe("decodeMozLz4: a final literals-only sequence after a match", () => {
  it("appends the trailing literals after an overlapping match", () => {
    // token 0x12: 1 literal "a", match 2+4=6 at offset 1 (7 bytes);
    // then token 0x30: 3 literals "xyz" → 10 bytes.
    const block = [0x12, 0x61, 0x01, 0x00, 0x30, 0x78, 0x79, 0x7a];
    expect(decode(mozlz4Frame(10, block))).toEqual(Buffer.from("aaaaaaaxyz"));
  });
});

// ------------------------------------------------------------------------- VT-4

describe("encodeMozLz4 round-trip through decodeMozLz4", () => {
  it.each([0, 1, 14, 15, 16, 269, 270, 271, 300])("round-trips the %i-byte case", (length) => {
    const text = repeatTo(length);
    const encoded = encodeMozLz4(text);
    expect(decode(encoded)).toEqual(Buffer.from(text, "utf8"));
    expect(encoded.readUInt32LE(8)).toBe(length);
  });

  it("round-trips the empty string and builds only the token 0x00", () => {
    const encoded = encodeMozLz4("");
    expect(decode(encoded)).toEqual(Buffer.alloc(0));
    expect(encoded).toEqual(mozlz4Frame(0, [0x00]));
  });

  it("round-trips the scratchpad.json bytes", () => {
    const json = fixture("scratchpad.json");
    expect(decode(encodeMozLz4(json))).toEqual(json);
  });

  it("round-trips a multi-byte UTF-8 string", () => {
    const text = "ünïcode ✓ 日本語";
    const encoded = encodeMozLz4(text);
    expect(decode(encoded)).toEqual(Buffer.from(text, "utf8"));
    expect(encoded.readUInt32LE(8)).toBe(Buffer.byteLength(text, "utf8"));
  });
});
