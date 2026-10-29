# IMP-029: Journal a classify batch failure's screwtape error and reason

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Why

First deploy of SL-007 (2026-10-30): every `screwtape classify` in the room
jail failed with stderr `{"level":"error","error":"http","reason":"tls_failed",…}`
(screwtape ISS-002: no CA store in the jail, needed even for an `http` base
URL). The adapter (`src/mail/screwtape.ts`, the classify failure table) mapped
that to `failed` for every id. Every item was withheld, correctly, but the
`malebolge-room` journal recorded nothing. Diagnosis took a hand-run of
screwtape inside the jail's namespaces. A single journal line would have named
the failure.

## Wanted

When a classify call ends with **no id classified** (the whole batch fails,
whatever the ending: non-zero exit, timeout, prefix mismatch, spawn error),
write one line to the daemon's journal (stderr, `malebolge: ` prefix, like
the startup lines). It names:

- the ending: exit code / `timeout` / `spawn_error` / `mismatch`;
- screwtape's `error` and `reason` from the first error-level stderr line,
  each only if it is a bare word (the existing `bareWord` / `firstDiagnostic`
  helpers);
- the batch size.

Never the cursor, message ids, or any other child text. `cursor` names a
message, and stderr may carry mail text; the closed vocabulary keeps the
journal free of mail content (DEC-081's spirit). `unavailable`
(config/credential) is worth the same line: it also withholds everything.

Open:
- Rate: one line per failed call could repeat on every tool call during an
  outage. Probably acceptable (calls are model-paced), or log on state change
  only. YAGNI says per call.
- Where the logger comes from: the adapter has no logger today. `MailDeps.log`
  is mail_report's journal line, so either inject a diagnostics logger into
  `ScrewtapeOptions` or return the diagnostic with the outcomes and log in
  `classificationsOf`.

## Related

- IMP-027: same gap for failed model turns (journal observability).
- SL-007 design § One classify(ids) call (the failure table, `errorDiagnostic`),
  DEC-059, DEC-081.
- screwtape ISS-002 (the incident).
