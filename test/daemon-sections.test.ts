import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { cwdExtension } from "../src/cwd.ts";
import { isRecord } from "../src/json.ts";
import { daemonExtensions } from "../src/daemon-extensions.ts";
import { personaExtension } from "../src/persona.ts";
import {
  gitRootDirs,
  nodeSourceReader,
  readSources,
  renderProjectContext,
} from "../src/project-context.ts";
import { type Skill, skillsExtension } from "../src/skills.ts";
import { tempDir } from "./fixtures.ts";
import { openFauxHarness, openTestHarness, systemPromptSections } from "./harness-fixture.ts";

const skill: Skill = {
  name: "alpha",
  description: "Does alpha.",
  file: "/s/SKILL.md",
  hidden: false,
};
const satan = defineExtension({ name: "satan" });

const keysOf = (entry: unknown): string[] => (isRecord(entry) ? Object.keys(entry) : []);

describe("cwdExtension", () => {
  it("is one untagged section, worded as pi states it", async () => {
    const sections = cwdExtension("/work").sections ?? [];
    expect(sections.map(({ key, tag }) => [key, tag])).toEqual([["cwd", false]]);
    const test = await openTestHarness([cwdExtension("/work")]);
    expect(await systemPromptSections(test)).toEqual([{ cwd: "Current working directory: /work" }]);
  });
});

describe("daemon system prompt sections", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  const setup = async (): Promise<{ dir: string; persona: string; cwd: string }> => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const persona = join(tmp.dir, "persona");
    await writeFile(persona, "persona\n");
    await mkdir(join(tmp.dir, ".git"));
    await writeFile(join(tmp.dir, "AGENTS.md"), "be careful\n");
    const cwd = join(tmp.dir, "sub");
    await mkdir(cwd);
    return { dir: tmp.dir, persona, cwd };
  };

  /** The daemon's startup expression. */
  const readContext = async (cwd: string): Promise<string | undefined> =>
    renderProjectContext(await readSources(cwd, gitRootDirs(cwd), nodeSourceReader));

  it("renders persona, project context, skills and cwd, in that order, for a fresh conversation", async () => {
    const { persona, cwd } = await setup();
    const projectContext = await readContext(cwd);
    expect(projectContext).toContain("be careful");
    const test = await openFauxHarness(new MemoryStorage(), {
      extensions: daemonExtensions({
        personaFiles: [persona],
        projectContext,
        skills: [skill],
        cwd,
        satan,
      }),
    });
    const entries = await systemPromptSections(test);
    expect(entries).toHaveLength(1);
    expect(keysOf(entries[0])).toEqual(["persona", "project_context", "skills", "cwd"]);
    expect(entries[0]).toMatchObject({
      persona: "persona\n",
      project_context: `<project_context>\n${String(projectContext)}\n</project_context>`,
      cwd: `Current working directory: ${cwd}`,
    });
  });

  it("omits project_context when there is none", async () => {
    const { persona, cwd } = await setup();
    const test = await openFauxHarness(new MemoryStorage(), {
      extensions: daemonExtensions({
        personaFiles: [persona],
        projectContext: undefined,
        skills: [skill],
        cwd,
        satan,
      }),
    });
    const entries = await systemPromptSections(test);
    expect(entries.map(keysOf)).toEqual([["persona", "skills", "cwd"]]);
  });

  it("re-sends every section once, in order, to a conversation that already shows persona and skills", async () => {
    const { dir, persona, cwd } = await setup();
    const projectContext = await readContext(cwd);
    // Closing a harness closes its storage, so reopen the daemon's real sqlite file.
    const dbPath = join(dir, "session.db");
    const before = await openFauxHarness(await openNodeSqliteStorage(dbPath), {
      extensions: [personaExtension([persona]), skillsExtension([skill])],
    });
    expect((await systemPromptSections(before)).map(keysOf)).toEqual([["persona", "skills"]]);

    const after = await openFauxHarness(await openNodeSqliteStorage(dbPath), {
      extensions: daemonExtensions({
        personaFiles: [persona],
        projectContext,
        skills: [skill],
        cwd,
        satan,
      }),
    });
    // Oldest first: the fixture lists them newest first.
    const entries = (await systemPromptSections(after)).reverse();
    expect(entries.map(keysOf)).toEqual([
      ["persona", "skills"],
      ["persona", "skills"],
      ["persona", "project_context", "skills", "cwd"],
    ]);
    expect(entries[1]).toEqual({ persona: null, skills: null });
  });
});
