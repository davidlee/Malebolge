# DEC-070: A per-pairing budget of 10 bridge-started SATAN turns, refilled by the operator's input on either side

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


## Refinements

- Refined by DEC-078 (operator, 2026-10-29): "in its submit commit" is not buildable, because pi-durable's submit takes no transaction. The spend is its own commit just before the submit; it reads tx.submissionByRequest, so a duplicate spends nothing. A crash or failed submit between the two costs one unit with no turn.
