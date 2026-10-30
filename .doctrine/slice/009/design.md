<!-- doctrine:section sec-1 -->
## 1. Overview

A jailed pi session and one malebolge conversation exchange messages over a
restricted daemon socket. SATAN never touches the project; the jailed pi
does. Scope: `slice-009.md`. Evidence: `research/research.md` (X1–X8).

```
 host (uid 1000)                                   room daemon (jail, rw bind of …/durable/room)
 ┌──────────────────────────────┐                 ┌──────────────────────────────────────────────┐
 │ pi jail (per project)        │                 │ src/daemon.ts      durable.sock  (attach)    │
 │  /workspace/<project> ro|rw  │                 │ src/bridge/listener.ts  bridge.sock          │
 │  ~/.pi/agent/extensions/     │  bridge.sock    │   BRIDGE_FIRST_LINE / BRIDGE_BOUND tables     │
 │   malebolge-bridge (ro) ─────┼──── ndjson ────►│ src/bridge/pairing.ts  pairing document      │
 │   = pi-bridge/index.ts       │  (dir ro-bound) │   token hash · posture · outbox · budget     │
 │  malebolge-bridge send|tee ──┼── post-once ───►│ src/bridge/inbound.ts  pi → SATAN submit     │
 └──────────────────────────────┘                 │ src/bridge/extension.ts  bridge_post +       │
          ▲                                       │   BRIDGE_SECTION (bridge mode, DEC-071)      │
          │ pi-bridge/wire.ts (frames, parser) ◄──┤ imported by both sides                       │
 operator ── Emacs ── durable.sock ───────────────┤ bridged conversation C (topic <project>-bridge)│
                                                  └──────────────────────────────────────────────┘
```

| decision | owns |
|---|---|
| DEC-064 | second listener, own directory, own frame vocabulary |
| DEC-065 | pairing, token, topic `<project>-bridge`, newest connection wins |
| DEC-066 | SATAN → pi outbox, per-entry ack, cap |
| DEC-067 | pi → SATAN direct input/write, framing, idempotence, withdrawal notice |
| DEC-068 | each message enters each context once; tool-result texts |
| DEC-069 | kinds turn and note |
| DEC-070 | per-pairing turn budget and refill |
| DEC-071 | `bridge` mode, no talk set, room only |
| DEC-072 | posture |
| DEC-073 | `pi-bridge/` extension and its loud failures |
| DEC-074 | deployment contract (`~/flakes`, CHR-007) |
| DEC-075 | `malebolge-bridge send` / `tee` |
| DEC-076 | wake to another conversation needs a shared talk set |
| DEC-078 | budget spent in its own commit before the submit (refines DEC-070) |
| DEC-079 | a turn dropped by an abort joins the next turn as a note (refines DEC-069) |
| DEC-080 | outbox entries carry `kind` (refines DEC-066) |
| DEC-090 | pi is handed bridge messages only while idle (refines DEC-066, DEC-069, DEC-079) |
| DEC-092 | a bridge topic may carry a model; `pair` creates through `topicInit` (SL-010) |
| DEC-093 | `pair` creates its `<project>-bridge` topic explicitly; DEC-016's rule governs attach |

Reuse, named once here and cited by section below: `serveUnix` and the
private-socket helper `servePrivateUnix` extracted beside it from
`src/runner/control.ts` (`src/unix-socket.ts`), `boundedLineSplitter` and
`encodeLine` (`src/ndjson.ts`), the `FIRST_LINE` table shape
(`src/daemon.ts`) and the connection helpers moved from it to
`src/connection-reply.ts` (`answer`, now generic over its reply type;
`write`, `finish`, `fail`), `capHeadTail` and the socket path rule
`bridgeSocketPath` in `pi-bridge/wire.ts`,
`topicInit` (`src/conversations.ts`, SL-010), `requireSameTalkSet`
(`src/toolsets.ts`), `endingOf` (`src/threads/task.ts`), `escapeXml`
(`src/xml.ts`), `capUtf8` (`src/truncate.ts`), `defineDoc` and `watchDoc`
(pi-durable).

<!-- doctrine:section sec-2 -->
## 2. Bridge listener and wire (DEC-064)

**Path.** `bridgeSocketPath(env)` in `pi-bridge/wire.ts`:
`MALEBOLGE_BRIDGE_SOCKET`, else
`$XDG_RUNTIME_DIR/satan/durable/room/bridge/bridge.sock`. `src/config.ts`'s
`bridgeSocket` delegates to it, so daemon and extension share one rule. `inProfileDir`
gains its bridge variant: the socket's grandparent must be named for the
profile and its parent `bridge`. The daemon creates the directory 0700 and
checks its owner and mode, serves through `serveUnix`, then chmods the socket
0600. This is the runner control socket's code (`src/runner/control.ts`),
extracted into one helper, `servePrivateUnix`, beside `serveUnix`, which both
use. Only the room profile starts it;
a host daemon has no bridge path in its `Config`.

