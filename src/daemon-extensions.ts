// The daemon's extensions in system prompt order. Section order is the order
// of this list, so it lives here once rather than in the daemon's entry script.

import type { Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { cwdExtension } from "./cwd.ts";
import { grepExtension } from "./grep.ts";
import { personaExtension } from "./persona.ts";
import { projectContextExtension } from "./project-context.ts";
import { type Skill, skillsExtension } from "./skills.ts";

export interface DaemonParts {
  personaFiles: readonly string[];
  /** Rendered project context, read once at startup; `undefined` when there is none. */
  projectContext: string | undefined;
  skills: readonly Skill[];
  cwd: string;
  /** SATAN's tools (needs the live MCP socket, so supplied by the caller). */
  satan: Extension;
}

export const daemonExtensions = (parts: DaemonParts): Extension[] => [
  personaExtension(parts.personaFiles),
  projectContextExtension(parts.projectContext),
  skillsExtension(parts.skills),
  cwdExtension(parts.cwd),
  CodingTools,
  grepExtension,
  parts.satan,
];
