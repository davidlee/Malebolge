# Notes SL-002: list conversations and attach to one from Emacs

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet or the design run's runtime state that must survive
`rm -rf` of `.doctrine/state/`.

## Scope, twice

Scoped 2026-10-23 against RFC-002's *pre-refresh* text, then corrected the same
day when the RFC's refresh landed (`9c6a193`): D1-D7 accepted in principle, OQ-4
answered, OQ-3 handed to satan IMP-053, and a four-step sequence that names this
slice as step 1 — "a `list` frame returning bare ids, `malebolge-attach --list`,
and a target for `M-x malebolge-attach`".

Two proposals withdrawn because the RFC already answers them:

- **Listing labels.** I proposed carrying `cwd` (cheap: one
  `harness.snapshot(AgentDoc, id, ctx)`, `AgentState.cwd` exists) and/or an
  excerpt of the opening user message (`UserEntry.is` over `tx.scanEntries`).
  RFC-002 D4 decides exactly that shape — title if set, else the latest IDE-017
  intent entry, else an excerpt of the first user message, derived at read time
  and never stored — and sequences it to step 4, after the index it reads from.
  Implementing it here would have built a strict subset ahead of its own inputs.
- **`--here` / attach-by-directory.** Under the `room` profile a conversation's
  `cwd` is a room path and a shell's is a host path, so the lookup silently
  misses. RFC-002 D1 keeps it in the topics work.

## Design run

Run `dr-01a16771-…`, exploring → inquiring → (drafting). Explore runbook
discharged, governing context and concern graph confirmed by the user on
2026-10-23 ("agreed, agreed"), sufficiency accepted on the same day.

inq-1..inq-4 → DEC-007..DEC-010. One deliberate deviation from the scope's
literal text, recorded in DEC-007: the listing is **newest first** (id
descending), because a page limit with ascending order would trim the newest
conversations — exactly the ones a returning client wants.

## Informal critical pass (2026-10-23)

Requested by the user before drafting: "throw the inq graph at another
(deepseek/pi) agent for an informal critical pass". Run as a `reviewer` subagent
pinned to `llm-gateway/deepseek-flash` (no `pi` agent is defined in this setup),
read-only, ten-finding budget, citations mandatory. Nine findings; all nine
accepted on evidence, none contested. Not an RV ledger — informal by request.

