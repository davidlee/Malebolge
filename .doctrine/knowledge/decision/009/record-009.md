## Context

`M-x malebolge-attach` takes no arguments and appends only `--emacs`
(`emacs/malebolge.el:211-229`); the program it runs is
`malebolge-attach-command` (`:44-47`). The transcript and draft are single,
fixed-name buffers (`:69-70`), the draft's submit path holds one process
(`:177-190`), and the daemon's `attached` notice already prints
`attached to conversation N` into the transcript (`src/render.ts:246-247`).
RFC-002 §Clients: "SL-002 adds a target prompt over bare ids. With topics: one
buffer per conversation."

## Choice

- **Plain `M-x malebolge-attach` behaves as today**: root, or the live client if
  one is attached — no prompt, no change.
- **`C-u M-x malebolge-attach` prompts for a target** with `completing-read` over
  the daemon's own ids, obtained by running the attach command with `--list`
  before any comint buffer is created. A final `new` candidate creates a
  conversation. Candidates are bare numbers, newest first, exactly as the daemon
  sends them (RFC-002 D4 puts labels at step 4).
- **The listing is a synchronous subprocess into a temporary buffer**, stderr
  merged, bounded by the client's own 10 s connect wait. A non-zero exit — daemon
  down, daemon predating `list` — raises `user-error` carrying that output and the
  attach is abandoned. It never silently falls back to root.
- **The chosen target becomes argv**: `--conversation N`, or `--new`, before
  `--emacs`. A buffer-local records the target the client asked for, so a later
  targeted attach can tell switch from re-pop.
- **Switching is safe by construction.** With a live client and a named target:
  detach it (`malebolge-quit`'s frame, then a bounded wait for the process, then
  `delete-process` if it survives) and attach into the same buffers. **If the
  draft holds any non-whitespace text, the switch is refused** with a message to
  submit or clear it first — the one buffer pair is shared, so a switch would
  otherwise send one conversation's draft to another.
- **Buffer names stay `*malebolge*` and `*malebolge-draft*`.** Per-conversation
  buffers are RFC-002 step 4's.

## Alternatives

- A defcustom for the target: one conversation per Emacs, decided at config time.
- Always prompting (no prefix argument): a tax on the common case, which is root.
- Falling back to root when `--list` fails: hides a real failure and attaches
  somewhere the user did not ask for.
- Switching while keeping the draft: cheaper code, wrong conversation.

## Rationale

The prompt is where the hostility of numeric ids is paid, once, by a picker —
which is exactly what RFC-002 anticipated for this step. Refusing a switch with a
non-empty draft trades a small annoyance for never crossing two conversations'
text.

## Consequences

- `emacs/malebolge.el` gains a target-prompting path, a listing subprocess, and a
  detach-then-attach switch; `test/malebolge-ert.el` covers the refusal and the
  argv shaping.
- The Emacs end-to-end smoke (`test/emacs-attach-smoke.ts`) gains a targeted
  attach against a fake daemon.
- A daemon-side `list` is now load-bearing for Emacs: with it broken, `C-u`
  attach fails loudly rather than degrading.

## Amendments (2026-10-23, after the informal critical pass)

- **No buffer-local target record.** `malebolge--live-process`
  (`emacs/malebolge.el:176-179`) already answers whether a client is live, and a
  stored target has no lifecycle: after `C-c C-q` it would still name an old
  conversation while a plain `M-x malebolge-attach` reuses the same buffer for
  root, and step 4's per-conversation buffers would inherit the lie. The
  transcript's `attached to conversation N` is the only authority on what is bound.
- **A switch must restore following.** `erase-buffer`
  (`emacs/malebolge.el:218-222`) clips point to `point-min` and
  `comint-scroll-to-bottom-on-output` is nil (`:163`), so the new snapshot would be
  inserted below point and the window would never follow: `goto-char (point-max)`
  after the erase, and set the point of windows already showing the buffer. An ERT
  case asserts it.
- **The listing call is announced.** A `message` plus `redisplay` before the
  synchronous subprocess, so that a stopped daemon — the ordinary case when a
  targeted attach is requested — does not freeze Emacs silently; DEC-008's short
  wait bounds the pause.
