# Bridge existing conversations: pair pi with an interactive conversation by id

## Context

SL-009 built the session bridge: a jailed pi session and a malebolge
conversation exchange messages over `bridge.sock`. Its pairing (DEC-065)
always creates a new conversation in a dedicated `bridge` mode (DEC-071),
in topic `<project>-bridge`.

The operator, 2026-10-30: the value is in connecting conversations that
already exist, the ones attached from Emacs (`M-x malebolge-attach`). Today
those are interactive conversations and can never gain `bridge_post`: a
conversation's mode is fixed at creation (DEC-025). SL-009's live run
attached from the terminal with `--topic <project>-bridge`, so the gap went
unseen.

Operator positions (2026-10-30 session):

- Jail-sourced text reaching other conversations through threads is not a
  concern; DEC-071's rationale no longer holds for them.
- Network egress from a jail is the jail profile's choice, not malebolge's.
- Mail has no business talking to anything, jailed or another conversation:
  mail-mode conversations stay off the bridge.
- pi names the target conversation; choosing the pi end from Emacs is
  unclear (no way to discover or identify it there).
- Model choice is solved by this approach: the operator creates the
  conversation (with its topic's model) and pi pairs with it.

```
before:  pi /bridge pair <posture>      ──► daemon creates C (mode bridge, topic <project>-bridge)
after:   pi /bridge pair <posture> <id> ──► daemon binds existing conversation <id>
                                            (refused unless its mode is interactive)
```

## Scope & Objectives

1. **Fold bridge into interactive mode; retire the `bridge` mode.** The
   interactive catalog gains the `bridge` extension (room only, beside
   `threads`). `bridge_post` refuses when the conversation is unpaired
   (precedent: bookmarks refuse when unconfigured, DEC-055). Every room
   interactive conversation frames bridge messages as untrusted; the bridge
   environment and posture text render only once the conversation has been
   paired. Startup reconcile re-derives every conversation's extension list
   from its mode, so existing interactive conversations gain the extension
   on restart, and rewrites stored `bridge` toolsets to `interactive` once.
   DEC-025 holds otherwise: no conversation changes mode.
2. **`pair` names its target conversation.** The daemon binds the named
   conversation if it exists and is interactive; otherwise it refuses with a
   reason. With no id, it binds the one conversation an operator client is
   attached to, and refuses none or several. Token, resume and
   newest-connection-wins on the same token are unchanged.
3. **One live pairing per conversation.** A new `pair` on a conversation that
   already has one replaces the old pairing (newest wins, one level up); the
   old connection is closed `superseded by a new pairing`. Outbox and budget
   reset; the seq continues, so a seq is never reused in a conversation.
4. **Emacs shows the conversation id** where the operator can read it to type
   into pi: already true (see Decisions).
5. **Records:** see Decisions; update SL-009's design where it is the living reference
   (via reconcile, not in this scope document).

Unchanged: the outbox (DEC-066, its seq rule widened to the conversation by
DEC-106), pi's inbound framing (DEC-067), turn budget (DEC-070), posture
(DEC-072), deployment contract (DEC-073/074), env and status
(DEC-096/097/098).

## Non-Goals

- Pairing initiated from Emacs (one-time code, pi-end discovery).
- Bridging mail-mode or job conversations.
- Changing a conversation's model after creation.
- Network policy for jails.

## Decisions (design inquiry, 2026-10-30)

- DEC-099: pair binds an existing interactive conversation by id; refuses
  unknown ids and non-interactive toolsets; creates nothing. Supersedes DEC-065.
- DEC-100: the `bridge` mode is retired; the bridge extension joins
  interactive, room only. Supersedes DEC-071; amends DEC-029, 032, 076.
- DEC-101 (was OQ-2): startup reconcile rewrites stored `bridge` toolsets to
  `interactive`, once. Refines DEC-025.
- DEC-102: the bridge section's environment and posture text render only
  once a conversation has been bridged. Refined by DEC-107.
- DEC-103: a new pair replaces the conversation's pairing; the old connection
  is closed `superseded by a new pairing`.
- DEC-104 (was OQ-1): pair with no id binds the one conversation an operator
  client is attached to; refuses none or several. Supersedes DEC-092, 093.
- DEC-105: a bridge-started turn opens a new origin (refines DEC-036).
- DEC-106: a re-pair keeps the conversation's seq allocator. Refines DEC-103,
  DEC-066.
- DEC-107: every room interactive conversation renders the untrusted-bridge
  framing, so a fork carrying bridge history stays framed. Refines DEC-102.
- Stale pairings are accepted; an attach-side end is IDE-010.
- Verification (was OQ-3) includes an Emacs-attached VH.
- Objective 4: Emacs already prints `attached to conversation N`
  (`src/render.ts:372-376`); no Emacs change is required.

## Affected surface

- `src/toolsets.ts` (catalog, profile policy), `src/persona.ts`
- `src/bridge/**` (pairing, listener, extension)
- `src/topics.ts`, `src/session.ts` (startup reconcile),
  `src/conversations.ts` (header comment)
- `pi-bridge/**` (`/bridge pair` argument, `malebolge-bridge` command)
- `src/daemon.ts`, `src/daemon-start.ts` (attached-conversation set for DEC-104)
- `src/threads/**` (origin kind for DEC-105)
- `test/**`
- `README.md`, `docs/internals.md`

## Verification intent

- VT: pair by id binds an existing interactive conversation; refuses a
  missing id, a mail-mode conversation; a second pair supersedes the first
  and the seq continues.
- VT: an interactive conversation unpaired has `bridge_post` refusing and a
  bridge section of the untrusted framing alone; paired, the full section.
- VT: startup reconcile with stored `bridge`-mode records (DEC-101).
- VH: from Emacs, attach to an existing conversation, pair pi to its id,
  exchange messages both ways.

## Risks

- A line from a superseded pi connection already in progress when a new
  pair commits may act once on the new pairing; the next line is refused.
  Accepted: visible, recovered by re-pairing or resuming, and pair is not
  a security boundary (design sec-4).
- The first daemon start after this slice rewrites and logs every room
  interactive conversation's extension list once (the list gains `bridge`).

## Open Questions

None.

## Summary

Done 2026-10-30. pair binds an existing room interactive conversation by id,
or the one attached conversation, and creates nothing. The `bridge` mode is
retired (stored records rewritten once at startup). A re-pair replaces the old
pairing and keeps the seq. Every room interactive conversation frames bridge
messages as untrusted. A bridge turn opens its own origin. Both sides' prompts
treat commit-named paths as shared. Audit: RV-031 (no blocker); VH-1 waived by
the operator, live use substituted.

## Follow-Ups

- CHR-008: SATAN's posture text and where turn policy lives.
- CHR-009: malebolge's flake still hand-rolls the bridge jail.
- IDE-010: ending a pairing from the attach side.
