# SL-007 notes

## Design surface triage (2026-10-29)

> Superseded by the inquiry's decisions (DEC-047 to DEC-063, CON-001). In
> particular the "plain, read-only key file" below gave way to DEC-059 (the
> unit decrypts screwtape's credential). Kept for history.

Sources: `slice-007.md`, `research/research.md` (with its addendum), and
operator answers given in the session.

### Shaping decisions (operator, 2026-10-29)

- **Placement.** Answers go on the existing tools, not a new `mail_classify`
  tool (OQ-1). This leaves the DEC-029 catalog unchanged.
- **Cost.** Classify is fast and functionally free. Batch it anyway, on
  principle (OQ-4).
- **Budget.** Answers may sit on top of DEC-026's per-item share, and the
  agent gets only the useful subset (OQ-5).
- **Jail path (e).** Classify runs inside the jail through the gateway
  socket the jail already holds, bridged to loopback. The Jev key is
  provisioned as a plain, read-only key file, which is Jev-only and useful
  only on loopback. The wrapper / `systemd-run --user` route is rejected:
  it needs the user bus, which is a jail escape (research addendum).

- **Quarantine hardening (scope objective 6).** The operator added three
  requirements:
  - framing as untrusted, possibly hostile, never authority or instruction;
  - a self-report protocol for the agent, independent of Jev;
  - a pre-filter that withholds what Jev flags as hostile.

  These are inquiries inq-10, inq-11 and inq-12. The pre-filter is a scoped
  exception to the "no filtering policy" non-goal.

### Open questions → design inquiries

1. Where classification enters the port, and which tools carry answers.
2. What classify reads: a separate fixed-size read, or the tool's own read
   (research X-3).
3. The adapter's invocation: a no-shell spawn with stdin, bounds, timeout,
   and an id/order check (X-2).
4. Jail wiring, which crosses repos:
   - who runs the `socat` bridge;
   - key file provisioning and env vars;
   - whether the gateway socket's API matches the relay's;
   - the child env.
5. The cache: scope, key, bound (X-4).
6. Failure semantics: per message vs per page, and wording (X-5).
7. Rendering:
   - the useful subset;
   - the reserve on top of the share;
   - pi's 50 KiB cap;
   - `MAIL_SECTION` (X-6).
8. Governance edits at lock.
9. Verification.

### Risks

- Answers are influenceable by an attacker, so they are advice only
  (RSK-002). `agent_directive` and `deception_cues` are themselves targets
  for an attacker to game.
- Cross-repo changes in satan (jail binds, key file, bridge). This slice's
  phases can't land them alone.
- pi may truncate a tool result above 50 KiB (unverified). If it does,
  "on top of budget" must still fit under that cap.

### Assumptions

- The gateway's client unix socket serves the same HTTP API as the relay
  on `127.0.0.1:4000` (inference).
- A JMAP message id names immutable content, so a cached classification
  never goes stale under the same id and config.

### Constraining governance

- DEC-026, DEC-027, DEC-028, DEC-029, DEC-030
- RSK-002
- ASM-001
- Screwtape's README contract: "classify", "Resume and skip", "Bounds".

## Further review (2026-10-29)

RV-020 ran three informal passes over the design (pi first pass, GPT critical
pass, pi verify-only). The last pass found only wording and recipe slips, so no
further design pass is planned. What one would probe, if run: the `seen`
contract once screwtape IMP-006 is specified (field shape, per-list address
bounds, the raw bounds table); whether the mail-only framing should move into
the shared untrusted block for bookmarks (SL-008, DEC-054). Recipe-level
slips are left to red/green tests; the next review is of the plan.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-29 · re-locked (design run rev 70, DEC-094); planned, 8 phases; slice ready · a4461f9 (SL-007 planning uncommitted)

### Produced
- design.md drafted, reviewed (RV-020: pi first pass, GPT critical pass, pi verify-only; F-1..F-18 answered) and locked
- minted: DEC-077 — screwtape owns Jev's window (refines DEC-048, DEC-050); DEC-081 — classify crash dumps off (refines DEC-059)
- minted: IMP-024 — drop `preview` from every mail view; screwtape IMP-006 — classify raw-byte bounds, every address list, `seen`
- lock notes (inq-8) on DEC-026..030, DEC-050, DEC-060, DEC-061; ASM-001 claim and RSK-002 controls edited; relation edges added
- slice-007.md scope reconciled; selectors match § Code impact (incl. src/untrusted-block.ts)
- uncommitted: all SL-007 .doctrine/ work in malebolge, plus satan, flakes and screwtape items (operator has not asked to commit); no code changed, no gate run needed

- design reopened and re-locked: screwtape SL-005 landed seen as the window text (mail-2); minted DEC-094 (agent sender text from seen; refines DEC-077, DEC-048, DEC-050); sec-1, sec-6..15 revised; RV-020 re-review waived by operator
- plan.toml / plan.md authored; phase sheets PHASE-01..08 materialised
### Learned
- mem.fact.malebolge.screwtape-classify-window — classify strips PII before its byte cut; growth up to 1.5x
- mem.pattern.malebolge.own-the-window-upstream — have the upstream report what it saw rather than mirroring it
- mem.fact.malebolge.pi-tool-output-bound — pi bounds tool results to 50 KiB
- mem.fact.malebolge.screwtape-classify-failure-line — a classify error line carries a cursor

### Open
- ASM-002 — gateway client socket serves Jev's path like the relay (first-phase VA)
- ASM-003 — the satan launcher can wrap the daemon (satan IMP-060; fallback in DEC-059)
- screwtape SL-005 (carries IMP-006) — in audit; PHASE-07 (text from seen) and PHASE-08 follow its close
- satan IMP-060, flakes IMP-055 — gate PHASE-08 (VH)
- RV-026 — empty design-review pass opened by the reopen; disposition waived
- inq-9 — applied in plan.toml (VT/VA-1 probe/VH-1)
