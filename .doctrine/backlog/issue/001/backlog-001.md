# ISS-001: Interactive attach crashes on a JSON line that is not an event

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Found during RV-010 (SL-003 code review, F-5). `src/attach.ts` `wire` passes each
parsed line to `handleEvent(state, toPrintable(value))`; `toPrintable`
(`src/render.ts:46`) throws `not an event: …` for any JSON value without a string
`type`, inside the socket `data` listener — an uncaught exception, so the
interactive client dies with a stack trace. Pre-existing (a7ec48f had the same
shape). RV-010 F-5 fixed the non-JSON case for both client paths via
`wireClient`'s `malformed` arm; this is the remaining valid-JSON-but-not-an-event
case on the interactive path only (`request.ts` already ignores such values).

Fix shape: treat a non-event like a malformed line — one notice, skip it — or
route it through `malformed`.
