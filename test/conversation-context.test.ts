// SL-004 PHASE-01: the conversation context — one index read turned into the
// six `SATAN_*` variables tools receive and the prompt line the system prompt
// shows (design sec-2, sec-5; DEC-018, DEC-019, DEC-021). Every row of the
// mapping table goes through `expectAllSix`, so RV-012 F-1 cannot return by a
// conditional spread.

import type { ConversationId } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import type { Profile } from "../src/config.ts";
import { isConversationKey, toolsetInit } from "../src/conversations.ts";
import {
  type ConversationContext,
  contextOf,
  conversationLine,
  conversationVars,
  type SatanKind,
  satanIdentity,
} from "../src/conversation-context.ts";
import { DEFAULT_TOPIC } from "../src/protocol.ts";
import { type IndexDoc, type IndexEntry, IndexDocument, type IndexReader } from "../src/topics.ts";
import {
  createConversation,
  createTaskOwned,
  forkConversation,
  openIndexedHarness,
} from "./harness-fixture.ts";

/** The six names, as `~/db/q` reads them: the whole contract of `conversationVars`. */
const NAMES = [
  "SATAN_HARNESS",
  "SATAN_PROFILE",
  "SATAN_CONVERSATION",
  "SATAN_CWD",
  "SATAN_TOPIC",
  "SATAN_PARENT_CONVERSATION",
] as const;

/** Every row's key set and string values: what `toEqual` alone would not say. */
function expectAllSix(vars: Record<string, string>): void {
  expect(Object.keys(vars).sort()).toEqual([...NAMES].sort());
  for (const name of NAMES) {
    expect(vars[name]).toBeTypeOf("string");
  }
}

/** pi's branded id for `n`, through the guard the wire parser uses, so no case needs a cast. */
const idOf = (n: number): ConversationId => {
  if (!isConversationKey(n)) {
    throw new Error(`test id ${String(n)} is no conversation id`);
  }
  return n;
};

/** A conversation context as the caller builds it: no entry is a conversation the index lacks. */
const conversationOf = (id: number, entry?: IndexEntry): ConversationContext => ({
  id: idOf(id),
  ...(entry === undefined ? {} : { entry }),
});

/** One row of the mapping table: the input, and every value it must produce. */
interface Row {
  profile: Profile;
  cwd: string;
  context: ConversationContext;
  expected: Record<string, string>;
}

const ROWS: Record<string, Row> = {
  "a fork": {
    profile: "host",
    cwd: "/home/david/malebolge",
    context: conversationOf(12, { topic: "work", parent: 7, toolset: "interactive" }),
    expected: {
      SATAN_HARNESS: "malebolge",
      SATAN_PROFILE: "host",
      SATAN_CONVERSATION: "12",
      SATAN_CWD: "/home/david/malebolge",
      SATAN_TOPIC: "work",
      SATAN_PARENT_CONVERSATION: "7",
    },
  },
  "a non-fork": {
    profile: "room",
    cwd: "/home/room",
    context: conversationOf(9, { topic: "work", toolset: "interactive" }),
    expected: {
      SATAN_HARNESS: "malebolge",
      SATAN_PROFILE: "room",
      SATAN_CONVERSATION: "9",
      SATAN_CWD: "/home/room",
      SATAN_TOPIC: "work",
      SATAN_PARENT_CONVERSATION: "",
    },
  },
  "no entry": {
    profile: "room",
    cwd: "/home/room",
    context: conversationOf(21),
    expected: {
      SATAN_HARNESS: "malebolge",
      SATAN_PROFILE: "room",
      SATAN_CONVERSATION: "21",
      SATAN_CWD: "/home/room",
      SATAN_TOPIC: "",
      SATAN_PARENT_CONVERSATION: "",
    },
  },
};

it.each(Object.entries(ROWS))("maps %s to the six variables", (_name, row) => {
  const vars = conversationVars(row.profile, row.cwd, row.context);
  expectAllSix(vars);
  expect(vars).toEqual(row.expected);
});

it("reads root's entry in the default topic", async () => {
  const test = await openIndexedHarness();
  expect(await contextOf(test.harness, test.root.id)).toEqual({
    id: test.root.id,
    entry: { topic: DEFAULT_TOPIC, toolset: "interactive" },
  });
});

it("reads a fork's own id, its topic and its parent", async () => {
  const test = await openIndexedHarness();
  const parent = await createConversation(test.harness, toolsetInit("room", "work"));
  const forked = await forkConversation(test.harness, parent);
  expect(await contextOf(test.harness, forked.id)).toEqual({
    id: forked.id,
    entry: { topic: "work", parent: parent.id, toolset: "interactive" },
  });
});

it("gives no entry for a conversation the index lacks", async () => {
  const test = await openIndexedHarness();
  const owned = await createTaskOwned(test);
  expect(await contextOf(test.harness, owned)).toEqual({ id: owned });
});

it("takes an inherited name as no entry: the lookup is own-key", async () => {
  const empty: IndexDoc = IndexDocument.definition.initial();
  const read: IndexReader = { snapshot: () => Promise.resolve(empty) };
  // Ids are decimal, so only a cast can key the index `constructor`: the guard
  // is real but no store can reach it.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- no decimal id is this name
  const forged = "constructor" as unknown as ConversationId;
  const found = await contextOf(read, forged);
  expect(found.id).toBe(forged);
  expect(found.entry).toBeUndefined();
});

it("draws the line with the entry's topic", () => {
  expect(conversationLine(conversationOf(12, { topic: "satan-db", toolset: "interactive" }))).toBe(
    "Conversation: 12 (topic: satan-db)",
  );
});

it("draws the line alone when the index has no entry", () => {
  expect(conversationLine(conversationOf(12))).toBe("Conversation: 12");
});

it("announces the conversation as its identity to satan-mcp (EX-2)", () => {
  const kind: SatanKind = "interactive";
  const identity = satanIdentity(idOf(12), kind);
  expect(identity).toEqual({
    experimental: { satan: { conversation: "12", kind: "interactive" } },
  });
  // Stringified: satan-mcp keys its own state by a string, whatever pi's id is.
  expect(identity.experimental.satan.conversation).toBeTypeOf("string");
  expect(satanIdentity(idOf(7), kind).experimental.satan.conversation).toBe("7");
});
