// Families and the verdict (SL-006 design § Counting; PHASE-06 EX-4, VT-3): active
// posts per origin, and what admitting one more post does. Pure: every inspection is
// a fake task built here, with no harness and no Tx.

import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type Harness,
  type HarnessInspection,
  type JsonObject,
  type TaskId,
  type TaskInspection,
  UserEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import { isRecord } from "../src/json.ts";
import { DEFAULT_TOPIC } from "../src/protocol.ts";
import { familiesOf, verdict } from "../src/threads/caps.ts";
import { type Origin, originKey } from "../src/threads/origin.ts";
import { afterReap, reapIn } from "../src/threads/reap.ts";
import {
  POST_KIND,
  type PostInput,
  type PostResult,
  type PostState,
  postRequestId,
} from "../src/threads/task.ts";
import { readIndex } from "../src/topics.ts";
import { WAKE_KIND } from "../src/wake/task.ts";
import { textOf, toolResults } from "./harness-fixture.ts";
import {
  createIndexedThread,
  createPost,
  inputOf,
  notifyCalls,
  postEntries,
  postResult,
  postTasks,
  reapedNotices,
  reapedOrigins,
  type ThreadSession,
  threadWorld,
  type ThreadWorld,
  waitQueuedPost,
  writeTombstone,
} from "./thread-fixture.ts";
import {
  dataOf,
  entriesOf,
  gatedTurn,
  heldUntilCutOff,
  only,
  submissionOf,
  WAIT,
} from "./wake-fixture.ts";

/** What a task record's input is (pi-durable exports no bare JSON value type). */
type JsonValue = JsonObject[string];

/** Whether `n` could be one of pi-durable's ids: positive safe integers. */
const isPositive = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

const isConversationId = (n: number): n is ConversationId => isPositive(n);
const isTaskId = (n: number): n is TaskId<JsonValue> => isPositive(n);

/** `n` as an id `is` accepts, or a failure: pi-durable's ids are opaque numbers to a test. */
const idOf = <I extends number>(n: number, is: (value: number) => value is I, what: string): I => {
  if (!is(n)) {
    throw new Error(`test id ${String(n)} is no ${what}`);
  }
  return n;
};

const conversationIdOf = (n: number): ConversationId =>
  idOf(n, isConversationId, "conversation id");
const taskIdOf = (n: number): TaskId<JsonValue> => idOf(n, isTaskId, "task id");

/** The conversation every fake task belongs to, and the one a post is sent to. */
const CONVERSATION = conversationIdOf(1);
const RECIPIENT = conversationIdOf(2);

/** A human origin at `entry`: pi-durable mints entry ids from one sequence, so a higher entry is younger. */
const human = (entry: number): Origin => ({ conversation: CONVERSATION, entry, kind: "human" });

/** No origin is reaped. */
const NOTHING_REAPED = (): boolean => false;

/** An origin as JSON: the way a post's input carries it (a record's input is JSON, not an interface). */
const originData = (origin: Origin): JsonObject => ({
  conversation: origin.conversation,
  entry: origin.entry,
  kind: origin.kind,
  ...(origin.episodeClass === undefined ? {} : { episodeClass: origin.episodeClass }),
});

/** The input of task `id`: a post, or one of the two cap-exempt notices. */
const postInputOf = (
  id: TaskId<JsonValue>,
  origin: Origin,
  letter: PostInput["letter"],
): JsonObject => {
  const from = originData(origin);
  switch (letter) {
    case "post":
      return {
        letter,
        to: RECIPIENT,
        from: CONVERSATION,
        topic: "topic",
        origin: from,
        intent: "intent",
      };
    case "post-failed":
      return {
        letter,
        to: RECIPIENT,
        origin: from,
        post: id,
        recipient: CONVERSATION,
        outcome: "withdrawn",
        reason: "target unreachable",
        intent: "intent",
      };
    case "family-reaped":
      return { letter, to: RECIPIENT, origin: from, reason: "5 active (cap 4)" };
  }
};

/** A live task inspection as the caps read it: its id, origin, letter, kind and scheduler state. */
const postInspection = (
  id: TaskInspection["record"]["id"],
  origin: Origin,
  options: { letter?: PostInput["letter"]; state?: "running" | "blocked"; kind?: string } = {},
): TaskInspection => ({
  record: {
    id,
    conversationId: CONVERSATION,
    kind: options.kind ?? POST_KIND,
    version: 1,
    input: postInputOf(id, origin, options.letter ?? "post"),
    background: true,
    abortRequested: false,
    state: { status: "running", checkpoint: {} },
  },
  state:
    options.state === "blocked"
      ? { kind: "blocked", reason: "restart_limit" }
      : { kind: "running" },
});

/** `count` live posts of `origin`, ids running from `first`. */
const posts = (first: number, origin: Origin, count: number): TaskInspection[] =>
  Array.from({ length: count }, (_unused, offset) =>
    postInspection(taskIdOf(first + offset), origin),
  );

