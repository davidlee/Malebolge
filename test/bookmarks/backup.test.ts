// VT-1: choosing the file — newest name date across several backups, a date tie
// broken by the lexically greatest name, foreign names and non-calendar dates
// (9999-99-99, 2026-02-30) ignored, an empty dir no_backup, a missing dir
// unreadable with the directory named, and the snapshot's date/bookmarks/folders.
// VT-2: the caps and decoding — a file over the size cap, a file that grows past
// the cap after stat (the read loop must not trust stat), a declared size over
// the JSON cap, corrupt bytes, invalid JSON, a schema miss, an oversized guid,
// one bad guid deep in the tree, and a deeply nested body.
// VT-3: every refusal is a BookmarkSourceError whose message never carries the
// file's content (the MARKER), and which never carries a cause.
// VT-4: unconfiguredSource refuses with not_configured.
// Plus: read is stateless per call (DEC-027), and fakeBookmarkSource records reads.

import { mkdir, open, stat, truncate, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  BACKUP_FILE_MAX_BYTES,
  BACKUP_JSON_MAX_BYTES,
  BookmarkSourceError,
  backupSource,
  unconfiguredSource,
  type BackupContainer,
  type BookmarkFailure,
  type BookmarkSource,
} from "../../src/bookmarks/backup.ts";
import { project } from "../../src/bookmarks/project.ts";
import { rejection, tempDir } from "../fixtures.ts";
import {
  backupName,
  backupTree,
  container,
  encodeMozLz4,
  fakeBookmarkSource,
  mozlz4Frame,
  place,
  writeBackup,
} from "./bookmark-fixtures.ts";

/**
 * Text put in failing files: no refusal may ever echo it back. Short, because V8's
 * JSON.parse SyntaxError quotes only ~10 characters around the bad token.
 */
const MARKER = "MK7f3a";

/** A fresh temp directory, removed when the test ends. */
async function backupDir(): Promise<string> {
  const { dir, cleanup } = await tempDir();
  onTestFinished(cleanup);
  return dir;
}

/** The failure reason `error` names, if it is a source failure at all. */
function reasonOf(error: unknown): BookmarkFailure | undefined {
  return error instanceof BookmarkSourceError ? error.reason : undefined;
}

/** `error`'s own message text, whichever way it was raised. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether `error` carries a `cause` of its own (no refusal ever should). */
function hasCause(error: unknown): boolean {
  return typeof error === "object" && error !== null && Object.hasOwn(error, "cause");
}

/** Asserts `source` refuses with `reason`: the class first, then the reason. */
async function expectRefusal(source: BookmarkSource, reason: BookmarkFailure): Promise<unknown> {
  const error = await rejection(source.read());
  expect(error).toBeInstanceOf(BookmarkSourceError);
  expect(reasonOf(error)).toBe(reason);
  return error;
}

/** Whether `value` has the shape of a FileHandle prototype: where the stat spy goes. */
function isStatSpyTarget(value: unknown): value is Pick<FileHandle, "stat"> {
  return typeof value === "object" && value !== null && "stat" in value;
}

/** The prototype every FileHandle shares, so a stat spy covers the source's own handle. */
function handleProto(handle: FileHandle): Pick<FileHandle, "stat"> {
  const proto: unknown = Object.getPrototypeOf(handle);
  if (!isStatSpyTarget(proto)) {
    throw new Error("a FileHandle has no prototype to spy on");
  }
  return proto;
}

/** A places body nested `depth` containers deep, spelled as text: no object to stringify. */
function nestedBody(depth: number): string {
  const head = '{"type":"text/x-moz-place-container","children":[';
  return head.repeat(depth) + "]}".repeat(depth);
}

/** A valid mozlz4 file whose magic says otherwise: a corrupt buffer that holds `text`. */
function badMagic(text: string): Buffer {
  const bytes = Buffer.from(encodeMozLz4(text));
  bytes.write("notmozLz", 0, "latin1");
  return bytes;
}

// ------------------------------------------------------------------------- VT-1

