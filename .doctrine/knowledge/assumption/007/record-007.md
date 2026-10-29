Basis: pi docs, packages
(`.doctrine/state/slice/009/research-context/pi-docs/packages.md:80-90`): pi
supplies `typebox`, `@earendil-works/pi-ai`, `pi-agent-core`,
`pi-coding-agent` and `pi-tui` to extensions; declare them as peer
dependencies and do not bundle them. The docs speak of packages; a bare
directory under the jail home is the case to verify.

Underpins DEC-073: the extension has no npm dependencies beyond what pi provides.
