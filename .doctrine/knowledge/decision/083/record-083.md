# DEC-083: A topic model the catalog does not know refuses creation in that topic, inside the creating commit

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


Applied in SL-010 design §4 (review round 1, operator assent to OQ-1: "recommended on all"): at daemon start, the heartbeat create in a wake topic whose stored model the catalog lacks is refused and logged, no heartbeat is created, and the daemon serves. Every other heartbeat failure still aborts the start.
