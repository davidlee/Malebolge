pi-durable documents are plain JSON objects with `Object.prototype`. A map keyed
by a user-supplied name (the index's `topics`) answers `index.topics.constructor`
with `Object` even when nobody wrote it: `=== undefined` existence checks pass,
`?? {}` spreads a function, and pi-durable then refuses the write
(`Value contains a non-JSON function`). Topic names match
`[a-z0-9][a-z0-9._-]{0,63}`, which admits exactly one inherited key,
`constructor`; other `Object.prototype` keys contain uppercase or start with `_`.

Read such maps through an own-key helper (`storedTopic` in `src/topics.ts`,
`Object.hasOwn`). Found at RV-010 F-1; regression test in
`test/conversations.test.ts` runs every topic path with `constructor`.
