// SL-009 design sec-7: the extension shell. pi events and socket events go
// into state.ts's step; the shell performs the effects it returns. The shell
// holds one BridgeState and the I/O handles only, plus a queue: a handler that
// raises an event from inside an effect (a synchronous sendMessage, a complete)
// is queued and drained after the current effect, never re-entered.
import { basename } from "node:path";
import {
  type BashOperations,
  createBashTool,
  createLocalBashOperations,
  type CustomMessageEntry,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type LineConnection, openConnection } from "./connection.ts";
import {
  type Ends,
  type NotifyDesktop,
  noticeText,
  OUTAGE_SUMMARY,
  outageText,
  unknownText,
} from "./notices.ts";
import { withPosture } from "./posture.ts";
import {
  type BridgeEntry,
  type BridgeEvent,
  type BridgeState,
  type Delivery,
  type Effect,
  initialState,
  type MessageKey,
  type Paired,
  type Phase,
  type PostOutcome,
  step,
  type StatusView,
} from "./state.ts";
import { BRIDGE_POST_WAIT_MS, bridgeSocketPath, type DaemonFrame, type Posture } from "./wire.ts";

/** customType of the bridge's session entries (appendEntry) and injected messages. */
export const BRIDGE_CUSTOM_TYPE = "malebolge-bridge";
/** setStatus key, and the powerbar segment's id. */
export const BRIDGE_STATUS_KEY = "malebolge-bridge";

/** The conversation variable the spawn hook sets (ASM-008). */
const CONVERSATION_VAR = "MALEBOLGE_BRIDGE_CONVERSATION";
/** The token variable the spawn hook sets (ASM-008): never logged, never shown. */
const TOKEN_VAR = "MALEBOLGE_BRIDGE_TOKEN";

/** What `/bridge` answers with when it is given anything else. */
const BRIDGE_USAGE = "usage: /bridge pair delegate|consult, or /bridge end";

export interface ShellOptions {
  /** The environment the socket path is read from (bridgeSocketPath). */
  env: Readonly<Record<string, string | undefined>>;
  /** The mounted extension directory: prepended to bash's PATH (malebolge-bridge lives there). */
  extensionDir: string;
  notifyDesktop: NotifyDesktop;
}

/** The bridge's two variables, while paired. */
export interface BridgeVars {
  conversation: string;
  token: string;
}

/** What a `bridge_post` call resolves with: one text block and its outcome kind. */
interface PostResult {
  content: { type: "text"; text: string }[];
  details: { outcome: PostOutcome["kind"] };
}

/** A timer the shell armed (a reply deadline or the retry). */
type Timer = ReturnType<typeof setTimeout>;

/** sec-7 State: one BridgeState, the I/O handles, and the drain queue. */
interface Shell {
  readonly options: ShellOptions;
  readonly pi: ExtensionAPI;
  state: BridgeState;
  /** The latest context any handler or command saw. */
  ctx: ExtensionContext | undefined;
  /** Live connections, by their generation. */
  conns: Map<number, LineConnection>;
  /** Armed reply deadlines, by `JSON.stringify(key)`. */
  deadlines: Map<string, Timer>;
  /** The armed retry timer, if any. */
  retry: Timer | undefined;
  /** `bridge_post` calls awaiting their outcome, by tool call id. */
  posts: Map<string, (result: PostResult) => void>;
  /** What the spawn hook sets while paired (sec-7 Bash env). */
  vars: BridgeVars | null;
  /** Events raised but not yet stepped. */
  queue: BridgeEvent[];
  /** Whether a drain is running: events raised while performing are queued. */
  draining: boolean;
}

/** Retry backoff for outage attempt `attempt` (>= 1). */
export function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 30_000);
}

/**
 * The spawn hook's env (ASM-008): `env` with MALEBOLGE_BRIDGE_CONVERSATION and
 * MALEBOLGE_BRIDGE_TOKEN set from `vars` (or removed when null), and
 * `extensionDir` prepended to PATH. Nothing else changes.
 */
