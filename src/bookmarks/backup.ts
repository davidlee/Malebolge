// The bookmark backup (SL-008 design sec-2): the node shapes ("Validation"),
// the one fail-closed check the projection reads behind, and the source port
// ("Choosing the file", "Decoding", "Errors") that reads the newest backup.

import { open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { decodeMozLz4, MozLz4Error } from "./mozlz4.ts";
import { project, type Projection } from "./project.ts";

/** A Firefox bookmark guid: exactly 12 of A-Z a-z 0-9 _ -. */
export const GUID = /^[A-Za-z0-9_-]{12}$/;

const CONTAINER = "text/x-moz-place-container";
const PLACE = "text/x-moz-place";
const SEPARATOR = "text/x-moz-place-separator";

// The Backup* types are hand-written rather than Static derivations: `Static`
// of the cyclic Ref resolves `children` to `unknown[]` (and `any[]` one level
// down), so it cannot tie the recursion to the schema.

/** One line of a places tree that holds nothing. */
export interface BackupSeparator {
  readonly type: typeof SEPARATOR;
}

/** One bookmark: the fields the projection reads, and nothing else. */
export interface BackupPlace {
  readonly type: typeof PLACE;
  readonly guid: string;
  readonly title?: string;
  readonly uri: string;
  readonly dateAdded?: number;
  readonly tags?: string;
}

/** A folder: the fields the projection reads, and nothing else. */
export interface BackupContainer {
  readonly type: typeof CONTAINER;
  readonly title?: string;
  readonly children?: readonly BackupNode[];
  readonly root?: string;
}

/** Any node of a places tree. */
export type BackupNode = BackupContainer | BackupPlace | BackupSeparator;

const ContainerSchema = Type.Object({
  type: Type.Literal(CONTAINER),
  title: Type.Optional(Type.String()),
  children: Type.Optional(Type.Array(Type.Ref("Node"))),
  root: Type.Optional(Type.String()),
});

const PlaceSchema = Type.Object({
  type: Type.Literal(PLACE),
  guid: Type.String({ pattern: GUID.source }),
  title: Type.Optional(Type.String()),
  uri: Type.String(),
  dateAdded: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.String()),
});

const SeparatorSchema = Type.Object({ type: Type.Literal(SEPARATOR) });

/**
 * A places tree rooted at a container (Firefox's `placesRoot`): extra fields are
 * allowed on every node kind, and one bad node anywhere fails the whole check.
 */
export const BackupTreeSchema = Type.Cyclic(
  {
    Node: Type.Union([ContainerSchema, PlaceSchema, SeparatorSchema]),
    Container: ContainerSchema,
  },
  "Container",
);

/** Whether `value` is a places tree the projection may read. */
export function isBackupTree(value: unknown): value is BackupContainer {
  return Value.Check(BackupTreeSchema, value);
}

// --------------------------------------------------------------- the source

/** The file size cap: a backup file over this many bytes is refused undecoded. */
export const BACKUP_FILE_MAX_BYTES = 16 * 1024 * 1024;

/** The decoded size cap: a backup declaring more than this is refused. */
export const BACKUP_JSON_MAX_BYTES = 64 * 1024 * 1024;

/** The newest backup, projected, with the date its file name carries. */
export interface Snapshot extends Projection {
  /** YYYY-MM-DD, from the backup's file name. */
  readonly date: string;
}

/** The bookmarks' port, stateless per call as DEC-027: every `read` re-reads the directory. */
export interface BookmarkSource {
  read(): Promise<Snapshot>;
}

/** Why a BookmarkSource call failed. */
export type BookmarkFailure =
  | "not_configured"
  | "no_backup"
  | "too_large"
  | "unreadable"
  | "corrupt"
  | "invalid";

/** A BookmarkSource call that failed; `message` is safe to show the model. */
export class BookmarkSourceError extends Error {
  readonly reason: BookmarkFailure;

  constructor(reason: BookmarkFailure, message: string) {
    super(message);
    this.name = "BookmarkSourceError";
    this.reason = reason;
  }
}

/** The most bytes one read asks for: the cap is checked over chunks, not stat. */
const READ_CHUNK_BYTES = 1024 * 1024;

/** Firefox's backup name: `bookmarks-<date>_<counter>_<suffix>.jsonlz4`. */
const BACKUP_NAME = /^bookmarks-(\d{4}-\d{2}-\d{2})_\d+_[A-Za-z0-9_=+-]+\.jsonlz4$/;

/** A backup file chosen by name, and the date that name carries. */
interface Chosen {
  readonly name: string;
  readonly date: string;
}

