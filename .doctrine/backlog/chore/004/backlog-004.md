# CHR-004: Rename toolset to mode across code, stored records and the wire flag

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

RFC-003 OQ-6 renames "toolset" to "mode". SL-006 deferred it (DEC-032): the
name is not only code (16 `src` files) but stored data (index entries, topic
records) and wire protocol (`attach --set-topic … --toolset NAME`,
`src/attach-main.ts:20`). The rename needs a read-compatible migration of stored
records and a compatibility window for the wire flag, including the Emacs
client.
