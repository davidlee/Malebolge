// A frozen baseline of what a new interactive conversation offers today: the
// fixed corpus it reads, the registry parts a later test rebuilds, and the
// snapshot helper that capture (and comparison) tests share.

import { join } from "node:path";
import { type Extension, MemoryStorage } from "@earendil-works/pi-durable";
import { context } from "../src/context.ts";
import { isRecord } from "../src/json.ts";
import type { Skill } from "../src/skills.ts";
import { openFauxHarness, systemPromptSections } from "./harness-fixture.ts";

/** The fixed corpus, in the layout `personaFiles` reads (system/, prompts/, prompts/env/). */
export const BASELINE_CORPUS = join(import.meta.dirname, "fixtures", "corpus");

/** The written baseline: captured once, before SL-005, and compared ever after. */
export const BASELINE_PATH = join(import.meta.dirname, "fixtures", "interactive-baseline.json");

/** The project context a snapshot states; the section wraps it in `<project_context>` tags. */
export const BASELINE_PROJECT_CONTEXT = "baseline project context";

/** The one skill a snapshot advertises. */
export const BASELINE_SKILL: Skill = {
  name: "baseline",
  description: "Does baseline.",
  file: "/skills/baseline/SKILL.md",
  hidden: false,
};

/** What one interactive conversation's system prompt and tools look like. */
export interface InteractiveSnapshot {
  /** The extension names, in order. */
  extensions: string[];
  /** The recorded system prompt sections, with the conversation id normalised. */
  sections: unknown;
  /** The offered tool names, in order. */
  tools: string[];
}

/** `sections` with the conversation id in each `conversation` section replaced by `<id>`. */
const normaliseId = (sections: unknown[], id: string): unknown[] =>
  sections.map((entry) =>
    isRecord(entry) && typeof entry["conversation"] === "string"
      ? { ...entry, conversation: entry["conversation"].replace(id, "<id>") }
      : entry,
  );

/**
 * Open a faux harness over `extensions` at cwd "/work", read the offered tools,
 * then the system prompt sections (which run a turn and close the harness).
 */
export async function interactiveSnapshot(extensions: Extension[]): Promise<InteractiveSnapshot> {
  const test = await openFauxHarness(new MemoryStorage(), { extensions });
  await test.root.configure({ cwd: "/work" }, context);
  const tools = (await test.root.agent(context)).tools.map((tool) => tool.name);
  const sections = await systemPromptSections(test);
  return {
    extensions: extensions.map((extension) => extension.name),
    sections: normaliseId(sections, String(test.root.id)),
    tools,
  };
}
