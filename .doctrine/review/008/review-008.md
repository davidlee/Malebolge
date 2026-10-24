# Review RV-008 — design of SL-003

Adversarial-review ledger. Structured findings live in the sister
ledger toml; this prose companion carries the reviewer's framing.

## Brief

Raiser: `raiser`. Full adversarial design pass over SL-003 sec-1 through
sec-7, its scope, research and DEC-011 through DEC-017, including the existing
DEC-007, DEC-008 and DEC-010 contracts being amended.

Probe the index's atomicity and completeness, creation/fork/startup ordering,
session-document semantics, paging and id ordering against pi-durable's tagged
v1.4.0 source and the installed 1.3.0 distribution. Check both directions of
wire compatibility, client flag resolution, directory selection and `--here`
under socket/profile overrides. Challenge ambiguous contracts, missing code
impact and tests that could pass despite the claimed invariant failing.

Read-only examination and in-memory probes only; changes are confined to
RV-008. Findings distinguish verified source facts from inferred consequences
of the proposed design. The pass conclusion records checked areas with no
finding as well as verification limits.
