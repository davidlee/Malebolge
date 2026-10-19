import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPEND_SYSTEM_FILE,
  CONTEXT_FILE_NAMES,
  capSource,
  type ContextSource,
  gitRootDirs,
  nodeSourceReader,
  projectContextExtension,
  readChainDir,
  readSources,
  renderProjectContext,
  SOURCE_CAP_BYTES,
  type SourceReader,
} from "../src/project-context.ts";
import { tempDir } from "./fixtures.ts";
import { openTestHarness, systemPromptSections } from "./harness-fixture.ts";

const MARKER = "[truncated at 65536 bytes]";

/** Whether git finds a work tree at or above `dir`: an oracle independent of gitRootDirs. */
const underRepo = (dir: string): boolean => {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const pathSource = (path: string, text: string): ContextSource => ({ origin: { path }, text });

/** A reader over an in-memory file map; `regular` lists the paths that are regular files. */
const fakeReader = (
  files: Record<string, string | undefined>,
  regular: readonly string[] = Object.keys(files),
): SourceReader & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    regularFiles: (dir, names) =>
      Promise.resolve(new Set(names.filter((name) => regular.includes(join(dir, name))))),
    readCapped: (path): Promise<string | undefined> => {
      reads.push(path);
      return Promise.resolve(files[path]);
    },
  };
};

describe("capSource", () => {
  it("leaves text under the cap untouched", () => {
    expect(capSource({ path: "/a" }, "hello")).toEqual(pathSource("/a", "hello"));
  });

  it("cuts text over the cap on a character boundary and appends the marker", () => {
    const text = `${"a".repeat(SOURCE_CAP_BYTES - 1)}€tail`;
    const source = capSource({ path: "/a" }, text);
    expect(source.text).toBe(`${"a".repeat(SOURCE_CAP_BYTES - 1)}\n${MARKER}`);
    expect(source.text).not.toContain("�");
  });

  it("does not mark text of exactly SOURCE_CAP_BYTES", () => {
    const text = "a".repeat(SOURCE_CAP_BYTES);
    expect(capSource({ path: "/a" }, text).text).toBe(text);
  });

  it("strips a leading byte-order mark", () => {
    expect(capSource({ path: "/a" }, "﻿hi").text).toBe("hi");
  });
});

describe("readChainDir", () => {
  it("prefers names in CONTEXT_FILE_NAMES order", async () => {
    const reader = fakeReader({
      "/d/AGENTS.md": "plain",
      "/d/AGENTS.override.md": "override",
      "/d/CLAUDE.md": "claude",
    });
    expect(CONTEXT_FILE_NAMES[0]).toBe("AGENTS.override.md");
    expect(await readChainDir("/d", reader)).toEqual(
      pathSource("/d/AGENTS.override.md", "override"),
    );
  });

  it("uses CLAUDE.md when there is no AGENTS file", async () => {
    const reader = fakeReader({ "/d/CLAUDE.md": "claude" });
    expect(await readChainDir("/d", reader)).toEqual(pathSource("/d/CLAUDE.md", "claude"));
  });

  it("skips, unread, a name that is not a regular file", async () => {
    const reader = fakeReader({ "/d/AGENTS.md": "never read", "/d/CLAUDE.md": "claude" }, [
      "/d/CLAUDE.md",
    ]);
    expect(await readChainDir("/d", reader)).toEqual(pathSource("/d/CLAUDE.md", "claude"));
    expect(reader.reads).toEqual(["/d/CLAUDE.md"]);
  });

  it("falls through a file that does not read", async () => {
    const reader = fakeReader({ "/d/AGENTS.md": undefined, "/d/CLAUDE.md": "claude" });
    expect(await readChainDir("/d", reader)).toEqual(pathSource("/d/CLAUDE.md", "claude"));
  });

  it("is undefined when nothing reads", async () => {
    expect(await readChainDir("/d", fakeReader({}))).toBeUndefined();
  });

  it("takes an empty file as the pick, as pi does", async () => {
    const reader = fakeReader({ "/d/AGENTS.md": "", "/d/CLAUDE.md": "claude" });
    expect(await readChainDir("/d", reader)).toEqual(pathSource("/d/AGENTS.md", ""));
  });
});

