Probed against real pi 1.4.0 (source 936e5f40a), rpc mode, fake provider (SL-009 PHASE-01; rig `.doctrine/slice/009/probes/va1/`, evidence in SL-009 notes.md § Probes; ASM-004).

- `pi.sendMessage(…, {triggerTurn: true})` makes `ctx.isIdle()` false synchronously, before `agent_start`. Guard injection on `isIdle()`, not on your own running flag from `agent_start`.
- An abort during a slow `before_agent_start` handler waits for the handler to return — keep that handler fast.
- `agent_end` can fire before a retry (`auto_retry_start`, new `agent_start`); `agent_settled` fires once, last, with `aborted`. Flush only on settle.
- A turn sent from inside the `agent_settled` handler is deferred by pi and starts a fresh run with its own `agent_settled`.
- `clearQueue` on abort drops queued extension messages (DEC-090): buffer in the extension, never queue in pi while it runs.