describe("familiesOf and verdict (PHASE-06 EX-4, VT-3)", () => {
  it("a blocked post task is not counted", () => {
    const origin = human(10);
    const families = familiesOf(
      [
        postInspection(taskIdOf(1), origin, { state: "blocked" }),
        postInspection(taskIdOf(2), origin),
      ],
      NOTHING_REAPED,
    );

    // The parked task waits for its definition; only the running post is active.
    expect(families.get(originKey(origin))).toEqual({ origin, active: 1, taskIds: [2] });
  });

  it("familiesOf leaves out reaped origins and notices", () => {
    const reapedOrigin = human(10);
    const live = human(20);
    const reaped = (key: string): boolean => key === originKey(reapedOrigin);
    const families = familiesOf(
      [
        postInspection(taskIdOf(1), reapedOrigin),
        postInspection(taskIdOf(2), live, { letter: "post-failed" }),
        postInspection(taskIdOf(3), live, { letter: "family-reaped" }),
        postInspection(taskIdOf(4), live, { kind: WAKE_KIND }),
        postInspection(taskIdOf(5), live),
      ],
      reaped,
    );

    // Notices are cap-exempt, another kind is not a post, and the reaped family is gone.
    expect(families.has(originKey(reapedOrigin))).toBe(false);
    expect(families.get(originKey(live))).toEqual({ origin: live, active: 1, taskIds: [5] });
  });

  it("verdict admits under both caps", () => {
    const caller = human(40);
    const alone = familiesOf([postInspection(taskIdOf(1), caller)], NOTHING_REAPED);
    expect(verdict(alone, caller)).toEqual({ kind: "admit" });

    // The caller's family at K exactly: 4 active is not over the family cap.
    const atFamilyCap = familiesOf(
      [...posts(1, caller, 3), ...posts(10, human(10), 1)],
      NOTHING_REAPED,
    );
    expect(verdict(atFamilyCap, caller)).toEqual({ kind: "admit" });

    // The daemon at N exactly: 4 + 4 + 3 elsewhere plus the caller's first post make 12.
    const atGlobalCap = familiesOf(
      [...posts(1, human(10), 4), ...posts(10, human(20), 4), ...posts(20, human(30), 3)],
      NOTHING_REAPED,
    );
    expect(verdict(atGlobalCap, caller)).toEqual({ kind: "admit" });
  });

  it("the fifth post of one origin reaps its own family", () => {
    const caller = human(40);
    const families = familiesOf(posts(1, caller, 4), NOTHING_REAPED);

    // Four are live already; the post being admitted is the fifth.
    expect(families.get(originKey(caller))?.active).toBe(4);
    expect(verdict(families, caller)).toEqual({ kind: "reap-own", reason: "5 active (cap 4)" });
  });

  it("the global cap reaps the largest other family and admits the call", () => {
    const caller = human(40);
    const largest = human(30);
    const families = familiesOf(
      [...posts(1, largest, 5), ...posts(10, human(10), 4), ...posts(20, human(20), 3)],
      NOTHING_REAPED,
    );

    // 5 + 4 + 3 live, plus the caller's post: 13 over a cap of 12.
    expect(verdict(families, caller)).toEqual({
      kind: "reap-other",
      family: { origin: largest, active: 5, taskIds: [1, 2, 3, 4, 5] },
      reason: "13 active daemon-wide (cap 12); largest family",
    });
  });

  it("ties go to the youngest origin", () => {
    const caller = human(40);
    const youngest = human(30);
    const families = familiesOf(
      [...posts(1, human(10), 4), ...posts(10, human(20), 4), ...posts(20, youngest, 4)],
      NOTHING_REAPED,
    );

    // Three families of 4: the highest entry id (30) is the one reaped.
    expect(verdict(families, caller)).toEqual({
      kind: "reap-other",
      family: { origin: youngest, active: 4, taskIds: [20, 21, 22, 23] },
      reason: "13 active daemon-wide (cap 12); largest family",
    });
  });

  it("the global cap reaps the caller's family when it is the largest", () => {
    const caller = human(40);
    const families = familiesOf(
      [
        ...posts(1, caller, 3),
        ...posts(10, human(10), 3),
        ...posts(20, human(20), 3),
        ...posts(30, human(30), 3),
      ],
      NOTHING_REAPED,
    );

    // The caller's family counts as 4, the largest: 4 + 3 + 3 + 3 = 13.
    expect(verdict(families, caller)).toEqual({
      kind: "reap-own",
      reason: "13 active daemon-wide (cap 12); largest family",
    });
  });

  it("a reaped family is never chosen again", () => {
    const caller = human(40);
    const largest = human(30);
    const next = human(20);
    const rest = human(10);
    const tasks = [...posts(1, largest, 5), ...posts(10, next, 4), ...posts(20, rest, 3)];

    expect(verdict(familiesOf(tasks, NOTHING_REAPED), caller)).toEqual({
      kind: "reap-other",
      family: { origin: largest, active: 5, taskIds: [1, 2, 3, 4, 5] },
      reason: "13 active daemon-wide (cap 12); largest family",
    });

    // Once its tombstone stands, its live tasks no longer count and it cannot be picked.
    const reaped = (key: string): boolean => key === originKey(largest);
    const after = familiesOf(tasks, reaped);
    expect([...after.keys()].sort()).toEqual([originKey(next), originKey(rest)].sort());
    expect(verdict(after, caller)).toEqual({ kind: "admit" });
  });
});

const INTENT = "Summarise the failing test runs";

/** The reason a family-cap reap names: the caller's fifth post. */
const CAP_REASON = "5 active (cap 4)";

/** The refusal a crossing call reads. */
const reapRefusal = (origin: Origin, reason = CAP_REASON): string =>
  `origin ${originKey(origin)} was reaped for fan-out: ${reason}; posts and thread starts from it are refused`;

/** `request`'s transcript as text: its messages, the system prompt's sections excluded. */
const transcriptOf = (request: Parameters<FauxResponseFactory>[0]): string =>
  JSON.stringify(request.messages.filter((message) => message.role !== "system"));

