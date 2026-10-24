Learned in SL-004 (commits 0a80895..9d996b2).

- **Stub index reader:** `{ snapshot: () => Promise.resolve(doc) }`, not `async () => doc`: `@typescript-eslint/require-await` fires on the latter. As an `EnvTarget.read` it must also carry `snapshotAsOf` (`DocumentReader`); for `contextOf` alone, `IndexReader` (`src/topics.ts`) suffices. `IndexDocument.definition.initial()` gives an index with no entry = an unindexed conversation.
- **Created conversations need an agent:** `openTestHarness` configures only root. A second conversation must `configure({ model: FAUX_MODEL }, context)` before its turn, or the turn generates nothing.
- **`openTestHarness`'s registry is empty:** a bash-turn case passes `[CodingTools]` itself; the env hook is the third positional.
- **Inherited env:** save/restore `process.env` names in `afterEach` (`preservingEnv` in `test/daemon-env.test.ts`). The room fixture's daemon inherits `process.env` at its lazy spawn (first exec), so set variables before the first exec on a fresh `DaemonEnv`. Assert a foreign inherited var alongside the masked one (`[][yes]`), or an empty result proves nothing.
- **Env hook type** is `NonNullable<HarnessOptions["env"]>` (two params, may return undefined); `built()` in the test narrows instead of casting (`consistent-type-assertions: never`).
- Shared fixtures already in `test/harness-fixture.ts`: `closing`, `openIndexedHarness`, `createConversation`, `forkConversation`, `createTaskOwned`, `stubTask`. Reuse; don't re-copy.
