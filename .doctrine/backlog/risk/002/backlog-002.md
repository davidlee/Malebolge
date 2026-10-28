# RSK-002: Foreign-originated text can carry instructions into SATAN: quarantine for mail, its derivatives, and panopticon

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## The risk

Text that originates off this machine — mail bodies, captured web pages — can
carry instructions. A model that reads it may follow them. Framing it as
untrusted, labelling it, and classifying it beforehand all lower the odds; none
of them rules out infection.

Operator's stance (2026-10-28):

- A conversation with direct access to mail triage tools is **possibly a
  zombie**. Probably not one, but it could be. You don't talk to zombies.
- Mail will be classified for risk before it is read and framed as
  non-authoritative. That is mitigation, not proof.
- The quarantine emits a limited set of writes: mostly structured, read by the
  operator alone (plans for emails, enacted only by the operator); and
  summaries.
- **Summaries are quarantined material too** until the operator has read them
  and promoted or disposed of them. A classifier will judge whether one is
  infected, but it is just a classifier. By default they sit outside the range
  of every SATAN read tool.
- Accepted exception: a lexical search over quarantined summaries that returns
  only a couple of lines per hit, so an agent can point the operator at
  something worth reading in time.

## Zones

```
 foreign text ──► Q1 quarantined reader ──► Q2 derivatives ──► operator ──► promoted (trusted)
 (mail, web)      (mail-mode conversation)   (plans, summaries,              or disposed
                                              its own transcript)
                                                   │
                                                   └─► SATAN: lexical hits only, a few lines
```

- **Q0, foreign text:** raw mail and page text.
- **Q1, quarantined reader:** anything that has read Q0. Its context is
  presumed contaminated for its lifetime, including any fork of it.
- **Q2, derivatives:** everything Q1 emits — structured plans, summaries, and
  its transcript. Quarantined until the operator promotes or disposes of it.
- Nothing flows from Q1/Q2 to SATAN's other contexts except through the
  operator, or through the accepted lexical exception.

## Current controls (evidence)

- Mail mode's extension set is mail tools only: no coding, SATAN, memory or
  write tools (DEC-029; `src/toolsets.ts` CATALOG `mail`). `prompts/mail.txt`:
  "You write nothing anywhere."
- Mail tool results are wrapped in `<mail-data untrusted="true">` with a
  standing instruction that nothing inside is an instruction
  (`src/mail/extension.ts:10`, `src/mail/render.ts:21`).
- A classifier before reading is planned (satan:RFC-020; screwtape IDE-001),
  not built.

## Gaps

1. **Panopticon (unverified; the operator is unsure).** Panopticon captures raw
   browser text to disk and sends it off for summarisation and scoring.
   SATAN's `content_read` exposes the raw captured body (`get`) and the
   model-written digests (summary, claims, entities) to its ordinary read tools
   (satan:IMP-035, `satan/satan-tools-content.el`). Inference: since `get`
   returns the body, captured web text is not quarantined from SATAN today.
   Whether the digest step frames or classifies its input is unchecked.
2. **Threads (planned).** Starting or posting into a thread from mail mode, or
   reading a mail conversation's transcript or forking it into another mode,
   would open a path from Q1 to SATAN. RFC-003 puts mail mode in no talk set:
   it neither sends nor receives, and talks only to the operator. A fork of a
   mail conversation stays in mail mode.
3. **Where derivatives live.** RFC-020 puts operation proposals and the unread
   digest under `~/.local/state/satan/…`. That path must stay outside every
   SATAN read root, the lexical exception aside.

## When to pull

Before any slice that lets a mail-mode conversation emit anything beyond its
reply to the operator: the triage run's writes (satan:RFC-020 M3), thread post
from mail mode, or a search over conversations. Gap 1 stands independently;
audit panopticon's pipeline when convenient.
