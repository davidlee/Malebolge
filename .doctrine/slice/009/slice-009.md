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

1. **Bridge socket** served by the daemon: a separate, restricted endpoint
   carrying only bridge verbs (pair, post, receive), not the full attach
   protocol. The daemon cannot reach into a jail, so pi dials out and holds
   the connection.
2. **Pairing**: a pi session pairs with one malebolge conversation (new, or
   resumed by id). The pairing survives pi reconnects.
3. **Messages both ways**, starting turns on the receiving side. Messages to
   a disconnected pi are queued and delivered on reconnect.
4. **Loop bound**: two agents exchanging turn-starting messages must not run
   unbounded (cf. RSK-003). The bound is in code.
5. **Driver posture**, set by agreement per pairing: SATAN delegates and pi is
   its hands, or the operator works in pi and pi consults SATAN. Mechanism
   (prompt text, a mode, a flag) is design's.
6. **Reach**: a bridged conversation's talk set (RFC-003, DEC-032). Likely its
   own set, so the jail's capability does not leak into other conversations.
   Messages from pi carry repo content and are framed as data with
   provenance.
7. **The pi extension**: the pi-side client — connect, pair, post as a tool,
   inject received messages as turns.
8. **Flakes combinator** (in `~/flakes`, a sibling change): `jailed-agents`
   gains a combinator that mounts the bridge socket's directory read-only
   into pi profiles, and a read-only option for the project mount.

## Non-Goals

- Emacs changes. The bridged conversation is attachable like any other.
- SATAN reading or writing host files itself (preflight option B).
- Network policy for the jailed pi: the jail profile's concern.
- IMP-018 (new conversation in a named topic from Emacs).
- Many pi sessions per conversation, or conversation-to-conversation fan-out
  through a bridge.

## Open Questions

- **OQ-1 Socket and protocol.** A second socket from the same daemon, or a
  verb-filtered mode on the existing one? Wire shape: reuse the ndjson frames
  of `src/protocol.ts`?
- **OQ-2 Authentication.** Is the mount (who can see the socket) enough, or
  does pairing need a token? Several jails share one socket directory.
- **OQ-3 Turn semantics.** Does every message start a turn, or only some
  (reply vs note)? How does a reply correlate with its request?
- **OQ-4 Loop bound.** Per-pairing hop budget reset by an operator turn, a
  rate cap, or reuse thread admission (`src/threads/admission.ts`, `caps.ts`)?
- **OQ-5 Mode and talk set.** A new `bridge` mode, or interactive plus a
  bridge extension? Which talk set?
- **OQ-6 Extension home and packaging.** Where the pi extension lives (this
  repo, a package), and how the jail loads it.
- **OQ-7 Posture.** How the posture is agreed and recorded, and whether it can
  change mid-pairing.
- **OQ-8 Queue durability.** In memory for the daemon's lifetime, or stored?

## Risks

- **Reach widens SATAN's capability**: whatever the jailed pi can do (files
  rw, network if the profile has it) becomes reachable from the bridged
  conversation (RFC-003 "reach is authority"). Mitigated by its own talk set
  and the operator's jail profile choice.
- **Foreign text inward**: repo content and pi's output enter SATAN's
  transcript (RSK-002, lighter: the operator's own repos, but dependencies and
  vendored text are not).
- **Runaway exchange** between two agents (RSK-003).
- **Socket impersonation** if the directory mount is writable (ISS-042).

## Verification intent

- Tests (fake daemon / fake pi client): pairing, both directions, queue on
  disconnect, loop bound refuses with an explicit reason, refused verbs on the
  bridge socket.
- VH: a jailed pi in a real project pairs with a conversation; each posture
  completes one exchange; a read-only mount refuses a write.

## Summary

## Follow-Ups
