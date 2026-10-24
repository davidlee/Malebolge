# IMP-007: attach-main exits before a piped stdout drains, so a long --list can be cut

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

## Context

Found while building `--list` (SL-002 PHASE-02/04); measured and recorded as
`mem.fact.malebolge.attach-exit-truncates-piped-stdout`.

`src/attach-main.ts` finishes by calling `process.exit(0)` immediately after an
awaited write. Writes to a **pipe** are asynchronous in Node, so exit can win
the race and the listing's tail is never delivered. A terminal is a TTY and
drains synchronously, which is why `just attach` and hand-run listings look
fine; the pipe case is exactly the two consumers the flag exists for — a script
piping `malebolge-attach --list`, and the Emacs picker, which reads the
subprocess through a pipe.

The page is bounded (`LIST_PAGE` = 50, so at most ~200 bytes of ids), which is
why nothing has been observed truncating yet. The defect is latent, not
theoretical: the size that breaks it is the size a bigger page would have.

## Direction (not a plan)

- Set `process.exitCode` and let the loop drain, rather than `process.exit`.
  Both the attach and the listing paths end in the same place, so it is one
  change, not two.
- Prove it with a listing large enough to exceed the pipe buffer (or by
  shrinking the buffer in the test), asserting the full id set arrives —
  `test/attach.test.ts` and the Emacs ERT case already capture numeric stdout,
  so the fixture is close to hand.
- Sibling of IMP-006: that one bounds the reply's wait, this one drains the
  reply. Both are the client's terminal path treated as if it were a data path;
  they plausibly land as one commit in `src/attach-main.ts` / `src/attach.ts`.

## What not to do

Do not paper over it in the docs. SL-002 PHASE-04 deliberately describes the
contract (`--list` prints ids and exits 0) rather than disclosing a bug the code
should not have.
