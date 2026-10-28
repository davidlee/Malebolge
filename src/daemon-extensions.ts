// The extensions this module can build, by name. Their order in a conversation is
// the catalogue's (src/toolsets.ts), so it lives there once rather than here.

import type { Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Profile } from "./config.ts";
import { conversationExtension } from "./conversation-context.ts";
import { cwdExtension } from "./cwd.ts";
import { grepExtension } from "./grep.ts";
import { personaExtension } from "./persona.ts";
import { projectContextExtension } from "./project-context.ts";
import { type Skill, skillsExtension } from "./skills.ts";
import { allowedNames, type DaemonToolset, requireInstalled } from "./toolsets.ts";

export interface DaemonParts {
  /** A toolset's persona files, in order; the daemon passes `personaFiles` bound to its corpus. */
  personaFiles: (toolset: DaemonToolset) => readonly string[];
  /** Rendered project context, read once at startup; `undefined` when there is none. */
  projectContext: string | undefined;
  skills: readonly Skill[];
  profile: Profile;
  /** The room's `tasks` extension (wakes); the host never installs it (W10). */
  tasks: Extension;
  /** The room's `threads` extension; the host never installs it (W10). */
  threads: Extension;
  /** The mail extension; absent when the profile does not allow mail. */
  mail?: Extension;
}

/** One builder per name this module can construct; a name absent here is a catalogue error. */
const builders = (parts: DaemonParts): ReadonlyMap<string, () => Extension> => {
  const byName = new Map<string, () => Extension>([
    ["persona", (): Extension => personaExtension("persona", parts.personaFiles("interactive"))],
    ["mail-persona", (): Extension => personaExtension("mail-persona", parts.personaFiles("mail"))],
    ["project_context", (): Extension => projectContextExtension(parts.projectContext)],
    ["skills", (): Extension => skillsExtension(parts.skills)],
    ["cwd", (): Extension => cwdExtension],
    ["conversation", (): Extension => conversationExtension],
    ["coding-tools", (): Extension => CodingTools],
    ["grep", (): Extension => grepExtension],
    ["tasks", (): Extension => parts.tasks],
    ["threads", (): Extension => parts.threads],
  ]);
  // A room start without it is refused by `requireInstalled` rather than left unbuilt.
  const { mail } = parts;
  if (mail !== undefined) {
    byName.set("mail", () => mail);
  }
  return byName;
};

/** `name`'s extension; `requireInstalled` has already refused a name nothing builds. */
const build = (byName: ReadonlyMap<string, () => Extension>, name: string): Extension => {
  const builder = byName.get(name);
  if (builder === undefined) {
    throw new Error(`extension ${name} is not installed`);
  }
  return builder();
};

// Scope: persona, project context and skills are per profile; `cwd` is per
// conversation. Accepted inconsistency (research X-6, DEC-080): a conversation created with
// another `cwd` states that directory and runs its tools there, while its
// project context was read once from the daemon's directory.
export const daemonExtensions = (parts: DaemonParts): Extension[] => {
  const byName = builders(parts);
  const names = allowedNames(parts.profile);
  requireInstalled(names, new Set(byName.keys()));
  return names.map((name) => build(byName, name));
};
