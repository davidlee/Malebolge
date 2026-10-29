`indexConversation` (`src/topics.ts`) writes `{ topic: "default" }` for any parentless, non-task conversation; root additionally carries `toolset: "interactive"` (`test/topics.test.ts` "indexes a created conversation, and root, in the default topic"). DEC-021's empty `SATAN_TOPIC` applies only to a conversation with no index entry (task-owned).

Sharp edge: an SL-010 handover asserted root had no topic index entry; it misframed an operator question until the code was read. Check index claims against `indexConversation`.