describe("readSources", () => {
  const append = join("/w", APPEND_SYSTEM_FILE);
  const extra: ContextSource = { origin: { command: "boot" }, text: "boot" };
  const files = {
    [append]: "append",
    "/AGENTS.md": "outer",
    "/w/AGENTS.md": "inner",
  };

  it("orders APPEND_SYSTEM, then extra, then the chain outermost first", async () => {
    const sources = await readSources("/w", ["/", "/w"], fakeReader(files), extra);
    expect(sources).toEqual([
      pathSource(append, "append"),
      extra,
      pathSource("/AGENTS.md", "outer"),
      pathSource("/w/AGENTS.md", "inner"),
    ]);
  });

  it("omits each part that is absent", async () => {
    expect(await readSources("/w", ["/", "/w"], fakeReader({ [append]: "append" }))).toEqual([
      pathSource(append, "append"),
    ]);
    expect(await readSources("/w", ["/w"], fakeReader({ "/w/AGENTS.md": "inner" }), extra)).toEqual(
      [extra, pathSource("/w/AGENTS.md", "inner")],
    );
    expect(await readSources("/w", ["/w"], fakeReader({}))).toEqual([]);
  });

  it("does not read APPEND_SYSTEM unless it is a regular file", async () => {
    const reader = fakeReader(files, ["/w/AGENTS.md"]);
    await readSources("/w", ["/w"], reader);
    expect(reader.reads).toEqual(["/w/AGENTS.md"]);
  });

  it("drops sources with no text", async () => {
    const reader = fakeReader({ [append]: "﻿", "/w/AGENTS.md": "" });
    expect(await readSources("/w", ["/w"], reader, { origin: { command: "x" }, text: "" })).toEqual(
      [],
    );
  });
});

describe("renderProjectContext", () => {
  it("is undefined for no sources", () => {
    expect(renderProjectContext([])).toBeUndefined();
  });

  it("renders paths and commands as pi's project_instructions blocks", () => {
    expect(
      renderProjectContext([
        pathSource("/w/AGENTS.md", "rules"),
        { origin: { command: "doctrine prompt resolve" }, text: "boot" },
      ]),
    ).toBe(
      [
        "Project-specific instructions and guidelines:",
        "",
        '<project_instructions path="/w/AGENTS.md">',
        "rules",
        "</project_instructions>",
        "",
        '<project_instructions command="doctrine prompt resolve">',
        "boot",
        "</project_instructions>",
      ].join("\n"),
    );
  });

  it("escapes attribute values", () => {
    const rendered = renderProjectContext([pathSource(`/a"b&<c>/AGENTS.md`, "x")]);
    expect(rendered).toContain('path="/a&quot;b&amp;&lt;c&gt;/AGENTS.md"');
  });

  it("renders the body as is, even a closing tag", () => {
    const rendered = renderProjectContext([pathSource("/a", "x </project_instructions> <&>")]);
    expect(rendered).toContain("\nx </project_instructions> <&>\n");
  });
});

