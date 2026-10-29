// The three bookmark tools (SL-008 design sec-3): bounds clamped, inputs refused
// before the source is read, matching, ordering and tag counting here, and the
// page framed by ./render.ts. No I/O here: the BookmarkSource and "now" are
// injected, and the projections are already capped.

import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { isRecord, type JsonRecord } from "../json.ts";
import { bounded, type Clamp, type Range } from "../ranges.ts";
import { BookmarkSourceError, type BookmarkSource } from "./backup.ts";
import {
  FOLDER_MAX_BYTES,
  TAGS_MAX,
  TAG_MAX_BYTES,
  TITLE_MAX_BYTES,
  URL_MAX_BYTES,
  type Bookmark,
  type Folder,
} from "./project.ts";
import {
  type BookmarkBound,
  type PageRequest,
  renderFolders,
  renderSearch,
  renderTags,
  type TagCount,
} from "./render.ts";

// ------------------------------------------------------- ranges and clamps

/** bookmarks_search's limit: 1-200, default 50. */
export const SEARCH_LIMIT: Range = { min: 1, max: 200, default: 50 };
/** Every tool's offset: 0-10000, default 0 (mail_list's range). */
export const OFFSET: Range = { min: 0, max: 10000, default: 0 };

/**
 * The filter byte caps: a value over its cap is refused before the source is
 * read. A tag or folder filter longer than the projection's cap could never
 * match, so those two are the projection's own caps.
 */
export const QUERY_MAX_BYTES = 512;
export const TAG_FILTER_MAX_BYTES = TAG_MAX_BYTES;
export const FOLDER_FILTER_MAX_BYTES = FOLDER_MAX_BYTES;

// ------------------------------------------------------------ validation

/** Bad tool arguments: refused before the source, in a message that never repeats the value. */
export class BookmarkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookmarkInputError";
  }
}

/** The filters given, and only those; each optional value is checked by the tool. */
export interface BookmarkFilters {
  readonly query?: string;
  readonly tag?: string;
  readonly folder?: string;
}

/** `raw` as a filter string: absent stays absent, and over its cap is refused unnamed. */
function filterOf(tool: string, param: string, raw: unknown, maxBytes: number): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new BookmarkInputError(
      `${tool}: ${param} must be a string of at most ${String(maxBytes)} bytes`,
    );
  }
  return raw;
}

/** The filters given and not blank: a whitespace-only query, an empty tag or folder, filters nothing. */
function filtersOf(tool: string, args: JsonRecord): BookmarkFilters {
  const query = filterOf(tool, "query", args["query"], QUERY_MAX_BYTES);
  const tag = filterOf(tool, "tag", args["tag"], TAG_FILTER_MAX_BYTES);
  const folder = filterOf(tool, "folder", args["folder"], FOLDER_FILTER_MAX_BYTES);
  return {
    ...(query === undefined || query.trim() === "" ? {} : { query }),
    ...(tag === undefined || tag === "" ? {} : { tag }),
    ...(folder === undefined || folder === "" ? {} : { folder }),
  };
}

// -------------------------------------------------------------- matching

/** `query` as its lowercased terms: whitespace splits them, blanks drop. */
function queryTerms(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
}

/** The bookmark's lowercased fields: where a query term is looked for. */
function fieldsOf(bookmark: Bookmark): readonly string[] {
  return [bookmark.title, bookmark.url, bookmark.folder, ...bookmark.tags].map((field) =>
    field.toLowerCase(),
  );
}

/** Whether every term is a substring of at least one field (terms may hit different fields). */
function hasTerms(bookmark: Bookmark, terms: readonly string[]): boolean {
  if (terms.length === 0) {
    return true;
  }
  const fields = fieldsOf(bookmark);
  return terms.every((term) => fields.some((field) => field.includes(term)));
}

/** Case-insensitive equality with one of the bookmark's tags. */
function hasTag(bookmark: Bookmark, tag: string): boolean {
  const wanted = tag.toLowerCase();
  return bookmark.tags.some((candidate) => candidate.toLowerCase() === wanted);
}

/** Case-insensitive prefix at a segment boundary: Menu/dev matches Menu/dev/cli, not Menu/devops. */
function inFolder(bookmark: Bookmark, folder: string): boolean {
  const wanted = folder.toLowerCase();
  const path = bookmark.folder.toLowerCase();
  return path === wanted || path.startsWith(`${wanted}/`);
}

