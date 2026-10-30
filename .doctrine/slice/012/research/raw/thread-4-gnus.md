## Thread 4 — Gnus execution mechanics

### Cited facts

**1. Locating an article by Message-ID.**

- `nnimap-find-article-by-message-id (group server message-id &optional limit)` — `stage/gnus/nnimap.el:1154`. Issues `UID SEARCH HEADER Message-Id %S` (`nnimap.el:1170`) and returns a *single integer* (the article number = IMAP UID), or nil; the group is not returned, it is the argument. It selects the group `read-only` (EXAMINE) via `(nnimap-change-group group server nil t)` (`nnimap.el:1159`, signature/doc `nnimap.el:1914-1921`), so the lookup itself changes no flags. With `limit` it searches only the last N and retries un-limited (`nnimap.el:1174-1183`); `limit` is normally `nnimap-request-articles-find-limit` (`nnimap.el:150`).
- Backend-agnostic path: `gnus-request-article (article group &optional buffer)` whose docstring says "ARTICLE can either be an article number or an article Message-ID" (`stage/gnus/gnus-int.el:592-599`); `gnus-request-head (article group)` likewise passes the string through (`gnus-int.el:671-691`).
- `nnimap-request-head (article &optional group server to-buffer)` and `nnimap-request-article (article &optional group server to-buffer)` both accept a string and resolve it with `nnimap-find-article-by-message-id` (`stage/gnus/nnimap.el:735-738`, `nnimap.el:704-710`). Both return `(GROUP . ARTICLE-NUMBER)` — i.e. the group and the number — or nil (`nnimap.el:748`, `nnimap.el:729`). So: **yes, string-in, (group . number)-out.**
- Gnus's own convenience wrapper that opens a summary around one Message-ID: `gnus-select-group-with-message-id (group message-id)` → "Activate and select GROUP with the given MESSAGE-ID selected. Returns the article number" (`gnus-int.el:608-648`). It *creates a summary buffer* and calls `gnus-summary-select-article` (`gnus-int.el:642`), which runs `gnus-mark-article-hook` → marks read.
- `gnus-registry`: keyed by Message-ID, `(gnus-registry-get-id-key id key)` (`stage/gnus/gnus-registry.el:1108`) with keys `'group`, `'marks` etc.; `gnus-registry-fetch-message-id-fast` goes the other way, article→id, and needs summary data (`gnus-registry.el:870`). But `gnus-registry-install` defaults to `'ask` (`gnus-registry.el:155`), and `dl-gnus.el` never mentions the registry, so its coverage is an assumption, not a lookup source. Not a reliable locator here.

**2. Fetching headers without changing marks.**

- `gnus-request-head` ends with `nntp-server-buffer` holding the header block, trailing blank line + body stripped (`gnus-int.el:696-701`); it returns `(group . number)`.
- nnimap fetches headers with `BODY.PEEK[HEADER.FIELDS (...Subject From Date Message-Id ...)]` (`nnimap.el:215-231`) and full articles with `BODY.PEEK[]` / `RFC822.PEEK` (`nnimap.el:761-762`, `775-776`, `806-813`). `PEEK` means the server does **not** set `\Seen` (`nnimap-mark-alist` maps `read "\\Seen"`, `nnimap.el:183`). So a header fetch mutates nothing, server-side.
- Local read marks are set only by summary/article display: `gnus-mark-article-hook` (default `gnus-summary-mark-read-and-unread-as-read`, `gnus-sum.el:1090`) is run by article preparation (`stage/gnus/gnus-art.el:4762`) and by summary selection (`gnus-sum.el:12587`). `gnus-request-head` runs neither. Note that Gnus itself suppresses marking in exactly this way: `gnus-summary-move-article` binds `gnus-mark-article-hook` to nil around its consultative `gnus-summary-select-article` (`gnus-sum.el:10060-10063`).
- For rendering your own review buffer, `gnus-request-article-this-buffer (article group)` erases the current buffer and inserts the article, accepting a Message-ID string (`gnus-art.el:7137-7154`) — but it pulls the whole body, so `gnus-request-head` + `nnheader-narrow-to-headers` is lighter.

**3. Read/tick marks by number, no summary.**

