`test/topics.test.ts` "keeps IndexDocument to src/topics.ts" read
`readdirSync(src)` without `recursive`, so it never saw `src/threads/` or
`src/wake/`; `src/threads/admission.ts` named `IndexDocument` and the guard
still passed (RV-018 F-12). Fixed with
`readdirSync(dir, { recursive: true, encoding: "utf8" })`.

How to apply: any guard that greps the source tree for a name or import
reads it recursively, and is checked red against a planted violation in a
subdirectory. `test/structure.test.ts` already walks recursively.
