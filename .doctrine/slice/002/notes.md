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

## PHASE-01 — the `list` frame, one page, a clean close (2026-10-23)

Implemented in one commit, `ec6c8c5` (the handover allowed "one commit or a
short series"; the frame's type makes a protocol-only commit untypeable without
a half-routed daemon, so the daemon seams went in with it).

What shipped: `FrameRefused`/`frameRefused(frame, problem)` in place of
`AttachRefused` (every shipped `attach: …` string byte-identical, pinned by a new
exact-message table in `test/protocol.test.ts`); the strict `list` frame and the
`conversations` reply; `LIST_PAGE = 50` with `list()` reading one descending
`scanConversations` page in one commit and keeping `owner === undefined` only;
`finish(state, value?)` as the one daemon-side close, with `fail` delegating to
it; and `list` refused on a bound connection through both branches RV-005 F-11
names (the well-formed frame never reaches `act`; any `FrameRefused` maps to the
unprefixed `already attached to conversation N`).

**Where TDD bent, recorded honestly.** The protocol tests were written first and
were red for the right reason (`FrameRefused` undefined, 4 failures). The
conversations and daemon tests were written after their seams, in the same
sitting, so red-first could not be shown for them; each key claim was instead
proven load-bearing by **mutation** and reverted:

- `order: "ascending"` → `lists the ownerless conversations newest first` red.
- dropping `|| message.type === "list"` in `laterLine` → the bound-connection
test hangs and fails (5 s), which is exactly F-11's silent-write regression.
- an extra `writeError` before the reply → the VT-1 test fails on the
  one-frame assertion, so "no error written" is real and not incidental.

Three implementation notes a reviewer would otherwise ask about:

- **The reply is not a `Printable` yet.** PHASE-02 owns the renderer and its
  `render.test.ts` case, so PHASE-01's daemon tests decode the frame with a local
  strict decoder (`listingFrame`, narrowed on `isRecord`/`Array.isArray`/element
  `typeof`/the `"truncated"` key). Recorded as
  `mem.pattern.malebolge.frame-decoder-before-renderer`.
- **The test teardown list is `{ close: () => void }[]`**, not
  `LineClient<Printable>[]`: one afterEach closes clients of either frame
  vocabulary, so the second frame needed no second list.
- **`LIST_PAGE` is deliberately not the runner's `PAGE_SIZE`**
  (`src/runner/durable-ids.ts:11`, 64): different store, different concern, and
  DEC-007 names the daemon's value.

Gate at phase end: biome/eslint/tsc clean, `npx vitest run` 1815 passed / 11
failed — the 11 are exactly the `test/runner/*` container set, +13 new tests over
the 1802 baseline; `just ert` 24/24; `just smoke` 3/3. `test/structure.test.ts`
untouched: no new module, no moved import edge.

## PHASE-02 — `--list`: one frame, ids on stdout, its own wait (2026-10-24)

One commit: the renderer's `conversations` case, the fourth invocation shape, the
skew predicate, `NotListedError` and its reader, and `attach-main`'s one dispatch.

**TDD held this time — red first for all three units**, each red for the right
reason and recorded before the seam was written:

- renderer: `TypeError: handlers[type] is not a function` at `dispatch`, i.e. the
  mapped `Handlers` had no `conversations` case (the type and the runtime agree).
- invocation: `CACError: Unknown option --list` surfacing as the `UsageError` the
  parse already makes of every `parseArgs` throw.
- reader: `TS2305: no exported member 'listConversations'` and six failing cases.

Five mutation checks, each reverted, each caught by exactly the intended test:

- no truncation write → `writes one truncated line to stderr for --list` red.
- a silent close settling as success (`if (!state.answered)` → `if (false)`) →
  `reports a close before any reply through NOT_LISTED` red.
- rendering every frame instead of its own two → `ignores the snapshot a pre-list
  daemon sends first` red (the snapshot would print to stdout).
- `LIST_WAIT` timeouts at attach's 10 s → `gives up on its own short LIST_WAIT` red.
- re-sorting the ids the daemon sent → both listing-output tests red, which is
  what "it never re-sorts" is worth.

Implementation notes a reviewer would otherwise ask about:

