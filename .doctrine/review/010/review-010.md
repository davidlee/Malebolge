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

## Synthesis

**Overall:** acceptable. The work as delivered at b053e1f was revision-required; with the fixes it is solid.

**Synopsis.** SL-003's topics and conversation index are well structured. One
module owns the index, and every write merges. The `FIRST_LINE` dispatch table
makes a frame without a handler a compile error. Parsing is strict, and every
refusal is one line. The tests mostly drive the real pi-durable hook and real
sockets. The defects were at the edges.

- **Prototype keys (F-1).** `constructor`, a valid topic name, passed the
  existence check through `Object.prototype`.
- **Lost lineage (F-2).** The backfill dropped `parent`. The production room
  store has already been backfilled without it. The fix also repairs entries a
  previous run wrote without their parent, so the next daemon start restores
  the lineage.
- **Silently ignored flag (F-3).** `--topic NAME --dir X` was accepted and
  `--dir` was dropped.
- **Request path (F-4, F-5).** The request path could resolve after an error,
  and it crashed with a stack trace on a line that is not JSON.
- **Race (F-6).** Two attaches to an empty topic could each create a
  conversation.

All 21 findings were fixed, test-first wherever the behaviour changed. The two
new seam tests were mutation-checked: each fails when the regression it targets
is reintroduced. F-18 (the design names `git rev-parse`; the code walks up to
`.git`) is the design's error and is amended at /reconcile.

Standing risks and accepted tradeoffs:
- Topic opens are serialised daemon-wide, not per topic (F-6). A hung commit
  would block every topic attach behind it, but commits are bounded.
- `topic` now refuses a `cwd` that contains control characters (F-15). That is
  a new sec-4 refusal; it is listed for reconcile.
- The interactive client still throws on JSON that is not an event. This is
  pre-existing and captured as ISS-001.
- There is still no reply timeout (IMP-006, known).

**Haiku**

    constructor slipped in —
    the prototype said "I'm here";
    hasOwn shuts the door
