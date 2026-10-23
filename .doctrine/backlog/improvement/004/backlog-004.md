# IMP-004: A local dev flake for malebolge: the gate's toolchain comes from the flake, not the checkout

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Raised 2026-10-23 during SL-002's plan, from a real gate failure rather than a
preference.

## What happened

`just check` runs its toolchain through `npx`, which resolves the checkout's own
`node_modules`. On this host that tree carries a glibc-linked
`@biomejs/cli-linux-x64/biome`, and there is no `/lib64/ld-linux-x86-64.so.2`,
so `just fmt-check` dies with `spawnSync … ENOENT` before it can report
anything. eslint, tsc and vitest in the same tree run fine; only the native
biome binary is wrong for the platform.

The workaround in place for SL-002 is a hand-edited `justfile`: `biome format .`
and `biome format --write .` instead of `npx biome …`, picking up biome 2.5.15
from the flake/devshell PATH. That works in the devshell and only there — it
does not evaluate in every shell the user runs `just` from, and it silently
changes the version source from `package-lock.json` to `flake.lock`.

## What this item asks for

One flake output that makes the gate self-sufficient:

1. **A devShell whose PATH carries the gate**: node 24, `just`, and the
   formatter/linter/test tools as pinned by `flake.lock`.
2. **A dev `node_modules`** so the tools that resolve *relative to the repo*
   work too — eslint's plugins, tsc's `@types`, vitest's vite. PATH alone is
   not enough for those, which is IMP-001's core insight.
3. **Recipes that use it**: `just check` in a fresh devshell, with no `npm ci`
   and no global shim, and no `npx` reaching a platform-wrong native binary.
4. **One version source.** biome is pinned twice today
   (`package.json` `@biomejs/biome: 2.5.15` and the devshell's `pkgs.biome`).
   Either derive one from the other or assert they are equal in the gate, so a
   formatting diff cannot come from a version skew nobody chose.
5. **Acceptance**: from a fresh clone and a clean devshell, `just check` runs
   end to end; `npx biome` is not needed; the justfile needs no host-specific
   edit.

## Relationship to IMP-001 — do not implement this twice

IMP-001 ("Build the dev node_modules in the flake so a sealed room runs
`just check`") is the same destination seen from inside the room: no egress, so
`npm ci` cannot run and the tree must be a flake output, patched for a loader
the room has. Its items 1–6 are the room-facing half; this item is the
host-facing half, and item 6 there (`autoPatchelfHook` for biome's linux-gnu
binary) is exactly the failure that raised this one.

The right shape is **one** flake output serving both: a dev tree built by
`importNpmLock.buildNodeModules` plus the loader/patchelf fix, exported and
placed by a recipe. Whoever takes either item should land it once, not once per
side of the wall.

## Provocation

Should the justfile depend on `npx` at all? Every `npx <tool>` in it is a
resolution rule the flake could own outright; the fallback to `npm ci` is what
IMP-001 item 3 keeps for the host.
