# Research: SL-005 (mail read tools and tool partitioning)

## Header

- **Threads 1 and 2**: the orchestrator (Opus 5.5), read directly,
  2026-10-27. No research agents were spawned: the surface is small and
  every row below is load-bearing, so reading beat delegating and
  re-verifying. `raw/` is empty.
- Started from screwtape SL-003's research
  (`~/dev/screwtape/.doctrine/slice/003/research/research.md`, same day),
  which maps the contract side. Its rows are cited here as `st:F<n>` and
  `st:finding <n>`, and are not re-verified unless marked ✓.
- satan sources: satan:RFC-020 (D1–D5, D8), satan:RFC-019 D6, read with
  `doctrine show` in `~/dev/satan`.
- pi-durable 1.4.0 as installed (`node_modules/@earendil-works/pi-durable`).
- Baseline: `baseline.toml`, stamped by `doctrine slice research 5`.

## Verification legend

- ✓ means the orchestrator read the cited site in this round.
- Unmarked: cited from SL-003's research or the RFC text, not re-read.

## Thread 1: governance applicability

**Binding here**

| Source | Constraint on SL-005 |
|---|---|
| Operator, 2026-10-27 | Native tools, not MCP. Contract form: **CLI JSON**. |
| `~/.claude/CLAUDE.md`, project CLAUDE.md | TDD; no parallel implementation; lint and format clean. |

malebolge has no ADRs, policies or standards (boot snapshot). Its DECs found
by `doctrine search "tool set"` are about the env and topics (DEC-020,
DEC-021), and none governs tool selection.

**Evidence (satan, not binding here)**

- satan:RFC-020 D5 ✓: the `mail_*` tools are pi-durable native tools over
  the store, bounded per brief §4.4, and do not go through satan-mcp. They
  are **not** in the interactive daemon's tool set ("that session has host
  bash"). Triage is "its own invocation with a fixed tool set: `mail_*`
  reads plus one writer… The tool set comes from configuration; mail
  content cannot widen it." Placement is open (satan:RFC-020 OQ-6).
- satan:RFC-020 D1 ✓: the consumer half of `changes` "is a cursor over the
  store, held by each consumer".
- satan:RFC-020 D3 ✓: same uid. "Native mail tools confining themselves to
  the store is a property of their code, not something the OS enforces."
- satan:RFC-019 D6 ✓: native tools "run on the host, in the agent process.
  The runner is an unjailed unit, so a native read tool there reaches
  whatever its code allows: each must confine itself to its root."
- Brief §4.4 (via st:Thread 1): bound counts, bytes per message, aggregate
  bytes per invocation, thread size and pagination; explicit truncation
  metadata.

**Checked, not applicable**

- satan:ADR-017 (Emacs is a client): no Emacs surface in this slice.
- satan:ISS-028 (jails can reach around the protocol): concerns jailed
  sessions with host reach. The mail tools take no paths. Whether the
  triage run is jailed is satan:RFC-020 OQ-6, out of scope.
- satan:RFC-020 D6/D7 (Wormwood, ledger rows): mutation and credential
  custody, out of scope.

**Revision candidates**

- satan:RFC-020 D5 / OQ-6: once SL-005 fixes the tool-set mechanism, the
  RFC can say how "fixed tool set from configuration" is enforced.

## Thread 2: code map

**Hotspots**

