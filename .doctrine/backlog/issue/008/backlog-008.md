# ISS-008: Audit: the malebolge daemon's jail is never the execution environment for an agent with host-attached coding tools

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator direction, 2026-10-30 (SL-012 design, inq-3). Follow-on; not in SL-012.

## Concern

The room daemon runs in one jail (`mkJailedMalebolge`, `~/dev/satan/flake.nix`;
`docs/internals.md` § Jail). Mail tools need screwtape's store bound into it
read-write (`docs/internals.md:200-204`), and SL-012 adds a read-write bind of
the mail plans directory (`MALEBOLGE_MAIL_PLANS`). Those are RSK-002 Q0/Q2
material. If an agent with host-attached coding tools (shell, file edit)
executes inside that jail, it can read or write them, which bypasses the
quarantine (nothing flows Q1/Q2 → SATAN except through the operator).

Inference, unchecked: whether any conversation's coding tools run inside the
daemon's jail today.

## Operator framing

- Audit that the jail used by the malebolge daemon is never the execution
  environment for an agent with host-attached coding tools.
- "interactive" in the operator's usage is essentially room mode. In the other
  mode (host), the daemon should either not mount the mail environment, or
  mount it within a different jail.

## Done when

- The audit's answer is recorded with evidence (which conversations' tools
  execute where, per profile).
- Any path that lets a coding-tool agent reach the store or plans directory is
  closed, or recorded as accepted under RSK-002.
