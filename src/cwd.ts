// The daemon's working directory as a system prompt section, worded as pi's
// coding-agent states it.

import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

export const cwdExtension = (cwd: string): Extension => {
  const text = `Current working directory: ${cwd}`;
  return defineExtension({
    name: "cwd",
    sections: [section("cwd", () => text, { tag: false })],
  });
};
