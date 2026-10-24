# Review RV-010 — code-review of SL-003

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Depth: full (pre-close; ~3k-line delta, all code by deepseek-flash, prior orchestrator
review VA-1-targeted only). Reviewer: Claude (user's choice over Codex, 2026-10-24).
Evidence: `git diff a7ec48f..b053e1f -- src test`; binding: `design.md` sec-2..sec-6.

Lines of attack (ranked, from the SL-003 handover):

1. `src/topics.ts` — conversation-created hook + `backfillIndex`: atomicity with the
   creating commit; odd/large pre-index stores; forks of unindexed parents; owned
   (task) conversations; merge-never-replace on the index document.
2. `src/request.ts` — socket settle/close races, stray traffic ignored, version skew
   (`skewOf`, both reply shapes). Missing reply timeout is known (IMP-006): not re-raised.
3. `src/protocol.ts` — strict-parse holes; `topicNameOf`; refusal texts vs design sec-4.
4. `src/attach-invocation.ts` — flag exclusivity matrix completeness; `resolveHere`
   (profile check, exact-match rule, `--set-topic --here`).
5. Tests — names vs assertions; where stubs (`fakeDaemon`, injected `gitRoot`) stand
   in, is the real path covered.

Not re-raised (already in SL-003 notes Harvest/Open): sec-3 vs sec-4 `no topic X`
prefix; `new:false` refusal absent from sec-4; sec-5 omits `--set-topic --here`;
DEC-007/008/010 amendments; IMP-010 pager duplication; IMP-006 no reply timeout.
