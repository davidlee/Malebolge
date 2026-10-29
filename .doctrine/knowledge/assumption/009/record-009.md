Basis: `~/flakes/agents/jailed-agents.nix` commonPkgs carries no nodejs, and pi 1.4.0 is a compiled ELF (`libexec/pi/pi`) that brings no `node` onto PATH; malebolge's own jails add `nodejs_24` through `shellPkgs`, other projects' pi jails do not. The agents flake's nixpkgs has nodejs and nodejs_24 at 24.21.0. Host evidence (2026-10-29): the kit's `sl009-wire` runs on host node v24.21.0 with no flags and no warning, from its own dir and from `/`. The jail case is the premise; it holds only once the jail carries node (proposed ~/flakes change, operator assent pending).

Shapes: SL-009 (PHASE-01 EX-10; DEC-075).

## Validation (2026-10-29)

Probed by the operator in a real pi jail, 2026-10-29 (SL-009 PHASE-01 VH-1; kit `.doctrine/slice/009/probes/vh1/sl009-probe/`, runbook in SL-009 notes.md § Probes). `cd /tmp && sl009-wire` printed
`sl009-wire ran on node v26.12.1: {"text":"xxxxx…xxxxx","truncated":true}`,
exit 0, no flags. Validated for a jail that carries node: that jail's node
came from its project's packages, not from the agents flake, so node's
presence in an arbitrary project's pi jail remains a ~/flakes deployment
concern (proposed `lib.optional piInJail pkgs.nodejs_24`, operator assent
pending; CHR-007 scope), not a premise failure.
