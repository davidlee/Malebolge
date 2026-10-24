// The command line as parsed: what each flag combination asks for, and what is
// refused before any socket is opened (SL-003 EX-2's table, EX-6's split).

import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  attachInvocationOf,
  attachTargetOf,
  HereRefusedError,
  resolveHere,
  UsageError,
} from "../src/attach-invocation.ts";
import { messageOf } from "../src/message-of.ts";
import { encodeLine } from "../src/ndjson.ts";
import type { AttachTarget, TopicsMessage } from "../src/protocol.ts";
import { createRenderer } from "../src/render.ts";
import { frameOf } from "../src/request.ts";
import { fakeDaemon, type FakeDaemon, rejection, socketPath } from "./fixtures.ts";

/** `--here`, as parsing leaves it: resolved against the daemon later (design sec-5, DEC-014). */
const HERE = { here: true } as const;

/** A request-reply invocation's connect wait: a listing runs against a daemon already up. */
const LIST_WAIT = { intervalMs: 200, timeoutMs: 1_000 };

const ROOT_LINES = { target: { kind: "root" }, inputMode: "lines", presentation: "terminal" };
const ROOT_FRAMES = { target: { kind: "root" }, inputMode: "frames", presentation: "emacs" };

describe("attachTargetOf", () => {
  it.each<[string[], AttachTarget]>([
    [[], { kind: "root" }],
    [["--conversation", "3"], { kind: "existing", id: 3 }],
    [["--conversation=3"], { kind: "existing", id: 3 }],
    [["--new"], { kind: "new" }],
    [["--new", "--cwd", "/tmp/a b"], { kind: "new", cwd: "/tmp/a b" }],
    [["--new", "--cwd", ""], { kind: "new", cwd: "" }],
    [["--topic", "work"], { kind: "topic", name: "work", new: false }],
    [["--topic", "work", "--new"], { kind: "topic", name: "work", new: true }],
    [
      ["--topic", "work", "--new", "--cwd", "/tmp/x"],
      { kind: "topic", name: "work", new: true, cwd: "/tmp/x" },
    ],
    // One name rule, the protocol's: the boundary lengths and every allowed punctuation.
    [["--topic", "a"], { kind: "topic", name: "a", new: false }],
    [["--topic", "0default"], { kind: "topic", name: "0default", new: false }],
    [["--topic", `a${"b".repeat(63)}`], { kind: "topic", name: `a${"b".repeat(63)}`, new: false }],
    [["--topic", "a.b_c-d"], { kind: "topic", name: "a.b_c-d", new: false }],
    // `default` is the daemon's to reserve: attaching to it is how root is reached by name.
    [["--topic", "default"], { kind: "topic", name: "default", new: false }],
  ])("%j → %j", (args, target) => {
    expect(attachTargetOf(args)).toEqual(target);
  });

  it.each<string[][]>([
    [["--conversation", "3", "--new"]],
    [["--cwd", "/x"]],
    [["--conversation", "0"]],
    [["--conversation=-1"]],
    [["--conversation", "1.5"]],
    [["--conversation", "1e3"]],
    [["--conversation", "9007199254740992"]],
    [["--wat"]],
    [["x"]],
    [["--conversation"]],
    [["--new", "--cwd"]],
    // A topic target: one id, one name, and a directory only for a conversation being created.
    [["--topic"]],
    [["--topic", "work", "--conversation", "3"]],
    [["--topic", "work", "--cwd", "/x"]],
    [["--topic", ""]],
    [["--topic", "Work"]],
    [["--topic", "_work"]],
    [["--topic", `a${"b".repeat(64)}`]],
    // A directory without a topic write names no target at all.
    [["--dir", "/x"]],
    [["--no-dir"]],
  ])("%j is a usage error", (args) => {
    expect(() => attachTargetOf(args)).toThrow(UsageError);
  });

  it.each<string[][]>([
    [["--list"]],
    [["--list", "--topic", "work"]],
    [["--topics"]],
    [["--set-topic", "work"]],
  ])("%j names no attach target", (args) => {
    expect(() => attachTargetOf(args)).toThrow(UsageError);
  });
});

