import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { personaExtension, personaFiles, readPersona } from "../src/persona.ts";
import { tempDir } from "./fixtures.ts";
import { openTestHarness, systemPromptSections } from "./harness-fixture.ts";

describe("persona", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  it("draws on the scaffold, then the interactive prompt, as hello-satan does", () => {
    expect(personaFiles("/c")).toEqual(["/c/system/scaffold.txt", "/c/prompts/interactive.txt"]);
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
    const sections = personaExtension([]).sections ?? [];
    expect(sections.map(({ key, tag }) => [key, tag])).toEqual([["persona", false]]);

    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const file = join(tmp.dir, "scaffold");
    await writeFile(file, "scaffold\n");
    const test = await openTestHarness([personaExtension([file])]);
    const prompts = await systemPromptSections(test);
    expect(prompts).toEqual([{ persona: "scaffold\n" }]);
  });
});
