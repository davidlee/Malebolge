# DEC-060: Classifications render as a compact, type-generic jev object in each item's core

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Amended 2026-10-29 by the operator's simplicity pass (reply 'ok').



SL-007 lock: JEV_MAX_BYTES is 288, not about 384 (a maximal list/thread core leaves ~310 bytes); the mail-1 example renders at 217 bytes. The rationale's 'the share never cuts a body below max_bytes' does not hold (fill is fitted first): the deduction keeps jev out of the body's room, and cut names body when fill crowds it (operator: 'correct it').