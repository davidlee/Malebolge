Basis: pi-durable README, Busy Conversations
(`.doctrine/state/slice/009/research-context/pi-docs/durable-README.md:497-515`):
"Writes append an entry without asking the model anything ... A write with
`model`, `head`, or `edits` waits for the next boundary like a steer." The
README states the busy case; the idle case is the inference to verify.

Underpins DEC-069: a note into SATAN is such a write and must spend no turn.


## Validation (SL-009 PHASE-01, 2026-10-29)

Validated by a standing daemon-side test: `test/queue-premises.test.ts`,
"ASM-006: a write with model content on an idle conversation" (SL-009 VT-1).
On an idle conversation a `write` whose entry carries `model` settles `done`
with zero model calls; the next `input`'s single run is given the note's content
before its own input. Negative control: the same note sent as `input` fails the
zero-calls assertion. Mechanism (pi-durable `dist/harness/submissions.js:139-217`):
an idle non-display-only write is `appendEntry` + settle `done`, no `startRun`.
