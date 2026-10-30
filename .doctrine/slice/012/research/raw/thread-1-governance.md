## Thread 1 — governance applicability

### Binding constraints

(stage = `.doctrine/state/slice/012/stage`; all records cited live in `stage/records/`.)

- RSK-002 (zone model): Q1 emits Q2 derivatives, quarantined until the operator promotes or disposes of them, and nothing flows Q1/Q2 → SATAN except through the operator (`stage/records/RSK-002.md:52-58`) — consequence for SL-012: plans are Q2, Emacs/operator-readable only, and must not sit inside any SATAN read root.
- RSK-002 gap 3: operation proposals and digests "must stay outside every SATAN read root" (`stage/records/RSK-002.md:85-87`) — consequence for SL-012: the Q2 home cannot be malebolge's own state root `~/.local/state/satan/durable/<profile>/` (`src/config.ts:332-334`), because `~/.local/state/satan` is itself one of SATAN's three roots (`stage/satan/RFC-020.md:69-71`).
- RSK-002 "When to pull": it must be pulled before any slice letting mail emit beyond its reply (`stage/records/RSK-002.md:90-93`) — consequence for SL-012: this slice *is* that trigger; the Q2 home answer belongs in RSK-002's gap 3.
- RSK-002 operator stance: "the quarantine emits a limited set of writes: mostly structured, read by the operator alone (plans for emails, enacted only by the operator)" (`stage/records/RSK-002.md:31-33`) — consequence for SL-012: a plan tool is pre-authorised in kind; the obligation is to keep it structured and operator-only.
- IDE-005 cheapest path: the agent must not write the elisp; ours validates actions, groups and Message-IDs, quotes rationale as data, and renders Gnus headers (`stage/records/IDE-005.md:37-62`) — consequence for SL-012: objective 4/5 is a settled design, not an open choice.
- DEC-025: a conversation's toolset is fixed at creation, chosen by topic among the profile's allowed sets, checked in code (`stage/records/DEC-025.md:7`) — consequence for SL-012: no opt-in flag; every mail conversation gains the plan tool at the next restart.
- DEC-029 (2),(3),(6): the mail list is exactly `mail-persona, conversation, mail`; mail names none of coding-tools, grep, satan, tasks; a catalog change reaches existing conversations at restart and is logged (`stage/records/DEC-029.md:7`) — consequence for SL-012: only the `mail` extension changes; the guard tests (`test/toolsets.test.ts:243-266`) still bar coding and thread tools.
- DEC-049: mail tools refuse every call when the process can reach the network, and a test pins that the mail toolset holds only non-egress tools (`stage/records/DEC-049.md:7`) — consequence for SL-012: the plan tool must be a pure local write and join that pin; it must also not become a read path back to the agent.
- DEC-062: the canonical shape for a mail write tool — closed vocabulary, validated typed fields, no free text, one journal line, bounded set with explicit refusal when full (`stage/records/DEC-062.md:7`) — consequence for SL-012: plan tool follows it (closed action set, plan/line caps, refusal messages), and the catalog count moves six → seven in the same places.
- DEC-061: error results carry the fixed `malebolge: ` prefix, and the UNTRUSTED header line lives in the shared renderBlock by block tag (`stage/records/DEC-061.md:7`, `:21`, `:25`) — consequence for SL-012: plan-tool errors use the prefix; any sender text the tool echoes must go through `src/untrusted-block.ts`, not a bespoke renderer.
- DEC-054: one module measures, cuts and wraps every foreign-data family (`stage/records/DEC-054.md:15`) — consequence for SL-012: a rationale quoting mail text may not open a second, unmeasured rendering path.
- DEC-063: the pre-filter withholds sender-written text of hostile, unclassified or reported mail while keeping ids (`stage/records/DEC-063.md:7`) — consequence for SL-012: the agent can name ids it never read; design owes an explicit rule on withheld/reported mail in plans, with the Gnus-header render as the only real mitigation.
- CON-001: classifier question names appear only in the pre-filter policy (`knowledge/constraint/001/record-001.toml:6`, `:15`-ish `choice`) — consequence for SL-012: plan validation and rendering must not name or branch on Jev questions.
- DEC-028: fail-closed envelope validation, argv with no shell, no partial data on a malformed line (`knowledge/decision/028/record-028.toml:15`) — consequence for SL-012: unknown action, unknown mailbox or unresolvable id fails the whole call before anything is stored.
- DEC-055 + ASM-010: the established pattern for a host file the daemon must reach is a configured absolute path with a read-only jail bind, startup refusing a relative value, explicit denial when unset (`knowledge/decision/055/record-055.toml:15`; `knowledge/assumption/010/record-010.toml:6`) — consequence for SL-012: the plan home should be an env-configured absolute directory rather than a hard-coded path.
- DEC-091 (refining DEC-089): every Emacs call goes through one bounded `malebolge--client`; a timed-out write reports an unknown outcome (`knowledge/decision/091/record-091.toml:15`; `emacs/malebolge.el:276`) — consequence for SL-012: if OQ-1 picks the client path, plan fetch/ack reuses that one bounded path.
- DEC-002 + DEC-016: Emacs submits JSON stdin frames, and first-line frames are table-dispatched with unknown keys refused by older daemons (`knowledge/decision/002/record-002.toml:15`; `knowledge/decision/016/record-016.toml:15`) — consequence for SL-012: a plan-fetch frame is a protocol widening with a deployment-skew cost; a file in a bind-mounted directory avoids it.
- RFC-003 talk sets: mail belongs to no talk set, and its transcript and outputs are quarantined derivatives (`rfc/003/rfc-003.md:125-128`; DEC-032) — consequence for SL-012: the plan tool posts, wakes and sends nothing, and no other conversation's tools may reach the plan store.
- ASM-001: a mail conversation runs as the operator on the host with `HOME` alone (`knowledge/assumption/001/record-001.toml:15`) — consequence for SL-012: the daemon performs the write, so "the agent writes nothing" stays literally true; the agent supplies data only.

