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
| DEC-102 | the bridge section's environment and posture text render only once a conversation has been bridged (refined by DEC-107) |
| DEC-103 | a new pair replaces the conversation's pairing; the old connection is closed `superseded by a new pairing` |
| DEC-104 | pair with no conversation binds the one an operator client is attached to (supersedes DEC-092, 093) |
| DEC-105 | a bridge-started turn opens a new origin, kind `bridge` (refines DEC-036) |
| DEC-106 | a re-pair keeps the conversation's seq allocator; a seq is never reused in a conversation (refines DEC-103, DEC-066) |
| DEC-107 | every room interactive conversation renders `BRIDGE_UNTRUSTED`, so inherited bridge history stays framed (refines DEC-102) |

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
100, 104), and its outbox section notes that seq now continues across
pairings (DEC-106 refines DEC-066); `README.md` and `docs/internals.md` updated in code (sec-8).
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
- `TALK_SETS` is unchanged. Bridged conversations are interactive and so in the room's
  interactive talk set: threads start, fork, post and wake into and out of
  them (DEC-100 amends DEC-032, DEC-076).

`src/persona.ts`: the `case "bridge"` arm and its comment go.
`src/daemon-extensions.ts`: unchanged in shape; its comment "only the room's
policy installs it" stays true (via `ROOM_ONLY`).

Mail stays off the bridge by two independent facts: mail's list has no
`bridge` extension, and pair refuses a non-interactive target (sec-4).
<!-- doctrine:section sec-3 -->
## 3. Retiring stored `bridge` toolsets (DEC-101)

Without a remap, `allowedToolsets` (`src/session.ts:127-142`) refuses any
stored topic or conversation entry whose toolset is `bridge`, and the room
daemon will not start. SL-009's live run created such records.

`entryToolsets` (`src/topics.ts:327-348`) already rewrites index entries in
the reconcile commit (its backfill). It gains the retirement rule, in one
place, applied to both entries and topic records before they are returned:

```
stored toolset t  →  t === "bridge" ? "interactive" : t        (written back when changed)
```

No retirement table: a `Partial<Record>` lookup cannot narrow to
`DaemonToolset` without a cast (RV-029 F-1), and one entry adds nothing.

- A rewritten entry is logged by the existing step-3 path, because its
  extension list (the bridge list) differs from interactive's:
  `conversation N: toolset interactive list changed`. `entryToolsets` stays
  log-free and also returns `retired`, the names of the topics it rewrote;
  `src/session.ts` logs `topic NAME: toolset bridge retired, now interactive`
  for each.
- The first start after this slice rewrites and logs every room interactive
  conversation's list once, because the interactive list gains `bridge`
  (sec-2). This is expected step-3 behaviour.
- `IndexDoc` holds the stored types: `StoredEntry` (`toolset?:
  StoredToolset`) and a new `StoredTopicRecord` (`toolset?: StoredToolset`),
  with `StoredToolset = DaemonToolset | "bridge"`. `TopicRecord`,
  `NamedTopic`, `TopicChange` and `IndexEntry` keep `DaemonToolset`.
