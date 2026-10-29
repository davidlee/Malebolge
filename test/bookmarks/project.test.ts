// VT-1: folder paths and root names (Menu, Toolbar, Other, Mobile from the
// `root` keys), tags split and trimmed, separators and `place:` saved queries
// skipped, `added` from microseconds with missing and unsafe values absent.
// VT-2: `folders` — empty folders and parents holding only subfolders (count 0),
// same-titled siblings merged with summed counts, long paths cut to one prefix
// merged, and the scratchpad backup's own folders and guids.
// VT-3: the field caps — at the cap uncut, one byte over cut to fit by
// renderedLength and named in `cut`, in the order title, url, tags, folder.
// VT-4: the schema behind isBackupTree: a bad node anywhere fails the whole
// tree, the top must be a container, extra fields are allowed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isBackupTree,
  type BackupContainer,
  type BackupNode,
  type BackupPlace,
} from "../../src/bookmarks/backup.ts";
import { decodeMozLz4 } from "../../src/bookmarks/mozlz4.ts";
import {
  FOLDER_MAX_BYTES,
  TAG_MAX_BYTES,
  TAGS_MAX,
  TITLE_MAX_BYTES,
  URL_MAX_BYTES,
  project,
  type Bookmark,
} from "../../src/bookmarks/project.ts";
import { renderedLength } from "../../src/untrusted-block.ts";
import { backupTree, container, place, rootFolder, separator } from "./bookmark-fixtures.ts";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const DECODE_MAX_BYTES = 64 * 1024 * 1024;

/** `count` copies of `char`: a value whose size a cap test can name exactly. */
function text(char: string, count: number): string {
  return char.repeat(count);
}

/** `index` in `list`, refusing an index that is not there: a test's own guarantee. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`no item at ${String(index)}`);
  }
  return item;
}

/** The bookmark a place projects to: whole, so an extra or missing field fails. */
function bookmarkOf(
  node: BackupPlace,
  folder: string,
  overrides: Partial<Bookmark> = {},
): Bookmark {
  return {
    guid: node.guid,
    title: node.title ?? "",
    url: node.uri,
    tags: [],
    folder,
    cut: [],
    ...overrides,
  };
}

/** `count` tags, `tag0` upward: no commas, no surrounding space, all short. */
function tagList(count: number): string[] {
  const tags: string[] = [];
  for (let index = 0; index < count; index += 1) {
    tags.push(`tag${String(index)}`);
  }
  return tags;
}

/** A placesRoot holding `children`: a tree with a top-level container that is not a root. */
function placesRoot(children: readonly BackupNode[]): BackupContainer {
  return container("", children, { root: "placesRoot" });
}

/** The scratchpad backup, decoded and checked as a tree. */
function scratchpad(): BackupContainer {
  const bytes = decodeMozLz4(
    readFileSync(join(FIXTURES_DIR, "scratchpad.jsonlz4")),
    DECODE_MAX_BYTES,
  );
  const doc: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isBackupTree(doc)) {
    throw new Error("the scratchpad fixture is not a backup tree");
  }
  return doc;
}

/** Every place the projection keeps: all of them but the `place:` saved queries. */
function keptPlaces(tree: BackupContainer): BackupPlace[] {
  const kept: BackupPlace[] = [];
  const pending: BackupNode[] = [tree];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    if (node.type === "text/x-moz-place-container") {
      pending.push(...(node.children ?? []));
    } else if (node.type === "text/x-moz-place" && !node.uri.startsWith("place:")) {
      kept.push(node);
    }
  }
  return kept;
}

// ------------------------------------------------------------------------- VT-1