### Checked, not applicable

- DEC-026: read-tool surface and rendered-byte bounds; plan limits are a new, separate bound.
- DEC-027: cursor paging for reads; plans are not paged.
- DEC-047, DEC-048, DEC-050, DEC-056, DEC-057, DEC-058, DEC-060, DEC-077, DEC-094: classify wiring, caching and window clamps; SL-012 inherits the `jev` object unchanged and touches no classify path.
- DEC-023, DEC-024: toolset catalog/selection, absorbed for this purpose by DEC-029.
- DEC-053: bookmark metadata carve-out; different material family, no plan bearing.
- DEC-013: the index is one session document; plans are not index entries.
- DEC-032 as *content* (talk-set declaration): only its mail conclusion binds (above).
- DEC-064 to DEC-066, DEC-071: bridge listener, pairing and outbox; separate socket and vocabulary.
- DEC-034, DEC-035, DEC-039: thread tools and visibility; mail has no thread surface.
- IDE-006: digests are a different output with their own slice; only its "where derivatives live" question is shared.
- IDE-007: operator signals; SL-012 records acts but reads nothing back, matching its constraints (`stage/records/IDE-007.md:24-30`).
- IDE-008 step 2: bookmark reorganisation plans; explicit non-goal, format may be shared later.
- CHR-004 (toolset → mode rename): open chore; SL-012 should write "toolset" per `src/toolsets.ts:8` and let the rename come later (inference).
- RFC-001, RFC-002: malebolge governance/orientation; no mail-plan constraint.

### Revision candidates

