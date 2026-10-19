// SL-027 design §4.1: which modules may import which, asserted over the
// source text file by file. Allowlists, not denylists: a new root module is
// outside the runner's and the room's lists until it is added on purpose
// (RFC-001 §1; RV-035 F-9).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

/** The one module outside src/runner/ that may import it. */
const RUNNER_ENTRY = "runner-main.ts";
/** Root modules src/runner/ may import: today's edges, less config and session. */
const RUNNER_ROOTS = [
  "context",
  "fields",
  "grep",
  "json",
  "message-of",
  "models",
  "ndjson",
  "project-context",
  "registry",
  "truncate",
  "unix-socket",
];
/** Root modules src/room/ may import. */
const ROOM_ROOTS = ["context", "fields", "json", "project-context", "truncate"];

/** Source text by path relative to src/. */
type Sources = Readonly<Record<string, string>>;

const SPECIFIER = /(?:\bfrom\s+|\bimport\s+)["']([^"']+)["']/g;

/** The src/-relative targets of `file`'s relative imports; packages are not edges. */
function targets(file: string, source: string): string[] {
  return [...source.matchAll(SPECIFIER)]
    .map((match) => match[1] ?? "")
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => normalize(join(dirname(file), specifier)));
}

type Tier = "runner" | "room" | "root" | "other";

function tierOf(path: string): Tier {
  if (path.startsWith("runner/")) {
    return "runner";
  }
  if (path.startsWith("room/")) {
    return "room";
  }
  return path.includes("/") ? "other" : "root";
}

/** `roots`, or a sibling tier in `tiers`: what a module of a confined tier may import. */
const within =
  (tiers: readonly Tier[], roots: readonly string[]) =>
  (target: string): boolean =>
    tiers.includes(tierOf(target)) ||
    (tierOf(target) === "root" && roots.includes(target.replace(/\.ts$/, "")));

/** Whether `file` may import `target` (both src/-relative), per tier. */
const ALLOWS: Record<Tier, (target: string, file: string) => boolean> = {
  runner: within(["runner", "room"], RUNNER_ROOTS),
  room: within(["room"], ROOM_ROOTS),
  root: (target, file) => tierOf(target) !== "runner" || file === RUNNER_ENTRY,
  other: (target) => tierOf(target) !== "runner",
};

/** Each import that breaks §4.1's rules, as `importer -> target`. */
function violations(sources: Sources): string[] {
  return Object.entries(sources)
    .flatMap(([file, source]) =>
      targets(file, source)
        .filter((target) => !ALLOWS[tierOf(file)](target, file))
        .map((target) => `${file} -> ${target}`),
    )
    .sort();
}

const SRC = join(import.meta.dirname, "../src");

function sourceTree(dir: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? Object.entries(sourceTree(join(dir, entry.name), `${prefix}${entry.name}/`))
        : [[`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), "utf8")]],
    ),
  );
}

describe("module boundaries (design §4.1)", () => {
  it("src/ imports only what each tier's allowlist names", () => {
    expect(violations(sourceTree(SRC))).toEqual([]);
  });
});

describe("violations: the allowlist checker", () => {
  const rejects = (file: string, source: string): string[] => violations({ [file]: source });

  it("rejects a runner module importing a daemon module (RV-035 F-9)", () => {
    expect(rejects("runner/run.ts", 'import { daemonEnv } from "../daemon-env.ts";')).toEqual([
      "runner/run.ts -> daemon-env.ts",
    ]);
  });

  it("rejects a runner module importing a root module not yet listed", () => {
    expect(rejects("runner/run.ts", 'import type { X } from "../brand-new.ts";')).toEqual([
      "runner/run.ts -> brand-new.ts",
    ]);
  });

  it("rejects the runner importing config or session (the root moves)", () => {
    const source = 'import { parseModel } from "../config.ts";\nimport "../session.ts";';
    expect(rejects("runner/model-gate.ts", source)).toEqual([
      "runner/model-gate.ts -> config.ts",
      "runner/model-gate.ts -> session.ts",
    ]);
  });

  it("rejects a re-export as an import", () => {
    expect(rejects("runner/env.ts", 'export { x } from "../daemon-main.ts";')).toEqual([
      "runner/env.ts -> daemon-main.ts",
    ]);
  });

  it("rejects a module outside src/runner/ importing it, but not the entry point", () => {
    const source = 'import { startRunner } from "./runner/start.ts";';
    expect(rejects("daemon-main.ts", source)).toEqual(["daemon-main.ts -> runner/start.ts"]);
    expect(rejects(RUNNER_ENTRY, source)).toEqual([]);
  });

  it("rejects the room tier importing the runner or a root module outside its list", () => {
    const source = 'import { jobEnv } from "../runner/env.ts";\nimport "../models.ts";';
    expect(rejects("room/shell.ts", source)).toEqual([
      "room/shell.ts -> models.ts",
      "room/shell.ts -> runner/env.ts",
    ]);
  });

  it("accepts the runner importing room/, a listed root module and packages", () => {
    const source = [
      'import { roomShell } from "../room/shell.ts";',
      'import { registryOf } from "../registry.ts";',
      'import { describe } from "vitest";',
      'import { Connection } from "@earendil-works/pi-env";',
    ].join("\n");
    expect(rejects("runner/run.ts", source)).toEqual([]);
  });
});