describe("project: root names, folder paths, tags and added (VT-1)", () => {
  it("names the four roots Menu, Toolbar, Other and Mobile, not their Firefox titles", () => {
    const menu = place({ title: "Menu item", uri: "https://example.com/menu" });
    const toolbar = place({ title: "Toolbar item", uri: "https://example.com/toolbar" });
    const other = place({ title: "Other item", uri: "https://example.com/other" });
    const mobile = place({ title: "Mobile item", uri: "https://example.com/mobile" });
    const tree = backupTree({
      menu: [menu],
      toolbar: [toolbar],
      unfiled: [other],
      mobile: [mobile],
    });
    expect(project(tree).bookmarks).toEqual([
      bookmarkOf(menu, "Menu"),
      bookmarkOf(toolbar, "Toolbar"),
      bookmarkOf(other, "Other"),
      bookmarkOf(mobile, "Mobile"),
    ]);
  });

  it("joins a nested path as Menu/a/b, with no leading slash", () => {
    const deep = place({ title: "Deep", uri: "https://example.com/deep" });
    const tree = backupTree({ menu: [container("a", [container("b", [deep])])] });
    expect(project(tree).bookmarks).toEqual([bookmarkOf(deep, "Menu/a/b")]);
  });

  it("gives a place directly under the tree argument the empty folder, listed in no folders", () => {
    const top = place({ title: "Top", uri: "https://example.com/top" });
    expect(project(placesRoot([top]))).toEqual({ bookmarks: [bookmarkOf(top, "")], folders: [] });
  });

  it("splits tags on commas, trims them and drops the empties", () => {
    const tagged = place({ tags: " a, ,b ,," });
    const repeated = place({ tags: "a,a,b" });
    const untagged = place();
    const tree = backupTree({ menu: [tagged, repeated, untagged] });
    expect(project(tree).bookmarks).toEqual([
      bookmarkOf(tagged, "Menu", { tags: ["a", "b"] }),
      bookmarkOf(repeated, "Menu", { tags: ["a", "a", "b"] }),
      bookmarkOf(untagged, "Menu"),
    ]);
  });

  it("skips a separator, and does not count it in folders", () => {
    const first = place();
    const second = place();
    const tree = backupTree({ menu: [first, separator(), second] });
    const { bookmarks, folders } = project(tree);
    expect(bookmarks).toEqual([bookmarkOf(first, "Menu"), bookmarkOf(second, "Menu")]);
    expect(folders).toEqual([
      { path: "Menu", count: 2 },
      { path: "Toolbar", count: 0 },
      { path: "Other", count: 0 },
      { path: "Mobile", count: 0 },
    ]);
  });

  it("skips a place: saved query, and does not count it in folders", () => {
    const saved = place({ title: "Recent tags", uri: "place:type=6&sort=14&maxResults=10" });
    const kept = place({ title: "Kept", uri: "https://example.com/kept" });
    const tree = backupTree({ menu: [saved, kept] });
    const { bookmarks, folders } = project(tree);
    expect(bookmarks).toEqual([bookmarkOf(kept, "Menu")]);
    expect(folders).toEqual([
      { path: "Menu", count: 1 },
      { path: "Toolbar", count: 0 },
      { path: "Other", count: 0 },
      { path: "Mobile", count: 0 },
    ]);
  });

  it("dates added from dateAdded microseconds as 2026-03-25", () => {
    const dated = place({ dateAdded: 1_774_411_442_038_000 });
    const tree = backupTree({ menu: [dated] });
    const bookmarks = project(tree).bookmarks;
    expect(bookmarks).toEqual([bookmarkOf(dated, "Menu", { added: "2026-03-25" })]);
    expect("added" in at(bookmarks, 0)).toBe(true);
  });

  it("leaves added out when dateAdded is missing, 1.5 or 2 ** 60", () => {
    const missing = place();
    const fractional = place({ dateAdded: 1.5 });
    const unsafe = place({ dateAdded: 2 ** 60 });
    const tree = backupTree({ menu: [missing, fractional, unsafe] });
    const { bookmarks } = project(tree);
    expect(bookmarks).toEqual([
      bookmarkOf(missing, "Menu"),
      bookmarkOf(fractional, "Menu"),
      bookmarkOf(unsafe, "Menu"),
    ]);
    for (const bookmark of bookmarks) {
      expect("added" in bookmark).toBe(false);
    }
  });
});

// ------------------------------------------------------------------------- VT-2

