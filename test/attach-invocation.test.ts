// The command line as parsed: what each flag combination asks for, and what is
// refused before any socket is opened (SL-003 EX-2's table, EX-6's split).

import { describe, expect, it } from "vitest";
import { attachInvocationOf, attachTargetOf, UsageError } from "../src/attach-invocation.ts";
import type { AttachTarget } from "../src/protocol.ts";

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