- One pure function, `liveToolset(t: StoredToolset): DaemonToolset`
  (the ternary above), is the narrowing. `entryToolsets` uses it and writes
  changed values back; the other narrowing readers (`storedEntry`,
  `storedTopic`, `topicsOf`, `indexConversation`'s fork copy) use it too, so
  no cast is needed. At runtime they never meet `bridge` once reconcile has
  run, and it runs before the session serves.
- `<project>-bridge` topics survive as ordinary interactive topics with no
  directory. Their conversations keep their pairing documents; pi sessions
  holding those pairings resume them unchanged.
- Idempotent: a second start finds nothing to rewrite.
<!-- doctrine:section sec-4 -->
## 4. Pair (DEC-099, DEC-103, DEC-104, DEC-106)

### Frame

`pair {posture, project, conversation?}`: `conversation` is optional text,
parsed like `resume`'s with `conversationKeyOf` (strict decimal). The one
vocabulary both ends share, `pi-bridge/wire.ts` `FIRST_LINE_FRAMES.pair`,
gains `conversation: optional(text)` (the listener imports it,
`src/bridge/listener.ts:20`, `:445`). `project`
stays a client assertion, stored on the pairing for display only; pair
refuses a project over 255 bytes (`NAME_MAX`, the longest basename) as
`project longer than 255 bytes`, before the commit.

### Target

```
pairRow
  token := mintToken()                          (before any commit, as now)
  id    := pairTarget(host, frame)              (no commit; a refusal writes nothing)
             project over 255 bytes → refuse "project longer than 255 bytes"
             frame.conversation ? key or refuse "not a conversation id: X"
                                : the one attached id   ── DEC-104
  openPairOn(host, id, frame, token)            (one commit)
    entry := index entry for id   or refuse "no conversation N"
    entry.toolset == interactive  or refuse "conversation N has toolset T, not interactive"
    openPairing(pairingDoc(tx, id), posture, project, token)  ── DEC-103 overwrite
  bindAndFollow(state, host, id, token)          (closes an older pairing's connection)
```

- The attached id (`pairTarget`): `host.attached()` returns the distinct conversation ids
  bound by live attach connections. One id → it. None → refuse
  `no operator client is attached; name a conversation`. Several → refuse
  `several conversations are attached (N, M); name one` (ids ascending).
- A fork of an interactive conversation is interactive and may be paired.
- The check and `openPairing` run in one commit, so a refusal writes
  nothing. `createBridged`, `bridgedInit`, `requireBridge` and the topic
  creation are deleted; `src/conversations.ts`'s header comment reverts to
  "no frame ever creates a topic implicitly" (DEC-093 superseded).

### Replacing a pairing (DEC-103, DEC-106)

`openPairing` resets token, posture, project, ended, outbox and spent. It
keeps `nextSeq`: the seq continues, so a seq is never reused in a
conversation (DEC-066), and pi, which dedupes by conversation and seq, never
drops a new pairing's message as a duplicate.

A live connection for the old pairing is the one in `listener.bindings` for
that conversation; `bind` closes it. The reason
becomes context-specific:

- resume or a newer pair connection on the **same** token → `superseded by a
  newer connection` (unchanged; pi keeps its pairing and stops).
- a pair that **replaced** the pairing → `superseded by a new pairing`. pi
  treats it as terminal: it unpairs, as for `bad token`. Its later resume
  would get `bad token` anyway.

`bind` takes the reason from its caller: `pairRow` passes the new reason,
`resumeRow` the old. `resumeRow` keeps its existing token check. Posts the old connection had accepted stand (their
inputs are committed); its unanswered posts are answered by the close as
today (pi's `settlePending`).

A connection records the token hash it bound under (pair: the minted token;
resume: the presented one). `boundLine` compares it with the pairing snapshot
it already reads, beside the ended check; on a mismatch it refuses
`superseded by a new pairing` and finishes the connection. `bind` already
finishes the superseded connection, and an ended connection's queued lines
are dropped and nothing is delivered to it.

Accepted residual: a line of the superseded connection already in progress
when the new pair commits may act once on the new pairing: end it, post one
untrusted-framed message, reset its budget, or (a resume) take the binding
and receive its undelivered messages, its next line then refused. Each is
visible and recovered by re-pairing or resuming. pair is unauthenticated
(DEC-099), so this is not a security boundary.

The operator-input refill (`operatorRefill` via `onOperatorInput`,
DEC-070, DEC-078) has no connection and checks no token hash: operator
input refills whichever pairing the conversation holds now. `refillBridged`
is unchanged.

### Attached set

`src/daemon.ts`'s `serve` keeps the set of its live `Connection`s (added in
`startConnection`, removed on socket `close`). `Daemon` gains
`attached(): readonly ConversationId[]`: the distinct `bound.id` of live,
not-ended connections. A listing connection binds nothing and does not
count; root counts once bound (plain `M-x malebolge-attach` binds root).
`daemon-start.ts` passes `() => socket.attached()` into `bridgeHostOf`
(`daemon` is `Daemon | undefined` there; `socket` is the served value), and
`BridgeHost` gains `attached`. This mirrors `onOperatorInput`, the
existing cross-listener hook.
<!-- doctrine:section sec-5 -->
## 5. The SATAN-side extension (DEC-102, DEC-107)

`src/bridge/extension.ts`:

- `bridgeSectionText(doc)` is unchanged (`src/bridge/extension.ts:41-46`):
  `BRIDGE_UNTRUSTED` always; `BRIDGE_ENVIRONMENT` and the posture text only
  when `isBridged(doc)`. Now that every room interactive conversation has
  the extension, every one renders `BRIDGE_UNTRUSTED`. `isBridged` is
  `tokenHash !== ""` (`src/bridge/pairing.ts:100`), true from the first pair
  onwards, including after `end`.
- So bridge messages are framed as untrusted wherever they are in context:
  in the paired conversation, after `end`, and in a fork of a bridged
  conversation, whose pairing document forks initial (unpaired) but whose
  history carries the bridge entries.
- A render that throws keeps the section last shown
  (`node_modules/@earendil-works/pi-durable/dist/harness/prompt.js:29-35`),
  so a failed pairing read never drops the framing.
- `bridge_post` stays registered unconditionally and refuses through
  `appendOutbox` (`not a bridged conversation`, `pairing ended`), as now.
  Its tool description gains one clause: it works only once pi has paired
  with this conversation.
<!-- doctrine:section sec-6 -->
## 6. Origin of a bridge-started turn (DEC-105)

`src/threads/origin.ts`: `Origin.kind` becomes `"human" | "wake" | "bridge"`;
`isOrigin` accepts it. `src/threads/admission.ts` `originOf`: an entry of kind
`BRIDGE_ENTRY_KIND` (`satan.bridge`, `src/bridge/inbound.ts:33`) whose
`data.kind` is `"turn"` opens
`{conversation: caller, entry: entry.id, kind: "bridge"}`.

Today `originOf` returns `undefined` for a bridge entry, so `callerOrigin`
skips it and a bridge-started turn inherits the previous input's origin,
sharing that family's cap. A bridge note (a write, DEC-069) starts no turn,
so `originOf` still returns `undefined` for it: `callerOrigin` skips it as
today, and the turn keeps the origin of the input that started it. A
`satan.bridge` entry with no readable `data.kind` opens no origin either:
only a turn is known to be an input.

Family and global caps, reaping and tombstones apply unchanged. Post
entries serialise `origin.kind` into their data (`src/threads/task.ts`
`originData`), so `isOrigin` must accept `bridge`; journals print
`originKey`, which carries no kind.
<!-- doctrine:section sec-7 -->
## 7. pi side

- `/bridge pair <posture> [conversation]`: `pi-bridge/shell.ts` accepts one
  or two words after `pair`; the second must be decimal digits, else usage.
  `BRIDGE_USAGE`: `usage: /bridge pair delegate|consult [conversation], or /bridge end`.
- The `pair` command event and frame carry `conversation` when given
  (`pi-bridge/state.ts` pair event and the frame built at `:673-676`, and the
  re-pair after `end` at `:394`, which keeps the conversation it was asked
  for).
- The bound phase's `ending` becomes `{ then?: PairRequest }`, with
  `PairRequest = { posture, conversation? }`: `pairEvent` passes the event's
  conversation, and `terminalRefusal` builds the pair frame from it.
- `TERMINAL_REASONS` gains `superseded by a new pairing` (sec-4). A bound
  `/bridge pair` ends its own pairing first, so pi never meets its own
  supersede; `superseded by a new pairing` comes only from another client.
- Notices: `topicOf`/`Ends.topic` (`pi-bridge/notices.ts`, `shell.ts:593`)
  go; ends name the conversation id when known. `pairFailedText`'s
  `mayHaveCreated` clause becomes: when the pair timed out after sending,
  `the daemon may have paired conversation N` (or `the attached
  conversation` with no id), since pair now creates nothing but may have
  replaced a pairing.
- The `malebolge-bridge` command and env are unchanged (they act on the
  paired conversation by id and token).
- pi's prompt (operator-directed after PHASE-08: 6eaa43e, ffb8d61, e9698dc;
  RV-031 F-2). `PI_BRIDGE_ENVIRONMENT` (`pi-bridge/posture.ts`) names
  `malebolge-bridge send|tee [--turn]` and its exit codes (0 accepted, 1
  outage, 2 refused, 3 unanswered). It says a path is a shared reference
  only with a named commit, that a claim resting on a current tree is
  checked on pi's own side, and that bridge_post starts a turn.
  `PI_POSTURE_TEXT` carries the operator's texts (consult: a sounding board;
  delegate: a representative with bounded authority). Per DEC-072, pi's
  posture section is the extension's own, so these stay code. SATAN's side
  of the shared-reference rule is IMP-030.
