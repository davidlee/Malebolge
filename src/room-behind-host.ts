// Socket-activated host helper. The socket carries only a response; no caller
// input is interpreted as a command or an argument.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

execFile(
  "just",
  [
    "--shell",
    "bash",
    "--clear-shell-args",
    "--shell-arg=-o",
    "--shell-arg=pipefail",
    "--shell-arg=-c",
    "room-behind",
  ],
  { cwd: join(homedir(), "flakes"), timeout: 30_000, maxBuffer: 48 * 1024 },
  (error, stdout, stderr) => {
    const text =
      error === null
        ? stdout
        : `command failed: ${(stderr !== "" ? stderr : error.message).slice(0, 4096)}`;
    process.stdout.write(JSON.stringify({ ok: error === null, text }));
  },
);
