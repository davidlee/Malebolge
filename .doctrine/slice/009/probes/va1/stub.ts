// SL-009 VA-1 probe stub: fake provider + bridge-delivery simulation + event log.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG = process.env.STUB_LOG ?? "/dev/null";
const t0 = Date.now();
const log = (o: Record<string, unknown>) =>
  appendFileSync(LOG, `${JSON.stringify({ t: Date.now() - t0, ...o })}\n`);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const id = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); res(); });
  });

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let failedOnce = false;

const lastUserText = (ctx: any): string => {
  const ms = [...ctx.messages].reverse().find((m: any) => m.role === "user");
  if (!ms) return "";
  return typeof ms.content === "string" ? ms.content : ms.content.map((c: any) => c.text ?? "").join("");
};

function fakeStream(model: any, context: any, options?: any) {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const text = lastUserText(context);
    const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
    log({ ev: "provider_call", text: text.slice(0, 40) });
    if (text.includes("FAILONCE") && !failedOnce) {
      failedOnce = true;
      stream.push({ type: "error", reason: "error", error: { ...base, content: [], stopReason: "error", errorMessage: "503 service unavailable (stub)" } });
      stream.end();
      return;
    }
    if (text.includes("SLOW")) await sleep(4000, options?.signal);
    if (options?.signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: { ...base, content: [], stopReason: "aborted", errorMessage: "Request aborted" } });
      stream.end();
      return;
    }
    const msg = { ...base, content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    stream.push({ type: "start", partial: { ...msg, content: [] } });
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...msg, content: [{ type: "text", text: "" }] } });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: msg });
    stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: msg });
    stream.push({ type: "done", reason: "stop", message: msg });
    stream.end();
  })();
  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:1", apiKey: "x", api: "fake-api",
    models: [{ id: "fake-1", name: "fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
    streamSimple: fakeStream as any,
  });

  // --- bridge simulation (DEC-090): deliver only while idle and not running; else buffer; flush on settle.
  let running = false;
  const buffer: { kind: "note" | "turn"; text: string }[] = [];
  let ctxRef: any;
  const customEntries = (ctx: any) =>
    ctx.sessionManager.getEntries().filter((e: any) => e.type === "custom_message")
      .map((e: any) => ({ id: e.id, type: e.customType, content: e.content, details: e.details }));
  const snap = (label: string, ctx: any) =>
    log({ ev: "entries", label, n: customEntries(ctx).length, entries: customEntries(ctx), idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });

  const sendNow = (ctx: any, kind: "note" | "turn", text: string, triggerTurn: boolean) => {
    log({ ev: "pi.sendMessage", kind, text, triggerTurn });
    pi.sendMessage({ customType: "probe", content: text, display: true, details: { text, kind } }, { triggerTurn });
  };
  const deliver = (ctx: any, kind: "note" | "turn", text: string) => {
    const idle = ctx.isIdle();
    log({ ev: "deliver", kind, text, idle, running });
    if (idle && !running) sendNow(ctx, kind, text, kind === "turn");
    else { buffer.push({ kind, text }); log({ ev: "buffered", n: buffer.length }); }
  };

  pi.registerCommand("stub-deliver", { description: "deliver <note|turn> <text>", handler: async (args: string, ctx: any) => {
    const [kind, ...rest] = args.split(" "); deliver(ctx, kind as any, rest.join(" "));
  } });
  // EX-1: raw sendMessage while idle; snapshot entries at return, after a microtask, a macrotask, and 300ms.
  pi.registerCommand("stub-send", { description: "send <true|false> <text>", handler: async (args: string, ctx: any) => {
    const [tt, ...rest] = args.split(" ");
    snap(`before(${tt})`, ctx);
    pi.sendMessage({ customType: "probe", content: rest.join(" "), display: true, details: { text: rest.join(" "), tt } }, { triggerTurn: tt === "true" });
    snap(`sync-after-return(${tt})`, ctx);
    await Promise.resolve(); snap(`microtask(${tt})`, ctx);
    await sleep(0); snap(`macrotask(${tt})`, ctx);
    await sleep(300); snap(`+300ms(${tt})`, ctx);
  } });
  pi.registerCommand("stub-dump", { description: "dump entries", handler: async (args: string, ctx: any) => snap(`dump:${args}`, ctx) });

  pi.on("session_start", async (_e: any, ctx: any) => { ctxRef = ctx; log({ ev: "session_start" }); });
  pi.on("before_agent_start", async (e: any, ctx: any) => {
    log({ ev: "before_agent_start", idle: ctx.isIdle(), running, messageType: e.messageType });
    if (e.messageType === "user" && e.prompt.includes("DELAY")) {
      await sleep(1500, ctx.signal);
      log({ ev: "before_agent_start:delay-done", idle: ctx.isIdle(), running });
    }
  });
  pi.on("agent_start", async (_e: any, ctx: any) => { running = true; log({ ev: "agent_start", idle: ctx.isIdle() }); });
  pi.on("turn_start", async (_e: any, ctx: any) => log({ ev: "turn_start" }));
  pi.on("turn_end", async (_e: any, ctx: any) => { log({ ev: "turn_end" }); snap("turn_end", ctx); });
  pi.on("agent_end", async (e: any, ctx: any) => log({ ev: "agent_end", idle: ctx.isIdle(), last: e.messages.at(-1)?.stopReason }));
  pi.on("agent_settled", async (e: any, ctx: any) => {
    log({ ev: "agent_settled", aborted: e.aborted, idle: ctx.isIdle(), bufferN: buffer.length });
    running = false;
    const items = buffer.splice(0);
    const turn = items.find((i) => i.kind === "turn");
    for (const i of items) if (i !== turn) sendNow(ctx, "note", i.text, false);
    if (turn) sendNow(ctx, "turn", turn.text, !e.aborted);
    snap("agent_settled:after-flush", ctx);
  });
}
