<!-- doctrine:section sec-1 -->
## Purpose and boundary

SATAN gets native `mail_*` read tools over Screwtape's CLI JSON contract
(v1, screwtape SL-003), and only in conversations whose **toolset** grants
them. A toolset is a named, complete, ordered extension list, computed per
execution profile: a conversation's prompt as well as its tools (DEC-029).
The interactive toolset never includes mail (satan:RFC-020 D5).

```
             catalog (src/toolsets.ts, closed, in code): toolsetList(toolset, profile)
   interactive/room ─ persona · project_context · skills · cwd · conversation · coding-tools · grep · tasks · satan
   interactive/host ─ the same without tasks
   mail             ─ mail-persona · conversation · mail
   job              ─ job-tools · job-guard                                  (runner)

 daemon profile ──► allowed toolsets ──► registry installs their lists' union
 topic record {cwd?, toolset?} ──► index entry {topic, parent?, toolset} ──► agent.extensions
                                    (name fixed at creation)     (re-derived at every startup)

 mail extension ──► MailSource port ──► screwtape adapter ──► bounded exec ──► `screwtape --config <c> <verb> …`
                    (fake in tests)      (validation)         (shared with grep)
```

The live consumer is a daemon topic set to `mail` (DEC-025): every new
conversation in it is mail-only.

Out of scope (scope Non-Goals): a repo-less runner job kind and timer
(satan:RFC-020 OQ-6); the digest and its writer; injection evaluation
cases; mutation; Screwtape changes; reading the store directly; a
per-conversation byte budget (DEC-026, backlog IMP-015).

<!-- doctrine:section sec-2 -->
## Toolsets

**Catalog** (`src/toolsets.ts`, DEC-029). `toolsetList(toolset, profile)`
returns extension names in system prompt and tool order:

| toolset | room | host | used by |
|---|---|---|---|
| `interactive` | `persona`, `project_context`, `skills`, `cwd`, `conversation`, `coding-tools`, `grep`, `tasks`, `satan` | the same without `tasks` (room-only, W10) | daemon |
| `mail` | `mail-persona`, `conversation`, `mail` | not allowed | daemon |
| `job` | `job-tools`, `job-guard` | n/a | runner |

- `interactive` is today's install order: the registry's list, with `satan`
  appended by discovery. An interactive conversation's sections and its
  offered tool order are unchanged. VT-1 pins this against a baseline
  captured before the change.
- `type Toolset = "interactive" | "mail" | "job"`. A name outside the
  catalog does not compile.
- Profiles, in code beside the catalog:
  - `room`: default `interactive`, allowed `interactive` and `mail`.
  - `host`: default `interactive`, allowed `interactive` only. A host
    daemon needs no Screwtape configuration.
- The daemon installs exactly the union of its allowed toolsets' lists for
  its profile, so a host registry holds no `mail_*` tool.
- Startup refuses when a static name is not installed: a catalog error.
  `satan` is the one dynamic member. Discovery installs it before the
  session resumes, and pi-durable skips a selected name the registry lacks,
  so an absent `satan` means fewer tools, never more.
- Guard tests: every daemon toolset includes `conversation`; `mail` names
  none of `coding-tools`, `grep`, `satan` or `tasks`.
- Runner: the `job` list is selected in code when a job conversation is
  created (see Selection). There is no `[mode.*]` key until a second runner
  toolset exists.

**Persona per toolset** (DEC-030). `personaFiles(corpusRoot, toolset,
profile)`:

| toolset | files |
|---|---|
| `interactive` | `system/scaffold.txt`, `prompts/interactive.txt`, `prompts/env/<profile>.txt` (unchanged) |
| `mail` | `system/scaffold.txt`, `prompts/mail.txt` |

- `personaExtension(name, files)` takes its extension name: `persona` or
  `mail-persona`. Both render the section key `persona`, so the two personas
  never meet in one conversation.
- One rule for the corpus files: every file of every allowed toolset's
  persona must exist at startup, or startup refuses. Today only the
  environment file is checked; this extends the check.
