import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSkills,
  parseSkill,
  renderSkills,
  type Skill,
  skillsExtension,
} from "../src/skills.ts";
import { personaExtension } from "../src/persona.ts";
import { tempDir } from "./fixtures.ts";
import { openTestHarness, systemPromptSections } from "./harness-fixture.ts";

const skillMd = (frontmatter: string): string => `---\n${frontmatter}\n---\n\nBody.\n`;

const skill = (over: Partial<Skill> = {}): Skill => ({
  name: "alpha",
  description: "Does alpha.",
  file: "/s/alpha/SKILL.md",
  hidden: false,
  ...over,
});

describe("parseSkill", () => {
  it("parses plain frontmatter, with the file path under the given dir", () => {
    expect(parseSkill("/s/alpha", skillMd("name: alpha\ndescription: Does alpha."))).toEqual(
      skill(),
    );
  });

  it("strips a BOM and reads CRLF frontmatter", () => {
    const text = "﻿---\r\nname: alpha\r\ndescription: Does alpha.\r\n---\r\nBody\r\n";
    expect(parseSkill("/s/alpha", text)).toEqual(skill());
  });

  it.each([
    ["no frontmatter", "name: a\ndescription: d\n"],
    ["unclosed frontmatter", "---\nname: a\ndescription: d\n"],
    ["empty frontmatter block", "---\n---\n"],
  ])("skips %s for want of a description", (_label, text) => {
    expect(parseSkill("/s/a", text)).toContain("description");
  });

  it.each([
    ["quoted", 'description: "a: b"', "a: b"],
    ["folded", "description: >\n  one\n  two", "one two\n"],
    ["block", "description: |\n  one\n  two", "one\ntwo\n"],
    ["untrimmed", 'description: "  padded  "', "  padded  "],
  ])("reads a %s description", (_label, line, expected) => {
    const parsed = parseSkill("/s/a", skillMd(`name: a\n${line}`));
    expect(parsed).toMatchObject({ description: expected });
  });

  it.each([
    ["missing", "name: a"],
    ["non-string", "name: a\ndescription: 3"],
    ["empty", 'name: a\ndescription: ""'],
    ["whitespace-only", 'name: a\ndescription: "   "'],
  ])("skips a %s description", (_label, frontmatter) => {
    expect(parseSkill("/s/a", skillMd(frontmatter))).toContain("description");
  });

  it.each([
    ["missing", "description: d"],
    ["non-string", "name: 7\ndescription: d"],
    ["empty", 'name: ""\ndescription: d'],
  ])("falls back to the directory name when name is %s", (_label, frontmatter) => {
    expect(parseSkill("/s/dirname", skillMd(frontmatter))).toMatchObject({ name: "dirname" });
  });

  it.each([
    ["true", "disable-model-invocation: true", true],
    ["the string true", 'disable-model-invocation: "true"', false],
    ["false", "disable-model-invocation: false", false],
    ["absent", "", false],
  ])(
    "hides a skill only when disable-model-invocation is boolean true (%s)",
    (_l, line, hidden) => {
      expect(parseSkill("/s/a", skillMd(`name: a\ndescription: d\n${line}`))).toMatchObject({
        hidden,
      });
    },
  );

  it("skips a YAML syntax error with the parser's message", () => {
    const reason = parseSkill("/s/a", skillMd("description: [unclosed"));
    expect(typeof reason).toBe("string");
    expect(reason).not.toBe("");
  });

  it.each([
    ["a list", "- a\n- b"],
    ["a scalar", "just text"],
  ])("skips frontmatter that is %s, not a mapping", (_label, frontmatter) => {
    expect(parseSkill("/s/a", skillMd(frontmatter))).toContain("not a mapping");
  });

  it("treats a null document as empty frontmatter, as pi does", () => {
    expect(parseSkill("/s/a", skillMd("~"))).toContain("description");
  });
});

// Expected text copied from pi 1.3.0 formatSkillsForPrompt (skills.ts:362-389), "read" branch,
// minus the leading blank lines.
const PI_LISTING = `The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>alpha</name>
    <description>Does alpha.</description>
    <location>/s/alpha/SKILL.md</location>
  </skill>
  <skill>
    <name>beta</name>
    <description>Does beta.</description>
    <location>/s/beta/SKILL.md</location>
  </skill>
</available_skills>`;

