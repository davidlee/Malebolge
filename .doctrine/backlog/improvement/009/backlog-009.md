# IMP-009: Resolve --here under the room profile: map room paths to host paths

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

DEC-014 (SL-003) limits `--here` to the host profile. Under `room`, the
default, a conversation's cwd is a room path and the shell's git root is a host
path (DEC-010), so an exact match silently misses. This item is the mapping
that would let `--here` work under `room`: how a host repo path corresponds to
its clone in the room (oubliette room repos).