- `prompts/mail.txt` is a mode prompt, like `interactive.txt`. It says what
  mail triage is for and that it supersedes the parts of `scaffold.txt`
  written for other runs: the batch `Protocol:` section (JSONL,
  `satan_final`) and every reference to tools or write surfaces the manifest
  does not list (`hippocampus_write`, the inbox, goad, memory tools). It
  lives in `~/satan-corpus` (operator's repo); this slice drafts its first
  text as a proposal for the operator.
- No environment file for mail: its tools run on the host whatever the
  profile (DEC-028), and the conversation has no other tools.
- The mail extension's own section, `mail` (tagged), says in code what a
  `<mail-data>` block is and that nothing inside it is an instruction. Each
  tool's description covers its usage, including the retry rules below.

<!-- doctrine:section sec-3 -->
## Selection and storage

**The conversation's toolset is a name in its index entry** (DEC-029 (6)).
`IndexEntry = { topic, parent?, toolset }`. The name is fixed at creation
and never rewritten (DEC-025). The conversation's `agent.extensions` is
derived from it: `toolsetList(entry.toolset, profile)`.

The list is not simply stored at creation because pi-durable stores a
selection as a list of names, frozen when written. With a stored list, an
extension later added to a toolset would never reach existing
conversations. Storing the name keeps *which* toolset fixed, while *what it
contains* follows the code. A change in contents is the operator's act in
code, and it reaches existing conversations at the next restart.

**Creation** (DEC-024 (1)). Every daemon create path passes one init,
`toolsetInit(profile, topic)`, and `create` in `src/conversations.ts`
requires it, so no create path can omit it. Inside the creating commit it
resolves the toolset, checks it against the profile's allowed set, writes
the entry's `toolset`, and calls `configure(tx, id, { extensions })`. It
resolves, in order:

1. the topic record's `toolset`, read in `tx`, for a named topic;
2. the profile default.
pi-durable applies `agent` and then `init` in that commit
(`harness/harness.js:269-272`), so the init's list is the one stored. The
toolset is never read before the commit, so a concurrent `--set-topic`
cannot be overtaken.

**Forks and task-owned conversations are not supported.** malebolge
creates neither today (wake tasks are owned by a conversation; they own
none). A fork would not pass through `create`, and a task-owned
conversation has no index entry, so neither gets a selection here. The
startup reconcile refuses either, naming it, rather than let
pi-durable's fallback give it every installed extension. The slice that
introduces one designs its inheritance (IMP-017). A stored conversation is
therefore never without a selection, and the fallback is unreachable.

| path | toolset |
|---|---|
| topic `new` | the topic record's `toolset`, else the profile default |
| attach `new` | the profile default: it lands in `default`, which holds no record (`src/topics.ts:169-171`); it passes `toolsetInit` like every path |
| root | the profile default, written by the reconcile (below), its only writer |
| runner job | `job`: `src/runner/conversations.ts` passes `agent: { extensions }` at create, and the admission `configure` (`src/runner/run.ts:365-374`) re-derives it from `toolsetList` on every run |
| fork, task-owned | not supported: refused by the startup reconcile (IMP-017) |

The runner stores no toolset name: it opens `Harness` directly, with no
index and no reconcile, and `job` is its only toolset. Its admission write
is its re-derivation, the analogue of reconcile step 3: both writes take
the same `toolsetList("job", …)`, so a job queued across an upgrade runs
the current list. Runner start runs the same installed-name check as the
daemon, so a renamed `job-guard` refuses startup instead of being skipped.
Name storage comes with a second runner toolset, as the `[mode.*]` key
does.

**Startup reconcile** (DEC-024 (2)–(3)). It adds the toolset backfill;
`backfillIndex` stays and still indexes every ownerless conversation that
lacks an entry. It runs in `openSession` after `harness.root()`, root's
`configure` and `backfillIndex`, before `resume()`, in one commit. It scans
every conversation, whatever its owner (`scanConversations`, paged as
`backfillIndex` pages). First, a fork (a record with a `parent`) or a
task-owned conversation (a record with an `owner`) refuses startup, naming
it, so neither is ever defaulted (IMP-017). Then it applies:

1. An entry without `toolset` gets the profile default. This is the
   one-time backfill of today's stored conversations, root included.
2. A topic record or an entry whose toolset the profile does not allow
   refuses startup, naming it. Allowed sets are code, so only a code change
   can produce this, and the remedy is a code change too (a migration in the
   reconcile). Silently widening a mail topic to `interactive` is worse.
3. Each indexed conversation's `extensions` is set to its toolset's list
   when the two differ. Each change is logged (`conversation <id>: toolset
   <t> list changed`).

Root's `configure(options.agent)` keeps model and `cwd` but no longer
carries `extensions`: `SessionOptions.agent` omits the field in its type,
so `openSession` cannot write it, and the reconcile is the only code that
writes root's list. (pi-durable's `Conversation.configure` still accepts
`extensions`; the reconcile runs after root's `configure`, so its list is
the one that stands, and VT-3 checks root's list after a restart.) No turn can run between `root()` and the reconcile,
because both come before `resume()`.

**Topic toolset** (DEC-025 (3)). `TopicRecord = { cwd?, toolset? }`, written
the way `cwd` is:

- The `topic` frame takes `toolset: string | null`. `null` clears it, and an
  absent key leaves it unchanged. A name outside the profile's allowed set
  is refused.
- `malebolge-attach --set-topic <name> --toolset <t>` sets it, and
  `--no-toolset` clears it, beside `--dir`/`--no-dir`.
- The topic listing shows the toolset, so the operator can see which topics
  are mail-only.
- A change affects only conversations created afterwards.

<!-- doctrine:section sec-4 -->
## Mail tools

Five tools behind a `MailSource` port (DEC-026). All are `replay: "safe"`,
none holds state, and the caller holds the cursor (DEC-027).

| tool | port call → screwtape | parameters (clamped) |
|---|---|---|
| `mail_new` | `readAfter` → `read --after <c> --limit --max-bytes [--since --mailbox --unread --from]` | `after` (required; `""` starts), `since` (only with `after: ""`, else refused), `limit` 1–20 (default 10), `max_bytes` 512–8192 (default 4096), filters |
| `mail_read` | `read` → `read <id> --max-bytes` | `id`, `max_bytes` 1024–32768 (default 16384) |
| `mail_thread` | `thread` → `thread <id> --limit` | `id`, `limit` 1–40 (default 20) |
| `mail_list` | `list` → `list --limit --offset [filters]`, newest first | `limit` 1–40 (default 20), `offset` 0–10000, filters |
| `mail_mailboxes` | `mailboxes` → `mailboxes` | none |

**Inputs are validated in code before argv.**
- Ids, including `mailbox`, must match the JMAP Id form,
  `^[A-Za-z0-9_-]{1,255}$`, and must not start with `-`. The form itself
  admits a leading `-`, and screwtape reads a `read` argument starting with
  `--` as a selection (`argv.gleam:102`). A real id starting with `-` is
  refused.
- `from` is at most 256 bytes, has no control characters and no leading
  `-`.
- `after` must be a canonical cursor (contract C3): `""`, or `<ms>:<id>`
  with `<ms>` a decimal int64 printed as Screwtape prints it (no `+`, no
  leading zero, no `-0`) and `<id>` in the JMAP Id form. This is stricter
  than Screwtape's parse, which accepts a `:` inside the id; store ids are
  JMAP Ids, so no real cursor is refused. Checking it here keeps a bad
  value out of argv and lets the header bound `next`.
- `since` is checked against the contract's date form.
- A bad value is refused with a plain error. Clamped values are reported in
  the header (`max_bytes clamped to N`).

**Bounds: every result fits, by construction** (DEC-026, refined).

Every size below is measured in **rendered bytes**: the UTF-8 length after
`JSON.stringify` and the escaping described under Output, which can make one
character six bytes. Nothing is measured on raw text.

- `MAIL_MAX_BYTES` = 50 KiB per result, the same as grep's.
  `HEADER_RESERVE` = 2 KiB holds the header and the block's fixed wrapper
  (the `<mail-data untrusted="true">` and `</mail-data>` lines and the
  newlines around them, 64 bytes charged), so the header itself has
  1984 bytes. The items share the remaining 48 KiB.
- **Share:** each item may use `floor((48 KiB − (limit − 1)) / limit)`: the
  48 KiB less the newlines between items, divided equally (`mail_read`:
  limit 1).
- **Body:** Screwtape returns `bodies`, a list of parts, each with its own
  text and flags. The projection folds them into one `body` and one fixed
  set of body flags, so neither grows with the number of parts:
  - `body`: the parts' texts in Screwtape's order, joined by a blank line;
  - `is_truncated`, `is_encoding_problem`, `conversion_failed`: true when
    true of any part;
  - `truncated_by`: the distinct reasons of the truncated parts (at most
    `server` and `message_limit`);
  - `output_truncated`: Screwtape cut this output (`--max-bytes`), or our
    fill cut the body.
- **Core:** every item opens with fields that are always shown, as
  top-level keys:
  - the summary core, for `mail_list` and `mail_thread`: `id`,
    `thread_id`, `received_at`, `subject` (capped at 200 bytes), `is_seen`,
    `is_flagged`, `has_attachment`, `held_back` when set, `cut`, and for a
    thread item `in_store`. A thread entry the store does
    not hold is `id` and `in_store: false` only;
  - `mail_new`: the summary core plus the body flags;
  - `mail_read`: the summary core plus the body flags, `message_id`
    (its first 5 entries, each at most 256 bytes) and `account_id`.

  `subject` and `message_id` are the only fields ever shortened, because
  a core field cannot be left out; a cut `subject` ends in `…`.

  `mail_new` reads envelopes (`readAfter`) but does not show their
  `message_id` or `account_id` (`mail_read` shows them); its body goes
  last in the fill.

  Ids are validated against the JMAP Id form by the contract schema (at
  most 255 bytes). `received_at` is validated as RFC 3339 and rendered by
  our code as UTC to the millisecond (`2026-10-28T09:41:00.000Z`, 24
  bytes), never as Screwtape printed it. So a summary core is at most
  1152 bytes (worst case 1040: keys 137, values 734, the largest `cut`
  152, `in_store` 17); the body flags add at most 141, so `mail_new`'s
  core (no `in_store`) is at most 1280 (worst case 1164); and a read core
  is at most 3 KiB (worst case about 2.7 KiB). The limits are clamped so a
  core always fits its share: at limit 40 the share is 1227 bytes, at
  `mail_new`'s limit 20 it is 2456, and `mail_read`'s single item has the
  whole 48 KiB.
- **Fill, in a fixed order, after the core:** `from`, `mailbox_ids`, `to`,
  `cc`, `bcc`, `reply_to`, `sender`, `sent_at`, `size`, `preview`,
  `keywords`, `in_reply_to`, `references`, `attachments`, then the body
  last. A verb fills only
  the fields its envelope carries: `mail_list` and `mail_thread` items
  carry no body.
  - Not projected: the per-item `cursor` (the header carries `next`) and
    `provenance` fields other than `account_id`. The projection schema keeps
    only the fields named in this section, so a field added in v1 is
    neither rendered nor counted.
  - A non-body field is added whole if it fits in what remains of the
    share; otherwise it is left out. No other field is shortened: a
    40-entry `to` list is shown whole or not at all.
  - The body takes what remains. It is cut at a code-point boundary so its
    rendered length fits, `body` is named in `cut`, and `output_truncated`
    is set.
  - So a message is never replaced or dropped. At worst its fields give way
    to its core, and the model can re-read it with `mail_read`.
- `cut` names every field that was shortened or left out (`"cut":
  ["subject", "to", "body"]`), from a fixed set of names.
- **Joint clamp:** `mail_new` clamps `max_bytes` to at most
  `floor(40 KiB / limit)`, so Screwtape's output stays proportionate to what
  can be shown.
- `mail_mailboxes`: mailboxes are added whole, in Screwtape's order, while
  they fit in 48 KiB, and the header says `shown N of M`.
- **The header** holds only literals our code writes and values in fixed
  forms, each of bounded length, so it fits its 1984 bytes by
  construction; a test renders its largest form.

**Output.**
- A trusted header comes first. It contains only literals our code writes
  and values validated against fixed forms (integers; cursors as screwtape
  returned them, checked against the canonical cursor form under Inputs;
  RFC 3339 times). An invalid value fails closed. The header holds:
  - counts (items, items with cuts, held back), `next`, `caught_up`.
    `next` is written as a JSON string, escaped like the data block, so the
    cursor stays opaque and its text is data, not prose. The canonical
    form has no character that escaping lengthens, so `next` renders in at
    most 278 bytes (19 digits, a sign, `:`, a 255-byte id, two quotes);
  - the clamps applied;
  - for threads, `total` and `truncated` (Screwtape keeps the last `limit`
    entries);
  - for mailboxes, `shown N of M`;
  - the known gaps, one fixed line (late arrivals; filters do not reopen
    passed positions).
- Then `<mail-data untrusted="true">`: one line per item, made by
  `JSON.stringify` and then replacing every `<`, `>` and `&` with its JSON
  escape (`\u003c`, `\u003e`, `\u0026`). The line stays valid JSON, and
  no content can close the block. Mailbox names and `in_store: false`
  thread ids (id only) are items too.
- Provenance per verb is part of the core (above): summaries (`mail_new`,
  `mail_list`, `mail_thread`) carry `id`, `thread_id`, `received_at`, and
  `mailbox_ids` second in the fill (left out, and named in `cut`, only when
  it does not fit); `mail_read` adds `message_id`,
  `account_id` (from `provenance`) and the body flags.
- Empty stdout from `read --after` means zero messages.

**Cursor** (DEC-027, refined).
- `next` is the cursor of the last item Screwtape returned, computed on the
  raw page. With no item returned, `next` is the input `after`.
- `caught_up` means fewer than `limit` were returned, or a message was held
  back.
- **Held back:** a message whose `received_at` is later than now plus 10
  minutes. It is judged on the validated envelope, before projection.
  `next` stops before the first held-back message, or stays at the input
  `after` when it comes first, and `caught_up` is true. The message is
  still shown, with `held_back: true`, and reappears on each poll until its
  date arrives. Arrivals sort by `received_at` (contract `ORDER BY
  received_at_ms, id`), so new mail sorts ahead of it and paging never
  stalls. The rule reads `received_at`, never the cursor's text.
- **Oversize message:** at `limit: 1`, a ceiling failure (sec-5) means
  the next envelope is over 4 MiB. `mail_new` fails with `screwtape output
  over 4 MiB at limit 1: the next message cannot be read` and returns no
  `next`, so it cannot pass that message while it is in the store;
  `mail_list` still shows it. Accepted: it takes headers over 4 MiB (about
  20,000 MIME parts). Screwtape IMP-002, bounding list fields on
  Screwtape's side, is the fix.
- `mail_list`'s description says that `offset` paging shifts under a
  concurrent sync, and that `mail_new` is the stable path.

<!-- doctrine:section sec-5 -->
## Screwtape client

The `MailSource` adapter (DEC-028).

- **Location.** `MALEBOLGE_SCREWTAPE` and `MALEBOLGE_SCREWTAPE_CONFIG`
  are absolute paths, checked at startup, and required only when the
  profile allows `mail` (that is, `room`). There is no `PATH` lookup.
  Deployment order: corpus `prompts/mail.txt`, then the launcher env, then
  restart the daemon. The room runs in satan's `jailed-malebolge` jail:
  `mkJailedMalebolge` sets both variables, binds the binary and config with
  their closures, and binds the store's directory read-write (WAL sidecars;
  screwtape DEC-031). `MALEBOLGE_SCREWTAPE` is the unwrapped binary, since
  the Home Manager wrapper passes its own `--config` first. Detail:
  `docs/internals.md`.
