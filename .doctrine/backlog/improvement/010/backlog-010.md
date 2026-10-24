# IMP-010: Share one scanConversations pager between durable-ids and the topic backfill

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

`src/runner/durable-ids.ts` (`conversationIdOf`) and `src/topics.ts`
(`unindexed`, SL-003 PHASE-01) each hand-roll the same
`tx.scanConversations` cursor loop: page until `next` is undefined. One
searches, one collects; both are "every record, in order". An async
generator `conversationRecords(tx, order)` in a root module would serve both
and every later scan. The PHASE-01 worker kept the copy because the runner
module sits in the runner tier; check `test/structure.test.ts` allows a root
module to be imported from `src/runner/` (it should — the runner already
imports root modules).
