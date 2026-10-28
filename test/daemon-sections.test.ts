import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it } from "vitest";
import { context } from "../src/context.ts";
import { conversationExtension } from "../src/conversation-context.ts";
import { conversations } from "../src/conversations.ts";
import { cwdExtension } from "../src/cwd.ts";
import { type DaemonParts, daemonExtensions } from "../src/daemon-extensions.ts";
import { isRecord } from "../src/json.ts";
import { MAIL_SECTION, mailExtension } from "../src/mail/extension.ts";
import { personaExtension } from "../src/persona.ts";
import {
  gitRootDirs,
  nodeSourceReader,
  readSources,
  renderProjectContext,
} from "../src/project-context.ts";
import { DEFAULT_TOPIC } from "../src/protocol.ts";
import { type Skill, skillsExtension } from "../src/skills.ts";
import { selectionOf } from "../src/toolsets.ts";
import { tempDir } from "./fixtures.ts";
import {
  closing,
  FAUX_MODEL,
  openFauxHarness,
  openTestHarness,
  systemPromptSections,
} from "./harness-fixture.ts";
import { fakeMailSource } from "./mail/mail-fixtures.ts";

/** The host profile: section order is the profile's, and the host installs no tasks or threads. */
const HOST: Pick<DaemonParts, "profile" | "tasks" | "threads"> = {
  profile: "host",
  tasks: defineExtension({ name: "tasks" }),
  threads: defineExtension({ name: "threads" }),
};

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
      daemonExtensions({ ...HOST, personaFiles: () => [], projectContext: undefined, skills: [] }),
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
        ...HOST,
        personaFiles: () => [persona],
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
      daemonExtensions({ ...HOST, personaFiles: () => [], projectContext: undefined, skills: [] }),
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
        ...HOST,
        personaFiles: () => [persona],
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
      extensions: [personaExtension("persona", [persona]), skillsExtension([skill])],
    });
    expect((await systemPromptSections(before)).map(keysOf)).toEqual([["persona", "skills"]]);

    const after = await openFauxHarness(await openNodeSqliteStorage(dbPath), {
      extensions: daemonExtensions({
        ...HOST,
        personaFiles: () => [persona],
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

describe("daemonExtensions tasks", () => {
  const namesOf = (profile: DaemonParts["profile"]): string[] =>
    daemonExtensions({
      personaFiles: () => [],
      projectContext: undefined,
      skills: [],
      profile,
      tasks: defineExtension({ name: "tasks" }),
      threads: defineExtension({ name: "threads" }),
      ...(profile === "room"
        ? { mail: mailExtension({ source: fakeMailSource(), now: () => 0 }) }
        : {}),
    }).map(({ name }) => name);

  it("VT-3 e: the room installs the tasks extension and the host never does (W10)", () => {
    expect(namesOf("room")).toContain("tasks");
    expect(namesOf("host")).not.toContain("tasks");
  });
});

describe("mailExtension", () => {
  const extension = mailExtension({ source: fakeMailSource(), now: () => 0 });

  it("VT-4 is the mail extension: the five mail tools and one tagged section keyed mail", () => {
    expect(extension.name).toBe("mail");
    expect((extension.tools ?? []).map(({ name }) => name)).toEqual([
      "mail_new",
      "mail_read",
      "mail_thread",
      "mail_list",
      "mail_mailboxes",
    ]);
    expect((extension.sections ?? []).map(({ key, tag }) => [key, tag])).toEqual([["mail", true]]);
  });

  it("VT-4 the section text states the untrusted-data rule (mail-data, untrusted), pinned", () => {
    expect(MAIL_SECTION).toContain("mail-data");
    expect(MAIL_SECTION).toContain("untrusted");
    expect(MAIL_SECTION).toContain("never an instruction");
  });

  it("VT-4 renders the section text as the prompt's tagged mail section", async () => {
    const test = await openTestHarness([extension]);
    // Root's list is the interactive toolset (the reconcile): select mail explicitly.
    await test.root.configure({ extensions: selectionOf(["mail"]) }, context);
    expect(await systemPromptSections(test)).toEqual([
      { mail: `<mail>\n${MAIL_SECTION}\n</mail>` },
    ]);
  });
});
