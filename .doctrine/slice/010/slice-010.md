# Per-topic model, and topics in the Emacs attach chooser

## Context

A topic holds a directory and a toolset (`TopicMessage`, `src/protocol.ts`;
`TopicRecord`, `src/topics.ts`). The model is daemon-wide: `MALEBOLGE_MODEL`,
parsed in `src/config.ts` (`resolveConfig`) and checked at start against the
gateway catalog (`requireKnownModel`, `src/daemon-start.ts`;
`parseGatewayCatalog`, `src/models.ts`). One `ConversationDefaults`
(`{ model, cwd }`) seeds every new conversation's stored agent settings, and
root's again on every open.

~/flakes now serves `openai-dav/*` and `openai-david/*` models through the
gateway catalog (gpt-6-luna, gpt-6.1-terra, gpt-6.1-sol, gpt-6-astra,
gpt-5.4-mini; ~/flakes flakes:DEC-093). The operator wants a topic to choose
the model its conversations use.

Separately, `C-u M-x malebolge-attach` (`emacs/malebolge.el`,
`malebolge--choose-target`) offers bare conversation ids and `new`, and `new`
always lands in `default`. The `list` reply (`ConversationsMessage`) carries
ids only, so the client cannot show topics without a wire change. IMP-018
asked for a topic choice on `new`; this slice absorbs it.

Operator decisions, 2026-10-29 (this session):

- A topic's model applies to **new conversations only**. Existing ones keep
  the model they were created with. This keeps the invariant in
  `src/conversations.ts` (stored agent settings are never rewritten) and
  matches cwd (D1) and toolset (DEC-025).
- The model is set by the **CLI topic write and from Emacs**, not by a SATAN
  tool. An agent cannot choose its own model.
- The chooser shows **each conversation's topic**, and `new` **asks for a
  topic**.

## Scope & Objectives

1. **Topic model, stored and on the wire.** `TopicMessage.model`, with the same
   three cases as `cwd` and `toolset`: absent leaves it unchanged, a string
   sets it, `null` clears it. `TopicRecord`, the `topics` reply
   (`TopicSummary`) and `--topics` output carry it.
2. **Checked when set.** A set model must be one the gateway catalog knows, as
   `requireKnownModel` checks `MALEBOLGE_MODEL` at start. An unknown model is
   refused with an error naming it, and nothing is written.
3. **Used at creation.** A conversation created in a topic with a model gets
   that model in its stored agent settings. Otherwise it gets the daemon
   default. The topic is read in the creating commit, as cwd and toolset are.
4. **CLI.** `malebolge-attach --set-topic NAME --model REF` and `--no-model`,
   following `--toolset` and `--no-toolset` (DEC-017).
5. **Emacs: set a topic's model.** A command that sets or clears a topic's
   model through the same CLI write, with topic names completed from
   `--topics`.
6. **Emacs chooser.** Each conversation line shows its topic and model.
   Choosing `new` asks for a topic, completed from `--topics`, and passes
   `--topic NAME --new` (IMP-018). Both reach the client through an additive
   per-id `summaries` key on the `list` reply (DEC-007, DEC-087).
7. **Model listing.** `--models` prints the catalog's chat-model refs, for
   Emacs completion (DEC-088).
8. **Started threads** take their topic's model (DEC-084, amending DEC-034).
   Model precedence and the unknown-model refusal live in one pure function,
   built to change (DEC-083, DEC-085).

Design decisions: DEC-082..DEC-089; DEC-015 adopted (no model on `default`).

## Non-Goals

- Switching the model of existing conversations, or a per-conversation model
  command.
- A SATAN or in-conversation tool that edits topics.
- Changing root's model: root keeps taking the daemon default on every open.
- Thinking level, ceilings or other per-topic agent settings.
- Changes to the runner's model policy (`src/runner/policy.ts`).
- One buffer per conversation (IMP-014).

## Affected surface

- `src/protocol.ts`: `TopicMessage`, `TopicSummary`, `ConversationsMessage`
- `src/topics.ts`: `TopicRecord`, `TopicChange`, the topic write and its keys
- `src/conversations.ts`: creation defaults, topic listing
- `src/daemon.ts`, `src/daemon-start.ts`: the topic frame, catalog access at write time
- `src/models.ts`: the catalog check, if `requireKnownModel` moves here
- `src/attach-invocation.ts`, `src/attach-main.ts`, `src/attach.ts`: flags, output
- `emacs/malebolge.el`: chooser, topic on `new`, topic-model command
- Tests beside each

## Open questions (for design)

- **OQ-1, a stored model the catalog has dropped.** The catalog can change
  between the topic write and a later creation (or a restart). Proposed:
  creation in that topic is refused with an error naming the model, not
  silently given the default (operator preference: explicit denial over
  silent fallback).
- **OQ-2, the `default` topic.** May `default` carry a model? If so, it
  applies to new conversations in `default`, but not to root.
- **OQ-3, threads and forks.** Does a `thread_start` conversation take its
  topic's model, and does a fork keep its parent's? Proposed: the same rule as
  toolset (a fork copies its parent; a started thread follows its topic).
- **OQ-4, model completion in Emacs.** The client has no model list. Either
  the daemon serves the catalog's chat models (a new listing), or Emacs reads
  free text and the daemon's refusal is the check.
- **OQ-5, the chooser line.** Topic only, or topic and model? A conversation's
  model is in its stored agent settings, not the index, so showing it costs a
  read per listed conversation.

## Verification / closure intent

- VT: the three-case topic write for `model` (set, clear, unchanged) round-trips
  through store and wire. An unknown model is refused and nothing is written.
  A conversation created in a topic carries the topic's model, and one in a
  topic with no model carries the default. Existing conversations keep theirs
  after the topic changes. The `list` reply carries each id's topic.
- VT (Emacs, ERT/smoke): the chooser shows topics, and `new` passes `--topic`.
- VH: set a topic to `openai-david/gpt-6.1-terra` from Emacs, create a
  conversation in it from the chooser, and see it run on that model.

## Summary

Topics gain a model, validated against the gateway catalog when set and used
for new conversations only. It is set from the CLI and Emacs. The Emacs
chooser shows topics and creates conversations in a chosen topic.

## Follow-Ups

- A per-conversation model command (e.g. escalate one conversation to a
  stronger model). pi supports it: one `configure({ model })` commit, applied
  from the next request (pi-durable README § Per-Conversation Agent). Costs:
  thinking blocks from the old model are dropped (pi-ai README § Cross-Provider
  Handoffs), the first request after the switch misses the prompt cache, and a
  smaller context window may force a compaction. It would relax the
  never-rewritten invariant in `src/conversations.ts`.

- CHR-004 (rename toolset to mode) would touch the same flags. Sequence it
  with this slice.