- **The attach arm of `AttachInvocation` is untagged** (`mode?: undefined`). EX-1
  writes the union as `{mode:"attach",…} | {mode:"list",wait}` but also says the
  three attach shapes parse exactly as shipped, and EX-6 requires every existing
  `test/attach.test.ts` expectation to pass unchanged — `:569-583` asserts that
  object with `toEqual`. Both hold only with the shipped shape; `mode` is the one
  slot the list arm adds. `attach-main` still dispatches on `invocation.mode`.
- **`listConversations` takes an `errors` sink**, not `process.stderr`: EX-2's
  parameter list has no second stream but requires the truncation line on stderr,
  and a dead daemon's connect notice must not land on stdout either. `attach-main`
  supplies both streams, so the module stays off `process.*`.
- **The truncation line states the cut, not the page size.** `LIST_PAGE` is the
  daemon's constant (`src/conversations.ts:37`); a client printing 50 would own a
  claim it cannot check. PHASE-04's docs state the number.
- **The reader settles on the daemon's close, not on the reply**, so nothing is
  reported before the connection is done with. It ends *its own* socket only on
  failure, because an old daemon binds root and never closes.
- The listing's one-line frame is typed `ListMessage` (`src/protocol.ts`), so a
  client/daemon shape drift is a type error — that shared type, not a fixture, is
  what composes.

Gate at phase end: biome/eslint/tsc clean, `npx vitest run` 1824 passed / 11
failed — the 11 are exactly the `test/runner/*` container set, +9 new tests over
the 1815 baseline; `just ert` 24/24; `just smoke` 3/3. `test/structure.test.ts`
untouched: no new module, no moved import edge.

Beyond the suite, the CLI was exercised for the two contracts a unit test cannot
see: `node src/attach-main.ts --list --new` → exit 2, one line plus the usage, no
connection; `--list` with no daemon → exit 1 after 1.06 s, one stderr line, empty
stdout; and against a fake daemon on a pipe, `--list` wrote exactly `9\n7\n3\n`
(checked with `od -c`) and exited 0.

## PHASE-03 — Emacs: a target under a prefix argument (2026-10-24)

One commit: the picker behind a prefix argument, in the fixed order list →
prompt → draft check → detach → attach; the chosen target becomes argv; every
window follows after the switch; and the smoke's fake daemon learns a `list`
reply. 12 new ERT cases (24 → 38 by way of two real-process listing cases) and a
fourth smoke check.

**TDD held: red first for every unit.** Fourteen cases failed for the right
reason before the seam existed — `void-function` for
`malebolge--attach-arguments`/`--target-label`/`--conversation-candidates`/
`--await-exit`, `wrong-number-of-arguments` for `malebolge-attach` without its
prefix argument — and the smoke check failed by timing out because the fake
daemon did not yet answer `list`.

Three things the phase learned that the design did not carry:

- **The listing has no reply timeout.** `LIST_WAIT` is a `ConnectWait`
  (`connectUnixWaiting`), and the listing reader settles on the socket's
  `close`. A server that accepts `{"type":"list"}` and never answers held the
  client for **19 s** in a measured repro. EX-2's "so a stopped daemon does not
  freeze the editor silently" therefore needed the picker's *own* bound:
  `malebolge--list-timeout` (5 s) with `malebolge--await-listing`, which deletes
  the client and signals `user-error`. DEC-009's amendment ("DEC-008's short wait
  bounds the pause") assumed the client bounds the reply; it does not. The
  client-side fix is filed as **IMP-006** and the shape recorded as
  `mem.fact.malebolge.list-has-no-reply-timeout` rather than smuggled into this
  phase.
- **`call-process` cannot send stderr to a buffer** (Emacs 31: `wrong-type-argument
  stringp #<buffer …>`; its `(BUFFER STDERR)` form wants a *file name*). So the
  listing uses `make-process :stderr PIPE` with a `make-pipe-process` whose
  sentinel is `ignore`. `:stderr BUFFER` works but appends a `Process … stderr
  finished` line, which would have leaked into the truncation message. The
  separation is pinned by a case that runs a real `sh`, not by the stub.
- **`malebolge--follow` is a guarantee, not the mechanism.** `erase-buffer`
  relocates every window's point marker to `point-min`, which *is* the process
  mark of the emptied buffer, so comint's own following already satisfies EX-6
  after a switch. Removing the *call* is therefore unobservable; removing
  `set-window-point` from the helper is not. The helper stays — DEC-009 mandates
  it, and it survives a switch that does not erase (RFC-002 step 4's
  per-conversation buffers) — but the sheet records which mutation is live.

