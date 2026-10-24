`HarnessOptions.conversationCreated(tx, record)` runs in every commit that
creates or forks a conversation: `createConversation`, `fork`, raw
`tx.createConversation`, and root's creation by `harness.root()` on a fresh
store. All of them go through `#create` → `#stageConversation`
(pi `packages/durable/src/harness/harness.ts:394-425`,
`src/session/transaction.ts:292-345`, at v1.4.0). It runs after the built-in
`pi.*` documents and before `agent` and `init`. `record` carries `parent` and
`owner`. Table reads in it throw `ReadAfterWrite`; documents are readable and
writable. A throw fails the creating commit.

Use it for state every conversation must have (SL-003's index, DEC-012), and
`init` for per-call data. pi's README recommends that split. A harness opened
without the option, such as `test/harness-fixture.ts`'s `openFauxHarness`,
gets no hook.