| File | Role for SL-005 |
|---|---|
| `src/daemon-extensions.ts` | ✓ `:24-32` The interactive daemon's extension list: persona, project context, skills, cwd, conversation, `CodingTools`, `grepExtension`. SATAN's MCP tools are installed beside it (`src/daemon-start.ts:89`). |
| `src/daemon-start.ts` | ✓ `:74` builds `daemonExtensions(...)` into the daemon's registry. |
| `src/conversations.ts` | ✓ `:107-121` creates a daemon conversation with `agent: { ...defaults, cwd }`. No `extensions` field is set, so it gets the host default: **every installed extension**. |
| `src/runner/tools.ts` | ✓ `:17-20` `JobTools` = `CodingTools` (with `read` replay-safe) + `grepTool`. |
| `src/runner/start.ts` | ✓ `:147` `extensions = [JobTools, jobGuard(...)]`: one registry for every job. |
| `src/runner/run.ts` | ✓ `:365-372` each job's conversation is configured with `extensions: deps.extensions` (an explicit list), model, thinking level and `cwd`. |
| `src/runner/env.ts` | ✓ `:1-30` a job's env is pi-env's **remote** env into the room. `CodingTools` and `grep` run *through* it, in the room. |
| `src/runner/config.ts` | ✓ `:63-70` `ModeConfig` = policy-ladder rung + `repos` + `allowedPaths` scopes (DEC-069). ✓ `:163,424` `[mode.*]` tables. |
| `src/runner/protocol.ts` | ✓ `:27,122,268-290` a submit names a `mode`, and its repo and paths are checked against that mode's scope. |
| `src/config.ts` | ✓ `:22` `type Profile = "room" \| "host"`: the **execution profile**, where tools run. |
| `src/grep.ts` | ✓ `:1-40` the precedent for a native tool: `defineTool`, TypeBox parameters, byte caps as exported constants, a bounded line splitter for a child's stdout. |
| `src/truncate.ts`, `src/ndjson.ts` | Shared truncation and bounded-line helpers (`grep.ts:16-17` ✓). Reuse for the client's bounded stdout. |

**Cited facts: pi-durable 1.4.0**

- P1 ✓ The registry is per harness. `Registry.install` / `uninstall`
  (`harness/types.d.ts:344-349`).
- P2 ✓ Per conversation, `AgentState.extensions` is "an array [that]
  selects exactly these extensions" or an `{add, remove}` edit of the host
  default. `tools` filters the selected extensions' tools, and `modelTools`
  narrows further and "never widens" (`harness/types.d.ts:350-375`).
- P3 ✓ "By default every conversation selects every installed extension, in
  install order" (README `:243`). Per-conversation selection therefore
  **fails open**: a conversation created without an explicit list gets
  everything installed.
- P4 ✓ Agent state is stored per conversation as names in `pi.agent`,
  resolved against the registry at each use (README `:104`). Only the host
  calls `configure`; no tool in malebolge exposes it to the model.
- P5 ✓ A tool reruns after a crash only if it is declared `replay: "safe"`
  (README `:277`). Nested `executeTool` calls keep their own replay policy.

**Cited facts: Screwtape contract (from SL-003)**

- st:F4 The read verbs (`mailboxes`, `list`, `read`, `thread`) print one
  `{"version":1,"kind","data"}` document. Fields are snake_case, and an
  optional field prints `null`, never omitted. Exit codes 0/1/2; diagnostics
  go to stderr as JSON lines (st:DEC-011).