Two smaller decisions a reviewer would otherwise ask about:

- **The stderr notice is emitted after `completing-read` returns.** A `message`
  before the prompt is replaced by the minibuffer's own prompt before anyone can
  read it; F-12's intent is that the truncation prose is read.
- **A targeted failure signals `user-error`; root keeps its `[status]` line.**
  The shipped root path is byte-identical (its ERT case passes untouched); a
  chosen target refuses instead, because "the user asked for a specific
  conversation, and a silent substitute is worse than an empty buffer" (sec-5
  step 5). `malebolge--start-transcript` carries that difference in `target`
  itself rather than a second flag.

Mutation checks, each reverted, each caught: draft check moved after the detach
→ the draft-bearing-switch case; `--attach-arguments` never naming a target →
the argv cases; a targeted failure writing the shipped `[status]` line → the
empty-transcript case; `--follow` without `set-window-point` → the follow
contract case; stderr merged into stdout → the stream-separation case; the
listing's reply bound widened to 120 s → the bounded-listing case (fails after
30 s); the fake daemon not answering `list` → the whole smoke check.

Gate at phase end: biome/eslint/tsc clean, `npx vitest run` 1824 passed / 11
failed — all 11 under `test/runner/` (the container set), `just ert` 38/38,
`just smoke` 4/4, byte-compile clean with `byte-compile-error-on-warn`.
`test/structure.test.ts` untouched: no `src/` change.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-24 · PHASE-03 complete · code pending, doctrine pending

### Produced
- PHASE-03 done — the Emacs target picker: `malebolge-attach` under a prefix
  argument in the fixed order list → prompt → draft check → detach → attach,
  `--conversation N` / `--new` argv, the bounded listing seam with its own
  timeout, `malebolge--follow`, and the smoke's `list` reply + targeted-argv
  check (12 new ERT cases, 1 new smoke check).
- gate re-measured at phase end: lint/tsc/format clean, `just ert` 38/38,
  `just smoke` 4/4, vitest 11 red, all under `test/runner/` (container).
- IMP-006 — `--list` bounds its connect but not its reply; the picker's own
  bound defends Emacs, the client fix is left as work.
- `mem.fact.malebolge.list-has-no-reply-timeout` — the measurement and its shape.
- PHASE-02 done — `--list` as its own mode: the renderer's `conversations` case,
  the fourth invocation shape on its own `LIST_WAIT`, the generalised skew
  predicate, `NotListedError` and a reader that accepts exactly two frames
  (9 new tests).
- gate re-measured at phase end: lint/tsc/format clean, `just ert` 24/24,
  `just smoke` 3/3, vitest 11 red, all under `test/runner/` (container).
- PHASE-01 done — the `list` frame, `list()`'s one descending ownerless page,
  `finish`, and the bound-connection refusal (commit `ec6c8c5`; 13 new tests).
- gate re-measured at phase end: lint/tsc/format clean, `just ert` 24/24,
  `just smoke` 3/3, vitest 11 red, all under `test/runner/` (container: git-guard
  shim, no room).
- IMP-005 — `doctrine check gate` cannot run here: the justfile has no `gate`
  recipe, so the verb dies at `just gate` (`69929b9`); the phase ran the
  components its criteria name instead.
- DEC-007..DEC-010 — the four dispositions PHASE-02..04 still implement against.
- `design.md` (locked rev 37, att-1..att-6) and `RV-005` (13 findings; the routed
  ones land in PHASE-02 F-4/F-2-consumer, PHASE-03 F-5/F-3, PHASE-04 F-2-docs).
- `plan.toml` / `plan.md` — four phases with EN/EX/VT; `research/research.md`
  baselined (restamped at phase-plan time, no thread needed refreshing).

### Learned
- A `ConnectWait` bounds connecting, not answering: read which promise a named
  wait is actually handed to before describing it as a timeout for the reply.
- `malebolge--follow`'s criterion is already satisfied by the erase's marker
  relocation; when a mutation survives, the mechanism is somewhere else — say so
  in the sheet rather than adding a second test that also passes either way.
- `call-process`'s `(BUFFER STDERR)` wants a file name; only `make-process`
  takes a buffer, and `:stderr BUFFER` pays a sentinel line — a pipe process
  with `:sentinel #'ignore` is the clean separation.
- A test whose process "fails fast" proves the wrong thing: `sleep 30 --list`
  rejects its extra argument immediately, so a bound test on it passes with the
  bound removed. `sh -c "sleep 30"` is what actually hangs.
