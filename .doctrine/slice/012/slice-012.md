# Mail action plans: the mail agent proposes, the operator executes in Gnus

## Context

SL-007 gave the mail agent classified, read-only mail tools. It reads mail
well enough; it cannot yet produce anything the operator can act on beyond
its reply.

The operator, 2026-10-30: the agent should emit suggested actions as data,
which the operator reviews, edits, or executes as-is in Emacs / Gnus with
their own read/write credentials. This is IDE-005, whose 2026-10-29 notes
already chose the cheapest path: execute in Gnus, so screwtape needs no write
side.

RSK-002 (foreign-text quarantine) governs. The mail conversation is Q1 (a
possibly-infected reader); its plan is a Q2 derivative: structured, read by
the operator alone, enacted only by the operator. Mail mode writes nothing
today (DEC-029); emitting a plan is its first write.

```
 mail agent (Q1)                      malebolge (trusted)            Emacs (trusted elisp, ours)
 ───────────────                      ───────────────────            ─────────────────────────────
 mail_propose(...) ──► validate: closed action set,  ──► plan (data) ──► review buffer per batch:
   ids + action          ids screwtape resolves,          in a Q2 home    mail-store headers, not the
   + target mailbox      target mailbox exists                            agent's description
   + rationale (data)                                     (Gnus summary of the plan's messages)
                                                                           │ apply a batch, or act
                                                                           ▼ with stock Gnus keys
                                                          Gnus marks / moves ──► act log (append)
                                                          (operator's credentials)
```

## Scope & Objectives

1. **A plan tool in mail mode.** The agent proposes actions over messages it
   can read, from a closed vocabulary:
   - archive / move to an existing mailbox
   - mark read / mark unread
   - flag (Gnus tick) / unflag
   - delete (move to Trash; never expunge)

   Each line carries message ids, the action, a target mailbox where the
   action needs one, and a short rationale held as data. No free-text action,
   no elisp, no shell. Withheld mail the conversation was shown is added by
   malebolge on a line of its own (DEC-117).
2. **Validation on the trusted side.** malebolge refuses unknown actions,
   unknown mailboxes, ids the source cannot resolve, and messages without a
   usable Message-ID, before anything is stored. Message identity for Gnus
   (RFC 5322 Message-ID, IMAP path) and the header snapshot are derived from
   screwtape, not from the agent (DEC-109).
3. **A Q2 home for plans.** Plans are stored outside every SATAN read root,
   readable by the operator's Emacs.
4. **Review in a plan document, stage and commit in Gnus.** A plan renders
   into an org-mode buffer with no file, one heading per line with real
   sender/subject snapshots, the rationale quoted as agent text, and status
   from the act log (DEC-116). Opening a line stages its proposed actions in
   an ephemeral nnselect Gnus summary (DEC-112, DEC-113); the operator commits
   with ordinary Gnus acts (`q`, `B m`), discards with `Q`, or does something
   else.
5. **A log of the operator's acts on plans.** Emacs appends one record per
   act on a plan's message, when it happens: Message-ID, action, source and
   target, result, and the plan and line it came from. Moves and marks are
   captured from Gnus's hooks as they reach the server (DEC-114). Edits
   and drops are not logged separately: they are the difference between the
   stored plan and the logged acts (operator, 2026-10-30). The source is the
   operator's acts, not the agent (IDE-007 provenance). Append-only; nothing
   reads it yet.
