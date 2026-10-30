# DEC-049: Mail tools refuse every call when the daemon's process can reach the network

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->



## Reconciled 2026-10-30 (SL-007, RV-028 F-4)

The choice's mechanism narrowed from /sys/class/net to /proc/net/dev: a sysfs bound into a --unshare-net jail reflects the host's network namespace, while /proc/net/dev lists the reading process's own. The decision itself is unchanged.