/** The bookmarks matching every given filter: each is ANDed, on the capped fields. */
export function matches(
  bookmarks: readonly Bookmark[],
  filters: BookmarkFilters,
): readonly Bookmark[] {
  const terms = filters.query === undefined ? [] : queryTerms(filters.query);
  return bookmarks.filter(
    (bookmark) =>
      hasTerms(bookmark, terms) &&
      (filters.tag === undefined || hasTag(bookmark, filters.tag)) &&
      (filters.folder === undefined || inFolder(bookmark, filters.folder)),
  );
}

// --------------------------------------------------------------- ordering

/** Plain code-unit order, not localeCompare, so the order is the same everywhere. */
function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Newest first: `added` is a calendar date, so its text compares as one; none sorts last. */
function compareAdded(left: Bookmark, right: Bookmark): number {
  if (left.added === right.added) {
    return 0;
  }
  if (left.added === undefined) {
    return 1;
  }
  if (right.added === undefined) {
    return -1;
  }
  return compareStrings(right.added, left.added);
}

/** The order the search page shows: added descending, missing added last, then guid ascending. */
export function searchOrder(bookmarks: readonly Bookmark[]): readonly Bookmark[] {
  return [...bookmarks].sort((left, right) => {
    const byDate = compareAdded(left, right);
    return byDate === 0 ? compareStrings(left.guid, right.guid) : byDate;
  });
}

// ------------------------------------------------------------- tag counts

/** Each distinct tag (exact, case-sensitive) and how many bookmarks carry it, a bookmark once. */
function countsByTag(bookmarks: readonly Bookmark[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bookmark of bookmarks) {
    for (const tag of new Set(bookmark.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return counts;
}

/** bookmarks_tags' order: count descending, then tag ascending. */
export function tagCounts(bookmarks: readonly Bookmark[]): readonly TagCount[] {
  return [...countsByTag(bookmarks)]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) =>
      left.count === right.count ? compareStrings(left.tag, right.tag) : right.count - left.count,
    );
}

/** Every folder by path ascending, empty ones included. */
function foldersByPath(folders: readonly Folder[]): readonly Folder[] {
  return [...folders].sort((left, right) => compareStrings(left.path, right.path));
}

// ---------------------------------------------------------------- the tools

export interface BookmarkDeps {
  readonly source: BookmarkSource;
  readonly now: () => number;
}

/** A page's request: the offset, the clamps so far, and the injected clock as a date. */
function pageRequest(
  deps: BookmarkDeps,
  offset: number,
  clamps: readonly Clamp<BookmarkBound>[],
): PageRequest {
  return { offset, clamps, now: new Date(deps.now()) };
}

/** bookmarks_search: the matching bookmarks in search order, one page. */
async function searchText(deps: BookmarkDeps, args: JsonRecord): Promise<string> {
  const clamps: Clamp<BookmarkBound>[] = [];
  const filters = filtersOf("bookmarks_search", args);
  const limit = bounded(args["limit"], SEARCH_LIMIT, "limit", clamps);
  const offset = bounded(args["offset"], OFFSET, "offset", clamps);
  const snapshot = await deps.source.read();
  const ordered = searchOrder(matches(snapshot.bookmarks, filters));
  return renderSearch(snapshot, ordered, limit, pageRequest(deps, offset, clamps));
}

/** bookmarks_tags: every tag with its count, one page. */
async function tagsText(deps: BookmarkDeps, args: JsonRecord): Promise<string> {
  const clamps: Clamp<BookmarkBound>[] = [];
  const offset = bounded(args["offset"], OFFSET, "offset", clamps);
  const snapshot = await deps.source.read();
  return renderTags(snapshot, tagCounts(snapshot.bookmarks), pageRequest(deps, offset, clamps));
}

/** bookmarks_folders: every folder with its direct count, by path, one page. */
async function foldersText(deps: BookmarkDeps, args: JsonRecord): Promise<string> {
  const clamps: Clamp<BookmarkBound>[] = [];
  const offset = bounded(args["offset"], OFFSET, "offset", clamps);
  const snapshot = await deps.source.read();
  const folders = foldersByPath(snapshot.folders);
  return renderFolders({ ...snapshot, folders }, pageRequest(deps, offset, clamps));
}

interface BookmarkToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly text: (args: JsonRecord) => Promise<string>;
}

