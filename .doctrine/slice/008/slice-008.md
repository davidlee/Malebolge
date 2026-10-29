# Bookmark read tools: SATAN finds and relates Firefox bookmarks

## Context

IDE-008 step 1 (operator, 2026-10-29). SATAN should find and relate the
operator's Firefox bookmarks:

- "I'm writing about Kegan's theory of adult development: dig up anything I
  bookmarked that seems related, ish."
- Groundwork for "rationalise the tags and folders for my CLI-tool bookmarks"
  (IDE-008 step 2, reorganisation plans — a later slice).

Facts from the preflight (2026-10-29):

- Bookmarks live in the Firefox profile
  `~/.config/mozilla/firefox/ez06zp0k.default`: `places.sqlite` (~63 MB, WAL,
  locked while Firefox runs; also holds history) and daily
  `bookmarkbackups/bookmarks-<date>_<count>_<hash>.jsonlz4` (mozlz4 JSON tree;
  latest names 513 bookmarks).
- At ~500 bookmarks a compact listing (title, URL, tags, folder path) fits in
  context, so "related, ish" is the model's judgement over a listing or a
  lexical pre-filter. No embeddings.
- The panopticon Firefox extension and native-messaging host
  (`~/dev/panopticon/firefox-extension`, `panopticon/firefox_host`) already
  bridge Firefox to local files. The WebExtension `bookmarks` API reads the
  live tree while Firefox runs, and later (step 2) can apply changes.
- Template: SL-005 (mail read tools). Native pi-durable `defineTool` tools in
  malebolge, not satan-mcp elisp (operator: new tools leave elisp), calling an
  external program's versioned JSON contract behind a port, tested with a
  fake, bounded in code, framed as untrusted data.
- The daemon runs in `jailed-malebolge` (`docs/internals.md` § Jail); it sees
  neither the Firefox profile nor panopticon's state today. Screwtape reached
  it by a bind added in `~/dev/satan/flake.nix` and `~/flakes`.

## Scope & Objectives

1. **A bookmark source behind a port** in malebolge: a small module that
   obtains the bookmark tree from one data path (chosen in design, OQ-1),
   bounds and validates it, and hands tools plain records: title, URL, tags,
   folder path, date added, Firefox GUID.
2. **Read tools** (names and parameters decided in design):
   - list or search bookmarks — by text over title / URL / tags / folder,
     by tag, by folder;
   - the folder tree and tag inventory with counts (what step 2 needs to
     reason about structure).
3. **Bounds in code.** Count and byte caps per result; truncation stated in
   the result, never silent.
4. **Untrusted framing and field caps.** Bookmark titles are mostly web page
   titles: they reach the model framed as data with provenance (source,
   backup date), with per-field caps (DEC-053). The framing primitives move
   out of `src/mail/` into a shared module mail also uses (DEC-054).
5. **Interactive toolset** (OQ-2, operator 2026-10-29), under the RSK-002
   carve-out DEC-053. Optional config, explicit refusal when unset (DEC-055).

## Non-Goals

- Digest lookup or capture-on-demand for a bookmark — waits on IMP-023
  (quarantine for panopticon content and digests).
- Reorganisation plans and any write to Firefox (IDE-008 step 2).
- Browsing history (IDE-008 step 4).
- Semantic search / embeddings.
- Retiring satan's `content_read` (IMP-023).

## Open Questions

All settled in design (2026-10-29): OQ-1 → DEC-052 (backup file); OQ-2 →
interactive, DEC-053; OQ-3 dissolved (no external program); OQ-4 → bind
`bookmarkbackups/` only, operator rollout (DEC-055).


- **OQ-1 Data path.** (a) read the newest `bookmarkbackups/*.jsonlz4`
  (no Firefox coupling; up to a day stale; needs an lz4 decoder);
  (b) copy `places.sqlite` + WAL and query it (fresh; schema is Firefox
  internals); (c) panopticon's extension exports the tree through its
  native host to a snapshot file (fresh, owned by panopticon, the same
  channel step 2 needs for writes; a panopticon-side change). (c) is the
  preferred direction; it puts a sibling slice in panopticon's doctrine.
- **OQ-2 Toolset.** Bookmark titles are low-risk foreign text (RSK-002).
  Interactive set with framing, or a separate toolset?
- **OQ-3 Contract.** If (c): a panopticon CLI verb printing versioned JSON
  (as screwtape), or malebolge reading a snapshot file panopticon writes.
- **OQ-4 Jail.** Which bind `jailed-malebolge` needs (satan flake +
  `~/flakes`); outside this repo — operator rollout, as for screwtape.

## Risks

- Cross-repo coordination (panopticon, satan flake, `~/flakes`) — the
  malebolge side is buildable against a fake, as SL-005 did.
- Folder and tag semantics in Firefox (tags are a special folder in
  `places.sqlite`; the `bookmarks` API does not expose tags) may push the
  data-path choice.

## Verification intent

- Tools tested against a fixture bookmark tree through the port's fake:
  search hits, tag / folder views, caps and stated truncation, framing.
- A guard that the tools are only in the toolsets design names.
- VH: operator asks the Kegan question in a live conversation and gets
  plausible bookmarks back.

## Summary

## Follow-Ups

- IDE-008 step 2 (reorganisation plans), step 3 (capture-on-demand, after
  IMP-023), step 4 (history).
