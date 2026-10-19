// SATAN's interactive persona as a system prompt section: the files ~/notes
// `just build-system-prompt` concatenates into .pi/SYSTEM.md, with this
// daemon's environment file in place of pi's.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import type { Profile } from "./config.ts";

/**
 * The persona's files, ending with `profile`'s execution environment (design
 * §4.8): the interactive prompt is shared with jailed-pi, whose environment
 * differs. A profile without its file refuses startup.
 */
export function personaFiles(corpusRoot: string, profile: Profile): string[] {
  const environment = join(corpusRoot, "prompts", "env", `${profile}.txt`);
  if (!existsSync(environment)) {
    throw new Error(`no environment prompt for profile ${profile}: ${environment}`);
  }
  return [
    join(corpusRoot, "system", "scaffold.txt"),
    join(corpusRoot, "prompts", "interactive.txt"),
    environment,
  ];
}

/** The persona text: `files` in order, read now. */
export const readPersona = (files: readonly string[]): string =>
  files.map((file) => readFileSync(file, "utf8")).join("\n");

/**
 * Read on every request, so a corpus edit lands on the next turn. The harness
 * resends a section only when its text changed, so the prompt cache survives.
 */
export const personaExtension = (files: readonly string[]): Extension =>
  defineExtension({
    name: "persona",
    sections: [section("persona", () => readPersona(files), { tag: false })],
  });
