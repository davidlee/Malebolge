// SL-005 PHASE-01: the toolset catalogue (design sec-2; DEC-029, DEC-030). The
// interactive list is pinned against the baseline captured before the change
// (test/fixtures/interactive-baseline.json, read via ./interactive-baseline.ts), so
// the catalogue cannot quietly alter what a new conversation sees.

import { readFileSync } from "node:fs";
import type { Extension } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { Profile } from "../src/config.ts";
import { daemonExtensions } from "../src/daemon-extensions.ts";
import { isRecord } from "../src/json.ts";
import { mailExtension } from "../src/mail/extension.ts";
import { personaFiles } from "../src/persona.ts";
import {
  allowedNames,
  type DaemonToolset,
  PROFILE_TOOLSETS,
  requireInstalled,
  SATAN,
  toolsetList,
} from "../src/toolsets.ts";
import { tasksExtension, wakeBinding } from "../src/wake/extension.ts";
import { fakeMailSource } from "./mail/mail-fixtures.ts";
import {
  BASELINE_CORPUS,
  BASELINE_PATH,
  BASELINE_PROJECT_CONTEXT,
  BASELINE_SKILL,
  type InteractiveSnapshot,
  interactiveSnapshot,
} from "./interactive-baseline.ts";

const PROFILES: readonly Profile[] = ["room", "host"];

/** The toolsets a daemon installs; the runner's `job` is selected elsewhere. */
const DAEMON_TOOLSETS: readonly DaemonToolset[] = ["interactive", "mail"];

/**
 * One profile's frozen baseline. It also records `registry`, the names the
 * pre-SL-005 `daemonExtensions` returned; no snapshot states a registry, so it is
 * not compared.
 */
interface BaselineProfile {
  readonly extensions: readonly string[];
  readonly sections: unknown;
  readonly tools: readonly string[];
}

interface Baseline {
  readonly sourceCommit: string;
  readonly profiles: Readonly<Record<Profile, BaselineProfile>>;
}

/** `value`, when it is an array of strings, or a refusal naming `what`. */
function stringArray(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`baseline ${what} is not an array`);
  }
  const items: readonly unknown[] = value;
  return items.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`baseline ${what} holds a non-string`);
    }
    return item;
  });
}

/** The written baseline. It is JSON, so it is read and checked rather than trusted. */
function readBaseline(): Baseline {
  const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("baseline is not an object");
  }
  const { sourceCommit, profiles } = parsed;
  if (typeof sourceCommit !== "string" || !isRecord(profiles)) {
    throw new Error("baseline lacks sourceCommit or profiles");
  }
  const partsOf = (profile: Profile): BaselineProfile => {
    const entry = profiles[profile];
    if (!isRecord(entry)) {
      throw new Error(`baseline has no ${profile} profile`);
    }
    return {
      extensions: stringArray(entry["extensions"], `${profile} extensions`),
      sections: entry["sections"],
      tools: stringArray(entry["tools"], `${profile} tools`),
    };
  };
  return { sourceCommit, profiles: { room: partsOf("room"), host: partsOf("host") } };
}

const BASELINE = readBaseline();

/** A baseline profile as a snapshot: the same parts, copies rather than the parsed arrays. */
const expectedSnapshot = ({
  extensions,
  sections,
  tools,
}: BaselineProfile): InteractiveSnapshot => ({
  extensions: [...extensions],
  sections,
  tools: [...tools],
});

/** The interactive extensions as the daemon builds them, out of the room's whole union. */
const extensionsOf = (profile: Profile): Extension[] => {
  const interactive = new Set(toolsetList("interactive", profile));
  return daemonExtensions({
    personaFiles: (toolset) => personaFiles(BASELINE_CORPUS, toolset, profile),
    projectContext: BASELINE_PROJECT_CONTEXT,
    skills: [BASELINE_SKILL],
    profile,
    tasks: tasksExtension(wakeBinding().deps),
    ...(profile === "room"
      ? { mail: mailExtension({ source: fakeMailSource(), now: () => 0 }) }
      : {}),
  }).filter(({ name }) => interactive.has(name));
};

