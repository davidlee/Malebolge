# Mail fixtures: provenance

Both directories hold screwtape v1 envelopes (`{"version":1,"kind":...,"data":...}`),
one per line. Screwtape is the mail store whose read verbs the mail tools wrap.

| directory | what | origin |
|---|---|---|
| `real/` | scrubbed real output of the read verbs | captured from screwtape at commit `e61d01b`; see `real/SCRUB.md`. Committed as is: never edit, rename or reformat |
| `contract/` | one envelope per verb, every field in contract print order, `null` where a value is absent | transcribed by hand from screwtape `README.md` § Contract at commit `e61d01b` |

`contract/` files:

| file | covers |
|---|---|
| `mailboxes.json` | `mailboxes`, with a parent and a null role |
| `list-offset.json` | `list` printed without `--after` (`offset`) |
| `list-after.json` | `list` printed with `--after` (`after`) |
| `read.json` | `read`: two bodies (one html-converted, truncated by `server`), one attachment, every optional list |
| `thread.json` | `thread`: in-store and `in_store: false` items, `truncated: true` |
| `read-after-2-lines.jsonl` | `read --after`: two `read` envelopes, oldest first |
| `read-after-empty.jsonl` | `read --after` with no matches: empty stdout |

Values are invented (no real mail). The tests in `test/mail/` that load these
files go through `loadEnvelopes` in `test/mail/mail-fixtures.ts`.
