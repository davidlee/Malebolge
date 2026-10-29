## Thread 1 — governance applicability

### Binding

- **DEC-024** — every conversation's tools come from a named toolset, no implicit install; bookmark tools must be added to a catalogue entry or they exist nowhere (docs/internals.md:100-102).
- **DEC-025** — a toolset is fixed at creation and chosen via the topic record / `--set-topic --toolset`; bookmark tools cannot be offered by an attach-time flag.
- **DEC-026** — bounds convention SL-008 already copies: rendered-byte budget, a trusted header (counts, clamps), truncation stated, never silent, no partial result.
- **DEC-027** — read tools are stateless and replay-safe; no server-side cursor, seen-list or cache in the bookmark tools.
- **DEC-028** — reuse `src/bounded-exec.ts` and the configured-absolute-path + fail-closed envelope validation pattern; no second bounded exec, no `PATH` lookup, raw child text never reaches the model.
- **DEC-029** — a toolset is the *complete ordered* extension list, prompt included; adding tools to `interactive` means editing `CATALOG.interactive` (src/toolsets.ts:25-35) and giving that conversation prompt text that describes them, since interactive is currently "unchanged byte for byte".
- **DEC-030** — tool usage lives in tool descriptions in code; the untrusted-data rule is one code section, test-pinned; persona prose stays in the corpus.
- **DEC-032** — if design creates a `bookmarks` toolset it needs a `TALK_SETS` entry (src/toolsets.ts:71-73); absent means that conversation can neither start, fork nor post. Leaving the tools in `interactive` puts every bookmark-reading conversation in the single talk set `interactive`.
- **ASM-001** — by analogy only, and it is binding *shape*: an adapter runs on the host as the operator with a minimal child environment, validated by a smoke test. SL-008 inherits the shape but has no equivalent assumption on record yet.
- **RSK-002** — bookmark titles/URLs reach the model framed as data with provenance and never as authority; framing is a code property, pinned by test (`src/mail/extension.ts:10`, `src/mail/render.ts:21` are the precedent).
- **SL-005** — the template this slice is held to: one port with a fake, bounds in code, framing reuse, doc/tool-inventory updates, and a guard test that the tools are only in the toolset design names.
- **docs/internals.md §Jail:207-211** — the daemon reaches only what `jailed-malebolge` binds (repo read-only, corpus, store, `$XDG_RUNTIME_DIR/satan/`); Firefox profile and panopticon state are outside it today, and OQ-4 is a cross-repo operator rollout.

### Checked, not applicable

- **DEC-001 – DEC-006** — Emacs attach composition/follow; no client change.
- **DEC-007, DEC-008, DEC-010, DEC-016, DEC-017** — attach/`list`/topic wire frames; bookmark tools are conversation tools, not frames.
- **DEC-009, DEC-014, DEC-015, DEC-037** — attach targeting, `--here`, topic-latest; untouched.
- **DEC-011, DEC-012, DEC-013, DEC-018 – DEC-022** — pi upgrade, index document, conversation-context variables; no new index field or variable.
- **DEC-031, DEC-033 – DEC-036, DEC-038 – DEC-046** — thread fork/post/caps/reaping/rendering; no thread interaction (though DEC-032 keeps the *talk set* consequence in play).
- **EVD-001, EVD-002** — fork/queue evidence for threads.
- **SL-007** — classified mail, `mail-1` answers; different port and toolset.
- **IDE-008** — the originating idea, not a constraint; its "Home … likely malebolge, TBD" is now settled by SL-008.
- **IMP-023** — deferred by this slice's non-goals (no digest lookup), but see Tensions for the boundary it still imposes.

### Revision candidates

- **DEC-029** — "This is today's install order, so an interactive conversation's prompt and tool order are unchanged" becomes false; needs an amend naming the new extension(s) and their position, plus a rule for the code-side guidance they carry.
- **test/fixtures/interactive-baseline.json / test/toolsets.test.ts:157-166** — the frozen interactive snapshot must be re-captured deliberately (the threads precedent, `withoutThreads`, test/toolsets.test.ts:125-128), otherwise VT-1 fails.
- **RSK-002** — the zone definition ("Q1 = anything that has read Q0") and *Current controls* name only mail; a bookmark-metadata carve-out (low-risk, operator-chosen titles) or a recorded control must be written, and *When to pull* gains a trigger.
- **SL-005** — its Context paragraph "**Not in the interactive tool set** (satan:RFC-020 D5)" and its closure claim ("README … states that mail is absent from the interactive set") stay true for mail, but the rationale (host bash defeats confinement) is the general-purpose test; it needs a note that read-only foreign-metadata tools are carved out, or the next reader will read it as a general ban.
- **IMP-023** — should state that bookmark metadata is outside its quarantine scope, so step 3's digest tool cannot be added to the same surface by drift.
- **docs/internals.md:71-83 and README.md:336-353** — toolset tables, the "interactive never includes mail" sentence's neighbourhood, and the tool inventory need bookmark rows/sections (DEC-010/DEC-029 doc-currency convention).
- **No ASM for bookmarks** — a new assumption (the daemon, in the jail, reads the chosen snapshot from a configured absolute path) should be created rather than ASM-001 amended.

### Tensions

1. **RSK-002 vs interactive placement.** Bookmark titles are Q0 foreign text, so by RSK-002's own definition an interactive conversation that reads them *is* Q1 — "presumed contaminated for its lifetime" — and interactive is the only talk set (src/toolsets.ts:71-73), so that contamination can be posted and forked into other interactive conversations, which RSK-002 says must happen "except through the operator". The slice's decision (interactive, no digest lookup) is defensible only if a carve-out is recorded, because otherwise the model's answer to "what is a zombie" swallows the interactive daemon.
2. **IMP-023 wants the opposite of interactive** — "Page content and digests reachable only from a dedicated toolset …, not the interactive set" — and SL-008 step 3 (capture-on-demand) reaches exactly that material through the same panopticon channel. The bookmark tools and the future digest tool will share a data path but must not share a toolset; that boundary has to be visible in code now (`CATALOG` entry), not decided when step 3 lands.
3. **Jail visibility vs the data path.** All three OQ-1 options need a bind added outside this repo (docs/internals.md:203-207), but option (c) is the only one whose bind is a narrow, purpose-made snapshot path. Binding the Firefox profile directory would put `logins.json`/`key4.db` inside a jail whose stated property is "its only secret is the gateway key file" (docs/internals.md:208-209); a `bookmarkbackups/`-sized bind or a panopticon-written export preserves that property and should be stated as a design constraint, not just an operator rollout.
4. **DEC-029(6) reaches existing conversations at restart.** Because a toolset's *list* is re-derived from code, adding bookmark tools to `interactive` silently rewrites every stored interactive conversation's extension list at the next start, logged (`conversation <id>: toolset interactive list changed`, docs/internals.md:124-125). Transcripts that never had host-file or foreign-text reach gain it retroactively — the one moment RSK-002's lifetime-contamination rule is easiest to violate without noticing.
5. **Prompt coupling.** DEC-030 requires the framing rule in code and the persona in the corpus; the interactive persona (src/persona.ts:27, `prompts/interactive.txt`) is corpus prose SL-008 may not edit, yet it claims an inventory and orders a first-turn `satan_boot_context`. Adding tools without touching it leaves the prompt describing a toolset the conversation no longer exactly is — a corpus change is an operator/cross-repo item to name in the design, as SL-005 did for `prompts/mail.txt`.
