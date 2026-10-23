# Notes SL-001: Improve Malebolge's Emacs session interaction

Durable per-slice scratchpad — tracked in git. The place to lift anything from a
disposable phase sheet (`.doctrine/state/.../phase-NN.md`) that must survive
`rm -rf` before the slice close-out audit harvests it.

## Harvest
<!-- single-copy: updated in place each harvest; ids only, never restated content -->
fresh-as-of: 2026-10-23 · audit · 336b317

### Produced
- PHASE-01..PHASE-05 done — Emacs draft and frame mode, presentation profile, transcript guard, native follow, reattach, smoke, and docs (commits 4ef3751..6c8ca60).
- RV-004 — reconciliation audit; F-3 fixed in 336b317 (smoke echoes the draft at the turn boundary).
- minted: IMP-003 — share one fake-daemon fixture; IDE-001 — show a queued draft before the boundary; CHR-001 — `just gate` recipe.

### Learned
- EVD-001 — pi-durable queues busy-conversation input, so the user turn follows the answer.
- quotient's token ceiling counts cached reads; use fresh, narrow pi sessions (implementation log below).

### Open
- DEC-006 — native comint follow; design sec-5 awaits reconcile (RV-004 brief).
- PHASE-05 VH-1 — optional manual try against a live daemon.

## Further review after RV-003

If another review pass is useful during implementation, probe the actual Emacs
process boundary: whether the read-only transcript and refusing comint sender
block every non-draft write, whether per-window follow survives streamed chunks,
and whether client-local notices preserve the assistant continuation cue. The
RV-002 closed seven findings and the read-only RV-003 pass found no new design
issue. The remaining checks need implementation behavior and are named in the
design's verification section.

## Implementation log

- PHASE-01 (renderer): presentation table (`TERMINAL`/`EMACS`) over shared
  streaming logic; `message_end` routes through `advance` so whole-at-end and
  end-time rewrites get cues. Terminal drops trailing newlines that arrive only
  at `message_end` (`finalText`); Emacs prints them, for snapshot parity.
  RV by malebolge-06: F1 (continuation cue lost across invisible update),
  F2 (double blank line after a trailing notice), F3 (end-only newlines parity)
  fixed with tests.
- plan.toml: PHASE-01 `[[phase]]` header restored (was inside a comment);
  PHASE-03 EX-6 added — user amendment: coloured `[tool]`/`[status]` faces.
- Delegation note: quotient's `tokens` ceiling (320k) counts cached reads, so a
  pi session dies at ~20 requests and resumed sessions die almost at once.
  Use fresh, tightly scoped sessions.
- PHASE-02 (attach frame mode): `attachInvocationOf` is the one parser
  (`attachTargetOf` delegates); frames: `FRAME_FIELDS` Map allowlist (narrows,
  fails closed) then `parseClientMessage`; `quit` local; refusals noticed.
  Renderer created before connect; every client notice via `client_notice`.
  Writer's red tests waited on terminal wording under emacs presentation —
  fixed. RV by malebolge-06: F1 prototype-key crash (Map), F2 strict quit
  fields, F3 `handleLine` rename — fixed with tests.
- PHASE-03 (Emacs draft/controls/guard/faces): writers' ERT fixture had
  harness bugs (unattached fake process, free `draft` var, paren slip) —
  fixed. RV by malebolge-06: F1 (major) C-c C-c from the transcript sent and
  erased the transcript → submit reads the draft by name; F2 comint EOF/signal
  keys remapped to `malebolge--refuse-input`; F3 compact nil instructions;
  F4/F5 docs; T1–T3 tests strengthened (faces via real output path).
- PHASE-04 (follow/reattach): DEC-006 (user-accepted) amends sec-5 — comint's
  native follow, no custom hooks; follow test mutation-checked. Failed start
  writes a `[status]` line and keeps the draft.
- Committed PHASE-03 and PHASE-04 together (same files, interleaved).
- PHASE-05 (smoke + docs): `just smoke` = batch Emacs + real
  `malebolge-attach --emacs` + fake daemon: draft submitted mid-stream (asserted
  in flight) arrives as exactly one exact `input`, no quit; reattach in the same
  Emacs (dead process → attach again) shows each turn once and one trailing
  blank line; terminal line commands unchanged. The smoke exposed a renderer gap
  — a live user turn mid-answer printed without the interrupt path — fixed
  (`interrupt(p.userTurn(…))`) with a render test. PHASE-04 RV follow-ups:
  selected-window-reading-older-text ERT (no defect), M-> resume documented in
  help/README. Smoke's fake daemon is its own (scripted streaming) — not shared
  with attach.test.ts's; candidate for a shared fixture later.
