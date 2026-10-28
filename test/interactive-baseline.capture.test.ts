// The one-shot capture of the interactive baseline (SL-005 EN-2): gated, so a
// normal run skips it and never rewrites the frozen fixture. Run it with
// CAPTURE_INTERACTIVE_BASELINE=1 and never after an SL-005 edit.

import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Profile } from "../src/config.ts";
import { daemonExtensions } from "../src/daemon-extensions.ts";
import { personaFiles } from "../src/persona.ts";
import { tasksExtension, wakeBinding } from "../src/wake/extension.ts";
import {
  BASELINE_CORPUS,
  BASELINE_PATH,
  BASELINE_PROJECT_CONTEXT,
  BASELINE_SKILL,
  type InteractiveSnapshot,
  interactiveSnapshot,
} from "./interactive-baseline.ts";

/** Today's static registry for `profile`, as the daemon's entry script builds it. */
const snapshotOf = (profile: Profile): Promise<InteractiveSnapshot> =>
  interactiveSnapshot(
    daemonExtensions({
      personaFiles: personaFiles(BASELINE_CORPUS, profile),
      projectContext: BASELINE_PROJECT_CONTEXT,
      skills: [BASELINE_SKILL],
      profile,
      tasks: tasksExtension(wakeBinding().deps),
    }),
  );

describe.runIf(process.env["CAPTURE_INTERACTIVE_BASELINE"] === "1")(
  "interactive baseline capture",
  () => {
    it("writes the room and host snapshots of a new conversation", async () => {
      const room = await snapshotOf("room");
      const host = await snapshotOf("host");
      // SATAN's tools are discovered at runtime, so neither profile lists them here.
      expect(room.extensions.at(-1)).toBe("tasks");
      expect(host.extensions).not.toContain("tasks");
      expect(room.tools).toContain("wake_schedule");
      expect(host.tools).not.toContain("wake_schedule");
      const baseline = {
        sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        note: "captured before any SL-005 edit to src/daemon-extensions.ts or src/persona.ts; never regenerate",
        profiles: {
          room: { registry: room.extensions, ...room },
          host: { registry: host.extensions, ...host },
        },
      };
      await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    });
  },
);
