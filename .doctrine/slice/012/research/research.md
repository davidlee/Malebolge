# SL-012 research — mail action plans

## Header

- Date: 2026-10-30. Baseline: `research/baseline.toml` (stamped by `doctrine slice research 12`).
- Producers: five quotient `pi_agent` runs, profile `research` (deepseek-flash), read-only.
  Raw output under `research/raw/`:
  - `thread-1-governance.md` — governance applicability.
  - `thread-2-code-map.md` — malebolge code map (first run hit its 60-request ceiling; the
    same session was resumed to write the answer from what it had read).
  - `thread-3-screwtape.md` — screwtape message identity and mailboxes.
  - `thread-4-gnus.md` — Gnus execution mechanics.
  - `thread-5-gnus-native.md` — a Gnus-native (nnselect summary) path, at the operator's request.
- Outside material was staged (gitignored) at `.doctrine/state/slice/012/stage/`: screwtape
  `src/` + README, Emacs 31.1 Gnus sources, the operator's `dl-gnus.el`, `satan:RFC-020`, and
  `doctrine show` renderings of the records below. Citations `stage/...` point there.
- Assembled and verified by the orchestrating agent (Claude Opus 5.5).

## Verification legend

- ✓ — checked by the assembler against the cited site (grep/read).
- unmarked — researcher claim, cited but not checked. Design may load-bear only ✓ rows or
  rows it verifies at point of use.

## Thread 1 — governance applicability

Full detail: `raw/thread-1-governance.md`.

### Binding constraints

- ✓ RSK-002 zones: mail conversations are Q1; their plans are Q2 derivatives, read by the
  operator alone, enacted only by the operator; nothing flows Q1/Q2 → SATAN except through the
  operator. Gap 3: derivatives must stay outside every SATAN read root.
- ✓ `~/.local/state/satan` is one of SATAN's three roots (`stage/satan/RFC-020.md:69-71`), and
  it is malebolge's state root (`src/config.ts:332`). **Plans and the act log cannot live
  there.**
- IDE-005: the agent never writes elisp; trusted elisp validates actions, groups and Message-IDs,
  quotes the rationale as data, and renders Gnus's own headers.
- DEC-062: the precedent for a mail tool with a side effect — closed vocabulary, typed fields, no
  free text, a bounded set with explicit refusal when full.
- DEC-029 / DEC-025: the mail toolset is `mail-persona, conversation, mail`; a new tool reaches
  existing mail conversations at the next restart; no opt-in.
- DEC-049: mail tools hold no egress; the pin test grows to include the plan tool.
- DEC-061: model-visible errors carry the `malebolge: ` prefix; untrusted text goes through
  `src/untrusted-block.ts`.
- DEC-063: withheld mail keeps its id. The agent can propose actions on mail it never read; the
  Gnus-header render is the mitigation. Design owes an explicit rule.
- DEC-028: fail closed — an invalid line refuses the whole call, nothing stored.
- DEC-055 / ASM-010: a host path the daemon needs is an env-configured absolute path, refused if
  relative, explicitly denied when unset.
- DEC-002 / DEC-016: a new attach frame widens the protocol, with a deployment-skew cost.
- RFC-003 / DEC-032: mail is in no talk set; the plan tool posts, wakes and sends nothing.

### Checked, not applicable

DEC-026/027 (read bounds, paging), DEC-047…060/077/094 (classify wiring), DEC-023/024
(absorbed by DEC-029), DEC-053 (bookmarks), DEC-013 (index), DEC-034/035/039 (threads),
DEC-064…066/071 (bridge), IDE-006 (digests), IDE-008 step 2 (non-goal), RFC-001/002.
Reasons in raw.

### Revision candidates

- DEC-062 and DEC-026's narrowing note hold the mail tool count (six). SL-012 amends that count
  to seven, not DEC-029, which carries no count. **Scope objective 6 is restated accordingly.**
