# IMP-003: Share one fake-daemon fixture between attach tests and the Emacs smoke

<!-- Backlog item body — context, detail, links. The structured, queried fields
     live in the sister `backlog-NNN.toml`; this prose is free-form and is never
     structurally parsed (the storage rule). -->

From RV-004 F-6 (SL-001 audit). `test/emacs-attach-smoke.ts` builds its own
scripted fake daemon on `serveUnix`, separate from `test/attach.test.ts`'s.
Extract one fixture (attach reply, snapshot/entry builders, scripted
streaming, frame recorder) into `test/fixtures.ts` so the two cannot drift
from the daemon independently.