export function bridgeEnv(
  env: NodeJS.ProcessEnv,
  vars: BridgeVars | null,
  extensionDir: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== CONVERSATION_VAR && key !== TOKEN_VAR) {
      out[key] = value;
    }
  }
  // No trailing ":" when PATH is unset: an empty PATH element would mean the cwd.
  const path = env["PATH"];
  out["PATH"] = path === undefined || path === "" ? extensionDir : `${extensionDir}:${path}`;
  if (vars !== null) {
    out[CONVERSATION_VAR] = vars.conversation;
    out[TOKEN_VAR] = vars.token;
  }
  return out;
}

/** The extension: registers bridge_post, /bridge, the bash env (tool and `!`) and the event handlers. */
export function bridgeExtension(options: ShellOptions): (pi: ExtensionAPI) => void {
  return (pi): void => {
    const shell = createShell(options, pi);
    registerEvents(shell);
    registerTools(shell);
    registerCommand(shell);
  };
}

/** sec-7 State: the shell before anything has happened to it. */
function createShell(options: ShellOptions, pi: ExtensionAPI): Shell {
  return {
    options,
    pi,
    state: initialState,
    ctx: undefined,
    conns: new Map(),
    deadlines: new Map(),
    retry: undefined,
    posts: new Map(),
    vars: null,
    queue: [],
    draining: false,
  };
}

// --- dispatch: the queue between pi and step ---------------------------------

/** sec-7 dispatch: enqueue `event`, then drain when no drain is already running. */
function dispatch(shell: Shell, event: BridgeEvent): void {
  shell.queue.push(event);
  if (shell.draining) {
    return;
  }
  shell.draining = true;
  try {
    drain(shell);
  } finally {
    shell.draining = false;
  }
}

/** sec-7 dispatch: step each queued event and perform its effects, in order. */
function drain(shell: Shell): void {
  for (;;) {
    const event = shell.queue.shift();
    if (event === undefined) {
      return;
    }
    const stepped = step(shell.state, event);
    shell.state = stepped.state;
    for (const effect of stepped.effects) {
      perform(shell, effect);
    }
  }
}

// --- perform: one row per effect type ----------------------------------------

/** One effect type's own shape. */
type EffectOf<T extends Effect["type"]> = Extract<Effect, { type: T }>;

/** One row of the effect table: `handle` runs for its own effect type. */
type Performer = (shell: Shell, effect: Effect) => void;

/** Whether `effect` is a `type` effect, so a row runs only on its own. */
function isEffect<T extends Effect["type"]>(effect: Effect, type: T): effect is EffectOf<T> {
  return effect.type === type;
}

/** One row of the effect table: `handle` runs only for effects of its own type. */
function performWhen<T extends Effect["type"]>(
  type: T,
  handle: (shell: Shell, effect: EffectOf<T>) => void,
): Performer {
  return (shell, effect): void => {
    if (isEffect(effect, type)) {
      handle(shell, effect);
    }
  };
}

/** sec-7 State: perform one effect, through its row. */
function perform(shell: Shell, effect: Effect): void {
  EFFECTS[effect.type](shell, effect);
}

/** sec-7's effects, one row each: what the shell does with what step asked for. */
const EFFECTS: Record<Effect["type"], Performer> = {
  connect: performWhen("connect", connectEffect),
  send: performWhen("send", sendEffect),
  close: performWhen("close", closeEffect),
  deadline: performWhen("deadline", deadlineEffect),
  retry: performWhen("retry", retryEffect),
  "cancel timers": performWhen("cancel timers", cancelTimersEffect),
  complete: performWhen("complete", completeEffect),
  inject: performWhen("inject", injectEffect),
  append: performWhen("append", appendEffect),
  env: performWhen("env", envEffect),
  notify: performWhen("notify", notifyEffect),
  status: performWhen("status", statusEffect),
};

// --- the connection effects (sec-7 connect, send, close) ---------------------

