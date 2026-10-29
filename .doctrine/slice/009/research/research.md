# SL-009 research — session bridge

## Header

- Round 1, 2026-10-29. Baseline: `baseline.toml` (stamped by
  `doctrine slice research 9`).
- Producers (quotient pi `research` profile, deepseek-flash, read-only):
  - **Thread 1 governance** — over staged `doctrine show` output
    (`.doctrine/state/slice/009/research-context/governance/`), decision
    records and SL-006's design. Raw: `raw/governance.md`.
  - **Thread 2 code map** — this repo. Raw: `raw/code-map.md`.
  - **Thread 3 pi extension API and jail** — over staged pi coding-agent 1.4.0
    docs, `extensions/types.ts`, examples, and `~/flakes/agents/jailed-agents.nix`
    + `workspace-binds.nix` (copies in `research-context/`). Raw:
    `raw/pi-jail.md`.
  - Orchestrator (Opus): verification greps; read `~/dev/satan/flake.nix` for
    the daemon jail's runtime binds.
- Operator inputs, 2026-10-29 (session): combinator in `jailed-agents` mounts
  a restricted daemon socket into pi profiles; ro/rw is a jail mount option;
  queueing while pi is disconnected is fine; own talk set likely; loop bound
  needed; posture is SATAN-delegates or operator-in-pi-consults, by agreement;
  Emacs unchanged; network is the jail's concern.

## Verification legend

✓ = verified by the orchestrator (read or grep of the cited site).
Unmarked = researcher claim, cited, not checked. Design load-bears ✓ rows only,
or verifies at point of use.

## Thread 1 — governance applicability

### Binding

| id | constraint | bears on |
|---|---|---|
| DEC-016 ✓ | First-line frames dispatch through one handler table (`FIRST_LINE`, `src/daemon.ts:241`); unknown key refused; replies widen additively | OQ-1 |
| DEC-029 / DEC-024 / DEC-025 | Toolset = closed catalog of ordered extension lists in code; every create path names one; fixed at creation, forks inherit | OQ-5, OQ-7 |
| DEC-032 ✓ | Talk sets: per-profile map beside `PROFILE_TOOLSETS`; absent = no set; one `requireSameTalkSet` (`src/toolsets.ts:62-74`) | OQ-5 |
| DEC-038 | Threads run in the room profile only | OQ-5 |
| DEC-035 ✓ | A post is a durable `satan.post` task owned by the recipient, submitted `whenBusy:"followUp"`, waited unbounded (`src/threads/task.ts:157-173`) | OQ-3, OQ-8 |
| DEC-036 ✓ | Caps count live posts per propagating origin: K=4 per family, N=12 daemon-wide (`src/threads/admission.ts:24-27`); **no chain-depth cap, loops allowed** (SL-006 `design.md:382`) | OQ-4 |
| DEC-041, DEC-044, DEC-046 | Thread tools sequential; tombstone-first reap; reaped family's wake opens a new capped family | OQ-4 |
| DEC-042 | `afterFailedRun:"continue"`, `followUpMode:"one-at-a-time"` | OQ-3 |
| DEC-040 | Code states framing facts only; conduct between conversations is corpus prose | OQ-7 |
| DEC-059 ✓ | Transport is the launcher's / deployment's concern; malebolge owns the contract (variable, path, layout); satan and `~/flakes` changes are made by their own sessions | OQ-1, OQ-2, OQ-6 |
| DEC-014 | The daemon does not trust a client's assertion of its profile | OQ-2 |

### Evidence (non-binding)

- RFC-003: "reach is authority"; talk sets are trust domains; turn origins
  human / wake / post / orientation; cross-harness talk (its OQ-8) undecided.
- RFC-002: one connection serves one conversation; first line says what for.
- RSK-002: foreign text → quarantined reader; repo text inward is a lighter
  case of it. RSK-003: reaped family restarting via wakes, accepted, bounded.

### Checked, not applicable

DEC-031/033 (forks: no fork here), DEC-037 (`latestIn` skips tool-created
conversations; pairing is not `thread_start`), DEC-039/043/045 (thread-tool
journal, interrupted calls, `post-failed` — only if delivery reuses
`satan.post`), DEC-049/CON-001 (mail egress; network is a non-goal).

### Revision candidates

DEC-032 and DEC-029 (a new toolset / set: amendments their own text
anticipates); DEC-036 (origin kinds are closed at `human | wake`,
`src/threads/origin.ts:13` ✓ — a bridge origin is a new row); DEC-038 (silent
on a second set); DEC-035 (if a bridge queue is not durable).

## Thread 2 — code map

### Hotspots

