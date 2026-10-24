import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { conversations } from "../src/conversations.ts";
import { conversationExtension } from "../src/conversation-context.ts";
import { cwdExtension } from "../src/cwd.ts";
import { isRecord } from "../src/json.ts";
import { daemonExtensions } from "../src/daemon-extensions.ts";
import { personaExtension } from "../src/persona.ts";
import { DEFAULT_TOPIC } from "../src/protocol.ts";
import {
  gitRootDirs,
  nodeSourceReader,
  readSources,
  renderProjectContext,
} from "../src/project-context.ts";
import { type Skill, skillsExtension } from "../src/skills.ts";
import { tempDir } from "./fixtures.ts";
import {
  closing,
  FAUX_MODEL,
  openFauxHarness,
  openTestHarness,
  systemPromptSections,
} from "./harness-fixture.ts";

const skill: Skill = {
  name: "alpha",
  description: "Does alpha.",
  file: "/s/SKILL.md",
  hidden: false,
};

const keysOf = (entry: unknown): string[] => (isRecord(entry) ? Object.keys(entry) : []);

describe("cwdExtension", () => {
  it("is one untagged section, worded as pi states it", async () => {
    const sections = cwdExtension.sections ?? [];
    expect(sections.map(({ key, tag }) => [key, tag])).toEqual([["cwd", false]]);
    const test = await openTestHarness([cwdExtension]);
    await test.root.configure({ cwd: "/work" }, context);
    expect(await systemPromptSections(test)).toEqual([{ cwd: "Current working directory: /work" }]);
  });

  it("renders no section when the conversation has no cwd", async () => {
    const test = await openTestHarness([cwdExtension]);
    expect(await systemPromptSections(test)).toEqual([]);
  });
});

describe("conversationExtension", () => {
  it("is one untagged section, stating the conversation and its topic", async () => {
    const sections = conversationExtension.sections ?? [];
    expect(sections.map(({ key, tag }) => [key, tag])).toEqual([["conversation", false]]);
    const test = await openTestHarness([conversationExtension]);
    closing(test.harness);
    expect(await systemPromptSections(test)).toEqual([
      { conversation: `Conversation: ${String(test.root.id)} (topic: ${DEFAULT_TOPIC})` },
    ]);
  });

  it("renders directly after cwd", async () => {
    const test = await openTestHarness(
      daemonExtensions({ personaFiles: [], projectContext: undefined, skills: [] }),
    );
    closing(test.harness);
    await test.root.configure({ cwd: "/work" }, context);
    // An empty persona list still renders its section (empty text); skills render none.
    expect((await systemPromptSections(test)).map(keysOf)).toEqual([
      ["persona", "cwd", "conversation"],
    ]);
  });

  it("states the conversation alone when the index has no entry for it", async () => {
    const test = await openFauxHarness(new MemoryStorage(), {
      extensions: [conversationExtension],
    });
    closing(test.harness);
    expect(await systemPromptSections(test)).toEqual([
      { conversation: `Conversation: ${String(test.root.id)}` },
    ]);
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

  it("renders persona, project context, skills, cwd and conversation, in that order, for a fresh conversation", async () => {
    const { persona, cwd } = await setup();
    const projectContext = await readContext(cwd);
    expect(projectContext).toContain("be careful");
    const test = await openFauxHarness(new MemoryStorage(), {
      extensions: daemonExtensions({
        personaFiles: [persona],
        projectContext,
        skills: [skill],
      }),
    });
    await test.root.configure({ cwd }, context);
    const entries = await systemPromptSections(test);
    expect(entries).toHaveLength(1);
    expect(keysOf(entries[0])).toEqual([
      "persona",
      "project_context",
      "skills",
      "cwd",
      "conversation",
    ]);
    expect(entries[0]).toMatchObject({
      persona: "persona\n",
      project_context: `<project_context>\n${String(projectContext)}\n</project_context>`,
      cwd: `Current working directory: ${cwd}`,
    });
  });

  it("states a created conversation's own cwd, not the daemon default", async () => {
    const test = await openTestHarness(
      daemonExtensions({ personaFiles: [], projectContext: undefined, skills: [] }),
    );
    const api = conversations(test, { model: FAUX_MODEL, cwd: "/daemon-default" }, "host");
    const created = await api.open({ kind: "new", cwd: "/own" });
    expect(await systemPromptSections(test, created)).toMatchObject([
      { cwd: "Current working directory: /own" },
    ]);
  });

  it("omits project_context when there is none", async () => {
    const { persona, cwd } = await setup();
    const test = await openFauxHarness(new MemoryStorage(), {
      extensions: daemonExtensions({
        personaFiles: [persona],
        projectContext: undefined,
        skills: [skill],
      }),
    });
    await test.root.configure({ cwd }, context);
    const entries = await systemPromptSections(test);
    expect(entries.map(keysOf)).toEqual([["persona", "skills", "cwd", "conversation"]]);
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
      }),
    });
    await after.root.configure({ cwd }, context);
    // Oldest first: the fixture lists them newest first.
    const entries = (await systemPromptSections(after)).reverse();
    expect(entries.map(keysOf)).toEqual([
      ["persona", "skills"],
      ["persona", "skills"],
      ["persona", "project_context", "skills", "cwd", "conversation"],
    ]);
    expect(entries[1]).toEqual({ persona: null, skills: null });
  });
});
