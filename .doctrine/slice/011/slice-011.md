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
   (precedent: bookmarks refuse when unconfigured, DEC-055). The bridge
   prompt section renders only while paired. Startup reconcile re-derives
   every conversation's extension list from its mode, so existing
   interactive conversations gain the extension on restart. DEC-025 holds:
   no conversation changes mode.
2. **`pair` names its target conversation.** The daemon binds the named
   conversation if it exists and is interactive; otherwise it refuses with a
   reason. Token, resume and newest-connection-wins (DEC-065) are unchanged.
3. **One live pairing per conversation.** A new `pair` on a conversation that
   already has one ends the old pairing (newest wins, one level up).
4. **Emacs shows the conversation id** where the operator can read it to type
   into pi: already true (see Decisions).
5. **Records:** see Decisions; update SL-009's design where it is the living reference
   (via reconcile, not in this scope document).

Unchanged: the outbox (DEC-066), pi's inbound framing (DEC-067), turn budget
(DEC-070), posture (DEC-072), deployment contract (DEC-073/074), env and
status (DEC-096/097/098).

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
- DEC-102: the bridge section renders only once a conversation has been bridged.
- DEC-103: a new pair replaces the conversation's pairing; the old connection
  is closed `superseded by a new pairing`.
- DEC-104 (was OQ-1): pair with no id binds the one conversation an operator
  client is attached to; refuses none or several. Supersedes DEC-092, 093.
- DEC-105: a bridge-started turn opens a new origin (refines DEC-036).
- Stale pairings are accepted; an attach-side end is IDE-010.
- Verification (was OQ-3) includes an Emacs-attached VH.
- Objective 4: Emacs already prints `attached to conversation N`
  (`src/render.ts:372-376`); no Emacs change is required.

## Affected surface

- `src/toolsets.ts` (catalog, profile policy, talk sets)
- `src/bridge/**` (pairing, listener, extension)
- `src/session.ts` (startup reconcile), `src/conversations.ts` (topicInit use by pair)
- `pi-bridge/**` (`/bridge pair` argument, `malebolge-bridge` command)
- `src/daemon.ts`, `src/daemon-start.ts` (attached-conversation set for DEC-104)
- `src/threads/**` (origin kind for DEC-105)
- `test/**`

## Verification intent

- VT: pair by id binds an existing interactive conversation; refuses a
  missing id, a mail-mode conversation; a second pair supersedes the first.
- VT: an interactive conversation unpaired has `bridge_post` refusing and no
  bridge prompt section; paired, both present.
- VT: startup reconcile with stored `bridge`-mode records (per OQ-2).
- VH: from Emacs, attach to an existing conversation, pair pi to its id,
  exchange messages both ways.

## Summary

## Follow-Ups
