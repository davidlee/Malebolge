// Project instructions as a system prompt section: the sources pi's coding
// agent reads (AGENTS.md chain, .pi/APPEND_SYSTEM.md), read through an
// injected SourceReader so the same pipeline serves the daemon (node fs) and
// the patch-job runner (a room).

import { existsSync } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { capUtf8 } from "./truncate.ts";
import { escapeXml } from "./xml.ts";

export const CONTEXT_FILE_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;
export const APPEND_SYSTEM_FILE = ".pi/APPEND_SYSTEM.md";
export const SOURCE_CAP_BYTES = 65_536;

/** Where a source came from: a file, or a command's stdout. */
export type SourceOrigin = { path: string } | { command: string };
export interface ContextSource {
  origin: SourceOrigin;
  text: string;
}

export interface SourceReader {
  /** Of `names` in `dir`, those that are regular files (symlinks followed); none is opened. */
  regularFiles(dir: string, names: readonly string[]): Promise<ReadonlySet<string>>;
  /** At most SOURCE_CAP_BYTES + 1 bytes of a file; undefined when it does not read. */
  readCapped(path: string): Promise<string | undefined>;
}

const TRUNCATION_MARKER = `[truncated at ${String(SOURCE_CAP_BYTES)} bytes]`;

const stripBom = (text: string): string => (text.startsWith("﻿") ? text.slice(1) : text);

/** The source for one capped read: BOM stripped, text cut to the cap, plus the marker when cut. */
export const capSource = (origin: SourceOrigin, text: string): ContextSource => {
  const capped = capUtf8(stripBom(text), SOURCE_CAP_BYTES);
  return {
    origin,
    text: capped.truncated ? `${capped.text}\n${TRUNCATION_MARKER}` : capped.text,
  };
};

/** The source for `path` if it reads, else undefined. */
const readSource = async (
  reader: SourceReader,
  path: string,
): Promise<ContextSource | undefined> => {
  const text = await reader.readCapped(path);
  return text === undefined ? undefined : capSource({ path }, text);
};

/** The first name in `dir` that reads, as a source; undefined when none does. */
export const readChainDir = async (
  dir: string,
  reader: SourceReader,
): Promise<ContextSource | undefined> => {
  const regular = await reader.regularFiles(dir, CONTEXT_FILE_NAMES);
  for (const name of CONTEXT_FILE_NAMES) {
    if (!regular.has(name)) {
      continue;
    }
    const source = await readSource(reader, join(dir, name));
    if (source !== undefined) {
      return source;
    }
  }
  return undefined;
};

const readAppendSystem = async (
  cwd: string,
  reader: SourceReader,
): Promise<ContextSource | undefined> => {
  const file = join(cwd, APPEND_SYSTEM_FILE);
  const regular = await reader.regularFiles(dirname(file), [basename(file)]);
  return regular.has(basename(file)) ? readSource(reader, file) : undefined;
};

/**
 * Sources in render order: APPEND_SYSTEM at `cwd`, then `extra` (doctrine's
 * boot, when given), then the chain over `dirs` (outermost first). A source
 * with no text says nothing, so it is left out.
 */
export const readSources = async (
  cwd: string,
  dirs: readonly string[],
  reader: SourceReader,
  extra?: ContextSource,
): Promise<ContextSource[]> => {
  const chain: (ContextSource | undefined)[] = [];
  for (const dir of dirs) {
    chain.push(await readChainDir(dir, reader));
  }
  return [await readAppendSystem(cwd, reader), extra, ...chain].filter(
    (source): source is ContextSource => source !== undefined && source.text !== "",
  );
};

const originAttribute = (origin: SourceOrigin): string =>
  "path" in origin ? `path="${escapeXml(origin.path)}"` : `command="${escapeXml(origin.command)}"`;

/** pi's render of the sources (system-prompt.ts), or undefined for none. */
export const renderProjectContext = (sources: readonly ContextSource[]): string | undefined =>
  sources.length === 0
    ? undefined
    : [
        "Project-specific instructions and guidelines:",
        ...sources.map(
          ({ origin, text }) =>
            `\n<project_instructions ${originAttribute(origin)}>\n${text}\n</project_instructions>`,
        ),
      ].join("\n");

/** `cwd` and its ancestors up to the first holding `.git` (a directory or a file), outermost first. */
export const gitRootDirs = (cwd: string): string[] => {
  const start = resolve(cwd);
  const dirs: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (existsSync(join(dir, ".git"))) {
      return dirs;
    }
    if (dir === dirname(dir)) {
      return [start];
    }
  }
};

/** The nearest directory at or above `cwd` holding `.git`, or `undefined` outside a repository. */
export const gitRootOf = (cwd: string): string | undefined => {
  const root = gitRootDirs(cwd)[0];
  return root !== undefined && existsSync(join(root, ".git")) ? root : undefined;
};

const isRegularFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/** Up to `limit` bytes from the start of `file`; a read may return short, so go on until full or EOF. */
const readHead = async (file: FileHandle, limit: number): Promise<Buffer> => {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    const { bytesRead } = await file.read(buffer, filled, limit - filled, filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
};

/** The daemon's reader: node fs. `stat` decides what is a regular file, so a FIFO is never opened. */
export const nodeSourceReader: SourceReader = {
  regularFiles: async (dir, names) => {
    const checks = await Promise.all(
      names.map(async (name) => ((await isRegularFile(join(dir, name))) ? name : undefined)),
    );
    return new Set(checks.filter((name): name is string => name !== undefined));
  },
  readCapped: async (path) => {
    try {
      const file = await open(path, "r");
      try {
        return (await readHead(file, SOURCE_CAP_BYTES + 1)).toString("utf8");
      } finally {
        await file.close();
      }
    } catch (error) {
      console.error(`project context: cannot read ${path}: ${String(error)}`);
      return undefined;
    }
  },
};

/** A constant section, omitted when there is no text. */
export const projectContextExtension = (text: string | undefined): Extension =>
  defineExtension({
    name: "project_context",
    sections: [section("project_context", () => text, { tag: true })],
  });
