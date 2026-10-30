# ISS-006: Mail results don't say when the classifier is down: an outage looks like every message failing on its own

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Observed (2026-10-30)

Screwtape's classify failed for every message in the room jail: `tls_failed`,
on Jev's plain-http loopback, because the jail has no `/etc/ssl` (screwtape
ISS-002; stopgap CA bind in satan's room jail). Each item came back
`withheld: { reason: "unclassified", detail: "failed" }`. SATAN worked out that
there was an outage from a page of 20 identical verdicts, but nothing in the
result said so. Until it did, the obvious reading was 20 suspicious messages.

## Problem

`failed` and `unavailable` are per-item verdicts (`src/mail/policy.ts`
`withholding`). A batch that failed as a whole and a single message Jev couldn't
answer look the same to the agent. The header (`src/mail/render.ts`) counts
withheld items but doesn't say why at the call level.

## Direction (not designed)

- When every classify outcome in a call is `failed` or `unavailable`, have the
  header written by malebolge say the classifier is unavailable for this call,
  so the agent reports an outage rather than N withheld messages.
- Keep fail-closed: the items stay withheld. This changes what the agent is
  told, not what it is shown.
- The flag must not be something a message can trigger on its own: a single
  crafted message that makes Jev fail must not make the call read as "the
  classifier is down" in a way that changes behaviour. The text informs the
  agent only.

## Related

- IMP-029: journal the batch's screwtape error and reason, for the operator.
  This issue is the agent-facing counterpart.
- Withheld `failed` / `unavailable` are never cached (`cacheable` in
  `src/mail/classifications.ts`), so recovery is automatic. This is only about
  what the agent is told.
