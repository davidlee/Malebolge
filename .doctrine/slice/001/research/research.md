# SL-001 pre-design research

Producers: governance applicability and code-map threads ran through Quotient's read-only `research` profile on 2026-10-23. Both final answers are preserved in `raw/governance.md` and `raw/code-map.md`. This synthesis and the marked checks are by Codex. Baseline: `baseline.toml`.

The later addition of `design.md` changes the intent-document baseline but not the pre-design code or governance findings below. The baseline was refreshed after materialising the design.

## Verification legend

✓ means Codex independently read the cited source in this round. Unmarked findings are researcher claims or design inferences and must be checked before they carry a design decision. The raw threads are evidence, not authority. No implementation, tests, or runtime smoke were run.

## Thread 1 — governance applicability

- ✓ SL-001 requires one logical multiline submission, preserved lines, distinct role and status cues without relying on color, blank separation after completed Satan responses in live and reattached history, discoverable submission and slash actions, and conditional output following (`SL-001`, `doctrine show SL-001`). The slice excludes daemon semantics, startup lifecycle, terminal one-line interaction redesign, and unrelated comint users (`SL-001`).
- ✓ The existing string `input.content` satisfies the payload requirement; `parseClientMessage` accepts string content and the daemon passes it to `conversation.submit` (`src/protocol.ts:19`, `src/protocol.ts:120`, `src/daemon.ts:76`). There is no identified reason to change the daemon protocol (`SL-001`).
- ✓ The project currently lists no specs, ADRs, policies, or standards (`doctrine spec list`, `doctrine adr list`, `doctrine policy list`, `doctrine standard list`, 2026-10-23). `AGENTS.md` points at the boot snapshot and identifies a pi checkout; it adds no Emacs design rule (`AGENTS.md:1`).
- Checked, not applicable: `RFC-001` concerns the shared room kernel; `RFC-002` concerns conversation topology, which SL-001 excludes. `IMP-001` concerns development dependencies; `IMP-002` concerns source-tree architecture. These are open advice or backlog items, not binding Emacs UX decisions (`doctrine status`, 2026-10-23).

## Thread 2 — code map

- ✓ `emacs/malebolge.el` creates a comint process and currently installs no local input, transcript, key, or follow behavior (`emacs/malebolge.el:43`).
- ✓ `src/attach.ts` reads stdin with Node `readline`; every `line` runs `commandOf`, which ignores a blank line, recognizes `/quit`, `/abort`, and `/compact`, or sends one input with the original typed line (`src/attach.ts:94`, `src/attach.ts:260`). It is shared by terminal and Emacs (`src/attach.ts:1`).
- ✓ `src/attach-main.ts` passes CLI args through `attachTargetOf` and invokes `attach` with the selected target (`src/attach-main.ts:4`, `src/attach-main.ts:24`). Selecting an explicit Emacs stdin mode therefore also touches this entry point.
- ✓ The attach client JSON-encodes one command per socket line, holds pre-attach commands, and flushes them after an `attached` event (`src/attach.ts:169`, `src/attach.ts:210`). Socket framing escapes embedded newline characters inside a JSON string (`src/ndjson.ts:78`).
- ✓ Reattached history uses snapshot entries; live answers use `message_start`, `message_update`, and `message_end` in the same renderer (`src/render.ts:55`, `src/render.ts:141`). The renderer currently prefixes user history with `» `, leaves assistant text bare, and formats notices as bracketed lines or tool lines beginning `· ` (`src/render.ts:48`, `src/render.ts:95`).
- ✓ A live user `message_end` prints nothing, since the current client expects local typing to be visible (`src/render.ts:173`, `test/render.test.ts:166`). The installed pi-durable event producer emits `message_start` and `message_end` for an appended user entry (`node_modules/@earendil-works/pi-durable/dist/harness/events.js:207`). An Emacs-specific renderer can therefore echo that event without duplicating terminal output.
- ✓ There is no blank line after a completed answer in either history or live output: transcript entries each contribute one trailing newline and live `message_end` contributes one (`src/render.ts:55`, `src/render.ts:173`). `test/render.test.ts:35` and `test/render.test.ts:54` encode today's behavior.
- ✓ The relevant focused suites are `test/attach.test.ts` for client commands and socket behavior and `test/render.test.ts` for transcript and streaming text (`test/attach.test.ts:337`, `test/render.test.ts:35`). No Emacs test harness was found in the repository search (`rg 'emacs|comint' package.json justfile test src`, 2026-10-23).

## Cross-thread findings

- ✓ The multiline failure is at the Emacs-to-attach stdin boundary. The daemon already accepts a single string and socket JSON framing preserves embedded newlines; current attach stdin processing instead emits one input per physical line (`src/attach.ts:94`, `src/attach.ts:260`, `src/protocol.ts:120`, `src/ndjson.ts:82`).
- ✓ `src/render.ts` serves both terminal and Emacs (`src/render.ts:1`). SL-001 now names it in the affected surface so live/history parity has an explicit owner (`SL-001`). The terminal client's one-line submission contract remains outside the redesign.
- ✓ Output-follow and draft isolation belong in the Emacs buffer behavior; the attach renderer only writes appended text and has no Emacs window context (`src/render.ts:1`, `emacs/malebolge.el:43`).

## Design-input deltas

1. Use the existing daemon `input.content` field. Specify a client-side envelope or equivalent framing that sends an entire Emacs draft as one physical stdin line, while leaving terminal typed-line behavior intact.
2. Settle whether the draft lives in a dedicated editable buffer or in comint's prompt region. Specify local echo, exact Enter and submit behavior, slash-command dispatch, and what happens to a draft when the process detaches.
3. Define presentation rules at message boundaries, including multiline role prefixes, empty answers, notice adjacency, and exactly one blank line after a completed answer in both live and snapshot paths.
4. Specify an Emacs-local window-follow rule and focused verification for draft preservation while output streams, one wire input per submission, live/history parity, keyboard discoverability, and terminal compatibility.