/**
 * The shared faux queue's one answer, whatever order the conversations ask in: the
 * recipient's foreground run and any post turn are held (so every post's input stays
 * queued and its task live), a turn whose last message is a tool result or that carries
 * a `family-reaped` envelope answers plainly, and any other turn issues `calls` as one
 * message. A later round's transcript already holds
 * an earlier round's tool result, so the check is on the newest message.
 */
const round =
  (calls: readonly ToolCall[]): FauxResponseFactory =>
  (request, options, state, model) => {
    const transcript = transcriptOf(request);
    if (transcript.includes("foreground") || transcript.includes("<post from=")) {
      return heldUntilCutOff(request, options, state, model);
    }
    if (request.messages.at(-1)?.role === "toolResult" || transcript.includes("<family-reaped")) {
      return fauxAssistantMessage([fauxText("stopped")]);
    }
    return fauxAssistantMessage([...calls], { stopReason: "toolUse" });
  };

/** `count` thread_post calls to `to`, as one message carries them. */
const postCalls = (to: ConversationId, count: number): ToolCall[] =>
  Array.from({ length: count }, (_unused, index) =>
    fauxToolCall("thread_post", { to, intent: INTENT }, { id: `call-${String(index + 1)}` }),
  );

/** The reap's stage: a world, a caller indexed with the threads extension, and its recipient. */
interface ReapStage {
  readonly world: ThreadWorld;
  readonly session: ThreadSession;
  readonly caller: Conversation;
  readonly recipient: Conversation;
}

/** A fresh world and stage; `registered` replaces the satan.post the session's registry installs. */
async function stageOver(registered?: ThreadWorld["task"]): Promise<ReapStage> {
  const world = threadWorld();
  const session = await world.open(registered);
  const caller = await createIndexedThread(session.harness, "room");
  const recipient = await createIndexedThread(session.harness, "research", []);
  return { world, session, caller, recipient };
}

/** A fresh world, an indexed caller on `room`, and an indexed recipient on `research` with no extension. */
function reapStage(): Promise<ReapStage> {
  return stageOver();
}

/** The scripted answers of a round issuing `calls`: one factory, shared by every conversation. */
const scriptCalls = (stage: ReapStage, calls: readonly ToolCall[]): void => {
  stage.world.faux.setResponses(Array.from({ length: 12 }, () => round(calls)));
};

/** The scripted answers of a round of `count` thread_post calls to the recipient. */
const scriptRound = (stage: ReapStage, count: number): void => {
  scriptCalls(stage, postCalls(stage.recipient.id, count));
};

/** Model turns a held run burns, one per reopen: each re-run of the placed turn is held again. */
const HELD_TURNS = 12;

/** Holds `conversation`'s run: its turn reaches the model and waits, so every later input queues. */
async function holdRun(world: ThreadWorld, conversation: Conversation): Promise<void> {
  await conversation.submit(
    { type: "input", content: "foreground", requestId: "foreground" },
    context,
  );
  await vi.waitFor(() => {
    expect(world.faux.state.callCount).toBe(1);
  }, WAIT);
}

/** A held run with a script of its own: every re-run of its turn holds until the process cuts it off. */
async function holdConversation(world: ThreadWorld, conversation: Conversation): Promise<void> {
  world.faux.setResponses(Array.from({ length: HELD_TURNS }, () => heldUntilCutOff));
  await holdRun(world, conversation);
}

/** Holds the recipient's run: its turn reaches the model and waits, so every post queues behind it. */
function holdRecipient(stage: ReapStage): Promise<void> {
  return holdRun(stage.world, stage.recipient);
}

/** One caller message issuing `count` thread_post calls, and the results the model read, oldest first. */
async function runRound(stage: ReapStage): Promise<ToolResultMessage[]> {
  await (await stage.caller.submit({ type: "input", content: "go" }, context)).wait(context);
  return toolResults(stage.session.harness, stage.caller);
}

/** The origin a round's calls carried: the caller's newest human input. */
async function originOfCaller(caller: Conversation): Promise<Origin> {
  const input = only((await entriesOf(caller)).filter((entry) => UserEntry.is(entry)));
  return { conversation: caller.id, entry: input.id, kind: "human" };
}

/** The created post's id, as a tool result names it: `{"post":N,"to":M}`. */
const postIdOf = (result: ToolResultMessage): TaskId<PostResult> => {
  const parsed: unknown = JSON.parse(textOf(result));
  if (!isRecord(parsed) || typeof parsed["post"] !== "number") {
    throw new Error(`tool result ${textOf(result)} names no post`);
  }
  return idOf(parsed["post"], (value): value is TaskId<PostResult> => isPositive(value), "task id");
};

/** The conversation's `family-reaped` entries: the originator's one notice. */
async function familyReaped(conversation: Conversation): Promise<EntryRecord[]> {
  return (await postEntries(conversation)).filter(
    (entry) => dataOf(entry)["letter"] === "family-reaped",
  );
}

/** The `post` input letter of `entry`, as a notice's or post's data carries it. */
const letterOf = (entry: EntryRecord): unknown => dataOf(entry)["letter"];

