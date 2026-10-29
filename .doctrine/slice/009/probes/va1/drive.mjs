// Usage: node drive.mjs <probe>   probes: ex1 ex5 ex6 ex7 ex7b
// Drives `pi --mode rpc` with isolated agent dir + stub; writes <probe>.stub.jsonl and <probe>.rpc.jsonl; prints summary.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const probe = process.argv[2];
const stubLog = join(here, `${probe}.stub.jsonl`), rpcLog = join(here, `${probe}.rpc.jsonl`);
for (const f of [stubLog, rpcLog]) rmSync(f, { force: true });
writeFileSync(stubLog, ""); writeFileSync(rpcLog, "");
const work = join(here, "work", probe); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });

const pi = spawn(join(process.env.HOME, ".nix-profile/bin/pi"),
  ["--mode", "rpc", "--no-session", "-e", join(here, "stub.ts"), "--provider", "fake", "--model", "fake-1",
   "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline"],
  { cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: join(here, "agentdir"), STUB_LOG: stubLog }, stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const events = [];
const t0 = Date.now();
pi.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) {
  const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
  const o = JSON.parse(line); events.push(o);
  writeFileSync(rpcLog, JSON.stringify({ t: Date.now() - t0, ...o }) + "\n", { flag: "a" }); } });
pi.stderr.on("data", (d) => writeFileSync(rpcLog, JSON.stringify({ stderr: String(d) }) + "\n", { flag: "a" }));
const send = (o) => pi.stdin.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 15000) => { const s = Date.now(); while (Date.now() - s < ms) { if (events.some(pred)) return; await sleep(20); } throw new Error("timeout waiting"); };
const nSettled = () => events.filter((e) => e.type === "agent_settled").length;
const prompt = (m) => send({ type: "prompt", message: m });

await sleep(1500); // startup
const scenarios = {
  async ex1() {
    prompt("/stub-send false note-no-trigger"); await sleep(1000);
    prompt("/stub-send true note-trigger"); await sleep(1500);
    prompt("/stub-dump final"); await sleep(300);
  },
  async ex5() {
    prompt("DELAY hello");              // before_agent_start sleeps 1.5s
    await sleep(500);                   // inside window
    prompt("/stub-deliver note during-window");
    await sleep(200);
    send({ type: "get_state", id: "st1" });
    await sleep(100);
    send({ type: "abort" });
    await waitFor((e) => e.type === "agent_settled", 8000);
    await sleep(500);
    prompt("/stub-dump final"); await sleep(300);
  },
  async ex6() {
    prompt("FAILONCE hello");
    await waitFor((e) => e.type === "agent_settled", 15000);
    await sleep(1500); // look for a second agent_settled
    prompt("/stub-dump final"); await sleep(300);
  },
  async ex7() {
    prompt("SLOW hello");
    await waitFor((e) => e.type === "agent_start"); await sleep(300);
    prompt("/stub-deliver note buffered-note");
    await sleep(200);
    send({ type: "abort" });
    await waitFor((e) => e.type === "agent_settled", 8000);
    await sleep(1500);
    prompt("/stub-dump final"); await sleep(300);
  },
  async ex7b() { // aborted: buffered 'turn' kind must not start a turn; plus non-aborted comparison
    prompt("SLOW hello");
    await waitFor((e) => e.type === "agent_start"); await sleep(300);
    prompt("/stub-deliver turn buffered-turn-aborted");
    await sleep(200); send({ type: "abort" });
    await waitFor((e) => e.type === "agent_settled", 8000); await sleep(1500);
    prompt("/stub-dump after-abort"); await sleep(300);
    // non-aborted comparison: busy run completes normally with a buffered turn
    prompt("DELAY hello2"); await sleep(400);
    prompt("/stub-deliver turn buffered-turn-normal");
    const n = nSettled(); await waitFor(() => nSettled() > n, 10000); await sleep(1500);
    prompt("/stub-dump after-normal"); await sleep(300);
  },
};
try { await scenarios[probe](); } catch (e) { console.error("DRIVER ERROR", e.message); }
pi.kill();
const lines = readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
for (const l of lines) {
  if (l.ev === "entries") console.log(`${String(l.t).padStart(5)} entries[${l.label}] n=${l.n} idle=${l.idle} ${JSON.stringify(l.entries.map((e) => e.content))}`);
  else { const { t, ev, ...r } = l; console.log(`${String(t).padStart(5)} ${ev} ${JSON.stringify(r)}`); }
}
console.log("--- rpc event types (order):", events.filter((e) => e.type !== "response").map((e) => e.type).filter((t, i, a) => !(t === a[i - 1] && /update|delta/.test(t))).join(" "));
const st = events.find((e) => e.id === "st1"); if (st) console.log("--- get_state:", JSON.stringify(st.data ?? st).slice(0, 400));
