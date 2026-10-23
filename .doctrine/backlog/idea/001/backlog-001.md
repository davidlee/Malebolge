# IDE-001: Show a queued draft in the Emacs transcript before the turn boundary

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From RV-004 F-7 (SL-001 audit). pi-durable queues input to a busy
conversation (`pi.inbox`), so a draft submitted mid-answer shows nothing in the
transcript until the answer ends; the only feedback is the minibuffer
"malebolge: sent N characters". Option: render `inbox_update` (silent today in
`src/render.ts`) as `[status] queued: …` in the Emacs presentation.