- **DEC-062** (consequences, `stage/records/DEC-062.md:10`) and **DEC-026**'s narrowing note (`stage/records/DEC-026.md:23`): the five→six catalog count is recorded *there*, not in DEC-029, whose choice text carries no tool count. SL-012's objective 6 ("amend DEC-029's mail catalog (tool count)") should be restated as "mail goes six → seven; DEC-062's consequence amended" (inference from the two records plus `test/toolsets.test.ts:256-266`).
- **DEC-029**: no textual change to the catalog, but its consequence list is where "the list is re-derived at restart" lives; SL-012 should note the new tool arrives that way.
- **DEC-049**: the "only non-egress tools" pin gains a seventh member; its consequence wording should say the pin covers write tools too.
- **DEC-030** and **RSK-002** (`stage/records/RSK-002.md:62-64`, quoting `prompts/mail.txt` "You write nothing anywhere"; also `stage/records/IDE-005.md:29-31`): now false once a plan is stored. The prompt lives in `~/satan-corpus` (DEC-030 choice (1)–(2)), so this is a cross-repo operator change; DEC-030's "usage in code" survives.
- **RSK-002**: controls list (`:10`) gains the plan tool; gap 3 (`:85-87`) gains its first concrete answer and the act log's home.
- **IDE-005**: mark the shape settled (its `fulfilled by: SL-012` edge already exists, `stage/records/IDE-005.md:7-8`).
- **satan:RFC-020** D4 row and M4: the operation-proposals root, writer and lifecycle are now decided elsewhere (below); either SL-012 records the departure or satan amends.

### Notes on satan:RFC-020

- Milestone correction: proposals are **M4** — "Schema, validator and preview, with no execution" (`stage/satan/RFC-020.md:442-443`); M3 is triage, native tools and classify (`:436-441`). SL-012 delivers M4's schema, validator and preview *plus* execution, so it is M4 and part of D6 (`:382-398`).
- Principle it must align with: "The model proposes, deterministic software validates, the human authorises, and privileged software executes" (`:19-21`). Malebolge-validates / Emacs-renders / operator-executes in Gnus is that split with Gnus as the privileged executor.
- Storage departure: D4 puts Operation proposals at `~/.local/state/satan/…`, writer = SATAN triage run, readers = human (Emacs) **and Wormwood** (`:333`). SL-012 departs on all three — mail-mode writer, Emacs-only reader, and a root outside every SATAN read root, because that directory is itself a SATAN root (`:69-71`; `stage/records/RSK-002.md:86`). Record it as an explicit departure.
- Format/approval requirements worth adopting from D6 (`:384-387`): declarative versioned plan; ids scoped to an account; **expected source state per operation**; **approval bound to the canonicalised plan**; per-operation accept or reject; no replay. Consequence: a plan line needs account/mailbox/Message-ID plus the expected pre-state (current mailbox, seen, flagged), and an edit must re-canonicalise and be logged, or approval no longer binds what was executed.
- Execution departures: D6 gives execution to Wormwood with its own write token and a live JMAP recheck rather than the store (`:389-396`), and RFC-020's non-goals exclude Gnus integration (`:38-40`). SL-012 executes in Gnus with the operator's own credentials, no new credential, and the recheck is Gnus's own. Consequently authority-ledger rows 11 and 12 (`:408-409`) do not land as written; row 12's owner "emacs-client" is satisfied in spirit but the credential stays with the operator's Gnus session (inference).
- Closed action set: RFC-020's future executor lists archive, move, mark_read, flag, **unsubscribe, rules** (`:36-37`). SL-012 keeps the first four and drops the two D6 itself flags as needing "stronger checks" (`:386-387`) — consistent with its non-goals.
- Lifecycle: D4 leaves "lifecycle after approval" open (`:333`). SL-012's plan lifecycle plus the append-only act log answers that cell for the mail case and should be recorded against it.
- Constraint on the act log: "Mail-derived text must not become authoritative memory or configuration" (`:354-356`) — the log is operator-sourced but names quarantined plans, so it must stay out of the corpus, `memory_*` and `hippocampus_*`, matching IDE-007's provenance rule.
