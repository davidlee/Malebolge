`doctrine slice conformance` folds each phase's recorded source delta, a
commit range from `code_start_oid` to its end (open-ended for the last
phase). When another session commits to the same branch inside that range,
its paths appear as **undeclared**. SL-011 PHASE-08 swept 54 SL-012 paths
this way (RV-031 F-7).

No verb excludes interleaved commits. An explicit end oid still spans them.

How to apply:
- In an audit, split the undeclared cell by owner first. Read the handover's
  or notes' "leave alone" list.
- Disposition the other session's paths as registry noise (tolerated, with
  rationale).
- Judge only this slice's own undeclared paths as findings.
- To avoid the noise, run concurrent sessions on separate branches or
  worktrees.
