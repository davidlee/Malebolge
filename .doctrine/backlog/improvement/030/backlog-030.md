# IMP-030: SATAN's bridge environment forbids comparing files with pi; align with pi's commit-named shared-reference rule

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

`src/bridge/extension.ts:37` (`BRIDGE_ENVIRONMENT`) tells SATAN "Do not compare files or commits with pi; ask it to read or run what you need." pi's in-use feedback (SL-011, 2026-10-30) showed paths worked as shared references when both sides named their commit; pi's side now says so (`pi-bridge/posture.ts`, ffb8d61). Proposed SATAN text: "A path is a shared reference only with the commit pi names; when it matters that your copy is current, ask pi to check." Awaiting operator yes/no.

## Resolution (2026-10-30)

The operator chose the text: option 2 from the SL-011 reconcile, amended with "(and you have it)". `BRIDGE_ENVIRONMENT` now says: "A path and line from pi are a shared reference only when pi names its commit (and you have it); otherwise, or when the answer depends on current code, ask pi to read or run what you need rather than reasoning from your copy." It replaces "Do not compare files or commits with pi; …". The existing sentence about the room's older snapshot stays. Landed with SL-011 as an operator-directed prompt change (design sec-7).
