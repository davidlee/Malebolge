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
}

// Scope: persona, project context and skills are per profile; `cwd` is per
// conversation. Accepted inconsistency (research X-6, DEC-080): a conversation created with
// another `cwd` states that directory and runs its tools there, while its
// project context was read once from the daemon's directory.
export const daemonExtensions = (parts: DaemonParts): Extension[] => [
  personaExtension(parts.personaFiles),
  projectContextExtension(parts.projectContext),
  skillsExtension(parts.skills),
  cwdExtension,
  CodingTools,
  grepExtension,
];
