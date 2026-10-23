# IMP-005: justfile has no gate recipe, so doctrine check gate (and check commit's default) cannot run

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

`doctrine check` proxies to a project-declared command per cadence (SL-163).
Unconfigured, `check gate` defaults to `just gate` and `check commit` to
`just check`. This repo's `justfile` has `check` (fmt-check + lint + typecheck +
test) but no `gate` recipe, so:

    $ doctrine check gate
    error: justfile does not contain recipe `gate`

Found running SL-002 PHASE-01 (2026-10-23), whose execute skill names
`doctrine check gate` as the verification step. The phase ran the components the
plan's criteria actually name instead — `biome format .`,
`npx eslint . --max-warnings 0`, `npx tsc --noEmit`, `npx vitest run`, `just ert`,
`just smoke` — so nothing was skipped, but the doctrine-level verb is dead here
and every agent that follows the skill will hit the same error.

## Detail

- The end-of-phase cadence is the one that matters: `gate` should be at least
  `check`, plus the suites `check` deliberately excludes (`ert` needs emacs,
  `smoke` needs emacs and a socket). The comment in the justfile already draws
  that line.
- `check commit`'s default (`just check`) is fine today.
- Consequence for criteria: any plan that writes "`doctrine check gate` green"
  as an EX row is unsatisfiable in this repo until a `gate` recipe exists. SL-002
  avoided that by naming the components; a future plan may not.

## Options

- Add `gate: check ert smoke` to the justfile (cheap, matches the existing
  comment's split).
- Or declare `[check] gate = "…"` in `.doctrine/doctrine.toml` if a
  project-declared command is preferred over the recipe convention.