- DEC-049: the non-egress pin covers write tools too.
- DEC-030 / RSK-002 controls: "You write nothing anywhere" (`prompts/mail.txt`) becomes false.
  ✓ That prompt lives in `~/satan-corpus`, not this repo (`src/persona.ts:36-38`,
  `src/config.ts:337`): a cross-repo change (relates to ISS-007).
- RSK-002: controls gain the plan tool; gap 3 gets its first concrete answer.
- satan:RFC-020: D4 (proposals at `~/.local/state/satan/…`, written by a SATAN triage run, read by
  Emacs and Wormwood) and D6 (Wormwood executes with its own JMAP token) are departed from.
  Record the departure.

### satan:RFC-020 alignment

- Principle kept: "the model proposes, deterministic software validates, the human authorises,
  privileged software executes" (`stage/satan/RFC-020.md:19-21`); Gnus is the privileged executor.
- Worth adopting from D6 (`:384-387`): a declarative, versioned plan; **expected source state per
  operation**; per-operation accept/reject; approval bound to the plan as executed; no replay.
- SL-012 is RFC-020's M4 (schema, validator, preview) plus execution, not M3.
- RFC-020 constraint (`:354-356`): mail-derived text must not become memory or configuration —
  the act log stays out of every corpus and memory store.

## Thread 2 — code map

Full detail (69 cited facts): `raw/thread-2-code-map.md`.

### Hotspots

- `src/mail/tools.ts` — `mailTools`, `mailTool` factory, `idOf`, `mail_report` (the precedent).
- `src/mail/policy.ts` — `REPORT_KINDS`, the closed-vocabulary precedent.
- `src/mail/extension.ts`, `src/daemon-start.ts:192-205` — `MailDeps` wiring.
- `src/mail/source.ts`, `src/mail/screwtape.ts` — `read <id>` gives `message_id` + `mailbox_ids`.
- `src/config.ts` — a plans path, modelled on `MALEBOLGE_BOOKMARK_BACKUPS` (`:132-143`).
- `src/toolsets.ts`, `test/toolsets.test.ts` — VT-2/VT-3 guards.
- `emacs/` + `test/malebolge-ert.el` — new Gnus-facing code; none exists today.
- `README.md:351`, `docs/internals.md:84,137` — still say five mail tools (pre-existing drift).

### Cited facts (load-bearing)

- ✓ The agent never sees a Message-ID: projections drop `message_id`, `in_reply_to`,
  `references` (`test/mail/project.test.ts:130`, `:831-861`). It sees screwtape ids and
  `mailbox_ids`.
- ✓ The mail tool registration is pinned to exactly six names, in order
  (`test/toolsets.test.ts:256-269`).
- ✓ Mail tools are `replay: "safe"` (`src/mail/tools.ts:351`); side-effecting tools elsewhere are
  `"unsafe"` (`src/threads/tools.ts:489`, `src/bridge/extension.ts:64`).
- ✓ Nothing in `src/` or `pi-bridge/` writes a file (no `appendFile`/`writeFile`/stream). The plan
  store is the daemon's first file writer.
- The attach stream reaches Emacs as pre-rendered text, font-locked by label regex
  (`src/attach.ts:1-2`, `emacs/malebolge.el:133-146`). A structured plan over it needs a new event
  type and an Emacs parser.
- `mail_report` volume cap: `REPORTED_MAX = 1000` (`src/mail/tools.ts:69`).
- Elisp conventions: `malebolge-` public, `malebolge--` private; ERT names `malebolge-<behaviour>`;
  `just ert` byte-compiles with warnings as errors (`justfile:19-23`).
- Test helpers: `fakeMailDeps` is the single place a mail test gets deps
  (`test/mail/mail-fixtures.ts:608-620`); `fakeMailSource` fails on an unexpected verb.

### Naming precedents

