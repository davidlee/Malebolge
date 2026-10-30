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
    "threads",
    "bookmarks",
    "bridge",
    SATAN,
  ],
  mail: ["mail-persona", "conversation", "mail"],
  job: ["job-tools", "job-guard"],
};

/**
 * Room only: `tasks` and `threads`, which a host never installs (W10), and `bridge`: the
 * bridge extension is the room's, and a host never installs it or builds-and-requires it
 * (SL-011 sec-2; DEC-100). `bookmarks` is not here: it is installed on both profiles,
 * refusing when unconfigured (DEC-055).
 */
const ROOM_ONLY: ReadonlySet<string> = new Set(["tasks", "threads", "bridge"]);

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

/** Each profile's default toolset and the ones it may use. */
export const PROFILE_TOOLSETS: Readonly<Record<Profile, ProfileToolsets>> = {
  room: { default: "interactive", allowed: ["interactive", "mail"] },
  host: { default: "interactive", allowed: ["interactive"] },
};

/** A set of toolsets that may talk to each other (design sec-11; DEC-032). */
export type TalkSet = "interactive";

/** Which talk set each toolset belongs to, profile by profile; absent means none (DEC-032). */
export const TALK_SETS: Readonly<Record<Profile, Partial<Record<DaemonToolset, TalkSet>>>> = {
  room: { interactive: "interactive" },
  host: {},
};

/**
 * The talk set `caller` and `target` share on `profile`, refusing when either has none or they
 * differ. `targetLabel` names the target in the refusal (`conversation 13`, `topic inbox`).
 * Start, fork, post and the wake reach check call it alike.
 */
export function requireSameTalkSet(
  profile: Profile,
  caller: DaemonToolset,
  target: DaemonToolset,
  targetLabel: string,
): TalkSet {
  const sets = TALK_SETS[profile];
  const callerSet = sets[caller];
  if (callerSet === undefined) {
    throw new Error(`toolset ${caller} has no talk set on profile ${profile}`);
  }
  if (sets[target] !== callerSet) {
    throw new Error(
      `${targetLabel} (toolset ${target}) is outside this conversation's talk set (${callerSet})`,
    );
  }
  return callerSet;
}

/** The names a daemon on `profile` must install: the allowed union, `SATAN` left out. */
export function allowedNames(profile: Profile): string[] {
  const names = PROFILE_TOOLSETS[profile].allowed.flatMap((toolset) =>
    toolsetList(toolset, profile),
  );
  return [...new Set(names)].filter((name) => name !== SATAN);
}

/**
 * `toolset` as `policy` allows it, refusing one it does not, naming `subject`
 * when given (`topic inbox: toolset mail is not allowed on profile host`). The
 * name arrives unchecked (a wire frame's, say), so this is the one place the
 * policy judges it. The policy is code, so only a code change causes this and
 * only a code change remedies it (design sec-3): a caller refuses rather than
 * widens the toolset silently.
 */
export function requireAllowed(
  toolset: string,
  profile: Profile,
  policy: ProfileToolsets = PROFILE_TOOLSETS[profile],
  subject?: string,
): DaemonToolset {
  const allowed = policy.allowed.find((name) => name === toolset);
  if (allowed === undefined) {
    const refusal = `toolset ${toolset} is not allowed on profile ${profile}`;
    throw new Error(subject === undefined ? refusal : `${subject}: ${refusal}`);
  }
  return allowed;
}

/** Refuses the first static name of `names` that `installed` lacks: a catalogue error. */
export function requireInstalled(names: readonly string[], installed: ReadonlySet<string>): void {
  for (const name of names) {
    if (name !== SATAN && !installed.has(name)) {
      throw new Error(`extension ${name} is not installed`);
    }
  }
}