- **Spawn.** A host `NodeExecutionEnv` owned by the mail extension, never
  the conversation's env (which may be the room).
  - argv is `["--config", <config>, <verb>, …]`: `--config` must come first
    (`argv.gleam:81`). No shell.
  - `inheritEnv: false` with `env: { HOME }`. Without it, pi-durable merges
    the daemon's environment (`env/node.js:205,745`).
  - 10 s timeout. The env holds no resources and has no close; an
    in-flight child ends with its call's abort signal when the harness
    closes.
- **Bounded exec** (`src/bounded-exec.ts`, extracted from `src/grep.ts`).
  - stdout goes through `boundedLineSplitter` (not the unbounded
    `lineSplitter`), with `MAIL_STDOUT_MAX` = 4 MiB as both the per-line cap
    and the total ceiling.
  - stderr is capped with `headKeeper`.
  - An oversize option, `"fail" | "count"`: mail fails closed on an
    oversize line or on the ceiling (no partial result); grep keeps
    count-and-notice. grep's tests pin its behaviour.
  - Screwtape bounds only bodies, so a page of `limit` envelopes with large
    headers (long `References` chains, many parts) can reach the ceiling
    although each envelope is small. The error then says so and, when
    `limit` is above 1, tells the model to retry with `limit: 1`
    (`screwtape output over 4 MiB; retry with limit 1`). The tool
    descriptions state the same rule.
  - A single envelope over 4 MiB fails even at `limit: 1`, and
    `mail_new` cannot pass it (Mail tools, Cursor); accepted. Screwtape
    bounding its list fields per envelope is screwtape IMP-002.