**Wire: `pi-bridge/wire.ts`.** One module of frame types and a pure parser,
imported by the daemon and the extension (DEC-073), so the two sides cannot
disagree on a frame. Newline-delimited JSON, lines read through
`boundedLineSplitter` with a line cap, `BRIDGE_LINE_MAX_BYTES` (6 × the body cap
+ 4 KiB, so a capped body is never refused by the line cap; “Messages”, framing
and caps), so an oversized line is refused, not buffered. Senders cut
first: `capHeadTail` lives in `pi-bridge/wire.ts`, so the extension and
`malebolge-bridge` truncate head-and-tail to `BRIDGE_BODY_MAX_BYTES` before
sending, and the line cap never refuses a well-behaved sender.

| first line (client) | reply | then |
|---|---|---|
| `pair {posture, project}` | `paired {conversation, token}` | bound |
| `resume {conversation, token}` | `paired {conversation}` | bound |
| `post-once {conversation, token, kind, text}` | `accepted {}` or `refused {reason}` | closed (DEC-007) |

| bound (client) | reply |
|---|---|
| `post {id, kind, text}` | `accepted {id}` or `refused {id, reason}` |
| `ack {seq}` | none |
| `refill {}` | none; `refused {reason}` on refusal |
| `end {}` | connection closed with a reason |

The daemon also sends `deliver {seq, kind, text}` unprompted (“Messages”). Any frame
the tables do not name, or a frame with a key its type does not name, is
`refused {reason}`; the bridge parser knows no attach verb, so the full
protocol is unreachable here.

**Dispatch.** `src/bridge/listener.ts` copies the `FIRST_LINE` shape:
`BRIDGE_FIRST_LINE` and `BRIDGE_BOUND`, each a mapped type over its frame
union so a frame without a row is a compile error; each row is thin.
`post-once` settles through `answer`, which moves with `write`/`finish`/`fail`
from `src/daemon.ts` to `src/connection-reply.ts` and becomes generic over its
reply. The two tables are separate from `src/daemon.ts`'s. Its only other
change is the refill hook (“Loop budget”).

**Connections.** A binding is held per pairing: a valid `resume` or `pair`
supersedes the previous connection for that pairing, which is closed with
`refused {reason: "superseded by a newer connection"}` (DEC-065).

**Liveness.** Every request frame (`pair`, `resume`, `post`, `post-once`)
has a reply deadline of `BRIDGE_POST_WAIT_MS` (30 s) from send, client side.
There is no heartbeat (“The pi side and deployment”).

<!-- doctrine:section sec-3 -->
## 3. Pairing and the pairing document (DEC-065, DEC-072)

**The document.** `src/bridge/pairing.ts` defines one pi-durable document,
conversation scope, kind `malebolge.bridge`, modelled on
`src/threads/tombstones.ts` (unexported token). Three accessors:
`pairingDoc(tx, conversation)` reads it in a commit; `pairingSnapshot` reads
it without one, so a refused `resume` writes nothing; `watchPairing` watches it
without creating it:

```
PairingDoc = {
  tokenHash: string            // sha256 of the token, hex
  posture: "delegate" | "consult"
  project: string              // naming only (DEC-065)
  ended: boolean
  nextSeq: number              // outbox allocator (DEC-066)
  outbox: { seq, kind, text }[]  // unacked entries
  spent: number                // bridge-started SATAN turns since refill (DEC-070)
}
```

A pairing is identified by its conversation id: one pairing per
conversation, and `details.pairing` and `requestId` use it.

A conversation with no pairing document is not bridged; every bridge frame
naming it is refused `not a bridged conversation`. Pure functions over the
value — `admitTurn`, `refill`, `appendOutbox`, `ackEntry`, `checkToken` — hold
every rule, so tests exercise them without a socket.

**pair.** A `/bridge pair` from a session already paired first sends `end`
for the current pairing, so one pi session holds one pairing. Pairings of
other pi sessions in the same topic are untouched. A pairing whose pi session
died without `end` stays open; its outbox refuses at the cap and the operator
ends it.

The daemon validates `project` against the topic rule (`src/protocol.ts`) as
`<project>-bridge`, then:

1. `setTopic({name, toolset: "bridge"})` if the topic is absent (its own
   commit; a crash after it leaves an empty bridge topic, which the next pair
   reuses). This is `pair`'s explicit act, not an implicit creation: DEC-016's
   rule governs `attach` (DEC-093). The topic is written with no directory and
   no model;
