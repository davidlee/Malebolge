Basis: pi docs, packages
(`.doctrine/state/slice/009/research-context/pi-docs/packages.md:80-90`): pi
supplies `typebox`, `@earendil-works/pi-ai`, `pi-agent-core`,
`pi-coding-agent` and `pi-tui` to extensions; declare them as peer
dependencies and do not bundle them. The docs speak of packages; a bare
directory under the jail home is the case to verify.

Underpins DEC-073: the extension has no npm dependencies beyond what pi provides.

## Validation (2026-10-29)

Probed by the operator in a real pi jail, 2026-10-29 (SL-009 PHASE-01 VH-1; kit `.doctrine/slice/009/probes/vh1/sl009-probe/`, runbook in SL-009 notes.md § Probes). The kit, a bare directory under the jail home's `~/.pi/agent/extensions/`
with no node_modules, loaded; its TypeBox-schema tool `sl009_echo` answered
`sl009:hi`.