<!-- doctrine:section sec-8 -->
## 8. Code impact

| file | change |
|---|---|
| `src/toolsets.ts` | sec-2 |
| `src/persona.ts` | drop `bridge` arm |
| `src/topics.ts` | `StoredToolset`, `StoredTopicRecord`, `liveToolset`; `entryToolsets` retires `bridge` for entries and topics and returns `retired`; narrowing readers use `liveToolset` (sec-3) |
| `src/session.ts` | logs each `retired` topic; otherwise unchanged (sec-3) |
| `src/bridge/listener.ts` | `pairRow` target resolution, interactive check, project length check, overwrite; delete `createBridged`, `bridgedInit`, `requireBridge`; `bind` takes its close reason; the connection's recorded token hash, checked in `boundLine` beside the ended check (sec-4); `BridgeHost` gains `attached` and loses `conversations`, `defaults`, `catalog` and `profile` (their sole use was `createBridged`'s `topicInit`), and their now-unused imports go (sec-4) |
| `src/bridge/pairing.ts` | `openPairing` keeps `nextSeq` (sec-4) |
| `src/bridge/extension.ts` | `bridge_post` description (sec-5) |
| `src/daemon.ts`, `src/daemon-start.ts` | live-connection set; `Daemon` changes from a bare alias of `UnixServer` to `UnixServer & { attached(): readonly ConversationId[] }`; `bridgeHostOf` passes `attached` and stops passing the four dropped fields (sec-4) |
| `src/conversations.ts` | header comment (DEC-093 superseded) |
| `src/threads/origin.ts`, `src/threads/admission.ts` | `bridge` origin kind (sec-6) |
| `pi-bridge/wire.ts`, `state.ts`, `shell.ts`, `notices.ts` | sec-7 |
| `pi-bridge/posture.ts` | sec-7 prompt texts (operator-directed, RV-031 F-2) |
| `src/wake/tools.ts` | a stale comment corrected when the toolset retired (RV-031 F-3) |
| `README.md`, `docs/internals.md` | bridge mode and `<project>-bridge` text replaced by pairing an existing conversation |
| tests | sec-9 |

