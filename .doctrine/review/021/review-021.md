# Review RV-021 — design of SL-009

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

<!-- Pre-reading + lines of attack: what this review is probing, the invariants
     it must hold the subject to, and where the bodies are likely buried. Seeded
     at `review new`; the reviewer fills it before raising findings. -->

Codex round 3 reviews all nine sections of SL-009's design against accepted
DEC-064..DEC-076, the slice scope, installed pi-durable, and the local pi
checkout. Lines of attack: build and deployment seams; durable outbox delivery;
retry and failure-notice idempotence; end, reconnect, and session replacement;
concurrent admission; hostile-text framing and bounded transport.

The round-2 rulings were read first. Q3, Q4 (including stale one-commit wording),
accepted residuals, ISS-003, network policy, Emacs, and placeholder posture prose
are excluded. Findings distinguish verified source facts from inferred runtime
scenarios and propose the smallest repair using existing mechanisms. No product
or design files are changed. The raiser label is codex as requested; this label
field has no review CLI edit verb (lib:reference/using-doctrine.md, Hand-edit vs
verb). Findings and conclusion are written through doctrine review.