- **Outcome mapping.** Raw stderr never reaches the model.

  | outcome | model sees |
  |---|---|
  | exit 0 | the result |
  | exit 2 | `screwtape usage error: <code>`. `<code>` is the `reason` field of the first stderr line whose `level` is `"error"` (a warning line may come first), accepted only if it matches `^[a-z_]{1,64}$`; otherwise the message has no code |
  | any other exit, including `128+n` | `screwtape failed (exit N)` |
  | `ExecutionError` `timeout` | `screwtape timed out after 10 s` |
  | `ExecutionError` `aborted` | the abort propagates (the call is aborted) |
  | `ExecutionError` `spawn_error` | `screwtape could not run` |
  | an unterminated last stdout line | `screwtape contract violation: unterminated line` |

- **Validation, fail closed.**
  - Every stdout line parses as JSON, with a `version` in `{1}` and the
    called verb's `kind`.
  - Its `data` passes a TypeBox projection schema that allows extra fields
    (a v1 addition is compatible). Every id it carries (`id`, `thread_id`,
    mailbox ids, `account_id`, `blob_id`) matches the JMAP Id form,
    each `cursor` is canonical (Mail tools, Inputs), and
    `received_at` is RFC 3339 (rendered normalised by our code). This is
    what bounds the core of an item (Mail tools).
  - Arity per verb: exactly one envelope, except `read --after`, which
    prints 0 to `limit`.
  - Any failure fails the call with `screwtape contract violation: <what>`,
    with `<what>` drawn from a fixed set. No partial data.
