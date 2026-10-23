# EVD-001: pi-durable queues input to a busy conversation, so the user turn follows the answer

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->

Source: the `Conversation.submit` docs in pi-durable 1.3.0,
`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:595`: "A busy
conversation, or one with queued items, queues input and writes that affect
model context in `pi.inbox`". The daemon passes `input` to `conversation.submit`
(`src/daemon.ts:76-88`), so a draft submitted mid-answer is echoed as a user
`message_end` at a boundary, not between the answer's deltas.

This rests on API documentation, not a live-daemon trace. The `whenBusy` option
(`steer | followUp | reject`) sets the boundary. Relied on by
`test/emacs-attach-smoke.ts` and SL-001 design sec-4 (RV-004 F-2, F-3).
