// A Harness on memory storage driven by pi-ai's faux provider, which replays
// scripted assistant messages in place of a model.

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type JsonObject,
  type Conversation,
  type ConversationId,
  type ConversationInit,
  defineTask,
  type Extension,
  Harness,
  type HarnessOptions,
  type HarnessSettings,
  MemoryStorage,
  type Registry,
  type Storage,
  type StorageWrite,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { onTestFinished } from "vitest";
import { context } from "../src/context.ts";
import { conversations } from "../src/conversations.ts";
import { type Daemon, serve } from "../src/daemon.ts";
import { isRecord } from "../src/json.ts";
import { registryOf } from "../src/registry.ts";
import { openSession, type SessionOptions } from "../src/session.ts";
import { type IndexDoc, type IndexReader, readIndex } from "../src/topics.ts";

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

export interface TestHarness {
  harness: Harness;
  root: Conversation;
  faux: FauxProviderHandle;
}

export type FauxOptions = Parameters<typeof fauxProvider>[0];

/** A model catalog holding only a fresh faux provider. */
export function fauxModels(fauxOptions?: FauxOptions): {
  faux: FauxProviderHandle;
  models: Models;
} {
  const faux = fauxProvider(fauxOptions);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

/** The default hook: a node env at the conversation's cwd, or the process's. */
export const nodeEnv: SessionOptions["env"] = ({ cwd }) =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

/** A settable clock: one function to hand the harness and a wake's env alike. */
export interface FakeClock {
  now: () => number;
  set: (time: number) => void;
  advance: (ms: number) => void;
}

/** A clock stopped at `start` until the test moves it. */
export function fakeClock(start: number): FakeClock {
  let time = start;
  return {
    now: () => time,
    set: (to): void => {
      time = to;
    },
    advance: (ms): void => {
      time += ms;
    },
  };
}

/** The harness timer on a fake clock: an armed timer fires only when the test moves the clock past it. */
export interface FakeTimers {
  /** For `HarnessOptions.setTimer`; background timers (memory only) are declined. */
  readonly setTimer: NonNullable<SessionOptions["setTimer"]>;
  /** Moves the clock by `ms`, then fires every timer now due, earliest first. */
  readonly advance: (ms: number) => void;
  /** When each armed timer is due, earliest first. */
  readonly pending: () => number[];
}

/** Timers armed on `clock`, due at the clock's time plus their delay. */
export function fakeTimers(clock: FakeClock): FakeTimers {
  const armed = new Set<{ readonly due: number; readonly callback: () => void }>();
  return {
    setTimer: (callback, delayMs, { background }): (() => void) | undefined => {
      if (background) {
        return undefined;
      }
      const timer = { due: clock.now() + delayMs, callback };
      armed.add(timer);
      return (): void => {
        armed.delete(timer);
      };
    },
    advance: (ms): void => {
      clock.advance(ms);
      const due = [...armed].filter((timer) => timer.due <= clock.now());
      for (const timer of due.sort((a, b) => a.due - b.due)) {
        armed.delete(timer);
        timer.callback();
      }
    },
    pending: (): number[] => [...armed].map((timer) => timer.due).sort((a, b) => a - b),
  };
}

/** A session on memory storage whose root runs the faux model, on `now` when given. */
export async function openTestHarness(
  extensions: readonly Extension[],
  fauxOptions?: FauxOptions,
  env?: SessionOptions["env"],
  now?: SessionOptions["now"],
): Promise<TestHarness> {
  const { faux, models } = fauxModels(fauxOptions);
  const session = await openSession(new MemoryStorage(), {
    models,
    registry: registryOf(extensions),
    agent: { model: FAUX_MODEL },
    env: env ?? nodeEnv,
    profile: "room",
    log: () => undefined,
    ...(now === undefined ? {} : { now }),
  });
  return { ...session, faux };
}

export interface FauxHarnessOptions {
  extensions?: readonly Extension[];
  /** The registry the harness reads, in place of one built from `extensions`. */
  registry?: Registry;
  fauxOptions?: FauxOptions;
  /** What the harness sees in place of the faux catalog, e.g. a gated view of it. */
  models?: (models: Models) => Models;
  settings?: HarnessSettings;
  env?: SessionOptions["env"];
  /** Enable scheduling once open (default). `false` leaves a passive harness that only reads. */
  resume?: boolean;
  /** The creating-commit hook; `openSession` installs the index's, a pre-index store installs none. */
  conversationCreated?: HarnessOptions["conversationCreated"];
}

function harnessOptionsOf(options: FauxHarnessOptions, models: Models): HarnessOptions {
  return {
    models: options.models?.(models) ?? models,
    registry: options.registry ?? registryOf(options.extensions ?? []),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.conversationCreated === undefined
      ? {}
      : { conversationCreated: options.conversationCreated }),
  };
}

/**
 * A harness on `storage` whose root runs the faux model, with the harness options
 * `openSession` fixes (settings, environment, scheduling) open to the test.
 */
export async function openFauxHarness(
  storage: Storage,
  options: FauxHarnessOptions = {},
): Promise<TestHarness> {
  const { faux, models } = fauxModels(options.fauxOptions);
  const harness = await Harness.open(storage, harnessOptionsOf(options, models), context);
  const root = await harness.root(context, { agent: { model: FAUX_MODEL } });
  if (options.resume ?? true) {
    harness.resume();
  }
  return { harness, root, faux };
}

/** The conversation index of `harness`: what the creating commits wrote, read the one way. */
export function indexOf(harness: IndexReader): Promise<IndexDoc> {
  return readIndex(harness);
}

