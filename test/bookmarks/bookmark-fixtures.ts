// Shared helpers for the bookmark tests: mozlz4 framing and a literal-only LZ4
// encoder, so a test (or a later phase) can build real mozlz4 buffers without a
// compressor. Nothing here knows how the decoder works; it only builds inputs.
// The tree builders below are the same idea for the projection: a test says the
// shape it means, and never spells a node out as an inline object.

import type {
  BackupContainer,
  BackupNode,
  BackupPlace,
  BackupSeparator,
} from "../../src/bookmarks/backup.ts";

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

// ----------------------------------------------------------------- trees
//
// A tree is what a backup's JSON holds: a placesRoot container with the four
// roots under it. These builders know the Firefox spellings; a test overrides a
// field (or adds an extra one) to say what it means.

/**
 * Fields a builder adds to or replaces on its default node. `unknown` values are
 * deliberate: a test must be able to build a node the schema refuses (a guid of
 * the wrong length, a foreign type, or a required field left undefined).
 */
export type Overrides = Record<string, unknown>;

/** Firefox's four roots, by the short name tests use and their own spelling. */
export type RootKey = "menu" | "toolbar" | "unfiled" | "mobile";

interface Root {
  readonly root: string;
  readonly title: string;
}

const ROOTS: Readonly<Record<RootKey, Root>> = {
  menu: { root: "bookmarksMenuFolder", title: "menu" },
  toolbar: { root: "toolbarFolder", title: "toolbar" },
  unfiled: { root: "unfiledBookmarksFolder", title: "unfiled" },
  mobile: { root: "mobileFolder", title: "mobile" },
};

/** Firefox's own root order in a backup. */
const ROOT_ORDER: readonly RootKey[] = ["menu", "toolbar", "unfiled", "mobile"];

/** How many places the builders have made, so each one gets its own guid and url. */
let placesMade = 0;

/** `n` as the eight digits a built guid ends in. */
function counter(n: number): string {
  return String(n).padStart(8, "0");
}

/** A bookmark with a unique 12-character guid; `overrides` win over the defaults. */
export function place(overrides: Overrides = {}): BackupPlace {
  placesMade += 1;
  const base: BackupPlace = {
    type: "text/x-moz-place",
    guid: `guid${counter(placesMade)}`,
    title: `Bookmark ${String(placesMade)}`,
    uri: `https://example.com/${String(placesMade)}`,
  };
  return { ...base, ...overrides };
}

/** A separator line; `extra` adds fields the schema allows but the projection ignores. */
export function separator(extra: Overrides = {}): BackupSeparator {
  const base: BackupSeparator = { type: "text/x-moz-place-separator" };
  return { ...base, ...extra };
}

/** A folder with `title` and `children`; `extra` adds or replaces fields. */
export function container(
  title: string,
  children: readonly BackupNode[] = [],
  extra: Overrides = {},
): BackupContainer {
  const base: BackupContainer = { type: "text/x-moz-place-container", title, children };
  return { ...base, ...extra };
}

/** One of Firefox's four roots, with its Firefox title so the root KEY is what names it. */
export function rootFolder(key: RootKey, children: readonly BackupNode[] = []): BackupContainer {
  const root = ROOTS[key];
  return container(root.title, children, { root: root.root });
}

/** A whole backup: placesRoot holding the four roots in Firefox order, absent keys empty. */
export function backupTree(
  roots: Partial<Record<RootKey, readonly BackupNode[]>> = {},
): BackupContainer {
  const children = ROOT_ORDER.map((key) => rootFolder(key, roots[key] ?? []));
  return container("", children, { root: "placesRoot" });
}
