# IMP-018: Emacs client: create a conversation in a named topic

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

`malebolge-attach` (`emacs/malebolge.el`) opens root, a listed conversation
id, or `new`; `new` passes `--new --emacs`, so the conversation lands in
`default`. Since SL-005 a topic carries a toolset (`--set-topic NAME
--toolset mail`), so the only way to start a mail conversation is the shell:
`attach-main.ts --topic mail --new`, then `C-u M-x malebolge-attach` on its
id.

Wanted: choosing `new` also offers a topic, completed from `--topics`
(`NAME\tDIR\tTOOLSET`), and passes `--topic NAME --new`. Optionally show each
conversation's topic in the chooser. Creating or editing topics stays in the
CLI.

Found during SL-005 VH-1 (2026-10-28). `emacs/malebolge.el` had another
writer at the time, so it was left alone. Related: IMP-014 (one buffer per
conversation).