2. creates the conversation through SL-010's `topicInit` with a `require`
   that the chosen toolset is `bridge` and no `startedBy`, so a topic of that
   name with another toolset is refused and nothing is created. The topic's
   stored model, else the daemon default, becomes the conversation's model
   (DEC-092); a stored model the catalog lacks throws `UnknownModel` in the
   creating commit, nothing is created (SL-010's DEC-083), and `pair` answers
   `refused {reason: "unknown model <ref>"}` (the thrown message), which the
   extension's refusal row reports;
3. writes the pairing document in that creating commit's `init`.

The token is 32 random bytes, base64url, sent once in `paired` and stored
only as its hash.

**resume.** Reads the document, compares hashes in constant time, refuses
`pairing ended` or `bad token` loudly (the extension does not retry these,
DEC-073), else binds.

**end.** Sets `ended` and closes the connection. The conversation stays an
ordinary bridge-mode transcript: attachable, with `bridge_post` refused
`pairing ended`. The extension appends an unpaired marker after a confirmed
`end`, or after a terminal `pairing ended` or `bad token` refusal (“The pi
side and deployment”).

**Posture.** Stored at pair, never changed (a new posture is a new pairing).
Each side is also told where the other runs, whatever the posture (DEC-098).
`BRIDGE_SECTION`, SATAN's `bridge` section, is untagged (a tag would wrap it
in the envelope it tells the model to distrust) and renders the untrusted
framing (“Messages”), then, for a bridged conversation only,
`BRIDGE_ENVIRONMENT`, then the posture's text. pi's system prompt gains
`PI_BRIDGE_ENVIRONMENT`, then pi's posture text (“The pi side and
deployment”). The two posture texts are corpus prose (DEC-040),
authored in the satan-corpus session; this slice ships placeholders keyed by
posture and the test that pins which one renders.

<!-- doctrine:section sec-4 -->
## 4. Messages (DEC-066, DEC-067, DEC-068, DEC-069)

A message has kind `turn` (default) or `note`; how each enters each side is
DEC-069's table. Each side's post tool returns a short ack and never echoes
(DEC-068): SATAN's `bridge_post` returns `sent #<seq>`, pi's `bridge_post`
returns `sent`. There is no receive tool.

**SATAN → pi: the outbox.** `bridge_post {text}` (a turn, DEC-069; in
`src/bridge/extension.ts`) commits `appendOutbox` and returns. Refusals:
`pairing ended`; `outbox full, pi is not draining` at `BRIDGE_OUTBOX_CAP`
(32) unacked entries. Replay unsafe, as the thread tools (DEC-043; IMP-020). An outbox entry
is `{seq, kind, text}` (DEC-080, refining DEC-066): `turn` from `bridge_post`,
`note` for the withdrawal notice, so pi knows which starts a turn.

Pushing is decoupled from the tool: a bound connection holds a `watchDoc` on
its pairing document. On bind it sends `deliver` for every outbox entry; on
each change it sends entries with `seq` above the highest it has sent on this
connection. `ack {seq}` commits `ackEntry`. A drop loses nothing: the next
bind redelivers every unacked entry.

The extension never hands pi a bridge message while pi is running (DEC-090,
refining DEC-066, DEC-069 and DEC-079). Idle means `ctx.isIdle()` is true at the
moment of delivery and `running` is clear; pi turns busy before
`agent_start` fires, so the event alone does not decide. Idle: it injects at once as a custom
message (`customType malebolge-bridge`, `details {pairing: <conversation id>,
seq}`). A turn uses `triggerTurn: true`; a note uses `triggerTurn: false`.
Otherwise (`ctx.isIdle()` false, or `running` set from `agent_start` or its
own turn injection until `agent_settled`): it buffers the delivery in memory in seq order. On
`agent_settled` it flushes in seq order. Not aborted: every buffered note up
to the first buffered turn, then that turn with `triggerTurn: true`, and
stops; the rest waits for the next settle. Aborted: the whole buffer, turns
included, with `triggerTurn: false`, so the operator's stop holds. A `deliver` whose seq is already in the session's
entries (by `details.seq`) or in the buffer is skipped and, if in the
session, re-acked. A seq is acked once its entry is in the session
(ASM-004). Delivery is at least once; pi's session is the dedupe record.

pi's own queues therefore never hold a bridge message. A reload or crash
loses only the unacked buffer, which the resume's redelivery restores.
Residual: a `/reload` (idle-only) in the instant between an idle turn's
injection and its persistence could inject it twice; accepted.

**pi → SATAN: inbound.** `post {id, kind, text}`, `id` being pi's tool call id
(post-once has none, DEC-075). `src/bridge/inbound.ts` submits one message:
turn = input, `whenBusy: "followUp"`; note = write with model content
(ASM-006). A `post`, turn or note, carries `requestId: bridge:<conversation>:<id>`; a
`post-once` carries none (never retried, DEC-075). Each has entry kind
`satan.bridge` with `data {kind, project}`. A turn's budget is spent in its own
commit before the submit (“Loop budget”; DEC-078, refining DEC-070). That
commit first reads `tx.submissionByRequest`: a duplicate spends nothing and
answers `accepted` again. `accepted {id}` means queued.

