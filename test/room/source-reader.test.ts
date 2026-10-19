// The room's source reader (design §4.1): project-context reads over a room
// shell, each failure handed to the caller as a ReadFailure, and what the
// classification does not answer for rethrown, the callback untold.

import { ExecutionError } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { ChannelFailed, ChannelUnavailable, type ShellOutput } from "../../src/room/shell.ts";
import { type ReadFailure, roomSourceReader } from "../../src/room/source-reader.ts";
import { exit, never, overflowed, recordingShell, rejection } from "./shell-fixture.ts";

/** A reader over a shell answering every call by `answer`, and the failures it reported. */
function readerOver(
  answer: (argv: readonly string[]) => ShellOutput,
  signal = never(),
): {
  reader: ReturnType<typeof roomSourceReader>;
  failures: [string, ReadFailure][];
} {
  const failures: [string, ReadFailure][] = [];
  const { shell } = recordingShell(answer);
  const reader = roomSourceReader(shell, signal, (source, failure) => {
    failures.push([source, failure]);
  });
  return { reader, failures };
}

const throwing =
  (error: unknown): (() => never) =>
  () => {
    throw error;
  };

const execFailed = (code: ExecutionError["code"]): ChannelFailed =>
  new ChannelFailed(`exec: ${code}`, { cause: new ExecutionError(code, code) });

describe("roomSourceReader: reads", () => {
  it("answers the regular files stat reports, and a capped read's text", async () => {
    const { reader, failures } = readerOver((argv) =>
      argv[0] === "stat" ? exit(1, "8000 /d/A.md\n4000 /d/B.md\n") : exit(0, "text"),
    );

    expect(await reader.regularFiles("/d", ["A.md", "B.md", "C.md"])).toEqual(new Set(["A.md"]));
    expect(await reader.readCapped("/d/A.md")).toBe("text");
    expect(failures).toEqual([]);
  });
});

describe("roomSourceReader: failures go to the callback", () => {
  it.each<[string, () => ShellOutput, ReadFailure]>([
    ["an absent binary is missing", throwing(execFailed("spawn_error")), { reason: "missing" }],
    ["a timeout", throwing(execFailed("timeout")), { reason: "timeout" }],
    ["another exec failure", throwing(execFailed("aborted")), { reason: "error", code: "aborted" }],
    ["an overflow", (): ShellOutput => overflowed("x"), { reason: "overflow" }],
    [
      "an unnamed exit",
      (): ShellOutput => exit(2, "", "bad"),
      { reason: "error", code: 2, stderr: "bad" },
    ],
  ])("stat: %s, named for the one path asked", async (_case, answer, failure) => {
    const { reader, failures } = readerOver(answer);

    expect(await reader.regularFiles("/d", ["A.md"])).toEqual(new Set());
    expect(failures).toEqual([["/d/A.md", failure]]);
  });

  it("stat over several names is named for the directory", async () => {
    const { reader, failures } = readerOver(throwing(execFailed("timeout")));

    await reader.regularFiles("/d", ["A.md", "B.md"]);

    expect(failures).toEqual([["/d", { reason: "timeout" }]]);
  });

  it("a read that cannot run is reported; one that exits non-zero is unreadable, unreported", async () => {
    const timedOut = readerOver(throwing(execFailed("timeout")));
    const exited = readerOver(() => exit(1, "", "denied"));

    expect(await timedOut.reader.readCapped("/d/A.md")).toBeUndefined();
    expect(await exited.reader.readCapped("/d/A.md")).toBeUndefined();
    expect(timedOut.failures).toEqual([["/d/A.md", { reason: "timeout" }]]);
    expect(exited.failures).toEqual([]);
  });
});

describe("roomSourceReader: what the classification does not answer for is rethrown", () => {
  it.each<[string, unknown]>([
    ["a lost room", new ChannelUnavailable("down")],
    ["an untrusted host key", new ChannelFailed("key", { reason: "host_key" })],
    ["a non-channel error (a bug)", new TypeError("bug")],
  ])("%s", async (_case, error) => {
    const { reader, failures } = readerOver(throwing(error));

    expect(await rejection(reader.regularFiles("/d", ["A.md"]))).toBe(error);
    expect(await rejection(reader.readCapped("/d/A.md"))).toBe(error);
    expect(failures).toEqual([]);
  });

  it("the caller's abort, whatever the failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = execFailed("timeout");
    const { reader, failures } = readerOver(throwing(error), controller.signal);

    expect(await rejection(reader.readCapped("/d/A.md"))).toBe(error);
    expect(failures).toEqual([]);
  });
});