describe("VT-1: choosing the newest backup", () => {
  it("reads the backup with the greatest date in its name", async () => {
    const dir = await backupDir();
    const newest = backupTree({ menu: [place({ title: "newest" })] });
    await writeBackup(dir, backupName("2026-10-26"), backupTree({ toolbar: [place()] }));
    await writeBackup(dir, backupName("2026-10-28"), newest);
    await writeBackup(dir, backupName("2026-10-27"), backupTree());
    const snapshot = await backupSource(dir).read();
    expect(snapshot.date).toBe("2026-10-28");
    expect(snapshot.bookmarks).toEqual(project(newest).bookmarks);
    expect(snapshot.folders).toEqual(project(newest).folders);
  });

  it("breaks a date tie with the lexically greatest name", async () => {
    const dir = await backupDir();
    const loser = backupTree({ menu: [place({ title: "lower name" })] });
    const winner = backupTree({ menu: [place({ title: "higher name" })] });
    await writeBackup(dir, backupName("2026-10-28", "AAAAAA=="), loser);
    await writeBackup(dir, backupName("2026-10-28", "ZZZZZZ=="), winner);
    const snapshot = await backupSource(dir).read();
    expect(snapshot.date).toBe("2026-10-28");
    expect(snapshot.bookmarks).toEqual(project(winner).bookmarks);
  });

  it("ignores files that are not Firefox backup names", async () => {
    const dir = await backupDir();
    const real = backupTree({ menu: [place({ title: "real" })] });
    const ignored = backupTree({ menu: [place({ title: "ignored" })] });
    await writeBackup(dir, backupName("2026-10-28"), real);
    await writeBackup(dir, "notes-2026-10-29_446_AbCdEf==.jsonlz4", ignored);
    await writeBackup(dir, "bookmarks-2026-10-30_446_AbCdEf==.json", ignored);
    await writeBackup(dir, "bookmarks-2026-10-31_446_AbCdEf==.jsonlz4.tmp", ignored);
    const snapshot = await backupSource(dir).read();
    expect(snapshot.date).toBe("2026-10-28");
    expect(snapshot.bookmarks).toEqual(project(real).bookmarks);
  });

  it("ignores a 9999-99-99 name even though it is lexically greatest", async () => {
    const dir = await backupDir();
    const real = backupTree({ menu: [place({ title: "real" })] });
    await writeBackup(dir, backupName("2026-10-28"), real);
    await writeBackup(dir, backupName("9999-99-99", "ZZZZZZ=="), backupTree({ menu: [place()] }));
    const snapshot = await backupSource(dir).read();
    expect(snapshot.date).toBe("2026-10-28");
    expect(snapshot.bookmarks).toEqual(project(real).bookmarks);
  });

  it("ignores a 2026-02-30 name that is not a calendar date", async () => {
    const dir = await backupDir();
    const real = backupTree({ menu: [place({ title: "real" })] });
    await writeBackup(dir, backupName("2026-10-28"), real);
    await writeBackup(dir, backupName("2026-02-30", "ZZZZZZ=="), backupTree({ menu: [place()] }));
    const snapshot = await backupSource(dir).read();
    expect(snapshot.date).toBe("2026-10-28");
    expect(snapshot.bookmarks).toEqual(project(real).bookmarks);
  });

  it("refuses an empty directory as no_backup", async () => {
    const dir = await backupDir();
    await expectRefusal(backupSource(dir), "no_backup");
  });

  it("refuses a missing directory as unreadable, naming the directory", async () => {
    const dir = await backupDir();
    const missing = join(dir, "no-such-backup-dir");
    const error = await expectRefusal(backupSource(missing), "unreadable");
    expect(messageOf(error)).toContain(missing);
  });
});

// ------------------------------------------------------------------------- VT-2

describe("VT-2: the caps and decoding", () => {
  it("refuses a file over the size cap as too_large", async () => {
    const dir = await backupDir();
    const path = await writeBackup(dir, backupName("2026-05-01"), backupTree());
    await truncate(path, BACKUP_FILE_MAX_BYTES + 1); // sparse: instant, no 16 MiB written
    await expectRefusal(backupSource(dir), "too_large");
  });

  it("refuses a file that grows past the cap after stat as too_large", async () => {
    const dir = await backupDir();
    const path = await writeBackup(dir, backupName("2026-05-01"), backupTree());
    const small = await stat(path); // stat's story: a small, harmless file
    const handle = await open(path);
    const spy = vi.spyOn(handleProto(handle), "stat").mockResolvedValueOnce(small);
    try {
      await truncate(path, BACKUP_FILE_MAX_BYTES + 1); // the file itself grows past the cap
      await expectRefusal(backupSource(dir), "too_large");
    } finally {
      spy.mockRestore();
      await handle.close();
    }
  });

  it("refuses a directory named like a backup as unreadable", async () => {
    const dir = await backupDir();
    await writeBackup(dir, backupName("2026-05-01"), backupTree());
    const date = "2026-05-08"; // the newest matching name is a directory, not a file
    await mkdir(join(dir, backupName(date)));
    const error = await expectRefusal(backupSource(dir), "unreadable");
    expect(messageOf(error)).toContain(date);
    expect(messageOf(error)).not.toContain("446_AbCdEf"); // fixed text and the date only
    expect(hasCause(error)).toBe(false);
  });

  it("refuses a declared size over the JSON cap as too_large", async () => {
    const dir = await backupDir();
    const body = mozlz4Frame(BACKUP_JSON_MAX_BYTES + 1, [0x00]);
    await writeBackup(dir, backupName("2026-05-02"), body);
    await expectRefusal(backupSource(dir), "too_large");
  });

  it("refuses bad magic as corrupt", async () => {
    const dir = await backupDir();
    await writeBackup(dir, backupName("2026-05-03"), badMagic(JSON.stringify(backupTree())));
    await expectRefusal(backupSource(dir), "corrupt");
  });

  it("refuses a truncated block as corrupt", async () => {
    const dir = await backupDir();
    await writeBackup(dir, backupName("2026-05-03"), mozlz4Frame(64, [0x00]));
    await expectRefusal(backupSource(dir), "corrupt");
  });

  it("refuses a body that is not JSON as invalid", async () => {
    const dir = await backupDir();
    await writeBackup(dir, backupName("2026-05-04"), "this is not JSON at all");
    await expectRefusal(backupSource(dir), "invalid");
  });

  it("refuses a tree that misses the schema as invalid", async () => {
    const dir = await backupDir();
    const body = JSON.stringify({
      type: "text/x-moz-place-container",
      children: [{ type: "text/x-moz-place", title: "no guid, no uri" }],
    });
    await writeBackup(dir, backupName("2026-05-04"), body);
    await expectRefusal(backupSource(dir), "invalid");
  });

  it("refuses an oversized guid as invalid", async () => {
    const dir = await backupDir();
    const tree = backupTree({ menu: [place({ guid: "a".repeat(4096) })] });
    await writeBackup(dir, backupName("2026-05-05"), tree);
    await expectRefusal(backupSource(dir), "invalid");
  });

  it("refuses one bad guid deep in an otherwise good tree as invalid", async () => {
    const dir = await backupDir();
    const tree = backupTree({
      menu: [place()],
      toolbar: [
        container("one", [container("two", [container("three", [place({ guid: "bad" })])])]),
      ],
    });
    await writeBackup(dir, backupName("2026-05-06"), tree);
    await expectRefusal(backupSource(dir), "invalid");
  });

  it("refuses a deeply nested body as invalid, never a raw RangeError", async () => {
    const dir = await backupDir();
    await writeBackup(dir, backupName("2026-05-07"), nestedBody(200_000));
    await expectRefusal(backupSource(dir), "invalid");
  });
});