| # | sev | finding | disposition |
|---|---|---|---|
| 1 | blocker | scope and research still said "ascending"; doc criterion lagged DEC-007/DEC-010; the slice's OQ-3 still listed as open | fixed in `slice-002.md` (Objective 1, three criteria, OQ-3) and `research.md` (delta 1) |
| 2 | major | an old daemon's answer to `list` is root's **snapshot then the error** (`daemon.ts:176-185`, asserted `test/daemon.test.ts:563-574`, reproduced by the attach skew fake `test/attach.test.ts:195-205`) | DEC-007 + DEC-008 amended; research fact 5 corrected; new criterion "no snapshot, no notices" |
| 3 | major | a *malformed* `list` frame binds root and stays open, because `AttachRefused` is attach-shaped (`protocol.ts` prefixes `attach: `) | one frame-named refusal (`FrameRefused`/`frameRefused`) shared by both first-line frames, always error-then-close; new criterion using `{"type":"list","topic":"x"}` |
| 4 | major | a rejected `list()` strands the socket: `actOn` writes the error and keeps the chain (`daemon.ts:242-249`), and an unbound connection then receives nothing | route through `fail`; criterion + test with a rejecting `list()` |
| 5 | major | ownerless filter and page bound unprovable by the stated criteria (a `map(r => r.id)` passes everything) | two criteria + two tests, using the existing task-owned fixture (`test/daemon.test.ts:507-525`) and `conversationIds()` |
| 6 | major | the Emacs switch leaves point at `point-min` after `erase-buffer` while `comint-scroll-to-bottom-on-output` is nil (`malebolge.el:218-222`, `:163`), so the new snapshot never follows | DEC-009 amended: `goto-char (point-max)` + window point, ERT case |
| 7 | minor | `conversations: [N,…]` is not additively widenable (step 4's labels make elements objects) and discards `Page.next` | DEC-007 amended: `truncated` flag; the element-type change at step 4 recorded rather than assumed away |
| 8 | minor | a synchronous `--list` freezes Emacs for 10 s when the daemon is stopped — the ordinary case for a targeted attach | DEC-008/009 amended: short list wait (~1 s, one retry) + `message`/`redisplay` first |
| 9 | minor | the buffer-local target is redundant with `malebolge--live-process` (`malebolge.el:176-179`) and goes stale after `C-c C-q` | DEC-009 amended: dropped; the transcript's `attached to conversation N` is the only authority |

Lesson worth carrying: the machine's own gates (sufficiency, graph review) do not
read the *scope document* — a decided reversal inside a decision record leaves the
criteria in the scope stale, and a phase could then satisfy the letter of a
superseded criterion. Amend the scope when a decision reverses it, in the same
turn.

## Commits

- `3447149` — the user's in-flight Emacs speaker-face work, committed first so the
  slice builds on a known base (`just ert`: 24 tests, byte-compile clean).
- `3a9d526` — flake, `.codex/config.toml`, the pi-checkout note in `AGENTS.md`.
- `3e0be2d` — scope + research round.
- `04b9daa` — DEC-007..DEC-010.

`.agents/` (doctrine-installed skills) is deliberately left untracked.

## Plan (2026-10-23)

The user nodded the four-phase decomposition at plan time (`ok, go`), so the
proposal recorded in the design-lock handover is now the authored plan: daemon /
client / Emacs / docs, in that order and for the reasons `plan.md` §Sequencing
gives (a shared frame type, then the `--list` flag contract, then the only
end-to-end evidence, then a description that needs settled wording).

One documented deviation from the handover proposal: **no fifth gate phase.**
`just check` is an exit criterion on PHASE-01..03 and `just ert`/`just smoke` on
PHASE-03..04; a gate phase would have nothing to build.

Two things the plan pins that the design left at the seam, recorded so a phase
does not re-litigate them: the composition the scope's first done-criterion
names is proven by **one declared frame type** in `src/protocol.ts` (a shape
mismatch is a type error), not by shared fixtures — IMP-003 stays outside this
slice; and the Emacs picker's listing call must be a **stub-able seam**, matching
how the suite already stubs `make-comint-in-buffer`, so no ERT case needs a live
socket.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-23 · design locked (run dr-01a16771…, rev 37) · plan authored · lifecycle `ready` · gate baseline measured 2026-10-23: lint/tsc/format clean, `just ert` 24/24, `just smoke` 3/3, vitest 11 red all under `test/runner/` (container: git-guard shim, no room)

### Produced
- DEC-007..DEC-010 — `accepted`; the four inquiry dispositions, each with an
  amendments section carrying the informal pass's nine findings.
- `design.md` — six sections (sec-1..sec-6), materialised at rev 32, locked at
  rev 37; attested by att-1..att-6 (adversarial lane).
- `research/research.md` — two threads + `raw/`, baselined; one cited fact
  corrected (an old daemon answers an unknown first-line frame with root's
  snapshot *then* the error).
- RV-005 — design review, 13 findings (6 major), all `fix-now`, verified; the
  six majors route `demonstrate` (evidence is the plan's verification).
- RV-006 — the narrow verification round, kept as its own record (3 findings,
  re-raised on RV-005 so the run's own pass carries them).
- `slice-002.md` — scope amended twice: to the RFC-002 refresh, then to RV-005.
- `plan.toml` — four phases (PHASE-01 daemon, PHASE-02 client, PHASE-03 Emacs,
  PHASE-04 docs) with EN/EX and structured VT mandates; RV-005's routed findings
  are cited inline where their evidence lands (F-1, F-11 → 01; F-4, F-2 consumer →
  02; F-5, F-3 → 03; F-2 docs → 04).
- `plan.md` — sequencing rationale, plus the critical pass that revised it before
  materialisation (order preservation, typed composition, stub-able listing seam,
  two scope criteria given a home: PHASE-03/EX-5 and EX-9).
- phase sheets — four, materialised from `plan.toml` via `doctrine slice phases`.
- memories: `mem.pattern.doctrine.mcp-root-follows-session-cwd`,
  `mem.pattern.doctrine.design-run-one-ledger-per-pass`.

### Learned
- Cross-repo ledger writes must use the target repo's `doctrine` binary; the
  MCP tools root at the session cwd (this misfiled ten findings on satan's
  RV-005, since withdrawn).
- A run keeps one RV pass; second rounds reopen it. Section attestations are
  `att-` nodes. Severe findings need a `route`, and a concluded pass cannot be
  amended onto one — reopen, dispose again with `--route`, verify.
- A research baseline hashes the slice's **intent docs**, so amending `design.md`
  after the round reports drift even when no fact changed. Re-read the Thread 2
  sites, record that they held, restamp — a re-round is not owed for that alone.

### Open
- No open DEC / QUE / ASM. Every decision is `accepted`; no assumption record
  was needed.
- Plan-phase handoff: `/phase-plan` expands the next phase's runtime sheet, then
  `/execute` (or `/dispatch` for confined workers per phase). PHASE-01 is the
  entry point; nothing else can start first.
- `review_pass RV-005 STALE` still prints in the run's status: the pass concluded
  before the final section amendments were attested. Every section's current
  fingerprint is attested, the edge to `locked` was cleared and the design is
  locked — treat the flag as informational, not as an unreviewed section.
- Other repos: satan ISS-053 (SPEC-002 has no row for the client socket, which
  now carries a verb that creates durable state) and ISS-055 (protocol
  handshake) remain theirs.