`mail_<verb>` tool names (→ `mail_propose`); `PLAN_ACTIONS`/`PlanAction` beside `REPORT_KINDS`;
module `src/mail/plans.ts`; errors via `MailInputError`, never echoing the refused value;
untrusted tags `<family>-data`, but a tag longer than `bookmark-data` must update `LONGEST_TAG`
(`src/untrusted-block.ts:18-20`).

## Thread 3 — screwtape identity and mailboxes

Full detail: `raw/thread-3-screwtape.md`.

- ✓ `read <id>` returns `message_id: [string]` (a list, possibly empty) and `mailbox_ids`
  (`stage/screwtape/README.md:184-194`). `list`/`thread` items carry no Message-ID.
  `read <id> --max-bytes 0` returns headers only.
- ✓ Mailboxes are `{id, name, parent_id, role, …}` with JMAP leaf names; screwtape has no IMAP
  path or separator concept (`stage/screwtape/README.md:138-146`).
- ✓ A message moved out of every configured mailbox (for example archived) is dropped from the
  mirror (`stage/screwtape/README.md:518-522`). A plan can outlive its screwtape ids.
- `keywords`, `is_seen`, `is_flagged` give the expected pre-state per message.
- Sync runs on a 15-minute timer; validation is against a store up to one tick stale.
- Lookup failure is `unknown_message`, exit 2.

## Thread 4 — Gnus execution mechanics

Full detail and a code sketch: `raw/thread-4-gnus.md`.

- ✓ `nnimap-request-head` accepts a Message-ID string, resolves it with
  `nnimap-find-article-by-message-id` (`UID SEARCH HEADER Message-Id`), and returns
  `(group . uid)`; the header fetch uses `BODY.PEEK`, so it marks nothing
  (`stage/gnus/nnimap.el:735-750`, `:1154-1183`). The search returns one UID even when several
  match (`car (last …)`).
- ✓ `nnimap-request-set-mark (group ((RANGE add|del MARKS)))`; adding `tick` also adds `read`
  (`stage/gnus/nnimap.el:1243-1265`). **In Gnus, flagging marks the message read.**
- `gnus-request-set-mark` does not update Gnus's local group info; Gnus's own no-summary paths
  also call `gnus-info-set-marks` / `gnus-group-update-group` (`gnus-sum.el:6318-6378`). An open
  summary for the group can push stale marks back on exit.
- ✓ `gnus-fetch-group (group &optional articles)` starts Gnus if needed and opens a summary
  limited to those articles (`stage/gnus/gnus-group.el:2139-2148`). Process-marking them and
  calling `gnus-summary-move-article` does the destination bookkeeping a raw
  `gnus-request-move-article` skips. The researcher recommends this for moves.
- Delete: `gnus-summary-delete-article` expunges (unrecoverable). Moving to `Trash` is a plain
  `UID MOVE`, which is recoverable.
- ✓ Groups are `nnimap+fastmail:<mailbox>`; `dl-gnus-archive-group` = `nnimap+fastmail:Archive`
  (`stage/emacs-config/dl-gnus.el:28`). The operator's archive command wraps
  `gnus-summary-move-article` (`:83-87`).
- Gnus must be running with `.newsrc.eld` loaded, or group info and bookkeeping no-op. The first
  backend call may prompt for a password.
- Execution is not transactional: the act log must append per message as each result lands.

## Thread 5 — Gnus-native path (operator follow-up)

Full detail: `raw/thread-5-gnus-native.md`. Question: can the review and execution lean on
Gnus's existing user-level logic instead of thread 4's hand-rolled calls?

- ✓ nnselect is Gnus's extension point for "these articles, from any groups, as one group": an
  `nnselect-specs` parameter of `(nnselect-function . F) (nnselect-args . A)`, F returning a vector
  of `[real-prefixed-group article-number score]` (`stage/gnus/nnselect.el:26-41`).
- ✓ gnus-search turns `message-id:<…>` into IMAP `HEADER Message-ID "<…>"`
  (`stage/gnus/gnus-search.el:588-589`, `:1296-1297`), returns those triples, and supports `or`.
  A search scoped to the plan's per-line groups avoids a server-wide walk.
