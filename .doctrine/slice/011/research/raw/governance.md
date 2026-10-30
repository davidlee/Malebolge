## Binding constraints

| id | what it requires of SL-011 | evidence (quote ≤20 words) |
|---|---|---|
| DEC-016 | `pair` must stay explicit; no frame may create a topic implicitly, and attach keeps refusing unknown topics | "an unknown topic is refused, never created implicitly" |
| DEC-025 | Pair may not change a conversation's mode: refuse non-interactive targets, never rewrite/adopt a stored mode; topic-borne toolset rule else applies | "A conversation's toolset is fixed at creation and never changes" |
| DEC-029 | Interactive's list is `(toolset, profile)` and profile-conditional; reconcile re-derives and must still refuse a stored mode the policy disallows | "the complete ordered list, prompt and tool extensions alike"; "startup refuses when a static name is not installed" |
| DEC-032 | One `requireSameTalkSet` governs start/fork/post; a bridged interactive conversation therefore *is* in room's interactive set | "Room: {interactive: 'interactive'}; mail and host have no entry" |
| DEC-036 | A bridge-started turn's posts need a defined origin or the family caps miscount | "a turn started by a satan.post inherits the post's origin" |
| DEC-055 | Precedent for capability present, calls refused when unconfigured (no environment-varying toolset list) | "every bookmark tool call returns an explicit 'bookmarks are not configured' error" |
| DEC-064 | Listener, path, private-dir rule and tables unchanged; `pair` gains a key additively only | "a second listener with its own handler table and its own frame vocabulary" |
| DEC-066 | Outbox, per-entry ack, cap 32, redeliver-everything-on-bind survive; pairing doc now on a shared conversation | "At the budget … 'outbox full, pi is not draining'" (`.doctrine/slice/009-session-bridge/design.md:206`) |
| DEC-067 | One input per post, `requestId: bridge:<conversation>:<id>`, kind `satan.bridge`, withdrawal notice | "a resend after reconnect is not duplicated and needs no sequence allocator" |
| DEC-068 | Ack-only tool results; exactly-once per side | "Post tools on both sides return a short ack … never an echo" |
| DEC-069 | turn/note mapping unchanged by the pairing's host conversation | "A message has kind turn (default) or note" |
| DEC-070 | Budget 10 and refill sources stay as written; SL-011 must state their new effect | "a human input in the bridged conversation" (`design.md:335`) |
| DEC-072 | Posture stored on the pairing, fixed until a new pair; not on the conversation | "Changing posture means a new pairing" |
| DEC-073 | Extension registration and loud-failure contract (`/bridge pair`, `bridge_post`) unchanged | "A connect failure is loud, never silent" |
| DEC-074 | No new jail mounts or env beyond the existing contract | "the directory … created before a pi jail starts, ro-bound into pi jails" |
| DEC-075 | `post-once` and its env vars still path through the paired conversation | "post-once {conversation, token, kind, text}" |
| DEC-078 | Turn spend still its own commit before the submit | "one commit first reads tx.submissionByRequest … then runs admitTurn" |
| DEC-079, DEC-090 | Idle-only injection; abort flushes buffered turns as notes | "pi is never handed a bridge message while running" |
| DEC-080 | Outbox and `deliver` carry `kind` | "an outbox entry is {seq, kind, text}" |
| DEC-095 | `/bridge end` in outage unpairs locally, doc left as is — now on a live conversation | "no frame to the daemon, whose pairing document is left as is" |
| DEC-096, DEC-097 | Bridge env for `!` commands; powerbar status | "a user_bash handler returns pi's local bash operations with bridgeEnv applied" |
| DEC-098 | `BRIDGE_ENVIRONMENT`/`PI_BRIDGE_ENVIRONMENT` must accompany whatever section survives gating | "states where the other runs, that it cannot see the other's files" |
| RSK-002 | Mail must stay unreachable: refuse mail targets outright, not merely by talk set | "Mail will be classified for risk before it is read" ; "mail mode has mail tools only" |

## To supersede or amend

| id | which clause conflicts | proposed disposition |
|---|---|---|
| DEC-065 | "pair … creates a bridge-mode conversation in the topic `<project>-bridge`"; consequence "bridge conversations live in their own topic so attach by project topic never lands on one"; token/resume/newest-*connection*-wins still wanted | supersede, carrying the token, resume, supersede-close and posture/topic-free clauses forward |
| DEC-071 | Whole decision: `bridge` in CATALOG/PROFILE_TOOLSETS, no talk set, room only, "bridge must be allowed before any conversation stores it" | supersede (OQ-2 still needs an answer for stored `bridge` records) |
| DEC-092 | `pair` creating through `topicInit` and applying a topic model to a new conversation | supersede (no creation at pair; model comes from the operator-created conversation) |
| DEC-093 | "creating the `<project>-bridge` topic … is part of what pair does" | supersede (also restores the `src/conversations.ts:11` "no frame ever creates a topic implicitly" comment) |
| DEC-076 | Consequences "a bridge conversation can wake only itself, only a bridge conversation itself schedules wakes into it"; rationale rests on bridge having no talk set | amend — the wake check stays, but a bridged conversation now sits in interactive's set, so wake reach is wide open pending an operator call |
| DEC-029 | `CATALOG.bridge` exists; interactive's room list ends "coding-tools, grep, tasks, satan" with no bridge extension | amend — drop `bridge` from the catalog, add the bridge extension (room only) to interactive's list |
| DEC-032 | Context/consequences treat "a mode in no set" as the quarantine for jail-sourced text (bridge precedent) | amend — record that pairing no longer removes a conversation from the interactive talk set |

