# ISS-004: SL-009 design must absorb SL-010's creation seam and listing changes

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator assent 2026-10-29 ("recommended on all"): file these for SL-009 design; SL-010 lands first. From the SL-010 design review, round 1.

1. (M-15) Bridge `pair` creates its conversation through SL-010's `topicInit` (catalog + daemon default), so the pairing commit configures the topic's model (DEC-085). A `<project>-bridge` topic whose stored model the catalog lacks refuses `pair` and creates nothing (DEC-083); SL-009 surfaces it as `refused {reason}`, not as "a conversation may have been created" (SL-009 design §7 pairing row).
2. Split of the `thread` hook into optional `require` / `startedBy` (SL-009 design §8) applies to `topicInit`'s last parameter, not `toolsetInit`'s; `writeCreated` returns the topic record after SL-010.
3. (M-16) The `src/connection-reply.ts` extraction moves `answer` with its reply union including SL-010's `ModelsMessage`, and keeps `Connection.modelRefs`.
4. (M-17) `test/bridge-fixture.ts` supplies a `ModelCatalog` stub (literal object) to `conversations(…)` and `topicInit` (inference from SL-010 §4 signature).
5. (M-18) Decide whether `<project>-bridge` topics may carry a model. After SL-010 they appear in `malebolge-set-topic-model`'s completion (they match the topic name rule); either intended, or a stated non-goal.
6. (M-19) `pair`'s implicit `setTopic({name, toolset:"bridge"})` contradicts "no frame ever creates a topic implicitly" (`src/conversations.ts:11`, DEC-016). Pre-existing in SL-009; now load-bearing because a topic record decides a model. Needs an explicit DEC-016 amendment or a different shape.