Not changed: `emacs/malebolge.el` (the transcript already says `attached to
conversation N`, `src/render.ts:372-376`),
`src/bridge/inbound.ts`, `pi-bridge/command.ts`, the jail contract.
<!-- doctrine:section sec-9 -->
## 9. Verification

VT (vitest):

| criterion | test |
|---|---|
| room interactive list contains `bridge` before `satan`; host's does not; `bridge` is no toolset and not allowed. `bridge` joins `withoutPostBaseline`'s exclusions (it postdates the baseline); VT-5's room expectation gains extension `bridge` before `satan` and tool `bridge_post`, and a `bridge` section of `BRIDGE_UNTRUSTED` alone (never bridged, DEC-107); host unchanged | `test/toolsets.test.ts` (rewrites the bridge-catalogue and no-talk-set cases) |
| reconcile rewrites a stored `bridge` entry and topic to `interactive`, re-derives the list, logs, and is idempotent | `test/session.test.ts` |
| pair by id binds an existing interactive conversation and answers `paired` with a token; creates no topic or conversation | `test/bridge-listener.test.ts` (replaces the create-in-topic cases now in `test/bridge-pairing.test.ts`'s "pair, through the listener" block) |
| pair refuses an unknown id, a non-decimal id, a mail conversation and a project over 255 bytes, writing nothing | `test/bridge-listener.test.ts` |
| pair without id: one attached → binds it; none / several → refused naming ids | `test/bridge-listener.test.ts` |
| `attached()`: a listing connection binds nothing and does not count; root counts once bound; an ended connection drops out | `test/daemon.test.ts` |
| pair binds a fork of an interactive conversation | `test/bridge-listener.test.ts` |
| re-pair replaces: old connection gets `superseded by a new pairing`; old token resumes `bad token`; seq continues after re-pair | `test/bridge-listener.test.ts` |
| `openPairing` over a used pairing resets token, outbox and budget and keeps `nextSeq` | `test/bridge-pairing.test.ts` (its "resets a used document to a fresh pairing" case) |
| a pi session re-pairs the same conversation and receives the new pairing's first message | pi-bridge state test |
| section: never bridged → `BRIDGE_UNTRUSTED` alone; bridged → three parts; ended → still three parts | `test/daemon-sections.test.ts` |
| fork a bridged conversation after a bridge entry: the fork's prompt carries `BRIDGE_UNTRUSTED`; its pairing is unpaired | `test/daemon-sections.test.ts` |
| a thread post from a bridge-started turn carries origin kind `bridge` | `test/threads-admission.test.ts` |
| a bridge note after an operator input leaves the caller's origin kind `human` | `test/threads-admission.test.ts` |
| a wake from a bridged conversation passes the talk-set check | `test/wake-tools.test.ts` (replaces the bridge-self-only case) |
| a line on a bound connection after its pairing was reopened under a new token is refused `superseded by a new pairing`, the connection finished, nothing mutated | `test/bridge-listener.test.ts` |
| pi: `/bridge pair consult 12` sends `conversation: "12"`; bad second word → usage; new reason is terminal | `test/pi-bridge-shell.test.ts`, state tests |

`test/bridge-fixture.ts`'s `pair()` helper takes a target conversation and
an attached set. Persona tests drop the `bridge` case.

VH (operator, live room + jailed pi), closing the gap that hid this:

1. Room daemon restarts over SL-009's store: starts; the old bridge
   conversations are listed and attachable as interactive.
2. `M-x malebolge-attach` (root). In pi: `/bridge pair consult` with no id →
   bound to root. Exchange both ways; SATAN calls `bridge_post`; pi's
   messages arrive framed.
3. Emacs attached to root (plain `M-x malebolge-attach`); a terminal attach
   client (`node src/attach-main.ts --conversation N`) attached to another conversation.
   `/bridge pair consult` → refused, naming both ids;
   `/bridge pair consult <id>` → bound.
4. `/bridge pair delegate <mail conversation id>` → refused, `not interactive`.
5. A second pi session pairs the same conversation: the first pi reports
   the pairing replaced and unpairs.

Per `mem.pattern.malebolge.settle-model-input-from-stored-record`, VH
checks what SATAN received from the stored record, not from SATAN's report.
