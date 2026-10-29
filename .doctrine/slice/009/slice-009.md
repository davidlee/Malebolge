# Session bridge: a jailed pi session and a malebolge conversation exchange messages

## Context

Operator, 2026-10-29: SATAN should work in a chosen project folder, read-only
or read-write, under a jail. The preflight found:

- The room (`assistant`, a firecracker microVM, `/srv/fleet`) has no host
  shares, so no host folder can reach SATAN's coding tools there. Room repo
  clones (`/work/<target>`, oubliette SL-006) are fleet targets only, and
  satan only reads them.
- `~/flakes/agents/jailed-agents.nix` already runs per-project pi jails: the
  launch dir is mounted at `/workspace/<project>` (DEC-078). The operator
  already runs these.
- The same file already mounts a socket *directory* read-only into pi jails
  for satan-mcp (`jailed-agents.nix:168-172`); a writable directory would let
  the jail replace the socket and impersonate the server (ISS-042).
- Conversations already post to each other as threads (SL-006).

Rather than a new host-side tool backend for SATAN (preflight option B), the
operator chose a bridge: a pi extension in the jailed project session talks to
one malebolge conversation over a restricted daemon socket. SATAN never
touches the project files; the jailed pi does.

```
operator ── Emacs ──► malebolge-room daemon (offline; room tools)
                         ▲  bridged conversation C
                         │  bridge socket: bridge verbs only, dir mounted ro
                         ▼
                  jailed pi + bridge extension
                  /workspace/<project> (ro | rw: the jail's mount)
```

## Scope & Objectives

1. **Bridge socket** served by the daemon (DEC-064): a second listener at
   `$XDG_RUNTIME_DIR/satan/durable/room/bridge/bridge.sock` in its own
   directory (0700, socket 0600), with its own first-line table and frame
   vocabulary, newline-delimited JSON. First lines: pair, resume, post-once.
   Bound frames: post, ack, refill, end (client); paired, accepted, refused,
   deliver (daemon). Room profile only. The daemon cannot reach into a jail,
   so pi dials out and holds the connection.
2. **Pairing** (DEC-065): pair creates a bridge-mode conversation in topic
   `<project>-bridge` and returns a token; resume by {conversation, token}
   survives pi reconnects and restarts; the newest connection wins; end
   closes the pairing.
3. **Messages both ways**, kind turn (starts a turn) or note (seen at the next
   turn) (DEC-069). SATAN to pi through a durable outbox in the pairing
   document, pushed and acked per entry, capped; entries carry their kind
   (DEC-066, DEC-080). pi is handed a message only while idle; deliveries
   during a run are buffered and flushed at settle, and after an operator
   abort they join the next turn as notes (DEC-090, DEC-079). pi to SATAN as one
   direct input or write per message, idempotent by pi tool call id, with a
   notice to pi when a queued turn is withdrawn (DEC-067). Each message
   enters each side's context once; no receive tool (DEC-068).
4. **Loop bound** (DEC-070): a per-pairing budget of bridge-started SATAN
   turns, spent at admission in its own commit before the submit (DEC-078),
   refused loudly when exhausted, refilled by operator input on either side.
   In code.
5. **Driver posture** (DEC-072): delegate or consult, chosen at pair, fixed
   for the pairing, rendered as prompt text on both sides.
6. **Reach** (DEC-071, DEC-076): a new `bridge` mode, interactive minus
   threads plus bridge, in no talk set, room only. A wake to another
   conversation must share the caller's talk set, so a bridge conversation
   wakes only itself. pi's messages are escaped and framed as untrusted data
   with provenance (DEC-067).
7. **The pi extension** (DEC-073): `pi-bridge/` in this repo, ro-mounted into
   the jail home's extensions directory — connect, pair, resume, post as a
   tool, inject received messages, loud connect failures.
8. **`malebolge-bridge send` / `tee`** (DEC-075): post stdin as one note (or
   `--turn`) through a one-shot frame, outside pi's context.
9. **Deployment contract** (DEC-074): malebolge states what `~/flakes` must
   provide (bridge directory ro-bound, env forwarded, extension ro-bound,
   read-only project mount option). Implementation is CHR-007, in `~/flakes`.