describe("the reap (PHASE-06 EX-5..EX-7)", () => {
  it("one message issuing more thread calls than K admits K and the crossing call reaps the family", async () => {
    const stage = await reapStage();
    scriptRound(stage, 5);
    await holdRecipient(stage);
    const results = await runRound(stage);

    // The first four calls are admitted: one round, so each counts the previous call's post.
    const admitted = results.slice(0, 4);
    const ids = admitted.map(postIdOf);
    expect(new Set(ids).size).toBe(4);
    for (const result of admitted) {
      expect(JSON.parse(textOf(result))).toEqual({
        post: postIdOf(result),
        to: stage.recipient.id,
      });
    }

    // The fifth crosses K and is refused, naming the cap and the origin.
    const origin = await originOfCaller(stage.caller);
    const crossing = only(results.slice(4));
    expect(crossing.isError).toBe(true);
    expect(textOf(crossing)).toBe(reapRefusal(origin));

    // The tombstone stands, and the four posts are the only post tasks the round created.
    const reaped = await reapedOrigins(stage.session.harness);
    expect(Object.keys(reaped)).toEqual([originKey(origin)]);
    expect(reaped[originKey(origin)]?.reason).toBe(CAP_REASON);

    // Their inputs are withdrawn and they settle reaped, with no post-failed notice.
    for (const id of ids) {
      expect(await postResult(stage.session.harness, id)).toEqual({ outcome: "reaped" });
      const own = await submissionOf(stage.session.harness, stage.recipient.id, postRequestId(id));
      expect(own?.status).not.toBe("queued");
      expect(own?.reason).toBe("aborted");
    }
    const notices = (await postEntries(stage.caller)).filter(
      (entry) => letterOf(entry) === "post-failed",
    );
    expect(notices).toEqual([]);
    // No fifth post task exists: every post still live is one this round created.
    const live = (await postTasks(stage.session.harness)).filter(
      (task) => inputOf(task)["letter"] === "post",
    );
    expect(live).toEqual([]);
  });

  it("a family over 4 is reaped and its originator told, while a co-resident loop is untouched", async () => {
    const stage = await reapStage();
    scriptRound(stage, 5);
    await holdRecipient(stage);

    // Another origin's post, queued at the same recipient before the round: a co-resident loop.
    const other: Origin = { conversation: stage.session.root.id, entry: 1, kind: "human" };
    const otherPost = await createPost(stage.session, stage.world.task, {
      letter: "post",
      to: stage.recipient.id,
      from: stage.session.root.id,
      topic: "research",
      origin: other,
      intent: INTENT,
    });
    await waitQueuedPost(stage.session, otherPost, stage.recipient.id);

    await runRound(stage);

    // The other loop's input is still queued, and its origin has no tombstone.
    const still = await submissionOf(
      stage.session.harness,
      stage.recipient.id,
      postRequestId(otherPost),
    );
    expect(still?.status).toBe("queued");
    expect((await reapedOrigins(stage.session.harness))[originKey(other)]).toBeUndefined();

    // The originator receives exactly one family-reaped entry, naming its own origin and the cap.
    const origin = await originOfCaller(stage.caller);
    await vi.waitFor(async () => {
      expect(await familyReaped(stage.caller)).toHaveLength(1);
    }, WAIT);
    const notice = only(await familyReaped(stage.caller));
    expect(dataOf(notice)["origin"]).toEqual(originData(origin));
    expect(dataOf(notice)["reason"]).toBe(CAP_REASON);
  });

  it("the reap journals the withdrawn count and notifies the operator, SATAN threads reaped", async () => {
    const stage = await reapStage();
    scriptRound(stage, 5);
    await holdRecipient(stage);
    const results = await runRound(stage);

    const origin = await originOfCaller(stage.caller);
    const line = `family ${originKey(origin)} reaped: ${CAP_REASON}; withdrew 4`;
    expect(line).toContain("reaped: 5 active (cap 4); withdrew");
    await vi.waitFor(() => {
      expect(stage.world.lines).toContain(line);
    }, WAIT);

    // Four post lines, then the reap's line: withdrawal found every family input queued.
    const postLines = stage.world.lines.filter((entry) => entry.startsWith("post "));
    expect(postLines).toHaveLength(4);
    const ids = results.slice(0, 4).map(postIdOf);
    for (const id of ids) {
      expect(postLines.some((entry) => entry.startsWith(`post ${String(id)} `))).toBe(true);
    }
    expect(stage.world.lines.at(-1)).toBe(line);

    // One notification, titled SATAN threads reaped, its body the journal line.
    const notifications = notifyCalls(stage.world);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.args["title"]).toBe("SATAN threads reaped");
    expect(notifications[0]?.args["body"]).toBe(line);
  });

  it("a fourth post alone is admitted, writes no tombstone and notifies nobody", async () => {
    const stage = await reapStage();
    scriptRound(stage, 4);
    await holdRecipient(stage);
    const results = await runRound(stage);

    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.isError).toBe(false);
      expect(JSON.parse(textOf(result))).toEqual({
        post: postIdOf(result),
        to: stage.recipient.id,
      });
    }

    // Under K: no tombstone, no family-reaped entry, no notification.
    expect(await reapedOrigins(stage.session.harness)).toEqual({});
    expect(await familyReaped(stage.caller)).toEqual([]);
    expect(notifyCalls(stage.world)).toEqual([]);
    expect(stage.world.lines).toHaveLength(4);
    expect(stage.world.lines.every((entry) => entry.startsWith("post "))).toBe(true);
  });
});

/** A hand-made family: its origin, and the posts queued under it at the recipient. */
interface HeldFamily {
  readonly origin: Origin;
  readonly ids: readonly TaskId<PostResult>[];
}