/** Whether `date` (YYYY-MM-DD) is a real calendar date: 2026-02-30 and 9999-99-99 are not. */
function isCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** Whether `candidate` beats `newest`: the greater date, ties to the greater name. */
function beats(candidate: Chosen, newest: Chosen | undefined): boolean {
  if (newest === undefined) {
    return true;
  }
  if (candidate.date !== newest.date) {
    return candidate.date > newest.date;
  }
  return candidate.name > newest.name;
}

/** The newest backup among `names`: greatest date, ties to the lexically greatest name. */
function newestBackup(names: readonly string[]): Chosen | undefined {
  let newest: Chosen | undefined;
  for (const name of names) {
    const date = BACKUP_NAME.exec(name)?.[1];
    if (date === undefined || !isCalendarDate(date)) {
      continue;
    }
    const candidate = { name, date };
    if (beats(candidate, newest)) {
      newest = candidate;
    }
  }
  return newest;
}

/** A refusal over the chosen backup: fixed text plus its date, never its content. */
function tooLarge(date: string): BookmarkSourceError {
  return new BookmarkSourceError("too_large", `bookmark backup ${date} is over the size cap`);
}

/** A refusal to read the chosen backup, naming only its date. */
function unreadableBackup(date: string): BookmarkSourceError {
  return new BookmarkSourceError("unreadable", `bookmark backup ${date} could not be read`);
}

/** A refusal of the chosen backup's mozlz4 frame, naming only its date. */
function corruptBackup(date: string): BookmarkSourceError {
  return new BookmarkSourceError("corrupt", `bookmark backup ${date} is corrupt`);
}

/** A refusal of the chosen backup's JSON body or places tree, naming only its date. */
function invalidBackup(date: string): BookmarkSourceError {
  return new BookmarkSourceError("invalid", `bookmark backup ${date} is not a valid bookmark tree`);
}

/**
 * `path`'s bytes, or undefined when the file is over the cap. `stat` refuses an
 * already-oversize file early; the read loop, not `stat`, is the bound, because a
 * file can grow past the cap after it was stat'ed. The handle is always closed.
 */
async function readCappedFile(path: string): Promise<Buffer | undefined> {
  const handle: FileHandle = await open(path, "r");
  try {
    if ((await handle.stat()).size > BACKUP_FILE_MAX_BYTES) {
      return undefined;
    }
    const chunks: Buffer[] = [];
    let read = 0;
    while (read <= BACKUP_FILE_MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, BACKUP_FILE_MAX_BYTES + 1 - read));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      read += bytesRead;
    }
    const bytes = Buffer.concat(chunks);
    return bytes.length > BACKUP_FILE_MAX_BYTES ? undefined : bytes;
  } finally {
    await handle.close();
  }
}

/** The chosen backup's bytes: `unreadable` on any filesystem failure, `too_large` over the cap. */
async function readBackup(dir: string, chosen: Chosen): Promise<Buffer> {
  let bytes: Buffer | undefined;
  try {
    bytes = await readCappedFile(join(dir, chosen.name));
  } catch {
    throw unreadableBackup(chosen.date);
  }
  if (bytes === undefined) {
    throw tooLarge(chosen.date);
  }
  return bytes;
}

/** The backup's projection: a bad frame is corrupt, a bad body, tree or walk is invalid. */
function decodeBackup(bytes: Buffer, date: string): Projection {
  let decoded: Buffer;
  try {
    decoded = decodeMozLz4(bytes, BACKUP_JSON_MAX_BYTES);
  } catch (error) {
    throw error instanceof MozLz4Error && error.kind === "too_large"
      ? tooLarge(date)
      : corruptBackup(date);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw invalidBackup(date);
  }
  try {
    if (isBackupTree(parsed)) {
      return project(parsed);
    }
  } catch {
    throw invalidBackup(date); // a deeply nested tree overflows the recursive check or walk
  }
  throw invalidBackup(date);
}

/** The newest backup under `dir`, read and projected; every failure is a BookmarkSourceError. */
async function readNewest(dir: string): Promise<Snapshot> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    throw new BookmarkSourceError("unreadable", `bookmark backup directory ${dir} is unreadable`);
  }
  const chosen = newestBackup(names);
  if (chosen === undefined) {
    throw new BookmarkSourceError("no_backup", "no bookmark backup found");
  }
  return { date: chosen.date, ...decodeBackup(await readBackup(dir, chosen), chosen.date) };
}

/** The newest backup under `dir` (DEC-027: every read re-reads the directory). */
export function backupSource(dir: string): BookmarkSource {
  return { read: (): Promise<Snapshot> => readNewest(dir) };
}

/** The source when no backup directory is configured (DEC-055). */
export function unconfiguredSource(): BookmarkSource {
  return {
    read: (): Promise<Snapshot> =>
      Promise.reject(new BookmarkSourceError("not_configured", "bookmarks are not configured")),
  };
}
