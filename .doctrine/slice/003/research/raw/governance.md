## Thread 1 — governance applicability

### Binding constraints

- **Authority tiers:** accepted decisions bind (tier 2, `.doctrine/state/boot.md:12`); RFCs, slice notes and memories are evidence only (tier 5, `.doctrine/state/boot.md:15`). So RFC-002 does not bind SL-003 directly — it binds because SL-003's scope adopts three of its decisions (`.doctrine/slice/003/slice-003.md:9-31`), exactly as RFC-002 requires (`rfc-002.md:8-9`, `rfc-002.md:301-303`).
- **RFC-002 D1:** a topic is a unique name with an optional `cwd`, used as a creation-time default copied into the conversation; changing a topic never rewrites existing conversations (`rfc-002.md:279`, `rfc-002.md:143-147`). Adopted: `slice-003.md:12-17`.
- **RFC-002 D3:** a topic carries only `cwd`; no model/extension defaults (`rfc-002.md:281`), reinforced by non-goal `slice-003.md:72`.
- **RFC-002 D7:** every ownerless conversation is in the index, added in the commit that creates it, through `createConversation`/`fork` `init`; a fork records its parent's topic and its parent; pre-index conversations backfill into `default`, root first (`rfc-002.md:285`; `slice-003.md:21-25`, `:37-43`, `:79-82`).
- **RFC-002 I-1:** the index is a session-scoped pi-durable document in the same store, "a single document (or a document family plus a key list)" (`rfc-002.md:154-160`). This is the only text bearing on OQ-3, and it explicitly declines to choose.
- **DEC-007, widening rule:** keys widen additively; an element type does not (`record-007.md:61-62`, `:92-95`). Objective 5's "can list the topics themselves" (`slice-003.md:52-54`) therefore cannot ride on `conversations:[N,…]` without an explicit skew decision.
- **DEC-007 amendment, refusals:** one frame-named `FrameRefused` for every first-line frame, error-then-close, binding nothing (`record-007.md:76-84`; code `src/protocol.ts:66-76,144`). The new `topic` frame must join this vocabulary or reintroduce the F-3 bug it retired.
- **DEC-007 amendment, failed reads close:** a rejected read routes through `fail`, not the turn chain (`record-007.md:85-88`). Applies unchanged to a topic-filtered listing and to the index read.
- **DEC-008:** `--list` is exclusive with `--conversation`, `--new`, `--cwd`, `--emacs` (`record-008.md:16-19`); the reader accepts exactly two frames; skew is a predicate naming the frame (`record-008.md:21-24`). `--topic`/`--here` must be added to that closed set or legalised deliberately; a widened `topic` frame inherits the skew hint for free.
- **DEC-010:** SL-002 refused `--here`/attach-by-directory and paging, and named *why* — under the `room` profile a conversation's `cwd` is a room path and a shell's is a host path, "so the lookup would silently miss" — routing it to this slice (`record-010.md:29-33`). SL-003 inherits the hazard, not just the feature.
- **SL-002's locked design is a shipped guarantee:** the `list` frame refuses `{"type":"list","topic":"x"}` with the exact message `list: unknown key topic` (`.doctrine/slice/002/design.md:29`, `:99`; `test/daemon.test.ts:708`; `test/protocol.test.ts:89`). Objective 5 falsifies it, so the change is an owed amendment plus test edit, never a silent drift.
- **Docs owed by accepted DECs:** DEC-007 requires `docs/internals.md` §Protocol to document the frame (`record-007.md:62-64`); DEC-010 owes the no-paging claim (`record-010.md:25-28`). Both currently assert things Objective 5 removes (`docs/internals.md:107-118`; `README.md:140-147`).
- **Structure gate:** `test/structure.test.ts` moves in the same commit as any seam that moves (`.doctrine/slice/002/design.md:103`) — an index module will move it.
- **Carried client defects:** the listing bounds its connect but not its reply (`mem.fact.malebolge.list-has-no-reply-timeout`; `IMP-006`) and `attach-main` can truncate piped output (`mem.fact.malebolge.attach-exit-truncates-piped-stdout`; `IMP-007`) — IMP-007 says the breaking size "is the size a bigger page would have", which is what widening `--list` to topics produces.
- **Verification hygiene:** any "no document claims X" criterion must sweep `.doctrine/`, not just README/docs (`mem.pattern.malebolge.criterion-sweep-must-include-governance`).

### Checked, not applicable

- **No SPEC/PRD/REQ, ADR, POL or STD exist in this repo** (`.doctrine/` has no `adr/`, `policy/`, `standard/`, `spec/`; boot: "not yet populated"). Positive control: `doctrine revision change add --target DEC-009` is refused, DECs not being revision targets (`mem.pattern.doctrine.decision-is-not-a-revision-target`). Conclusion: SL-003 amends DECs as prose; no REV is the correct surface.
- **REV-001** — `abandoned`, no `[[change]]` rows (`.doctrine/revision/001/revision-001.toml`), so it carries nothing forward.
- **DEC-009 (Emacs picker)** — its scope is the Emacs target prompt; SL-003 gives Emacs topic support to the clients slice (`slice-003.md:69`). Not binding here.
- **DEC-001..DEC-005** — `proposed`, SL-001 Emacs drafts/frames (`.doctrine/knowledge/decision/001/record-001.toml`); DEC-006 is comint following. All Emacs, all outside `slice-003.md:69`.
- **RFC-001** — module placement and room mechanism (`rfc-001.md:44-70`, `:90-136`); it decides nothing about topics or an index.
- **IMP-002, IDE-001, REC-001** — structural backlog and inbox behaviour (`backlog/improvement/002`, `backlog/idea/001`, `knowledge/evidence/001`); no reach into conversation organisation.
- **satan ADR-017/ADR-018, DEC-104/105/107/108, IDE-017, IMP-053** — cited as governing (`slice-003.md:135`; `src/conversations.ts:1-8`) but cross-repo and unreadable here: `~/dev/satan` exists and is empty.