/** Four hand-created posts from origin `entry` on the recipient, queued behind its held run. */
async function holdFamily(stage: ReapStage, entry: number): Promise<HeldFamily> {
  const origin: Origin = { conversation: stage.recipient.id, entry, kind: "human" };
  const ids: TaskId<PostResult>[] = [];
  for (let index = 0; index < 4; index += 1) {
    const id = await createPost(stage.session, stage.world.task, {
      letter: "post",
      to: stage.recipient.id,
      from: stage.session.root.id,
      topic: "research",
      origin,
      intent: INTENT,
    });
    await waitQueuedPost(stage.session, id, stage.recipient.id);
    ids.push(id);
  }
  return { origin, ids };
}

/** Three other origins holding four live posts each: the daemon at N exactly, two of them tied at the top. */
async function holdFamilies(
  stage: ReapStage,
): Promise<readonly [old: HeldFamily, middle: HeldFamily, young: HeldFamily]> {
  const old = await holdFamily(stage, 100);
  const middle = await holdFamily(stage, 200);
  const young = await holdFamily(stage, 300);
  return [old, middle, young];
}

/** The reason a global-cap reap names: the caller's post making 13 daemon-wide. */
const GLOBAL_REASON = "13 active daemon-wide (cap 12); largest family";

/** The refusal a reaped origin's post reads when another conversation reaped the family first. */
const NO_REASON_REFUSAL = (origin: Origin): string =>
  `origin ${originKey(origin)} was reaped for fan-out; posts and thread starts from it are refused`;

/** One family's submissions at the recipient, as their statuses read. */
async function statusesOf(stage: ReapStage, family: HeldFamily): Promise<string[]> {
  const statuses: string[] = [];
  for (const id of family.ids) {
    const record = await submissionOf(stage.session.harness, stage.recipient.id, postRequestId(id));
    statuses.push(record?.status ?? "absent");
  }
  return statuses;
}

/**
 * The world's satan.post with an `initial` that throws for a post but not for a notice: a
 * seam pi-durable gives without a product change, since `Tx.createTask` runs it inside the
 * commit, after the reap's writes.
 */
const failingPost = (world: ThreadWorld): ThreadWorld["task"] => {
  const definition = world.task.definition;
  return {
    definition: {
      ...definition,
      initial: (input: PostInput): PostState => {
        if (input.letter === "post") {
          throw new Error("the creating commit failed");
        }
        return definition.initial(input);
      },
    },
  };
};

/** The live `post` tasks: what a call created, and what a refused or rolled-back call must not. */
async function livePosts(stage: ReapStage): Promise<TaskInspection[]> {
  return (await postTasks(stage.session.harness)).filter(
    (task) => inputOf(task)["letter"] === "post",
  );
}

