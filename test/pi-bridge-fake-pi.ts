// SL-009 PHASE-09: a fake pi. It is the ExtensionAPI and ExtensionContext the
// extension shell talks to, with everything the shell causes recorded: the
// messages it sends, the session entries it persists, the notices it raises,
// the statuses it sets and the desktop notifications it asks for. Tests drive
// the shell through it: events, the `/bridge` command, the registered tools, and
// the turn a held `triggerTurn` message waits for.
//
// Sessions are a plain branch (pi's SessionEntry[]): `appendEntry` pushes a
// `custom` entry, `sendMessage` pushes a `custom_message` entry, and
// `runTurn()` appends what a `triggerTurn` call held back, then fires `turn_end`.

import type {
  CustomEntry,
  CustomMessageEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { NotifyDesktop } from "../pi-bridge/notices.ts";

/** One sendMessage call: the message, and the options it came with. */
export interface SentMessage {
  readonly message: CustomMessageDraft;
  readonly options: { readonly triggerTurn?: boolean };
}

/** The message draft a bridge sendMessage call carries: its content is a body, a string. */
export interface CustomMessageDraft {
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
  readonly details: unknown;
}

/** One `ui.notify` call. */
export interface Notified {
  readonly text: string;
  readonly level: string | undefined;
}

/** One `ui.setStatus` call. */
export interface StatusShown {
  readonly key: string;
  readonly text: string | undefined;
}

/** One desktop notification the extension asked for. */
export interface DesktopNotice {
  readonly summary: string;
  readonly body: string;
}

/** What the fake pi starts from. */
export interface FakePiOptions {
  /** `ctx.sessionManager.getSessionId()`. */
  readonly sessionId?: string;
  /** `ctx.cwd`: its basename is the project the shell reports. */
  readonly cwd?: string;
  /** The branch the session already holds: pairing entries, bridge messages. */
  readonly entries?: readonly SessionEntry[];
}

/** A fake pi: its records, and the actions a test drives the shell with. */
export interface FakePi {
  /** The extension's desktop notifier: records into `desktop`. */
  readonly notifyDesktop: NotifyDesktop;
  /** Every sendMessage call, in order. */
  readonly messages: readonly SentMessage[];
  /** Every ui.notify call, in order. */
  readonly notices: readonly Notified[];
  /** Every ui.setStatus call, in order. */
  readonly statuses: readonly StatusShown[];
  /** Every desktop notification the extension raised, in order. */
  readonly desktop: readonly DesktopNotice[];
  /** The session branch, as it stands now. */
  readonly entries: () => readonly SessionEntry[];
  /** Load the extension: what pi does with the factory it finds. */
  readonly load: (extension: (pi: ExtensionAPI) => void) => void;
  /** Fire one pi event at every handler registered for it; the handlers' results. */
  readonly fire: (eventName: string, event: object) => Promise<readonly unknown[]>;
  /** Fire `session_start`. */
  readonly startSession: () => Promise<void>;
  /** Run the `/bridge` command with `args`. */
  readonly command: (name: string, args: string) => Promise<void>;
  /** Call a registered tool's `execute`; the promise it returns. */
  readonly callTool: (
    name: string,
    id: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Run the registered bash tool; its text output. */
  readonly bash: (command: string) => Promise<string>;
  /** Run the turn a `triggerTurn` message waits for: append it, then fire `turn_end`. */
  readonly runTurn: () => Promise<void>;
  /** Whether pi reports itself idle. */
  readonly setIdle: (idle: boolean) => void;
}

/** Whether `value` is a JSON-like object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How many seeded entries have been built (their ids are only labels). */
let seeded = 0;

/** The timestamp every fake entry carries: pi only needs one. */
const stamp = (): string => new Date(0).toISOString();

/** A `custom` session entry (a pairing or the unpaired marker) to seed a branch with. */
export function branchEntry(customType: string, data: unknown): CustomEntry {
  seeded += 1;
  return {
    type: "custom",
    customType,
    data,
    id: `seed-${String(seeded)}`,
    parentId: null,
    timestamp: stamp(),
  };
}

/** A `custom_message` session entry (a bridge message already in the session) to seed a branch with. */
export function branchMessage(
  customType: string,
  content: string,
  details: unknown,
): CustomMessageEntry {
  seeded += 1;
  return {
    type: "custom_message",
    customType,
    content,
    details,
    display: true,
    id: `seed-${String(seeded)}`,
    parentId: null,
    timestamp: stamp(),
  };
}

/** One text block of a tool result, or a failure saying what it is instead. */
function textBlockOf(value: unknown): string {
  if (!isRecord(value) || value["type"] !== "text" || typeof value["text"] !== "string") {
    throw new Error(`not a text block: ${JSON.stringify(value)}`);
  }
  return value["text"];
}

/** A tool result's text blocks, or a failure: every tool the shell registers returns text. */
function toolContent(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    throw new Error(`not a tool result: ${JSON.stringify(value)}`);
  }
  const content: unknown = value["content"];
  if (!Array.isArray(content)) {
    throw new Error(`a tool result without content blocks: ${JSON.stringify(value)}`);
  }
  const blocks: readonly unknown[] = content;
  return blocks.map(textBlockOf);
}

/** A tool result's text, joined: what a test reads from `bridge_post` and the bash tool. */
export function resultText(value: unknown): string {
  return toolContent(value).join("");
}

/** A `bridge_post` result's outcome kind, or a failure: the shell reports it in `details`. */
export function resultOutcome(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value["details"])) {
    throw new Error(`a tool result without details: ${JSON.stringify(value)}`);
  }
  return value["details"]["outcome"];
}

