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
