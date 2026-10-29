# IDE-005: Mail action plans: proposed archive, mark-read and move tasks the operator reviews and executes

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator direction, 2026-10-29. One of the mail agent's outputs.

## Intent

A mail conversation proposes a set of actions over messages — archive, mark
as read, move to a folder, and similar — as a structured plan. The operator
reviews it, edits or rejects lines, and executes the rest. The agent never
executes a plan itself.

## Shape (unsettled)

- A plan is a Q2 derivative under RSK-002: structured, read by the operator
  alone, enacted only by the operator. Mail mode writes nothing today
  (DEC-029, `prompts/mail.txt`), so emitting a plan is the first write mail
  mode gets. Keep it a closed, typed vocabulary of actions over message ids,
  not free text.
- Execution goes through a mail-writing path that screwtape does not have
  yet (its verbs are read-only plus `classify`).
- Review surface: probably the Emacs client.
- Operator decisions on a plan are signals for IDE-007.

## Cheapest path: execute in Gnus (operator, 2026-10-29)

The operator reads mail in Gnus. Emacs can execute the plan, so no
screwtape write side is needed yet: present batches of messages, each with
its action, and the operator triggers them one batch at a time.

Constraint (RSK-002): the agent must not write the elisp. Its output is
quarantined (Q2), and agent-written elisp, once evaluated, runs as the
operator with full access, which is the worst outcome RSK-002 names. Split:

```
 mail agent (Q1) ──► plan: data only          trusted elisp (ours, reviewed once)
                     batches of Message-IDs ──► renders a review buffer:
                     + action from a closed      subjects/senders per batch,
                       set + target folder       one command per batch
                       + rationale                     │
                                                       ▼
                                          operator triggers ──► Gnus marks / moves
```

- The renderer validates the plan: known actions, existing target groups,
  well-formed Message-IDs. It quotes the rationale as data and never
  evaluates it.
- The review buffer shows what each message is, using Gnus's own headers
  rather than the agent's description, so a batch can't misdescribe its
  messages.
- Open: mapping screwtape ids to Gnus articles (Message-ID lookup in the
  nnimap group); whether the plan arrives as a file in a quarantine dir or
  through the attach client.

Builds on IMP-022 (classified mail is the input worth planning over).