- ✓ `gnus-group-read-ephemeral-group` opens the group with `no-article` = t
  (`stage/gnus/gnus-group.el:2262`), so no article is selected and nothing is marked read
  (`stage/gnus/gnus-sum.el:4098-4100`).
- ✓ Moves from an nnselect summary go to the real group as an internal `UID MOVE`, with
  `nnimap-expunge` bound to `immediately` (`stage/gnus/nnselect.el:504-526`).
  `gnus-summary-move-article` does the destination bookkeeping regardless of backend.
- ✓ Marks are written back per real group when the summary closes, **unless it exits without
  update** (`Q`): `nnselect-close-group` skips `nnselect-push-info` then
  (`stage/gnus/nnselect.el:790-800`).
- ✓ `gnus-summary-article-move-hook` runs after each successful move with the article header
  (hence Message-ID), the from-group (the nnselect name, not the real one) and the target
  (`stage/gnus/gnus-sum.el:10280-10286`). Marks have only `gnus-after-set-mark-hook`
  (group + ranges), no per-article hook.
- ✓ `%u<c>` summary-line specs call `gnus-user-format-function-<c>` (emacs 31.1
  `gnus-spec.el:538-539`), so the plan's action and rationale can sit beside Gnus's own From and
  Subject on each line.
- gnus-undo does not cover moves or deletes; gnus-registry is not enabled in `dl-gnus.el`.

Mechanism, in outline: malebolge's plan gives Message-ID + current IMAP path per line → trusted
elisp runs one scoped `gnus-search-run-query` → opens an ephemeral nnselect summary of exactly
those articles, with a line format showing the plan's action → pre-sets process marks per batch
→ the operator uses stock Gnus keys (`B m`, `!`, `M c`, `d`, `&`) or one malebolge command that
applies the batch's proposed action to the marked set → exit writes marks back. Estimated
≈ 75–90 lines of elisp, none of it Gnus-internal bookkeeping (thread 4's path needed manual
group-info updates and its own move loop).

Risks to settle in design or by a live probe: `Q` or a crash drops pending marks (moves are
immediate, marks are deferred to exit); `message-id:` is a substring search, so results must be
diffed against the plan's exact ids; summary order follows Gnus threading/sorting, so marks are
set by Message-ID, not position; the three-way `or` nesting and Fastmail's `UID MOVE` need a live
check.

## Cross-thread findings

1. **Where plans live (RSK-002 × config).** malebolge's state root *is* a SATAN read root. Plans
   and the act log need a home outside it: an env-configured absolute directory (DEC-055 pattern),
   for example under `~/.local/state/malebolge/`. Inference: mail transcripts (Q2) already sit in
   `session.sqlite` under `~/.local/state/satan/durable/<profile>/`. That is a pre-existing
   RSK-002 gap-3 exposure, outside this slice; worth a backlog note.
2. **Identity chain (code map × screwtape × Gnus).** Agent gives screwtape ids → malebolge
   `read <id> --max-bytes 0` → `message_id[]` + `mailbox_ids` → `mailboxes` → mailbox name/role.
   Gnus looks up by (group, Message-ID). Every identity in the plan is derived by malebolge;
   the agent supplies only screwtape ids, actions and target mailbox ids.
