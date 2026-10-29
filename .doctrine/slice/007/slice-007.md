# Classified mail: mail tools carry screwtape classify answers

## Context

SL-005 gave mail-mode conversations five stateless read tools (`mail_new`,
`mail_read`, `mail_thread`, `mail_list`, `mail_mailboxes`) over screwtape's
v1 read contract, behind the `MailSource` port (DEC-026, `src/mail/source.ts`).
DEC-026 left room for a classifier stage (as a new port member, DEC-047),
without new tools for it.

Screwtape SL-004 (closed) added that stage: `screwtape classify` reads v1
`read` envelopes on stdin, strips PII, asks Jev (typesafe.ai's decision
model, not an LLM) the `mail-1` questions, and prints one line per message:
`id`, `cursor`, `schema`, `model`, and typed `answers` (a choice label,
noul probabilities, scores, each with probabilities and confidence).
Contract: screwtape README, "classify", "mail-1", "What Jev sees",
"Resume and skip", "The key, and the wrapper".

satan:RFC-020 (amended at screwtape SL-004 close) narrows D5: SATAN triages
a pre-classified subset of mail.

Originates from IMP-022. Operator intent (2026-10-29): get the classified
mail first, so we can see whether Jev's dimensions earn their place
(screwtape IMP-003) before SATAN depends on them. The mail agent's later
outputs — action plans (IDE-005), quarantined digests (IDE-006), operator
signals (IDE-007) — build on this.

## Scope & Objectives

Updated 2026-10-29 against the decisions the design inquiry accepted
(DEC-047 to DEC-063, CON-001) and the design review (DEC-077, DEC-081).

1. **Classified mail reaches the conversation.** `mail_new`, `mail_read`,
   `mail_thread` and `mail_list` carry each message's classification as a
   compact `jev` object in the item's core (DEC-047, DEC-060). `MailSource`
   gains `classify(ids)`; no new tool for this.
2. **The agent never sees mail text Jev was not shown** (DEC-048). The
   window is screwtape's (DEC-077): each classify line reports in `seen`
   the raw body bytes Jev kept, and the agent's bodies are clamped to it;
   every other field is clamped to screwtape's documented raw bounds.
   Header text Jev never sees is capped or dropped (DEC-050).
3. **No redundant classification.** An in-memory cache held for the
   daemon's lifetime, keyed by message id, filled read-through (DEC-057,
   DEC-058). Screwtape keeps no classifications, so reuse is ours.
4. **Classify runs from the jail** through a launcher-run loopback bridge to
   the gateway socket, with screwtape's Jev credential decrypted by the
   `malebolge-room` unit (DEC-059; satan IMP-060, flakes IMP-055). The
   adapter spawns classify with stdin and no shell (DEC-051). No crash dump
   can leave the key or mail in the jail home: the classify child runs with
   `ERL_CRASH_DUMP_SECONDS=0` and the unit sets `LimitCORE=0` (DEC-081).
5. **Failures degrade per item; a read never fails because classify did**
   (DEC-056). Unclassified items carry a fixed reason.
6. **Answers are validated by type and framed as advice.** Validation and
   rendering name no questions (CON-001); answers never widen a
   conversation's tools.
7. **Quarantine hardening** (operator, 2026-10-29):
   - **Framing.** Every mail result frames its content as possibly hostile,
     never authority, never an instruction: section, header line, error
     prefix, tool descriptions. No test pins the phrasing; one assertion
     ties the section to the rendered block tag (DEC-061).
   - **Network guard.** Mail tools refuse every call if the process can
     reach the network (DEC-049).
   - **Self-report.** `mail_report(id, kind)`, a closed vocabulary, logs to
     the journal and withholds the message from then on (DEC-062). The
     reported set refuses new ids when full; nothing is evicted.
   - **Pre-filter.** Hostile (`agent_directive` or `deception_cues` >= 0.5),
     unclassified or reported mail has its sender-written text withheld;
     the agent sees why and names it to the operator (DEC-063).

## Non-Goals

- Action plans, digests, operator-signal memory (IDE-005/006/007), and
  background prefill (noted on IDE-006).
- Triage policy built on answers (e.g. hiding promotions), beyond the safety
  pre-filter. Using answers for triage is later work, after IMP-003.
- Any write to the mailbox or to screwtape.
- Changing the `mail-1` questions, or screwtape's contract beyond DEC-077's
  three additive v1 changes (raw-byte bounds, every address list in Jev's
  state, `seen`), which screwtape IMP-006 carries. Screwtape IMP-005
  proposes relaxing PII erasure; not this slice.
- Attachment contents: screwtape keeps metadata only.
- Persisting classifications or reports across daemon restarts.
- SATAN's ordinary contexts reading classifications (RSK-002 zones).

## Affected surface

- `src/mail/source.ts`: `classify` member, classify envelope schema
  (type-shaped, with `seen`), `JEV_WINDOW`.
- `src/mail/screwtape.ts`, `src/bounded-exec.ts` neighbour: `stdinEnv`,
  classify invocation and failure mapping.
- `src/mail/project.ts`, `src/mail/render.ts`, `src/mail/tools.ts`: view
  clamps, `jev` core field, withheld items, header line, error prefix,
  `mail_report`, joint clamp.
- `src/mail/classifications.ts`, `src/mail/policy.ts`: the cache and
  read-through; the withhold policy.
- `src/mail/extension.ts`: `MAIL_SECTION`.
- `src/daemon-start.ts`, `src/config.ts`: cache, reported set, log and
  refusal built in `mailPart`; the credentials variable.
- `test/toolsets.test.ts` catalog guard: six mail tools.
- `test/mail/**`: classify fixtures, `fakeMailSource` with `classify`,
  `fakeMailDeps`.
- Cross-repo: satan IMP-060 (bridge, bind, variable), flakes IMP-055
  (unit credential, `LimitCORE=0`, DEC-081), screwtape IMP-006 (DEC-077's
  window changes).

## Risks, assumptions, open questions

The inquiry settled OQ-1 to OQ-5 (DEC-047, DEC-057, DEC-059, DEC-051,
DEC-060). Remaining:

- **Unverified:** the gateway's client socket serves Jev's path as the
  relay does (first-phase probe); `makeJailedAgent` admits a wrapper agent
  command (satan IMP-060; fallback: the daemon runs the bridge).
- **Risk:** Jev answers are adversarially influenceable; they are advice.
  Thresholds are uncalibrated until IMP-003.
- **Risk:** a Jev outage withholds all mail, loudly, until Jev returns.
- **Dependency:** the window-dependent work (`seen` schema, view clamps)
  waits on screwtape IMP-006. Until it lands, a classify line without
  `seen` is a contract violation, so every item is withheld.

## Verification / closure intent

- VT: unit tests over fixture classify output and fakes (adapter, failure
  mapping, cache, rendering bounds, each withhold reason, `mail_report`,
  network check, CON-001 behaviour). No framing-phrase tests.
- VA: first-phase probe of the gateway socket's API.
- VH: live check from a room mail conversation after satan IMP-060 and
  flakes IMP-055 land.

## Summary

Mail-mode conversations see Jev's classification of each message, computed
once per message, invoked from the jail, degrading per item on failure, with
hostile, unclassified or reported mail withheld and every result framed as
possibly hostile data.

## Follow-Ups

- IDE-005 action plans (data DSL executed by trusted elisp in Gnus).
- IDE-006 quarantined digests (with background prefill); IDE-007 operator
  signals.
- IMP-015 per-conversation byte budget for mail tools.
- screwtape IMP-005 PII relaxation for malice signals.
- IMP-024 drop `preview` from every mail tool's view.
