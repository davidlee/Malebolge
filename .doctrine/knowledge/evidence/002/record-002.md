
Spike for SL-006 inq-2 (research X-3). Throwaway test, deleted after the run.

Entries seen by the tool, newest first: 11 `pi.assistant`, 10 `pi.system`,
7 `pi.user`. Fork at 11 gave child 13 with the same three entries; the model
context gained the synthetic tool result for `call-1`. Submitting "hello
child" to 13 produced `{status: "done"}` and the scripted answer.

Not tested: an assistant message with several parallel tool calls; a fork
taken after compaction; the parent's own continuation (it finished normally).