/** sec-7 `connect`: open the socket and feed its frames back into step. */
function connectEffect(shell: Shell, effect: EffectOf<"connect">): void {
  const { conn, frame } = effect;
  let path: string;
  try {
    path = bridgeSocketPath(shell.options.env);
  } catch (error) {
    dispatch(shell, { type: "closed", conn, reason: messageOf(error) });
    return;
  }
  const connection = openConnection(path, frame, {
    onFrame: (daemonFrame): void => {
      const idle = shell.ctx?.isIdle() ?? false;
      dispatch(shell, frameEvent(conn, daemonFrame, idle));
    },
    onClose: (reason): void => {
      shell.conns.delete(conn);
      dispatch(shell, { type: "closed", conn, reason });
    },
  });
  shell.conns.set(conn, connection);
}

/** sec-7 `send`: one frame on that connection, only while it is live. */
function sendEffect(shell: Shell, effect: EffectOf<"send">): void {
  shell.conns.get(effect.conn)?.send(effect.frame);
}

/** sec-7 `close`: drop that connection, if it is still there. */
function closeEffect(shell: Shell, effect: EffectOf<"close">): void {
  const connection = shell.conns.get(effect.conn);
  if (connection === undefined) {
    return;
  }
  shell.conns.delete(effect.conn);
  connection.close();
}

// --- the timer effects (sec-7 reply deadlines and retry) ---------------------

/** sec-7 reply deadline: arm `BRIDGE_POST_WAIT_MS` for `key`, replacing any earlier one. */
function deadlineEffect(shell: Shell, effect: EffectOf<"deadline">): void {
  const key = JSON.stringify(effect.key);
  const armed = shell.deadlines.get(key);
  if (armed !== undefined) {
    clearTimeout(armed);
  }
  const timer = setTimeout((): void => {
    shell.deadlines.delete(key);
    dispatch(shell, { type: "deadline", key: effect.key });
  }, BRIDGE_POST_WAIT_MS);
  shell.deadlines.set(key, timer);
}

/** sec-7 `retry`: arm the backoff timer for outage `attempt`, replacing any earlier one. */
function retryEffect(shell: Shell, effect: EffectOf<"retry">): void {
  if (shell.retry !== undefined) {
    clearTimeout(shell.retry);
  }
  shell.retry = setTimeout((): void => {
    shell.retry = undefined;
    dispatch(shell, { type: "retry" });
  }, retryDelayMs(effect.attempt));
}

/** sec-7 `cancel timers`: clear the retry and every reply deadline. */
function cancelTimersEffect(shell: Shell): void {
  for (const timer of shell.deadlines.values()) {
    clearTimeout(timer);
  }
  shell.deadlines.clear();
  if (shell.retry !== undefined) {
    clearTimeout(shell.retry);
    shell.retry = undefined;
  }
}

// --- the pi-facing effects (sec-7 complete, inject, append, env, ...) --------

/** sec-7 `complete`: answer a `bridge_post` call with its outcome's text. */
function completeEffect(shell: Shell, effect: EffectOf<"complete">): void {
  const resolve = shell.posts.get(effect.id);
  if (resolve === undefined) {
    return;
  }
  shell.posts.delete(effect.id);
  const text = postText(effect.outcome, endsOf(shell));
  resolve({ content: [{ type: "text", text }], details: { outcome: effect.outcome.kind } });
}

/** sec-7 `inject`: send the message to pi, then report what the branch now holds. */
function injectEffect(shell: Shell, effect: EffectOf<"inject">): void {
  const { pairing, delivery, triggerTurn } = effect;
  shell.pi.sendMessage(
    {
      customType: BRIDGE_CUSTOM_TYPE,
      content: delivery.text,
      display: true,
      details: { pairing, seq: delivery.seq },
    },
    { triggerTurn },
  );
  reportPersisted(shell);
}

/** sec-7 `append`: record a pairing or the unpaired marker in pi's session. */
function appendEffect(shell: Shell, effect: EffectOf<"append">): void {
  shell.pi.appendEntry(BRIDGE_CUSTOM_TYPE, effect.entry);
}

/** sec-7 Bash env: what the spawn hook sets from now on. */
function envEffect(shell: Shell, effect: EffectOf<"env">): void {
  shell.vars = effect.env;
}

