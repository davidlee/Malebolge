# Scrubbed mail fixtures (SL-005 PHASE-05 EN-2)

Source: real screwtape v1 output captured 2026-10-28; screwtape repo HEAD
`e61d01b`. Tooling (outside the repo, private): `scrub.mjs`, `check.mjs`,
`verify.mjs`, `map.json`, `extra-terms.txt`, `redact-ids.txt` in
`~/.local/state/malebolge-sl005-raw/`.

## What was captured

| file | command |
|---|---|
| `mailboxes.json` | `screwtape mailboxes` |
| `list-20.json` | `screwtape list --limit 20 --from github.com` |
| `read-<id>.json` | `screwtape read <id> --max-bytes 16384` |
| `thread-Ar3hVBQKNIKV.json` | `screwtape thread Ar3hVBQKNIKV` |
| `read-after-1.json` | `screwtape read --after "" --from github.com --limit 5 --max-bytes 16384` |
| `read-after-2.json` | the same with `--after "$(cat read-after-2.cursor)"` |

Reads: `StlqDajM7cCB` (GitHub notification, in the thread), `StlqOgGOxrms`,
`StlqC78lBvpV`, `StlqOs9L-c6V` (newsletters), `StmEQpYNhvr3` (vendor receipt,
2 attachments), `Stm7N6wH5vLs` (`output_truncated: true`). The thread has 21
entries, 19 of them without sender or subject (not in the local store).

The list and `--after` pages are filtered by sender to keep personal mail
out.

## Replacements (consistent across all files; same real value, same fake)

| category | how | occurrences |
|---|---|---|
| email addresses | `<alnum>@example.com`, local part same length | 95 (45 distinct) |
| Message-Id / In-Reply-To / References | same mapper as emails | 28 |
| URLs | `https://example.com/<alnum filler>`, same length | 198 (149 distinct) |
| personal names and private terms | same-length fake per word, case shape kept | 78 |
| `@handles` | same-length fake | 41 (11 distinct) |
| phone, meeting, passcode, 9+ digit numbers | class-preserving scramble | 77 |
| `provenance.account_id` | class-preserving scramble | 16 |
| attachment filenames with digits | class-preserving scramble | 4 |

Kept unchanged: JMAP ids (message, thread, mailbox, blob, part), cursors,
`email_state`, dates, sizes, flags, keywords, `output_truncated` /
`is_truncated` / `truncated_by`, mailbox names, brand and newsletter display
names, public newsletter author names, JSON key order. Every `subject`,
`preview` and `bodies[].text` keeps its UTF-8 byte length.

## Leftover check

- No real value from `map.json` appears in any output file. Two digit runs
  inside fake message ids match stale `map.json` keys from an earlier capture;
  neither occurs in any raw input.
- No `@` address outside `example.com`; no `http(s)` URL outside `example.com`.
- The operator's name and domains: none. `lee` hits only inside `Westlee`
  (a newsletter author list) and `fleet`.
- Byte lengths against raw: 92 strings checked, 0 mismatches; every output
  parses (JSON / JSONL).