describe("attachInvocationOf", () => {
  it.each<[string[], unknown]>([
    [[], ROOT_LINES],
    [["--emacs"], ROOT_FRAMES],
    [["--emacs", "--conversation", "3"], { ...ROOT_FRAMES, target: { kind: "existing", id: 3 } }],
    [["--emacs", "--new", "--cwd", "/x"], { ...ROOT_FRAMES, target: { kind: "new", cwd: "/x" } }],
    [["--topic", "work"], { ...ROOT_LINES, target: { kind: "topic", name: "work", new: false } }],
    [
      ["--topic", "work", "--new", "--cwd", "/x", "--emacs"],
      { ...ROOT_FRAMES, target: { kind: "topic", name: "work", new: true, cwd: "/x" } },
    ],
    [["--list"], { mode: "list", wait: LIST_WAIT }],
    [["--list", "--topic", "work"], { mode: "list", wait: LIST_WAIT, topic: "work" }],
    [["--topics"], { mode: "topics", wait: LIST_WAIT }],
    // `cwd` absent leaves the topic's directory unchanged; `--no-dir` clears it.
    [["--set-topic", "work"], { mode: "set-topic", wait: LIST_WAIT, name: "work", cwd: undefined }],
    [
      ["--set-topic", "work", "--dir", "/tmp/x"],
      { mode: "set-topic", wait: LIST_WAIT, name: "work", cwd: "/tmp/x" },
    ],
    [
      ["--set-topic", "work", "--no-dir"],
      { mode: "set-topic", wait: LIST_WAIT, name: "work", cwd: null },
    ],
    // `--here` parses to a marker, where a topic's name or a directory would stand.
    [["--here"], { ...ROOT_LINES, target: { kind: "topic", name: HERE, new: false } }],
    [
      ["--here", "--new", "--cwd", "/repo"],
      { ...ROOT_LINES, target: { kind: "topic", name: HERE, new: true, cwd: "/repo" } },
    ],
    [["--list", "--here"], { mode: "list", wait: LIST_WAIT, topic: HERE }],
    [
      ["--set-topic", "work", "--here"],
      { mode: "set-topic", wait: LIST_WAIT, name: "work", cwd: HERE },
    ],
  ])("%j → %j", (args, invocation) => {
    expect(attachInvocationOf(args)).toEqual(invocation);
  });

  it("still refuses an unknown flag", () => {
    expect(() => attachInvocationOf(["--emacs", "--wat"])).toThrow(UsageError);
  });
});

// Every refused pair exits 2 with the usage line, because every one is a UsageError.
describe("exclusive flags", () => {
  it.each<string[][]>([
    // --topics stands alone.
    [["--topics", "--list"]],
    [["--topics", "--topic", "work"]],
    [["--topics", "--conversation", "3"]],
    [["--topics", "--new"]],
    [["--topics", "--cwd", "/x"]],
    [["--topics", "--emacs"]],
    [["--topics", "--dir", "/x"]],
    [["--topics", "--no-dir"]],
    [["--topics", "--set-topic", "work"]],
    // --set-topic takes a directory and nothing else.
    [["--set-topic", "work", "--dir", "/x", "--no-dir"]],
    [["--set-topic", "work", "--list"]],
    [["--set-topic", "work", "--topic", "work"]],
    [["--set-topic", "work", "--conversation", "3"]],
    [["--set-topic", "work", "--new"]],
    [["--set-topic", "work", "--cwd", "/x"]],
    [["--set-topic", "work", "--emacs"]],
    [["--set-topic", "work", "--topics"]],
    // --list takes a topic filter only.
    [["--list", "--conversation", "3"]],
    [["--list", "--new"]],
    [["--list", "--new", "--cwd", "/x"]],
    [["--list", "--cwd", "/x"]],
    [["--list", "--emacs"]],
    [["--emacs", "--list"]],
    [["--list", "--dir", "/x"]],
    [["--list", "--no-dir"]],
    [["--list", "--topic", "work", "--conversation", "3"]],
    // --here stands where a topic's name or a directory would: it cannot also be given.
    [["--here", "--topic", "work"]],
    [["--here", "--conversation", "3"]],
    [["--here", "--dir", "/repo"]],
    [["--here", "--no-dir"]],
    [["--list", "--here", "--topic", "work"]],
    [["--set-topic", "work", "--here", "--dir", "/repo"]],
    [["--set-topic", "work", "--here", "--no-dir"]],
    [["--topics", "--here"]],
  ])("%j is a usage error", (args) => {
    expect(() => attachInvocationOf(args)).toThrow(UsageError);
  });

  it.each<string[][]>([
    [["--set-topic", "Work"]],
    [["--set-topic", ""]],
    [["--list", "--topic", "Work"]],
    [["--list", "--topic"]],
  ])("%j is a usage error: a name off the rule, or none at all", (args) => {
    expect(() => attachInvocationOf(args)).toThrow(UsageError);
  });
});