/** sec-7 `notify`: one notice, plus the desktop notification an outage deserves. */
function notifyEffect(shell: Shell, effect: EffectOf<"notify">): void {
  const text = noticeText(effect.notice, endsOf(shell));
  shell.ctx?.ui.notify(text, effect.level);
  if (effect.notice.kind === "outage") {
    shell.options.notifyDesktop(OUTAGE_SUMMARY, text);
  }
}

/**
 * sec-7 `status`: the one status line, which never names the token. Also sent
 * as a pi-powerbar segment: that extension hides the footer setStatus draws in,
 * and takes segments over pi's event bus, so it is no dependency here.
 */
function statusEffect(shell: Shell, effect: EffectOf<"status">): void {
  const text = statusText(effect.status);
  shell.ctx?.ui.setStatus(BRIDGE_STATUS_KEY, text);
  shell.pi.events.emit("powerbar:update", { id: BRIDGE_STATUS_KEY, text });
}

// --- sec-7 session_shutdown ------------------------------------------------

/** sec-7 `session_shutdown`: every connection destroyed and every timer cleared. */
function closeAll(shell: Shell): void {
  for (const connection of shell.conns.values()) {
    connection.close();
  }
  shell.conns.clear();
  cancelTimersEffect(shell);
}

// --- sec-7 persisted: what the session now holds ----------------------------

/** sec-7 persisted: report each injected message whose entry is on the branch. */
function reportPersisted(shell: Shell): void {
  const ctx = shell.ctx;
  if (ctx === undefined) {
    return;
  }
  const keys = persistedKeys(ctx.sessionManager.getBranch(), shell.state.injected);
  for (const key of keys) {
    dispatch(shell, { type: "persisted", key });
  }
}

// --- the registrations (sec-7 Registrations) --------------------------------

/** sec-7 Registrations: the pi events, each one a dispatch (and the pure read of the prompt). */
function registerEvents(shell: Shell): void {
  const { pi } = shell;
  pi.on("session_start", (_event, ctx): void => {
    shell.ctx = ctx;
    // At session start every extension is loaded, whatever the load order.
    pi.events.emit("powerbar:register-segment", { id: BRIDGE_STATUS_KEY, label: OUTAGE_SUMMARY });
    dispatch(shell, sessionStartEvent(ctx));
  });
  pi.on("session_shutdown", (_event, ctx): void => {
    shell.ctx = ctx;
    dispatch(shell, { type: "session_shutdown" });
    closeAll(shell);
  });
  pi.on("agent_start", (_event, ctx): void => {
    shell.ctx = ctx;
    dispatch(shell, { type: "agent_start" });
  });
  pi.on("agent_end", (_event, ctx): void => {
    shell.ctx = ctx;
    dispatch(shell, { type: "agent_end" });
  });
  pi.on("agent_settled", (event, ctx): void => {
    shell.ctx = ctx;
    dispatch(shell, { type: "agent_settled", aborted: event.aborted });
    reportPersisted(shell);
  });
  pi.on("turn_end", (_event, ctx): void => {
    shell.ctx = ctx;
    reportPersisted(shell);
  });
  pi.on("message_end", (_event, ctx): void => {
    shell.ctx = ctx;
    reportPersisted(shell);
  });
  pi.on("input", (event, ctx): { action: "continue" } => {
    shell.ctx = ctx;
    if (event.source === "interactive") {
      dispatch(shell, { type: "input" });
    }
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event, ctx): { systemPrompt: string } | undefined => {
    shell.ctx = ctx;
    return posturePrompt(shell.state.phase, event.systemPrompt);
  });
}

/** sec-7 Registrations: the `bridge_post` tool, the bash tool with its spawn hook, and `!` commands. */
function registerTools(shell: Shell): void {
  shell.pi.registerTool({
    name: "bridge_post",
    label: "Bridge post",
    description: "Send a message to the operator's conversation over the malebolge bridge.",
    parameters: Type.Object({ text: Type.String({ description: "the message text" }) }),
    execute: (id, params): Promise<PostResult> => bridgePost(shell, id, params.text),
  });
  registerBashTool(shell);
  registerUserBash(shell);
}

