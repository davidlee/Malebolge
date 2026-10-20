# IMP-001: Build the dev node_modules in the flake so a sealed room runs just check

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Raised 2026-10-19 from oubliette. `just check` runs biome, eslint, tsc and
vitest through `npx`, from a `node_modules` that `npm ci` fills. In oubliette's
`assistant` room there is no egress, so `npm ci` cannot run. That is by design.
Oubliette's policy `POL-005` ("A room never fetches", in oubliette's corpus)
says a room repo's language-package dependencies are its flake's output, fixed
by its lockfile, and the repo puts them into its own tree.

`flake.nix` already builds production dependencies for `runner`
(`buildNpmPackage`, `npmDepsHash`, then `npm prune --omit=dev`). What's missing:

1. **A tree with the dev dependencies.** `importNpmLock.buildNodeModules`
   reads `package-lock.json`'s own integrity hashes, so it needs no
   `npmDepsHash` to bump. `runner` could take its production tree the same
   way.
2. **Export it** in `packages.dev-tools`, or as a small script there that
   places it into the checkout. eslint resolves its plugins and tsc its
   `@types` relative to the repo, so tools on `PATH` alone are not enough.
3. **A recipe that uses it when present** and falls back to `npm ci`
   otherwise (host devshell, slot).
4. **Refuse on drift:** embed a fingerprint of every input that determines the
   tree (`package.json` and `package-lock.json` at least, plus `.npmrc` or
   patches if present). Refuse when the working tree's inputs differ. A
   lockfile hash alone misses a `package.json` edit made without relocking.
   Verify that negative case.
5. **Acceptance:** `just check` passes in the sealed room, from a clean
   checkout and again over an existing tree.
6. **Native binaries.** biome's linux-gnu binary is dynamically linked. It
   needs `autoPatchelfHook` in the derivation, or a loader the room does not
   have yet (oubliette `IMP-021`). Unverified.