3. **Mailbox → Gnus group mapping (OQ-2) — resolved by operator evidence, 2026-10-30.**
   ✓ The operator's Gnus group buffer shows `nnimap+fastmail:INBOX`, `Archive`, `Sent`, `Spam`,
   `Trash`, nested `deduction/fy15`, `readme/newsletters`, and a name with a space,
   `tax invoice`. ✓ The real screwtape fixture (`test/mail/fixtures/real/mailboxes.json`) has
   the same tree as JMAP leaf names with `parent_id` (e.g. `fy15` → parent `deduction`;
   `Spam` has role `junk`; the inbox is named `Inbox`, role `inbox`). Rule: `nnimap+fastmail:` +
   the names along the parent chain joined by `/`, with the role-`inbox` mailbox spelled `INBOX`
   (IMAP's reserved name). Unverified: how a child of the inbox (fixture: `family` under `Inbox`)
   is spelled over IMAP (`INBOX/family` assumed); it is not in the operator's subscribed list.
   Gnus lists subscribed groups only, so Emacs should check that a target group exists on the
   server, not that it is subscribed.
   Note on ids: the ids the agent uses are native JMAP Email ids. IMAP cannot address them, so the
   RFC 5322 Message-ID header is the only identity shared with Gnus.
4. **Re-resolve at execution, in Gnus.** screwtape drops archived mail and is up to 15 minutes
   stale. The plan stores the derived Message-ID, the mailbox it was in, and the expected state
   (seen/flagged) as advisory data. Emacs re-locates each message by Message-ID at execution time
   and logs a miss or a state mismatch instead of trusting the plan.
5. **Delivery (OQ-1): a file beats the attach stream.** The stream is pre-rendered text
   (Thread 2), and a new frame widens the protocol with skew cost (DEC-002/016). Emacs reading
   plan files from the configured directory needs no protocol change.
6. **Flag implies read in Gnus.** A "flag" line also marks the message read; "unflag" does not
   unread it. The review buffer should say so, or the plan vocabulary should name it.
7. **Delete is a move to Trash.** It is recoverable and reuses the move path; expunge stays out of
   scope.
8. **Review must never mark read.** Header display via `gnus-request-head` (PEEK) only; no
   article display path, which runs `gnus-mark-article-hook`.
9. **Approval binds what ran.** Per RFC-020 D6, an edited line is what the log records as executed,
   with the proposed line beside it. That is the act log's edit record (scope objective 5).
10. **The plan tool's replay class.** Today every mail tool is `safe`. A plan write that is
    idempotent per tool call can stay `safe`; otherwise it is `unsafe` like the thread tools.
    Design decides.
11. **The persona premise is cross-repo.** "You write nothing" is in `~/satan-corpus`, and the
    mail prompt section must teach `mail_propose`. The `MAIL_SECTION` in this repo can carry the
    tool guidance (DEC-061), and the corpus sentence needs an operator edit.

## Design-input deltas

- Objective 6 restated: the mail tool count moves six → seven in DEC-062 / DEC-026 / DEC-049 and the
  VT-3 pin. DEC-029 needs no change.
- OQ-1 leans to: plan files in an env-configured directory outside every SATAN root; Emacs reads
  them.
- OQ-2: derived mapping (cross-thread 3). malebolge can compute the Gnus group from the
  `mailboxes` tree, so no config table is needed; one edge (children of the inbox) is unverified.
- OQ-3 answered, two candidate paths:
  - thread 5 (preferred lead): the review buffer *is* a Gnus summary — an ephemeral nnselect
    group built from a scoped gnus-search on the plan's Message-IDs; stock summary commands
    execute; Gnus does the bookkeeping.
  - thread 4 (fallback): `gnus-request-head` per id, `gnus-request-set-mark` plus manual info
    updates, `gnus-fetch-group` + `gnus-summary-move-article` for moves.
- Act log (objective 5) under thread 5: acts are captured from Gnus hooks
  (`gnus-summary-article-move-hook`) and malebolge's own batch command. Edits and drops then show
  up as the difference between the stored plan and the logged acts, rather than as separate
  editing records.
- OQ-6 leans to: JSONL beside the plans, outside SATAN roots, appended per message as each result
  lands.
- New design obligations: a rule for withheld/reported ids in plans (DEC-063); expected pre-state
  per line; caps on lines per plan and plans per conversation; a replay class; the "flag implies
  read" display; the RFC-020 departure record.
- Side findings for the backlog, outside this slice: mail transcripts under a SATAN root
  (cross-thread 1); README/internals doc drift (five tools).
