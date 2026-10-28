// SL-005 PHASE-01: the persona is per toolset as well as per profile (design
// sec-2; DEC-030). `personaFiles` is pure, so startup checks every file of
// every allowed toolset's persona instead of only the environment file.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  personaExtension,
  personaFiles,
  readPersona,
  requirePersonaFiles,
} from "../src/persona.ts";
import { context } from "../src/context.ts";
import { selectionOf } from "../src/toolsets.ts";
import { tempDir } from "./fixtures.ts";
import { openTestHarness, systemPromptSections } from "./harness-fixture.ts";

/** A corpus root no test writes to: `personaFiles` only names paths. */
const CORPUS = "/corpus";

const scaffold = join(CORPUS, "system", "scaffold.txt");
const interactive = join(CORPUS, "prompts", "interactive.txt");
const mail = join(CORPUS, "prompts", "mail.txt");
const environment = (profile: string): string => join(CORPUS, "prompts", "env", `${profile}.txt`);

describe("persona", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  /** A corpus under a fresh temp dir holding exactly `files`; removed after the test. */
  async function corpus(files: Readonly<Record<string, string>>): Promise<string> {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    for (const [file, text] of Object.entries(files)) {
      const path = join(tmp.dir, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    return tmp.dir;
  }

  it("draws on the scaffold, the interactive prompt, then the profile's environment", () => {
    expect(personaFiles(CORPUS, "interactive", "room")).toEqual([
      scaffold,
      interactive,
      environment("room"),
    ]);
  });

  it("VT-3: the mail persona is the scaffold and the mail prompt, with no environment file", () => {
    for (const profile of ["room", "host"] as const) {
      expect(personaFiles(CORPUS, "mail", profile)).toEqual([scaffold, mail]);
    }
  });

  it("VT-3: the mail persona extension is named mail-persona and renders under the persona key", async () => {
    const dir = await corpus({
      "system/scaffold.txt": "scaffold\n",
      "prompts/mail.txt": "mail\n",
    });
    const extension = personaExtension("mail-persona", personaFiles(dir, "mail", "room"));
    expect(extension.name).toBe("mail-persona");
    expect((extension.sections ?? []).map(({ key, tag }) => [key, tag])).toEqual([
      ["persona", false],
    ]);

    const test = await openTestHarness([extension]);
    // Root's list is the interactive toolset (the reconcile): select the mail one explicitly.
    await test.root.configure({ extensions: selectionOf(["mail-persona"]) }, context);
    expect(await systemPromptSections(test)).toEqual([{ persona: "scaffold\n\nmail\n" }]);
  });

  it("renders the files in order, re-reading them so corpus edits apply next request", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const [a, b] = [join(tmp.dir, "a"), join(tmp.dir, "b")];
    await writeFile(a, "scaffold\n");
    await writeFile(b, "interactive\n");
    const render = (): string => readPersona([a, b]);
    expect(render()).toBe("scaffold\n\ninteractive\n");
    await writeFile(b, "edited\n");
    expect(render()).toBe("scaffold\n\nedited\n");
  });

  it("is one untagged system prompt section, rendered into a turn's prompt", async () => {
    const sections = personaExtension("persona", []).sections ?? [];
    expect(sections.map(({ key, tag }) => [key, tag])).toEqual([["persona", false]]);

    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const file = join(tmp.dir, "scaffold");
    await writeFile(file, "scaffold\n");
    const test = await openTestHarness([personaExtension("persona", [file])]);
    const prompts = await systemPromptSections(test);
    expect(prompts).toEqual([{ persona: "scaffold\n" }]);
  });

  it("VT-3 startup check: a room corpus without the mail prompt is enough at this stage", async () => {
    const dir = await corpus({
      "system/scaffold.txt": "scaffold\n",
      "prompts/interactive.txt": "interactive\n",
      "prompts/env/room.txt": "room\n",
    });
    expect(() => {
      requirePersonaFiles(dir, "room");
    }).not.toThrow();
  });

  it("VT-3 startup check: a missing interactive prompt refuses startup, naming its path", async () => {
    const dir = await corpus({
      "system/scaffold.txt": "scaffold\n",
      "prompts/env/room.txt": "room\n",
    });
    expect(() => {
      requirePersonaFiles(dir, "room");
    }).toThrow(
      `no persona file for toolset interactive: ${join(dir, "prompts", "interactive.txt")}`,
    );
  });

  it("VT-3 startup check: the host needs its environment file", async () => {
    const dir = await corpus({
      "system/scaffold.txt": "scaffold\n",
      "prompts/interactive.txt": "interactive\n",
      "prompts/env/room.txt": "room\n",
    });
    expect(() => {
      requirePersonaFiles(dir, "host");
    }).toThrow(
      `no persona file for toolset interactive: ${join(dir, "prompts", "env", "host.txt")}`,
    );
  });
});
