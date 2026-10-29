// SL-009 design sec-7: the extension entry pi loads from
// ~/.pi/agent/extensions/malebolge-bridge/index.ts (DEC-074 clause 3).
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { notifyDesktop } from "./notices.ts";
import { bridgeExtension } from "./shell.ts";

export default bridgeExtension({
  env: process.env,
  extensionDir: dirname(fileURLToPath(import.meta.url)),
  notifyDesktop,
});
