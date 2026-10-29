// Bookmark rendering (SL-008 design sec-4): the page fill over the matches from
// `offset`, the trusted header, and `cutCount`. Pure: the tools hand in their
// matches or counts already in order, and this file only measures, pages and
// frames them.
//
// Every header value is a code literal or a fixed form: counts go through
// `count`, the backup date through `isCalendarDate`, `now` through its own
// check. Nothing from a bookmark ever reaches the header, so a title cannot
// write one.

import type { Clamp } from "../ranges.ts";
import {
  assertWithin,
  clampsLine,
  count,
  fitWhole,
  HEADER_MAX_BYTES,
  renderBlock,
} from "../untrusted-block.ts";
import { isCalendarDate, type Snapshot } from "./backup.ts";
import type { Bookmark, Folder } from "./project.ts";

/** The block's tag, as `<bookmark-data untrusted="true">`. */
const BOOKMARK_TAG = "bookmark-data";
const DAY_MS = 86_400_000;
/** Past this many days old, the header says so: a backup a day behind is normal. */
const STALE_DAYS = 2;

/** The bookmark tools' clamped bounds: code literals, never input. */
export type BookmarkBound = "limit" | "offset";

/** One bookmarks_tags item. */
export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

/** What every page needs beside its items. */
export interface PageRequest {
  readonly offset: number;
  readonly clamps: readonly Clamp<BookmarkBound>[];
  readonly now: Date;
}

/** The bookmarks with a non-empty `cut`. Pure. */
export function cutCount(bookmarks: readonly Bookmark[]): number {
  return bookmarks.filter((bookmark) => bookmark.cut.length > 0).length;
}

// ---------------------------------------------------------------- the page

/** A page's lines and counts: `emitted` is what the header reports, `of` the total. */
interface Page {
  readonly lines: readonly string[];
  readonly emitted: number;
  readonly of: number;
}

/** A page that cannot advance is refused, never sent with next_offset = offset. */
function requireAdvance(candidates: number, shown: number): void {
  if (candidates > 0 && shown === 0) {
    throw new Error("bookmark page fits no item");
  }
}

/** `candidates` as whole lines only, each rendered by `item`, counted against `of`. */
function pageOf<T>(candidates: readonly T[], item: (value: T) => unknown, of: number): Page {
  const fitted = fitWhole(candidates.map(item));
  requireAdvance(candidates.length, fitted.shown);
  return { lines: fitted.lines, emitted: fitted.shown, of };
}

/** `values` from `offset` to the end: a page with no limit of its own. */
function fromOffset<T>(values: readonly T[], offset: number): readonly T[] {
  return values.slice(count(offset, "offset"));
}

/** One search item: the design's keys in its order, `added` only when there is one. */
function searchItem(bookmark: Bookmark): unknown {
  const { title, url, tags, folder, added, guid, cut } = bookmark;
  return { title, url, tags, folder, ...(added === undefined ? {} : { added }), guid, cut };
}

/** One tags item. */
function tagItem(tag: TagCount): unknown {
  return { tag: tag.tag, count: tag.count };
}

/** One folders item: the folder's path and its direct bookmark count. */
function folderItem(folder: Folder): unknown {
  return { folder: folder.path, count: folder.count };
}

// -------------------------------------------------------------- the header

/** Whole local calendar days from the backup's date to `now`'s local date. */
function ageInDays(date: string, now: Date): number {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return (today - Date.parse(`${date}T00:00:00.000Z`)) / DAY_MS;
}

/** The source line, then the stale line only past a backup's normal age. */
function sourceLines(date: string, now: Date): string[] {
  if (!isCalendarDate(date)) {
    throw new Error("header: source is not a backup date");
  }
  if (Number.isNaN(now.getTime())) {
    throw new Error("header: now is not a time");
  }
  const lines = [`source: bookmark backup ${date}`];
  const days = ageInDays(date, now);
  if (days > STALE_DAYS) {
    lines.push(`stale: ${String(count(days, "stale"))} days`);
  }
  return lines;
}

/** `, next_offset: X` when the page leaves more, nothing on the last one. */
function nextSuffix(offset: number, emitted: number, total: number): string {
  const next = offset + emitted;
  return next < total ? `, next_offset: ${String(count(next, "next offset"))}` : "";
}

/** The header's clamps, appended only when the tool clamped anything. */
function clampsOf(clamps: readonly Clamp<BookmarkBound>[]): string[] {
  return clamps.length > 0 ? [clampsLine(clamps)] : [];
}

/** The header, refused when it outgrows its room. */
function headerOf(lines: readonly string[]): string {
  const header = lines.join("\n");
  assertWithin(header, HEADER_MAX_BYTES, "bookmark header");
  return header;
}

/** A search page's header: the page, the matches left, the source and the clamps. */
function searchHeader(page: Page, cuts: number, snapshot: Snapshot, request: PageRequest): string {
  return headerOf([
    `bookmarks_search: ${String(count(page.emitted, "items"))} items, ${String(
      count(cuts, "with cuts"),
    )} with cuts`,
    `matched: ${String(count(page.of, "matched"))}${nextSuffix(request.offset, page.emitted, page.of)}`,
    ...sourceLines(snapshot.date, request.now),
    ...clampsOf(request.clamps),
  ]);
}

/** The listing tools: code literals, the only tool names a listing header writes. */
type ListingTool = "bookmarks_tags" | "bookmarks_folders";

/** A tags or folders page's header: shown N of M, the source, the caps cut and clamps. */
function listingHeader(
  tool: ListingTool,
  page: Page,
  snapshot: Snapshot,
  request: PageRequest,
): string {
  const caps = cutCount(snapshot.bookmarks);
  return headerOf([
    `${tool}: shown ${String(count(page.emitted, "shown"))} of ${String(
      count(page.of, "of"),
    )}${nextSuffix(request.offset, page.emitted, page.of)}`,
    ...sourceLines(snapshot.date, request.now),
    ...(caps > 0 ? [`cut by caps: ${String(count(caps, "cut by caps"))} bookmarks`] : []),
    ...clampsOf(request.clamps),
  ]);
}

// -------------------------------------------------------------- the result

/** A search page: the matches from `offset` within `limit`, whole lines only. */
export function renderSearch(
  snapshot: Snapshot,
  matches: readonly Bookmark[],
  limit: number,
  request: PageRequest,
): string {
  const at = count(request.offset, "offset");
  const window = matches.slice(at, at + count(limit, "limit"));
  const page = pageOf(window, searchItem, matches.length);
  const cuts = cutCount(window.slice(0, page.emitted));
  return renderBlock(BOOKMARK_TAG, searchHeader(page, cuts, snapshot, request), page.lines);
}

/** A tags page: the counts from `offset`, whole lines only. */
export function renderTags(
  snapshot: Snapshot,
  tags: readonly TagCount[],
  request: PageRequest,
): string {
  const page = pageOf(fromOffset(tags, request.offset), tagItem, tags.length);
  const header = listingHeader("bookmarks_tags", page, snapshot, request);
  return renderBlock(BOOKMARK_TAG, header, page.lines);
}

/** A folders page: the snapshot's folders from `offset`, whole lines only. */
export function renderFolders(snapshot: Snapshot, request: PageRequest): string {
  const page = pageOf(
    fromOffset(snapshot.folders, request.offset),
    folderItem,
    snapshot.folders.length,
  );
  const header = listingHeader("bookmarks_folders", page, snapshot, request);
  return renderBlock(BOOKMARK_TAG, header, page.lines);
}
