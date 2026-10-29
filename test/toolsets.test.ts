// SL-005 PHASE-01: the toolset catalogue (design sec-2; DEC-029, DEC-030). The
// interactive list is pinned against the baseline captured before the change
// (test/fixtures/interactive-baseline.json, read via ./interactive-baseline.ts), so
// the catalogue cannot quietly alter what a new conversation sees.

import { readFileSync } from "node:fs";
import type { Extension } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { BOOKMARKS_SECTION } from "../src/bookmarks/extension.ts";
import type { Profile } from "../src/config.ts";
import { daemonExtensions } from "../src/daemon-extensions.ts";
import { isRecord } from "../src/json.ts";
import { mailExtension } from "../src/mail/extension.ts";
import { personaFiles } from "../src/persona.ts";
import { THREADS_SECTION, threadBinding, threadsExtension } from "../src/threads/extension.ts";
import {
  allowedNames,
  type DaemonToolset,
  PROFILE_TOOLSETS,
  requireInstalled,
  requireSameTalkSet,
  SATAN,
  TALK_SETS,
  type TalkSet,
  toolsetList,
} from "../src/toolsets.ts";
import { tasksExtension, wakeBinding } from "../src/wake/extension.ts";
import { bookmarksPart } from "./bookmarks/bookmark-fixtures.ts";
import {
  BASELINE_CORPUS,
  BASELINE_PATH,
  BASELINE_PROJECT_CONTEXT,
  BASELINE_SKILL,
  type InteractiveSnapshot,
  interactiveSnapshot,
} from "./interactive-baseline.ts";
import { fakeMailSource } from "./mail/mail-fixtures.ts";

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
    threads: threadsExtension(threadBinding().deps),
    bookmarks: bookmarksPart(),
    ...(profile === "room"
      ? { mail: mailExtension({ source: fakeMailSource(), now: () => 0 }) }
      : {}),
  }).filter(({ name }) => interactive.has(name));
};

/**
 * The extensions `profile` installs, less the two the baseline predates: threads
 * (PHASE-05) and bookmarks (PHASE-07).
 */
const withoutPostBaseline = (extensions: readonly Extension[]): Extension[] =>
  extensions.filter(({ name }) => name !== "threads" && name !== "bookmarks");

/** What a new interactive conversation offers on `profile`. */
const snapshotOf = (profile: Profile): Promise<InteractiveSnapshot> =>
  interactiveSnapshot(extensionsOf(profile));

