A reconciliation brief that names "REV amend DEC-NNN" names a surface that does
not exist. `doctrine revision change add --action modify --target DEC-009` is
refused:

    Error: `revises` target must be one of [SPEC, PRD, REQ, ADR, POL, STD], got a DEC

The revision kind's target set is governance/spec truth only. Decisions (and ASM /
QUE / CON, the other knowledge records) are amended as prose, exactly like the
slice's own artefacts:

    doctrine knowledge edit DEC-NNN --body - --body-mode append   # append an "## Amendments (date, why)" section

Ship the amendment with a heading that names the date and the RV finding that drove
it (`## Amendments (2026-10-24, reconciliation after RV-007 F-1)`), so a later reader
sees which claim was retired and by what evidence.

If a REV was created before the refusal was discovered: `doctrine revision status
REV-N abandoned`. A row-less revision in `started` is a half-applied pass that the
close gate will ask about; abandoning it leaves nothing to discharge.

The upstream lesson is for `/audit`: when a finding's remediation is "amend an
accepted decision", the brief's surface is a **direct prose edit to the knowledge
record**, not a REV.
