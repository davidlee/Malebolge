# IMP-012: Own quotient project forms for malebolge

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Quotient (the `pi_agent` MCP delegation server) runs every delegate inside a
"form": a confining executable chosen per capability (`read`/`write`). A root
with no `.quotient/forms/<capability>` link and no approval falls through to the
machine form named in `~/.config/quotient/policy.json` — today satan's
`quotientFormFamily` (`~/dev/satan/flake.nix`).

Probed 2026-10-26 (`pi_agent`, profile `read`, cwd this repo): that borrowed
form works here — node v24.21.0, just, doctrine 0.47.0, git, and the npm
binaries (vitest, tsc, biome, eslint) are all present.

## Why own one anyway

1. **Node is not pinned.** Satan's form ships nixpkgs `nodejs` (24 today);
   this repo requires `nodejs_24` (`package.json` engines). A nixpkgs default
   bump silently moves delegates' runtime.
2. **Excess surface.** The borrowed form carries satan's toolchain (emacs,
   postgres, zig, supabase, codex/claude) — none used here.
3. **Doctrine path.** The borrowed form puts doctrine at `/run/doctrine-bin`;
   this flake binds it at the host path because doctrine records
   `current_exe()` in what it writes (see `doctrineOptions` in `flake.nix`).

## Shape

Model on `~/dev/screwtape` (not satan — satan's is the older hand-rolled
machine form):

- `quotient` flake input; `quotient.lib.mkFormFamily` over `shellPkgs` plus
  bash, coreutils, findutils, grep, sed, ripgrep, fd, git, with doctrine at
  the host path and the LLM gateway env/key/models as screwtape does.
- `packages.quotient-{read,write}`; `checks.quotient-forms` via
  `quotient.lib.checkFormFamily`.
- `just quotient-forms` linking `.quotient/forms/{read,write}`; gitignore
  `.quotient/`.
- Operator act: `quotient allow /home/david/dev/malebolge` with the printed
  path@sha256.

Caveat: screwtape pins quotient to a local commit because the builder is not on
a published tag (screwtape CHR-001). Pin the same way or wait for a tag.

Wanted before or alongside satan SL-032 PHASE-07 (malebolge-side work run by
pi delegates); not blocking it.