- `gnus-request-set-mark (group action)` — `gnus-int.el:571-580`; it looks up the method for GROUP, checks `request-set-mark` is supported and calls it with `(gnus-group-real-name group) action server`. Returns ACTION when unsupported.
- `nnimap-request-set-mark (group actions &optional server)` — `nnimap.el:1243-1270`. Each element is destructured as `(range action marks)` (`nnimap.el:1251`), and emits `UID STORE %s %sFLAGS.SILENT (...)`, where action ∈ `add` / `del` / `set` → `+`/`-`/`` (`nnimap.el:1255-1264`), so the format is `((RANGE ACTION MARKS))` with ACTION a symbol among `add del set`. Marks are Gnus mark symbols mapped by `nnimap-marks-to-flags` (`nnimap.el:1226-1232`, table `nnimap.el:182-191`): `read`, `tick`, `reply`, `expire` (local only, no flag). Adding `tick` also pushes `read` (`nnimap.el:1253-1257`) — ticked implies read. RANGE accepts an integer, a cons `(lo . hi)`, or a list of those (`nnimap.el:360-374`).
- Local group info: `nnimap-request-set-mark` only talks to IMAP; it does **not** touch `gnus-info`. Gnus's own no-summary paths update both: `gnus-group-make-articles-read (group articles)` sets `(gnus-info-read info)` then `gnus-request-set-mark ... '(read)` then `gnus-group-update-group group t` (`gnus-sum.el:6318-6378`); `gnus-group-catchup` clears tick/dormant via `gnus-request-set-mark` plus `gnus-add-marked-articles ... 'force` (`stage/gnus/gnus-group.el:3685-3700`); `gnus-info-clear-data` pairs `gnus-request-set-mark` with `gnus-info-set-marks` and `setf gnus-info-read` (`gnus-group.el:3600-3616`). So **yes** — update `gnus-info` yourself (via `gnus-info-set-marks`/`setf (gnus-info-read ...)`, `gnus-add-marked-articles`, `gnus-group-update-group`), or the group buffer's unread counts lie until the next server resync (`nnimap-flags-to-marks`/`nnimap-update-infos`, `nnimap.el:1559-1562`, `1590-1596`).

**4. Moving without a summary.**

- `gnus-request-move-article (article group _server accept-function &optional last move-is-internal)` — `gnus-int.el:825-836`. `_server` is ignored; the method comes from GROUP.
- `nnimap-request-move-article (article group server accept-form &optional _last internal-move-group)` — `nnimap.el:1019-1053`. If `internal-move-group` is non-nil it uses `UID MOVE`/`UID COPY` + delete on the same server and returns `(target-group . new-uid)` (`nnimap.el:1030-1052`); otherwise it calls `accept-form` and deletes the source copy (`nnimap.el:1050-1053`).
- The accept-form Gnus builds is `(list 'gnus-request-accept-article to-newsgroup (list 'quote select-method) (not articles) t)` (`gnus-sum.el:10098-10104`); the internal-move-group argument is `(gnus-group-real-name to-newsgroup)` when both groups share a method (`gnus-sum.el:10101-10106`). `nnimap-request-accept-article` returns `(group . uid)` using APPENDUID or a Message-ID search (`nnimap.el:1308-1320`).
- Simpler supported path: `gnus-fetch-group (group &optional articles)` — "Start Gnus if necessary and enter GROUP. If ARTICLES, display those articles" (`gnus-group.el:2139-2148`), delegating to `gnus-group-read-group (&optional all no-article group select-articles)` (`gnus-group.el:1977-2013`). Then process-mark and call `gnus-summary-move-article (&optional n to-newsgroup select-method action)` with `to-newsgroup` = `"nnimap+fastmail:Archive"` (`gnus-sum.el:10002-10031`); marks can be set programmatically with `gnus-summary-set-process-mark (article)` (`gnus-sum.el:11032-11040`).
- Recommendation: **open a real summary limited to the batch's article numbers, process-mark, then `gnus-summary-move-article`.** This is the only path that also does the destination bookkeeping (`gnus-info-read` on the target, mark copying, `gnus-group-set-info` dribble, re-activation of touched groups — `gnus-sum.el:10210-10280`, `10290-10305`). Hand-rolling `gnus-request-move-article` leaves the destination group's info stale (inference: it would then be resynced from IMAP flags on the next group scan).

**5. Delete semantics.**