/** sec-7 Bash env: pi's bash tool, with the bridge's variables added per spawn. */
function registerBashTool(shell: Shell): void {
  const bash = createBashTool(process.cwd(), {
    spawnHook: (context): { command: string; cwd: string; env: NodeJS.ProcessEnv } => ({
      command: context.command,
      cwd: context.cwd,
      env: bridgeEnv(context.env, shell.vars, shell.options.extensionDir),
    }),
  });
  shell.pi.registerTool({
    ...bash,
    execute: (id, params, signal, onUpdate) => bash.execute(id, params, signal, onUpdate),
  });
}

/**
 * The operator's `!` commands get the bash tool's env: pi runs them outside the
 * tool, so its spawn hook never sees them. pi passes no env, so the base is
 * this process's (without pi's own bin dir or a configured shell path).
 */
function registerUserBash(shell: Shell): void {
  const local = createLocalBashOperations();
  const operations: BashOperations = {
    exec: (command, cwd, options) =>
      local.exec(command, cwd, {
        ...options,
        env: bridgeEnv(options.env ?? process.env, shell.vars, shell.options.extensionDir),
      }),
  };
  shell.pi.on("user_bash", () => ({ operations }));
}

/** sec-7 Registrations: `/bridge pair delegate|consult` and `/bridge end`. */
function registerCommand(shell: Shell): void {
  shell.pi.registerCommand("bridge", {
    description: "Pair with the operator's malebolge bridge, or end the pairing",
    handler: (args, ctx): Promise<void> => {
      shell.ctx = ctx;
      bridgeCommand(shell, args, ctx);
      return Promise.resolve();
    },
  });
}

/** sec-7 Registrations: what `/bridge` does with its arguments. */
function bridgeCommand(shell: Shell, args: string, ctx: ExtensionCommandContext): void {
  const words = args
    .trim()
    .split(/\s+/u)
    .filter((word): boolean => word !== "");
  const [verb, ...rest] = words;
  const posture = postureOf(rest[0]);
  if (verb === "end" && words.length === 1) {
    dispatch(shell, { type: "end" });
    return;
  }
  if (verb === "pair" && posture !== undefined && rest.length === 1) {
    dispatch(shell, { type: "pair", posture });
    return;
  }
  ctx.ui.notify(BRIDGE_USAGE, "error");
}

/** sec-7 `bridge_post`: register the call's resolver, then ask step for the post. */
function bridgePost(shell: Shell, id: string, text: string): Promise<PostResult> {
  return new Promise<PostResult>((resolve): void => {
    shell.posts.set(id, resolve);
    dispatch(shell, { type: "post", id, text });
  });
}

// --- pure helpers: what the ends, the status and pi's branch say ------------

/** `value` as one of the two postures, or undefined when it names neither. */
function postureOf(value: string | undefined): Posture | undefined {
  if (value === "delegate" || value === "consult") {
    return value;
  }
  return undefined;
}

/** The message a thrown value carries (sec-7 connect failure). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** sec-7 `deliver`/`frame`: the event a daemon frame raises on connection `conn`. */
function frameEvent(conn: number, frame: DaemonFrame, idle: boolean): BridgeEvent {
  if (frame.type === "deliver") {
    const delivery: Delivery = { seq: frame.seq, kind: frame.kind, text: frame.text };
    return { type: "deliver", conn, delivery, idle };
  }
  return { type: "frame", conn, frame };
}

/** sec-7's paired states: the `paired` a phase holds, if it holds one. */
function pairedOf(phase: Phase): Paired | undefined {
  if (phase.name === "bound" || phase.name === "resuming" || phase.name === "outage") {
    return phase.paired;
  }
  return undefined;
}

/** sec-7 `before_agent_start`: the posture's prompt when paired, nothing otherwise. */
function posturePrompt(phase: Phase, systemPrompt: string): { systemPrompt: string } | undefined {
  const paired = pairedOf(phase);
  if (paired === undefined) {
    return undefined;
  }
  return { systemPrompt: withPosture(systemPrompt, paired.pairing.posture) };
}

/** The socket path, or "unknown" when the environment cannot name one (sec-7 Ends). */
function socketText(env: Readonly<Record<string, string | undefined>>): string {
  try {
    return bridgeSocketPath(env);
  } catch {
    return "unknown";
  }
}

