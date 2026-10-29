# DEC-082: Conversations judge a model through one requireModel function built from the gateway catalog

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Refined in SL-010 design.md §2 (2026-10-29, during drafting): requireModel is the `require` method of a two-method `ModelCatalog` port ({ require(ref): ModelRef; refs(): string[] }), because DEC-088's --models listing needs chat-model refs from the same catalog. Pending the user's section review of sec-2.