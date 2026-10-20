// The conversation's working directory as a system prompt section, read from
// its agent, worded as pi's coding-agent states it.

import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

export const cwdExtension: Extension = defineExtension({
  name: "cwd",
  sections: [
    section(
      "cwd",
      ({ agent }) =>
        agent.cwd === undefined ? undefined : `Current working directory: ${agent.cwd}`,
      { tag: false },
    ),
  ],
});