// ---------------------------------------------------------------------------
// `--here`, resolved against the answering daemon (design sec-5, DEC-014): the
// git root, one silent lookup, then the daemon's own profile and its topics.
// ---------------------------------------------------------------------------

/** A `topics` reply as the daemon sends it; `profile` is the answering daemon's own. */
const topicsReply = (
  profile: "host" | "room",
  topics: { name: string; cwd?: string }[],
): TopicsMessage => ({ type: "topics", profile, topics });

/** A stub daemon answering every connection's lookup with `reply`, and what it heard. */
async function answering(reply: TopicsMessage): Promise<{ path: string; fake: FakeDaemon }> {
  const path = await socketPath();
  const fake = await fakeDaemon(path, (socket) => {
    socket.write(encodeLine(reply));
  });
  return { path, fake };
}

/** The git-root lookup, stubbed: `resolveHere` takes it, so no test runs git. */
const rootAt =
  (root: string | undefined): (() => string | undefined) =>
  () =>
    root;

/** What `resolveHere` refuses with: the one line `attach-main` prints, then exit 1. */
const refusalOf = async (run: Promise<unknown>): Promise<string> => messageOf(await rejection(run));

/** The frames the daemon heard, once the client is gone: a refusal sends nothing after the lookup. */
async function framesHeard(fake: FakeDaemon): Promise<readonly string[]> {
  await fake.lines.next((line) => line.includes('"topics":true'));
  fake.destroy();
  await fake.closed;
  return fake.lines.items;
}

describe("resolveHere: one exact match (EX-1)", () => {
  it("substitutes the one topic at the git root, and the frame carries its name", async () => {
    const { path } = await answering(
      topicsReply("host", [
        { name: "default" },
        { name: "work", cwd: "/repo" },
        { name: "nested", cwd: "/repo/sub" },
      ]),
    );
    const attaching = await resolveHere(attachInvocationOf(["--here"]), path, rootAt("/repo"));
    expect(attaching).toMatchObject({
      target: { kind: "topic", name: "work", new: false },
      inputMode: "lines",
    });

    const listing = await resolveHere(
      attachInvocationOf(["--list", "--here"]),
      path,
      rootAt("/repo"),
    );
    expect(listing.mode).toBe("list");
    if (listing.mode === "list") {
      expect(frameOf(listing)).toEqual({ type: "list", topic: "work" });
    }
  });

  it("leaves an invocation with no --here alone, without asking the daemon", async () => {
    // No daemon listens at this path: a lookup would fail, so this proves none was made.
    const path = await socketPath();
    const invocation = attachInvocationOf(["--topic", "work"]);
    expect(await resolveHere(invocation, path, rootAt("/repo"))).toEqual(invocation);
  });
});