describe("project: folders (VT-2)", () => {
  it("lists folders with count 0: an empty one, and one holding only subfolders", () => {
    const inChild = place();
    const tree = backupTree({
      menu: [container("empty"), container("parent", [container("child", [inChild])])],
    });
    expect(project(tree).folders).toEqual([
      { path: "Menu", count: 0 },
      { path: "Menu/empty", count: 0 },
      { path: "Menu/parent", count: 0 },
      { path: "Menu/parent/child", count: 1 },
      { path: "Toolbar", count: 0 },
      { path: "Other", count: 0 },
      { path: "Mobile", count: 0 },
    ]);
  });

  it("merges same-titled sibling folders into one folders entry, counts summed", () => {
    const tree = backupTree({
      menu: [container("dev", [place(), place()]), container("dev", [place()])],
    });
    const { bookmarks, folders } = project(tree);
    expect(folders).toEqual([
      { path: "Menu", count: 0 },
      { path: "Menu/dev", count: 3 },
      { path: "Toolbar", count: 0 },
      { path: "Other", count: 0 },
      { path: "Mobile", count: 0 },
    ]);
    expect(bookmarks.map((bookmark) => bookmark.folder)).toEqual([
      "Menu/dev",
      "Menu/dev",
      "Menu/dev",
    ]);
  });

  it("merges two long paths cut to the same FOLDER_MAX_BYTES prefix", () => {
    const first = container(`${text("x", 250)} one`, [place()]);
    const second = container(`${text("x", 250)} two`, [place(), place()]);
    const tree = backupTree({ menu: [first, second] });
    const { bookmarks, folders } = project(tree);
    const capped = `Menu/${text("x", 246)}…`;
    expect(capped.length).toBe(252);
    expect(renderedLength(capped)).toBe(FOLDER_MAX_BYTES);
    expect(folders).toEqual([
      { path: "Menu", count: 0 },
      { path: capped, count: 3 },
      { path: "Toolbar", count: 0 },
      { path: "Other", count: 0 },
      { path: "Mobile", count: 0 },
    ]);
    expect(bookmarks.map((bookmark) => bookmark.folder)).toEqual([capped, capped, capped]);
    for (const bookmark of bookmarks) {
      expect(bookmark.cut).toEqual(["folder"]);
    }
  });

  it("projects the scratchpad fixture: folders, bookmark count, every guid", () => {
    const tree = scratchpad();
    const kept = keptPlaces(tree);
    const { bookmarks, folders } = project(tree);
    expect(kept).toHaveLength(4);
    expect(bookmarks).toHaveLength(kept.length);
    const guids = kept.map((node) => node.guid);
    for (const bookmark of bookmarks) {
      expect(bookmark.guid).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(guids).toContain(bookmark.guid);
    }
    expect(folders).toEqual([
      { path: "Menu", count: 0 },
      { path: "Menu/Mozilla Firefox", count: 4 },
      { path: "Toolbar", count: 0 },
      { path: "Other", count: 0 },
      { path: "Mobile", count: 0 },
    ]);
  });
});

// ------------------------------------------------------------------------- VT-3

describe("project: the title and url caps (VT-3)", () => {
  it("keeps a title at TITLE_MAX_BYTES uncut", () => {
    const node = place({ title: text("t", TITLE_MAX_BYTES - 2) });
    expect(renderedLength(node.title)).toBe(TITLE_MAX_BYTES);
    expect(project(backupTree({ menu: [node] })).bookmarks).toEqual([bookmarkOf(node, "Menu")]);
  });

  it("cuts a title one byte over TITLE_MAX_BYTES, and names title in cut", () => {
    const node = place({ title: text("t", TITLE_MAX_BYTES - 1) });
    expect(renderedLength(node.title)).toBe(TITLE_MAX_BYTES + 1);
    const bookmark = at(project(backupTree({ menu: [node] })).bookmarks, 0);
    const cutTitle = `${text("t", TITLE_MAX_BYTES - 5)}…`;
    expect(bookmark).toEqual(bookmarkOf(node, "Menu", { title: cutTitle, cut: ["title"] }));
    expect(renderedLength(bookmark.title)).toBeLessThanOrEqual(TITLE_MAX_BYTES);
    expect(bookmark.title.endsWith("…")).toBe(true);
  });

  it("cuts a multi-byte title by rendered bytes, not characters", () => {
    const fitting = place({ title: "é".repeat((TITLE_MAX_BYTES - 2) / 2) });
    expect(renderedLength(fitting.title)).toBe(TITLE_MAX_BYTES);
    expect(at(project(backupTree({ menu: [fitting] })).bookmarks, 0)).toEqual(
      bookmarkOf(fitting, "Menu"),
    );
    const node = place({ title: "é".repeat(TITLE_MAX_BYTES / 2) });
    expect(renderedLength(node.title)).toBe(TITLE_MAX_BYTES + 2);
    const bookmark = at(project(backupTree({ menu: [node] })).bookmarks, 0);
    expect(bookmark.title).toBe(`${"é".repeat(97)}…`);
    expect(bookmark).toEqual(
      bookmarkOf(node, "Menu", { title: `${"é".repeat(97)}…`, cut: ["title"] }),
    );
  });

  it("keeps a url at URL_MAX_BYTES uncut", () => {
    const uri = `https://example.com/${text("u", URL_MAX_BYTES - 22)}`;
    expect(renderedLength(uri)).toBe(URL_MAX_BYTES);
    const node = place({ uri });
    expect(project(backupTree({ menu: [node] })).bookmarks).toEqual([bookmarkOf(node, "Menu")]);
  });

  it("cuts a url one byte over URL_MAX_BYTES, and names url in cut", () => {
    const uri = `https://example.com/${text("u", URL_MAX_BYTES - 21)}`;
    expect(renderedLength(uri)).toBe(URL_MAX_BYTES + 1);
    const node = place({ uri });
    const bookmark = at(project(backupTree({ menu: [node] })).bookmarks, 0);
    const cutUrl = `https://example.com/${text("u", URL_MAX_BYTES - 25)}…`;
    expect(bookmark).toEqual(bookmarkOf(node, "Menu", { url: cutUrl, cut: ["url"] }));
    expect(renderedLength(bookmark.url)).toBeLessThanOrEqual(URL_MAX_BYTES);
    expect(bookmark.url.endsWith("…")).toBe(true);
  });
});

