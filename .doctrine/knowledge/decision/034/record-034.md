# DEC-034: Threads start through two tools, thread_start and thread_fork, each taking an intent and optional context

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


Refined 2026-10-29 by DEC-043 (design review r1, Sol F-3): an interrupted thread_start or thread_fork after its creating commit is ambiguous to the caller; receipts are IMP-020.

Amended by DEC-084 (SL-010; RV-025 F-15, 2026-10-29): a started thread takes its topic's model, else the daemon default, rather than the defaults' model; an unknown topic model refuses thread_start (DEC-083).