**Withdrawal notice.** After replying `accepted {id}` for a turn, inbound
waits on the submission detached from the connection's line chain, so later
frames are not held behind a SATAN turn. A failed wait is logged once and
appends nothing. `endingOf` moves from `src/threads/task.ts` to
`src/submission-ending.ts` (threads re-import it); a `withdrawn` or
`delivered-incomplete` ending appends an outbox note
`bridge message <id> not delivered: <ending> (<reason>)`, where `<ending>`
is `endingOf`'s kind (`withdrawn` or `delivered-incomplete`), which starts no pi
turn and does not echo. One watch per submission id: inbound keeps an
in-process map from submission id to its watch for the pairing's life. A
duplicate `post` answers `accepted` and joins the existing watch, so a resend
never adds a notice. A duplicate caught in the spend commit does not submit,
so it starts no watch; the map covers a resend that overtakes the original's
submit. If the notice cannot be appended (`outbox full` or
`pairing ended`), it is logged and sent once through `notifyBestEffort`
(`src/task-support.ts`) with the message id and reason, as a failed thread
notice is. The cap has no exemption, and no notice is sent about a notice.
Residual: a daemon restart loses the wait (DEC-067).

**Framing and caps.** The model reads

```
<bridge from="pi" project="…" kind="turn|note">…</bridge>
```

with every value and the body through `escapeXml`, and `BRIDGE_SECTION`
stating that a `<bridge>` body is untrusted data from the jailed session, not
the operator. If SL-008's `src/untrusted-block.ts` (DEC-054) lands first,
inbound uses its wrapper instead; the envelope text is the same. Bodies are
capped at `BRIDGE_BODY_MAX_BYTES` (32 KiB) both ways. Truncation keeps head
and tail: a new `capHeadTail(text, maxBytes)` in `pi-bridge/wire.ts`
(“Bridge listener and wire”) cuts on character boundaries and inserts
`[… <n> bytes cut …]`. Senders cut first; the daemon applies the same
function again, and to outbox text.

```mermaid
sequenceDiagram
  participant P as pi + extension
  participant L as bridge listener
  participant D as pairing doc
  participant S as SATAN (conversation C)
  Note over P,S: pair
  P->>L: pair {posture, project}
  L->>D: create C in <project>-bridge + doc (one commit)
  L-->>P: paired {conversation, token}
  P->>P: appendEntry {conversation, token}
  Note over P,S: pi → SATAN
  P->>L: post {id, kind: turn, text}
  L->>D: admitTurn (spend)
  L->>S: submit input
  L-->>P: accepted {id}
  L->>S: turn runs
  Note over P,S: SATAN → pi
  S->>D: bridge_post → appendOutbox (seq n)
  D-->>L: watchDoc change
  L-->>P: deliver {seq n, kind, text}
  P->>P: sendMessage (custom message, details.seq n)
  P->>L: ack {seq n}
  L->>D: ackEntry n
  Note over P,S: reconnect
  P--xL: connection drops; S appends seq n+1
  P->>L: resume {conversation, token}
  L-->>P: paired; deliver every unacked (n+1, any unacked n)
  P->>P: skip seqs already in session; inject n+1
  P->>L: ack {seq …}
```

<!-- doctrine:section sec-5 -->
## 5. Loop budget (DEC-070)

One function owns the policy, so autonomy modes (IDE-009) replace one body:

```
admitTurn(doc): { ok: true } | { ok: false, reason: "budget exhausted, waiting on the operator" }
```

`BRIDGE_TURN_BUDGET = 10`. `admitTurn` runs in its own commit just before
the submit, for a turn-kind `post` or `post-once` (DEC-078, refining
DEC-070). It reads `tx.submissionByRequest` (a duplicate spends nothing) and
increments `spent` when it admits; notes skip it. Residual: a crash or failed
submit after the spend costs one unit with no turn. A refusal is `refused {id, reason}` to pi (and the one-shot
exit status, “The pi side and deployment”).

**Refill** sets `spent` to 0 in its own commit. Two sources:

- `refill {}` on the bound connection, which the extension sends only for pi
  `input` events with `source: "interactive"`;
- a human input in the bridged conversation. The attach listener's
  `submitInput` (`src/daemon.ts`) is the only path for operator input, so
  `ServeOptions` gains one optional callback, `onOperatorInput(conversation)`,
  called from `act`'s `input` case after a successful submit, not from
  `submitInput`, which `orient` also uses with daemon-built content; the bridge supplies it and refills when
  the conversation has a pairing document. No other change to `src/daemon.ts`.

Residual: a subverted pi can fake refills (DEC-070).

<!-- doctrine:section sec-6 -->
## 6. Bridge mode and reach (DEC-071, DEC-076)

**Catalog** (`src/toolsets.ts`): `Toolset` gains `"bridge"`;
`CATALOG.bridge` is interactive's list without `threads`, with `bridge`
inserted before `SATAN`. `PROFILE_TOOLSETS.room.allowed` gains `bridge`;
`host` does not; `TALK_SETS` gives it no set.
Startup reconcile already refuses a stored toolset the policy does not allow,
so the allow lands with the catalog entry.

**Persona** (`src/persona.ts`): `bridge` shares interactive's persona files
(`case "interactive": case "bridge":`), since bridge's catalog uses the same
`persona` extension; bridge prose lives in `BRIDGE_SECTION`.
`requirePersonaFiles` then covers it with no new corpus file.

