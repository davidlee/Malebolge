import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isRecord } from "../src/json.ts";
import { readRoomBehind, roomBehindExtension } from "../src/room-behind.ts";

async function response(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "room-behind-"));
  const path = join(dir, "socket");
  const server = createServer((socket) => socket.end(body));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    return await readRoomBehind(path);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
    await rm(dir, { recursive: true, force: true });
  }
}

describe("room-behind host bridge", () => {
  it("never replays a sync automatically", () => {
    expect(roomBehindExtension.tools?.find((tool) => tool.name === "sync_room")?.replay).toBe(
      "unsafe",
    );
  });
  it("returns the host result", async () => {
    await expect(
      response(JSON.stringify({ ok: true, text: "repo\tbehind\nfoo\t1\n" })),
    ).resolves.toBe("repo\tbehind\nfoo\t1\n");
  });
  it("reports command failures and malformed responses", async () => {
    await expect(response(JSON.stringify({ ok: false, text: "command failed" }))).rejects.toThrow(
      "command failed",
    );
    await expect(response("bad")).rejects.toThrow();
  });
  it("rejects oversized responses", async () => {
    await expect(response("x".repeat(70_000))).rejects.toThrow("exceeds");
  });
});

it("runs only the fixed sync recipe and returns partial output on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sync-helper-"));
  try {
    await mkdir(join(dir, "flakes"));
    await mkdir(join(dir, "room-behind"));
    await writeFile(join(dir, "just"), "#!/bin/sh\nprintf 'ran %s\\n' \"$*\"\nexit 7\n", {
      mode: 0o755,
    });
    const result = await promisify(execFile)(
      process.execPath,
      ["src/room-behind-host.ts", "sync-room"],
      {
        env: {
          ...process.env,
          HOME: dir,
          XDG_RUNTIME_DIR: dir,
          PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        },
      },
    );
    const response: unknown = JSON.parse(result.stdout);
    if (!isRecord(response) || typeof response["text"] !== "string") {
      throw new Error("invalid helper response");
    }
    expect(response["ok"]).toBe(false);
    expect(response["text"]).toContain("sync may have partially completed");
    expect(response["text"]).toContain("sync-room");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
