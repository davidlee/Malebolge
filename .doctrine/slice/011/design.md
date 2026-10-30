<!-- doctrine:section sec-1 -->
## 1. Overview

SL-009's bridge pairs a jailed pi session with a conversation it creates in a
dedicated `bridge` mode. SL-011 pairs pi with a conversation the operator
already works in: any room interactive conversation, named by id or, with no
id, the one an operator client is attached to.

```
              before (SL-009)                          after (SL-011)
pi ─ pair{posture,project} ─► create C           pi ─ pair{posture,project,conversation?} ─► bind C
                               mode bridge                                         C: interactive (room)
                               topic <project>-bridge                              refused: unknown, not interactive,
                                                                                   no/several attached (no id)
operator ─ attach --topic <project>-bridge ─► C   operator ─ M-x malebolge-attach (root or chosen) ─► C
```

| decision | choice |
|---|---|
| DEC-099 | pair binds an existing interactive conversation by id; never creates (supersedes DEC-065) |
| DEC-100 | `bridge` mode retired; the bridge extension joins interactive, room only (supersedes DEC-071; amends DEC-029, 032, 076) |
| DEC-101 | startup reconcile rewrites stored `bridge` toolsets to `interactive`, once (refines DEC-025) |
| DEC-102 | the bridge section renders only once a conversation has been bridged |
| DEC-103 | a new pair replaces the conversation's pairing; the old connection is closed `superseded by a new pairing` |
| DEC-104 | pair with no conversation binds the one an operator client is attached to (supersedes DEC-092, 093) |
| DEC-105 | a bridge-started turn opens a new origin, kind `bridge` (refines DEC-036) |

Unchanged from SL-009: the listener and its vocabulary apart from `pair`'s new
key (DEC-064), outbox and delivery (DEC-066, 080), inbound framing and
idempotence (DEC-067), exactly-once (DEC-068), turn/note (DEC-069), budget
and refill (DEC-070, 078), posture (DEC-072), deployment (DEC-073, 074),
post-once (DEC-075), pi-side buffering and abort (DEC-079, 090), outage end
(DEC-095), env and status (DEC-096..098). Evidence: `research/research.md`.
<!-- doctrine:section sec-10 -->
## 10. Records to reconcile

At reconcile: SL-009's `design.md` sections on pairing, the bridge mode and
`<project>-bridge` gain a pointer to this design (superseded by DEC-099,
100, 104); `README.md` and `docs/internals.md` updated in code (sec-8).
CHR-008 (posture texts) is unaffected. IDE-010 (end from the attach side)
stays in the backlog.
<!-- doctrine:section sec-2 -->
## 2. Toolsets (DEC-100)

`src/toolsets.ts`:

- `Toolset` loses `"bridge"`; `CATALOG.bridge` is deleted.
- `CATALOG.interactive` gains `"bridge"` between `"bookmarks"` and `SATAN`
  (the position the bridge list gave it), so the room interactive list is
  `persona, project_context, skills, cwd, conversation, coding-tools, grep,
  tasks, threads, bookmarks, bridge, satan`.
- `ROOM_ONLY` gains `"bridge"`: `toolsetList` drops it on host, as it drops
  `tasks` and `threads`. Host never installs or builds-and-requires it.
- `PROFILE_TOOLSETS.room.allowed` becomes `["interactive", "mail"]`.
- `TALK_SETS` is unchanged in shape; with no `bridge` key there is nothing to
  remove. Bridged conversations are interactive and so in the room's
  interactive talk set: threads start, fork, post and wake into and out of
  them (DEC-100 amends DEC-032, DEC-076).

`src/persona.ts`: the `case "bridge"` arm and its comment go.
`src/daemon-extensions.ts`: unchanged in shape; its comment "only the room's
policy installs it" stays true (via `ROOM_ONLY`).

Mail stays off the bridge by two independent facts: mail's list has no
`bridge` extension, and pair refuses a non-interactive target (sec-4).
<!-- doctrine:section sec-3 -->
## 3. Retiring stored `bridge` toolsets (DEC-101)

