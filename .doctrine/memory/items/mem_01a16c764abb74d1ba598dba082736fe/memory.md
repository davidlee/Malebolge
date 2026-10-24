Observed twice on 2026-10-24 (SL-003 design run, doctrine as installed that
day; run revisions 38 and 42).

`doctrine design apply` takes an optional top-level `acceptance: {basis}`
beside `declare`, `stage` and `checkpoint_act`. It is not a basis for the
submission's other contents: whenever it is present, the run records (or
re-records) the `design-accepted` act with `authority = "user"` and that
basis.

- Rev 38: a submission declaring only adversarial-lane `att-` attestations
  carried `acceptance` meant as their basis. The run logged
  `act_recorded cpa-design-accepted`, and `user-acceptance-attested`
  dropped out of the unmet list.
- Rev 42: a `stage: {to: reviewing}` regression carried `acceptance`
  quoting the user's request for an amendment. Same result.

The reviewing fragment's lock example shows `acceptance` beside
`checkpoint_act: design-accepted`, which reads like a general basis field.
It is not one.

Consequences and recovery:

- Recording `review-disposed` does **not** stale the false act.
- Changing any section does: rev 43 logged `act_invalidated`, because an
  acceptance binds the section fingerprints. So does the real lock
  submission, which re-records the act with the user's actual words.

How to apply: put a submission's basis in `reason` (stage, discharge) or in
the act's own `checkpoint_act.acceptance`. Add top-level `acceptance` only
in the final lock submission, after the user has accepted the design. If a
false act is recorded, say so to the user and confirm it is invalidated
before the lock.
