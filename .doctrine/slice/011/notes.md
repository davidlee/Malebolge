# SL-011 notes

## Design triage (2026-10-30)

Evidence: `research/research.md` (gitignored; raw thread output beside it).

**Constraining governance**
- DEC-025: a conversation's mode never changes. Pair binds; it never rewrites a mode.
- RSK-002 + operator: mail-mode conversations never reach the bridge.
- DEC-066..070, 072..080, 090, 095..098: bridge mechanics carried unchanged.
- To supersede: DEC-065 (pair creates), DEC-071 (bridge mode). To amend: DEC-029
  (catalog), DEC-032 (talk-set quarantine precedent), DEC-076 (wake reach).
  DEC-092/093 hinge on OQ-1.

**Shaping decisions (operator, 2026-10-30)**
- pi names the conversation id; Emacs-initiated pairing is out.
- Jail text reaching other conversations (threads) is acceptable; jail
  network egress is the jail profile's choice.
- Mail talks to nothing.
- Model is chosen when the operator creates the conversation.

**Open questions → design inquiries**
- Pair target and refusals (inq-1); retiring the mode (inq-2); stored
  `bridge` records (inq-3, OQ-2); section rendering (inq-4); re-pair
  semantics (inq-5); pair without an id (inq-6, OQ-1); origin of
  bridge-started turns under DEC-036 (inq-7); stale pairings on a working
  conversation (inq-8); verification incl. an Emacs path (inq-9, OQ-3);
  the pi command surface (inq-10).

**Risks**
- Retiring `bridge` without a remap makes the room daemon refuse to start
  (`src/session.ts:131-190`).
- Abort in pi downgrades buffered bridge turns to notes (DEC-079/090); more
  frequent now that the bridged conversation is the operator's main one.
  Accepted, unchanged behaviour.

**Assumptions**
- The live room store may hold `bridge`-mode conversations from SL-009's
  VH run (3949, 4524). Not checked; the remap must handle any number.

## Design review (2026-10-30)

Further passes (review.passes): no further design pass. Across RV-029 the
findings narrowed from missing mechanism (pi round 1, GPT rounds 1-2) to one
minor (GPT round 3). The simplicity pass removed F-16's lock: the operator
chose the token-hash check in `boundLine` plus the stated residual. A pi
verify-only pass came back clean. The next adversarial pass belongs to the
plan: phase criteria for F-4 (bridge notes keep the caller's origin), F-15 /
DEC-106 (seq continues across re-pair), F-16's single VT (stale-line
refusal) and F-17 / DEC-107 (untrusted framing on forks).

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-30 · close · 7778f32

### Produced
- design locked 0c2c9f2 (RV-029; DEC-106, DEC-107); plan PHASE-01..08 (3a71ff5)
- PHASE-01 6fd1650 · 02 d8cc727 · 03 f9753d9 · 04 01ef085 · 05 0c762be · 06 18342c0 · 07 acbc325 · 08 docs 934722f — via /super-orchestrator, pi workers only, no Claude spawns
- post-run, operator-directed pi prompt changes: 6eaa43e, ffb8d61 (PI_BRIDGE_ENVIRONMENT), e9698dc (PI_POSTURE_TEXT; touches DEC-040)
- VH-1 waived by operator; live use substituted (613cb4b); checklist steps 3-5 not known live-exercised
- audit flags: all adjudicated on RV-031 (F-1 shapes, F-2 prompt texts, F-10 test dip: only bridge-toolset cases)
- gate `just check` green at 7778f32 (4198 tests); `doctrine check gate` unconfigured (CHR-001)
- minted: IMP-030 (resolved fixed, 7778f32); CHR-009 — drop malebolge flake's hand-rolled bridge jail
- audit RV-031: 10 findings terminal, no blocker; brief → /reconcile (F-1/2/3 design + selectors, F-6 DEC-098); F-4 fixed in audit commit (internals, posture.ts comment, CHR-008 body) · 440963b
- reconcile a22f0ae: design sec-3/4/6/7/8/9, selectors, SL-009 pointers, DEC-098 amended

### Learned
- mem.fact.malebolge.pi-jails-carry-bridge — agents lib mounts the bridge in every pi jail
- mem.fact.pi-durable.section-render-undefined-omits
- mem.pattern.malebolge.vh-through-the-operators-client
- mem.fact.doctrine.design-review-decision-not-in-run
- mem.fact.doctrine.conformance-sweeps-interleaved-sessions — RV-031 F-7

### Open
- CHR-009 — malebolge flake's hand-rolled bridge jail
- CHR-008 — SATAN posture text and turn-policy home remain (body updated, RV-031 F-4)
- IDE-010 — attach-side end (out of scope)

