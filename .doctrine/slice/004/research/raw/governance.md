# pi run 0c4a35bbfbdca80966dd89423d2e02c3 · 7353 records

I'll start by checking the boot sentinel requirement and reading the slice.

… 11 entries elided
→ bash(cd /home/david/dev/malebolge D=/run/doctrine-bin/doctrine $D backlog list 2>&1 | head -40 echo "########## memory" $D m…)
  ↳ id      │ kind        │ status │ tags                   │ title

## Result
## Thread 1 — governance applicability

### Binding constraints
- **DEC-013** (accepted) — The index is one session-scoped document `{topics:{name:{cwd?}}, conversations:{id:{topic,parent?}}}`; topic/parent truth must be read from it through the harness document reader, not from `scanConversations` and not from new state. SL-004's `conversationVars` may therefore only translate `read()` output. Citation: DEC-013 facet (choice, consequences "Topic listing … read this document, not scanConversations").
- **DEC-012** (accepted) — The `conversationCreated` hook writes the entry, *skipping task-owned conversations*, and records `parent` for forks. So index absence is legitimate (task-owned, runner-created) and `SATAN_TOPIC`/`SATAN_PARENT_CONVERSATION` must stay unset there rather than be guessed (SL-003 Q-2). SL-004's miss path must cover ownerless-vs-task-owned, not just "not yet indexed". Citation: DEC-012 facet (choice, consequences), SL-003 Q-2.
- **DEC-015** (accepted) — Root is `default`'s first conversation and `default` exists implicitly. The lookup for root must yield topic `default`, never a miss; `default` is reserved and cannot be created or renamed. Citation: DEC-015 facet (choice).
- **DEC-014** (accepted, amended RV-008 F-1/F-2/F-6) — The profile of record is the *daemon's own*, not the client's `MALEBOLGE_PROFILE` (a socket override decouples them), and host and room are separate path spaces. Binds `SATAN_PROFILE`'s provenance and makes `SATAN_CWD` a path meaningful only relative to that profile. Citation: DEC-014 facet (choice + amendment).
- **DEC-016** (accepted) — The topics reply already carries the daemon's profile, per DEC-014's consequence "The topics reply carries the daemon's profile (DEC-016)". `SATAN_PROFILE` must read that one value; a second profile derivation in the env wrapper would be a duplicate source of truth. Citation: DEC-016, DEC-014 consequences.
- **satan:DEC-104** (foreign, cited by RFC-002 D1 and SL-003 D1) — A topic's directory is a creation-time default; the conversation's stored `cwd` is the authority thereafter. Binds `SATAN_CWD` to the conversation's agent cwd, never the topic's directory. Citation: RFC-002 D1; SL-003 Context.
- **satan:DEC-107** (foreign) — A new conversation's directory comes from the client's `cwd`, else the topic's, else the daemon's. `SATAN_CWD` must report the stored result, not re-derive the precedence. Citation: SL-003 Context (DEC-104, DEC-107).
- **RFC-002 "Shared resources — The room connection"** (resolved, carried into SL-030) — One pi-env connection serves every conversation and "the environment id `pi-env:daemon-room` must stay the same for every conversation, because pi-durable serializes file writes by environment id and path." The wrapper must vary env per exec only; it must not mint or vary an environment id per conversation. Citation: RFC-002 Shared resources.
- **RFC-002 D2** — Per-conversation project context is captured at creation into a conversation-scoped document so rendering is deterministic. SL-004 renders live index state at every prompt build; that is only safe because no verb renames a topic (DEC-015 reserves `default`; SL-003's `topic` frame only creates or sets a directory). SL-004 must record that invariant to justify R-1. Citation: RFC-002 Outcome D2; SL-003 objective 3.
- **CHR-002 / RFC-002 "pi 1.4.0 is a prerequisite"** — pi-ai, pi-durable, pi-env, pi-mcp stay at exactly 1.4.0 with the runner pin in one rollout. SL-004 may consume 1.4.0's `EnvTarget`/`PromptInput` but must not bump pi packages or churn the room daemon bytes. Citation: CHR-002; DEC-011; SL-003 Risks.
- **satan:DEC-106** (foreign, cited by RFC-002) — Room fault reporting stays per daemon. Per-conversation variables must not be used to re-attribute room faults per conversation. Citation: RFC-002 Shared resources.

### Checked, not applicable
- DEC-079, DEC-080, DEC-081 — do not resolve in this repo (its decision ids stop at DEC-017); no in-repo governance flows through them.
- DEC-011 — the 1.4.0 chore is landed; SL-004 is a consumer, not an owner (its constraint arrives as CHR-002).
- DEC-007, DEC-008, DEC-010, DEC-017 — client/protocol listing and attach-flag shape; SL-004 adds no frame and no flag.
- DEC-009, DEC-001–DEC-006 — Emacs behaviour and SL-001 verification; untouched.
- RFC-001, IMP-002 — tier-5 advice on module placement (`src/lib/`, `src/room/`); worth following for the new module, but nothing binds.
- IMP-009 — room↔host path mapping; SL-004 emits each profile's own path and maps nothing.
- satan IMP-053 / RFC-002 D6 — concurrency and cost ceilings; env vars carry no budget authority.
- IDE-017 — task-created conversations; bites only through DEC-012's skip.
- RSK-001, ISS-001, IMP-001–IMP-010, CHR-001/CHR-003 — open backlog work, not governance.
- `doctrine memory search` for "SATAN_ environment variables" and "prompt section" — no matches; no memory binds this change.

### Revision candidates
- **DEC-014** (and DEC-016's profile field) — SL-004 declares `SATAN_PROFILE` an enum "open to e.g. `tick-agent`", widening the profile beyond DEC-014's `host`/`room` and adding a second carrier of it. Needs an amendment or an explicit cross-reference.
- **RFC-002, "What pi-durable gives us" (env-hook row)** — states the hook receives `EnvTarget{conversationId, cwd?}` and that malebolge's hook "already uses it"; SL-004 widens the type to the full `EnvTarget` and begins using `read`. Resolved-archive drift.
- **SL-003 (Risks, "Inconsistent prompt")** — its scope narrows: SL-004 gives conversations a conversation-aware prompt section while project context remains daemon-wide, which changes what that risk covers.
- **SL-004 itself** — cites no decision ids at all (DEC-012/013/015 shape its reads, DEC-014/016 its profile, satan:DEC-104/107 its cwd); the slice needs them before design lock.