describe("the global cap and in-commit refusals (PHASE-06 VT-6, VT-7)", () => {
  it("the global cap reaps the largest family, ties to the youngest origin", async () => {
    const stage = await reapStage();
    scriptRound(stage, 1);
    await holdRecipient(stage);
    // Three other origins hold 4 live posts each: 12 active, the cap exactly, the top two tied.
    const [old, middle, young] = await holdFamilies(stage);
    expect(await statusesOf(stage, old)).toEqual(Array.from({ length: 4 }, () => "queued"));
    expect(await statusesOf(stage, middle)).toEqual(Array.from({ length: 4 }, () => "queued"));
    expect(await statusesOf(stage, young)).toEqual(Array.from({ length: 4 }, () => "queued"));

    const result = only(await runRound(stage));

    // The caller's post makes 13: it is admitted, and the youngest tied family is reaped.
    expect(result.isError).toBe(false);
    const post = postIdOf(result);
    expect(JSON.parse(textOf(result))).toEqual({ post, to: stage.recipient.id });
    const reaped = await reapedOrigins(stage.session.harness);
    expect(Object.keys(reaped)).toEqual([originKey(young.origin)]);
    expect(reaped[originKey(young.origin)]?.reason).toBe(GLOBAL_REASON);

    // Its four queued inputs are withdrawn and settle reaped, with no post-failed notice.
    for (const id of young.ids) {
      expect(await postResult(stage.session.harness, id)).toEqual({ outcome: "reaped" });
    }
    expect((await statusesOf(stage, young)).every((status) => status !== "queued")).toBe(true);

    // One family-reaped notice task, to the reaped origin's conversation.
    const notice = only(await reapedNotices(stage.session.harness));
    expect(notice.record.conversationId).toBe(young.origin.conversation);
    expect(inputOf(notice)["origin"]).toEqual(originData(young.origin));

    // The other families are untouched: still queued, no tombstone.
    expect(reaped[originKey(old.origin)]).toBeUndefined();
    expect(reaped[originKey(middle.origin)]).toBeUndefined();
    expect(await statusesOf(stage, old)).toEqual(Array.from({ length: 4 }, () => "queued"));
    expect(await statusesOf(stage, middle)).toEqual(Array.from({ length: 4 }, () => "queued"));

    // The journal: the caller's post line, then the reap's line after it.
    const line = `family ${originKey(young.origin)} reaped: ${GLOBAL_REASON}; withdrew 4`;
    const postLine = stage.world.lines.findIndex((entry) => entry.startsWith("post "));
    expect(postLine).toBeGreaterThanOrEqual(0);
    expect(stage.world.lines.indexOf(line)).toBeGreaterThan(postLine);
  });

  it("a second call after a global-cap reap does not reap the same family again", async () => {
    const stage = await reapStage();
    scriptRound(stage, 1);
    await holdRecipient(stage);
    const [old, middle, young] = await holdFamilies(stage);
    expect(only(await runRound(stage)).isError).toBe(false);

    // A second call: the reaped family is gone from the count, so nothing is reaped again.
    scriptRound(stage, 1);
    const second = only((await runRound(stage)).slice(-1));
    expect(second.isError).toBe(false);
    expect(JSON.parse(textOf(second))).toEqual({
      post: postIdOf(second),
      to: stage.recipient.id,
    });

    // One tombstone and one notice, whatever the second call counted.
    expect(Object.keys(await reapedOrigins(stage.session.harness))).toEqual([
      originKey(young.origin),
    ]);
    expect(await reapedNotices(stage.session.harness)).toHaveLength(1);
    // Nothing else was withdrawn: both surviving families still hold their four queued inputs.
    expect(await statusesOf(stage, old)).toEqual(Array.from({ length: 4 }, () => "queued"));
    expect(await statusesOf(stage, middle)).toEqual(Array.from({ length: 4 }, () => "queued"));
  });

  it("a call whose creating commit throws after a reap-other verdict leaves no tombstone and no notice", async () => {
    // The session's satan.post fails a post's own creation but not a notice's, so the
    // creating commit throws after `reapIn` wrote: both writes must roll back with it.
    const world = threadWorld();
    const session = await world.open(failingPost(world));
    const caller = await createIndexedThread(session.harness, "room");
    const recipient = await createIndexedThread(session.harness, "research", []);
    const stage: ReapStage = { world, session, caller, recipient };
    scriptRound(stage, 1);
    await holdRecipient(stage);
    const families = await holdFamilies(stage);

    // pi-durable surfaces the thrown commit as the tool result's error text: the call
    // fails, and the turn that issued it carries on.
    const result = only(await runRound(stage));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("<harness>\n[error] the creating commit failed\n</harness>");

    // The reap's writes went with the commit: no tombstone, no notice task.
    expect(await reapedOrigins(session.harness)).toEqual({});
    expect(await reapedNotices(session.harness)).toEqual([]);
    // The other family's four inputs still wait, and nothing was journalled or notified.
    for (const family of families) {
      expect(await statusesOf(stage, family)).toEqual(Array.from({ length: 4 }, () => "queued"));
    }
    expect(world.lines.filter((entry) => entry.startsWith("family "))).toEqual([]);
    expect(notifyCalls(world)).toEqual([]);
  });

  it("a call admitted before its family is reaped by another conversation is refused in its commit and creates nothing", async () => {
    const stage = await reapStage();
    scriptRound(stage, 1);
    await holdRecipient(stage);

    // `inspect` runs between the admission commit and the creating commit: this wrapper is
    // another conversation reaping the caller's family in that gap.
    const harness = stage.session.harness;
    stage.world.threads.harness = {
      inspect: async (ctx): Promise<HarnessInspection> => {
        const entry = only(
          (await entriesOf(stage.caller)).filter((record) => UserEntry.is(record)),
        );
        const origin: Origin = { conversation: stage.caller.id, entry: entry.id, kind: "human" };
        await writeTombstone(harness, origin, "5 active (cap 4)");
        return harness.inspect(ctx);
      },
      abortSubmission: (id, ctx, conversationId): ReturnType<Harness["abortSubmission"]> =>
        harness.abortSubmission(id, ctx, conversationId),
    };

    const result = only(await runRound(stage));
    const origin = await originOfCaller(stage.caller);

    // The creating commit re-read the tombstone and refused with the reasonless text.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(NO_REASON_REFUSAL(origin));
    // It created nothing: no post task, no journal line, no notice.
    expect(await livePosts(stage)).toEqual([]);
    expect(stage.world.lines.filter((entry) => entry.startsWith("post "))).toEqual([]);
    expect(await reapedNotices(stage.session.harness)).toEqual([]);
  });
});

/** Plain model answers: the turns a recovered notice or a released hold runs. */
const plains = (count = 6): ReturnType<typeof fauxAssistantMessage>[] =>
  Array.from({ length: count }, () => fauxAssistantMessage([fauxText("ok")]));

/** The entries of `conversation` placed with `letter`: a post, or one of the two notices. */
async function entriesWithLetter(
  conversation: Conversation,
  letter: PostInput["letter"],
): Promise<EntryRecord[]> {
  return (await postEntries(conversation)).filter((entry) => letterOf(entry) === letter);
}

/** A fresh handle on `id`: the conversation handles of a closed session are stale. */
async function conversationOf(harness: Harness, id: ConversationId): Promise<Conversation> {
  const conversation = await harness.conversation(id, context);
  if (conversation === undefined) {
    throw new Error(`no conversation ${String(id)} after reopening`);
  }
  return conversation;
}

/** The reap's one write, committed alone: what a crossing call's commit lands before a crash. */
function reapCommit(stage: ReapStage, origin: Origin, reason: string): Promise<boolean> {
  return stage.session.harness.commit(
    (tx) => reapIn(tx, stage.world.task, origin, reason, Date.now()),
    context,
  );
}

/**
 * A start and a fork call: each creates a conversation and its first post in one commit.
 * The stage's caller sits in topic `room`, which no record names, so the start names one.
 */
const CREATING_CALLS = [
  [
    "thread_start",
    fauxToolCall("thread_start", { intent: INTENT, topic: DEFAULT_TOPIC }, { id: "call-1" }),
  ],
  ["thread_fork", fauxToolCall("thread_fork", { intent: INTENT }, { id: "call-1" })],
] as const;

