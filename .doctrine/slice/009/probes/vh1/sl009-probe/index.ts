/**
 * SL-009 PHASE-01 VH-1 probe stub (throwaway; never under src/ or pi-bridge/).
 * EX-3 (ASM-007): imports typebox with no node_modules and registers a TypeBox tool.
 * EX-4 (ASM-008, RV-021 F-6): replaces bash via createBashTool's spawnHook, which sets
 *   SL009_PROBE=1 and prepends this directory to PATH.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HERE = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "sl009_echo",
    label: "SL-009 echo",
    description: "Echo a message back (SL-009 probe).",
    parameters: Type.Object({ message: Type.String({ description: "text to echo" }) }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `sl009:${params.message}` }], details: {} };
    },
  });

  const bash = createBashTool(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: { ...env, SL009_PROBE: "1", PATH: `${HERE}:${env.PATH ?? ""}` },
    }),
  });
  pi.registerTool({
    ...bash,
    execute: async (id, params, signal, onUpdate) => bash.execute(id, params, signal, onUpdate),
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(`sl009-probe loaded from ${HERE}`, "info");
  });
}
