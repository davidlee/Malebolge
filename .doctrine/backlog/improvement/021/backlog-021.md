# IMP-021: Transcript faces read right under foxglove-dark: [tool], [thread], [wake] distinct from operator text

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Observed 2026-10-29 (SL-006 VH-1): under the operator's current theme,
`foxglove-dark`, `[tool]` and `[thread]` lines render white, the same as the
operator's own text; `[wake]` lines are white by design (`malebolge-user-face`).

Cause: the package faces inherit semantic defaults that foxglove-dark leaves at
the default foreground `#d2d2cf`: `malebolge-tool-face` ->
`font-lock-function-name-face`, `malebolge-thread-face` ->
`font-lock-constant-face`. The operator's config sets no `malebolge-*` face.
The theme's distinct colours: red `error`/strings `#db919d`, amber `warning`
`#cb9e5c`, blue `success` `#a1bbfe`, grey `shadow` `#737270`.

Layering the operator wants: package faces inherit something semantically
sensible (the default); the operator's config overrides the mode-local
`malebolge-*` faces to the right colour (as SATAN's red comes via `error`).

Proposed:
1. Package (emacs/malebolge.el): add `malebolge-wake-face`, inheriting
   `malebolge-thread-face` (a wake, like a post, is input SATAN made, not the
   operator); point the `[wake] scheduled by` label at it. ERT pin.
2. Operator config (~/.config/emacs/apps/dl-satan.el, outside this repo):
   `:custom-face` on the malebolge use-package, inheriting theme faces, not hex:
   tool -> `success` (blue); thread -> `warning`, weight normal (amber);
   reap -> `warning` bold + underline. SATAN stays `error` (red), status
   `shadow` (grey).
Open: should wakes look different from posts?

Done 2026-10-29: package part in 52dcfbf (`malebolge-wake-face`, ERT-pinned);
operator config `:custom-face` added to ~/.config/emacs/apps/dl-satan.el
(tool -> success, thread -> warning normal, reap -> warning bold underline),
left uncommitted in that repo for the operator. Wakes read as posts (amber).