**Wake reach** (`src/wake/tools.ts`): when `targetOf` resolves a conversation
other than the caller, `wakeSchedule` reads both stored toolsets and calls
`requireSameTalkSet`; a throw becomes the tool's existing `refusal(…)` naming
the target topic. A self-wake skips the check. `wake_cancel`, `wake_list` and
the heartbeat are unchanged. Effects (DEC-076): bridge wakes only itself;
nothing wakes into a bridge conversation but itself; interactive can no
longer wake mail.

`WakeDeps` (through `EarlyWakeDeps`, `src/wake/extension.ts`) gains
`profile`, bound in `daemon-start` as threads' `bindEarly` already is. A
caller or target with no index entry is refused, naming the target.

`requireSameTalkSet` is used directly, not through threads'
`refuseOutsideTalkSet`, so `src/wake/` does not import `src/threads/`.

<!-- doctrine:section sec-7 -->
## 7. The pi side and deployment (DEC-072, DEC-073, DEC-074, DEC-075)

**`pi-bridge/index.ts`** (the extension). No npm dependencies beyond pi's
own (ASM-007 for TypeBox). It is a thin shell: pi events and socket events go
into one pure transition function, `step(state, event) → {state, effects}`,
in `pi-bridge/state.ts`, and the shell performs the effects (send a frame,
`appendEntry`, notify, `setStatus`, set the bash env, start or clear the
retry timer, close the socket). The table below is that function, and its
test is the same table.

States: `unpaired`; `pairing` (a `pair` sent, no reply yet); `resuming` (a
`resume` sent, no reply yet); `bound`; `outage` (connection lost, retrying).
The paired states (`resuming`, `bound`, `outage`) hold `{session,
conversation, token, posture}`, the delivery buffer (“Messages”) and the
pending posts. A `running` flag lives beside every state. `settlePending` is
the one exit effect from a paired state: it completes each pending post
`outcome unknown`, empties the pending set and cancels the timers.

Each connection has a generation. Frames, closes and reply deadlines stamped
with an older generation are stale and ignored. Reply deadlines come back into
`step` as events, as does the shell's `persisted` report that an injected
message's entry is in the session.

| state | event | next | effects |
|---|---|---|---|
| — | `session_start`, latest entry is a pairing whose `session` is this session (`ctx.sessionManager.getSessionId()`) | resuming | `resume` |
| — | `session_start`, latest entry is an unpaired marker, or none | unpaired | — |
| — | `session_start`, latest entry is a pairing from another session (fork, clone) | unpaired | `info` notice; never `end` the parent's pairing |
| unpaired | `/bridge pair <delegate\|consult>` | pairing | `pair {posture, project root basename}` |
| bound | `/bridge pair …` | unpaired, then pairing | the `/bridge end` row first (`end` awaited, `settlePending`, marker); once `end` is answered, `pair` (one pi session holds one pairing); `end` unanswered within the reply deadline: stop at `unpaired`, loud, no `pair` |
| pairing, resuming, outage | `/bridge pair …` | same | refused: `end` the current pairing first, or wait for reconnect |
| pairing | `paired` | bound | `appendEntry {session, conversation, token, posture}`; set bash env; status |
| pairing | connect failure, connection drop, `refused {reason}`, or reply deadline | unpaired | loud notice with the reason; after a deadline it says "a conversation may have been created in `<project>-bridge`"; no retry, no `resume` |
| resuming | `paired` | bound | set bash env; status; after an outage, one recovery notice |
| resuming | connect failure, or reply deadline | outage | close socket; first failure of the outage notifies (below); retry timer |
| bound | connection drops | outage | as above |
| outage | retry timer | resuming | `resume` |
| any paired | `/bridge end` answered, or `refused` `pairing ended` / `bad token` | unpaired | `settlePending`; `appendEntry` unpaired marker; clear credentials, posture, bash env; an intentional `end` is not an outage; a `refused` `pairing ended` answering an awaited `end` is its answer, an info notice `ended`; any other refusal notifies loudly and is not retried |
| bound, `end` awaited | connection drops, or the `end` reply deadline | unpaired | `settlePending`; close socket; `appendEntry` unpaired marker; clear credentials, posture, bash env; loud notice `end unanswered`; a re-pair waiting on the `end` is dropped |
| outage | `/bridge end` | unpaired | `settlePending`; close socket; `appendEntry` unpaired marker; clear credentials, posture, bash env; info notice `ended locally`; no frame, the daemon's pairing document is left as is (DEC-095) |
| pairing, resuming | `/bridge end` | same | refused busy (DEC-095) |
| resuming | any other `refused {reason}` | unpaired | as the terminal row: `settlePending`, marker, loud notice with the reason, no retry |
| bound | `refused {reason}` answering no post (a refused `refill`, or any other) | bound | loud notice with the reason |
| bound, resuming | `refused` `superseded by a newer connection` | unpaired | `settlePending`; in memory only, no marker (the pairing stays valid for its newer holder); notify with the reason; a later `session_start` may resume it (DEC-065) |
| any | `session_shutdown` | unpaired | `settlePending`; close socket; no entry |
| any | `persisted` | same | the message joins the session record; if bound to its pairing, `ack {seq}` |
| any | `agent_start` | same | set `running` |
| any | `agent_settled`, not aborted | same | clear `running`; flush notes up to the first buffered turn, then that turn as a turn (“Messages”) |
| any | `agent_settled`, aborted | same | clear `running`; flush the whole buffer as notes (“Messages”) |
| bound | interactive `input` | bound | `refill` |
| other | interactive `input` | same | none. Residual: an operator input during an outage does not refill; the next `budget exhausted` refusal is loud |

