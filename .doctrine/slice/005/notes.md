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

## Autonomy log
- PHASE-01: baseline capture committed alone (976262d); conversation-id normalisation narrowed to the `conversation` section (pi's version rewrote the id in every string). Why: EN-2 order checkable from git; avoid a false match on id "1". Tier: decide.
- PHASE-01: API fixed by the orchestrator beyond the design's names: `DaemonToolset`, `allowedNames`, `requireInstalled(names, installed)`, `requirePersonaFiles(corpusRoot, profile)` (personaFiles made pure); `toolsets.ts` takes `import type { Profile }` from config.ts (structure test checks direct edges only). Why: design sec-2 names the behaviour, not the helpers. Tier: decide.
- PHASE-02: `toolsetInit(profile, topic, policy = PROFILE_TOOLSETS[profile])` gains a test seam; `selectionOf(names)` passes name-only extension references to `configure` (pi-durable stores names only); `toolsetList("job")` overload so the runner needs no profile. Why: room allows only `interactive` until PHASE-08, so VT-1's mail-topic case needs a policy allowing mail; the runner has no execution profile. Tier: decide.
