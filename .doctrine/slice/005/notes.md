# Notes SL-005: Mail read tools and tool partitioning by profile

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Design triage (2026-10-27, design run revision 5)

Evidence: `research/research.md` (gitignored). Operator direction this session:
native tools; CLI JSON contract; named tool sets in config, selected **per
conversation** for a given execution profile (daemon) or runner mode; a
harness may host a mail-only conversation.

**Operator framing (2026-10-27)**: there is no "everything" set. Each
execution profile or runner mode has a named default set; `room` is in effect
the default (most SATAN MCP tools, no tools on the host cwd). A default may
exist, but none includes mail.

**Constraining governance**
- satan:RFC-020 D5: the interactive conversation's set never includes `mail_*`;
  a triage conversation's set comes from configuration, and mail content cannot
  widen it.
- satan:RFC-019 D6: native tools run in the agent process on the host and
  confine themselves (the mail tools take no paths; their only reach is the
  `screwtape` read verbs).

**Shaping facts**
- pi-durable selects every installed extension for a conversation with no
  `extensions` in its stored agent state (research P2, P3). Per-conversation
  selection fails open unless every conversation carries an explicit list.
- Daemon conversations are created without one (`src/conversations.ts:113-121`),
  and existing stored conversations have none. Installing the mail extension in
  the daemon's registry today would give it to all of them.
- The runner already sets `extensions` per job (`src/runner/run.ts:365-372`)
  and has a named, configured scope per job: `mode` (`src/runner/config.ts:63-70`).

**Open questions** (design inquiries)
- Tool-set model: what a named tool set is, where it is configured, how a
  profile or mode names its sets, and what the axis is called ("profile" means
  execution profile).
- Closing the fail-open default: explicit selection on every create, and what
  happens to stored conversations with no selection.
- Authority: who may choose a conversation's tool set (config only, or a client
  over the attach protocol, bounded by config).
- Mail tool surface: names, parameters, bounds (per call and per run), untrusted
  framing, provenance.
- Screwtape client: binary location, spawn, bounded output, timeout, version
  check, error mapping.
- Cursor and replay: the cursor as input/output; replay-safe reads.

**Risks**
- SL-003 settles fields or the cursor differently from our port: keep the port
  small and the cursor opaque.
- A regression re-opens the default: pin it with a test that creates a
  conversation by every path and checks its tool list.

**Assumptions**
- The triage conversation runs as `david` on the host and can execute
  `screwtape` (satan:RFC-020 D3).
- `~/flakes` installs `screwtape` at a stable path the config can name.

## Prompt ownership (2026-10-28, design run revision 22–28)

- Gap found while drafting: a mail conversation would get the coding prompt
  (persona env file, `interactive.txt`, project context, skills, cwd).
  `interactive.txt` is coding-specific and is the file that overrides
  `scaffold.txt`'s batch `Protocol:` section.
- DEC-029 supersedes DEC-023: a toolset is the complete ordered extension
  list, prompt included; runner gets no `[mode.*]` toolset key yet.
- DEC-030: persona per toolset; `prompts/mail.txt` (corpus) for mode prose;
  the untrusted-data rule in code.
- inq-8 added under inq-1; inq-1 re-pointed to DEC-029.
- Draft sec-3 proposes, without a DEC yet: the toolset *name* in the index
  entry, with `agent.extensions` re-derived at every startup. Reason:
  pi-durable stores a selection as a frozen name list, so a catalog change
  would otherwise never reach existing conversations. Needs operator review.
- pi-durable facts (read, `dist/harness/agent.js`): a stored list's order is
  the section order; a selected name the registry lacks is silently skipped
  (fails closed: fewer tools).

## Review passes

- 2026-10-28, RV-015, design draft rev 29. Three parallel quotient `review`
  runs (deepseek-flash, thinking max, read-only), one lens each:
  selection/storage (24 req, $0.050), mail trust boundary (29 req, $0.048),
  conformance/tests (20 req, $0.057). Outside material staged in
  `.doctrine/state/slice/005/review-context.md` (runs see only this root).
  ~40 raw findings, merged to 24 on RV-015 (3 blocker, 14 major, 6 minor,
  1 nit).