/** What a new interactive conversation offers on `profile`. */
const snapshotOf = (profile: Profile): Promise<InteractiveSnapshot> =>
  interactiveSnapshot(extensionsOf(profile));

/** The catalogue's union: each allowed toolset in order, deduplicated, SATAN left out. */
const unionOf = (profile: Profile): string[] => {
  const names: string[] = [];
  for (const toolset of PROFILE_TOOLSETS[profile].allowed) {
    for (const name of toolsetList(toolset, profile)) {
      if (name !== SATAN && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
};

describe("toolset catalogue", () => {
  it("VT-1: a new interactive conversation is the frozen baseline, profile for profile", async () => {
    for (const profile of PROFILES) {
      const snapshot = await snapshotOf(profile);
      expect(snapshot).toEqual(expectedSnapshot(BASELINE.profiles[profile]));
      // SATAN's tools arrive by discovery, so the static list names no `satan`.
      expect(snapshot.extensions).toEqual(
        toolsetList("interactive", profile).filter((name) => name !== SATAN),
      );
    }
  });

  it("VT-1 negative control: dropping the tasks extension no longer matches the baseline", async () => {
    const withoutTasks = extensionsOf("room").filter(({ name }) => name !== "tasks");
    expect(await interactiveSnapshot(withoutTasks)).not.toEqual(
      expectedSnapshot(BASELINE.profiles.room),
    );
  });

  it("VT-1 provenance: the baseline names the commit it was captured at", () => {
    expect(BASELINE.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("VT-2: mail offers a conversation and mail tools, and no coding tool", () => {
    for (const profile of PROFILES) {
      const mail = toolsetList("mail", profile);
      expect(mail).toEqual(["mail-persona", "conversation", "mail"]);
      for (const absent of ["coding-tools", "grep", SATAN, "tasks"]) {
        expect(mail).not.toContain(absent);
      }
      for (const toolset of DAEMON_TOOLSETS) {
        expect(toolsetList(toolset, profile)).toContain("conversation");
      }
    }
  });

  it("VT-2: satan is last in interactive, and only the room installs tasks", () => {
    for (const profile of PROFILES) {
      expect(toolsetList("interactive", profile).at(-1)).toBe(SATAN);
    }
    expect(toolsetList("interactive", "room")).toContain("tasks");
    expect(toolsetList("interactive", "host")).not.toContain("tasks");
  });

  it("VT-2: the job list is the runner's two extensions, whatever the profile", () => {
    for (const profile of PROFILES) {
      expect(toolsetList("job", profile)).toEqual(["job-tools", "job-guard"]);
    }
  });

  it("VT-2: allowedNames is the allowed union in order, without the discovered tool", () => {
    for (const profile of PROFILES) {
      expect(allowedNames(profile)).toEqual(unionOf(profile));
      expect(allowedNames(profile)).not.toContain(SATAN);
    }
  });

  it("VT-2: a host installs no mail, so its registry holds no mail tool", () => {
    expect(PROFILE_TOOLSETS.host.allowed).not.toContain("mail");
    expect(allowedNames("host")).not.toContain("mail-persona");
    expect(allowedNames("host")).not.toContain("mail");
  });

  it("VT-2: requireInstalled exempts satan and names the first missing static extension", () => {
    expect(() => {
      requireInstalled(["persona", "grep", SATAN], new Set(["persona", "grep"]));
    }).not.toThrow();
    expect(() => {
      requireInstalled(["persona", "grep"], new Set(["persona"]));
    }).toThrow(/extension grep is not installed/);
  });

  it("VT-2: every profile defaults to interactive, within the set it allows", () => {
    for (const profile of PROFILES) {
      expect(PROFILE_TOOLSETS[profile].default).toBe("interactive");
      expect(PROFILE_TOOLSETS[profile].allowed).toContain(PROFILE_TOOLSETS[profile].default);
    }
  });
});