## Implementation run (2026-10-30, /super-orchestrator)

Seat preflight, read by every charter:

- **Host gate:** `just check` from the repo root. The seat's shell already carries
  the flake devshell (direnv), so no `nix develop` wrapper. Green at 664b962:
  115 files, 4177 tests.
- **quotient forms:** `read` and `write` both have node, npx, just, biome, git
  (guarded), eslint, tsc, vitest; network works; `write` root is writable.
  Every `check` sub-recipe (fmt-check, lint, typecheck, test) passes in `write`.
  `emacs` and `nix` are absent: `just ert` and `just smoke` are host-only (not in `check`).
  In `write`, `npx biome` fails (npm binary needs a glibc the form lacks): briefs name
  `biome` (PATH) and `./node_modules/.bin/eslint` (PHASE-03 friction).
- **No sandbox-only failures.** Full suite is green in both.
- **Never run two full `vitest run`s at once** (host and pi, or two pi workers):
  they share `coverage/` and the coverage provider crashes. One full suite at a
  time; workers run targeted tests, the full gate runs serially.
- **Operator inputs:** none needed before PHASE-08. PHASE-08 VH-1 is human-run
  (live room, Emacs, jailed pi). The run stops there; docs (PHASE-08 EX-1) may land
  before it.
- **Other writers:** another session owns SL-012. Leave alone:
  `.doctrine/slice/012*`, `.doctrine/backlog/issue/007*`, `issue/008*`,
  `.doctrine/knowledge/decision/108..117*`,
  `.doctrine/memory/items/mem.fact.doctrine.design-review-decision-not-in-run`.
  Commit by path only.
- **Charters:** [01,02], [03], [04], [05,06], [07], [08 docs, halt before VH-1].

## Autonomy log

- PHASE-01: simplified VT-1's listing case to a lone `wireList` (pi's version paired it with a root attach, which made the assertion unable to tell a counted listing from root). Test-strength fix in phase files. decided
- PHASE-01: accepted pi's reflow of one pre-existing comment in `startDaemon` to stay under `max-lines-per-function` (80). Cosmetic. decided
- PHASE-02: added a contract case beyond the VTs: an unreconciled index entry (no toolset) is refused `no conversation N` (EX-2 names it; no VT keyword covers it). decided
- PHASE-02: pi merged the brief's `attachedTarget` into `pairTarget(host, frame)` (project-length check + id choice, all pre-commit) with `openPairOn` owning the one commit; refusals inside the commit throw and roll back. Design sec-4 names `attachedTarget`; same behaviour, flag for audit. decided
- PHASE-02: `create` in src/conversations.ts un-exported (its only outside user was the deleted bridge create path); dead `GHOST_REF` fixture export removed. decided
- PHASE-03: replaced pi's `holdsPairingToken` (treated an absent snapshot or unset connection hash as "still holds", fail-open) with an inline `doc?.tokenHash !== state.tokenHash` check: fail-closed, both arms unreachable in practice. decided
- PHASE-03: the supersede reasons are two module consts (`SUPERSEDED_BY_PAIRING`, `SUPERSEDED_BY_CONNECTION`); bind's caller data is one `Binding {reason, tokenHash}` object. Same behaviour as design sec-4. decided
- PHASE-04: no split; the churn was five test files (bridge-fixture, bridge-extension, daemon-sections, pi-bridge-shell use the `bridge` extension, not the toolset; EX-4 empty for them). decided
- PHASE-04: `liveToolset` is `t === "bridge" ? "interactive" : t`, no `RETIRED` table: a `Partial<Record>` lookup `RETIRED[t] ?? t` cannot narrow without a cast, and a one-entry table read only after the comparison adds nothing. Same behaviour as design sec-3; flag for audit. decided
- PHASE-04: pi also rewrote the unlisted toolsets VT-2 case pinning `bookmarks` before satan on both profiles (now `bridge` on the room): forced by EX-1, not weakened. decided
- PHASE-04: fixed a stale comment in src/wake/tools.ts ("bridge wakes only bridge"), outside the phase's four src files; comment only. decided
- PHASE-05: no test pins bridge_post's new description clause (EX-3 has no VT; operator rule against prompt-phrase tests); verified by reading the diff. decided
- PHASE-05/06: ran concurrently (file-disjoint: daemon-sections/extension vs threads-admission/origin/admission); one host `just check` covered both, commits per phase by path. decided
- PHASE-06: a `satan.bridge` entry with no readable `data.kind` opens no origin (skipped like a note), not a breach: only a turn is known to be an input. Within design sec-6; flag for audit. decided
- PHASE-06: tests pin callerOrigin (the origin a post carries) rather than an end-to-end thread post, as SL-006's origin tests do; plus a post round-tripping a bridge origin (EX-1, no VT keyword covers it). decided
- PHASE-07: pairing phase is `{ name: "pairing" } & PairRequest` and the pair event `{ type: "pair" } & PairRequest` (flat, not a nested `request` field); EX-2's "content"/"payload" read as the same fields. Flag for audit. decided
- PHASE-07: F-3 shell case asserts `not.toContain(`${PROJECT}-bridge`)` rather than `-bridge`: the fake daemon's socket dir is `malebolge-bridge-*`, which every notice names. Test-strength unchanged for what EX-4 removes. decided
- PHASE-07: simplified pi's pairFrame / pairingPhaseOf to spreads (exactOptionalPropertyTypes guarantees a PairRequest never holds `conversation: undefined`). Same behaviour. decided
- PHASE-08: docs written by pi from a facts brief (`.doctrine/state/slice/011/phase-08-brief-docs.md`); I fixed four phrasings (host sentence, framing sentence, "fork starts unpaired", Reach subject). decided
- PHASE-08: VA-1 read by intent: the remaining `-bridge\b` hits are the current `malebolge-bridge` command / extension dir / powerbar segment and `pi-bridge/` paths, and one `toolset bridge` hit is the retirement log line; none describes bridge mode or a `<project>-bridge` topic. decided
- PHASE-08: phase left `in_progress`; VH-1 (EX-2) is the operator's, checklist under `## VH-1 operator checklist`. decided

