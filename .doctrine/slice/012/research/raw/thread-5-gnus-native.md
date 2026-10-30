## Thread 5 — Gnus-native path

### Cited facts

**1. nnselect ephemeral groups — entry points and spec shape.**
- `gnus-group-read-ephemeral-group (group method &optional activate quit-config request-only select-articles parameters number)` — `stage/gnus/gnus-group.el:2186-2194`. PARAMETERS is spliced into the ephemeral group's parameters (`gnus-group.el:2225-2240`), the method is rewritten to a unique server (`gnus-group.el:2213-2227`), and it finishes with `(gnus-group-read-group (or number t) t group select-articles)` (`gnus-group.el:2263`) — i.e. *all* articles, and `no-article` = t.
- The canonical spec, verbatim from Gnus's own code (`nnselect-search-thread`, `nnselect.el:875-916`) is:
  `((nnselect-specs (nnselect-function . gnus-search-run-query) (nnselect-args (search-query-spec …) (search-group-spec …))) (nnselect-artlist . nil))` (`nnselect.el:905-914`).
- Contract for a custom function: it is applied to `nnselect-args` and must return a **vector of `[real-prefixed-group article-number score]`** (`nnselect.el:26-40`); consumed by `nnselect-generate-artlist` (`nnselect.el:316-355`), which also stores the artlist and updates info. So `(nnselect-function . my/plan-select)` + `(nnselect-args . <my data>)` is exactly the supported extension point — "or the function can be the identity and the args a vector of articles" (`nnselect.el:39-41`).
- Search-flavoured entry points: `gnus-group-read-ephemeral-search-group (no-parse &optional specs)` — SPECS "must be an alist with `search-query-spec` and `search-group-spec` keys, and skips all prompting" (`gnus-group.el:3199-3207`, body `gnus-group.el:3228-3245`); `gnus-group-make-search-group` is the same query but a *persistent* group (`gnus-group.el:3141-3192`); `gnus-summary-make-search-group` from a summary (`nnselect.el:1057-1068`). All of them end in the same `nnselect-specs` alist.
- Precomputed artlist is also accepted as a group parameter: `nnselect-request-create-group` stores `(nnselect-artlist . ART)` when given (`nnselect.el:802-822`), and `nnselect-retrieve-headers` prefers `(nnselect-get-artlist group)` over regenerating (`nnselect.el:399-407`); `nnselect-get-artlist` passes vectors through unchanged (`nnselect.el:105-107`, `283-296`). (Supplying artlist *and* an `active` parameter to avoid a regenerate call is inference, `nnselect.el:376-380`.)

**2. gnus-search + IMAP: Message-ID queries.**
- `message-id` is an expandable key (`gnus-search.el:389-393`) and is normalised to `id` by the key:value parser (`gnus-search.el:588-589`); `id` is transformed for IMAP to `HEADER Message-ID "<value>"` (`gnus-search.el:1296-1297`). Unknown keys also degrade to `HEADER <key> <value>` (`gnus-search.el:1301-1304`).
- OR is supported by the query language (`gnus-search-parse-query` docstring `gnus-search.el:424-470`) and becomes `(OR a b)` for IMAP (`gnus-search.el:1191-1202`), so `message-id:<a> or message-id:<b> or …` parses and translates. Multiple ids disable the single-message shortcut (`gnus-search-single-p`, `gnus-search.el:999-1009`; loop condition `gnus-search.el:1105-1126`).
- Search spanning a whole server: `search-group-spec` elements are `(SERVER . GROUPS)`; `groups` nil means `(gnus-search-get-active srv)`, all active groups of that server (`gnus-search.el:1100-1104`, `2260-2290`). SERVER is a server *name* string passed to `gnus-server-to-method` — `nnselect-search-thread` builds it with `(gnus-method-to-server (gnus-find-method-for-group …))` (`nnselect.el:897-899`), i.e. `"fastmail"`.
- Results come back as `[group uid 100]` triples built straight from the IMAP `SEARCH` response (`gnus-search.el:1131-1145`) — the same shape nnselect wants.
- Query prep/parse: `gnus-search-prepare-query` (`gnus-search.el:2104-2128`), including meta-keys `thread|grep|limit|raw` and a `raw` escape from parsing (`gnus-search.el:2117-2120`); `gnus-search-run-query` is the single public entry (`gnus-search.el:2063-2101`).

