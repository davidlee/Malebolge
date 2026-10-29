# ISS-003: Post envelopes interpolate intent, context and topic unescaped

`contentOf` (`src/threads/task.ts:99-117`) builds `<post>`, `<post-failed>`
and `<family-reaped>` by string interpolation. `intent`, `context`, `topic`
and `reason` are not passed through `escapeXml` (`src/xml.ts:3`), which
`skills.ts` and `project-context.ts` already use. A post whose intent contains
`</intent>` or `</post>` can forge envelope structure the recipient reads.

Found in SL-009 research (2026-10-29, `research.md` Thread 2 fact 6). The
bridge's own envelope must escape; this item fixes the existing ones.
