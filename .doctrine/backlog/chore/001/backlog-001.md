# CHR-001: Add a just gate recipe so doctrine check gate runs the project gate

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From RV-004 F-8 (SL-001 audit). `doctrine check gate` fails with "justfile
does not contain recipe `gate`". Add `gate: check` (optionally with `ert` and
`smoke` when Emacs is present) so the doctrine gate runs the project gate.

## Detail (carried from IMP-005, resolved as its duplicate in RV-007)

`doctrine check` proxies to a project-declared command per cadence (SL-163).
Unconfigured, `check gate` defaults to `just gate` and `check commit` to
`just check`. This repo's `justfile` has `check` (fmt-check + lint + typecheck +
test) but no `gate` recipe, so:

    $ doctrine check gate
    error: justfile does not contain recipe `gate`

- The end-of-phase cadence is the one that matters: `gate` should be at least
  `check`, plus the suites `check` deliberately excludes (`ert` needs emacs,
  `smoke` needs emacs and a socket). The comment in the justfile already draws
  that line.
- `check commit`'s default (`just check`) is fine today — but see IMP-001: until
  the dev node_modules and biome come from the flake, `just check` needs the
  devshell on PATH.
- Consequence for criteria: any plan that writes "`doctrine check gate` green"
  as an EX row is unsatisfiable in this repo until a `gate` recipe exists.

## Options

- Add `gate: check ert smoke` to the justfile (cheap, matches the existing
  comment's split).
- Or declare `[check] gate = "…"` in `.doctrine/doctrine.toml` if a
  project-declared command is preferred over the recipe convention.