/** A fake pi: every effect of the shell recorded, and nothing else real. */
export function fakePi(options: FakePiOptions = {}): FakePi {
  const sessionId = options.sessionId ?? "fake-pi-session";
  const cwd = options.cwd ?? process.cwd();
  const branch: SessionEntry[] = [...(options.entries ?? [])];
  const messages: SentMessage[] = [];
  const notices: Notified[] = [];
  const statuses: StatusShown[] = [];
  const desktop: DesktopNotice[] = [];
  const held: SentMessage[] = [];
  const handlers = new Map<string, ((event: unknown, context: ExtensionContext) => unknown)[]>();
  const tools = new Map<string, (id: string, params: unknown) => unknown>();
  const commands = new Map<string, (args: string, context: ExtensionCommandContext) => unknown>();
  let idle = true;
  let parentId: string | null = branch.at(-1)?.id ?? null;
  let appended = branch.length;
  let bashCalls = 0;

  /** Append one entry, chained under the one before it: pi's branch shape. */
  const append = (make: (id: string, parent: string | null) => SessionEntry): void => {
    appended += 1;
    const id = `entry-${String(appended)}`;
    branch.push(make(id, parentId));
    parentId = id;
  };

  /** Append a `custom` entry: what appendEntry does. */
  const pushCustom = (customType: string, data: unknown): void => {
    append((id, parent) => ({
      type: "custom",
      customType,
      data,
      id,
      parentId: parent,
      timestamp: stamp(),
    }));
  };

  /** Append a `custom_message` entry: what a sent message becomes in the session. */
  const pushMessage = (message: CustomMessageDraft): void => {
    append((id, parent) => ({
      type: "custom_message",
      customType: message.customType,
      content: message.content,
      details: message.details,
      display: message.display,
      id,
      parentId: parent,
      timestamp: stamp(),
    }));
  };

  const notifyDesktop: NotifyDesktop = (summary, body): void => {
    desktop.push({ summary, body });
  };

  const ui = {
    notify: (text: string, level?: string): void => {
      notices.push({ text, level });
    },
    setStatus: (key: string, text: string | undefined): void => {
      statuses.push({ key, text });
    },
  };

  const sessionManager = {
    getSessionId: (): string => sessionId,
    getBranch: (): readonly SessionEntry[] => [...branch],
    getCwd: (): string => cwd,
    getSessionFile: (): undefined => undefined,
  };

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a fake of pi's context: only the members the shell reads
  const ctx = {
    cwd,
    ui,
    sessionManager,
    mode: "tui",
    hasUI: true,
    isIdle: (): boolean => idle,
    isProjectTrusted: (): boolean => true,
    signal: undefined,
    abort: (): void => undefined,
    hasPendingMessages: (): boolean => false,
    shutdown: (): void => undefined,
    getContextUsage: (): undefined => undefined,
    compact: (): void => undefined,
    getSystemPrompt: (): string => "",
  } as unknown as ExtensionCommandContext;

  const fire = async (eventName: string, event: object): Promise<readonly unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(eventName) ?? []) {
      results.push(await Promise.resolve(handler(event, ctx)));
    }
    return results;
  };

  const sendMessage = (
    message: CustomMessageDraft,
    sendOptions: { readonly triggerTurn?: boolean } = {},
  ): void => {
    const sent: SentMessage = { message, options: sendOptions };
    messages.push(sent);
    if (sendOptions.triggerTurn === true) {
      held.push(sent);
      return;
    }
    pushMessage(message);
  };

  const api = {
    on: (
      eventName: string,
      handler: (event: unknown, context: ExtensionContext) => unknown,
    ): (() => void) => {
      const registered = handlers.get(eventName) ?? [];
      registered.push(handler);
      handlers.set(eventName, registered);
      return (): void => {
        // The fake never unsubscribes: its handlers live as long as the test does.
      };
    },
    registerTool: (tool: {
      readonly name: string;
      readonly execute: (id: string, params: unknown) => unknown;
    }): void => {
      tools.set(tool.name, tool.execute);
    },
    registerCommand: (
      name: string,
      registration: {
        readonly handler: (args: string, context: ExtensionCommandContext) => unknown;
      },
    ): void => {
      commands.set(name, registration.handler);
    },
    sendMessage,
    appendEntry: (customType: string, data?: unknown): void => {
      pushCustom(customType, data);
    },
  };

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a fake of pi's API: only the members the shell calls
  const pi = api as unknown as ExtensionAPI;

  const callTool = (
    name: string,
    id: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    const execute = tools.get(name);
    if (execute === undefined) {
      return Promise.reject(new Error(`no tool ${name} is registered`));
    }
    return Promise.resolve(execute(id, params));
  };

  const bash = async (command: string): Promise<string> => {
    bashCalls += 1;
    return resultText(await callTool("bash", `bash-${String(bashCalls)}`, { command }));
  };

  const command = async (name: string, args: string): Promise<void> => {
    const handler = commands.get(name);
    if (handler === undefined) {
      throw new Error(`no command ${name} is registered`);
    }
    await Promise.resolve(handler(args, ctx));
  };

  const runTurn = async (): Promise<void> => {
    for (const sent of held.splice(0)) {
      pushMessage(sent.message);
    }
    await fire("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: { role: "user", content: "" },
      toolResults: [],
      messageEntryId: branch.at(-1)?.id ?? "",
      toolResultEntryIds: [],
    });
  };

  return {
    notifyDesktop,
    messages,
    notices,
    statuses,
    desktop,
    entries: (): readonly SessionEntry[] => [...branch],
    load: (extension: (api: ExtensionAPI) => void): void => {
      extension(pi);
    },
    fire,
    startSession: async (): Promise<void> => {
      await fire("session_start", { type: "session_start", reason: "startup" });
    },
    command,
    callTool,
    bash,
    runTurn,
    setIdle: (value: boolean): void => {
      idle = value;
    },
  };
}