/** The indexed conversations: a created child adds one, a rolled-back call none. */
async function indexedCount(stage: ReapStage): Promise<number> {
  return Object.keys((await readIndex(stage.session.harness)).conversations).length;
}

describe("thread_start and thread_fork under the global cap (design § Shared steps 4-5)", () => {
  it.each(CREATING_CALLS)(
    "%s at the global cap reaps the largest family in its creating commit",
    async (_name, call) => {
      const stage = await reapStage();
      scriptCalls(stage, [call]);
      await holdRecipient(stage);
      const [old, middle, young] = await holdFamilies(stage);

      expect(only(await runRound(stage)).isError).toBe(false);

      // The call is admitted and the youngest tied family is reaped, as for a post.
      const reaped = await reapedOrigins(stage.session.harness);
      expect(Object.keys(reaped)).toEqual([originKey(young.origin)]);
      expect(reaped[originKey(young.origin)]?.reason).toBe(GLOBAL_REASON);
      for (const id of young.ids) {
        expect(await postResult(stage.session.harness, id)).toEqual({ outcome: "reaped" });
      }
      const notice = only(await reapedNotices(stage.session.harness));
      expect(notice.record.conversationId).toBe(young.origin.conversation);
      expect(await statusesOf(stage, old)).toEqual(Array.from({ length: 4 }, () => "queued"));
      expect(await statusesOf(stage, middle)).toEqual(Array.from({ length: 4 }, () => "queued"));
    },
  );

  it.each(CREATING_CALLS)(
    "%s whose creating commit throws after a reap-other verdict creates no conversation and reaps nobody",
    async (_name, call) => {
      const world = threadWorld();
      const session = await world.open(failingPost(world));
      const caller = await createIndexedThread(session.harness, "room");
      const recipient = await createIndexedThread(session.harness, "research", []);
      const stage: ReapStage = { world, session, caller, recipient };
      scriptCalls(stage, [call]);
      await holdRecipient(stage);
      const families = await holdFamilies(stage);
      const before = await indexedCount(stage);

      expect(only(await runRound(stage)).isError).toBe(true);

      expect(await indexedCount(stage)).toBe(before);
      expect(await reapedOrigins(stage.session.harness)).toEqual({});
      expect(await reapedNotices(stage.session.harness)).toEqual([]);
      for (const family of families) {
        expect(await statusesOf(stage, family)).toEqual(Array.from({ length: 4 }, () => "queued"));
      }
    },
  );
});

