// The two results a daemon tool answers with: JSON the model reads, or a refusal
// that says why the call did nothing. Shared by the wake and thread tools.

import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** A result the model reads as JSON. */
export const answer = (value: object): ToolExecutionResult => ({
  output: [{ type: "text", text: JSON.stringify(value) }],
});

/** A refusal: the call did nothing. */
export const refusal = (text: string): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  isError: true,
});