Outside the table, all states:

- **Reply deadline.** Every request frame (`pair`, `resume`, `post`,
  `post-once`) has a reply deadline of `BRIDGE_POST_WAIT_MS` from send,
  client side. There is no heartbeat.
- **`bridge_post {text}`** sends `post {id: toolCallId, kind: turn, text}`
  (body cut by `capHeadTail` first) and returns `sent` or the refusal reason.
  Not `bound` when called: refused at once with `outageText(ends)`. A drop
  before the reply: the same `id` is resent when the same pairing (its
  conversation) is next `bound` (idempotent, DEC-067); a pending post never
  crosses to another pairing. The deadline expires first: `outcome unknown`,
  naming the ends, not resent.
- `deliver` from the current binding only → inject when `ctx.isIdle()` is
  true and `running` is clear, else buffer (“Messages”); a
  frame from a stale socket is ignored. A seq already in the session is
  skipped and re-acked; one injected but not yet `persisted`, or buffered, is
  skipped without an ack (the `persisted` row acks it). For `input`, see the
  `input` rows.
- `before_agent_start` appends `PI_BRIDGE_ENVIRONMENT`, then the stored
  posture's pi section, to the system prompt (DEC-098).
- **Status.** Each `setStatus` is also emitted as `powerbar:update` on pi's
  event bus, segment `malebolge-bridge`, registered at `session_start`; a
  cleared status clears the segment. No dependency on pi-powerbar (DEC-097).
- **Bash env.** The spawn hook (ASM-008) sets `MALEBOLGE_BRIDGE_CONVERSATION`
  and `MALEBOLGE_BRIDGE_TOKEN` while paired, and prepends the mounted
  extension directory to `PATH`. A `user_bash` handler applies the same env
  to the operator's `!` commands, on base `process.env`, since pi passes none
  (DEC-096). `MALEBOLGE_BRIDGE_SOCKET` reaches bash from
  the jail's forwarded env (DEC-074 (2)); both sides fall back to
  `bridgeSocketPath`.

**Failure is loud** (DEC-073): the first failure of an outage raises
`ctx.ui.notify(…, "error")` and best-effort `notify-send` (ASM-005), naming
pi's project and session id and, as far as known, the conversation id, topic
and socket path; retries back off and show only in `setStatus`; recovery
notifies once. One function, `outageText(ends)`, builds the text for the
extension and the command alike.