/** A baseline profile's recorded prompt sections: the one object, keys in catalogue order. */
const promptSections = ({ sections }: BaselineProfile): Record<string, unknown> => {
  const records: readonly unknown[] = Array.isArray(sections) ? sections : [];
  const [record, ...others] = records;
  if (!isRecord(record) || others.length > 0) {
    throw new Error("a baseline profile's sections are one object");
  }
  return record;
};

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
      // The baseline predates threads (PHASE-05) and bookmarks (PHASE-07): compare without them.
      const snapshot = await interactiveSnapshot(withoutPostBaseline(extensionsOf(profile)));
      expect(snapshot).toEqual(expectedSnapshot(BASELINE.profiles[profile]));
      // SATAN's tools arrive by discovery, and the baseline predates those two extensions.
      expect(snapshot.extensions).toEqual(
        toolsetList("interactive", profile).filter(
          (name) => name !== SATAN && name !== "threads" && name !== "bookmarks",
        ),
      );
    }
  });

  it("VT-5: the room snapshot is the baseline plus exactly what threads and bookmarks add", async () => {
    const baseline = BASELINE.profiles.room;
    const afterTasks = baseline.extensions.indexOf("tasks") + 1;
    expect(afterTasks).toBeGreaterThan(0);
    const extensions = [...baseline.extensions];
    extensions.splice(afterTasks, 0, "threads");
    extensions.push("bookmarks");
    const baselineKeys = Object.keys(promptSections(baseline));

    const room = await snapshotOf("room");
    // Key order is prompt order, which toEqual ignores: threads then bookmarks come last.
    expect(Object.keys(promptSections(room))).toEqual([...baselineKeys, "threads", "bookmarks"]);
    expect(room).toEqual({
      extensions,
      // Catalogue order puts the tagged section after every earlier extension's.
      sections: [
        {
          ...promptSections(baseline),
          threads: `<threads>\n${THREADS_SECTION}\n</threads>`,
          bookmarks: `<bookmarks>\n${BOOKMARKS_SECTION}\n</bookmarks>`,
        },
      ],
      // The wake tools are the baseline's last; the thread tools follow them, bookmarks last.
      tools: [
        ...baseline.tools,
        "thread_post",
        "thread_start",
        "thread_fork",
        "bookmarks_search",
        "bookmarks_tags",
        "bookmarks_folders",
      ],
    });

    // The host installs no tasks or threads: it is the baseline plus bookmarks alone.
    const hostBaseline = BASELINE.profiles.host;
    const host = await snapshotOf("host");
    expect(Object.keys(promptSections(host))).toEqual([
      ...Object.keys(promptSections(hostBaseline)),
      "bookmarks",
    ]);
    expect(host).toEqual({
      extensions: [...hostBaseline.extensions, "bookmarks"],
      sections: [
        {
          ...promptSections(hostBaseline),
          bookmarks: `<bookmarks>\n${BOOKMARKS_SECTION}\n</bookmarks>`,
        },
      ],
      tools: [...hostBaseline.tools, "bookmarks_search", "bookmarks_tags", "bookmarks_folders"],
    });
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

  it("VT-2: mail offers a conversation and mail tools, and no coding, thread or bookmark tool", () => {
    for (const profile of PROFILES) {
      const mail = toolsetList("mail", profile);
      expect(mail).toEqual(["mail-persona", "conversation", "mail"]);
      for (const absent of ["coding-tools", "grep", SATAN, "tasks", "threads", "bookmarks"]) {
        expect(mail).not.toContain(absent);
      }
      for (const toolset of DAEMON_TOOLSETS) {
        expect(toolsetList(toolset, profile)).toContain("conversation");
      }
    }
  });

  it("VT-2: satan is last in interactive and bookmarks is the name before it; only the room installs tasks and threads", () => {
    for (const profile of PROFILES) {
      const names = toolsetList("interactive", profile);
      expect(names.at(-1)).toBe(SATAN);
      // Catalogue order, pinned: bookmarks sits immediately before SATAN on both profiles.
      expect(names.at(-2)).toBe("bookmarks");
    }
    const room = toolsetList("interactive", "room");
    expect(room).toContain("tasks");
    expect(room[room.indexOf("tasks") + 1]).toBe("threads");
    expect(room[room.indexOf("threads") + 1]).toBe("bookmarks");
    expect(toolsetList("interactive", "host")).not.toContain("tasks");
    expect(toolsetList("interactive", "host")).not.toContain("threads");
  });

  it("VT-2: the job list is the runner's two extensions, whatever the profile", () => {
    for (const profile of PROFILES) {
      expect(toolsetList("job", profile)).toEqual(["job-tools", "job-guard"]);
      expect(toolsetList("job", profile)).not.toContain("bookmarks");
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

describe("talk sets", () => {
  it("VT-1: TALK_SETS names only toolsets each profile allows", () => {
    expect(Object.keys(TALK_SETS)).toEqual(Object.keys(PROFILE_TOOLSETS));
    for (const profile of PROFILES) {
      const named = DAEMON_TOOLSETS.filter((toolset) => TALK_SETS[profile][toolset] !== undefined);
      expect(Object.keys(TALK_SETS[profile])).toEqual([...named]);
      for (const toolset of named) {
        expect(PROFILE_TOOLSETS[profile].allowed).toContain(toolset);
      }
      expect(TALK_SETS[profile].mail).toBeUndefined();
    }
    expect(TALK_SETS.host).toEqual({});
  });

  describe("VT-2: requireSameTalkSet refuses mail, host and mixed sets", () => {
    it("caller mail has no talk set on profile room", () => {
      expect(() => requireSameTalkSet("room", "mail", "interactive", "conversation 13")).toThrow(
        "toolset mail has no talk set on profile room",
      );
    });

    it("caller interactive has no talk set on profile host", () => {
      expect(() =>
        requireSameTalkSet("host", "interactive", "interactive", "conversation 13"),
      ).toThrow("toolset interactive has no talk set on profile host");
    });

    it("a mail target is outside the interactive set, named as a conversation", () => {
      expect(() => requireSameTalkSet("room", "interactive", "mail", "conversation 13")).toThrow(
        "conversation 13 (toolset mail) is outside this conversation's talk set (interactive)",
      );
    });

    it("a mail target is outside the interactive set, named as a topic", () => {
      expect(() => requireSameTalkSet("room", "interactive", "mail", "topic inbox")).toThrow(
        "topic inbox (toolset mail) is outside this conversation's talk set (interactive)",
      );
    });

    it("two interactives share the interactive set", () => {
      expect(requireSameTalkSet("room", "interactive", "interactive", "topic inbox")).toBe(
        "interactive" satisfies TalkSet,
      );
    });
  });
});