### Tensions / open points

- **OQ-1 is understated.** RFC-002 answers *who* resolves (the client, `rfc-002.md:279`, `:148-152`), not *in whose path space*. Code says the mismatch is structural: `Profile = "room" | "host"` (`src/config.ts:21`), the room's `home` is "the tools' cwd in the room" (`src/config.ts:29`), the client defaults to room (`src/config.ts:89`), and `cwd` reaches pi uninterpreted — "a host path given to the `room` profile points inside the room" (`README.md:156-159`). So one stored directory string is simultaneously a lookup key computed client-side and a creation-time default interpreted daemon-side. Readings: (a) client-side comparison of client paths — convenient, but the matched directory is not the directory the conversation gets; (b) daemon resolves a path — it only half knows the mapping (`src/config.ts:25-29`); (c) store two fields — violates D3 (`rfc-002.md:281`); (d) restrict `--here` to the `host` profile — cheap, no new state, D3 intact, but dead by default since the client defaults to room. I favour (d) or dropping `--here` from this slice; either departs from the scope's Objective 7 and needs the user's assent.
- **OQ-2 collides with a compat promise.** RFC-002 says a command-first-line connection binds "root, which is the `default` topic's first conversation" (`rfc-002.md:207-209`), and README owes "a plain `malebolge-attach` always reaches root" (`README.md:120-126`). If "latest" means highest id, `--topic default` never binds root once backfill adds anything; if "most recently attached", using root repairs it. Nothing in governance decides; the id ordering does, against the RFC's prose.
- **OQ-4 is decided by code, not by taste.** Root is re-configured with the daemon's agent on every open (`src/session.ts:41-42`), and `create()` takes the daemon's defaults with no init (`src/conversations.ts:96-105`). An ordinary, directory-bearing `default` would honour its directory only on the attach-by-topic path, never for root or legacy `attach new` — a half-kept D1 promise. "Reserved" dissolves that; "ordinary" needs a rule the RFC does not give.
- **OQ-3 is unconstrained** (`rfc-002.md:154-160` permits both), but D7's "in the creating commit" (`rfc-002.md:285`) fixes the seam's *location*, whatever the layout.
- **Fork premise is unverified.** `grep -rni fork src test docs README.md emacs` returns 0 hits, so `slice-003.md:70-71`'s "forks, which tests create through the harness" names a test that does not exist; D7's fork arm rests on the unverified `init` claim (`slice-003.md:113-114`; `rfc-002.md:303-306`). Design must make that a criterion.
- **Objective 5 vs DEC-007/DEC-010:** a topic *filter* is not a pager (compatible with `record-010.md:33`), but listing topics is a new element type and the shipped refusal test must be rewritten (`test/daemon.test.ts:708`).

### Revision candidates

- **DEC-007** — append an amendment: `list` gains a topic filter; topics listing gets a new frame or a documented element-type change; the `unknown key topic` refusal is retired.
- **DEC-010** — amend: `--here` and topic listing move from "refused, step 2 owns it" to SL-003's scope; keep "no paging", "no labels".
- **DEC-008** — amend: extend the closed exclusivity set with `--topic`/`--here`; state that the skew predicate covers `topic`.
- **DEC-009** — no change (Emacs topics are the clients slice).
- **SL-002 design.md:29/:99** — do not edit a closed slice's locked design; record the supersession in SL-003's design and in the DEC-007 amendment.
- **RFC-002** — leave as deliberation (`rfc-002.md:8-9`); if the design reopens D1's client-side `--here`, record that reopening with the user, as `rfc-002.md:301-303` requires.
- **No REV** — there is nothing in the revision target set to revise (`mem.pattern.doctrine.decision-is-not-a-revision-target`).

### Limits

- satan's ADR-017/018, DEC-104..108, IDE-017, IMP-053 and ISS-055 are cited as governing but unverifiable here (`~/dev/satan` empty); whether they add constraints is unknown, not dismissed.
- pi-durable 1.3.0 is installed (`node_modules/@earendil-works/pi-durable`, version 1.3.0) but the checkout RFC-002 read (`~/.local/src/pi`) is absent; the "session-scoped document" and `fork`-`init` claims (`rfc-002.md:74-79`, `slice-003.md:113-114`) are inferred from the RFC, not checked by me.
- No `SPEC`/`REQ` exists, so there is no requirement to drift against; if one is introduced before design lock this assessment needs redoing.
- I did not read `src/daemon-start.ts`, `src/attach-main.ts` or the full attach reader; the exclusivity and skew claims rest on `record-008.md` plus `src/attach.ts:118-181`.