**`pi-bridge/malebolge-bridge`** (DEC-075): an executable script (shebang to
the jail's `node`), reached through the `PATH` the spawn hook sets. `send
[--turn]` reads stdin to end, sends `post-once` and prints `accepted`; `tee`
copies stdin to stdout and prints no ack. Exit statuses: 0 accepted; 2
refused, by the daemon or locally (no bridge env vars, bad arguments; reason
on stderr); 3 outcome unknown (reply lost or deadline expired, never retried);
1 connect failure (stderr line from `outageText`, best-effort `notify-send`).
Same cap and truncation as a post (`capHeadTail` from `pi-bridge/wire.ts`
runs before sending; the daemon caps again).

**Deployment contract** (DEC-074; implemented in `~/flakes` as CHR-007):
1. `…/durable/room/bridge` created before a pi jail starts and ro-bound into
   pi jails; 2. `MALEBOLGE_BRIDGE_SOCKET` forwarded; 3. `pi-bridge/` ro-bound
   at `~/.pi/agent/extensions/malebolge-bridge`; 4. a read-only option for
   the project mount. `docs/internals.md` states the contract.

<!-- doctrine:section sec-8 -->
## 8. Code impact

| path | change |
|---|---|
| `pi-bridge/wire.ts` | new: frame types and parser, `bridgeSocketPath`, `capHeadTail`, both sides (“Bridge listener and wire”) |
| `pi-bridge/index.ts` | new: the extension entry pi loads (“The pi side and deployment”) |
| `pi-bridge/shell.ts` | new: the extension shell, performing `step`'s effects (“The pi side and deployment”) |
| `pi-bridge/state.ts` | new: pairing/connection transition function `step` (“The pi side and deployment”) |
| `pi-bridge/connection.ts` | new: one client connection, shared by the shell and the command |
| `pi-bridge/notices.ts` | new: `outageText` and the loud failure texts (“The pi side and deployment”) |
| `pi-bridge/posture.ts` | new: `PI_BRIDGE_ENVIRONMENT` and pi's posture texts (“Pairing and the pairing document”) |
| `pi-bridge/command.ts`, `pi-bridge/malebolge-bridge` | new: `send` / `tee`; executable, reached through `PATH` set by the spawn hook (“The pi side and deployment”) |
| `flake.nix` | runner `npmDepsHash` for the new dev dependency; `pi-bridge/wire.ts` in the runner's fileset (the daemon imports it); `installPhase` copies `pi-bridge/` |
| `tsconfig.json` | include `pi-bridge` |
| `vitest.config.ts` | coverage includes `pi-bridge/**/*.ts` |
| `package.json`, lockfile | dev dependency `@earendil-works/pi-coding-agent`, for the extension's types and tests only (the jail loads pi's own, ASM-007) |
| `eslint.config.js`, `biome.json` | cover `pi-bridge/` through the same project |
| `src/bridge/listener.ts` | new: second serve, `BRIDGE_FIRST_LINE`, `BRIDGE_BOUND`, bindings, push via `watchDoc` (“Bridge listener and wire”, “Messages”) |
| `src/bridge/pairing.ts` | new: pairing document and its pure rules (“Pairing and the pairing document”, “Loop budget”) |
| `src/bridge/inbound.ts` | new: pi → SATAN submit, envelope, withdrawal wait (“Messages”) |
| `src/bridge/extension.ts` | new: `bridge_post`, `BRIDGE_SECTION` with posture (“Pairing and the pairing document”, “Messages”) |
| `src/submission-ending.ts` | new: `endingOf` moved from `src/threads/task.ts` (“Messages”) |
| `src/threads/task.ts` | imports `endingOf`; no behaviour change |
| `src/truncate.ts` | `capUtf8` moves to `pi-bridge/wire.ts` (beside `capHeadTail`, which builds on it); re-exported here, so daemon callers are unchanged |
| `src/toolsets.ts` | `bridge` toolset, catalog, policy (“Bridge mode and reach”) |
| `src/persona.ts` | `bridge` shares interactive's case (“Bridge mode and reach”) |
| `src/wake/extension.ts` | `profile` in `WakeDeps` (“Bridge mode and reach”) |
| `src/wake/tools.ts` | talk-set check for a wake to another conversation (“Bridge mode and reach”) |
| `src/config.ts` | `bridgeSocket` delegates to `bridgeSocketPath`; bridge variant of `inProfileDir` (“Bridge listener and wire”) |
| `src/unix-socket.ts` | `servePrivateUnix`: private-dir check and socket chmod (“Bridge listener and wire”) |
| `src/runner/control.ts` | uses `servePrivateUnix`; no behaviour change |
| `src/connection-reply.ts` | new: `answer` (generic, its daemon reply union including SL-010's `ModelsMessage`), `write`, `finish`, `fail`, moved from `src/daemon.ts`; `Connection.modelRefs` stays in `src/daemon.ts` (“Bridge listener and wire”) |
| `src/conversations.ts` | `topicInit`'s last parameter (`thread?`) becomes optional `require` and `startedBy`; `pair` uses `writeCreated`'s topic record through `topicInit`; the header comment's “no frame ever creates a topic implicitly” narrowed to attach, citing DEC-093 (“Pairing and the pairing document”) |
| `src/daemon.ts` | connection helpers moved out; `ServeOptions.onOperatorInput` from `act`'s input case (“Loop budget”) |
| `src/daemon-start.ts`, `src/daemon-extensions.ts` | start the bridge listener (room), register the extension |
| `test/bridge-*.test.ts`, `test/bridge-fixture.ts` | new: fake pi client, listener, pairing, inbound, outbox, budget (flat, as `threads-*`); the fixture passes a literal `ModelCatalog` stub to `conversations(…)` and `topicInit` |
| `test/pi-bridge-*.test.ts`, `test/pi-bridge-fake-daemon.ts`, `test/pi-bridge-fake-pi.ts` | new: extension against a fake daemon and a fake pi API |
| `test/toolsets.test.ts`, `test/wake-tools.test.ts`, `test/config.test.ts`, `test/daemon-sections.test.ts` | membership, wake reach, path rule, pinned section |
| `test/structure.test.ts` | new rule: `pi-bridge/` imports nothing from `src/`; the wake/threads seam is already enforced |
| `docs/internals.md`, `README.md` | bridge mode, socket, env vars, deployment contract |

Module boundary: `pi-bridge/` is loaded by pi's jiti from the jail, so it
imports only pi-provided modules and itself; `src/bridge/` may import
`pi-bridge/wire.ts`, never the reverse.

<!-- doctrine:section sec-9 -->
## 9. Verification

Maps the slice's verification intent. VT by test, VH by human.

| intent | criterion | where |
|---|---|---|
| pairing | VT: pair creates C in `<project>-bridge` with toolset bridge; an absent topic is created with no model and C takes the daemon default; a topic model is applied to C; a stored model the catalog lacks is refused `unknown model…`, nothing created; topic with another toolset refused, nothing created; invalid project refused; re-pair from a paired session ends the old pairing; posture survives a pi restart | `test/bridge-pairing.test.ts`, `test/pi-bridge-*.test.ts` |
| resume | VT: bad token and ended pairing refused with distinct reasons; newer connection supersedes older with a reason; socket dir 0700 with owner checked, socket 0600 | `test/bridge-listener.test.ts` |
| both directions | VT: turn and note each way take DEC-069's path; SATAN `bridge_post` returns `sent #n`, pi returns `sent` (DEC-068) | `test/bridge-*.test.ts`, `test/pi-bridge-*.test.ts` |
| queue on disconnect | VT: entries appended while unbound are delivered on resume; per-entry ack; a redelivered seq already in pi's session is skipped and re-acked | `test/bridge-listener.test.ts`, `test/pi-bridge-*.test.ts` |
| outbox cap | VT: at `BRIDGE_OUTBOX_CAP` `bridge_post` refuses `outbox full…`; entries kept | `test/bridge-extension.test.ts` |
| idempotence | VT: a resent `post` with the same id is accepted once, submits once, spends once | `test/bridge-inbound.test.ts` |
| withdrawal notice | VT: an aborted queued turn appends `not delivered: withdrawn (…)`; a delivered one appends nothing | `test/bridge-inbound.test.ts` |
| loop bound | VT: the 11th turn is refused `budget exhausted…`; notes pass; `refill` and an operator input restore; an `orient` does not refill; a duplicate spends nothing; a failed submit after the spend leaves `spent` incremented (DEC-078) | `test/bridge-pairing.test.ts`, `test/daemon.test.ts` |
| refused verbs | VT: an attach verb or unknown frame on `bridge.sock` is refused; post-once closes after one reply | `test/bridge-listener.test.ts` |
| reach | VT: bridge catalog lacks threads; bridge not allowed on host; wake to another conversation refused across talk sets, self-wake allowed, interactive→mail refused; a caller with no index entry is refused | `test/toolsets.test.ts`, `test/wake-tools.test.ts` |
| framing | VT: attribute and body escaping; head-and-tail truncation states the cut | `test/bridge-inbound.test.ts`, `test/pi-bridge-wire.test.ts` |
| pi-side posts | VT: a post while unbound is refused at once; an in-flight post is resent on a resume within the wait, else outcome unknown | `test/pi-bridge-*.test.ts` |
| one-shot | VT: exit statuses 0/1/2/3; `tee` passes stdin through; an oversized stdin is truncated head-and-tail, not refused | `test/pi-bridge-*.test.ts` |
| loud failure | VT: first failed connect notifies once, recovery once, refused resume not retried | `test/pi-bridge-*.test.ts` |
| deduped watch | VT: lost ack, resend, then abort: one submitted input, one notice | `test/bridge-inbound.test.ts` |
| reply deadline | VT: a fake daemon that reads a request and never replies: post gives outcome unknown, post-once exits 3, a bind outage is reported | `test/pi-bridge-*.test.ts` |
| undeliverable notice | VT: full outbox and ended pairing at settlement: logged and notified, outbox unchanged | `test/bridge-inbound.test.ts` |
| idle-only inject | VT (DEC-090): a turn delivered mid-run is buffered and injected once at settle; after an aborted settle the buffered turn enters as a note, with no new turn; a retryable model error (an `agent_end` before settle) causes no early injection; busy note, idle, `/reload`, resume, next run: the note is in context once | `test/pi-bridge-state.test.ts` |
| busy gap | VT: a delivery while `ctx.isIdle()` is false but before `agent_start` is buffered, not injected; an abort in that gap leaves it to the settle flush as a note | `test/pi-bridge-state.test.ts` |
| abort probe | VA in PHASE-01 against real pi: busy delivery, then Esc, then settle: the message appears once, as a note | plan |
| fresh pair failure | VT: a failed, refused or timed-out fresh pair ends `unpaired`, loud, and sends no `resume` | `test/pi-bridge-state.test.ts` |
| superseded | VT: a superseded client sends no automatic `resume` and appends no marker | `test/pi-bridge-state.test.ts` |
| pending posts | VT: a pending post at end, terminal refusal, supersede and shutdown completes once; a re-pair does not receive it | `test/pi-bridge-state.test.ts` |
| refill gating | VT: unpaired and outage input send no frame | `test/pi-bridge-state.test.ts` |
| fork | VT: fork/clone of a paired session: child unpaired, parent's pairing intact | `test/pi-bridge-state.test.ts` |
| end | VT: pair/end/reopen stays unpaired; pair/end/pair pairs fresh; a terminal refusal leaves a marker | `test/pi-bridge-state.test.ts` |
| state table | VT: `step` tested as the table in “The pi side and deployment” | `test/pi-bridge-state.test.ts` |
| PATH | VT: bare `malebolge-bridge send` resolves from another cwd under the spawn hook; VH in the real jail | `test/pi-bridge-*.test.ts`, operator |
| gate | VT: `pi-bridge/` passes typecheck, lint and coverage in the normal gate | CI gate |
| assumptions | VA/VH in PHASE-01: ASM-004..ASM-008 | plan |
| real jail | VH: a jailed pi pairs; each posture completes one exchange; a ro project mount refuses a write; a stopped daemon notifies inside pi (desktop `notify-send` is best-effort and fails in the jail: ASM-005, IMP-025) | operator |

