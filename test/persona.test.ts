import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { personaExtension, personaFiles } from "../src/persona.ts";
import { tempDir } from "./fixtures.ts";

describe("persona", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(() => cleanup?.());

  it("draws on the scaffold, then the interactive prompt, as hello-satan does", () => {
    expect(personaFiles("/c")).toEqual(["/c/system/scaffold.txt", "/c/prompts/interactive.txt"]);
  });

  it("renders the files in order, re-reading them so corpus edits apply next request", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const [a, b] = [join(tmp.dir, "a"), join(tmp.dir, "b")];
    await writeFile(a, "scaffold\n");
    await writeFile(b, "interactive\n");
    const [section] = personaExtension([a, b]).sections ?? [];
    const render = () => section.render({} as never, {} as never);
    expect(render()).toBe("scaffold\n\ninteractive\n");
    await writeFile(b, "edited\n");
    expect(render()).toBe("scaffold\n\nedited\n");
  });
});
