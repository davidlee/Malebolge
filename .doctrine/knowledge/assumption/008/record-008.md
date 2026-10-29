Basis: pi's example extension
`.doctrine/state/slice/009/research-context/pi-ext-examples/bash-spawn-hook.ts`
re-registers `bash` built with `createBashTool(cwd, { spawnHook })`, whose hook
returns `{ command, cwd, env }`. Cost to note: the extension replaces the
built-in bash tool rather than decorating it, so the replacement must track the
built-in's options.

Underpins DEC-075: malebolge-bridge send reads its pairing from that env.

## Validation (2026-10-29)

Probed by the operator in a real pi jail, 2026-10-29 (SL-009 PHASE-01 VH-1; kit `.doctrine/slice/009/probes/vh1/sl009-probe/`, runbook in SL-009 notes.md § Probes). Through the createBashTool spawnHook replacement:
`cd /tmp && echo $SL009_PROBE && sl009-hello && ls -d "$PWD" && echo ok >&2; exit 3`
printed `1`, `sl009-hello ran: SL009_PROBE=1 cwd=/tmp` and `/tmp` on stdout,
`ok` on stderr, and reported exit code 3: the variable is set, the stub
directory is on PATH from another cwd, and the built-in's stdout/stderr/exit
behaviour is kept (RV-021 F-6).
