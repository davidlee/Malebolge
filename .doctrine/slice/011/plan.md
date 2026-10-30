# Implementation Plan SL-011: Bridge existing conversations: pair pi with an interactive conversation by id

Prose companion to `plan.toml`. Narrative only — no queried data lives here
(the storage rule); the phase list, criteria, verification, and links are
authored in the TOML. Use this for the plan's rationale and sequencing.
<!-- Reference forms: `lib:reference/glossary.md` § reference forms. -->

## Overview

Eight phases. The daemon side goes first: the attached set, then pair's new
target rule, then replacement. Only once nothing creates a `bridge`-toolset
conversation is the toolset retired and its stored records rewritten. The
framing, origin and pi-side changes follow, then docs and a live operator run.

## Sequencing & Rationale

```
PHASE-01 attached set ──► PHASE-02 pair binds by id / attached ──► PHASE-03 replacement
                                       │                                 │
                                       ▼                                 │
                          PHASE-04 retire bridge toolset + reconcile     │
                                │              │                         │
                                ▼              ▼                         │
                  PHASE-05 framing      PHASE-06 bridge origin           │
                                └──────┬───────┘                         │
                                       ▼                                 ▼
                                PHASE-07 pi side  ◄──────────────────────┘
                                       ▼
                                PHASE-08 docs + live VH
```

- **Pair before retiring the toolset.** The design orders sec-2/3 first by
  topic, but `createBridged` creates `bridge`-toolset conversations and would
  stop compiling the moment `Toolset` loses `bridge`. PHASE-02 deletes the
  create path, so PHASE-04 can retire the toolset and add the reconcile
  rewrite together, in one phase that never leaves the room daemon unable to
  start. Between PHASE-02 and PHASE-04, stored `bridge` conversations are
  refused as not interactive, which only matters to a live deployment; no
  deployment happens before PHASE-08.
- **Attached set alone first.** It is additive and small, and PHASE-02's
  no-id rule needs it. Splitting it keeps PHASE-02 to the listener.
- **Replacement after the target rule.** PHASE-03's three changes (close
  reason, `nextSeq` kept, the token-hash check in `boundLine`) all act on
  re-pairing an existing conversation, which only PHASE-02 makes possible
  without creating a new one.
- **Retirement as one phase.** Toolset, persona, stored types, `liveToolset`
  and the reconcile log must land together: removing `bridge` from `Toolset`
  without the stored type and the narrowing does not typecheck. It is the
  largest phase because test fixtures that built `bridge`-toolset
  conversations move to interactive. If its phase sheet finds it too big, the
  split point is fixtures-and-catalogue vs stored-type narrowing, keeping
  `just check` green at each step.
- **Framing after retirement.** The DEC-107 rule needs no code change
  (`bridgeSectionText` already renders `BRIDGE_UNTRUSTED` alone when not
  bridged), but it only covers every room interactive conversation once the
  extension is in the interactive list. PHASE-05 pins that, plus the fork
  case.
- **Origin is independent.** PHASE-06 touches only `src/threads/`; it needs
  PHASE-04 only so its tests can use an interactive bridged conversation.
- **pi side last.** It depends on the wire key (PHASE-02) and the new
  terminal reason (PHASE-03). Until it lands, pi pairs with no id, which
  PHASE-02 serves through the attached set, so the two sides stay compatible
  at every phase boundary.
- **Live run last.** The VH needs every piece together, from Emacs.

## Notes

- RV-029's plan-level cases are criteria citing `RV-029 F-n`: F-4 (only a
  turn opens a bridge origin) in PHASE-06; F-15 / DEC-106 (seq continues;
  pi receives a re-paired conversation's first message) in PHASE-03 and
  PHASE-07; F-16's single test (a stale line is refused and changes nothing)
  in PHASE-03; F-17 / DEC-107 (a fork keeps the framing) in PHASE-05.
- `PairRequest` on the pi side is `Pick<PairFrame, "posture" |
  "conversation">`: derived from the wire frame, so the two cannot drift, and
  narrower than the frame because `project` comes from the session, not the
  request. It replaces the posture-only payloads of the pair event, the
  pairing phase and `ending.then`, and one builder makes the pair frame where
  two inline copies exist today.
- Test titles carry their `RV-029 F-n` where the plan's VT keywords name one;
  that is how the VT gate finds them.
