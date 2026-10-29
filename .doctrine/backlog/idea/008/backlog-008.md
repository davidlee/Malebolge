# IDE-008: SATAN bookmark tools: search, operator-applied reorganisation plans, capture-on-demand for digest

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator direction, 2026-10-29 (preflight in session; findings below are
evidence as of that date).

## Intent

SATAN finds, relates and tidies the operator's Firefox bookmarks. Use cases:

- "I'm writing about Kegan's theory of adult development: dig up anything I
  bookmarked that seems related, ish."
- "Rationalise the tags and folders for all my bookmarks about CLI tools."
- "What was that YouTube clip about Palantir's enterprise ontologies?" —
  mostly history and attention data: step 4, deferred.

## Progression

1. **Read and search** bookmarks (title, URL, tags, folder). Look up the
   panopticon digest for a bookmark's URL (subject to IMP-023).
2. **Reorganisation plans.** SATAN proposes re-tag / re-folder / dedupe as a
   structured plan; the operator reviews and applies it. SATAN never writes
   Firefox state itself. Same pattern as IDE-005.
3. **Capture on demand.** SATAN enqueues a bookmark for digest.
4. **History** — deferred.

## Findings (preflight)

- Firefox profile `~/.config/mozilla/firefox/ez06zp0k.default`. `places.sqlite`
  (~63 MB, WAL, locked while Firefox runs) holds bookmarks, tags and history.
  Daily `bookmarkbackups/*.jsonlz4`; latest names 513 bookmarks.
- At ~513 bookmarks a compact listing fits in context: "related, ish" needs
  no embeddings. History will need search; defer with step 4.
- The panopticon Firefox extension (`~/dev/panopticon/firefox-extension`)
  already talks to a native-messaging host. The WebExtension `bookmarks` API
  can read *and* apply changes while Firefox runs — a safer step-2 write path
  than `places.sqlite`. `history` API likewise for step 4.
- Panopticon never fetches pages: content exists only for pages dwelt on
  (30 s) or right-clicked; digests are selected only from captured content
  (`panopticon/digest/select.py`). So step 3 means the extension opens the
  bookmark in a background tab and captures it.

## Open

- **Home.** Data path in panopticon (extension + host). Tools: not in satan
  elisp — operator wants new tools out of elisp; likely malebolge, TBD.
- **Background capture.** The dwell ("linger") check likely rejects a
  background tab; the explicit right-click path, or an injected extraction,
  may get around it. Unverified.
- Plan format and apply surface for step 2 (shared with IDE-005?).
- Injection: bookmark titles are mostly web page titles — low risk, not zero
  (RSK-002). Digests are the high-risk part: IMP-023.

## Research update (SL-008 research, 2026-10-29)

- Tags are folders under the `tags________` root in `places.sqlite`; 305 of
  447 bookmarks are tagged. The WebExtension `bookmarks` API has no tags.
- The live `places.sqlite` is locked while Firefox runs.
- So **step 2 tag edits** cannot go through the extension or a live DB
  write: either a generated backup the operator restores (replaces the whole
  tree) or a write while Firefox is closed. Folder moves / renames can go
  through the extension.
- Step 1 (SL-008) leans on the daily `bookmarkbackups/*.jsonlz4`, which
  carries tags.
