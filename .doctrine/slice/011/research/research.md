# SL-011 research

- **Producers:** Thread 1 (governance) and Thread 2 (code map) ran as quotient
  pi agents, profile `research` (deepseek-flash), 2026-10-30. Verbatim output:
  `raw/governance.md`, `raw/code-map.md`. Governance input was staged at
  `.doctrine/state/slice/11/governance.md` (DEC-016, 025, 029, 032, 036, 055,
  064..098, RSK-002, SL-011 scope). Synthesis and ✓ checks: Claude (orchestrator).
- **Baseline:** `baseline.toml` (stamped by `doctrine slice research 11`).

## Verification legend

✓ = checked by the orchestrator at the cited site. Unmarked = researcher
claim, cited, not checked. Design may lean only on ✓ rows or rows it checks
at point of use.

## Thread 1 — governance applicability

Full tables: `raw/governance.md`. No ADRs, policies or standards exist.

**Supersede:**

| id | conflict | disposition |
|---|---|---|
| DEC-065 | pair creates a bridge-mode conversation in `<project>-bridge` | supersede; carry forward token, resume, newest-connection-wins |
| DEC-071 | the `bridge` mode itself | supersede |
| DEC-092 | pair creates through topicInit, topic model applies | supersede (pair creates nothing) — subject to OQ-1 |
| DEC-093 | pair creates `<project>-bridge` | supersede — subject to OQ-1 |

**Amend:**

| id | clause | change |
|---|---|---|
| DEC-029 | catalog has `bridge`; interactive lacks the bridge extension | interactive gains `bridge` (room only) |
| DEC-032 | "a mode in no set" as the jail-text quarantine (bridge precedent) | bridged conversations are in the interactive talk set |
| DEC-076 | a bridge conversation can only self-wake | wakes reach bridged conversations like any interactive one |

**Still binding** (unchanged mechanics): DEC-025 (mode fixed; pair must not
rewrite a mode), DEC-055 (refuse-when-unconfigured precedent), DEC-064
(listener), DEC-066/080 (outbox), DEC-067 (framing, idempotence), DEC-068,
DEC-069, DEC-070 (budget), DEC-072 (posture per pairing), DEC-073/074/075
(deployment, post-once), DEC-078, DEC-079/090, DEC-095, DEC-096/097/098,
RSK-002 (mail unreachable).

**Not applicable:** DEC-077, 081..089, 091, 094 (mail, model seams, listing,
Emacs chooser) — reasons in raw.

## Thread 2 — code map

**Hotspots:** `src/toolsets.ts`, `src/session.ts` (reconcile), `src/bridge/listener.ts`
(pairRow, createBridged, requireBridge), `src/bridge/extension.ts`,
`src/bridge/pairing.ts`, `src/persona.ts`, `src/daemon-extensions.ts`,
`src/daemon.ts` + `src/daemon-start.ts` (only for OQ-1), `pi-bridge/{wire,state,shell,notices}.ts`,
tests (`bridge-pairing`, `toolsets`, `daemon-sections`, `bridge-extension`,
`session`, `persona`, `wake-tools`, `pi-bridge-shell`, `bridge-fixture`).

**Facts:**

1. ✓ `toolsetList` drops `ROOM_ONLY` names on host (`src/toolsets.ts:60-67`);
   adding `bridge` to `ROOM_ONLY` keeps a host daemon from installing it.
2. Pair path today: `pairRow` → `createBridged` writes topic
   `<project>-bridge` with toolset `bridge` if absent, then `create` through
   `bridgedInit` → `topicInit(…, {require: requireBridge})`, `openPairing` in
   the creating commit (`src/bridge/listener.ts:236-302`).
3. ✓ The pairing document is conversation-scoped, one per conversation
   (`src/bridge/pairing.ts:56-76`): one pairing per conversation is
   structural already. ✓ `openPairing` resets token, posture, project,
   ended, seq, outbox, spent (`:115-129`) — the primitive for "new pair ends
   the old".
4. ✓ `isBridged` is `tokenHash !== ""` (`src/bridge/pairing.ts:100`): true
   after the first pair, including once ended.
