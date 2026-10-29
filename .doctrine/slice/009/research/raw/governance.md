## Thread 1 — governance applicability

### Binding constraints

| id | constraint (one line) | bears on | citation |
|---|---|---|---|
| DEC-032 | Talk set = per-profile map beside `PROFILE_TOOLSETS`; absent means no set (mail none); one `requireSameTalkSet` serves start, fork and post; a test proves `TALK_SETS` ⊆ `PROFILE_TOOLSETS.allowed` | OQ-5 | `.doctrine/knowledge/decision/032/record-032.toml:7`; `design.md:220-259` |
| DEC-038 | Threads (start/fork/post/caps/reap) run in the room only; host has no talk set; enabling another population is one `TALK_SETS` line plus the extension in that mode's list | OQ-5 | `decision/038/record-038.toml:7`; `design.md:267-268` |
| DEC-029 | A toolset is a complete ordered extension list from a closed catalog in code (`Toolset = "interactive" \| "mail" \| "job"`); the name is fixed at creation, the list re-derived at each restart, and startup refuses a name not installed | OQ-5 | `decision/029/record-029.toml:7`; `docs/internals.md:84-85,117-128` |
| DEC-025 | A conversation's toolset is fixed at creation and never changes; forks inherit it; a topic may name one among the profile's allowed sets | OQ-5, OQ-7 | `decision/025/record-025.toml:7` |
| DEC-024 | Every create path sets an explicit toolset (pi's fail-open "every installed extension" is unreachable), backfilled at startup, guard-tested | OQ-5 | `decision/024/record-024.toml:7` |
| DEC-016 | First-line frames dispatch through one handler table; an unknown key is refused; replies widen additively | OQ-1 | `decision/016/record-016.toml:7`; `docs/internals.md:362-371` |
| DEC-007 | A first-line verb answers once and closes the connection; new keys widen additively | OQ-1 | `knowledge-list.txt:9`; `decision/016/record-016.toml:7` |
| DEC-035 | A post is a durable `satan.post` task, delivered as an input with a task-derived request id and `whenBusy:"followUp"`, **unbounded** (never withdrawn for waiting); failure answers the sender once | OQ-3, OQ-8 | `decision/035-thread-post-delivery/record-035.toml:7`; `design.md:627,649-657` |
| DEC-036 | Every post carries an `Origin` read from the caller's newest input entry (`pi.user`/`satan.wake` → new; `satan.post` → inherited); caps K=4 per origin, N=12 daemon-wide; crossing reaps; **no chain-depth cap — loops are allowed** | OQ-3, OQ-4 | `decision/036/record-036.toml:7`; `design.md:382,406-425,449-450` |
| DEC-041 | Thread tools run sequentially, so one turn's parallel calls cannot pass the caps together | OQ-4 | `design.md:266-274`; `SL-006.md:69-73` |
| DEC-044 | A reap writes the origin's tombstone first (never pruned) in the notice task's commit; every `satan.post` enforces it; the tombstone stops admission, not placement | OQ-4 | `decision/044/record-044.toml:7`; `design.md:840-900` |
| DEC-042 | Daemon-wide `afterFailedRun:"continue"`, `followUpMode:"one-at-a-time"`; input queued behind a failed run advances; faulted runs excluded | OQ-3, OQ-8 | `DEC-042.md:6-10,21-23`; `design.md:808` |
| DEC-046 | A wake scheduled from a reaped family opens a new, capped family (escape accepted, bounded) | OQ-4 | `SL-006.md:79-80`; `RSK-003.md:26-29`; `design.md:928-935` |
| DEC-040 | Code states framing facts only; conduct between conversations is corpus prose, not code | OQ-7 | `decision/040/record-040.toml:7`; `design.md:1004-1015,1058-1087` |
| DEC-059 | Transport and secrets are deployment concerns: the launcher, not the daemon, runs the jail↔host bridge (`socat` to the gateway client socket); malebolge knows nothing of the transport | OQ-1, OQ-2 | `decision/059/record-059.toml:7` |
| DEC-014 | Only the daemon knows its own profile for certain; trusting a client's `MALEBOLGE_PROFILE` as a caller assertion was rejected | OQ-2 | `DEC-014.md:7,9` |

### Evidence (non-binding: RFCs, risks, ideas)

| id | evidence | bears on | citation |
|---|---|---|---|
| RFC-003 | "Reach is authority"; talk sets are closed sets in code, a trust domain whose members' combined capability the operator accepts; mail in no set | OQ-5 | `RFC-003.md:113-137` |
| RFC-003 | A post is a turn whose origin is another conversation; the sender's id is the reply address; instruction-vs-data left only "mostly settled by talk sets" | OQ-3, OQ-7 | `RFC-003.md:154-161,204-205` |
| RFC-003 | Turn origins are human, wake, post, orientation; bounds (post-triggered cap by depth or rate) belong to the threads slice | OQ-3, OQ-4 | `RFC-003.md:98,163-168` |
| RFC-003 OQ-8 | Talk across harnesses (runner, gptel) crosses a process and security boundary and is undecided | OQ-5 | `RFC-003.md:214-218`; `DEC-038` consequences |
| RFC-002 | One connection serves one conversation, first line says what it is for; a second connection is the multiplexing answer | OQ-1 | `RFC-002.md:200-231` |
| RSK-002 | Foreign text → quarantined reader (Q1) → quarantined derivatives (Q2); nothing flows out except through the operator or the lexical exception; mail talks only to the operator | OQ-5 (repo text inward) | `RSK-002.md:42-58,80-84` |
| RSK-003 | A reaped family can restart through `wake_schedule`; accepted, bounded by K/N and clamped wake timing | OQ-4 | `RSK-003.md:20-29` |
| SL-006 (record) | The accepted threads objective set: origins per root input, 4/12 caps, tombstone, "no chain-depth cap: loops are allowed" | OQ-4 | `SL-006.md:69-80,143-144` |
| SL-006 (record) | Accepted residual: "a sender looping against a failing recipient is a loop like any other" | OQ-4 | `SL-006.md:154-160` |
| IDE-002 / IMP-017 | Task-owned conversations and toolset derivation are set aside; "conversation before delegation" | OQ-5 | `IDE-002.md:26-27`; `IMP-017.md:11-16` |

### Checked, not applicable

| id | reason it does not apply |
|---|---|
| DEC-031, DEC-033 | Fork point and fork toolset — the bridge has no fork; fan-out across conversations is a slice non-goal (`slice-009.md:76-80`). |
| DEC-037 | `latestIn` skips tool-created conversations — only bites if pairing *creates* a conversation through a tool; a bridge pair is not `thread_start` (inference, `design.md:355-364`). |
| DEC-039 | Journal/`--list` marks/transcript lines are for `satan.post` tasks and thread tools only. |
| DEC-043 | Interrupted-call ambiguity is scoped to thread tool calls. |
| DEC-045 | `<post-failed>` outcomes apply to the `satan.post` task; a bridge message is a different kind unless delivery is reused. |
| DEC-049, CON-001 | Mail/classifier egress and question policy; the jail's network posture is explicitly a non-goal (`slice-009.md:82-84`). |
| DEC-014 (`--here`) | The client-side git-root/host-path resolution has no analogue on a socket with no client path. Its *constraint* (no trusting a client assertion) is binding, in the table above. |

### Revision candidates

- **DEC-032** — its map has one room member. A bridge toolset needs a second set; the decision's own "a future set is one line" makes this an amendment plus the catalogue test.
- **DEC-038** — "threads run in the room only" is silent on a second mode in a second set; DEC-038's consequences anticipate only "one TALK_SETS line plus the extension in host's list".
- **DEC-029** — the closed `Toolset` union and startup install/refuse check must gain the new mode; lists re-derive at restart, so no data migration (`docs/internals.md:117-120`).
- **DEC-025** — "fixed at creation and never changes" constrains OQ-7: if posture is a mode, it cannot change mid-pairing; if it is prompt text or a flag, DEC-040 puts conduct in corpus prose, not code.
- **DEC-036** — caps count live `satan.post` tasks and derive origin from a four-row table (`design.md:410-415,434-441`); a bridge input kind is unrepresented, so the loop bound either reuses `satan.post`/admission (amendment: new origin row) or is uncovered by DEC-036.
- **DEC-035** — "never withdrawn for waiting" is the queue policy; a bridge queue that drops or bounds on disconnect would amend it.

## Answers bearing on open questions

**OQ-3 (turn semantics).** Governance says every delivered post starts or queues a turn — there is no reply/note distinction. Delivery is an input with `whenBusy:"followUp"` and a task-derived request id (`DEC-035`, `design.md:649-657`). Correlation is by address, not a reply field: the sender's id is the reply address and `from` is where a reply goes (`RFC-003.md:156-158`; `DEC-040`, `design.md:1063-1073`). Origin is inherited from the newest input entry, whose kinds are `pi.user`, `satan.wake`, `satan.post`, `pi.reset` (`design.md:410-415`). An operator input mid-turn re-roots later calls in that turn (`design.md:423-425`). Nothing found on a message kind that does not start a turn.

**OQ-4 (loop bound).** Bound by fan-out caps, not hops: K=4 active posts per origin, N=12 daemon-wide, reaping the crossing or largest family (`DEC-036`, `design.md:449-462`), sequential tool calls so one turn cannot pass them (`DEC-041`), tombstone-first reap (`DEC-044`). Explicitly no chain-depth cap; loops are legitimate (`SL-006.md:80`, `design.md:381-382`). Caps are counted by `harness.inspect` over live `satan.post` tasks only (`design.md:434-441`) — inference: a bridged message that is not a `satan.post` is uncounted, so reusing admission is the only path the governance already sanctions. "Reset by an operator turn" exists only as origin re-rooting (a human origin is a new family); a rate cap appears only as an alternative considered (`RFC-003.md:163-168`), never decided.

**OQ-5 (mode / talk set).** DEC-032 fixes the mechanism: a per-profile map, absent = no set, one `requireSameTalkSet` for every verb. DEC-038 confines threads to the room. Mail belongs to no set on any profile (RSK-002). A new mode is a catalogue change under DEC-029 plus a fixed-at-creation name (DEC-025) and an explicit selection (DEC-024). Its own set, separate from `interactive`, is the only shape the closed-set model permits for keeping jail capability from leaking (RFC-003 "reach is authority"; `slice-009.md:56-58`).

**OQ-7 (posture).** Nothing directly binding. Nearest: DEC-040 splits code-stated facts from conduct prose, so a posture agreed between two agents is conduct, i.e. corpus prose rather than code — inference. RFC-003 leaves "instruction vs data" only mostly settled by talk sets (`RFC-003.md:158-161`, OQ-4). DEC-025 blocks expressing posture as a mode change mid-life. DEC-059's precedent is that such contracts live at deployment, not in the daemon.

**OQ-8 (queue durability).** Governance is unambiguous: durable tasks, not memory. `satan.post` is created in the sender's commit, owned by the recipient, unbounded, re-run after restart with the same request id (`DEC-035`; `design.md:649-657,721`); a failed run continues with queued input (`DEC-042`); a blocked task is swept at start with a journal line and operator notify (`design.md:766-785`); tombstones are durable and never pruned (`DEC-044`). Faulted runs are the accepted residual (`DEC-042.md:21-23`).
