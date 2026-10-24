Observed in SL-003's reconcile, 2026-10-24, in ~/dev/malebolge.

`doctrine knowledge edit DEC-007 --body @/path/amend.md --body-mode append`
appended the literal text `@/path/amend.md` to the decision body and exited 0.
The flag's help says only "`-` reads stdin". Unlike `review raise --detail`, it
does not support `@path` file reads.

- Pipe the prose instead: `cat amend.md | doctrine knowledge edit DEC-N --body - --body-mode append`.
- Repair a bad append by rebuilding the body as the HEAD body plus the amendment,
  then `--body - --body-mode replace`.
- Check the result with `git diff` on `record-NNN.md`, because exit 0 proves
  nothing here.

Related: [[mem.pattern.doctrine.decision-is-not-a-revision-target]].
