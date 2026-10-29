# DEC-032: Talk sets are a per-profile map beside PROFILE_TOOLSETS; no toolset-to-mode rename in SL-006

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


## Refined by DEC-076 (2026-10-29)

SL-009 review r1 F-1: `wake_schedule` reached other conversations with no talk-set check. DEC-076 extends this decision's one check (`requireSameTalkSet`) to a wake whose target is not the caller; a self-wake is not judged.
