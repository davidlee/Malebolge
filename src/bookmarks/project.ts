// The projection (SL-008 design sec-2 "Projection"): a validated places tree to the
// bookmark list and folder index, every field capped by the one cut. Pure: no I/O.

import { cutRendered } from "../untrusted-block.ts";
import type { BackupContainer, BackupPlace } from "./backup.ts";

/** Rendered caps (DEC-053): title, URL, one tag, tag count, folder path. */
export const TITLE_MAX_BYTES = 200;
export const URL_MAX_BYTES = 512;
export const TAG_MAX_BYTES = 64;
export const TAGS_MAX = 20;
export const FOLDER_MAX_BYTES = 256;

/** Which field a cut touched, in the order `Bookmark.cut` reports them. */
export type CutField = "title" | "url" | "tags" | "folder";

/** One bookmark, as the tools see it: capped, and told which fields were cut. */
export interface Bookmark {
  readonly guid: string;
  readonly title: string;
  readonly url: string;
  readonly tags: readonly string[];
  readonly folder: string;
  readonly added?: string;
  readonly cut: readonly CutField[];
}

/** One folder in the index: its capped path and its direct bookmark count. */
export interface Folder {
  readonly path: string;
  readonly count: number;
}

/** What a backup projects to: the bookmarks and the folder index, in traversal order. */
export interface Projection {
  readonly bookmarks: readonly Bookmark[];
  readonly folders: readonly Folder[];
}

/** Firefox's root keys, named as the tools show them. */
const ROOT_NAMES: Readonly<Record<string, string>> = {
  bookmarksMenuFolder: "Menu",
  toolbarFolder: "Toolbar",
  unfiledBookmarksFolder: "Other",
  mobileFolder: "Mobile",
};

/** A container's path segment: its root key's name, else its title. */
function name(node: BackupContainer): string {
  return ROOT_NAMES[node.root ?? ""] ?? node.title ?? "";
}

/** `text` cut to `maxBytes`, naming `field` in `cut` when the cut happened. */
function capped(text: string, maxBytes: number, field: CutField, cut: CutField[]): string {
  const result = cutRendered(text, maxBytes, "…");
  if (result.cut) {
    cut.push(field);
  }
  return result.text;
}

/** `joined` split, trimmed and capped; an over-count or any cut names "tags". */
function tagsOf(joined: string | undefined, cut: CutField[]): string[] {
  const parts = (joined ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  const kept = parts.slice(0, TAGS_MAX).map((tag) => cutRendered(tag, TAG_MAX_BYTES, "…"));
  if (parts.length > TAGS_MAX || kept.some((tag) => tag.cut)) {
    cut.push("tags");
  }
  return kept.map((tag) => tag.text);
}

/** `node` as a bookmark in `folder`; caps and cut names are collected in order. */
function bookmarkOf(node: BackupPlace, folder: string): Bookmark {
  const cut: CutField[] = [];
  const added =
    node.dateAdded !== undefined && Number.isSafeInteger(node.dateAdded)
      ? new Date(Math.floor(node.dateAdded / 1000)).toISOString().slice(0, 10)
      : undefined;
  return {
    guid: node.guid,
    title: capped(node.title ?? "", TITLE_MAX_BYTES, "title", cut),
    url: capped(node.uri, URL_MAX_BYTES, "url", cut),
    tags: tagsOf(node.tags, cut),
    folder: capped(folder, FOLDER_MAX_BYTES, "folder", cut),
    ...(added === undefined ? {} : { added }),
    cut,
  };
}

/**
 * Projects `node`'s children (pre-order) into `bookmarks`, counting each
 * container's direct bookmarks in `folders` under its capped path, so equal
 * capped paths merge. The tree argument itself (path "") is not a folder.
 */
function walk(
  node: BackupContainer,
  path: string,
  bookmarks: Bookmark[],
  folders: Map<string, number>,
): void {
  const key = path === "" ? undefined : cutRendered(path, FOLDER_MAX_BYTES, "…").text;
  const count = (added: number): void => {
    if (key !== undefined) {
      folders.set(key, (folders.get(key) ?? 0) + added);
    }
  };
  count(0);
  for (const child of node.children ?? []) {
    if (child.type === "text/x-moz-place-container") {
      walk(child, path === "" ? name(child) : `${path}/${name(child)}`, bookmarks, folders);
    } else if (child.type === "text/x-moz-place" && !child.uri.startsWith("place:")) {
      bookmarks.push(bookmarkOf(child, path));
      count(1);
    }
  }
}

/** The bookmarks and folders `tree` holds, per design sec-2. */
export function project(tree: BackupContainer): Projection {
  const bookmarks: Bookmark[] = [];
  const folders = new Map<string, number>();
  walk(tree, "", bookmarks, folders);
  return { bookmarks, folders: Array.from(folders, ([path, count]) => ({ path, count })) };
}
