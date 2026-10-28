# DEC-042: A failed run starts the next run with the inputs queued behind it (afterFailedRun 'continue')

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


Consequence 2026-10-29 (design d2 review, Sol D-3; operator agreed): 'continue' covers failed runs (model_error, no_model), not faulted ones (malformed provider data, storage rejection; pi-durable ends those through endRun without placing queued inputs). A post queued behind a faulted run waits for the recipient's next input; the operator can abort it, which sends <post-failed>. Accepted residual.