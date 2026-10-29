# DEC-027: mail_new is stateless: cursor in, next out; no exclude list

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->



Narrowed by DEC-057, DEC-062 (SL-007 lock): an in-memory classification cache and a reported set sit below the tools; neither is caller state, and neither changes a page's selection or next.