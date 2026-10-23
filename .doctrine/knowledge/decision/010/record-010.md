## Context

SL-030 allowed a listing only as bare ids, and RFC-002 D4 puts readable labels at
step 4, after the index (step 2) and per-conversation project context (step 3).
So the interim really is numbers: no titles exist to show, IDE-017's intent
entries do not exist yet, and an excerpt-of-the-first-message label derived here
would be a subset of D4 that step 4 then reworks. The question is whether that is
usable enough to ship, and what it obliges this slice to get right.

## Choice

Bare ids are enough for this step, on three conditions this slice meets:

1. **The human path never requires typing one.** Emacs prompts with a picker over
   ids; `--list` is for the terminal and for scripts. Nobody has to remember a
   number to reach a conversation.
2. **The order is the useful one.** Newest first, so the id a returning user
   wants is at the top rather than beyond a page boundary.
3. **Attaching is cheap to undo.** A wrong guess is corrected by `C-c C-q` and a
   re-attach; the daemon keeps the conversation, and the snapshot on attach shows
   immediately which one it is. The transcript also states it
   (`attached to conversation N`).

What the slice owes the reader, and what it refuses:

- **Owes:** docs that say ids are per profile and per store (`README.md`,
  `docs/internals.md`); the one-page limit stated plainly, with "older
  conversations stay attachable by id"; and the `list` row in the protocol table.
- **Refuses:** label derivation (D4's, step 4's); `--here`/attach-by-directory
  (under the `room` profile a conversation's `cwd` is a room path and a shell's is
  a host path, so the lookup would silently miss — RFC-002 D1 puts it in the
  topics work); fuzzy or prefix matching of ids (an id is an identity, not a
  query); and any paging.

## Alternatives

- Ship labels now by deriving an excerpt of the first user message — repeats D4
  ahead of the index it reads from, and cannot implement D4's first two sources.
- Bring topics forward so ids never surface — that is RFC-002 step 2, a much
  larger slice whose policy (D1, D3, D7) is still under the user's review.

## Rationale

The step exists to unblock reaching a conversation at all. Recency plus a picker
plus a cheap undo is enough for that, and each of D4's sources arrives in its own
step without being pre-empted here.

## Consequences

- The interim is knowingly number-facing for terminal users; RFC-002 step 4 is the
  remedy and is scheduled.
- This slice must not grow a partial label implementation, a directory resolver,
  or a pager. A future reader should find the refusal recorded here, not an
  oversight.