5. ✓ The bridge section is computed per render from the pairing doc
   (`src/bridge/extension.ts:87-96`); `bridgeSectionText` returns
   `BRIDGE_UNTRUSTED` alone when never bridged, otherwise untrusted +
   environment + posture (`:40-46`). `bridge_post` is always registered;
   unpaired refusal comes from `appendOutbox` (`"not a bridged conversation"`).
6. Startup reconcile refuses a stored topic or conversation whose toolset is
   no longer allowed; it backfills missing toolsets but remaps none
   (`src/session.ts:131-190`, `src/topics.ts:327-348`).
7. Attach bindings live per connection (`src/daemon.ts:57-60`); no
   store-wide set. ✓ A cross-listener hook already exists:
   `onOperatorInput` passed from `daemon-start` into `ServeOptions`
   (`src/daemon-start.ts:268-280`, `:330-338`).
8. pi side: `/bridge pair <posture>` only (`pi-bridge/shell.ts:516-551`);
   frame `{type:"pair", posture, project}` (`pi-bridge/state.ts:673-676`,
   `pi-bridge/wire.ts:172`). `ResumeFrame` already carries `conversation`.
9. ✓ Emacs: the id appears in the transcript notice "attached to
   conversation N" (`src/render.ts:372-376`); no mode line or header entry.

**Naming precedents:** `conversation` field (resume/post-once/paired);
refusals `not a bridged conversation`, `bad token`, `pairing ended`,
`superseded by a newer connection`; `topic X has toolset Y, not bridge`
(`src/bridge/listener.ts:240`) → natural `conversation N has toolset mail, not interactive`.

## Cross-thread findings

- **Section gating is nearly free.** The section is already dynamic (✓5).
  "Render only while paired" = render nothing when `!isBridged(doc)`. Since
  `isBridged` stays true after `end` (✓4), a once-bridged conversation keeps
  the untrusted framing for the bridge messages still in its context — the
  right behaviour; the design should state it.
- **Re-pair = `openPairing` on the existing doc** (✓3). The old pi client's
  live connection must be closed with a reason (new: e.g. `superseded by a
  new pairing`), and its next resume gets `bad token` (loud). Pending posts
  from the old client: ordering needs one sentence in the design.
- **Wake and thread reach (DEC-076, DEC-032).** The operator cleared threads;
  wakes are the same class (jail text reaching another conversation).
  Treat as covered by the same position, but record it in the superseding
  decision rather than leave DEC-076 silently contradicted.
- **Origin accounting (DEC-036).** A bridge-started turn (`satan.bridge`
  input) can now call thread tools. Which origin it opens is unspecified.
  Candidate: a bridge input opens a new origin, like `pi.user`.
- **Budget (DEC-070).** Thread 1 called the budget "inert" because operator
  input refills it. That overstates it: the budget bounds unattended
  pi↔SATAN ping-pong between operator inputs, which is unchanged. No change.
- **Stale pairing on a working conversation.** After pi goes away the
  pairing stays; `bridge_post` queues until the outbox cap (32) then refuses.
  The operator cannot end a pairing from Emacs. Options: accept (a new pair
  supersedes; SATAN sees refusals), or an end path from the attach side —
  likely out of scope.
- **OQ-2 migration.** No remap code exists (6). Retiring `bridge` needs a
  reconcile step rewriting stored `bridge` topics and conversations to
  `interactive` (and their extension lists), or the daemon will not start.

## Design-input deltas

1. Pair takes `conversation`; refuse missing/unknown ids and non-interactive
   toolsets; never create. Supersede DEC-065/071; amend DEC-029/032/076.
2. Section: nothing when never bridged; unchanged otherwise.
3. Re-pair closes the old pairing's live connection with a reason.
4. Reconcile remaps stored `bridge` → `interactive` (OQ-2 answer candidate).
5. Decide DEC-036 origin for bridge inputs.
6. OQ-1 (no id = attached conversation) costs a shared attached-set from
   `src/daemon.ts` to the bridge host, by the `onOperatorInput` precedent;
   if dropped, DEC-092/093 are superseded with nothing to replace them.
7. Emacs needs no change for the id; a pairing indicator is optional.
