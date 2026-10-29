# SL-007 notes

## Design surface triage (2026-10-29)

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
