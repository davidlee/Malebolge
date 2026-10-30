// Socket-activated host helper. The socket carries only a response; no caller
// input is interpreted as a command or an argument.
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "room-behind";
if (mode !== "room-behind" && mode !== "sync-room") {
  throw new Error("unknown host helper mode");
}
const sync = mode === "sync-room";
const justArgs = [
  "--shell",
  "bash",
  "--clear-shell-args",
  "--shell-arg=-o",
  "--shell-arg=pipefail",
  "--shell-arg=-c",
  mode,
];
const runtime = process.env["XDG_RUNTIME_DIR"] ?? tmpdir();
const program = sync ? "flock" : "just";
const args = sync
  ? ["--nonblock", join(runtime, "room-behind", "sync.lock"), "just", ...justArgs]
  : justArgs;
execFile(
  program,
  args,
  { cwd: join(homedir(), "flakes"), timeout: sync ? 300_000 : 30_000, maxBuffer: 48 * 1024 },
  (error, stdout, stderr) => {
    const text =
      error === null
        ? stdout
        : `command failed${sync ? "; sync may have partially completed" : ""}: ${(stderr !== "" ? stderr : error.message).slice(0, 4096)}${stdout !== "" ? `\nOutput before failure:\n${stdout.slice(0, 32_000)}` : ""}`;
    process.stdout.write(JSON.stringify({ ok: error === null, text }));
  },
);