## Non-Goals

- Emacs changes. The bridged conversation is attachable like any other.
- SATAN reading or writing host files itself (preflight option B).
- Network policy for the jailed pi: the jail profile's concern.
- IMP-018 (new conversation in a named topic from Emacs).
- Many pi sessions per conversation, or conversation-to-conversation fan-out
  through a bridge.
- Changes in `~/flakes` or the satan launcher (DEC-074; CHR-007).
- Posture change mid-pairing (DEC-072: a new pairing).
- Bridge autonomy modes beyond the fixed budget (IDE-009).

## Open Questions

All answered by accepted decisions.

- **OQ-1 Socket and protocol.** A second listener in its own directory, own
  first-line table, ndjson framing — DEC-064.
- **OQ-2 Authentication.** The mount is the boundary; a pairing token stops
  accidental resume — DEC-065.
- **OQ-3 Turn semantics.** Turn or note; no reply ids, conversation order
  suffices — DEC-069; idempotence by tool call id — DEC-067.
- **OQ-4 Loop bound.** Per-pairing turn budget refilled by operator input —
  DEC-070.
- **OQ-5 Mode and talk set.** New `bridge` mode, no talk set — DEC-071; wake
  reach checked — DEC-076.
- **OQ-6 Extension home and packaging.** `pi-bridge/`, ro-bound into the jail
  home — DEC-073; deployment contract — DEC-074.
- **OQ-7 Posture.** Chosen at pair, fixed, prompt text — DEC-072.
- **OQ-8 Queue durability.** Stored in the pairing document — DEC-066.

## Risks

- **Reach widens SATAN's capability**: whatever the jailed pi can do (files
  rw, network if the profile has it) becomes reachable from the bridged
  conversation (RFC-003 "reach is authority"). Mitigated by the no-talk-set
  mode (DEC-071), the wake check (DEC-076) and the operator's jail profile.
- **Foreign text inward**: repo content and pi's output enter SATAN's
  transcript (RSK-002, lighter: the operator's own repos, but dependencies and
  vendored text are not). Mitigated by escaping and data framing (DEC-067).
- **Runaway exchange** between two agents (RSK-003). Bounded by DEC-070.
- **Socket impersonation** if the directory mount is writable (ISS-042).
  The contract ro-binds it (DEC-074).
- **Accepted residuals** (operator): token readable from the shared jail home
  (DEC-065); a pairing made before pi's first session entry dies with pi
  (DEC-065); daemon death between outbox append and tool settlement reports
  the call interrupted (DEC-066, DEC-043, IMP-020); a daemon restart loses the
  withdrawal watch of a queued pi turn (DEC-067); a subverted pi can fake
  refills (DEC-070); a crash or failed submit after the spend costs one budget
  unit (DEC-078); an idle-only `/reload` racing a turn's persistence could
  inject it twice (DEC-090); an operator input in pi during an outage does
  not refill.
- **Assumptions** verified in plan PHASE-01: ASM-004..ASM-008.

## Verification intent

- Tests (fake daemon / fake pi client): pairing and resume (token refused,
  newest connection wins, end refuses later frames); both directions, turn
  and note; outbox redelivery on reconnect, per-entry ack and dedupe; outbox
  cap refusal; idempotent resend by tool call id; withdrawal notice; budget
  exhaustion refuses with an explicit reason, notes pass, refill restores;
  refused verbs on the bridge socket; bridge mode reach (no threads, wake to
  another conversation refused, self-wake allowed); escaping and truncation;
  one-shot exit statuses; tool-result texts (DEC-068); the extension's
  pairing state table (fork, end, supersede, pending posts, reply deadline)
  and the idle-only buffer and flush (DEC-090).
- VH: a jailed pi in a real project pairs with a conversation; each posture
  completes one exchange; a read-only mount refuses a write; a connect
  failure notifies the operator. VA in PHASE-01: busy delivery, Esc, settle
  against real pi shows the message once, as a note.

## Summary

## Follow-Ups
