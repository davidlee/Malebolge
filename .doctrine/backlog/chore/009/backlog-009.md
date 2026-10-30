# CHR-009: Drop malebolge flake's hand-rolled bridgeOptions and jailed-pi-bridge now the agents lib carries the bridge (CHR-007)

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

`flake.nix:80-115` defines `bridgeOptions` (DEC-074 clauses by hand, "until CHR-007 lands") and a separate `jailed-pi-bridge`. The agents lib now applies the same binds to every pi-carrying jail (mem.fact.malebolge.pi-jails-carry-bridge). Bump the `agents` input, drop both, check `jailed-pi` carries the bridge. deck_of_dwarf did this at 753c28fc.