Without a remap, `allowedToolsets` (`src/session.ts:131-147`) refuses any
stored topic or conversation entry whose toolset is `bridge`, and the room
daemon will not start. SL-009's live run created such records.

`entryToolsets` (`src/topics.ts:327-348`) already rewrites index entries in
the reconcile commit (its backfill). It gains the retirement rule, in one
place, applied to both entries and topic records before they are returned:

```
RETIRED: { bridge: "interactive" }
stored toolset t  →  RETIRED[t] ?? t        (written back when changed)
```

- A rewritten entry is logged by the existing step-3 path, because its
  extension list (the bridge list) differs from interactive's:
  `conversation N: toolset interactive list changed`. A rewritten topic is
  logged `topic NAME: toolset bridge retired, now interactive`.
- The index document is typed, not parsed: `StoredEntry.toolset` and the
  stored `TopicRecord.toolset` (`src/topics.ts:48`, `:54`) widen to a
  `StoredToolset = DaemonToolset | "bridge"`, and `entryToolsets` narrows to
  `DaemonToolset`, so nothing past it sees `bridge`. Topic readers that run
  outside the reconcile (`topicInit`'s `choose`, listings) only ever see
  rewritten records, since reconcile runs before the session serves.
- `<project>-bridge` topics survive as ordinary interactive topics with no
  directory. Their conversations keep their pairing documents; pi sessions
  holding those pairings resume them unchanged.
- Idempotent: a second start finds nothing to rewrite.
<!-- doctrine:section sec-4 -->
## 4. Pair (DEC-099, DEC-103, DEC-104)

### Frame

`pair {posture, project, conversation?}`: `conversation` is optional text,
parsed like `resume`'s with `conversationKeyOf` (strict decimal). The one
vocabulary both ends share, `pi-bridge/wire.ts` `FIRST_LINE_FRAMES.pair`,
gains `conversation: optional(text)` (the listener imports it,
`src/bridge/listener.ts:20`, `:445`). `project`
stays a client assertion, stored on the pairing for display only.

### Target

```
pairRow
  token := mintToken()                          (before any commit, as now)
  id    := frame.conversation ? key or refuse "not a conversation id: X"
                              : attachedTarget(host)       ── DEC-104
  commit:
    entry := index entry for id   or refuse "no conversation N"
    entry.toolset == interactive  or refuse "conversation N has toolset T, not interactive"
    openPairing(pairingDoc(tx, id), posture, project, token)  ── DEC-103 overwrite
  bindAndFollow(state, host, id, token)          (closes an older pairing's connection)
```

- `attachedTarget`: `host.attached()` returns the distinct conversation ids
  bound by live attach connections. One id → it. None → refuse
  `no operator client is attached; name a conversation`. Several → refuse
  `several conversations are attached (N, M); name one` (ids ascending).
- A fork of an interactive conversation is interactive and may be paired.
- The check and `openPairing` run in one commit, so a refusal writes
  nothing. `createBridged`, `bridgedInit`, `requireBridge` and the topic
  creation are deleted; `src/conversations.ts`'s header comment reverts to
  "no frame ever creates a topic implicitly" (DEC-093 superseded).

### Replacing a pairing (DEC-103)

`openPairing` already resets token, posture, project, ended, seq, outbox and
spent. A live connection for the old pairing is the one in
`listener.bindings` for that conversation; `bind` closes it. The reason
becomes context-specific:

- resume or a newer pair connection on the **same** token → `superseded by a
  newer connection` (unchanged; pi keeps its pairing and stops).
- a pair that **replaced** the pairing → `superseded by a new pairing`. pi
  treats it as terminal: it unpairs, as for `bad token`. Its later resume
  would get `bad token` anyway.

`bind` takes the reason from its caller: `pairRow` passes the new reason,
`resumeRow` the old. Posts the old connection had accepted stand (their
inputs are committed); its unanswered posts are answered by the close as
today (pi's `settlePending`).

### Attached set

`src/daemon.ts`'s `serve` keeps the set of its live `Connection`s (added in
`startConnection`, removed on socket `close`). `Daemon` gains
`attached(): readonly ConversationId[]`: the distinct `bound.id` of live,
not-ended connections. A listing connection binds nothing and does not
count; root counts once bound (plain `M-x malebolge-attach` binds root).
`daemon-start.ts` passes `() => daemon.attached()` into `bridgeHostOf`, and
`BridgeHost` gains `attached`. This mirrors `onOperatorInput`, the
existing cross-listener hook.
<!-- doctrine:section sec-5 -->
## 5. The SATAN-side extension (DEC-102)

`src/bridge/extension.ts`:

- `bridgeSectionText(doc)` returns `undefined` (no section) when
  `doc === undefined || !isBridged(doc)`; otherwise unchanged:
  `BRIDGE_UNTRUSTED`, `BRIDGE_ENVIRONMENT`, the posture text. `isBridged` is
  `tokenHash !== ""` (`src/bridge/pairing.ts:100`), true from the first pair
  onwards, including after `end`, so bridge messages still in context stay
  framed as untrusted.
- pi-durable's `PromptSection.render` may return `undefined`, which renders
  no section (`node_modules/@earendil-works/pi-durable/dist/harness/prompt.js:38`).
  A render that throws keeps the section last shown (`:29-35`), so a failed
  pairing read never drops the framing from a bridged conversation.
- `bridge_post` stays registered unconditionally and refuses through
  `appendOutbox` (`not a bridged conversation`, `pairing ended`), as now.
  Its tool description gains one clause: it works only once pi has paired
  with this conversation.
<!-- doctrine:section sec-6 -->
## 6. Origin of a bridge-started turn (DEC-105)

`src/threads/origin.ts`: `Origin.kind` becomes `"human" | "wake" | "bridge"`;
`isOrigin` accepts it. `src/threads/admission.ts` `originOf`: an entry of kind
`BRIDGE_ENTRY_KIND` (`satan.bridge`, `src/bridge/inbound.ts:33`) opens
`{conversation: caller, entry: entry.id, kind: "bridge"}`.

Today `originOf` returns `undefined` for a bridge entry, so `callerOrigin`
skips it and a bridge-started turn inherits the previous input's origin,
sharing that family's cap. A bridge note (a write, DEC-069) is an input entry
of the same kind; it opens an origin only if it is the newest input when a
thread tool is called, which is correct: it is what the turn is acting on.

Family and global caps, reaping and tombstones apply unchanged. Wake
notices and journals print `kind` already; `bridge` appears there as-is.
<!-- doctrine:section sec-7 -->
## 7. pi side

- `/bridge pair <posture> [conversation]`: `pi-bridge/shell.ts` accepts one
  or two words after `pair`; the second must be decimal digits, else usage.
  `BRIDGE_USAGE`: `usage: /bridge pair delegate|consult [conversation], or /bridge end`.
- The `pair` command event and frame carry `conversation` when given
  (`pi-bridge/state.ts` pair event and the frame built at `:673-676`, and the
  re-pair after `end` at `:394`, which keeps the conversation it was asked
  for).
- `TERMINAL_REASONS` gains `superseded by a new pairing` (sec-4).
- Notices: `topicOf`/`Ends.topic` (`pi-bridge/notices.ts`, `shell.ts:593`)
  go; ends name the conversation id when known. `pairFailedText`'s
  `mayHaveCreated` clause becomes: when the pair timed out after sending,
  `the daemon may have paired conversation N` (or `the attached
  conversation` with no id), since pair now creates nothing but may have
  replaced a pairing.
- The `malebolge-bridge` command and env are unchanged (they act on the
  paired conversation by id and token).
<!-- doctrine:section sec-8 -->
## 8. Code impact

| file | change |
|---|---|
| `src/toolsets.ts` | sec-2 |
| `src/persona.ts` | drop `bridge` arm |
| `src/topics.ts` | `entryToolsets` retires `bridge` for entries and topics; stored-toolset read accepts `bridge` (sec-3) |
| `src/session.ts` | topic-rewrite log line; otherwise unchanged (sec-3) |
| `src/bridge/listener.ts` | `pairRow` target resolution, interactive check, overwrite; delete `createBridged`, `bridgedInit`, `requireBridge`; `bind` takes its close reason (sec-4) |
| `src/protocol.ts` (bridge frames) | `pair.conversation` optional |
| `src/bridge/extension.ts` | section gating; `bridge_post` description (sec-5) |
| `src/daemon.ts`, `src/daemon-start.ts` | live-connection set, `Daemon.attached()`, `BridgeHost.attached` (sec-4) |
| `src/conversations.ts` | header comment (DEC-093 superseded) |
| `src/threads/origin.ts`, `src/threads/admission.ts` | `bridge` origin kind (sec-6) |
| `pi-bridge/wire.ts`, `state.ts`, `shell.ts`, `notices.ts` | sec-7 |
| `README.md`, `docs/internals.md` | bridge mode and `<project>-bridge` text replaced by pairing an existing conversation |
| tests | sec-9 |

Not changed: `emacs/malebolge.el` (the transcript already says `attached to
conversation N`, `src/render.ts:372-376`), `src/bridge/pairing.ts`,
`src/bridge/inbound.ts`, `pi-bridge/command.ts`, the jail contract.
<!-- doctrine:section sec-9 -->
## 9. Verification

VT (vitest):

| criterion | test |
|---|---|
| room interactive list contains `bridge` before `satan`; host's does not; `bridge` is no toolset and not allowed | `test/toolsets.test.ts` (rewrites the bridge-catalogue and no-talk-set cases) |
| reconcile rewrites a stored `bridge` entry and topic to `interactive`, re-derives the list, logs, and is idempotent | `test/session.test.ts` |
| pair by id binds an existing interactive conversation and answers `paired` with a token; creates no topic or conversation | `test/bridge-pairing.test.ts` (rewrites create-in-topic cases) |
| pair refuses an unknown id, a non-decimal id, and a mail conversation, writing nothing | `test/bridge-pairing.test.ts` |
| pair without id: one attached → binds it; none / several → refused naming ids | `test/bridge-pairing.test.ts` + daemon `attached()` unit |
| re-pair replaces: old connection gets `superseded by a new pairing`; old token resumes `bad token`; outbox, seq and budget reset | `test/bridge-pairing.test.ts` |
| section: never bridged → none; bridged → three parts; ended → still framed | `test/daemon-sections.test.ts`, `test/bridge-extension.test.ts` |
| a thread post from a bridge-started turn carries origin kind `bridge` | `test/threads-admission.test.ts` |
| a wake from a bridged conversation passes the talk-set check | `test/wake-tools.test.ts` (replaces the bridge-self-only case) |
| pi: `/bridge pair consult 12` sends `conversation: "12"`; bad second word → usage; new reason is terminal | `test/pi-bridge-shell.test.ts`, state tests |

`test/bridge-fixture.ts`'s `pair()` helper takes a target conversation and
an attached set. Persona tests drop the `bridge` case.

VH (operator, live room + jailed pi), closing the gap that hid this:

1. Room daemon restarts over SL-009's store: starts; the old bridge
   conversations are listed and attachable as interactive.
2. `M-x malebolge-attach` (root). In pi: `/bridge pair consult` with no id →
   bound to root. Exchange both ways; SATAN calls `bridge_post`; pi's
   messages arrive framed.
3. `C-u M-x malebolge-attach` to another conversation, with root's client
   also attached: `/bridge pair consult` → refused, naming both ids;
   `/bridge pair consult <id>` → bound.
4. `/bridge pair delegate <mail conversation id>` → refused, `not interactive`.
5. A second pi session pairs the same conversation: the first pi reports
   the pairing replaced and unpairs.

Per `mem.pattern.malebolge.settle-model-input-from-stored-record`, VH
checks what SATAN received from the stored record, not from SATAN's report.