- **Port.**
  `MailSource { mailboxes, list, read, readAfter, thread }`
  returns validated envelopes. Failures reach the tools as
  `MailSourceError { failure }`, so a tool can tell the oversize failure at
  limit 1 from the others. A classifier stage can later replace
  `readAfter` (screwtape IDE-001) without changing the tools.

<!-- doctrine:section sec-6 -->
## Code impact

| file | change |
|---|---|
| `src/toolsets.ts` (new) | `Toolset`, `toolsetList(toolset, profile)`, per-profile default and allowed sets, the installed-name check |
| `src/daemon-extensions.ts` | builds the extensions of the profile's allowed toolsets by name. Section and tool order now come from the selection |
| `src/persona.ts` | `personaFiles(corpusRoot, toolset, profile)` checking every file; `personaExtension(name, files)` |
| `src/topics.ts` | `IndexEntry.toolset`, `TopicRecord.toolset`; `writeTopicRecord` takes `toolset` like `cwd` |
| `src/session.ts` | the startup reconcile (the fork and task-owned refusal, steps 1–3) after `backfillIndex`, which stays; `SessionOptions.agent` omits `extensions` |
| `src/conversations.ts` | `toolsetInit`, required by `create` on every path; `setTopic` validates `toolset` |
| `src/protocol.ts`, `src/attach-invocation.ts`, `src/request.ts`, `src/attach-main.ts` | `toolset` on the `topic` frame and in `requestFrameOf`; `--toolset`/`--no-toolset` with `--set-topic`, and in the usage text; the listing shows it |
| `src/daemon-start.ts`, `src/config.ts` | Screwtape paths read and checked when the profile allows `mail`; the mail extension built and closed |
| `src/wake/*` | no change: wake creates through `conversations.open` (verified PHASE-02) |
| `src/render.ts`, `src/daemon-main.ts` | the topic listing's toolset field; the startup log's mail tool count |
| `package.json`, `package-lock.json`, `flake.nix`, `biome.json`, `vitest.config.ts` | `typebox` declared; biome in the flake's dev shell and `npmDepsHash`; the smoke excluded from `just check`; mail fixtures excluded from biome |
| `test/interactive-baseline.ts`, `test/fixtures/corpus/**`, `test/bounded-exec.test.ts`, `test/config.test.ts`, `test/conversation-context.test.ts`, `test/daemon.test.ts`, `test/render.test.ts`, `test/skills.test.ts`, `test/wake-tools.test.ts` | the baseline helper and its fixed corpus; bounded exec's own tests; callers updated for toolsets and the listing |
| `src/bounded-exec.ts` (new), `src/grep.ts` | bounded exec extracted with the oversize option; grep moved onto it |
| `src/mail/source.ts` (new) | `MailSource` port, v1 projection types and schemas |
| `src/mail/screwtape.ts` (new) | the adapter: argv, exec, outcome mapping, validation |
| `src/mail/project.ts` (new) | the projection, sizes in rendered bytes (including the fold of `bodies` into one `body` and its flags), pure |
| `src/mail/render.ts` (new) | header, escaping, the core and the ordered fill of each share, the body cut, pure |
| `src/mail/tools.ts` (new) | the five tools: input validation (the canonical cursor check shared with the adapter), clamps, cursor rules |
| `src/mail/extension.ts` (new) | the `mail` extension: tools plus the `mail` section |
| `src/runner/conversations.ts`, `src/runner/start.ts`, `src/runner/run.ts` | `job` list at create and at admission, both from `toolsetList`; the installed-name check at runner start |
| `src/runner/tools.ts` | no change: `JobTools` stays the source of the `job` extensions |
| `src/runner/config.ts` | no change (DEC-029 (5)) |
| `test/structure.test.ts` | `RUNNER_ROOTS` gains `toolsets` |
| `test/fixtures/interactive-baseline.json` (new) | captured before any change to `src/daemon-extensions.ts` or `src/persona.ts`: per profile, section keys and texts and ordered tool names of a new interactive conversation over the static registry (`daemonExtensions`; `satan` is discovered at run time and excluded) and a fixed test corpus under `test/fixtures/`, never `~/satan-corpus`. It records the source commit it was captured at and the registry it was built from |
| `test/toolsets.test.ts` (new) | catalog invariants and the baseline comparison |
| `test/mail/*.test.ts` (new), `test/mail/fixtures/` (v1 envelopes from SL-003) | projection, render, tools on a fake `MailSource`, adapter, opt-in smoke |
| `test/session.test.ts`, `test/conversations.test.ts`, `test/topics.test.ts`, `test/protocol.test.ts`, `test/attach-invocation.test.ts`, `test/request.test.ts`, `test/persona.test.ts`, `test/daemon-sections.test.ts`, `test/daemon-start.test.ts`, `test/grep.test.ts`, `test/runner/*` | per the verification table |
| `test/models.test.ts`, `test/wake-fixture.ts`, `test/daemon-env.test.ts`, `test/topics.test.ts` | `openSession` callers: options without `extensions` |
| `test/harness-fixture.ts` | `toolsetProbe`: creates a conversation by a path, on a sqlite store, and reads its resolved agent (extension names, offered tools, section keys) through `conversation.agent()`, with no turn needed |
| `README.md`, `docs/internals.md` | toolsets, the catalog table, "mail is absent from interactive", the topic `--toolset`, the Screwtape variables and deployment order |
| `~/satan-corpus/prompts/mail.txt` (other repo) | first text drafted here as a proposal for the operator |