- Expiry (Gnus's "delete"): marks by `expire`, honours `nnmail-expiry-wait`, and honours the group parameter `expiry-target` (`gnus-sum.el:10492-10494`, `stage/gnus/gnus-group.el:3737-3739`; `nnmail.el:189-219`).
- `gnus-summary-delete-article (&optional n)` — "The article will disappear forever from your life, never to return" (`gnus-sum.el:10547-10551`): it binds `nnmail-expiry-target` to `'delete` and calls `gnus-request-expire-articles ... 'force` (`gnus-sum.el:10567-10581`).
- `nnimap-request-expire-articles (articles group &optional server force)` with force + `nnmail-expiry-target` `'delete` → `nnimap-delete-article` (`nnimap.el:1057-1083`), which `UID STORE +FLAGS.SILENT (\Deleted)` then expunges according to `nnimap-expunge` (`nnimap.el:1186-1210`). `nnimap-expunge` defaults to `'on-exit`; `'never` leaves the flag unexpunged (`nnimap.el:102-115`). Expunge = gone; only Fastmail's own retention/backup could recover it (inference).
- Recoverable delete: set `nnmail-expiry-target` to a real group. `nnimap-process-expiry-targets` shortcuts to `UID MOVE`/`UID COPY` + delete when the target is on the same server (`nnimap.el:1094-1112`); otherwise it copies via `nnmail-expiry-target-group` (`nnimap.el:1115-1128`). So "delete = move to `nnimap+fastmail:Trash`" (or Archive) is a plain COPY/MOVE, fully recoverable; `gnus-summary-move-article` to Trash is the same thing without expiry bookkeeping.

**6. dl-gnus.el facts.** Server name `"fastmail"`, method `(nnimap "fastmail" (nnimap-address "imap.fastmail.com") (nnimap-stream ssl) (nnimap-user dl-gnus-login))` (`emacs-config/dl-gnus.el:53-57`); group names are `nnimap+fastmail:<Mailbox>`; `dl-gnus-archive-group` = `"nnimap+fastmail:Archive"` (`dl-gnus.el:28-29`); Sent = `"nnimap+fastmail:Sent"` (`dl-gnus.el:78`); login constant `dl-gnus-login` (`dl-gnus.el:23`). Prefix conventions: exported `dl-gnus-…`, private `dl-gnus--…` (e.g. `dl-gnus--frugal` `dl-gnus.el:39`, `dl-gnus--yield-meow-keys` `dl-gnus.el:88`); commands in this file use the `my/` prefix (`my/gnus-summary-archive`, `dl-gnus.el:83-87`) which wraps `gnus-summary-move-article` with the archive constant and `(interactive "P" gnus-summary-mode)`. Tests: ERT, one behaviour per `ert-deftest`, names `dl-gnus/<kebab-case>`, assertions over config values and over stubbed collaborators via `cl-letf` on the symbol-function (`emacs-config/dl-gnus-test.el:14-21`, `23-26`, `65-68`); test files live in `lisp/test` and run via `just check` (`dl-gnus-test.el:3`).

**7. Must Gnus be running?** `gnus-alive-p` only checks that buffer `gnus-group-buffer` exists and is in `gnus-group-mode` (`stage/gnus/gnus-util.el:937-942`). Gnus's own entry points start it if not: `gnus-fetch-group` calls `(gnus-no-server)` first (`gnus-group.el:2146-2147`). Caveats: (a) backend calls mostly work without the group buffer — `nnimap-change-group` opens the server on demand if `nnimap-server-opened` is false (`nnimap.el:1922-1925`), which can prompt for a password if auth-source has no match (`dl-gnus.el:1-18` documents the keyring entries and the port-matching requirement); (b) but the bookkeeping helpers do `with-current-buffer gnus-group-buffer` unconditionally — `gnus-group-update-group` (`gnus-group.el:1629-1647`), `gnus-summary-move-article`'s tail (`gnus-sum.el:10298-10303`), `gnus-group-make-articles-read`'s undo registration (`gnus-sum.el:6338-6348`) — and `gnus-dribble-enter` needs the dribble state; (c) `gnus-get-info`/`gnus-newsrc-alist`/`gnus-active-hashtb` are only populated after Gnus reads `.newsrc.eld` (`gnus-start.el:973-980`), so from a cold Emacs every group looks unknown and mark/unread bookkeeping silently no-ops (inference).
So: start Gnus (or at least `gnus-no-server`) before executing a batch, and expect that the batch's effects only become visible in the operator's group buffer after `gnus-group-get-new-news`.

### Recommended mechanism

```
;; once, at batch execution time
(unless (gnus-alive-p) (gnus-no-server))            ; gnus-util.el:937, gnus-group.el:2146

;; 1. lookup: Message-ID -> (group . uid)
(let ((res (gnus-request-head mid "nnimap+fastmail:INBOX")))  ; gnus-int.el:671, nnimap.el:735
  (setq num (cdr res))                              ; nil => not in that group

;; 2. header display for the review buffer — no marks touched
(with-current-buffer nntp-server-buffer              ; filled by gnus-request-head
  (nnheader-narrow-to-headers)
  (list (message-fetch-field "from") (message-fetch-field "subject")
        (message-fetch-field "date")))

;; 3. marks, by uid — backend + local info, both
(gnus-request-set-mark grp '(((num) add (read))))    ; gnus-int.el:571, nnimap.el:1243
(gnus-request-set-mark grp '(((num) del (read))))    ; unread
(gnus-request-set-mark grp '(((num) add (tick))))    ; flag (tick implies read, nnimap.el:1253)
(gnus-request-set-mark grp '(((num) del (tick))))    ; unflag
;; then refresh local view (gnus-sum.el:6318-6378 pattern)
(gnus-group-update-group grp t)                       ; gnus-group.el:1629

;; 4. move/archive — open a summary already limited to these uids
(gnus-fetch-group grp (list num1 num2))               ; gnus-group.el:2139-2148
(with-current-buffer (gnus-summary-buffer-name grp)
  (dolist (n (list num1 num2)) (gnus-summary-set-process-mark n))  ; gnus-sum.el:11032
  (gnus-summary-move-article nil "nnimap+fastmail:Archive"))       ; gnus-sum.el:10002

;; 5. delete, recoverable: same call with the Trash group
(gnus-summary-move-article nil "nnimap+fastmail:Trash")
;; delete, unrecoverable (only if the slice chooses it):
(let ((nnmail-expiry-target 'delete))                 ; gnus-sum.el:10567
  (gnus-request-expire-articles (list num) grp 'force))  ; gnus-int.el:806, nnimap.el:1057
```

An alternative for step 4, avoiding a summary buffer entirely, is `gnus-request-move-article` with the internal-move-group argument `"Archive"` (`gnus-int.el:825`, `nnimap.el:1019`), which funnels to `UID MOVE`/`UID COPY` + delete and returns the new uid — cheap, but it performs none of the destination bookkeeping Gnus does at `gnus-sum.el:10210-10280`, so the operator's next group buffer entry must resync from IMAP to see the truth (inference). Not recommended as the primary path.

### Risks

- **Two identities per line.** A plan line may name a Message-ID that exists more than once (same message filed in INBOX and Archive, or duplicate deliveries). `nnimap-find-article-by-message-id` returns `(car (last ...))` of the SEARCH response (`nnimap.el:1178-1182`) — one arbitrary UID, silently. Resolve per (Message-ID, group) and refuse/annotate when a group yields several UIDs (inference from `nnimap.el:1174-1183`).
- **Message moved since the plan was made.** UIDs are stable per mailbox, but a move changes the mailbox (and UID); a stale plan's group/UID points at nothing (`nnimap-request-head` returns nil → `gnus-request-move-article` returns nil → "Couldn't move article" `gnus-sum.el:10159-10162`). Re-resolve every line by Message-ID at execution time, and log the miss rather than aborting the batch.
- **Stale local group info.** `nnimap-request-set-mark` never touches `gnus-info` (`nnimap.el:1243-1270`); a batch that skips the info update leaves unread counts and tick lists wrong in the group buffer until the next `nnimap-flags-to-marks` resync (`nnimap.el:1559-1562`). Worse, an open summary buffer for that group will later push its own stale deltas on exit (`gnus-update-marks`, `gnus-sum.el:6073-6140`), potentially undoing the batch on the server.
- **Accidental read-marking via summarisation.** Anything that routes through article display (`gnus-select-group-with-message-id` `gnus-int.el:642`, `gnus-fetch-group` with auto-select, `gnus-article-prepare` `gnus-art.el:4762`) marks read unless `gnus-mark-article-hook` is bound to nil as `gnus-summary-move-article` does (`gnus-sum.el:10060-10063`). A "move" batch must not leave the operator's review having also marked things read by accident.
- **Expunge after delete.** With `nnimap-expunge` left at `'on-exit` (`nnimap.el:102`), the `\Deleted` flag is applied immediately but expunged only at group close — mail lingers in the mailbox, still visible to other clients, and a subsequent `gnus-summary-expire-articles-now` (`gnus-sum.el:10535`) can purge far more than the batch marked. Prefer Trash-move; if expunging, scope it with `UID EXPUNGE` (UIDPLUS) which nnimap uses when available (`nnimap.el:1204-1210`).
- **Server open prompted mid-batch.** First backend call may block on an auth-source password prompt, and `gnus-open-server` remembers `denied` (`gnus-int.el:276-280`), so a single mistyped/aborted prompt can poison later lines in the batch (inference).
- **Partial execution.** No transaction: if line 7 of 12 fails, lines 1-6 are already applied server-side. The per-message log record must therefore be appended as each result lands, not once at batch end.