- Orchestrator-verified: tasks extension omission (code moved under the
  draft: satan SL-034 commits landed mid-session); escaping text lost (my
  authoring: the backslash-u escapes were decoded in the tool input);
  inheritEnv default; boundedLineSplitter vs lineSplitter; screwtape argv
  `--config` first and `--` selection detection; no fork path in src/.
- What pi got wrong or overstated: S-2 (fork fails open) is latent, no fork
  path exists; S-3's proposed catalog-revision hash is heavier than needed;
  M-2's argument against DEC-026's no-cut rule does not hold once per-field
  bounds guarantee a single message fits.

- 2026-10-28, RV-015 responder round (design rev 33): all 24 findings
  disposed (22 fix-now, F-8 aligned on operator ruling, F-24 tolerated).
  Operator calls: profile-dependent toolset lists (tasks room-only);
  contents follow code, name fixed (DEC-029 (6)); no page cut, per-field caps
  with marker plus visible stub for an oversize message (DEC-026 refined);
  held-back future-dated mail sets caught_up (DEC-027 refined).
- **Next pass should probe** (handback to the RV-015 raiser, then a fresh
  adversarial pass): (a) each fix-now disposition against the revised
  sections (raiser verifies or contests); (b) new mechanism introduced by
  the fixes: per-message budget + stub (does any input still exceed
  MAIL_MAX_BYTES: header growth with 20 held-back/cut notices, thread of 100
  stubs?), held-back rule with filters and `since`, reconcile steps 2-4 and
  init-time `configure(tx)` inside `createConversation` (pi applies `agent`
  before `init`: confirm configure inside init is legal and wins), the
  baseline fixture capture order (must precede any code change);
  (c) whether `MAIL_STDOUT_MAX` 4 MiB and the 2 KiB header reserve are
  consistent with the clamps. Operator directive: write a /handover before
  the handback.

- 2026-10-28, RV-015 raiser round 2 (design rev 34). review-context.md
  rebuilt (DEC-024..030 current; screwtape and corpus sections unchanged
  sources). Five quotient `review` runs, read-only: verify-a/b/c (the 24
  fixes by lens) and two adversarial (bounding; lifecycle). ~$0.22 total.
  Result: 20 verified; F-3, F-16, F-17, F-22 contested; new F-25..F-38
  (2 blocker, 6 major, 5 minor, 1 nit).
- Orchestrator-verified: configure inside init is legal and wins
  (pi-durable harness.js:269-272); attach new passes no init
  (conversations.ts:181-183); request.ts:126-130 and attach-main.ts:20
  need --toolset; backfillIndex covers unindexed ownerless conversations,
  so verify-a's "ownerless hole" was wording only (folded into F-34).
- Main theme: the bounding mechanism (F-25, F-26, F-27, F-28, F-30, F-3)
  is escape-blind and stubs whole messages; needs a redesign, not patches.
- 2026-10-28, RV-015 responder round 2 (design rev 36). Operator agreed the
  bounding redesign: rendered-byte sizes, core plus ordered fill, body cut
  to the remainder, no stub; thread/list limit 1-40. Creation: one required
  `toolsetInit` on every path; fork inherits via the index hook; runner
  admission stops writing extensions. DEC-026/027/030 refreshed. All 18
  open findings fix-now (severe ones routed control, F-17 refresh). Round 3
  handback launched (one verifier, one adversary).
- 2026-10-28, RV-015 round 3 (design rev 36 → 38, ~$0.12). 17 verified;
  F-16 contested (my "does not compile" overclaim). New F-39..F-46, all
  fix-now in rev 38 except F-41 (an envelope over 4 MiB stalls mail_new):
  awaiting operator. F-45 reverses F-35's admission change (the admission
  write is the runner's re-derivation). Summary core now 1152 B bound
  (worst 1023), share subtracts newlines.
- 2026-10-28, F-41 operator ruling (option 1 + screwtape backlog): at
  limit 1 a ceiling failure falls back to `listAfter` (list --after, limit
  1), shows the core marked `unreadable`, advances `next`. Design rev 40;
  DEC-026 updated; screwtape IMP-002 filed. Round 4 handback launched
  (one combined verify + attack run).

