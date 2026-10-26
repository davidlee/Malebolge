Observed with pi-durable 1.4.0, faux provider (satan SL-032 PHASE-07 VA-1 probe):
a turn whose step 1 tool call triggers `registry.install` of a new tool set.

- Fire-and-forget refresh: step 2 calling a newly installed tool gets
  "Tool X is not available".
- Refresh landed (6 ms) while step 2's model call was still pending: still
  "not available". The step's tool set was fixed before the model call.
- Step 3: the new tool works. The registry is re-read per step, not per turn.

Consequence: to make the very next step see a refreshed tool set, the tool call
that triggers the refresh must await it before returning its result. That is
what `satan-tools.ts` `withConnection` does for a new pool entry's first call.
