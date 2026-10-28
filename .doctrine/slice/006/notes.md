# Notes SL-006: Threads: start, fork and post among interactive conversations

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Design triage (2026-10-29, design run revision 5)

Evidence: `research/research.md` (cited `F-n`, `X-n`). Framing: RFC-003 and
the operator's answers recorded there (talk sets; mail in no set;
conversation before delegation; prompt model changes incrementally).

**Operator leanings carried into design (2026-10-29)**
- Fork point: spike first, then decide (X-3).
- Project context per conversation (RFC-002 D2): out of scope (X-4).
- A post addresses a conversation by id only (X-7).
- Caps: live counts through `harness.inspect`; chain depth on the post entry;
  cost stays with satan IMP-053 (X-6).
- Threads run in the room only, for now (X-8).

**Constraining governance**
- DEC-012 / RFC-002 D7: every ownerless conversation is indexed in its
  creating commit, by the hook; a fork takes its parent's topic and records it.
- DEC-024: every create path names a toolset; the guard test covers every path,
  across a restart. Start and fork join it.
- DEC-025 (1): toolset fixed at creation; forks inherit it.
- DEC-029: closed catalog; a new extension is named in the interactive list.
- DEC-015: latest = highest id, so a new thread becomes its topic's latest.

**Shaping facts**
- Wake already delivers a durable, deduped, provenance-carrying turn into
  another conversation (F-10..F-13): the post's delivery path (X-1).
- A tool can create or fork inside its own commit and get a handle (F-1..F-3):
  start can be atomic, brief included (X-2).
- A runtime fork today blocks the next start, and the backfill would give it
  the default toolset (F-7..F-9, X-5): fork and IMP-017 land together.

**Risks**
- Runaway turns between threads (bounds are mandatory).
- A fork point with a dangling tool call (X-3), unverified.

**Assumptions**
- EVD-001 (busy conversations queue input) holds for task-submitted input, as
  it does for wakes.

**Open questions**: the design graph's inquiries (`doctrine design show 6`).

## Proposed inquiry resolutions (2026-10-29, awaiting operator)

Put to the operator in session; not yet accepted. On acceptance, dispose each
inquiry in the run and record durable choices via /knowledge.

- inq-1: talk sets as a closed map in `src/toolsets.ts` (room:
  `{interactive: "interactive"}`; mail absent); one `requireSameTalkSet`
  used by start, fork, post. No toolset→mode rename this slice (stored in
  index entries, topic records, wire `--toolset`): backlog a chore.
- inq-2: fork at the caller's latest entry (EVD-002); brief arrives as the
  child's first post.
- inq-3: hook copies the parent entry's toolset; backfill takes the parent's
  (ids ascending, so parent first); startup refusal narrows to a fork with no
  parent entry; task-owned stays refused.
- inq-4: one tool `thread_start {brief, topic?, fork?}`. Fork keeps the
  caller's topic and toolset (topic with fork refused). Else new conversation
  in `topic` (default: caller's), toolset topic's else profile default, refused
  outside the caller's talk set; cwd topic's else daemon default. One
  `api.commit`: create/fork, configure, `toolsetInit`, the brief's post task.
  Returns `{conversation, topic}`.
- inq-5: `thread_post {to, text}`; refused unless target exists, indexed, same
  talk set, not self. `satan.post` task created in the sender's commit, owned
  by the recipient; delivery shared with wake (`placed`/`boundedWait`/withdraw
  moved to a common module); no gate. Envelope
  `<post from="12" topic="x" depth="1">…</post>`; returns `{post, to}`; reply
  = post back to `from`.
- inq-6: caps on posts (every start posts): pending `satan.post` ≤ 8 daemon-wide
  via `harness.inspect`; chain depth ≤ 3, depth = caller's current turn origin
  + 1, read from the caller's latest input entry (human/wake 0). Constants in
  code; refusal names the cap. Unverified: a wake input entry's kind is
  `satan.wake`.
- inq-7: accept topic capture (wake targets are fixed at schedule).
- inq-8: room only, like wakes.
- inq-9: daemon journal lines; threads appear in `--list`; nothing more.
- inq-10: tool descriptions + a short `threads` section in the extension;
  `interactive.txt` unchanged.
- inq-11: out of scope.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · design/inquiring (run rev 11) · adfa93a

### Produced
- RSK-002, RFC-003 (framing, committed before the slice)
- `research/research.md`; EVD-002 (fork inside a tool call)

### Learned
- EVD-002

### Open
- inq-1..inq-11 in the design run; proposals above await the operator
- RFC-003 OQ-1, OQ-2, OQ-4, OQ-7, OQ-8
- memory `mem.fact.malebolge.src-seam` has a broken body (`@/tmp/rv/mem.md`)
