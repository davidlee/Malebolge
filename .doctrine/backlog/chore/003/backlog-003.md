# CHR-003: Revise RFC-001 against the current tree

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

RFC-001 (2026-10-19) predates SL-002 and satan SL-030, and the tree has moved.
A read-only architectural review (Codex gpt-6.1-sol, 2026-10-24, during SL-003
planning) found its extraction advice largely implemented, its "contract by
convention only" claim obsolete, and new structural pressure inside the root
tier: the structure test does not distinguish client from daemon modules, or
wire contracts from persistence. SL-003's amendment (topicNameOf in
src/protocol.ts) is one instance of that pressure.

Done when RFC-001 states the implemented boundary instead of prospective
extraction steps, retires resolved symptoms and census numbers, and extends
its boundary analysis to client contracts versus daemon persistence.

Review findings, verbatim (evidence, not instruction; links relative to the
repo root, as of commit 53c9cdd):

RFC-001’s refresh belongs in a **follow-up RFC revision**:

- **VERIFIED — follow-up: much of the extraction advice is implemented.** Connection facts, observation and injected error policy live in [room/connection.ts:34](src/room/connection.ts:34); the reader is separated from admission through its failure callback in [room/source-reader.ts:137](src/room/source-reader.ts:137). Transfer remains behind `GitChannel` in [runner/door.ts:38](src/runner/door.ts:38). The daemon supplies its own policy in [daemon-env.ts:54](src/daemon-env.ts:54). I found no client/profile-policy erosion in the inspected room mechanisms. **Change:** replace prospective extraction instructions and old locations with this implemented boundary; clarify that the shared kernel supplies mechanisms, not one connection shared between programs.

- **VERIFIED — follow-up: the unnamed-root concern survives, but “contract by convention only” is obsolete.** Explicit runner/room allowlists now exist in [structure.test.ts:13](test/structure.test.ts:13). `parseModel` moved to [models.ts:33](src/models.ts:33), and registry construction to [registry.ts:6](src/registry.ts:6). There is still no `lib/` tier. The runner entry exception also survives at [structure.test.ts:69](test/structure.test.ts:69), contrary to the RFC’s prediction that the arrow retires. **Change:** distinguish enforced boundaries from remaining directory ambiguity. Revise “pure leaves”: today’s `models.ts` also loads files and constructs providers ([models.ts:8](src/models.ts:8)).

- **VERIFIED — follow-up: the new pressure is inside root.** The checker permits root-to-root imports ([structure.test.ts:66](test/structure.test.ts:66)); it distinguishes neither client from daemon nor contracts from persistence. SL-002 and conversations have added service/query responsibilities ([conversations.ts:26](src/conversations.ts:26)), while SL-003 adds management commands. The RFC’s old grep symptom is also obsolete: underlying errors are preserved at [grep.ts:363](src/grep.ts:363). **Change:** extend RFC-001’s boundary analysis to client contracts versus daemon persistence, and retire resolved symptoms and census numbers.

