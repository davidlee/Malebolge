// The closed catalogue of extension sets, by run kind (design §2; DEC-029): data,
// so a name outside it does not compile, and pure functions, so the daemon, the
// runner and their tests read one order.

import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { Profile } from "./config.ts";

/** A run kind. The daemon builds its own; the runner selects `job` in code. */
export type Toolset = "interactive" | "mail" | "job";

/** What a daemon may install, profile by profile. */
export type DaemonToolset = Exclude<Toolset, "job">;

/** A profile's toolset policy: what a new conversation takes, and what it may (design sec-3). */
export interface ProfileToolsets {
  readonly default: DaemonToolset;
  readonly allowed: readonly DaemonToolset[];
}

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
export function toolsetList(toolset: "job"): readonly string[];
export function toolsetList(toolset: Toolset, profile: Profile): readonly string[];
export function toolsetList(toolset: Toolset, profile?: Profile): readonly string[] {
  const names = CATALOG[toolset];
  return profile === "host" ? names.filter((name) => !ROOM_ONLY.has(name)) : names;
}

/**
 * `configure`'s selection of `names` (design sec-3): pi-durable stores a selection as
 * its names (dist/harness/agent.js:111-118), so a name-only reference stands for the
 * installed extension of that name — and for nothing when none is installed.
 */
export function selectionOf(names: readonly string[]): Extension[] {
  return names.map((name) => defineExtension({ name }));
}

/**
 * Each profile's default toolset and the ones it may use. STAGING: the design's
 * end state lets the room use `mail` too; PHASE-08 adds it, with its manifest.
 */
export const PROFILE_TOOLSETS: Readonly<Record<Profile, ProfileToolsets>> = {
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

/**
 * Refuse `toolset` when `policy` does not allow it, naming `subject` when given
 * (`topic inbox: toolset mail is not allowed on profile host`). The policy is
 * code, so only a code change causes this and only a code change remedies it
 * (design sec-3): a caller refuses rather than widens the toolset silently.
 */
export function requireAllowed(
  toolset: DaemonToolset,
  profile: Profile,
  policy: ProfileToolsets = PROFILE_TOOLSETS[profile],
  subject?: string,
): void {
  if (!policy.allowed.includes(toolset)) {
    const refusal = `toolset ${toolset} is not allowed on profile ${profile}`;
    throw new Error(subject === undefined ? refusal : `${subject}: ${refusal}`);
  }
}

/** Refuses the first static name of `names` that `installed` lacks: a catalogue error. */
export function requireInstalled(names: readonly string[], installed: ReadonlySet<string>): void {
  for (const name of names) {
    if (name !== SATAN && !installed.has(name)) {
      throw new Error(`extension ${name} is not installed`);
    }
  }
}
