# Review RV-028 — reconciliation of SL-007

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

Conformance audit of SL-007 (classified mail), PHASE-01..07, against the
locked design (run rev 71), on the primary tree at HEAD 38a3c8a (SL-007 code
d8d2466). This audit was not dispatched; no candidate branch exists.

Lines of attack:

- **DEC-048 / DEC-094 trust boundary.** Every sender-written text on a shown
  item comes from `seen`, never from the read. Withheld items carry no
  sender text beyond `sender_domains` (src/mail/project.ts).
- **DEC-056 failure table.** A read never fails because classify did. The
  adapter's mapping matches design § One classify(ids) call step 4 row by
  row, and only stable outcomes are cached (screwtape.ts, classifications.ts).
- **DEC-063 pre-filter.** The order is reported, unclassified,
  missing_question (checked before any hostility), then hostile. An id the
  port omits fails closed (policy.ts, tools.ts `screened`).
- **CON-001.** Question names appear only in `WITHHOLD_POLICY`.
- **DEC-049 preconditions.** Refusal happens before argument checks, and the
  network check holds under a real `--unshare-net` jail.
- **DEC-061 framing.** The section, the UNTRUSTED line, the error prefix and
  the description suffix each come from one place.
- **DEC-027.** Screening never changes `next` / `caught_up`.
- Mechanical: `slice conformance`, `slice verify-vt`, `just check`,
  `doctrine check gate`.

## Synthesis

**Closure story.** The implementation matches the design on every
load-bearing invariant probed above. Sender text on shown items is built
only from `seen` (`summaryEntries`, `readParts`, `projectAttachments`).
`projectWithheld` names each field it emits, so no envelope text leaks
through it. The pre-filter checks for missing questions before hostility,
and an id the port omits becomes `failed` (withheld). The cache stores only
`classified` and `too_large`. The cursor is computed before screening.
Question names appear only in `src/mail/policy.ts`. Conformance: 12/12
design-target paths delivered, none undelivered; the undeclared paths are
tests and records (F-8). VT: 21/21 PASS. `just check`: 115 files, 4170 tests
green before the fixes; re-run after the fixes (see notes).

Two code defects were found and fixed in this audit, each red then green:

- F-2: `mail_read`'s parameter schema advertised 32768.
- F-3: the classify mapping read stderr after a timeout, spawn failure or
  breach. A transient failure could then be cached as `too_large` and
  withhold a message until restart.

Two design-text lags go to /reconcile (F-4, F-5).

**Live check (VH-1, PHASE-08, 2026-10-30).** These ran in the deployed room
after home-switch:

1. Every shown item carried `jev` scores.
2. The self-sent agent-directed mail was withheld:
   `hostile`/`agent_directive`, score 0.99. SATAN named it.
3. `mail_report` wrote its journal line and withheld the message afterwards.
   This step exposed F-10: the line's `malebolge: ` prefix was doubled.
   Fixed red/green.
4. Not observable as written, because stopping the bridge also stopped the
   room's model (F-11). The operator accepted unit-test coverage for the
   degraded mapping (choice (a)).

The first attempts saw nothing because the mail post-dated the last sync,
and SATAN filtered on a wrong address from the window's oldest end. Neither
is a defect.

**Standing risks.**

- Deployment residue outside this slice's code. The unit reports
  `LimitCORE=infinity`, while DEC-081 requires 0 (flakes IMP-055). The jail
  launcher starts the :4000 socat twice; the second fails to bind and is
  left as a zombie (satan IMP-060). Both stay on those items.
- The :4000 bridge is shared by the room model and Jev (F-11): a dead
  bridge is a room outage. The degraded mail state is "Jev unreachable
  while the model is up".
- Jev's thresholds are uncalibrated until screwtape IMP-003, and its answers
  can be influenced by an attacker. They act only to withhold, which fails
  safe.
- A Jev outage withholds all mail, loudly.
- `jev` keys and choice labels are classifier-produced strings, bounded by
  `JEV_MAX_BYTES` and safe only while screwtape enforces its schema.

**Tradeoffs consciously accepted.**

- F-6 (IMP-028): default `mail_new` calls report a clamp.
- F-9: `LONGEST_TAG` is a literal; an overflow fails loudly.
- F-7 (CHR-001): there is no `just gate` recipe.

**Hand-off.** Every finding is terminal; the pass concludes, and SL-007
goes to /reconcile.

## Reconciliation Brief

### Per-slice (direct edit)

- design.md § Preconditions (F-4): in the table's "checked from" column,
  replace `/sys/class/net` with `/proc/net/dev` (lists the reading process's
  own netns). In the `mailPart` paragraph, replace
  `readdirSync("/sys/class/net")` with
  `readFileSync("/proc/net/dev")` through the pure
  `interfaceNamesOf`. Add the empty-list rule: a listing naming no
  interface counts as unreadable, since every netns holds `lo`. Add one
  sentence on why: a sysfs bound into a `--unshare-net` jail reflects the
  host's netns.
- design.md § One tool call (F-5): the `projectWithheld` signature's flags
  become `{ heldBack?, inStore?, size? }`, with `size` passed by the tools
  that read a message (`mail_new`, `mail_read`). Drop "`size` only when
  `item` is a read".

- design.md § Reaching Jev from the jail (F-11): state that the jail's
  127.0.0.1:4000 bridge is shared with the room model (gateway-models.json
  `baseUrl`) and predates SL-007. A dead bridge is a room outage. The
  degraded mail state ("unavailable/failed items, withheld and counted") is
  Jev unreachable while the model is up.
- design.md § Verification (F-11): VH step 4 becomes "Jev unreachable while
  the model is up", observed by VT (PHASE-02 VT-2, PHASE-05 VT-2), per the
  operator's 2026-10-30 choice.
- slice-007.md § Risks (F-11): the "Jev outage withholds all mail" risk
  stays. Add that a bridge outage takes the whole room down.

### Governance/spec (REV)

- DEC-049 (F-4): its choice text "reads /sys/class/net once" →
  "reads /proc/net/dev once", plus the reason (sysfs in a `--unshare-net`
  jail lists the host's interfaces). This narrows the mechanism, not the
  decision.

Off-surface, noted only: plan.toml PHASE-04 EX-3 names `/sys/class/net`.
Plan criteria are immutable, so it stays as history.