describe("project: the tag caps (VT-3)", () => {
  it("keeps a tag at TAG_MAX_BYTES uncut", () => {
    const node = place({ tags: text("g", TAG_MAX_BYTES - 2) });
    expect(renderedLength(node.tags)).toBe(TAG_MAX_BYTES);
    const bookmark = at(project(backupTree({ menu: [node] })).bookmarks, 0);
    expect(bookmark).toEqual(bookmarkOf(node, "Menu", { tags: [text("g", TAG_MAX_BYTES - 2)] }));
  });

  it("cuts a tag one byte over TAG_MAX_BYTES, and names tags in cut", () => {
    const node = place({ tags: text("g", TAG_MAX_BYTES - 1) });
    expect(renderedLength(node.tags)).toBe(TAG_MAX_BYTES + 1);
    const bookmark = at(project(backupTree({ menu: [node] })).bookmarks, 0);
    const cutTag = `${text("g", TAG_MAX_BYTES - 5)}…`;
    expect(bookmark).toEqual(bookmarkOf(node, "Menu", { tags: [cutTag], cut: ["tags"] }));
    expect(renderedLength(at(bookmark.tags, 0))).toBeLessThanOrEqual(TAG_MAX_BYTES);
    expect(at(bookmark.tags, 0).endsWith("…")).toBe(true);
  });

  it("keeps 20 tags at TAGS_MAX uncut", () => {
    const tags = tagList(TAGS_MAX);
    const node = place({ tags: tags.join(",") });
    const bookmark = at(project(backupTree({ menu: [node] })).bookmarks, 0);
    expect(bookmark).toEqual(bookmarkOf(node, "Menu", { tags }));
  });

  it("keeps the first 20 tags at TAGS_MAX, drops the 21st and names tags in cut", () => {
    const tags = tagList(TAGS_MAX + 1);
    const node = place({ tags: tags.join(",") });
    const bookmark = at(project(backupTree({ menu: [node] })).bookmarks, 0);
    expect(bookmark).toEqual(
      bookmarkOf(node, "Menu", { tags: tags.slice(0, TAGS_MAX), cut: ["tags"] }),
    );
    expect(bookmark.tags).toHaveLength(TAGS_MAX);
  });
});