describe("gitRootDirs and nodeSourceReader", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });
  const fresh = async (): Promise<string> => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    return tmp.dir;
  };

  it("gitRootDirs stops at the directory holding .git, outermost first", async () => {
    const root = await fresh();
    const cwd = join(root, "repo", "a", "b");
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    expect(gitRootDirs(cwd)).toEqual([join(root, "repo"), join(root, "repo", "a"), cwd]);
  });

  it("gitRootDirs treats a .git file as a root (worktree, submodule)", async () => {
    const root = await fresh();
    const cwd = join(root, "wt", "sub");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, "wt", ".git"), "gitdir: elsewhere\n");
    expect(gitRootDirs(cwd)).toEqual([join(root, "wt"), cwd]);
  });

  it("gitRootDirs is cwd alone when there is no .git (even at /)", () => {
    expect(gitRootDirs("/")).toEqual(["/"]);
  });

  // tmp may itself sit under a repo, whose root would then start the chain.
  it.skipIf(underRepo(tmpdir()))(
    "gitRootDirs is cwd alone when no ancestor holds .git",
    async () => {
      const root = await fresh();
      expect(gitRootDirs(root)).toEqual([root]);
    },
  );

  it("reads AGENTS.md through a symlink", async () => {
    const dir = await fresh();
    await writeFile(join(dir, "CLAUDE.md"), "via link");
    await symlink("CLAUDE.md", join(dir, "AGENTS.md"));
    expect(await readChainDir(dir, nodeSourceReader)).toEqual(
      pathSource(join(dir, "AGENTS.md"), "via link"),
    );
  });

  it("skips a broken symlink and a directory named AGENTS.md", async () => {
    const dir = await fresh();
    await symlink("missing", join(dir, "AGENTS.override.md"));
    await mkdir(join(dir, "AGENTS.md"));
    await writeFile(join(dir, "CLAUDE.md"), "claude");
    expect(await readChainDir(dir, nodeSourceReader)).toEqual(
      pathSource(join(dir, "CLAUDE.md"), "claude"),
    );
  });

  it("never opens a FIFO named AGENTS.md", { timeout: 2000 }, async () => {
    const dir = await fresh();
    execFileSync("mkfifo", [join(dir, "AGENTS.md")]);
    await writeFile(join(dir, "CLAUDE.md"), "claude");
    expect(await readChainDir(dir, nodeSourceReader)).toEqual(
      pathSource(join(dir, "CLAUDE.md"), "claude"),
    );
  });

  it("never opens a FIFO at .pi/APPEND_SYSTEM.md", { timeout: 2000 }, async () => {
    const dir = await fresh();
    await mkdir(join(dir, ".pi"));
    execFileSync("mkfifo", [join(dir, APPEND_SYSTEM_FILE)]);
    await writeFile(join(dir, "AGENTS.md"), "rules");
    expect(await readSources(dir, [dir], nodeSourceReader)).toEqual([
      pathSource(join(dir, "AGENTS.md"), "rules"),
    ]);
  });

  it("marks a file over the cap, with no replacement character from a split tail", async () => {
    const dir = await fresh();
    // A 3-byte character straddles the cap: the reader's cap+1 bytes end inside it.
    await writeFile(join(dir, "AGENTS.md"), `${"a".repeat(SOURCE_CAP_BYTES - 1)}€€`);
    const source = await readChainDir(dir, nodeSourceReader);
    expect(source?.text).toBe(`${"a".repeat(SOURCE_CAP_BYTES - 1)}\n${MARKER}`);
  });

  it("strips a BOM from a file", async () => {
    const dir = await fresh();
    await writeFile(join(dir, "AGENTS.md"), "﻿hi");
    expect((await readChainDir(dir, nodeSourceReader))?.text).toBe("hi");
  });

  it("reads a file that is gone as undefined, logging it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await nodeSourceReader.readCapped("/nonexistent/AGENTS.md")).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe("projectContextExtension", () => {
  it("is a tagged project_context section holding the text", async () => {
    const extension = projectContextExtension("rules");
    expect((extension.sections ?? []).map(({ key, tag }) => [key, tag])).toEqual([
      ["project_context", true],
    ]);
    const prompts = await systemPromptSections(await openTestHarness([extension]));
    expect(prompts).toEqual([{ project_context: "<project_context>\nrules\n</project_context>" }]);
  });

  it("renders no section without text", async () => {
    const prompts = await systemPromptSections(
      await openTestHarness([projectContextExtension(undefined)]),
    );
    expect(prompts).toEqual([]);
  });
});