describe("concurrent and crashed reaps", () => {
  it("two conversations of one family reaping at once create one tombstone and one notice", async () => {
    const stage = await reapStage();
    const origin: Origin = { conversation: stage.caller.id, entry: 1, kind: "human" };
    // The originator is busy with a held run, so the notice queues and its task stays live.
    await holdConversation(stage.world, stage.caller);

    // Two conversations of one family reap it at once: two commits, serialised by the line.
    const answers = await Promise.all([
      reapCommit(stage, origin, CAP_REASON),
      reapCommit(stage, origin, GLOBAL_REASON),
    ]);

    // The first writes; the second finds the tombstone and writes nothing, so no second notice.
    expect(answers).toEqual([true, false]);
    const reaped = await reapedOrigins(stage.session.harness);
    expect(Object.keys(reaped)).toEqual([originKey(origin)]);
    expect(reaped[originKey(origin)]?.reason).toBe(CAP_REASON);
    const notices = await reapedNotices(stage.session.harness);
    expect(notices).toHaveLength(1);
    expect(inputOf(only(notices))["reason"]).toBe(CAP_REASON);
    // The notice is created with the tombstone but not yet delivered: the originator is held.
    expect(await entriesWithLetter(stage.caller, "family-reaped")).toEqual([]);
  });

  it("two distinct reaps write two tombstones to the same stored document", async () => {
    const stage = await reapStage();
    stage.world.faux.setResponses(plains());
    const callerOrigin: Origin = { conversation: stage.caller.id, entry: 1, kind: "human" };
    const rootOrigin: Origin = { conversation: stage.session.root.id, entry: 1, kind: "human" };

    // Two families, two origins, both reaped at once.
    const answers = await Promise.all([
      reapCommit(stage, callerOrigin, CAP_REASON),
      reapCommit(stage, rootOrigin, GLOBAL_REASON),
    ]);
    expect(answers).toEqual([true, true]);
    // Each originator is told once before the store is closed.
    await vi.waitFor(async () => {
      expect(await entriesWithLetter(stage.caller, "family-reaped")).toHaveLength(1);
      expect(await entriesWithLetter(stage.session.root, "family-reaped")).toHaveLength(1);
    }, WAIT);

    await stage.session.harness.close(context);
    const reopened = await stage.world.open();

    // Both entries are in the one stored document: neither reap overwrote the other.
    const reaped = await reapedOrigins(reopened.harness);
    expect(Object.keys(reaped).sort()).toEqual(
      [originKey(callerOrigin), originKey(rootOrigin)].sort(),
    );
    expect(reaped[originKey(callerOrigin)]?.reason).toBe(CAP_REASON);
    expect(reaped[originKey(rootOrigin)]?.reason).toBe(GLOBAL_REASON);
    // Two notices, one per origin, still exactly one each after the restart.
    const caller = await conversationOf(reopened.harness, stage.caller.id);
    const root = await conversationOf(reopened.harness, stage.session.root.id);
    expect(await entriesWithLetter(caller, "family-reaped")).toHaveLength(1);
    expect(await entriesWithLetter(root, "family-reaped")).toHaveLength(1);
  });

  it("a crash after the reap commit and before any withdrawal delivers no queued family post after restart", async () => {
    const stage = await reapStage();
    await holdConversation(stage.world, stage.recipient);
    const family = await holdFamily(stage, 100);
    // A co-resident loop of another origin, queued at the same recipient.
    const other: Origin = { conversation: stage.session.root.id, entry: 1, kind: "human" };
    const neighbour = await createPost(stage.session, stage.world.task, {
      letter: "post",
      to: stage.recipient.id,
      from: stage.session.root.id,
      topic: "research",
      origin: other,
      intent: INTENT,
    });
    await waitQueuedPost(stage.session, neighbour, stage.recipient.id);

    // The crash: only the reap's commit lands, with none of its withdrawals.
    expect(await reapCommit(stage, family.origin, CAP_REASON)).toBe(true);
    await stage.session.harness.close(context);

    // Restart: each remaining family task withdraws its own input, and nothing of the family is placed.
    stage.world.faux.setResponses(Array.from({ length: HELD_TURNS }, () => heldUntilCutOff));
    const reopened = await stage.world.open();
    for (const id of family.ids) {
      expect(await postResult(reopened.harness, id)).toEqual({ outcome: "reaped" });
      const own = await submissionOf(reopened.harness, stage.recipient.id, postRequestId(id));
      expect(own?.status).not.toBe("queued");
      expect(own?.reason).toBe("aborted");
    }
    const recipient = await conversationOf(reopened.harness, stage.recipient.id);
    expect(await entriesWithLetter(recipient, "post")).toEqual([]);
    // The neighbour stays queued, and no post-failed notice was sent for the family.
    expect(
      (await submissionOf(reopened.harness, stage.recipient.id, postRequestId(neighbour)))?.status,
    ).toBe("queued");
    expect(await entriesWithLetter(reopened.root, "post-failed")).toEqual([]);
    // Only the family's own tombstone stands.
    expect(Object.keys(await reapedOrigins(reopened.harness))).toEqual([originKey(family.origin)]);
  });

  it("a crash right after the reap commit delivers the family-reaped notice once after restart, with no startup scan", async () => {
    const stage = await reapStage();
    const origin: Origin = { conversation: stage.caller.id, entry: 1, kind: "human" };
    // The originator is busy with a held run: the notice is created but not delivered before the crash.
    await holdConversation(stage.world, stage.caller);
    expect(await reapCommit(stage, origin, CAP_REASON)).toBe(true);
    expect(await reapedNotices(stage.session.harness)).toHaveLength(1);
    expect(await entriesWithLetter(stage.caller, "family-reaped")).toEqual([]);
    await stage.session.harness.close(context);

    // Restart: the held run ends, and the notice pi-durable recovered is delivered, once.
    stage.world.faux.setResponses(plains());
    const reopened = await stage.world.open();
    const caller = await conversationOf(reopened.harness, stage.caller.id);
    await vi.waitFor(async () => {
      expect(await entriesWithLetter(caller, "family-reaped")).toHaveLength(1);
    }, WAIT);

    // A further restart finds the notice delivered: no startup scan creates a second one.
    await reopened.harness.close(context);
    const again = await stage.world.open();
    const callerAgain = await conversationOf(again.harness, stage.caller.id);
    expect(await entriesWithLetter(callerAgain, "family-reaped")).toHaveLength(1);
    expect(await reapedNotices(again.harness)).toEqual([]);
  });

  it("a post that passed its tombstone check before the reap commit is delivered, and its turn cannot post", async () => {
    const stage = await reapStage();
    const recipient = await createIndexedThread(stage.session.harness, "research");
    const origin: Origin = { conversation: stage.caller.id, entry: 1, kind: "human" };
    // R's turn starts and waits at the model, so the post's input is placed past its tombstone check.
    const gated = gatedTurn(() =>
      fauxAssistantMessage(
        [fauxToolCall("thread_post", { to: stage.caller.id, intent: INTENT }, { id: "call-1" })],
        { stopReason: "toolUse" },
      ),
    );
    stage.world.faux.setResponses([gated.step, ...plains()]);
    const id = await createPost(stage.session, stage.world.task, {
      letter: "post",
      to: recipient.id,
      from: stage.caller.id,
      topic: "research",
      origin,
      intent: INTENT,
    });
    await gated.reached;
    await vi.waitFor(async () => {
      const own = await submissionOf(stage.session.harness, recipient.id, postRequestId(id));
      expect(own?.status).toBe("placed");
    }, WAIT);

    // The reap commits and runs its withdrawal: the placed input is not queued, so none is withdrawn.
    expect(await reapCommit(stage, origin, CAP_REASON)).toBe(true);
    await afterReap(stage.world.threads, origin, CAP_REASON, context);
    expect(stage.world.lines).toContain(
      `family ${originKey(origin)} reaped: ${CAP_REASON}; withdrew 0`,
    );

    // The placed turn runs to its end and cannot post: admission refuses R's turn, which inherits O.
    gated.release();
    expect(await postResult(stage.session.harness, id)).toEqual({ outcome: "delivered" });
    const refused = only(await toolResults(stage.session.harness, recipient));
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(NO_REASON_REFUSAL(origin));
    // The post is delivered, not withdrawn: its entry is in R, one of them, and it was not reaped.
    expect(await entriesWithLetter(recipient, "post")).toHaveLength(1);
    expect(Object.keys(await reapedOrigins(stage.session.harness))).toEqual([originKey(origin)]);
  });
});
