// SATAN's interactive persona as a system prompt section: the same files
// ~/notes `just build-system-prompt` concatenates into .pi/SYSTEM.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

export const personaFiles = (corpusRoot: string): string[] => [
  join(corpusRoot, "system", "scaffold.txt"),
  join(corpusRoot, "prompts", "interactive.txt"),
];

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