**3. Standard summary commands inside nnselect, and write-back.**
- Marks: `nnselect-request-set-mark` re-categorises each `(range action marks)` by originating group and calls the real `gnus-request-set-mark` per group (`nnselect.el:602-616`); `gnus-request-set-mark` also runs `gnus-after-set-mark-hook` with `(group action)` (`gnus-int.el:571-580`). `nnselect-request-update-mark` passes mark adjustment through to the real group, including auto-expirable handling (`nnselect.el:590-600`). So read/unread/tick/unflag set on the nnselect summary reach `nnimap` groups through the normal path.
- Move: `nnselect-request-move-article` ignores the caller's internal-move argument, recomputes it, binds `nnimap-expunge 'immediately`, and calls `gnus-request-move-article` on the *real* group/number with the internal move group, i.e. `UID MOVE` (`nnselect.el:504-526`; cf. `nnimap.el:1019-1053`). `gnus-summary-move-article`'s destination bookkeeping (target info, mark copying, dribble, re-activating the target group) runs regardless of backend (`gnus-sum.el:10200-10305`).
- Delete: `gnus-summary-delete-article` passes `force` (`gnus-sum.el:10566-10581`) and `gnus-request-expire-articles` has signature `(articles group &optional force)` (`gnus-int.el:806-817`), so `nnselect-request-expire-articles` proceeds per real group (`nnselect.el:542-563`); its ephemeral-refusal branch only fires when FORCE is nil (`nnselect.el:545-548`, `nnselect-allow-ephemeral-expiry` `nnselect.el:259-262`). It binds `nnimap-expunge 'immediately` (`nnselect.el:544`) — irreversible.
- Exiting writes marks back: `nnselect-close-group` calls `nnselect-push-info` unless exiting without update (`nnselect.el:790-800`); `nnselect-push-info` computes per-real-group add/del deltas, calls `gnus-request-set-mark` on each real group, then `gnus-info-set-marks` + `gnus-update-read-articles` + `gnus-get-unread-articles-in-group` + `gnus-group-update-group` (`nnselect.el:918-1052`, notably `1014-1052`). Deltas are computed only when the ephemeral group has a `quit-config`, otherwise `gnus-update-marks` already handled it (`nnselect.el:946-951`).
- Source group of any nnselect article is available in-process: `nnselect-article-group` (`nnselect.el:141-148`), and in the summary line as `%G`/`%g` (`gnus-sum.el:1465-1469`).

**4. The review buffer *is* the summary buffer.**
- Opening via `gnus-group-read-ephemeral-group` passes `no-article` = t (`gnus-group.el:2263`), and `no-article` suppresses auto-selection entirely: `(if (and (not no-article) … gnus-auto-select-first) …)` (`gnus-sum.el:4098-4100`). So `gnus-auto-select-first` (`gnus-sum.el:388-406`) is irrelevant on this path — nothing is selected, nothing is marked read (`gnus-mark-article-hook` fires only on selection, `gnus-sum.el:1090-1095`, `12587`). Precedent: `gnus-pick-mode` does exactly the same, setting `gnus-auto-select-first` nil and swapping `gnus-summary-line-format` (`gnus-salt.el:103-107`).
- Annotation hooks: `gnus-summary-prepare-hook` — "If you want to modify the summary buffer, you can use this hook" (`gnus-sum.el:1020-1024`); `gnus-summary-prepared-hook` "called as the last thing after the summary buffer has been generated" (`gnus-sum.el:1026-1029`), run at `gnus-sum.el:4125`.
- Line format: `%u` is a "user-defined spec" (`gnus-sum.el:814`, `1438-1470`); `%M` is the Message-ID header, `%Z` the nnselect rsv, `%G`/`%g` the originating group (`gnus-sum.el:1452`, `1465-1469`). `%u` followed by a char calls `gnus-user-format-function-<char>` with `gnus-tmp-header` bound (inference: Gnus manual; `gnus-spec.el` is not staged, and `gnus-sum.el:6197` only shows `gnus-tmp-header` is deliberately exposed "passed as argument to any user-format-funcs"). The format is buffer-local (`gnus-sum.el:3097`), so a `let` around the read call, or `gnus-summary-mode-hook` (already used at `emacs-config/dl-gnus.el:96`), sets it.
- Batch limiting: `gnus-summary-limit-to-articles` with no prefix limits to the process-marked articles and clears the marks (`gnus-sum.el:8144-8152`); `gnus-summary-limit-mark-excluded-as-read` is what pick-mode uses (`gnus-salt.el:136-140`).

