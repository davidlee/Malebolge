// SATAN's persona as a system prompt section: the files ~/notes
// `just build-system-prompt` concatenates into .pi/SYSTEM.md, with this
// daemon's environment file in place of pi's. Both the files and their names are
// per toolset (design §2; DEC-030).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import type { Profile } from "./config.ts";
import { type DaemonToolset, PROFILE_TOOLSETS } from "./toolsets.ts";

/**
 * The files a toolset's persona concatenates, in order. Pure, so startup can name
 * the one that is missing. The interactive prompt is shared with jailed-pi, whose
 * environment differs, so the profile's file ends it (design §4.8).
 */
export function personaFiles(
  corpusRoot: string,
  toolset: DaemonToolset,
  profile: Profile,
): string[] {
  const file = (path: string): string => join(corpusRoot, path);
  switch (toolset) {
    case "interactive":
      return [
        file("system/scaffold.txt"),
        file("prompts/interactive.txt"),
        file(`prompts/env/${profile}.txt`),
      ];
    case "mail":
      // No environment file: mail's tools run on the host whatever the profile (DEC-028).
      return [file("system/scaffold.txt"), file("prompts/mail.txt")];
  }
}

/** Refuses startup when a file of an allowed toolset's persona is missing. */
export function requirePersonaFiles(corpusRoot: string, profile: Profile): void {
  for (const toolset of PROFILE_TOOLSETS[profile].allowed) {
    for (const file of personaFiles(corpusRoot, toolset, profile)) {
      if (!existsSync(file)) {
        throw new Error(`no persona file for toolset ${toolset}: ${file}`);
      }
    }
  }
}

/** The persona text: `files` in order, read now. */
export const readPersona = (files: readonly string[]): string =>
  files.map((file) => readFileSync(file, "utf8")).join("\n");

/**
 * Read on every request, so a corpus edit lands on the next turn. The harness
 * resends a section only when its text changed, so the prompt cache survives.
 * Both personas render the one `persona` key, so the two never meet in a
 * conversation; the name says which toolset is speaking.
 */
export const personaExtension = (
  name: "persona" | "mail-persona",
  files: readonly string[],
): Extension =>
  defineExtension({
    name,
    sections: [section("persona", () => readPersona(files), { tag: false })],
  });