## Review passes (pi runs)

- PHASE-01 recon for PHASE-02 (research, $0.02): accurate file:line map, saved to `.doctrine/state/slice/011/phase-02-recon.md`.
- PHASE-01 implement ($0.04, 32 req): red-first, all checks clean; weak listing test (fixed by me). 6fd1650.
- PHASE-02 tests, red (implement, $0.066 + $0.011 continuation): 12 contract cases, red for the right reasons, old create block removed from bridge-pairing.test.ts. Missed the unreconciled-entry case until asked.
- PHASE-02 code, green (implement, $0.041, 38 req): tests unedited, VA-1 empty, all checks clean. d8cc727.
- PHASE-03 tests, red (implement, $0.021, 24 req): VT-1..VT-3, red for the right reasons, no fixture change. Clean.
- PHASE-03 code, green (implement, $0.026, 30 req): tests unedited, all checks clean; one fail-open helper simplified by me. Negative control (restore `nextSeq = 1`): VT-2 fails `[1]` vs `[3]`. f9753d9.
- PHASE-04 tests, red (implement, $0.047 + $0.008 continuation, 56+6 req): hit the request ceiling while linting; tried `git stash` (git-guard refused). Six red for the right reasons, tsc red on the two expected errors; left two eslint-disable comments for the missing export (removed by me after green).
- PHASE-04 code, green (implement, $0.051, 39 req): tests unedited, all checks clean, VA-1 greps clean; flagged the stale wake comment. I simplified `liveToolset`. Negative control (drop the topic write-back): VT-2 fails `bridge` vs `interactive`. 01ef085.
- PHASE-05 tests + clause (implement, $0.026, 32 req): pin tests passed first run by design; negative control (ended -> untrusted alone) fails the ended case. Clean. 0c762be.
- PHASE-06 tests, red (implement, $0.012, 16 req, concurrent with PHASE-05): 3 red for the right reasons, F-4 case green. Clean.
- PHASE-06 code, green (implement, $0.008, 13 req): tests unedited, no import cycle, no other Origin.kind reader affected. 18342c0.
- PHASE-07 tests, red (implement, $0.067, 47 req): 13 red for the right reasons, VT-3 green as expected with an in-test dedupe control (seq 3 after re-pair is re-acked, not injected). One sound deviation (F-3 `-bridge`). Clean.
- PHASE-07 code, green (implement, $0.035, 24 req): tests unedited (diff hash checked), tsc/lint clean, every pairFailed caller passes the conversation; two conditional builders simplified by me. acbc325.
- PHASE-08 docs (implement, $0.027, 19 req): README and internals rewritten from the facts brief, accurate to the code; four phrasings tightened by me; `just check` green. 934722f.
- PHASE-08 (pre-VH-1, operator-directed): `PI_BRIDGE_ENVIRONMENT` now names the `malebolge-bridge send|tee [--turn]` command; it said only bridge_post reaches SATAN. Prompt text outside the design; no wording test (by rule). Flag for audit/reconcile. decided
- PHASE-08 (pre-VH-1, operator-relayed pi feedback): `PI_BRIDGE_ENVIRONMENT` revised — paths count as shared references only with a named commit; verify on your own side; bridge_post starts a turn (pi claimed note-only: false, state.ts kind "turn"); the command's exit codes. Turn policy left to the posture corpus (DEC-040). Flag for audit/reconcile. decided
- PHASE-08 VH-1 (EX-2): operator waived the structured run, 2026-10-30 ("going to skip the structured VH run, i think that was more useful anyway"). Substitute evidence: the operator's live pairing of a jailed pi (deck_of_dwarf) with a room conversation; multi-exchange use with SATAN, and pi's feedback on the prompt. Seat did not observe which checklist steps that covered; steps (3) refusal naming both ids, (4) non-interactive refusal and (5) replacement are not known to have been exercised live (all are VT-covered). Waived by the operator. escalated → user act
- Post-PHASE-08 (operator-directed): `PI_POSTURE_TEXT` placeholders replaced — consult: SATAN as sounding board / second opinion for complex or ambiguous work; delegate: SATAN as the operator's representative with bounded authority, may delegate work. Touches DEC-040 (corpus prose deferred). Flag for audit/reconcile. decided

