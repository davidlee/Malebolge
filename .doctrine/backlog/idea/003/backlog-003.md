# IDE-003: Let gptel-hosted runs spawn conversations

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

A gptel-hosted run (an Emacs batch run outside the daemon) has no conversation
of its own, so it cannot start, fork or post (SL-006 tools are daemon-side and
room-only, DEC-038). Letting it spawn a daemon conversation needs two things:
teaching the run what a conversation is (addressing, topics, origin), and a
tool that reaches the daemon. Operator view (2026-10-29): self-contained,
probably tractable, out of SL-006. Frames: RFC-003 OQ-8 (talk across
harnesses); origins and families from DEC-036 would need a cross-harness
origin kind.
