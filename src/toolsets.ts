// The closed catalogue of extension sets, by run kind (design §2; DEC-029): data,
// so a name outside it does not compile, and pure functions, so the daemon, the
// runner and their tests read one order.

import type { Profile } from "./config.ts";

/** A run kind. The daemon builds its own; the runner selects `job` in code. */
export type Toolset = "interactive" | "mail" | "job";

/** What a daemon may install, profile by profile. */
export type DaemonToolset = Exclude<Toolset, "job">;

/** The catalogue's one dynamic member: discovery installs it before the session resumes. */
export const SATAN = "satan";

/** Names in system prompt and tool order. `job` ignores the profile: the runner picks it. */
const CATALOG: Readonly<Record<Toolset, readonly string[]>> = {
  interactive: [
    "persona",
    "project_context",
    "skills",
    "cwd",
    "conversation",
    "coding-tools",
    "grep",
    "tasks",
    SATAN,
  ],
  mail: ["mail-persona", "conversation", "mail"],
  job: ["job-tools", "job-guard"],
};

/** Room only: `tasks` wakes, which a host never installs (W10). */
const ROOM_ONLY: ReadonlySet<string> = new Set(["tasks"]);

/** `toolset`'s extension names on `profile`, in system prompt and tool order. */
export function toolsetList(toolset: Toolset, profile: Profile): readonly string[] {
  const names = CATALOG[toolset];
  return profile === "host" ? names.filter((name) => !ROOM_ONLY.has(name)) : names;
}

/**
 * Each profile's default toolset and the ones it may use. STAGING: the design's
 * end state lets the room use `mail` too; PHASE-08 adds it, with its manifest.
 */
export const PROFILE_TOOLSETS: Readonly<
  Record<Profile, { readonly default: DaemonToolset; readonly allowed: readonly DaemonToolset[] }>
> = {
  room: { default: "interactive", allowed: ["interactive"] },
  host: { default: "interactive", allowed: ["interactive"] },
};

/** The names a daemon on `profile` must install: the allowed union, `SATAN` left out. */
export function allowedNames(profile: Profile): string[] {
  const names = PROFILE_TOOLSETS[profile].allowed.flatMap((toolset) =>
    toolsetList(toolset, profile),
  );
  return [...new Set(names)].filter((name) => name !== SATAN);
}

/** Refuses the first static name of `names` that `installed` lacks: a catalogue error. */
export function requireInstalled(names: readonly string[], installed: ReadonlySet<string>): void {
  for (const name of names) {
    if (name !== SATAN && !installed.has(name)) {
      throw new Error(`extension ${name} is not installed`);
    }
  }
}