| file | change | symbols |
|---|---|---|
| `src/daemon.ts` | second listener with its own frame table | `FIRST_LINE` :241 ✓, `serve` :382 ✓, `startConnection` :110, `bind` :139 |
| `src/protocol.ts` | bridge frames | `FirstLineFrame` :346, `parseFirstLineFrame` :352, `FrameRefused` :117 |
| `src/unix-socket.ts` | socket dir/mode | `serveUnix` :119, `claimUnix` :88 |
| `src/config.ts` | bridge socket path; profile-dir rule | `daemonSocket` :123, `inProfileDir` :139 ✓ |
| `src/daemon-start.ts` | start/stop the second listener | `startDaemon` :203, `stop` :280 |
| `src/threads/{task,admission,caps,origin}.ts` | delivery, loop bound, origin kind | `placed` :157 ✓, `FAMILY_CAP` ✓, `Origin` ✓ |
| `src/toolsets.ts` | `bridge` mode, talk set | `CATALOG` :24, `PROFILE_TOOLSETS` :62 ✓, `TALK_SETS` :71 ✓ |
| `src/daemon-extensions.ts` | bridge extension builder | `builders` :35 |
| `src/conversations.ts` | pair new / resume | `open` :305, `watch` :327 |
| `src/xml.ts` | escaping for envelopes | `escapeXml` :3 |

### Cited facts

1. ✓ One listener only: the daemon's sole `serveUnix` call is `serve`
   (`src/daemon.ts:383`); the other listener in the repo is the runner's
   control socket (`src/runner/control.ts:334`).
2. ✓ No per-connection verb restriction: a bound connection may send any
   `ClientMessage` (`src/daemon.ts:110-135`, researcher; consistent with 1).
3. ✓ `serveUnix` never chmods; the runner's control socket does
   (`src/runner/control.ts:344`, 0600 in a 0700 dir, :328).
4. ✓ `inProfileDir` requires the socket's parent directory to be named for the
   profile (`src/config.ts:139-144`).
5. ✓ Post delivery: open target, submit an input with `whenBusy:"followUp"`,
   `requestId` `post:<taskId>:`, entry kind `satan.post`; wait unbounded
   (`src/threads/task.ts:157-173`). Durable via pi-durable task, survives
   restart (researcher: `session.ts:205-206`).
6. Post envelope `<post from=… topic=…><intent/><context/></post>` is built
   inline and interpolated unescaped though `escapeXml` exists
   (`src/threads/task.ts:99-117`, `src/xml.ts:3`).
7. Talk set refusal is `requireSameTalkSet` → `Refusal`
   (`src/toolsets.ts:81-99`, `src/threads/admission.ts:36-45`).
8. A new mode = `CATALOG` row + unions + `PROFILE_TOOLSETS` + `TALK_SETS` rows
   + a `daemon-extensions.ts` builder; startup reconcile refuses a stored
   toolset the profile does not allow (`src/session.ts:117-137`).
9. Attach survives reconnect by snapshot-then-stream on `watch`
   (`src/daemon.ts:139-172`, `src/conversations.ts:327`).

### Naming precedents

`attach`/`attached`, `list`/`conversations` → `pair`/`paired`;
`POST_KIND = "satan.post"` → `satan.bridge`; `thread_post` → `bridge_post`;
`FrameRefused` wording `"<frame>: <problem>"`; client modules
`reconnecting-client.ts`, `unix-socket-transport.ts`.

## Thread 3 — pi extension API and jail

### pi (coding-agent 1.4.0)

1. ✓ `pi.sendUserMessage(content, {deliverAs?: "steer"|"followUp"})` always
   triggers a turn; `pi.sendMessage(msg, {triggerTurn?, deliverAs?:
   "steer"|"followUp"|"nextTurn"})` records a custom message with or without a
   turn (`extensions/types.ts:1735-1748`). Sending while streaming without
   `deliverAs` throws (`examples/extensions/send-user-message.ts:26-31`).
2. Sockets/timers must open in `session_start` (startup | reload | new |
   resume | fork) and close in an idempotent `session_shutdown`, not in the
   factory (`docs/extensions.md:58-60`; `types.ts:755-761`, `:823-829`).
3. Tools: `pi.registerTool` with TypeBox params, `execute` → `{content,
   details}` (`types.ts:579-591`, `:1675`). Commands: `pi.registerCommand`.
4. Durable per-session state: `pi.appendEntry(customType, data)` (not sent to
   the model), rebuilt from `ctx.sessionManager.getBranch()` at
   `session_start` (plan-mode example). Identity: `ctx.cwd`,
   `sessionManager.getSessionFile()`.
5. Posture/prompt: `before_agent_start` can edit system prompt sections or
   replace the prompt; `pi.setActiveTools` narrows tools; `messageType`
   distinguishes runs the extension started (`docs/extensions.md:216`).
6. Status: `ctx.ui.setStatus` / `notify`, TUI only (`ctx.hasUI`).
7. Loading: `~/.pi/agent/extensions/`, `settings.json` packages (local path
   packages load in place), `-e`; project `.pi/extensions` needs project
   trust. TypeScript via jiti, no build.

### Jail (`~/flakes/agents/jailed-agents.nix`)