**5. Executing a batch.**
- Every "work on marked articles" command funnels through `gnus-summary-work-articles` (`gnus-sum.el:6544-6592`): prefix beats region beats process marks beats current. `gnus-summary-universal-argument` (`&`) is literally "Perform any operation on all articles that are process/prefixed" and re-reads a key sequence per article (`gnus-sum.el:6982-6995`). Move and delete use it too (`gnus-sum.el:10034`, `10566`).
- Marking process marks programmatically: `gnus-summary-set-process-mark` (cited in thread 4, `gnus-sum.el:11032`); the `gnus-uu-mark-*` family exists (`gnus-uu-mark-thread/region/by-regexp/buffer`, referenced at `gnus-salt.el:69-77`).
- Undo: `gnus-undo-register` is a no-op unless `gnus-undo-mode` is on (`gnus-undo.el:126-131`), and `gnus-undo-mode` is enabled in the *group* buffer (`gnus-group.el:1092`) — no `gnus-undo-mode` call exists in `gnus-sum.el` (grep). Mark/catchup paths register undo (`gnus-sum.el:6339-6350`, `12841-12850`); **moves and deletes register nothing** (`gnus-sum.el:10088-10305`, `10566-10600`) → no free undo for the dangerous operations (inference from absence).

**6. Logging hooks.**
- `gnus-summary-article-move-hook` (`gnus-sum.el:1107-1111`) is run with `(action header from-group to-newsgroup select-method)` right after the move, in the success branch (`gnus-sum.el:10280-10286`); `header` is the mail-header (hence Message-ID via `mail-header-id`). For nnselect, FROM-GROUP is the *nnselect* group name — the real source must come from the artlist/plan (inference).
- `gnus-summary-article-delete-hook` (`gnus-sum.el:1113-1117`) with `(action header group nil nil)` on junk-landing (`gnus-sum.el:10168-10176`) and on permanent delete (`gnus-sum.el:10588-10592`); `gnus-summary-article-expire-hook` also exists (`gnus-sum.el:1119-1123`).
- Mark logging has no per-mark hook; nearest is `gnus-after-set-mark-hook` "Hook called just after marks are set in a group" (`gnus-int.el:42-46`, invoked `gnus-int.el:580`) — with nnselect these arrive already re-categorised per real group.
- Move/delete hooks are listed in `gnus-summary-local-variables` as `(hook . global)` (`gnus-sum.el:1692-1693`), i.e. they are killed per summary but preserve a global value (inference on the `. global` semantics).
- Noisy/unusable for logging: `gnus-summary-update-hook` (per line redraw, `gnus-sum.el:1080-1087`, `3788`, `5492`), `gnus-mark-article-hook` (display-driven, `gnus-sum.el:1090`).

**7. gnus-registry.** It does offer Message-ID → group: `gnus-registry-get-id-key (id 'group)` (`gnus-registry.el:1108`), and nnselect uses it when available (`nnselect.el:899-905`). But `gnus-registry-install` defaults to `'ask` (`gnus-registry.el:155`) and **`stage/emacs-config/dl-gnus.el` contains no reference to the registry at all** (grep over the file: only `gnus-summary-move-article`, the archive group, meow keymap hooks at `dl-gnus.el:81-97`). Confirmed: not available; don't design around it.

### Proposed native mechanism

Trusted elisp, once per batch:

```elisp
;; a) ids -> artlist triples, one Gnus call, no per-id plumbing:
(gnus-search-run-query
 '((search-query-spec (query "message-id:<a@x> or message-id:<b@y>"))
   (search-group-spec (("fastmail")))))          ; gnus-search.el:2063, 2260
;; or, cheaper and unambiguous, one server/group pair per plan line:
;;   (search-group-spec (("fastmail" "INBOX") ("fastmail" "deduction/fy15")))

;; b) one function we write (~8 lines): return the stored artlist,
;;    keep plan metadata in a closure/alist for %u annotations.
(defun my/plan-select (args) ...)                 ; contract: nnselect.el:26-40

;; c) open the review buffer AS a summary
(let ((gnus-summary-line-format "%U%R%z %M %G %u %-30f %s\n")
      (gnus-auto-select-first nil))
  (gnus-group-read-ephemeral-group
   (concat "plan-" plan-id) '(nnselect "nnselect") nil
   (cons (current-buffer) gnus-current-window-configuration) ; => push-info on exit
   nil nil
   (list (cons 'nnselect-specs
               (list (cons 'nnselect-function 'my/plan-select)
                     (cons 'nnselect-args plan-artlist)))
         (cons 'nnselect-artlist plan-artlist))))
```

Operator keys, all stock Gnus: `%G`/`%M`/`%u` show real group, Message-ID, and the plan's action+rationale on one line; `#`/`gnus-summary-set-process-mark` pre-set per action batch (or a `gnus-summary-prepared-hook` that marks articles 1..N of the first batch); `&` (`gnus-summary-universal-argument`) or a plain `B m` move / `T` tick / `M d` unread / `M c` unflag / `gnus-summary-delete-article` applies it to the marked set; `q` exits — and `nnselect-close-group` → `nnselect-push-info` writes marks back per real group and updates each group's info and unread counts (`nnselect.el:790-800`, `918-1052`).