- st:F5 `list --limit` 1..500 (default 50); `read --max-bytes` with
  `output_truncated`; stored bodies carry `is_truncated` and `truncated_by`.
  **Unbounded:** `thread`'s entry count, and aggregate bytes across calls
  (the consumer's job).
- st:finding 2 The cursor is undecided: an arrival cursor over
  `(received_at_ms, id)` (no schema change; misses late entries and flag
  changes) or a store sequence (schema v2). Either way the consumer holds
  it.
- st:F6 A read-only open of the WAL store creates `-wal` and `-shm`, so the
  reader needs a writable store directory. Not ours while the tools go
  through the CLI: `screwtape` opens the store, not us.
- `read` takes one id (brief §3.1 says "one or more").

**Naming precedents**

- Tool names are snake_case with a prefix: `grep` (pi-style coding tools),
  satan's `notes_read`, `hippocampus_*`. `mail_*` follows the RFC.
- An extension is named for its tools (`job-tools`, the `grep` extension),
  and the runner's `[mode.*]` is already a named, configured scope.

## Cross-thread findings

1. **Partition by registry, not by per-conversation selection (P1–P3).**
   The RFC's "mail content cannot widen it" holds either way: only the
   host's code calls `configure` (P4). Exclusion **by default** holds only
   if the mail extension is never installed in the interactive daemon's
   registry. Selecting per conversation with `extensions: [...]` fails open
   wherever a conversation is created without the list (P3; the daemon's
   `create` sets none, `conversations.ts:113-121` ✓). So the invariant to
   test is "the daemon's registry has no `mail_*` tool", which is checkable
   at startup and in a unit test.
2. **The runner already has the axis: `mode` (`runner/config.ts:63-70`,
   DEC-069).** A mode is a named, configured scope a submit selects. A tool
   set is one more scope on it. The runner also already sets `extensions`
   per job from config (`run.ts:365-372`), the right place for a per-mode
   list. That suggests answering SL-005 OQ-1 with "a mode's `tools`" rather
   than a new noun. But runner jobs are **repo jobs**: a mode scopes repos
   and paths, a job's env is the room (`env.ts`), and its prompt is a commit
   prompt (`runner/prompt.ts:74,101`). A mail triage run has no repo and
   needs no room.
3. **Where the mail tools run differs from the coding tools.** `CodingTools`
   and `grep` run through the job's env, in the room (`env.ts` ✓). The mail
   tools spawn `screwtape` on the host, in the agent process, and do not use
   the env (satan:RFC-019 D6). The runner already runs on the host, so this
   works. But a tool set that mixes the two splits authority between room
   and host, and the RFC's triage set has no coding tools at all.
4. **Replay (SL-005 OQ-4).** Every read verb is idempotent: `replay: "safe"`
   (P5). If the consumer holds the cursor (st:finding 2, satan:RFC-020 D1),
   "advance the cursor" is the caller's act, not the tool's. A `mail_changes`
   tool that takes `after` and returns the next cursor value stays a pure
   read and replay-safe. Where the cursor persists between runs belongs to
   the triage invocation (OQ-6), out of scope.
5. **Bounds split by owner.** Screwtape bounds each call (`--limit`,
   `--max-bytes`). The tools bound the per-run aggregate (st:F5) and
   `thread`'s count until SL-003 adds a limit. The client bounds the child's
   stdout and stderr the way `grep.ts` does (✓ `:1-8`), so a broken or
   hostile reply cannot grow host memory.
6. **Version pinning (SL-005 OQ-3).** The envelope's `version` is the
   contract marker (st:F4). The client accepts exactly the versions it was
   built against and fails closed on any other. Adding a field is compatible
   within a version (SL-003's proposed rule), so the client must ignore
   unknown fields, not reject them.

## Design-input deltas

- **The invariant becomes concrete:** the mail extension is never installed
  in the interactive daemon's registry, a test asserts it, and so does a
  startup check if it is cheap. Per-conversation selection is not the
  mechanism.
- **SL-005 OQ-1/OQ-2 narrow to a design choice:**
  - a. a runner **mode** names its extensions (`[mode.*] tools = [...]`),
    and the runner installs the union. Reuses the existing axis, but needs
    a repo-less job kind (st:finding 2's tension, and OQ-6, which is out of
    scope).
  - b. a **separate harness entry point** (a triage program, like
    `runner-main`) whose registry is only the mail extension plus its
    writer. Simplest enforcement, but it decides OQ-6.
  - c. a **named tool set** (`toolset`) in config, chosen per harness at
    startup, so neither a profile nor a mode is overloaded. The daemon's
    toolset is fixed to "interactive".
  Design must pick one, and choose whether SL-005 commits to a placement
  for OQ-6 or only to the mechanism.
- **The mail tools are replay-safe reads.** The cursor goes in as an input
  and comes out as an output. The tool holds no state.
- **The Screwtape client** reuses `ndjson.ts`/`truncate.ts` for bounded
  output, spawns from a configured absolute path with argv only, and checks
  `version`.
- **Fixtures** come from SL-003's render tests and contract doc once locked.
  Until then, a fake port.
- Rename the slice once OQ-1 settles: "profile" is taken.