describe("resolveHere: refusals (EX-2)", () => {
  it("refuses outside a git repository, and sends nothing at all", async () => {
    const path = await socketPath();
    expect(
      await refusalOf(resolveHere(attachInvocationOf(["--here"]), path, rootAt(undefined))),
    ).toBe("--here needs a git repository: none is above this directory");
  });

  it("refuses a room daemon's topics, whatever the client's own MALEBOLGE_PROFILE says", async () => {
    // The client's profile picks the default socket and nothing else: here it would pick host.
    vi.stubEnv("MALEBOLGE_PROFILE", "host");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const { path, fake } = await answering(
      topicsReply("room", [{ name: "work", cwd: "/home/room/repo" }]),
    );
    const refusal = refusalOf(resolveHere(attachInvocationOf(["--here"]), path, rootAt("/repo")));
    expect(await refusal).toBe(
      "--here needs a host daemon: this daemon runs under room, so its topic directories are room paths, not this shell's",
    );
    expect(await framesHeard(fake)).toHaveLength(1);
  });

  it("succeeds against a host daemon with no MALEBOLGE_PROFILE set", async () => {
    vi.stubEnv("MALEBOLGE_PROFILE", undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const { path } = await answering(topicsReply("host", [{ name: "work", cwd: "/repo" }]));
    expect(await resolveHere(attachInvocationOf(["--here"]), path, rootAt("/repo"))).toMatchObject({
      target: { kind: "topic", name: "work" },
    });
  });

  it("refuses when no topic has the git root as its directory", async () => {
    const { path, fake } = await answering(
      topicsReply("host", [{ name: "default" }, { name: "work", cwd: "/elsewhere" }]),
    );
    const run = resolveHere(attachInvocationOf(["--list", "--here"]), path, rootAt("/repo"));
    await expect(run).rejects.toBeInstanceOf(HereRefusedError);
    expect(await refusalOf(run)).toBe("no topic has directory /repo");
    expect(await framesHeard(fake)).toHaveLength(1);
  });

  it("refuses several matches, naming them, rather than picking one", async () => {
    const { path, fake } = await answering(
      topicsReply("host", [
        { name: "alpha", cwd: "/repo" },
        { name: "beta", cwd: "/repo" },
      ]),
    );
    const refusal = refusalOf(resolveHere(attachInvocationOf(["--here"]), path, rootAt("/repo")));
    expect(await refusal).toBe("topics alpha, beta have directory /repo; name one with --topic");
    expect(await framesHeard(fake)).toHaveLength(1);
  });
});

describe("resolveHere: --set-topic --here (EX-3)", () => {
  it.each<[string, { name: string; cwd?: string }[]]>([
    ["no existing match", [{ name: "default" }]],
    ["one existing match", [{ name: "work", cwd: "/repo" }]],
    [
      "several existing matches",
      [
        { name: "alpha", cwd: "/repo" },
        { name: "beta", cwd: "/repo" },
      ],
    ],
  ])("writes the git root as the directory, with %s", async (_case, topics) => {
    const { path } = await answering(topicsReply("host", topics));
    const resolved = await resolveHere(
      attachInvocationOf(["--set-topic", "fresh", "--here"]),
      path,
      rootAt("/repo"),
    );
    expect(resolved.mode).toBe("set-topic");
    if (resolved.mode === "set-topic") {
      expect(resolved.cwd).toBe("/repo");
      expect(frameOf(resolved)).toEqual({ type: "topic", name: "fresh", cwd: "/repo" });
    }
  });

  it("refuses against a room daemon, writing nothing", async () => {
    const { path, fake } = await answering(topicsReply("room", []));
    const refusal = refusalOf(
      resolveHere(attachInvocationOf(["--set-topic", "fresh", "--here"]), path, rootAt("/repo")),
    );
    expect(await refusal).toContain("--here needs a host daemon");
    expect(await framesHeard(fake)).toHaveLength(1);
  });
});

describe("resolveHere: the lookup is silent (EX-4)", () => {
  it("--list --here writes nothing to stdout: its caller renders only the ids", async () => {
    const write = vi.spyOn(process.stdout, "write");
    onTestFinished(() => {
      write.mockRestore();
    });
    const { path } = await answering(topicsReply("host", [{ name: "work", cwd: "/repo" }]));
    const resolved = await resolveHere(
      attachInvocationOf(["--list", "--here"]),
      path,
      rootAt("/repo"),
    );
    expect(write).not.toHaveBeenCalled();
    expect(
      createRenderer()({ type: "conversations", conversations: [7, 3], truncated: false }),
    ).toBe("7\n3\n");
    expect(resolved.mode).toBe("list");
  });
});
