Basis: pi's example extension
`.doctrine/state/slice/009/research-context/pi-ext-examples/bash-spawn-hook.ts`
re-registers `bash` built with `createBashTool(cwd, { spawnHook })`, whose hook
returns `{ command, cwd, env }`. Cost to note: the extension replaces the
built-in bash tool rather than decorating it, so the replacement must track the
built-in's options.

Underpins DEC-075: malebolge-bridge send reads its pairing from that env.
