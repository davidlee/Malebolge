# Implementation Plan SL-002: List conversations and attach to one from Emacs

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

SL-002 is one mechanism in four layers, and the layers are the stack's, not the
slices' convenience. A first-line frame has to exist before a client can ask for
it; the client's flag has to exist before Emacs can shell out to it; the Emacs
path has to exist before the docs can describe what a user does. Four phases,
each ending green on its own.

The shape of the work follows a split the design already made and the scope
already policed: **transport now, policy later**. `list` ships the RFC's
transport — one reply, then a clean close — without deciding topics, labels or
paging, which are RFC-002's steps 2 and 4. That is why the reply is a framed
object rather than a bare array: step 4 widens the frame additively, and this
slice does not have to be rewritten to allow it.

The four phases are:

| Phase | Layer | Proves |
|---|---|---|
| PHASE-01 | daemon | the frame, the page, the clean close, the bound-connection rule |
| PHASE-02 | client | `--list` as its own mode, ids-only output, the generalised skew rule |
| PHASE-03 | Emacs | the prefix-argument picker, its order, its argv, following after a switch |
| PHASE-04 | docs | the shipped vocabulary, stated honestly, and the two claims it falsifies |

## Sequencing & Rationale

**PHASE-01 before PHASE-02 is a contract dependency, not a file conflict.** The
two phases touch disjoint files, but `src/render.ts` imports its printable
vocabulary from `src/protocol.ts`: the `conversations` reply type and the
frame-named refusal must exist before the client can render or classify them. A
parallel start would have PHASE-02 inventing shapes PHASE-01 then has to meet.

**PHASE-02 before PHASE-03 is the flag contract.** The Emacs picker's only
mechanism is a synchronous subprocess of `malebolge-attach --list` whose stdout
is its candidate list and whose non-zero exit is its refusal. `--list` must
settle its output split (ids on stdout, truncation on stderr) before the picker
can promise that stderr never becomes a candidate.

**PHASE-03 carries the expensive half, and it is last for a reason.** The daemon
change is thin; the Emacs change collides with a single-buffer, single-draft,
single-process client. It also carries the slice's only end-to-end evidence
(`just smoke`), which cannot be meaningful until both the frame and the flag
are real. It is deliberately not split: the picker, the detach ordering, the
draft refusal and the post-switch following are one behaviour with one failure
mode — a half-switched editor.

**PHASE-04 is last because it is a description.** It needs PHASE-01's frame
vocabulary and PHASE-03's prompt wording to have settled; writing it earlier
would produce docs that guess. It is a phase rather than a trailing chore
because DEC-010 makes the docs part of the deal: bare ids are only adequate if
the reader is told what an id means, what the page limit does, and how root stays
reachable when the page fills.

**No gate phase.** `just check` is an exit criterion on PHASE-01..PHASE-03,
`just ert`/`just smoke` on PHASE-03 and PHASE-04. A separate gate phase would
have nothing to build.

**Routed review obligations land on the earliest phase that can prove them.**
RV-005's five `demonstrate` findings are transcribed into criteria, each cited
inline where its evidence lands: F-1 and F-11 in PHASE-01 (the bound-connection
refusal, the well-formed `list` that used to write nothing); F-4 and F-2's
consumer half in PHASE-02 (the coded-error exit, the stderr truncation line);
F-5 and F-3 in PHASE-03 (the switch order, the smoke obligation); F-2's docs
half in PHASE-04 (root reachability when a page fills). None is left to prose
alone — each names a test or a gate that fails without it.

## Notes

**The tests are the deliverable, not the criteria.** Every VT mandate names a
real test file and a distinctive string that must exist in it after the phase
lands — usually the exact title of the test that proves the criterion, so the
mandate cannot be satisfied by a comment. The VT gate is inert without keywords,
so the keywords are chosen to be load-bearing rather than generic.