## VH-1 operator checklist

PHASE-08 EX-2 / VH-1, run by the operator against the live room (SL-009's
store) with a jailed pi carrying this tree's `pi-bridge/`. A failure re-enters
the owning phase (EX-2), not a patch here. Commands run from this repo's root
on the host unless marked "in pi".

Settle what SATAN received from the stored record, not from SATAN's report
(mem.pattern.malebolge.settle-model-input-from-stored-record). Read-only:

```sh
DB=~/.local/state/satan/durable/room/session.sqlite
# pi -> SATAN messages in conversation N, newest first (the envelope as stored)
sqlite3 "file:$DB?mode=ro" "select id, substr(record,1,400) from entries
  where conversation_id = N and record like '%<bridge from=%' order by id desc limit 5"
# SATAN's bridge_post calls in conversation N
sqlite3 "file:$DB?mode=ro" "select id, substr(record,1,400) from entries
  where conversation_id = N and record like '%bridge_post%' order by id desc limit 5"
```

pi side: `~/.local/share/jail.nix/home/agent/.pi/agent/sessions/--workspace-<project>--/*.jsonl`;
a SATAN message is in pi's context once per seq, as one `custom_message` entry.

1. **Restart over SL-009's store.** `systemctl --user restart malebolge-room`
   (or `M-x malebolge-start`). Look for: it starts;
   `journalctl --user -u malebolge-room -b | grep -E 'toolset bridge retired|list changed'`
   shows `topic <project>-bridge: toolset bridge retired, now interactive` and a
   `conversation N: toolset interactive list changed` line per conversation.
   `node src/attach-main.ts --topics`: the old `<project>-bridge` topics show
   TOOLSET `interactive`. `node src/attach-main.ts --list --topic <project>-bridge`
   lists the old conversations; `node src/attach-main.ts --conversation N` attaches
   one. A second restart logs no `retired` line (idempotent).
2. **Pair root with no id.** Only Emacs attached: `M-x malebolge-attach` (root).
   In pi: `/bridge pair consult`. Look for: pi's status line `malebolge bridge: bound`.
   Ask SATAN (in Emacs) to message pi: it calls `bridge_post`, the message
   starts a pi turn; pi answers with its `bridge_post`; `make test 2>&1 |
   malebolge-bridge tee` in pi's `!` lands as a note. Stored record: root's
   entries hold `<bridge from="pi" project="<project>" kind="turn">…</bridge>`
   (and `kind="note"`); send a body containing `<b>` and check it is stored
   escaped (`&lt;b&gt;`).
3. **Two attached, then by id.** Keep Emacs on root; in a terminal
   `node src/attach-main.ts --conversation N` (N another interactive
   conversation). In pi: `/bridge end`, then `/bridge pair consult`. Look for the
   refusal `several conversations are attached (R, N); name one` (ids
   ascending), shown as `malebolge bridge: pairing failed: …`. Then
   `/bridge pair consult N`: bound to N; an exchange lands in N's entries,
   not root's.
4. **Mail refused.** `node src/attach-main.ts --list` (or `--topics`, a mail
   topic) to find a mail conversation M. In pi: `/bridge pair delegate M`.
   Look for: `conversation M has toolset mail, not interactive`; M's entries
   unchanged.
5. **Replacement.** pi session A bound to N (step 3). Start a second jailed pi
   session B and run `/bridge pair consult N` in B. Look for: A reports
   `malebolge bridge: refused: superseded by a new pairing` and its status line
   leaves `bound` (unpaired; A's next `/bridge pair` would start afresh). Ask
   SATAN in N to message pi: B receives it (B's session `.jsonl` gains the
   `custom_message`; A's does not), and its seq continues past A's last one.