What we still write ourselves: the select function + spec assembly (~15 lines), the `%u` formatter (~10), plan→query string (~5), the mode/`let` that sets the line format and process marks (~10), and two `add-hook`/`add-function`s on `gnus-summary-article-move-hook` and `‑delete‑hook` that append the log record (Message-ID from `mail-header-id`; source group from the plan/artlist; target from the hook's TO-NEWSGROUP) (~35). Mark actions need our own wrapper or `gnus-after-set-mark-hook` (~10). Total ≈ 75-90 lines, none of it Gnus-internal bookkeeping.

| | Thread 4 (hand-rolled) | Thread 5 (nnselect summary) |
|---|---|---|
| Gnus plumbing | per-id `gnus-request-head`, manual `gnus-info`/mark updates, own move path | none: `gnus-search-run-query` + one select fn |
| Info/unread bookkeeping | ours (`gnus-group.el:3600-3700`, `gnus-sum.el:6318-6378` pattern) | Gnus's (`nnselect-push-info`, `nnselect.el:1014-1052`) |
| Destination group update | partial / left to resync | full (`gnus-sum.el:10200-10305`) |
| Review UI | bespoke buffer | summary buffer, `%G`/`%M`/`%u` |
| Batch apply | our loop | `&` / process marks |
| Undo | none | none for moves (marks undoable if `gnus-undo-mode` enabled) |
| Failure modes | stale info, double-marking, partial batch | exit-path (`Q`) silently drops marks; search cost; `%u` unverified |

### Risks and unknowns

- **`Q` loses everything.** `nnselect-close-group` skips `nnselect-push-info` when `gnus-group-is-exiting-without-update-p` is set (`nnselect.el:791-793`); an operator who quits with `Q`, or whose Emacs dies, leaves IMAP unchanged but the summary's marks lost without error. Bind/wrap so only `q` counts as commit, or push twice (on mark commands, not just exit) — inference.
- **`delete` in this mode can never be "expunge later".** `nnselect-request-expire-articles` binds `nnimap-expunge 'immediately` (`nnselect.el:544`); combined with `gnus-summary-delete-article`'s forced expiry this ignores `nnimap-expunge 'on-exit` (`nnimap.el:102-115`). The slice wants "delete = move to Trash", which is the move path — keep it there and refuse real expiry in plans.
- **Search ambiguity and cost.** `message-id:` is a substring `HEADER` search, so a truncated id silently matches; the same id may exist in INBOX, Archive and Sent, yielding duplicate triples; server-wide search walks every mailbox (`gnus-search.el:1100-1126`, `2260`). Resolution: pass explicit per-line groups in `search-group-spec` and diff found vs planned ids (misses get logged as failed, not skipped silently).
- **Three-plus-way `or` translation looks off.** The nested-`or` transform wraps a transformed `(OR …)` in another pair of parens (`gnus-search.el:1191-1202`), producing `((OR a (OR b c)))`. Probably accepted by IMAP but must be tried live; a `raw` query (`gnus-search.el:2117-2120`) is the fallback.
- **`%u` user format not verified from staged sources** (`gnus-spec.el` absent). Confirm `gnus-user-format-function-<c>` is called with `gnus-tmp-header` on 31.1; otherwise fall back to `gnus-summary-prepare-hook` text injection.
- **move hook has no real source group.** Its FROM-GROUP argument is the nnselect group name (`gnus-sum.el:10280-10286`); log the source from the plan/artlist, and don't rely on `gnus-newsgroup-selection` being bound inside the hook.
- **Threading, sorting, scoring, `gnus-fetch-old-headers` all apply** to the ephemeral group (`nnselect.el:395-452`, `gnus-group.el:2260-2263`); line order and article numbers won't match the plan's line order, so process marks must be set by looking up Message-ID, not by position.
- **Each real group is requested during header retrieval** (`nnselect.el:410-420`), which can prompt for a password or block on a slow mailbox mid-review (inference; cf. thread 4's server-open caveat).
- **Live checks needed:** that `gnus-search-run-query` with `(search-group-spec (("fastmail" "INBOX")))` returns `[group uid score]` for Fastmail; that `UID MOVE` to `Trash` preserves the Message-ID and that a subsequent id lookup finds it (so re-runs don't redo work); that exiting the ephemeral group updates the group buffer's unread counts without a `g`; and that `nnselect-request-set-mark` batches several marks of different types into valid `UID STORE`s on the same mailbox.
