Observed 2026-10-20 (SL-028 PHASE-01): `just check` in `~/dev/malebolge` went
red at base with three "was not found by the project service" parse errors
for `.doctrine/state/pi/extensions/{index,mcp,surface}.ts`. `doctrine install`
renders the pi extension there; it is gitignored runtime state, but
typescript-eslint's project service still walks it.

Fix (malebolge `7b9294a`): add `".doctrine"` to the top-level `ignores` in
`eslint.config.js`. Any TS repo with doctrine installed and typed linting
needs the same ignore; biome was unaffected.