- mem.pattern.malebolge.frame-decoder-before-renderer — a reply no renderer
  knows yet is decoded strictly in its test; do not widen `Printable` early.
  PHASE-02 closed the loop: the same frame is now a `Printable`, its strict
  decoding test passes unchanged, and the client narrows the type instead.
- mem.fact.malebolge.verify-vt-needs-phase-close — VT attribution reads
  UNATTRIBUTABLE until the phase's conformance boundary closes.
- mem.fact.malebolge.attach-exit-truncates-piped-stdout — `attach-main` calls
  `process.exit(0)` right after an awaited write, and stdout to a pipe is
  asynchronous, so a listing's completeness is something to observe (PHASE-03's
  ERT case captures the numeric stdout lines) rather than assume.
- A two-arm union whose arms differ by *absence* (one has `mode`, one does not)
  is what lets a plan's "becomes a union" and "existing shapes unchanged" both
  hold: `mode?: undefined` on the untagged arm buys the call-site reading
  `invocation.mode === "list"` without touching the shipped object.

### Open
- IMP-006 (above) is the terminal-path fix for the unbounded listing; it also
  makes the picker's own bound a backstop rather than the only defence.
- PHASE-04 next, and it is the last phase: `docs/internals.md` sec-Protocol and
  `README.md` sec-"Which conversation" must describe the frame, `--list`, `C-u
  M-x malebolge-attach`, the 50-conversation page, and the tree's two README
  corrections (RV-005 F-9, F-2-docs).
- No open DEC / QUE / ASM minted by PHASE-02 or PHASE-03.
- The stdout-completeness sharp edge is recorded, not fixed: if a long listing is
  ever truncated under `process.exit`, the fix is `process.exitCode` plus a
  drained stream in `attach-main`, a change to the shipped client idiom that
  wants its own slice or backlog item rather than a phase.
- PHASE-03's two inherited seams held as promised: `--list` prints ids and exits
  0, and every listing failure carries `NOT_LISTED`. The smoke's fake daemon now
  answers `list` itself; IMP-003 (one shared fake-daemon fixture) still sits
  outside the slice, so each fake grows its own reply.
- IMP-004 owns the `justfile`'s `biome` override: until it lands `just fmt-check`
  needs the devshell's biome on PATH (a shell without it cannot run the gate).
- satan ISS-053 (SPEC-002 has no row for the client socket) and ISS-055
  (protocol handshake) remain theirs, not this slice's.

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
  `mem.pattern.doctrine.design-run-one-ledger-per-pass`,
  `mem.fact.malebolge.biome-binary-needs-glibc-loader`,
  `mem.fact.malebolge.runner-suite-red-in-agent-container`.
- IMP-004 — a local dev flake so the gate's toolchain comes from the flake. The
  `justfile`'s `biome format .` (instead of `npx biome format .`) is the in-place
  workaround for this slice, not the fix; IMP-001 is the same destination from
  the room side and both must land as one output.

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
- A native binary built for the wrong libc surfaces as `spawnSync … ENOENT` from
  `npx`, not as "wrong platform": the file exists and is executable, and what is
  missing is the loader. Check `/lib64/ld-linux-x86-64.so.2` before doubting the
  package.
- A base that is red for environment reasons must be *measured* before the plan
  claims a green gate. "No new failure beyond the known set" is the honest form
  of the criterion; "all green" would have been quietly weakened later.

### Open
- No open DEC / QUE / ASM. Every decision is `accepted`; no assumption record
  was needed.
- Plan-phase handoff: `/phase-plan` expands the next phase's runtime sheet, then
  `/execute` (or `/dispatch` for confined workers per phase). PHASE-01 is the
  entry point; nothing else can start first.
- IMP-004 (local dev flake) owns the justfile's `biome` override. Until it lands,
  `just fmt-check` needs the devshell's biome on PATH; a shell without it cannot
  run the gate, and that is environment, not code.
- `review_pass RV-005 STALE` still prints in the run's status: the pass concluded
  before the final section amendments were attested. Every section's current
  fingerprint is attested, the edge to `locked` was cleared and the design is
  locked — treat the flag as informational, not as an unreviewed section.
- Other repos: satan ISS-053 (SPEC-002 has no row for the client socket, which
  now carries a verb that creates durable state) and ISS-055 (protocol
  handshake) remain theirs.
