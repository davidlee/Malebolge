# Improve Malebolge's Emacs session interaction

## Context
`M-x malebolge-start` opens `malebolge-attach` in an Emacs comint buffer. The
attach client currently reads stdin one line at a time and sends each line as
its own daemon input. That makes a pasted or composed multi-line message arrive
as several messages, which can be interleaved with the daemon's streamed
response. The daemon protocol already represents input content as a string, so
the primary problem is the interactive client boundary and its Emacs workflow.

The current interface exposes a small set of slash commands but gives little
guidance for composing, submitting, or navigating a conversation. This slice
improves that Emacs session experience with multiline submission as its core
behavior.

## Scope & Objectives
Design and implement an Emacs session interaction that:

- lets the user compose and submit a multi-line message as one logical input;
- keeps a submitted message intact while daemon output streams, so its lines
  are not sent separately or interleaved as new messages;
- visually separates completed Satan responses with a blank line, consistently
  in both live output and the reattached transcript;
- makes user messages and Satan responses visually distinguishable with clear
  role cues that remain understandable without color;
- gives status and tool notices a distinct visual treatment from conversation
  text;
- makes the core session actions discoverable and comfortable to use, including
  message submission, `/abort`, `/compact`, and `/quit`;
- keeps the active input usable during responses and follows new output only
  when the reader is already at the end of the transcript.

The design owns the exact composition interface, key bindings, and any
supporting comint or attach-client changes. Prefer the existing daemon input
protocol; extend it only if design research shows the current string content
cannot carry the required interaction.

Affected surface: `emacs/malebolge.el`, `src/attach-main.ts`, `src/attach.ts`,
`src/render.ts`, and focused tests for the Emacs integration, attach client,
and renderer. The attach entry point needs to select the Emacs input mode;
the renderer handles both live events and reattached history. `src/protocol.ts`
is in scope only if needed to preserve the chosen interaction end to end.

## Non-Goals
- Changing the daemon's conversation, persistence, or streaming semantics.
- Changing SATAN MCP startup internals or systemd lifecycle behavior.
- Redesigning the terminal attach client's one-line interaction.
- Building a general-purpose chat UI or changing unrelated Emacs comint users.
- A broad UX audit beyond composition, submission, visual transcript hierarchy,
  status notices, and output-follow behavior in this Malebolge Emacs session.

## Summary
Done means an Emacs user can submit a multi-line message and the daemon receives
it as exactly one input, with all lines preserved in order. The session makes
its core actions understandable; completed responses are separated; speaker
roles and status notices are distinguishable without relying on color; and
streamed output follows the reader only when they are already at the end of the
transcript. Submitted input does not become separate messages during streaming
output. Focused tests cover the behavior at the Emacs/attach boundary. The
design and phase plan will name the concrete checks and any runtime smoke test.

## Follow-Ups
Before design, run the scoped pre-design research round. Sol should settle the
composition and submission interaction, the ownership boundary between comint
and `malebolge-attach`, and the verification approach. Keep unrelated UX ideas
out of this slice or capture them separately if they emerge.
