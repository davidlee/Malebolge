# IMP-011: Route topics.ts's remaining index reads through storedEntry/ownKey

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From SL-004 PHASE-01 review. `src/topics.ts` now has `ownKey` (private), `storedTopic` and `storedEntry` (own-key lookups), but its other reads of `index.conversations[…]` / `index.topics[…]` (`needsBackfill`, `indexConversation` and later) index directly. Today's keys are decimal ids and validated topic names, so there's no live bug. The point is cohesion: one way to read the index, in the file that owns it. Route those reads through `storedEntry` / `storedTopic`, and keep behaviour identical (existing `test/topics.test.ts` covers it).