## Checked, not applicable

| id | reason it does not bear on SL-011 |
|---|---|
| DEC-081 | classify child env/limits; mail path only |
| DEC-082 | `ModelCatalog`/`requireModel` seam for creation; `pair` no longer resolves a model |
| DEC-083 | Refuses creation in a topic with an unknown model; `pair` creates nothing |
| DEC-084 | `thread_start`/fork model precedence; untouched |
| DEC-085 | `creationModel`/`topicInit` at creating paths; `pair` ceases to be one |
| DEC-086 | Topic-frame model key and `--set-topic --model`; wire untouched |
| DEC-087 | `--list` already prints the id, which is what objective 4 needs; no change |
| DEC-088 | `--models` listing; unrelated |
| DEC-089, DEC-091 | Emacs chooser/bounded client; objective 4 is display-only |
| DEC-094 | Mail sender text from `seen`; mail stays off the bridge |
| DEC-077 | Jev window clamping; mail |
| DEC-018..DEC-024, DEC-026..DEC-028, DEC-030, DEC-031, DEC-033..DEC-035, DEC-037..DEC-063 | not staged in this slice's governance file; cited above only where a staged record amends them |

## Hazards

- **Budget becomes inert.** Refill fires on any human input in the bridged conversation (`design.md:335`); that is now the operator's Emacs conversation, so `BRIDGE_TURN_BUDGET = 10` (DEC-070) is refilled continuously and the loop bound collapses. Needs an explicit decision, not a silent regression.
- **Wake reach reopens (DEC-076).** DEC-076 existed because "a bridge conversation could wake out with jail-sourced text"; with `interactive`'s talk set (DEC-032) a bridged conversation can wake and be woken. The operator's position covers *threads* only — wakes are unaddressed and would violate DEC-076's rationale.
- **Origin accounting (DEC-036).** A `satan.bridge` input is neither `pi.user` nor `satan.wake`, so no clause says whether its turn opens a new origin; a bridged conversation's posts to threads could inherit an unrelated origin or escape family caps.
- **Outbox lands in the operator's transcript (DEC-066, DEC-095).** Outage-local `end` leaves the pairing document live (`design.md:412`), as does the DEC-065 residual "pi writes no session file before the first user or assistant message"; `bridge_post` then keeps queuing into `BRIDGE_OUTBOX_CAP` on a conversation the operator uses, refusing `outbox full, pi is not draining` (`design.md:206`) during ordinary work.
- **Abort downgrade (DEC-079, DEC-090).** Operators abort in their own conversations far more than in a bridge-only one; every abort flushes buffered bridge turns as notes, so jail text re-enters context later with no turn and no visible pause.
- **Prompt gating vs reconcile (DEC-029, DEC-098).** The section must render "only while paired", but extension lists are re-derived from the mode at startup (DEC-029(6)) and the section set is pinned by `test/daemon-sections.test.ts` (design §9). A prompt-time read of the pairing doc that silently fails drops the untrusted framing while `bridge_post` stays live — the one guarantee in DEC-067 that must not degrade.
- **Static-name startup refusal (DEC-029(4)).** The bridge extension is room-only, but a static name in interactive's list makes a host daemon refuse to start; SL-011 must make the name profile-conditional or drop the entry from `host`.
- **Two supersede mechanisms collide (DEC-065, DEC-073).** DEC-065 supersedes the *connection*; SL-011 supersedes the *pairing* on a conversation. If a re-pair rewrites `tokenHash`, the old client sees `bad token` (terminal, loud, `design.md:176`) instead of `superseded by a newer connection` (`design.md:409`), and its pending posts must `settlePending` first — ordering is unspecified.
- **Posture drift (DEC-072).** Posture is per pairing while the conversation survives re-pairs; a re-pair changing posture must re-render SATAN's section and pi's `before_agent_start` section together or the two sides run different conduct text.
- **STORED default topic `default` (guess).** Interactive conversations in the `default` topic now gain a bridge extension whose `pair` no longer validates any topic name; nothing prevents pairing a conversation whose project basename disagrees with pi's asserted `project` — the old topic rule was the only check. (Marked: guess, unverified against `src/protocol.ts`.)
