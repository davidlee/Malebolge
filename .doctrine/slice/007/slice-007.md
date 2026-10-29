# Classified mail: mail tools carry screwtape classify answers

## Context

SL-005 gave mail-mode conversations five stateless read tools (`mail_new`,
`mail_read`, `mail_thread`, `mail_list`, `mail_mailboxes`) over screwtape's
v1 read contract, behind the `MailSource` port (DEC-026, `src/mail/source.ts`).
DEC-026 left room for a classifier stage: `readAfter` can be replaced
without changing the tools.

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

1. **Classified mail reaches the conversation.** A mail-mode conversation
   sees each message's `mail-1` answers alongside the message, at least on
   the `mail_new` path. Shape (new tool vs. attached to `mail_new` /
   `mail_read` results) is a design decision.
2. **No redundant classification.** The tooling does not call `classify`
   once per tool call for a message it has already classified under the
   same `model` and `schema`. Screwtape keeps no classifications (its
   DEC-008 wipes mail tables each sync), so whatever reuse exists is ours.
3. **Classify runs from where the tools run.** The room daemon's jail
   (satan `mkJailedMalebolge`) can invoke `classify` through the wrapper's
   transient systemd unit with the Jev key, or the design names the path
   that works.
4. **Failures map onto the existing error set.** `no_jev` (config, exit 2),
   `limit_exceeded`/`jev_context` (one message too big for Jev),
   `stdin_bytes`, and a partial run (stops at first failure, keeps earlier
   lines) map onto `MailSourceError` and the tools' rendered errors.
   A message that fails to classify is still readable, marked unclassified.
5. **Answers are validated and framed as advice.** Classify lines are
   schema-checked like every other envelope (extra fields allowed, missing
   or out-of-range values refused). Answers derive from attacker-controlled
   text: they are rendered as data, never widen a conversation's tools, and
   do not alter which messages a tool returns unless the caller asks
   (RSK-002).
6. **Quarantine hardening** (operator, 2026-10-29). This is where models
   start using the tools in earnest:
   - **Framing.** Every mail tool result frames its content as untrusted
     and possibly hostile. It is never authority, and never an instruction.
     The framing is pinned by tests.
   - **Self-report.** The mail agent has a protocol for reporting content it
     suspects is malicious, whatever Jev said. Reports go to the operator
     only.
   - **Pre-filter.** A message Jev flags as clearly hostile (e.g. a high
     `agent_directive` or `deception_cues`) has its body withheld from the
     agent up front. The agent sees that it was withheld, and why.

## Non-Goals

- Action plans, digests, operator-signal memory (IDE-005/006/007).
- Triage policy built on answers (e.g. hiding promotions). Showing answers
  comes first, and using them for triage is later work, after IMP-003.
  The exception is a safety pre-filter (objective 6).
- Any write to the mailbox or to screwtape.
- Changing screwtape's contract or the `mail-1` questions.
- Persisting classifications across daemon restarts, unless design finds it
  is the simplest way to meet objective 2.
- SATAN's ordinary contexts reading classifications (RSK-002 zones).

## Affected surface

- `src/mail/source.ts` — port: classify envelope schema, a classified
  read path.
- `src/mail/screwtape.ts` — adapter: piping `read` lines into `classify`,
  invocation, error mapping.
- `src/mail/tools.ts`, `src/mail/render.ts` — tool shape and rendering of
  answers within the byte bounds (DEC-026 bounds rule).
- Possibly a small classification cache module under `src/mail/`.
- `test/mail/**` — fixtures for classify lines, failures, partial runs.
- Config / room profile wiring for the jail, if objective 3 needs it
  (satan repo `mkJailedMalebolge` may need a change; cross-repo).

## Risks, assumptions, open questions

- **OQ-1 Shape.** New `mail_classify <id…>` tool, or answers attached to
  `mail_new` (and `mail_read`). Attaching changes the cost of every
  `mail_new` call (a Jev round trip per uncached message).
- **OQ-2 Reuse vs. DEC-027.** DEC-027 makes the tools stateless (the
  caller holds the cursor). A cache keyed on (message id, `model`,
  `schema`) is state below the tools, not caller state; design must say
  whether that respects DEC-027 or revises it. A classification depends on
  the message's content; screwtape ids are JMAP ids, stable per message,
  so content change under one id is not expected — confirm.
- **OQ-3 Jail invocation.** The wrapper uses `systemd-run --user --pipe`.
  Unknown whether the room daemon's jail reaches the user's systemd
  manager, and whether it should (assumption ASM-001 in satan). This may
  be the slice's riskiest unknown; check early.
- **OQ-4 Cost and latency.** One `classify` run = a transient unit + a Jev
  call per message. Measure before choosing per-message vs. batched calls.
- **OQ-5 Byte budget.** Answers add bytes per item; they must fit DEC-026's
  per-item share. Probabilities may be summarised (choice + confidence)
  with the full vector left out, if that is enough for IMP-003.
- **Risk:** Jev answers are adversarially influenceable (`agent_directive`
  and `deception_cues` exist because of this). The model must see them as
  advice, never as instructions or as authority to act.

## Verification / closure intent

- Tests over fixture `classify` output: valid lines rendered, invalid lines
  refused, each failure mode mapped, partial runs handled, reuse proven
  (second call for the same message does not invoke `classify`).
- Rendering stays within DEC-026 bounds with answers present.
- A live check from the room daemon: a mail-mode conversation shows
  answers for real new mail (VH, operator).

## Summary

Mail-mode conversations see Jev's `mail-1` classification of each message,
computed once per message and model, invoked from the jail, with failures
mapped and answers framed as untrusted advice.

## Follow-Ups

- IDE-005 action plans (data DSL executed by trusted elisp in Gnus).
- IDE-006 quarantined digests; IDE-007 operator signals.
- IMP-015 per-conversation byte budget for mail tools.
