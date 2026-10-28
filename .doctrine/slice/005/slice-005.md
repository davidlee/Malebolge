# Mail read tools and tool partitioning by profile

## Context

satan:RFC-020 (Belphegor: read-only mail for SATAN) puts milestone M3 next:
SATAN triages mail through native `mail_*` read tools. Screwtape, a scheduled
Gleam mirror, syncs Fastmail into its own SQLite store, and it alone holds
the JMAP credential (M1 and M2 are done in screwtape SL-001 and SL-002).

- **Native, not MCP** (satan:RFC-020 D5, operator 2026-10-27). The tools are
  pi-durable `defineTool` registrations in malebolge, like `src/grep.ts`. They
  do not go through satan-mcp.
- **Contract: CLI JSON** (operator, 2026-10-27). The tools call Screwtape's
  read verbs and parse the JSON each verb is versioned to print. They share no
  code with Screwtape and never read its store directly. screwtape SL-003 is
  defining that contract now, cursor included; this slice runs alongside it.
- **Not in the interactive tool set** (satan:RFC-020 D5). The interactive
  daemon has host bash, so "no arbitrary shell" cannot hold there. Mail tools
  belong only to a restricted tool set: `mail_*` reads plus whatever that
  invocation's own output needs.

malebolge has no way to say "this run gets these tools" today. The daemon's
tool set is fixed in `src/daemon-extensions.ts` (`CodingTools`, `grep`, and
the SATAN tools), and the runner's in `src/runner/tools.ts` (`JobTools`).
"Profile" already means **execution profile** in malebolge (`room` | `host`,
`src/config.ts`): where tools run. Tool partitioning is a separate axis,
which tools a run has, and needs its own name (OQ-1).

## Scope & Objectives

1. **Toolsets** (DEC-029, DEC-030, DEC-024, DEC-025). A closed catalog of
   named toolsets in code; a toolset is a conversation's complete extension
   list for its profile, prompt included. Every conversation carries an
   explicit toolset, fixed at creation; stored conversations are backfilled.
   The runner selects `job` in code (no `[mode.*]` key yet); a daemon topic
   may name one of its profile's allowed toolsets. The default toolsets never
   include `mail_*`, and a test asserts that. A mail conversation gets its own
   persona, not the coding prompt.
2. **`mail_*` read tools** over Screwtape's CLI JSON contract: the mailbox
   list, a message list, reading one message as bounded plain text, a thread,
   and "what changed since my cursor". Final names and parameters are decided
   in design and mirror SL-003's verbs.
3. **Bounds in code, not prompts** (brief §4.4). Count and byte caps on each
   result. Truncation, both Screwtape's and ours, is stated in the result,
   never silent.
4. **Untrusted content.** Mail text reaches the model framed as data, along
   with its provenance (JMAP id, `Message-ID`, mailbox, sync time).
5. **A Screwtape client behind a port.** One small module spawns the
   `screwtape` binary (argv only, no shell), bounds its output and validates
   each reply against the contract version. Tools depend on the port, so they
   are tested with a fake until SL-003 lands.

## Non-Goals

- A triage invocation outside the daemon (a repo-less runner job kind, a
  timer; satan:RFC-020 OQ-6). This slice's live consumer is a daemon topic
  with the `mail` toolset (DEC-025).
- The digest, its writer tool and its root (satan:RFC-020 D4, OQ-5).
- Prompt-injection evaluation cases (rest of M3).
- Proposals, mutation, Wormwood (M4).
- Screwtape changes. The contract is screwtape SL-003's.
- Reading the store's SQLite directly.

## Affected surface

- `src/daemon-extensions.ts`, `src/runner/tools.ts`: where tool sets are
  assembled today.
- `src/config.ts`, `src/toolsets.ts`: where a toolset is named and chosen (`src/runner/config.ts` unchanged, DEC-029).
- `src/conversations.ts`, `src/session.ts`, `src/topics.ts`, `src/protocol.ts`,
  `src/attach-invocation.ts`, `src/daemon-start.ts`: explicit selection,
  backfill, and the topic's toolset.
- `src/grep.ts`: its bounded exec is extracted for reuse by the Screwtape client.
- New: `src/mail/**` (the Screwtape client, contract types and tools).
- `test/**`.
- `README.md` § "Where tools run" and the tool inventory.

## Risks, assumptions, open questions

- **Dependency:** screwtape SL-003 fixes the verbs, fields, version marker and
  cursor. The client adapter, and the contract fixtures it is tested against,
  wait for that design to lock. Port, tools and partitioning do not.
- **Risk:** our port assumes a cursor shape SL-003 does not choose. Keep the
  port small, and take its cursor as an opaque token.
- **Risk:** each call starts the BEAM. Latency is accepted (operator chose
  CLI JSON); design says whether a call needs a timeout and how long.
- **ASM:** the triage run runs as `david` on the host and can execute
  `screwtape`. The store's file mode allows it (satan:RFC-020 D3, same uid).
- **ASM:** confining the tools to the store is a property of our code
  (satan:RFC-020 D3). The tools' only reach is the `screwtape` read verbs;
  they take no paths.
- **OQ-1** (resolved, DEC-029): the axis is the **toolset**.
- **OQ-2** (resolved, DEC-025, DEC-029): code catalog; the daemon hosts mail
  conversations through a topic's toolset; the runner selects `job` in code.
- **OQ-3** (resolved, DEC-028): configured absolute paths; envelope `version`
  in a supported set, fail closed.
- **OQ-4** (resolved, DEC-027): the caller holds the cursor; every mail tool
  is `replay: "safe"`.
- **Consequence:** a room daemon now needs Screwtape configured and
  `~/satan-corpus/prompts/mail.txt` present to start (design sec-5).

## Verification / closure

- A test pins the interactive daemon's tool set without `mail_*`, and one
  shows that a run's tool set comes from configuration alone.
- Each `mail_*` tool is tested against a fake port: bounds, truncation notices,
  provenance, data framing, error paths.
- The Screwtape client is tested against SL-003's published contract
  fixtures. A version mismatch fails closed.
- A smoke run against the real `screwtape` on this host, read-only.
- README lists the tool sets and states that mail is absent from the
  interactive set.

## Summary

## Follow-Ups
