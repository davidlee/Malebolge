// The command line as parsed: what each flag combination asks for, and what is
// refused before any socket is opened (SL-003 EX-6's split).

import { describe, expect, it } from "vitest";
import { attachInvocationOf, attachTargetOf, UsageError } from "../src/attach-invocation.ts";
import type { AttachTarget } from "../src/protocol.ts";

describe("attachTargetOf", () => {
  it.each<[string[], AttachTarget]>([
    [[], { kind: "root" }],
    [["--conversation", "3"], { kind: "existing", id: 3 }],
    [["--conversation=3"], { kind: "existing", id: 3 }],
    [["--new"], { kind: "new" }],
    [["--new", "--cwd", "/tmp/a b"], { kind: "new", cwd: "/tmp/a b" }],
    [["--new", "--cwd", ""], { kind: "new", cwd: "" }],
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
  ])("%j is a usage error", (args) => {
    expect(() => attachTargetOf(args)).toThrow(UsageError);
  });
});

describe("attachInvocationOf", () => {
  it.each<[string[], unknown]>([
    [[], { target: { kind: "root" }, inputMode: "lines", presentation: "terminal" }],
    [["--emacs"], { target: { kind: "root" }, inputMode: "frames", presentation: "emacs" }],
    [
      ["--emacs", "--conversation", "3"],
      { target: { kind: "existing", id: 3 }, inputMode: "frames", presentation: "emacs" },
    ],
    [
      ["--emacs", "--new", "--cwd", "/x"],
      { target: { kind: "new", cwd: "/x" }, inputMode: "frames", presentation: "emacs" },
    ],
  ])("%j → %j", (args, invocation) => {
    expect(attachInvocationOf(args)).toEqual(invocation);
  });

  it("still refuses an unknown flag", () => {
    expect(() => attachInvocationOf(["--emacs", "--wat"])).toThrow(UsageError);
  });
});

describe("--list", () => {
  it("refuses --list combined with an attach flag as a UsageError", () => {
    for (const args of [
      ["--list", "--conversation", "3"],
      ["--list", "--new"],
      ["--list", "--new", "--cwd", "/x"],
      ["--list", "--cwd", "/x"],
      ["--list", "--emacs"],
      ["--emacs", "--list"],
    ]) {
      expect(() => attachInvocationOf(args)).toThrow(UsageError);
    }
    // It names no attach target either, so that parse refuses it too.
    expect(() => attachTargetOf(["--list"])).toThrow(UsageError);
  });

  it("is a list invocation on its own LIST_WAIT, not the attach wait", () => {
    expect(attachInvocationOf(["--list"])).toEqual({
      mode: "list",
      wait: { intervalMs: 200, timeoutMs: 1_000 },
    });
  });
});
