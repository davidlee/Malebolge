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

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: <yyyy-mm-dd> · <PHASE-NN | stage> · <head-commit>

### Produced

### Learned

### Open