<!-- doctrine:section sec-7 -->
## Verification

| criterion | how |
|---|---|
| VT-1. A new interactive conversation's section keys and texts, and its ordered offered tool names, equal `interactive-baseline.json` for room and for host, over the static registry (`satan` excluded) and a fixed test corpus. The fixture is captured before any change to `src/daemon-extensions.ts` or `src/persona.ts` and records its source commit; dropping `tasks` from the room list fails this test | VT, `test/toolsets.test.ts` |
| VT-2. Guards: `mail` names none of `coding-tools`, `grep`, `satan`, `tasks`; every daemon toolset includes `conversation`; a host registry has no `mail_*` tool and starts with no Screwtape variables; a room start refuses when `MALEBOLGE_SCREWTAPE` or `MALEBOLGE_SCREWTAPE_CONFIG` is missing or relative; a room registry has the mail tools and `satan.wake`; a discovered `satan` is last in the interactive list; a static name missing from the registry refuses startup | VT, `test/toolsets.test.ts`, `test/daemon-start.test.ts` |
| VT-3. Each create path (topic new in a `mail` topic and in a plain one, attach new, root, runner job) yields exactly its toolset's extensions, via `toolsetProbe`, on a sqlite store, also after a restart; a runner admission re-derives the `job` list, and a runner registry missing a `job` name refuses start | VT, `test/conversations.test.ts`, `test/runner/*` |
| VT-4. Resolution is inside the creating commit: in one commit, a topic record staged before `toolsetInit` runs is the toolset the entry records. An implementation that reads the topic record before the commit fails this | VT, `test/conversations.test.ts` |
| VT-5. Reconcile: an entry without a toolset gets the default; a list made stale by a test catalog change is re-derived and logged; a disallowed topic or entry toolset refuses, naming it; a fork and a task-owned conversation each refuse startup, naming the conversation, and neither is defaulted. Each case is set up on a handcrafted store | VT, `test/session.test.ts`, `test/topics.test.ts` |
| VT-6. Persona: mail is scaffold then `mail.txt`, with no environment file and key `persona`; a missing persona file of an allowed toolset refuses startup (room needs `mail.txt`, host does not); the `mail` section text states the untrusted-data rule (pinned) | VT, `test/persona.test.ts`, `test/daemon-sections.test.ts` |
| VT-7. Topic toolset: the frame sets, clears and leaves it; a disallowed name is refused; the CLI flags parse and conflict as `--dir` does; the listing shows it | VT, `test/protocol.test.ts`, `test/attach-invocation.test.ts`, `test/topics.test.ts` |
| VT-8. Projection and render (pure): a 300-byte `subject` and a 7-entry `message_id` are shortened and named in `cut`, and a long `to` list is left out whole and named in `cut`; escaping (a body containing `</mail-data>`, and one of 4096 `<`, stays inside one valid JSON line); the fill (at limit 10, a body of 4096 `>` keeps the core and the addresses and is cut, with `output_truncated`; a field that does not fit is left out and named in `cut`); the largest summary core (255-byte ids, 200-byte subject, every flag, the largest `cut`, `in_store`) fits its share at `mail_list` and `mail_thread` 40, the largest `mail_new` core (summary core plus body flags) fits at 20, and the largest read core fits 3 KiB; a thread renders `in_store` on every item, and an entry not in the store as `id` and `in_store: false` only; an envelope of many body parts, mixed flags and reasons, renders one `body` and one set of body flags; a `received_at` with long fractional seconds renders as 24 bytes; a page at limit 40 of items tuned to their share, with the largest header, is within `MAIL_MAX_BYTES` counting newlines; fields outside the projection are not rendered; the largest header, with a 278-byte `next`, fits 1984 bytes, and with the block wrapper fits `HEADER_RESERVE`, and `next` in it is an escaped JSON string; mailboxes `shown N of M`; a property test over generated hostile envelopes at every limit keeps every result within `MAIL_MAX_BYTES` and every item's core whole; header values only from fixed forms, a malformed `received_at` fails closed | VT, `test/mail/render.test.ts`, `test/mail/project.test.ts` |
| VT-9. Tools on a fake `MailSource`: input validation (an id `--after`, a `from` with a leading `-`, `since` with a non-empty `after`, non-canonical `after` values such as `+5:x`, `05:x`, `-0:x` and an int64 overflow); clamps reported; `next` on an empty page equals `after`; held-back first, k-th and all, and held back with cut fields; at `limit: 1` a ceiling failure returns the oversize-message error and no `next`; `caught_up`; thread `total`/`truncated`; per-verb core keys exactly; `replay: "safe"` on all five; the tool descriptions state the `limit: 1` retry and, for `mail_list`, the `offset` drift (pinned) | VT, `test/mail/tools.test.ts` |
| VT-10. Adapter on SL-003 fixtures: argv with `--config` first; `inheritEnv: false`; outcome mapping (0, 2 with a valid and an invalid code, 1, 137, timeout, abort); no fixture stderr text in any error; bad JSON, wrong version, wrong kind, schema failure (including an id outside the JMAP Id form and a non-canonical `cursor`) and wrong arity each fail closed; extra fields accepted; an oversize line and the ceiling fail closed, with the `limit: 1` retry text only when `limit` is above 1 | VT, `test/mail/screwtape.test.ts` |
| VT-11. grep is unchanged on the shared bounded exec (its existing tests, plus count mode) | VT, `test/grep.test.ts` |
| VT-12. Smoke, opt-in only (`MALEBOLGE_MAIL_SMOKE=1`, never in `just check`): the real `screwtape` read verbs against a temporary copy of the store, configured to it; the copy's database file digest is unchanged afterwards | VT, `test/mail/smoke.test.ts` |
| VH-1. In a topic set to `mail`, a new conversation lists only the mail tools, triages recent mail and reads one message | VH, operator in Emacs |

`just check` is green and lint is clean at every phase end.

