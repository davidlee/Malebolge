Basis, read in pi's source (`~/.local/src/pi/packages/coding-agent/src/core/`):

- `agent-session.ts:2370-2400`: queued paths (`nextTurn`, `followUp`/`steer`
  while streaming) hold the message in memory; `sendCustomMessage` returns
  `Promise<void>`.
- `agent-session.ts:2402-2420`: the direct path appends the entry before
  emitting, and emits only to public listeners, not extension events.
- `agent-session.ts:1143-1155`: agent-loop messages persist on `message_end`,
  after the extension emit. So the extension's `message_end` is not the
  observation point on every path.
- `session-manager.ts:1160-1185`: no session file is written before the first
  user or assistant message (the DEC-065 residual).

From SL-009 inquiry review r1, F-2.


## Validation (SL-009 PHASE-01 EX-1, 2026-10-29)

Probed against real pi 1.4.0 (source 936e5f40a), rpc mode, stub extension with a
fake provider; evidence and rerun in `.doctrine/slice/009/probes/va1/` (`ex1`),
summary in SL-009 notes.md § Probes. Scope as narrowed by DEC-090 (idle paths only):

- `sendMessage(…, {triggerTurn:false})` while idle: the entry, with `details`, is in
  `ctx.sessionManager.getEntries()` synchronously when sendMessage returns.
- `sendMessage(…, {triggerTurn:true})` while idle: absent at return and after a
  microtask; present, with `details`, at the consuming `turn_end`.

Both within the claim ("once sendMessage returns, or at the latest by the consuming
turn_end"). The busy paths (followUp, nextTurn) are out of scope under DEC-090: the
extension never hands pi a message while it runs.