**Where a test cannot judge, the criterion says so.** Prose correctness in
PHASE-04 and seam discipline in each phase are `VA` (agent judgement over the
diff), not a keyword search pretending to be a test. The optional human read in
PHASE-04 is `VH` and is explicitly optional: it informs, it does not gate.

**Design premises were re-grepped at plan time.** Every concrete reference in
`design.md` — `AttachRefused`, `firstLine`/`laterLine`, the one-commit read in
`conversations.ts`, `SKEW`/`SKEW_HINT`, `attach-main`'s coded-error exit,
`Printable`, the Emacs target plumbing and its comint following, the smoke's
attach-only fake, the skew fake, the task-owned and malformed-second-attach
fixtures, the `just` gate, and pi-durable's `scanConversations`/`Page`/
`ROOT_CONVERSATION_ID` — still resolves at the cited site. No premise was stale,
so the plan did not have to loop back to `/design`.

**Research was re-baselined, not re-run.** The advisory flagged `design.md` as
changed; the change was RV-005's own amendments landing after the first stamp,
not research drift. Every Thread 2 fact was re-read against the tree, all held,
and the baseline was restamped with that recorded in `research.md`.

**Three implementation risks, named now so the phases carry them.**

- The page-bound test needs `LIST_PAGE + 1` (51) ownerless conversations. That
  is affordable only because the test harness is the in-memory faux harness —
  one commit creating 51 conversations, then `conversationIds()` as the oracle.
  If it turns out slow, the honest fix is a smaller named constant for tests,
  not a weaker assertion.
- `finish` writes and then ends the socket. The tests must assert the reply
  *arrives before* the close (`lineClient`'s `closed()` is the seam), or the
  phase will pass while racing.
- **The gate is measured, not assumed, and it is red at base here.** Run at
  `f13caae`: eslint and tsc clean, `biome format .` clean (2.5.15 — the pinned
  version, but only via the PATH binary; `npx biome` resolves the checkout's
  glibc-linked one and cannot exec — IMP-001 owns that packaging fix), `just ert` 24/24, `just smoke` 3/3, and
  `npx vitest run` 11 red — every one under `test/runner/`, caused by this
  container (`git` is the pi agent's guard shim; `GIT_GUARD=off` clears 4) and by
  the absence of a room/pi-env (the other 7). None of it touches a file this
  slice edits. So PHASE-01/EX-7 is written as *no new failure*, not *all green*:
  that is the regression guarantee, and it is the only honest form of the
  criterion in an environment whose base is red for reasons outside the slice.

**Deliberately out of scope, so a phase cannot drift into it:** sharing one
fake-daemon fixture between the attach tests and the Emacs smoke (IMP-003 — the
smoke grows its own `list` reply here); the first-line-verb split, topics,
labels, paging, `--here`, and the version handshake (RFC-002 steps 2–4, satan
ISS-055); and satan ISS-053's SPEC-002 row for the client socket.

**Critical pass over the first draft (same sitting).** Four things were
under-specified, and the plan was revised before it was materialised:

- *The client could pass every test and still re-sort.* PHASE-02/EX-2 now says
  the ids are printed **in the order received**, which is what makes the scope's
  "newest first" a composition of two proven halves rather than an accident.
- *The composition proof was unstated.* The scope's first done-criterion spans
  daemon and client. The plan now names why it holds: one declared frame type in
  `src/protocol.ts`, so a shape mismatch is a type error — rather than inventing
  shared fixtures (IMP-003) to paper over the seam.
- *The Emacs half assumed a live socket for its tests.* PHASE-03/EX-2 now
  requires the listing call to be a stub-able seam, matching how the suite
  already stubs `make-comint-in-buffer`; otherwise the picker is untestable
  headlessly and only the smoke would cover it.
- *Two scope criteria had no home.* The transcript naming the conversation, and
  `C-c C-q` still detaching with the conversation left running, are now
  PHASE-03/EX-5 and a new PHASE-03/EX-9 (appended — ids are immutable). Both are
  regressions the slice could plausibly break while implementing the switch.
