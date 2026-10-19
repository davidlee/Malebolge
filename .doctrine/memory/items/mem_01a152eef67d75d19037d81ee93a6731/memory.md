Cloudflare's `agents` npm package (checked `agents@0.28.1`, 2026-10-19) cannot be
imported by the malebolge daemon, which runs on plain Node:

- `agents/skills` statically imports `{ RpcTarget } from "cloudflare:workers"`.
- `agents/harness/pi` (the pi-durable adapter exporting `skills()`) pulls in
  `cloudflare:workers` via its shared lifecycle chunk, not via anything skill-related.
- `cloudflare:workers` is supplied only by the Workers runtime (workerd / Miniflare);
  Node rejects the `cloudflare:` URL scheme at module load.

Evidence: source inspection of the published tarball (`npm pack agents@0.28.1`,
`grep -l "cloudflare:" dist/...`). Not confirmed by a clean runtime import.

Consequence: its pi skills extension (`skills()`, `fromManifest`,
`activate_skill` / `read_skill_resource` tools) can't be used as a dependency.
Options were vendoring the ~180-line adapter or stubbing `cloudflare:workers`
with a Node loader hook; neither was worth it. Our own `src/skills.ts` (SL-024)
was compared against it and kept: it follows pi 1.3.0 coding-agent rules, and theirs
has defects (`disable-model-invocation` read from `metadata.*` instead of
top level, uncaught YAML errors, no BOM handling, partial XML escaping).

Re-check if a later `agents` release splits out a runtime-neutral entry point.
