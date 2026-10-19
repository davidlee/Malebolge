// Agent skills as a system prompt section: SKILL.md files found, parsed and
// listed as pi 1.3.0's coding-agent does (core/skills.ts, utils/frontmatter.ts).

import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { parse } from "yaml";
import { isRecord, type JsonRecord } from "./json.ts";

export interface Skill {
  name: string;
  description: string;
  /** The advertised location: `<dir>/SKILL.md`. */
  file: string;
  /** Loaded but not listed to the model (`disable-model-invocation: true`). */
  hidden: boolean;
}

/** Pi's frontmatter rules: BOM and CRLF tolerated; none if unopened, unclosed or empty. */
const extractFrontmatter = (text: string): string | undefined => {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return undefined;
  }
  const end = normalized.indexOf("\n---", 3);
  const block = end === -1 ? "" : normalized.slice(4, end);
  return block === "" ? undefined : block;
};

/** The frontmatter as a mapping, or why it is not one. */
const parseFrontmatter = (text: string): JsonRecord | string => {
  const block = extractFrontmatter(text);
  if (block === undefined) {
    return {};
  }
  try {
    const parsed: unknown = parse(block) ?? {};
    return isRecord(parsed) ? parsed : "frontmatter is not a mapping";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** A non-blank description, advertised as written; undefined otherwise. */
const readDescription = (frontmatter: JsonRecord): string | undefined => {
  const value = frontmatter["description"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
};

const readName = (frontmatter: JsonRecord, dir: string): string => {
  const value = frontmatter["name"];
  return typeof value === "string" && value !== "" ? value : basename(dir);
};

/** A skill from its directory and SKILL.md text, or why it is skipped. */
export const parseSkill = (dir: string, text: string): Skill | string => {
  const frontmatter = parseFrontmatter(text);
  if (typeof frontmatter === "string") {
    return frontmatter;
  }
  const description = readDescription(frontmatter);
  if (description === undefined) {
    return "description is required";
  }
  return {
    name: readName(frontmatter, dir),
    description,
    file: join(dir, "SKILL.md"),
    hidden: frontmatter["disable-model-invocation"] === true,
  };
};

/** Read and parse one directory's SKILL.md; never throws. */
const readSkill = (dir: string): Skill | string => {
  try {
    return parseSkill(dir, readFileSync(join(dir, "SKILL.md"), "utf8"));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** Pi's `canonicalizePath`: the real path, or the path itself when it cannot be resolved. */
const canonicalPath = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

/**
 * Read each directory's SKILL.md in order; log and drop the ones that fail.
 * As pi's `addSkills`: a file already loaded (same real path) is skipped
 * silently; a name already taken keeps the first skill and logs the collision.
 */
export const loadSkills = (dirs: readonly string[], log: (line: string) => void): Skill[] => {
  const seenFiles = new Set<string>();
  const byName = new Map<string, Skill>();
  for (const dir of dirs) {
    const parsed = readSkill(dir);
    if (typeof parsed === "string") {
      log(`skill ${dir}: ${parsed}`);
      continue;
    }
    const real = canonicalPath(parsed.file);
    if (seenFiles.has(real)) {
      continue;
    }
    const winner = byName.get(parsed.name);
    if (winner !== undefined) {
      log(`skill ${dir}: name "${parsed.name}" collides with ${winner.file}`);
      continue;
    }
    seenFiles.add(real);
    byName.set(parsed.name, parsed);
  }
  return [...byName.values()];
};

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const listing = (skill: Skill): string[] => [
  "  <skill>",
  `    <name>${escapeXml(skill.name)}</name>`,
  `    <description>${escapeXml(skill.description)}</description>`,
  `    <location>${escapeXml(skill.file)}</location>`,
  "  </skill>",
];

/**
 * Pi's listing for the visible skills, or undefined when there are none.
 * Wording and rules are copied from pi 1.3.0 `formatSkillsForPrompt`
 * (packages/coding-agent/src/core/skills.ts), "read" branch; its leading blank
 * lines are dropped because this is a section of its own.
 */
export const renderSkills = (skills: readonly Skill[]): string | undefined => {
  const visible = skills.filter((skill) => !skill.hidden);
  if (visible.length === 0) {
    return undefined;
  }
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...visible.flatMap(listing),
    "</available_skills>",
  ].join("\n");
};

/** Read once at startup, so the section closes over a constant. */
export const skillsExtension = (skills: readonly Skill[]): Extension => {
  const text = renderSkills(skills);
  return defineExtension({
    name: "skills",
    sections: [section("skills", () => text, { tag: false })],
  });
};
