# IMP-022: Mail tools call screwtape classify: classified mail_new

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator direction, 2026-10-29, after screwtape SL-004 (the `classify` verb)
reached reconcile.

The `mail_*` tools (SL-005) read screwtape's `read` verbs only. Screwtape now
has `classify` (screwtape SL-004, IDE-001): it reads version-1 `read` lines on
stdin, strips PII, asks Jev (a typesafe.ai decision model, not an LLM) the
`mail-1` questions, and prints one line per message: `id`, `cursor`, `schema`,
`model` and typed `answers` (choices, probabilities, scores). It is the
"classifier stage" SL-005's design left room for: `MailSource.readAfter` can
be replaced without changing the tools (DEC-026, `src/mail/source.ts`).

## Intent

Let a mail conversation see Jev's classification of a message, so we can find
out which dimensions are useful (screwtape IMP-003 evaluates them on real
mail). The operator's "see the results first" means exactly this: judging
whether Jev's classifications earn their place, before SATAN depends on them.
It is not an approval queue for SATAN.

## Open design questions

- Shape: a new tool (`mail_classify <id>`), or classification attached to
  `mail_new` / `mail_read` results. Either way the tools stay stateless
  (DEC-027).
- Invocation: `classify` runs in a transient systemd unit when `jev` is set
  (screwtape DEC-038) and needs the gateway key. Check this works from the
  room daemon's jail (satan `mkJailedMalebolge`; ASM-001).
- Failure: `classify` stops at the first failure and prints an error line
  carrying that message's cursor. Map `jev_context` (message too big) and
  config errors (`no_jev`) onto the existing `MailSourceError` set.
- Trust: answers derive from attacker-controlled text. Validate against the
  `mail-1` schema (the CLI contract does); a classification is advice and
  must not widen a conversation's tools (RSK-002).
- Persistence: a tooling question, not a screwtape one. Screwtape DEC-008
  wipes its mail tables each sync, so screwtape will not keep
  classifications; that does not mean malebolge should call `classify` once
  per tool call. Decide what the mail tools keep: a classification is a pure
  function of (message, `model`, `schema`), so a cache keyed on those is
  safe to reuse and needs no invalidation beyond a model or schema change.
  Tension: DEC-027 makes the tools stateless — a cache is state, so either
  it sits below the tools (in or beside `MailSource`) or DEC-027 is revised.
  Cost and latency of a `classify` call (systemd unit + Jev round trip) set
  how much this matters.

## Governance

Narrows satan:RFC-020 D5 (SATAN triages a pre-classified subset). Screwtape
SL-004 is closed and the RFC-020 D1/D5 amendment is made (operator,
2026-10-29); draft the slice against the amended RFC.
Contract and caveats: screwtape README, "classify" and "What Jev sees".

## Follow-ons

The mail agent's outputs build on classified mail: IDE-005 (action plans),
IDE-006 (quarantined digests), IDE-007 (operator signals).