6. **Records:** the mail tool count moves six → seven (DEC-062, DEC-026's
   narrowing note, DEC-049's non-egress pin; DEC-029 carries no count);
   RSK-002 controls and gap 3; the departure from satan:RFC-020 D4/D6.

## Non-Goals

- Draft replies or any agent-written text sent under the operator's name
  (later backlog item).
- A screwtape write path; malebolge never writes mail.
- The agent executing anything, or seeing a plan's outcome.
- A read side for the act log: querying it, or feeding it to the agent
  (IDE-007's operator signals are a later slice; this slice only records).
- Plans for bookmarks (IDE-008 step 2), though the format may be shared.
- Classification changes (SL-007).

## Affected surface (coarse)

- `src/mail/**` — the plan tool, validation, storage.
- `src/config.ts`, `src/daemon-start.ts` — the plans directory setting.
- `emacs/malebolge-mail.el` — plan document and Gnus staging (DEC-115).
- `test/**`, `justfile`, `README.md`, `docs/internals.md`.
- Outside this repo: the room jail binds the plans directory
  (`~/dev/satan/flake.nix`, `~/flakes/features/satan/malebolge.nix`).

`src/toolsets.ts` is unchanged: the mail catalog is the extension's tool list.

## Risks

- **Misdescribed batches.** An infected agent labels a batch "newsletters"
  and includes a bank's mail for deletion. Mitigation: the plan document
  renders the mail store's header snapshot, never the agent's description of
  a message (DEC-109, DEC-116).
- **Delete is destructive.** Mitigation: delete is a move to Trash, never an
  expunge, and only the operator commits it (DEC-108, DEC-113).
- **Rationale as an injection channel to the operator's eyes.** Bounded,
  rendered inert, framed as agent text.
- **Plan volume as a nuisance channel.** Mitigation: caps of 20 lines and
  100 messages per plan (DEC-108); no cap on plans per conversation, since the
  plan command opens the latest plan by default (DEC-117).

## Assumptions

- screwtape exposes each message's Message-ID header (`message_id` in
  `src/mail/source.ts`) and mailbox ids/names that map to Gnus nnimap groups.
- The operator's Gnus reaches the same IMAP account that screwtape mirrors.

## Open questions

All answered by the design inquiry (see Decisions below):

| question | answered by |
|---|---|
| OQ-1: how a plan reaches Emacs | DEC-110 |
| OQ-2: mapping screwtape mailboxes to Gnus groups | DEC-109 |
| OQ-3: locating and acting on articles by Message-ID | DEC-112, DEC-113 |
| OQ-4: one call or accumulated; what a batch is | DEC-108 |
| OQ-5: plan lifecycle and who records it | DEC-111 |
| OQ-6: the act log's home and format | DEC-114 |

## Verification / closure intent

- Tests: the tool refuses each invalid input class; a valid plan is stored
  in the Q2 home and nowhere a SATAN read tool reaches; the mail catalog
  guard still excludes coding, SATAN and write tools.
- Emacs: an ERT test renders a plan from fixture data; sender and subject
  come from the plan's header snapshot, never from the rationale.
- Emacs: ERT tests that a malebolge move and a stock Gnus move each append
  the expected record, and that a failed malebolge move is logged as failed.
- Live run (VH, by the operator): a mail conversation proposes a plan over
  real mail; the operator executes one batch as proposed and overrides one line with a
  stock Gnus command; the act log shows both.

## Decisions (design inquiry, 2026-10-30)

- DEC-108: `mail_propose` writes one whole plan; a line is one action over a
  set of messages; closed action set; caps; replay unsafe.
- DEC-109: malebolge derives Message-ID, IMAP paths, pre-state and a header
  snapshot from screwtape; withheld and reported mail must appear in the plan.
- DEC-110: plans in `MALEBOLGE_MAIL_PLANS`, outside SATAN read roots,
  create-exclusive JSON; room jail binds it read-write (this slice).
- DEC-111: plan files are immutable; status derives from the act log;
  dismiss moves to `dismissed/`.
- DEC-112: a plan line opens as an ephemeral nnselect group from a scoped
  gnus-search on its Message-IDs.
- DEC-113: opening a line stages; only the operator's Gnus commit reaches the
  server.
- DEC-114: append-only `acts.jsonl`; every server-reaching act from a plan's
  summary is logged; variations = plan − log.
- DEC-115: elisp lives in `emacs/malebolge-mail.el`.
- DEC-116: JSON rendered into an org buffer with no file; sanitised untrusted
  text; plan document for batch decisions, Gnus for messages.
- DEC-117: malebolge tracks withheld mail shown per conversation and adds it
  to every plan; no cap on plans per conversation.
- Follow-on: ISS-008 (daemon jail never hosts a coding-tool agent).