describe("project: the folder cap and cut order (VT-3)", () => {
  it("keeps a folder path at FOLDER_MAX_BYTES uncut", () => {
    const title = text("x", FOLDER_MAX_BYTES - 2);
    expect(renderedLength(title)).toBe(FOLDER_MAX_BYTES);
    const node = place();
    const tree = placesRoot([container(title, [node])]);
    expect(project(tree).bookmarks).toEqual([bookmarkOf(node, title)]);
    expect(project(tree).folders).toEqual([{ path: title, count: 1 }]);
  });

  it("cuts a folder path one byte over FOLDER_MAX_BYTES, and names folder in cut", () => {
    const title = text("x", FOLDER_MAX_BYTES - 1);
    expect(renderedLength(title)).toBe(FOLDER_MAX_BYTES + 1);
    const node = place();
    const tree = placesRoot([container(title, [node])]);
    const capped = `${text("x", FOLDER_MAX_BYTES - 5)}…`;
    const bookmark = at(project(tree).bookmarks, 0);
    expect(bookmark).toEqual(bookmarkOf(node, capped, { cut: ["folder"] }));
    expect(renderedLength(bookmark.folder)).toBeLessThanOrEqual(FOLDER_MAX_BYTES);
    expect(bookmark.folder.endsWith("…")).toBe(true);
    expect(project(tree).folders).toEqual([{ path: capped, count: 1 }]);
  });

  it("names each cut field once, in the order title, url, tags, folder", () => {
    const node = place({
      title: text("t", TITLE_MAX_BYTES - 1),
      uri: `https://example.com/${text("u", URL_MAX_BYTES)}`,
      tags: tagList(TAGS_MAX + 1).join(","),
    });
    const tree = placesRoot([container(text("f", FOLDER_MAX_BYTES), [node])]);
    const bookmark = at(project(tree).bookmarks, 0);
    expect(bookmark.cut).toEqual(["title", "url", "tags", "folder"]);
    expect(renderedLength(bookmark.title)).toBeLessThanOrEqual(TITLE_MAX_BYTES);
    expect(renderedLength(bookmark.url)).toBeLessThanOrEqual(URL_MAX_BYTES);
    expect(renderedLength(bookmark.folder)).toBeLessThanOrEqual(FOLDER_MAX_BYTES);
    expect(bookmark.tags).toHaveLength(TAGS_MAX);
    expect(bookmark.folder.endsWith("…")).toBe(true);
  });
});

// ------------------------------------------------------------------------- VT-4

describe("isBackupTree: the schema (VT-4)", () => {
  it("refuses a node of an unknown type deep in an otherwise valid tree", () => {
    const tree = backupTree({
      menu: [container("deep", [container("deeper", [], { type: "text/x-moz-plugin" })])],
    });
    expect(isBackupTree(tree)).toBe(false);
  });

  it("refuses a schema miss: a place missing uri deep in the tree", () => {
    const tree = backupTree({ toolbar: [container("deep", [place({ uri: undefined })])] });
    expect(isBackupTree(tree)).toBe(false);
  });

  it("refuses a guid that is not 12 characters of A-Za-z0-9_- deep in the tree", () => {
    const bad = ["guid0000000", "guid000000011", "guid0000000!", "guid 0000000"];
    for (const guid of bad) {
      const tree = backupTree({
        toolbar: [container("deep", [container("deeper", [place({ guid })])])],
      });
      expect(isBackupTree(tree)).toBe(false);
    }
    expect(isBackupTree(backupTree({ toolbar: [place({ guid: "guid_000000-" })] }))).toBe(true);
  });

  it("refuses a place whose schema fields are of the wrong type", () => {
    expect(isBackupTree(backupTree({ menu: [place({ dateAdded: "1774411442038000" })] }))).toBe(
      false,
    );
    expect(isBackupTree(backupTree({ menu: [container("a", [], { children: "no" })] }))).toBe(
      false,
    );
    expect(isBackupTree(backupTree({ menu: [place({ tags: 20 })] }))).toBe(false);
  });

  it("refuses a tree whose top is a place", () => {
    expect(isBackupTree(place())).toBe(false);
    expect(isBackupTree(null)).toBe(false);
    expect(isBackupTree("placesRoot")).toBe(false);
  });

  it("accepts extra fields on every node kind", () => {
    const tree = backupTree({
      menu: [
        container(
          "folder",
          [place({ typeCode: 1, index: 2, iconUri: "fake-favicon-uri:https://x" })],
          {
            index: 1,
            dateAdded: 1_774_411_442_038_000,
            lastModified: 1_774_411_442_131_000,
            typeCode: 2,
          },
        ),
        separator({ index: 3, typeCode: 3 }),
      ],
    });
    expect(isBackupTree(tree)).toBe(true);
  });

  it("accepts the scratchpad fixture and every tree the builders make", () => {
    expect(isBackupTree(scratchpad())).toBe(true);
    expect(isBackupTree(backupTree())).toBe(true);
    expect(isBackupTree(backupTree({ menu: [container("a", [place()]), separator()] }))).toBe(true);
    expect(isBackupTree(rootFolder("menu", [place()]))).toBe(true);
  });
});
