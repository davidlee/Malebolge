# IMP-015: Per-conversation byte budget for mail_* tools

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

SL-005 (DEC-026) bounds each mail tool call, not the total a conversation
reads. The brief (satan:RFC-020, brief §4.4) asks for aggregate bytes per
invocation. A daemon mail conversation is driven by the operator; a triage
job in the runner would sit under its token and cost ceilings. Revisit with
satan:RFC-020 OQ-6 (where triage runs): a budget held per conversation
needs state, so mind replay safety.