// ------------------------------------------------------------------------- VT-3

/** One failing file whose content must never surface in the refusal's message. */
interface LeakCase {
  readonly name: string;
  readonly body: Buffer | string | BackupContainer;
  readonly reason: BookmarkFailure;
}

const LEAK_CASES: readonly LeakCase[] = [
  {
    name: "invalid JSON quoting the marker",
    body: `{"title": ${MARKER}}`, // V8 quotes the bad token's neighbourhood
    reason: "invalid",
  },
  {
    name: "a schema miss with the marker in a title and a bad guid",
    body: backupTree({ menu: [place({ title: MARKER, guid: MARKER })] }),
    reason: "invalid",
  },
  {
    name: "corrupt bytes holding the marker",
    body: badMagic(`{"title":"${MARKER}"}`),
    reason: "corrupt",
  },
];

describe("VT-3: every refusal is a source error that never leaks content", () => {
  it.each(LEAK_CASES)("$name: message never carries the marker", async ({ body, reason }) => {
    const dir = await backupDir();
    await writeBackup(dir, backupName("2026-06-01"), body);
    const error = await expectRefusal(backupSource(dir), reason);
    expect(messageOf(error)).not.toContain(MARKER);
    expect(String(error)).not.toContain(MARKER);
    expect(hasCause(error)).toBe(false);
  });
});

// ------------------------------------------------------------------------- VT-4

describe("VT-4: no configured directory", () => {
  it("refuses unconfiguredSource with not_configured", async () => {
    await expectRefusal(unconfiguredSource(), "not_configured");
  });
});

// ------------------------------------------------------------------- the rest

describe("read is stateless per call (DEC-027)", () => {
  it("sees a newer file written between two reads of the same source", async () => {
    const dir = await backupDir();
    await writeBackup(
      dir,
      backupName("2026-07-01"),
      backupTree({ menu: [place({ title: "old" })] }),
    );
    const source = backupSource(dir);
    const first = await source.read();
    expect(first.date).toBe("2026-07-01");
    const newer = backupTree({ menu: [place({ title: "new" })] });
    await writeBackup(dir, backupName("2026-07-02"), newer);
    const second = await source.read();
    expect(second.date).toBe("2026-07-02");
    expect(second.bookmarks).toEqual(project(newer).bookmarks);
  });
});

describe("fakeBookmarkSource", () => {
  it("records each read and resolves the snapshot it was given", async () => {
    const snapshot = { date: "2026-01-01", bookmarks: [], folders: [] };
    const source = fakeBookmarkSource(snapshot);
    expect(source.calls).toHaveLength(0);
    await expect(source.read()).resolves.toBe(snapshot);
    await expect(source.read()).resolves.toBe(snapshot);
    expect(source.calls).toHaveLength(2);
  });

  it("rejects with the failure it was given", async () => {
    const failure = new BookmarkSourceError("no_backup", "no bookmark backup found");
    const source = fakeBookmarkSource(failure);
    await expect(source.read()).rejects.toBe(failure);
    expect(source.calls).toHaveLength(1);
  });
});