/** sec-7 Ends: every end a notice may name, and never the token. */
function endsOf(shell: Shell): Ends {
  const paired = pairedOf(shell.state.phase);
  const { project, session } = shell.state;
  return {
    project,
    socket: socketText(shell.options.env),
    ...(session === "" ? {} : { session }),
    ...(paired === undefined ? {} : { conversation: paired.pairing.conversation }),
    ...(project === "" ? {} : { topic: `${project}-bridge` }),
  };
}

/** sec-7 `status`: the text a view shows; unpaired clears the line. */
function statusText(status: StatusView): string | undefined {
  if (status.phase === "unpaired") {
    return undefined;
  }
  if (status.phase === "outage") {
    return `${OUTAGE_SUMMARY}: outage (attempt ${String(status.attempt ?? 0)})`;
  }
  return `${OUTAGE_SUMMARY}: ${status.phase}`;
}

/** sec-7 `bridge_post`: the text a call resolves with, per outcome. */
function postText(outcome: PostOutcome, ends: Ends): string {
  switch (outcome.kind) {
    case "sent":
      return "sent";
    case "refused":
      return `refused: ${outcome.reason}`;
    case "unknown":
      return unknownText(ends);
    case "not bound":
      return outageText(ends);
  }
}

/** Whether `value` is a JSON-like record (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** sec-7 `session_start`: whether `value` is a bridge entry state.ts would adopt. */
function isBridgeEntry(value: unknown): value is BridgeEntry {
  if (!isRecord(value)) {
    return false;
  }
  if (value["kind"] === "unpaired") {
    return true;
  }
  return (
    value["kind"] === "pairing" &&
    typeof value["session"] === "string" &&
    typeof value["conversation"] === "string" &&
    typeof value["token"] === "string" &&
    (value["posture"] === "delegate" || value["posture"] === "consult")
  );
}

/** sec-7 persisted: the message key `details` records, or undefined when malformed. */
function keyOf(details: unknown): MessageKey | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const pairing = details["pairing"];
  const seq = details["seq"];
  if (typeof pairing !== "string" || typeof seq !== "number" || !Number.isSafeInteger(seq)) {
    return undefined;
  }
  return { pairing, seq };
}

/** Whether a branch entry is one of the bridge's custom messages. */
function isBridgeMessage(entry: SessionEntry): entry is CustomMessageEntry {
  return entry.type === "custom_message" && entry.customType === BRIDGE_CUSTOM_TYPE;
}

/** Whether two message keys name the same message (the dedupe record). */
function sameKey(left: MessageKey, right: MessageKey): boolean {
  return left.pairing === right.pairing && left.seq === right.seq;
}

/** sec-7 `session_start`: every well-formed message key the branch holds. */
function messageKeys(branch: readonly SessionEntry[]): readonly MessageKey[] {
  const keys: MessageKey[] = [];
  for (const entry of branch) {
    if (!isBridgeMessage(entry)) {
      continue;
    }
    const key = keyOf(entry.details);
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return keys;
}

/** sec-7 `session_start`: the last well-formed bridge entry on the branch. */
function latestEntry(branch: readonly SessionEntry[]): BridgeEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== BRIDGE_CUSTOM_TYPE) {
      continue;
    }
    if (isBridgeEntry(entry.data)) {
      return entry.data;
    }
  }
  return undefined;
}

/** sec-7 `persisted`: the injected keys whose message is now on the branch. */
function persistedKeys(
  branch: readonly SessionEntry[],
  injected: readonly MessageKey[],
): readonly MessageKey[] {
  return messageKeys(branch).filter((key): boolean => injected.some((held) => sameKey(held, key)));
}

/** sec-7 `session_start`: the event `ctx` describes. */
function sessionStartEvent(ctx: ExtensionContext): BridgeEvent {
  const branch = ctx.sessionManager.getBranch();
  return {
    type: "session_start",
    session: ctx.sessionManager.getSessionId(),
    project: basename(ctx.cwd),
    latest: latestEntry(branch),
    messages: messageKeys(branch),
  };
}
