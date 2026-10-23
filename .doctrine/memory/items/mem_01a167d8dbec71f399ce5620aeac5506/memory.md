Observed 2026-10-23 (SL-002 plan), corrected the same day when the user put
biome on PATH.

**The hazard is the resolution path, not biome.** `just fmt-check` runs
`npx biome format .`, and npx prefers the local install:

    $ npx biome --version
    Error: spawnSync .../node_modules/@biomejs/cli-linux-x64/biome ENOENT
    $ ./node_modules/@biomejs/cli-linux-x64/biome --version
    bash: ...: cannot execute: required file not found

The file exists and is executable; the interpreter is missing.
`/lib64/ld-linux-x86-64.so.2` does not exist on this nix host, so a glibc-linked
binary cannot start and spawnSync reports ENOENT (the loader, not the binary).

**What works.** `biome` on PATH is nix's 2.5.15 — the exact version
`package.json` pins — and `biome format .` reports "Checked 168 files. No fixes
applied." So the formatting gate is satisfiable here; only the npx path is
broken. Run `biome format .` (or the flake devshell's toolchain) rather than
`npx biome format .` until IMP-001 builds node_modules in the flake.

**What is not affected.** `npx eslint --version` (10.13.0), `npx tsc --version`
(6.0.3) and `npx vitest --version` (5.0.5) all run, and `just ert` (24/24,
byte-compile clean) and `just smoke` (3 checks) are green.

See also `mem.fact.malebolge.runner-suite-red-in-agent-container` — the other,
larger reason `just check` is red here.

Unrelated: `mem.fact.malebolge.eslint-ignores-doctrine-state` is a different
`just check` failure (typed eslint walking `.doctrine/state/pi`), fixed in-repo.