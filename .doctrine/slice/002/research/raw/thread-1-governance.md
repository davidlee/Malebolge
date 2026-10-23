# Thread 1 — governance applicability (SL-002)

Run 2026-10-23 by the orchestrating agent (no project research agents are
defined in this repo's governance, so the round was run by hand — see
`research.md` §Header).

## Binding constraints

| Source | What it binds | Effect on this slice |
|---|---|---|
| RFC-002 §Wire protocol (open, `related`) | Sketches `{type:"list", topic?, archived?: bool}` → "one reply, then close", and states one conversation per connection. | Our `list` frame is the RFC's sketch narrowed: no topic, no archived filter, because both need the index/topics the RFC defers. The one-reply-then-close shape is the RFC's, not invented here. |
| RFC-002 §Clients | `malebolge-attach` gains flags; Emacs gets "one buffer per conversation … and a `completing-read` picker over `list`". | Endorses the Emacs target objective; "one buffer per conversation" is named but the RFC asserts no canon, so OQ-2 stays open. |
| SL-030 (satan) §Non-Goals, quoted in `slice-002.md` | "Listing, if present at all, returns bare ids." | Caps what `list` may return: ids, nothing else. No titles, no recency, no cwd. |
| SL-030 §Objective 7 (id resolution) | The wire id is a JSON number, a safe positive integer, read with one lookup; unknown and task-owned conversations refused. | The `list` reply reuses that id discipline and the same refusal semantics for anything it hands back. |
| `docs/internals.md` §Protocol | Documents the attach frame, its strict refusal set, and that a connection that sends nothing is never bound. | The protocol section is a shipped doc surface: a new first-line frame must be documented there, not only in code. |
| AGENTS.md (this repo) | Points at `~/.local/src/pi` as the pi checkout; nothing else binding. | No constraint. |

## Checked, not applicable

- **ADRs, policies, standards.** None exist in this repo (`doctrine adr status` /
  `doctrine spec list` report nothing; the corpus has RFC-001, RFC-002 and backlog
  only). Stated reason: this is not a boundary or trust decision.
- **SPEC-002 (satan).** Its Transports table documents cross-container channels;
  the client socket row is already missing and filed as satan ISS-053, which is
  satan's to fix. Stated reason: cross-repo, not this slice's artefact.
- **satan ISS-055 (version skew).** Same repo family, but its remedy is a
  handshake. Stated reason: this slice only has to make the *new* skew (`list`
  against an old daemon) legible; the general fix is the issue's.
- **IDE-010 (native Emacs client).** Stated reason: Emacs keeps comint here; the
  slice's Emacs objective is a target argument, not a transport rewrite.

## Revision candidates

- RFC-002's wire sketch could record that the shipped `list` is topic-free and
  that the RFC's `topic`/`archived` filters remain proposals. Candidate only;
  the RFC stays open and this slice does not edit it.
- satan ISS-055 gains a second data point (a second frame that skews opaquely)
  once this ships.

## Refresh round (2026-10-23, second read)

RFC-002 was refreshed while this slice was being scoped — commit `9c6a193`
("D1–D7 accepted in principle, OQ-4 answered, OQ-3 handed to satan IMP-053").
Re-reading it changes Thread 1 in three ways:

1. **It is no longer "open deliberation" in the old sense.** The user accepted
   D1–D7 in principle on 2026-10-23, pending a detailed review of the text; until
   that review it asserts no canon. So the RFC is now evidence *and* the
   expected-governing source, in a way it was not on the first read.
2. **It names this slice and fixes its payload.** §"Where the single-conversation
   assumption lived" lists "SL-002 (in flight): a `list` frame returning bare
   ids, `malebolge-attach --list`, and a target for `M-x malebolge-attach`", and
   §Clients says "SL-002 adds a target prompt over bare ids. With topics: one
   buffer per conversation, `*malebolge:TOPIC/TITLE*`". Both halves of my OQ-2
   are therefore answered by the RFC's own sequencing.
3. **Listing labels are decided, and they are not this slice's.** D4: a title if
   there is one, otherwise a label derived at read time (latest IDE-017 intent
   entry, else an excerpt of the first user message), never stored. The
   sequencing puts labels at step 4, after the index (step 2) and per-conversation
   project context (step 3). SL-002 is step 1.

Consequence: the earlier notion of putting a label (cwd or opening-message
excerpt) in SL-002's `list` reply is withdrawn — it would implement a strict
subset of D4 ahead of the index it depends on, then be reworked in step 4. D4's
rule also cannot be implemented here: no title exists to read, and IDE-017's
intent entries are unbuilt.

Still open for this slice: RFC-002 step 2 will deliberate "the split between
first-line verbs and attached-connection verbs". SL-002 should add the second
first-line frame and leave that deliberation to its scheduled home.