1. ✓ satan-mcp precedent: `satanMcpOptions = [ (try-readonly
   "/run/user/1000/satan/mcp") (try-fwd-env "XDG_RUNTIME_DIR") (try-fwd-env
   "SATAN_MCP_SOCKET") ]`, directory mount for ISS-042 (`:168-175`), offered
   via `extraOptions`.
2. ✓ `mountLaunchDir` is `--bind "$PWD" /workspace/<basename>` + `--chdir`
   (`:232-239`); read-only is `--ro-bind` (workspace-binds already chooses
   between the two, `workspace-binds.nix:68-71`).
3. Home is the profile's persisted, writable home (`persist-home`, `:265-269`)
   shared by every jail of that profile; read-only binds over home paths
   follow `hostDoctrineOptions` (`:348-357`).
4. All jails run as the same uid (`:40-50`).

### Daemon jail (`~/dev/satan/flake.nix`) — orchestrator

1. ✓ The room daemon's jail binds `/run/user/1000/satan/durable/room`
   read-write (`flake.nix:486`) and creates it (`:488`). A bridge socket in a
   subdirectory of it is reachable from the host with **no satan change**.

## Cross-thread findings

- **X1 Own directory, not just own socket.** A read-only mount does not stop
  `connect()`. If the pi jail mounted `…/durable/room/` it could dial
  `durable.sock` — the full protocol. The bridge socket needs its own
  directory (e.g. `…/durable/room/bridge/bridge.sock`), and only that
  directory is mounted. That path fails `inProfileDir` (fact 4 ✓), so the
  rule needs a bridge variant. ✓ (by facts 3, 4 and Daemon jail 1).
- **X2 Second listener, own frame table.** Code makes a second `serve` with
  its own table cheaper than a per-connection filter (Thread 2; DEC-016 table
  shape), and it keeps the full socket's protocol intact. Its directory is
  0700 and socket 0600 like the runner's control socket — which only stops
  other uids.
- **X3 Authentication needs a token.** Same uid in every jail (Thread 3 jail
  4), and one socket directory shared by all pi jails: any jail can dial and
  claim any pairing. A pairing token issued at `pair`, persisted on the pi
  side with `appendEntry` and on the daemon side with the pairing, prevents
  hijack; creating a fresh pairing stays open to any mounted jail (that is
  what the mount authorises).
- **X4 Two directions are not symmetric.** pi → SATAN fits the durable post
  path (a recipient conversation; DEC-035). SATAN → pi has no conversation
  recipient: pi is a client. Options: (a) pi reads the bound conversation's
  stream (attach-style, replay on reconnect) and treats SATAN's
  `bridge_post` tool calls as messages; (b) a daemon-side durable outbox per
  pairing, acked by the client. (a) reuses `watch`; (b) is explicit and
  survives pi being down for long.
- **X5 Talk set vs loop bound.** The pi peer is not a conversation, so
  `admitPost`/`requireSameTalkSet` are not on the bridge path. A `bridge`
  mode in **no** talk set (like mail) gives reach = operator + its one pi
  peer, the narrowest option. But the K/N caps count only `satan.post` tasks
  (DEC-036), so the bridge needs its own bound — or its messages ride
  `satan.post` with a `bridge` origin kind. DEC-036 explicitly allows loops;
  a two-agent ping-pong is exactly a loop, so the bridge bound is a new
  policy, not a reuse.
- **X6 Turn semantics map cleanly to pi.** "Starts a turn" vs "note" =
  `sendUserMessage`/`sendMessage{triggerTurn}` vs `sendMessage{triggerTurn:
  false}`; busy → `followUp`. Correlation must ride in the payload (pi has no
  reply ids).
- **X7 Extension packaging.** Not a project extension (project trust; repo
  code would load into the bridge). A local-path package bound read-only into
  the jail by the same combinator that mounts the socket keeps it immutable
  in-jail and versioned with this repo — sharing the protocol types.
- **X8 Posture.** DEC-025 fixes mode at creation, so posture-as-mode cannot
  change mid-pairing; DEC-040 puts conduct in corpus prose. Posture as data on
  the pairing (chosen at `pair`), rendered as prompt text on both sides, fits
  both.

## Design-input deltas

1. Bridge socket in its own directory under the room runtime dir; second
   listener with a bridge-only frame table; `inProfileDir` gains a variant.
   No satan launcher change; one `~/flakes` combinator (socket dir ro +
   extension package ro + env) and a read-only `mountLaunchDir` option.
2. Pairing carries a token (X3) and a posture (X8).
3. Decide X4 (stream vs outbox) and X5 (bridge bound) in design — these are
   the two real choices.
4. A new `bridge` toolset, likely in no talk set; DEC-032/029/036 amendments
   as recorded.
5. Envelope for pi's messages built with `escapeXml` and framed as data
   (Thread 2 fact 6 shows posts don't escape today — a separate defect,
   candidate backlog item).
