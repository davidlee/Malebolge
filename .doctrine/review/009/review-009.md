# Review RV-009 — design of SL-003

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

Narrow amendment review of SL-003 design sections sec-3 and sec-6 only.
Check topicNameOf's runtime dependency boundary and the attach-invocation /
request extraction against current attach, attach-main, protocol, structure
rules and attach tests. Read sec-2, sec-4, sec-5 and sec-7 for consistency;
do not reopen RV-008's settled review. Trace shared skew and connection helpers,
resolveHere's request dependency, and preservation of verification after tests
move. Source-backed design analysis only; no implementation or runtime proof.

## Synthesis

Overall: acceptable.

The amendment admits an acyclic client dependency graph and conforms to the
current tier rules. F-1 is verified: design.md:429-431 now assigns invocation
and resolveHere tests to attach-invocation.test.ts, request/skew tests to
request.test.ts, and retains interactive skew coverage in attach.test.ts.
No new findings arose from the repair. This pass verifies design text against
source; implementation, runtime and live acceptance remain unverified.

Haiku:
Names stay at the wire
Tests follow the paths they guard
The hint still reaches