/**
 * One bookmark tool. The model's arguments are read as untrusted JSON, so a
 * BookmarkInputError or BookmarkSourceError becomes the error result the model
 * sees, while anything else (an abort, a bug) is thrown.
 */
function bookmarkTool(spec: BookmarkToolSpec): ToolRegistration {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    // Reading bookmarks changes nothing: an interrupted call reruns after a restart.
    replay: "safe",
    execute: async (raw) => {
      try {
        if (!isRecord(raw)) {
          throw new BookmarkInputError(`${spec.name}: arguments must be an object`);
        }
        const text = await spec.text(raw);
        return { output: [{ type: "text", text }], isError: false };
      } catch (error) {
        if (error instanceof BookmarkInputError || error instanceof BookmarkSourceError) {
          return { output: [{ type: "text", text: error.message }], isError: true };
        }
        throw error;
      }
    },
  });
}

// --------------------------------------------------------- descriptions
//
// DEC-030: usage lives in code. The three clauses say the same thing on every
// tool, so they are written once; the caps interpolate the projection's own
// constants rather than retyping the numbers.

/** Where the data comes from: a backup that renews daily. */
const STALENESS_CLAUSE =
  "Results come from Firefox's daily bookmark backup, so they may be up to a day behind.";

/** Structure first: the two listing tools. */
const STRUCTURE_CLAUSE =
  "To see the structure first, list the folders with bookmarks_folders and the tags with bookmarks_tags.";

/** What the projection caps, so the model knows what is being matched and counted. */
const CAPS_CLAUSE = `Matching and counts use capped fields: titles up to ${String(TITLE_MAX_BYTES)} bytes, URLs up to ${String(URL_MAX_BYTES)} and tags up to ${String(TAG_MAX_BYTES)} bytes, at most ${String(TAGS_MAX)} tags, and folders up to ${String(FOLDER_MAX_BYTES)} bytes.`;

export const SEARCH_DESCRIPTION = `Search bookmarks by text, tag and folder. Every query term must appear in the title, url, a tag or the folder (case-insensitive); a tag is an exact, case-insensitive match; a folder filter includes its subfolders. For loose topical recall, run several searches with different terms, or page the full list with no query. limit 1-200 (default 50), offset 0-10000. ${STRUCTURE_CLAUSE} ${CAPS_CLAUSE} ${STALENESS_CLAUSE}`;

export const TAGS_DESCRIPTION = `List every tag with its bookmark count, most used first (count descending, then tag), a page of offset 0-10000. ${STRUCTURE_CLAUSE} ${CAPS_CLAUSE} ${STALENESS_CLAUSE}`;

export const FOLDERS_DESCRIPTION = `List every folder with its bookmark count, by path, a page of offset 0-10000. Counts are direct bookmarks only, while the search folder filter includes subfolders. ${STRUCTURE_CLAUSE} ${CAPS_CLAUSE} ${STALENESS_CLAUSE}`;

// ----------------------------------------------------------- parameters

const SEARCH_PARAMETERS = Type.Object({
  query: Type.Optional(
    Type.String({
      description: "Text whose every term must appear in the title, url, a tag or the folder",
    }),
  ),
  tag: Type.Optional(
    Type.String({ description: "A tag from bookmarks_tags; exact, case-insensitive" }),
  ),
  folder: Type.Optional(
    Type.String({ description: "A folder from bookmarks_folders; its subfolders included" }),
  ),
  limit: Type.Optional(Type.Integer({ description: "Matches per page (1-200)" })),
  offset: Type.Optional(Type.Integer({ description: "Matches to skip (0-10000)" })),
});

const OFFSET_PARAMETERS = Type.Object({
  offset: Type.Optional(Type.Integer({ description: "Entries to skip (0-10000)" })),
});

/** The bookmark tools, in the design's order. */
export function bookmarkTools(deps: BookmarkDeps): ToolRegistration[] {
  return [
    bookmarkTool({
      name: "bookmarks_search",
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS,
      text: async (args) => searchText(deps, args),
    }),
    bookmarkTool({
      name: "bookmarks_tags",
      description: TAGS_DESCRIPTION,
      parameters: OFFSET_PARAMETERS,
      text: async (args) => tagsText(deps, args),
    }),
    bookmarkTool({
      name: "bookmarks_folders",
      description: FOLDERS_DESCRIPTION,
      parameters: OFFSET_PARAMETERS,
      text: async (args) => foldersText(deps, args),
    }),
  ];
}
