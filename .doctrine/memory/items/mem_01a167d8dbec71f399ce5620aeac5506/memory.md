Observed 2026-10-23 (SL-002 plan): `just check` fails at its first recipe on
this host. `just fmt-check` runs `npx biome format .`, which spawns
`node_modules/@biomejs/cli-linux-x64/biome` — a 66 MB glibc-linked binary — and
dies:

    Error: spawnSync .../cli-linux-x64/biome ENOENT

    $ ./node_modules/@biomejs/cli-linux-x64/biome --version
    bash: ...: cannot execute: required file not found

The file exists and is executable; what is missing is the interpreter it needs:
`/lib64/ld-linux-x86-64.so.2` is absent on this nix host. So the ENOENT is the
loader, not the binary. `npx eslint --version`, `npx tsc --version` and
`npx vitest --version` all work (v10.13.0, 6.0.3, 5.0.5), so **only** the biome
format check is broken; lint, typecheck and tests are runnable.

Consequences for a slice whose exit criteria say "just check green": the
criterion is currently unsatisfiable here. Do not weaken it. Either run the gate
where the toolchain matches (the flake devshell / the room, where node_modules is
built for that platform) or wait for IMP-001 ("Build the dev node_modules in the
flake so a sealed room runs just check"), which is the fix this symptom is the
evidence for.

Related but distinct: `mem.fact.malebolge.eslint-ignores-doctrine-state` is a
different `just check` failure (typed eslint walking `.doctrine/state/pi`), fixed
in-repo and unrelated to the loader.