/** A conversation's resolved agent, by name: its selection, the tools offered, and its sections. */
export interface ToolsetProbe {
  extensions: string[];
  tools: string[];
  sections: string[];
}

/**
 * What `conversation` — or the one `open` creates — resolves to, without a turn, so a
 * test can probe, close the store, reopen it and probe again.
 */
export async function toolsetProbe(
  conversation: Conversation | (() => Promise<Conversation>),
): Promise<ToolsetProbe> {
  const of = typeof conversation === "function" ? await conversation() : conversation;
  const agent = await of.agent(context);
  return {
    extensions: agent.extensions.map((extension) => extension.name),
    tools: agent.tools.map((tool) => tool.name),
    sections: agent.sections.map((section) => section.key),
  };
}

/** `harness`, closed when the test ends. */
export function closing<T extends Harness>(harness: T): T {
  onTestFinished(() => harness.close(context));
  return harness;
}

/** A session harness — the creating hook and the backfill ran — closed when the test ends. */
export async function openIndexedHarness(
  extensions: readonly Extension[] = [],
): Promise<TestHarness> {
  const test = await openTestHarness(extensions);
  closing(test.harness);
  return test;
}

/** One ownerless conversation through the harness's own creating path. */
export function createConversation(
  harness: Harness,
  init?: ConversationInit,
): Promise<Conversation> {
  return harness.createConversation(
    { ownership: { kind: "ownerless" }, ...(init === undefined ? {} : { init }) },
    context,
  );
}

/** A task whose only phase waits: a stub, never run on a passive harness. */
export const stubTask = defineTask({
  name: "stub",
  version: 1,
  initial: () => ({ phase: "waiting" as const }),
  phases: { waiting: () => Promise.resolve() },
  abort: () => Promise.resolve(),
});

/** A conversation owned by a task, so no topic's and never in the index (DEC-012). */
export function createTaskOwned(test: TestHarness): Promise<ConversationId> {
  return test.harness.commit(async (tx) => {
    const taskId = await tx.createTask(
      stubTask,
      {},
      { ownership: { kind: "conversation" }, conversationId: test.root.id },
    );
    return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
  }, context);
}

/** A fork of `parent` at a note entry: the recipe a client forks by. */
export async function forkConversation(
  harness: Pick<Harness, "commit">,
  parent: Conversation,
): Promise<Conversation> {
  const entry = await harness.commit(
    (tx) => tx.appendEntry(parent.id, { kind: "test.note", data: { note: "fork here" } }),
    context,
  );
  return parent.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
}

/** The name rule's refusal, quoted so a test cannot drift from the text users see. */
export const NAME_RULE = "topic must match [a-z0-9][a-z0-9._-]{0,63}";

/**
 * `storage`, counting the commits that carried writes: how a test sees that a
 * start over an unchanged store wrote nothing.
 */
export function countingCommits(storage: Storage): { storage: Storage; commits: () => number } {
  let commits = 0;
  const counted: Storage = new Proxy(storage, {
    get(target, property): unknown {
      const member: unknown = Reflect.get(target, property);
      if (typeof member !== "function") {
        return member;
      }
      if (property !== "commit") {
        return (...args: readonly unknown[]): unknown => Reflect.apply(member, target, args);
      }
      return (writes: readonly StorageWrite[], ...rest: readonly unknown[]): unknown => {
        commits += writes.length > 0 ? 1 : 0;
        return Reflect.apply(member, target, [writes, ...rest]);
      };
    },
  });
  return { storage: counted, commits: () => commits };
}

/** Scripted model turns: one tool call, then a final text answer. */
export const callThenAnswer = (
  tool: string,
  args: JsonObject,
  answer: string,
): [call: AssistantMessage, answer: AssistantMessage] => [
  fauxAssistantMessage([fauxToolCall(tool, args, { id: "call-1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText(answer)]),
];

/** The tool result messages of `conversation` (default: the harness's root), oldest first. */
export async function toolResults(
  harness: Harness,
  conversation?: Conversation,
): Promise<ToolResultMessage[]> {
  const of = conversation ?? (await harness.root(context));
  const page = await of.entries({}, 50, undefined, context);
  return [...page.items]
    .reverse()
    .filter((entry) => ToolResultEntry.is(entry))
    .map((entry) => entry.model?.[0])
    .filter((message) => message?.role === "toolResult");
}

export const textOf = (message: ToolResultMessage): string =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/**
 * Run one turn on `conversation` (default: the harness's root), close the
 * harness, and return the sections of each system prompt it recorded, newest
 * first (the order `entries` pages in).
 */
export async function systemPromptSections(
  test: TestHarness,
  conversation: Conversation = test.root,
): Promise<unknown[]> {
  test.faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await (await conversation.submit({ type: "input", content: "hi" }, context)).wait(context);
  const page = await conversation.entries({}, 50, undefined, context);
  await test.harness.close(context);
  // The prompt is recorded as a system entry whose message is outside pi-ai's Message type.
  return page.items
    .flatMap((entry): unknown[] => [...(entry.model ?? [])])
    .filter(isRecord)
    .filter((message) => message["role"] === "system")
    .map((message) => message["sections"]);
}

/** The daemon over `test`, on `path`, with the tests' creation defaults. */
export const serveTest = (test: TestHarness, path: string): Promise<Daemon> =>
  serve({
    socketPath: path,
    conversations: Promise.resolve(
      conversations(test, { model: FAUX_MODEL, cwd: process.cwd() }, "host"),
    ),
    beforeInput: () => Promise.resolve(),
    orientation: () => Promise.resolve(""),
  });