describe("renderSkills", () => {
  it("lists visible skills in pi's wording", () => {
    const beta = skill({ name: "beta", description: "Does beta.", file: "/s/beta/SKILL.md" });
    expect(renderSkills([skill(), beta])).toBe(PI_LISTING);
  });

  it("escapes & < > \" ' in name, description and location, & first", () => {
    const text = renderSkills([skill({ name: "&<>\"'", description: "&<>\"'", file: "&<>\"'" })]);
    const escaped = "&amp;&lt;&gt;&quot;&apos;";
    expect(text).toContain(`<name>${escaped}</name>`);
    expect(text).toContain(`<description>${escaped}</description>`);
    expect(text).toContain(`<location>${escaped}</location>`);
  });

  it("omits hidden skills", () => {
    const text = renderSkills([skill({ hidden: true, name: "secret" }), skill()]);
    expect(text).not.toContain("secret");
    expect(text).toContain("<name>alpha</name>");
  });

  it.each([
    ["no skills", []],
    ["only hidden skills", [skill({ hidden: true })]],
  ])("renders nothing for %s", (_label, skills) => {
    expect(renderSkills(skills)).toBeUndefined();
  });
});

describe("loadSkills", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  /** A temp root holding a skill directory per entry (none written for undefined text). */
  const tree = async (
    skills: Record<string, string | undefined>,
  ): Promise<{ root: string; dir: (name: string) => string }> => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    for (const [name, text] of Object.entries(skills)) {
      if (text !== undefined) {
        await mkdir(join(tmp.dir, name));
        await writeFile(join(tmp.dir, name, "SKILL.md"), text);
      }
    }
    return { root: tmp.dir, dir: (name) => join(tmp.dir, name) };
  };
  const good = (name: string): string => skillMd(`name: ${name}\ndescription: Does ${name}.`);

  it("logs and drops a missing directory, and a skill that fails to parse, without throwing", async () => {
    const { dir } = await tree({ gone: undefined, bad: skillMd("name: bad"), ok: good("ok") });
    const log: string[] = [];
    const loaded = loadSkills([dir("gone"), dir("bad"), dir("ok")], (l) => log.push(l));
    expect(loaded.map((s) => s.name)).toEqual(["ok"]);
    expect(log).toHaveLength(2);
    expect(log[0]).toContain(`skill ${dir("gone")}: `);
    expect(log[1]).toMatch(new RegExp(`^skill ${dir("bad")}: .*description`));
  });

  it("keeps the order of dirs", async () => {
    const { dir } = await tree({ b: good("b"), a: good("a") });
    const loaded = loadSkills([dir("b"), dir("a")], () => undefined);
    expect(loaded.map((s) => s.name)).toEqual(["b", "a"]);
    expect(loaded[0]?.file).toBe(join(dir("b"), "SKILL.md"));
  });

  it("lists a repeated directory once, silently", async () => {
    const { dir } = await tree({ a: good("a") });
    const log: string[] = [];
    const a = dir("a");
    expect(loadSkills([a, a], (l) => log.push(l))).toHaveLength(1);
    expect(log).toEqual([]);
  });

  it("lists a symlinked directory once, silently", async () => {
    const { root, dir } = await tree({ real: good("a") });
    const link = join(root, "link");
    await symlink(dir("real"), link, "dir");
    const log: string[] = [];
    expect(loadSkills([dir("real"), link], (l) => log.push(l))).toHaveLength(1);
    expect(log).toEqual([]);
  });

  it("keeps the first of two skills with the same name and logs the collision", async () => {
    const { dir } = await tree({ one: good("same"), two: good("same") });
    const [one, two] = [dir("one"), dir("two")];
    const log: string[] = [];
    const loaded = loadSkills([one, two], (l) => log.push(l));
    expect(loaded.map((s) => s.file)).toEqual([join(one, "SKILL.md")]);
    expect(log).toEqual([`skill ${two}: name "same" collides with ${join(one, "SKILL.md")}`]);
  });
});

describe("skillsExtension", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  it("is one untagged section named skills", () => {
    const sections = skillsExtension([]).sections ?? [];
    expect(sections.map(({ key, tag }) => [key, tag])).toEqual([["skills", false]]);
  });

  it("renders the listing into a turn's system prompt", async () => {
    const visible = skill();
    const test = await openTestHarness([skillsExtension([visible])]);
    expect(await systemPromptSections(test)).toEqual([{ skills: renderSkills([visible]) }]);
  });

  it("leaves the section out when no skill is visible", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const file = join(tmp.dir, "persona");
    await writeFile(file, "persona\n");
    const test = await openTestHarness([
      personaExtension([file]),
      skillsExtension([skill({ hidden: true })]),
    ]);
    expect(await systemPromptSections(test)).toEqual([{ persona: "persona\n" }]);
  });
});