- 2026-10-28, RV-015 round 4 (rev 40, ~$0.06): 8 verified; F-43
  contested (mail_new items: summary core or read core? likely a
  clarification: summary core plus body in the fill); new minors F-47
  (unreadable pass two-call race), F-48 (escaped next vs header reserve:
  validate cursor canonical form), F-49 (forks bypass create's
  toolsetInit). Operator: handover before the next reviewer.
- 2026-10-28, RV-015 responder round 4 (design rev 41, materialised 42):
  F-43, F-47, F-48, F-49 fix-now. F-43 widened: `bodies` (a list of parts
  with per-part flags) had never been projected; it now folds into one
  `body` plus a fixed flag set, and the design names two cores (summary for
  mail_new/list/thread; read for mail_read). Summary worst case 1064 B.
  F-48 sibling: input `after` was not validated before argv; one canonical
  cursor check now covers `after` and every returned cursor (next at most
  278 B). F-49: toolsetInit lost its fork step; forks inherit via the hook
  and AgentDoc asOf. DEC-026 updated; review-context.md and rv-015-full.md
  rebuilt.
- **Round 5 should probe:** the body fold (part order, the `body_flags`
  cut group, `output_truncated`'s two sources); whether any other v1 list
  field sits in a core unbounded; the canonical-cursor rule against
  screwtape's `to_string` for negative ms.
- 2026-10-28, RV-015 round 5 (rev 42, one pi `review` run, $0.03): F-43,
  F-47..F-49 verified; new F-50..F-53 minor, F-54 nit. Responder (rev 43,
  materialised 44): all fix-now. F-50 wrapper charged to HEADER_RESERVE
  (header 1984 B); F-51 `in_store` in thread cores; F-52 repaired
  differently: body flags (max 142 B) moved into mail_new's core, the
  `body_flags` cut group dropped; F-53 reconcile refuses a fork entry with
  no toolset (verified src/topics.ts:82-85); F-54 rationale reworded.
  DEC-026 updated; context rebuilt. Round 6 handback launched.
- 2026-10-28, RV-015 round 6 (rev 44, $0.02): F-50..F-54 verified; new
  F-55 major (my F-53 refusal would refuse stored pre-slice forks, which
  backfillIndex writes with a parent) and F-56 nit (flag bytes: exact max
  141, mail_new worst 1192; raiser's recount was also off). Both fix-now
  in rev 45 (materialised 46).
- 2026-10-28, round 7 (verify only, $0.01): F-55, F-56 verified. RV-015
  concluded: 56 findings, all verified. Operator chose verify-then-review
  over waiving.
- 2026-10-28, simplification (operator ruling, design rev 47, materialised
  48). Operator asked whether the design had become a mousetrap; the review
  rounds had accreted edge machinery. Cut: (A) fork and task-owned
  inheritance: the reconcile now refuses either, naming it; designed
  mechanism parked in IMP-017 (operator: forks and task-owned conversations
  are likely later, e.g. heartbeat, mail triage). Verified that wake tasks
  are conversation-owned tasks, not task-owned conversations
  (src/wake/task.ts:139), so nothing today hits the refusal. (B) the
  unreadable pass and `listAfter`: at limit 1 the ceiling fails with no
  next; screwtape IMP-002 is the fix (supersedes F-41 ruling). (C) per-field
  caps: fill fields whole or left out; only core subject and message_id
  shortened. Core worst cases 1040 / 1164. DEC-026 updated. Consistency
  check (pi run hit its request ceiling, $0.02; finished by orchestrator):
  no dangling references; arithmetic holds; pi-durable creates no
  task-owned conversation and never forks on its own (harness.js:68, 267),
  so the refusal hits nothing today; every core field stays bounded.
- 2026-10-28, lock (rev 51): operator "reviewed, conducted, lock it".
  Lock gate refused 14 round-1 severe findings (F-1..F-15 minus F-3) with
  no route; reopened, routed (control x8, probe F-6, refresh F-2, review
  F-7/F-8/F-10/F-14), re-verified by the orchestrator (content unchanged,
  not re-reviewed by pi), RV-015 re-concluded. F-10's response notes the
  operator's 2026-10-28 refusal ruling. Slice status -> plan.
- Lesson: an adversarial reviewer asked to find defects each round always
  finds an edge; weigh each against YAGNI before patching, and stop open
  attack rounds once findings drop to minor.

- 2026-10-28, PHASE-01 (sub-orchestrator). Three quotient `implement`
  runs: baseline capture (28 req, $0.027), RED contract tests from spec
  (32 req, $0.048), implementation (32 req, $0.037). pi got wrong: id
  normalisation rewrote the id in every string (narrowed by orchestrator);
  impl added an unreachable `build` throw duplicating `requireInstalled`'s
  message (accepted: type narrowing under `noUncheckedIndexedAccess`).
  Host gate green (2281/2281).

- 2026-10-28, PHASE-02 (sub-orchestrator). quotient `implement` runs:
  RED tests (45 req, $0.073), implementation (61 req, hit the 60 ceiling,
  $0.067) plus a continuation (21 req, $0.020). pi got wrong: its first
  VT-3 admission test replayed the configure call itself (a run.ts still
  writing the registry list would pass); re-briefed, the impl run added a
  run-fixture test with a negative control. Impl left run.ts unformatted
  (biome not runnable in its form); fixed on host. Host gate green
  (2290/2290).
- PHASE-02 EX-5: src/wake creates only through `conversations.open`
  (src/wake/heartbeat.ts:38); no wake change. The only other
  `createConversation` callers are src/conversations.ts and
  src/runner/conversations.ts.
- 2026-10-28, PHASE-03 (sub-orchestrator). quotient `implement` runs:
  RED tests (34 req, $0.048), implementation (61 req, hit the ceiling,
  $0.075), continuation with five orchestrator rulings (36 req, $0.053).
  pi got wrong: none of substance; its reconcile carried a dead "no index
  entry" check and a two-pass step 3 (simplified by the orchestrator:
  entryToolsets returns an array). Host gate green (2300/2300), `6185372`.
- 2026-10-28, PHASE-04 (sub-orchestrator). quotient `implement` runs:
  RED tests (32 req, $0.049), implementation (17 req, $0.028). pi got
  nothing material wrong; it shared one set/clear/leave helper between
  --dir and --toolset as briefed. Host gate green (2340/2340), `ef28d62`.
- 2026-10-28, PHASE-05 (sub-orchestrator). Claude Sonnet `capsule-worker`
  wrote the RED contract tests (263 tests, contract fixtures, helpers;
  checked them against a throwaway reference implementation and 16
  mutations). quotient `implement` run wrote src/mail (27 req, $0.088),
  green first time. pi got nothing material wrong; it left a duplicated
  cut helper (merged by the orchestrator) and noted the list schema let
  both `offset` and `after` through (fixed with a test). The orchestrator
  re-ran 6 mutations against the real code (raw measure, no reserve,
  dropped body, no `&` escape, raw received_at, 7 message ids): each
  caught. Host gate green (2603/2603).
- 2026-10-28, PHASE-06 (sub-orchestrator). API fixed in
  `.doctrine/state/slice/005/p06-api.md`. quotient `implement` run T1
  extracted src/bounded-exec.ts with its own tests and moved grep onto it
  (28 req, $0.048); grep's existing tests unedited, one count-mode test
  added. Claude Sonnet `capsule-worker` wrote the RED adapter contract
  tests (396 tests; checked against a throwaway reference and 6 mutants).
  quotient `implement` run T3 wrote src/mail/screwtape.ts from the
  reference (16 req, $0.035), green first time. pi got nothing wrong; it
  noted (accepted) that mail's "line" breach is unreachable behind an
  equal total ceiling (same error either way; the line path is pinned in
  test/bounded-exec.test.ts) and that the abort tests check only "not a
  MailSourceError". The orchestrator typed the violation set and re-ran 7
  mutants (inheritEnv true, extra PATH, breach ignored on exit, retry text
  at limit 1, exit 3 accepted, kind unchecked): each caught. Host gate
  green (3013/3013).
- 2026-10-28, PHASE-07 (sub-orchestrator). First the PHASE-06 fix
  (`bac193a`, orchestrator-written: usage `reason` from the first
  error-level stderr line, warning-first case, `code`-only control). API
  fixed in `.doctrine/state/slice/005/p07-api.md`. Claude Sonnet
  `capsule-worker` wrote the RED tests (158 in test/mail/tools.test.ts,
  VT-4 in test/daemon-sections.test.ts, a recording fake MailSource in
  mail-fixtures.ts). quotient `implement` run wrote src/mail/tools.ts and
  extension.ts (46 req, $0.072) and correctly reported 3 tests it could
  not pass without editing them: a lone "-" echo check against a fixed
  message containing "-", a held-back cut case whose item fit limit 2's
  share, and the VT-4 render without selecting `mail` on root. The
  orchestrator fixed the three tests (exact-message equality kept; limit
  20; explicit `selectionOf(["mail"])` as persona VT-3 does). pi also found
  that `isJmapId` admits a leading "-" (see autonomy log). Mutants re-run
  by the orchestrator (next past held back, caught_up ignoring held back,
  oversize message passed through at limit 1, no 10-minute skew, no joint
  clamp, leading-"-" id accepted): each caught. Host gate green (3214/3214).
- PHASE-02 carry-forward: VT-1's mail case calls `toolsetInit` with a
  policy seam allowing mail; PHASE-08 (room allows mail) should exercise
  it through `conversations().open`. Runner start's installed-name check
  is unit-tested via `requireInstalled` only (startRunner hardcodes its
  two extensions). `assignTopic` stays in src/topics.ts: no src caller
  left, but tests use it and IndexDocument may not be named outside
  topics.ts.
## Planning (2026-10-28)

- Plan authored: 8 phases, two tracks (toolsets 01-04, mail 05-07) joined
  by 08. Rationale in plan.md. Premises re-grepped against 6cfd57f: all
  design file/symbol references hold.
- Routed RV-015 control/probe findings transcribed into VT `expects`;
  F-28, F-40, F-41 in their rev-47 (simplified) form.
- Plan choices beyond the design: room allowed set stays `interactive`
  until PHASE-08 (installed-name check would otherwise refuse room starts);
  `IndexEntry.toolset` optional in PHASE-02, required in PHASE-03; property
  test as a seeded loop (no fast-check); `bounded-exec` added to
  RUNNER_ROOTS (grep is a runner root).
- Screwtape SL-003 publishes no fixture files (screwtape DEC-030): v1
  fixtures are transcribed from its README § Contract and tests at a
  recorded commit (screwtape at e61d01b when planned).
- Wake's heartbeat creates through `conversations.open` (heartbeat.ts:38),
  so it passes toolsetInit; PHASE-02 EX-5 confirms.
- Slice status -> ready. Nothing committed (operator: commit when asked).

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-28 · ready (plan authored, 8 phases) · 6cfd57f (SL-005 doctrine files uncommitted)

### Produced
DEC-029 (supersedes DEC-023), DEC-030; DEC-026/DEC-027/DEC-030 refined (rounds 2-4); RV-015 (56 findings, all verified, concluded); design.md locked rev 51 (materialised 52); IMP-017; inq-8; screwtape IMP-002; plan.toml/plan.md (8 phases).

### Learned
quotient memory refreshed (quotient-sandbox-limits); design-review-yagni memory (stop attack rounds once minor); pi-durable selection facts in this file's "Prompt ownership"; pi-durable create order (hook, agent, init) confirmed at harness.js:269-272.

### Open
/phase-plan SL-005 PHASE-01 next (its first step is the baseline capture, RV-015 F-32). IMP-017 (fork/task-owned toolsets) and screwtape IMP-002 (list-field bounds) parked; IMP-015 (byte budget, deferred); ~/satan-corpus/prompts/mail.txt draft (operator repo).

## Implementation run (2026-10-28, /super-orchestrator)

Standing rulings from the operator (tier 1), binding on every charter:

- **Mail fixtures need operator confirmation before entering the repo.**
  Raw screwtape dumps: `~/.local/state/malebolge-sl005-raw/` (outside the
  repo, mode 700; never readable by pi). Scrubbed set:
  `.doctrine/state/slice/005/mail-scrubbed/` (gitignored). PHASE-05 may copy
  the scrubbed set into `test/mail/fixtures/` only once the seat records the
  operator's confirmation below.
- **Confirmed 2026-10-28** (operator, "Yes, commit as is"): the scrubbed
  set as it stands in `mail-scrubbed/` (see its `SCRUB.md`) may be committed
  to `test/mail/fixtures/` unchanged, mailbox names included. A re-capture
  or re-scrub needs fresh confirmation.
- Preflight: `biome` added to the flake's shellPkgs (`e0f82e9`); planning
  files committed (`3523209`). In the quotient forms, 4 tests fail that pass
  on the host (`test/runner/collect.test.ts` ×3, `recovery.test.ts` ×1:
  git-guard refuses `git reset --hard`). pi workers treat those 4 as known;
  the host `just check` is the authoritative gate.
  In the forms `biome format .` also reports "Found 4 warnings" that the
  same biome 2.5.15 does not report on the host; treat as a form quirk.
- quotient policy maxima per pi run: 60 requests, 280k context tokens, $1,
  900 s; a ceiling above one is refused, not clamped. pi runs see only this
  root: hand them spec files under `.doctrine/state/slice/005/`, not the
  session scratchpad. biome is on PATH in the forms: tell workers to run
  `biome format --write <their files>`.
- A targeted test run (`npx vitest run test/mail`) fails the global 85%
  coverage threshold: workers add `--coverage.enabled=false`. A phase that
  touches `package.json` or the lockfile also runs `nix build .#runner`
  (`just check` does not see a stale `npmDepsHash`).
- Seat, PHASE-05 autonomy item 1 (typebox declared directly): accepted as
  in-envelope: design sec-4 and the PHASE-05 objective name TypeBox, and
  1.3.27 was already locked transitively. Flagged for the operator.

## Autonomy log
- PHASE-01: baseline capture committed alone (976262d); conversation-id normalisation narrowed to the `conversation` section (pi's version rewrote the id in every string). Why: EN-2 order checkable from git; avoid a false match on id "1". Tier: decide.
- PHASE-01: API fixed by the orchestrator beyond the design's names: `DaemonToolset`, `allowedNames`, `requireInstalled(names, installed)`, `requirePersonaFiles(corpusRoot, profile)` (personaFiles made pure); `toolsets.ts` takes `import type { Profile }` from config.ts (structure test checks direct edges only). Why: design sec-2 names the behaviour, not the helpers. Tier: decide.
- PHASE-02: `toolsetInit(profile, topic, policy = PROFILE_TOOLSETS[profile])` gains a test seam; `selectionOf(names)` passes name-only extension references to `configure` (pi-durable stores names only); `toolsetList("job")` overload so the runner needs no profile. Why: room allows only `interactive` until PHASE-08, so VT-1's mail-topic case needs a policy allowing mail; the runner has no execution profile. Tier: decide.
- PHASE-03: `IndexEntry.toolset` required as the reconciled reader type; storage typed by a module-private `StoredEntry` (toolset optional), `storedEntry` reads an entry without toolset as undefined; the hook still writes none, so root's toolset has one writer (the reconcile). Why: EX-3 without casts, keeping the design's path table. Tier: decide.
- PHASE-03: `SessionOptions.policy?` test seam for the reconcile, mirroring toolsetInit's; production never passes it. Why: PHASE-02 VT-1's mail-topic reopen would otherwise be refused while the room disallows mail (until PHASE-08). Tier: decide.
- PHASE-03: `assignTopic` deleted; test fixtures create through `toolsetInit` (an index entry without toolset now reads as unindexed). persona VT-3 selects `mail-persona` explicitly (root no longer gets every installed extension). Why: fixtures model production creates; no parallel implementation. Tier: decide.
- PHASE-04: `requireAllowed` takes a string and returns the allowed `DaemonToolset` (the frame's name arrives unchecked; one checker); the disallowed-name refusal is tested at setTopic (test/conversations.test.ts), not in protocol.test.ts, since the frame does not judge names; `--topics` lines gain a third field `TOOLSET` (no Emacs consumer parses them); `toolset` added to the client's skew keys. Why: the policy, not the parser, owns names; design "listing shows it". Tier: decide.
- PHASE-05: `typebox` 1.3.27 declared in package.json (already locked as pi-ai's and pi-durable's exact dependency, so no new package; `Type` already came through pi-ai, and `Value.Check` is only reachable from `typebox/value`); flake `npmDepsHash` updated to match the lock (runner builds). Why: the design's TypeBox validation needs `Value`; a phantom import of an undeclared package was the alternative. Tier: decide (flagged to the seat).
- PHASE-05: `test/mail/fixtures/**` excluded from biome (biome.json). Why: the fixtures are screwtape's bytes, committed as is by operator ruling; biome would reformat them. Tier: decide.
- PHASE-05: fixtures laid out as `test/mail/fixtures/real/` (scrubbed set, unchanged, with SCRUB.md) and `contract/` (transcribed from screwtape README § Contract), provenance and screwtape `e61d01b` in `SOURCE.md`. Header line forms, cut-list placement (last in the core, always present), `truncated_by` as a list in fixed order, and the fill's worst-case reservation of later cut names fixed by the orchestrator (design names the content, not the format). Tier: decide.
- PHASE-05: `ListSchema` refuses a page carrying both `offset` and `after` (contract: exactly one). Tier: decide.
- PHASE-06: bounded-exec split into a pure sink `boundedOutput` and the exec wiring `boundedExec` (outcome exited | stopped | failed; caller abort throws), so grep keeps its collector API and stats; the ceiling counts raw stdout bytes and applies in either mode; ndjson.ts unchanged. Why: design names the parts, not the seams; one splitter. Tier: decide.
- PHASE-06: `MailSourceError { failure }` added to src/mail/source.ts (the port's error, so PHASE-07 tools can tell an oversize failure at limit 1 from others without importing the adapter); spawn_error maps to `screwtape could not run`, other ExecutionErrors propagate; an unterminated last stdout line is a contract violation (`unterminated line`), added to the fixed set; one message for a line or ceiling breach. Why: design's outcome table omits spawn failure and an unterminated line; both fail closed. Tier: decide.
- PHASE-06: exit 2's code is read as the `code` string field of the first non-blank stderr line parsed as a JSON object. The field name is assumed (screwtape DEC-011 not read: no other repo); PHASE-08's smoke should confirm it against the real binary. Tier: decide (flagged).
- Seat, PHASE-06 autonomy item 3 (exit-2 field name), decided: screwtape
  README § CLI at `e61d01b` writes usage diagnostics as
  `{"level":"error","error":"usage","reason":"<fixed code>"}`, one JSON line
  each, and a `{"level":"warning",...}` line can precede it. The adapter
  reads `code` from the first stderr line (`src/mail/screwtape.ts:150`): wrong
  field, fragile line choice. Fix: take `reason` from the first stderr line
  whose `level` is `"error"`; tests updated to the real shape, with a
  warning-first case. Done as a `fix(SL-005)` commit at the start of the
  PHASE-07 charter. Design sec-5's "<code>" means this `reason`: flagged for
  audit.
- PHASE-07: the port's query field is `signal?: AbortSignal | undefined` (src/mail/source.ts), so tools pass `context.abortSignal` as is. Why: exactOptionalPropertyTypes; the adapter's internal Call already used that type. Tier: decide.
- PHASE-07: ids and the mailbox filter are refused when they start with "-", on top of `isJmapId`. Why: the JMAP Id form `[A-Za-z0-9_-]` admits a leading "-", so design sec-4's "so no value can start with -" does not follow from the regex; the refusal makes the stated argv safety true. A real JMAP id starting with "-" would be refused (none seen in fixtures). Design text drift, flagged for audit. Tier: decide.
- PHASE-07: `OVERSIZE_AT_LIMIT_1` applies to mail_new at the clamped limit 1; clamps are reported once per name with the final value (mail_new max_bytes after the joint clamp, a lowered default included); header clamp order limit, offset, max_bytes; `heldBack` always in mail_new's header (0 included), `known gaps` only in mail_new's. Why: design names the facts, not these forms. Tier: decide.
- PHASE-07: the mail tools read their arguments as untrusted JSON (own defaults and type checks), not relying on harness schema validation; MailInputError/MailSourceError become error results, anything else is thrown. Tier: decide.
