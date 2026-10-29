Observed 2026-10-29 (SL-008 research, Firefox with places user_version 87):

- Profile: `~/.config/mozilla/firefox/<id>.default/` — moved under
  XDG_CONFIG_HOME by a recent Home Manager update, not `~/.mozilla`.
- **Tags** are folders under the root GUID `tags________` in `places.sqlite`;
  each tag entry's `fk` points at `moz_places`. The WebExtension `bookmarks`
  API exposes no tags, so it can neither read nor write them.
- **Live `places.sqlite` is exclusively locked** while Firefox runs: a read-only
  open fails `database is locked`. `?immutable=1` opens but ignores the WAL.
  Copy `places.sqlite` + `-wal` and open the copy instead.
- **`bookmarkbackups/bookmarks-YYYY-MM-DD_<count>_<hash>.jsonlz4`** is written
  daily: `mozLz40\0` magic, u32 LE decompressed size, one raw LZ4 block (a
  ~20-line decoder works). JSON tree; place nodes carry `tags` as a
  comma-joined string.
- No `sqlite3` binary on this host; Node 24's `node:sqlite` works.
- The profile dir also holds history, `logins.json`, `key4.db`: never bind it
  whole into a jail.

How to apply: for bookmark reads use the backup (DEC-052). For tag writes
(IDE-008 step 2) neither the extension nor a live DB write works.
