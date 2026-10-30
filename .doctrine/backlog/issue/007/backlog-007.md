# ISS-007: malebolge is not canonical for its own doctrine records: satan holds malebolge slices and decisions

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

Operator direction, 2026-10-30.

## Problem

malebolge has had its own doctrine corpus since 2026-10-23 (SL-001 onward),
but records that govern it still live in `~/dev/satan`: older malebolge
slices (satan:SL-023, SL-024, SL-026, SL-027), the mail-triage RFC
(satan:RFC-020), and decisions, specs and constraints cited from here.
malebolge's corpus cites them by `satan:<ID>` prose references, which
doctrine does not resolve, validate or show.

Evidence (grep of `.doctrine/`, 2026-10-30): 28 files, about 140
`satan:<ID>` references. Most cited: satan:RFC-020 (78), satan:SL-027 (30),
satan:IMP-035 (5), satan:RFC-019, satan:DEC-055 (4 each).

## Intent

- malebolge is canonical for records about malebolge.
- Foreign references are handled deliberately, by kind:
  - records that govern malebolge: migrate (or re-author) into malebolge's
    corpus, leaving a pointer in satan;
  - closed history (done slices): leave in satan, cite as legacy;
  - records genuinely about satan (e.g. panopticon, satan elisp tools):
    stay foreign, cited by a form a reader can follow.
- Check whether doctrine has a supported cross-corpus reference form before
  inventing a convention.

## Also review

The flake and quotient setup, to check the boundaries match: what each
repo's flake owns (IMP-004 local dev flake; CHR-006 bookmark rollout in
~/flakes), and quotient project forms (IMP-012), roots and sandbox reach.

## Open

- Inventory: which satan records are about malebolge, and which are live
  versus history.
- Migration mechanics: ids change on migration; how to keep satan-side
  links working.
