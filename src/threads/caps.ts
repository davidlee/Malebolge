// Families and the verdict (SL-006 design § Counting; PHASE-06 EX-4, VT-3): what
// posts are live per origin, and what admitting one more post does. Pure: the caller
// reads an inspection, this counts and decides; no Tx and no harness.

import type { ConversationId, TaskId, TaskInspection } from "@earendil-works/pi-durable";
import { FAMILY_CONVERSATION_CAP, FAMILY_POST_CAP, GLOBAL_POST_CAP } from "./admission.ts";
import { type Origin, originKey } from "./origin.ts";
import { isPostInput, POST_KIND } from "./task.ts";

/** One origin's active posts, in inspection order, and the conversations they reach. */
export interface Family {
  origin: Origin;
  recipients: readonly ConversationId[];
  taskIds: readonly TaskId[];
}

/** A live post as the caps count it: its origin and recipient. */
interface Counted {
  origin: Origin;
  to: ConversationId;
}

/**
 * The post a task counts as, or nothing. Only a live post counts: a task of another
 * kind, a parked (`blocked`) one, a notice (`post-failed`, `family-reaped`, which are
 * cap-exempt) or one whose family was reaped adds nothing.
 */
const countedOf = (task: TaskInspection, reaped: (key: string) => boolean): Counted | undefined => {
  const { record, state } = task;
  if (record.kind !== POST_KIND || state.kind === "blocked" || !isPostInput(record.input)) {
    return undefined;
  }
  const { input } = record;
  return input.letter === "post" && !reaped(originKey(input.origin))
    ? { origin: input.origin, to: input.to }
    : undefined;
};

/** `recipients` with `to` added once. */
const withRecipient = (
  recipients: readonly ConversationId[],
  to: ConversationId,
): readonly ConversationId[] => (recipients.includes(to) ? recipients : [...recipients, to]);

/** Active posts per origin key: live satan.post tasks whose letter is post; blocked tasks and reaped origins left out. */
export function familiesOf(
  tasks: readonly TaskInspection[],
  reaped: (key: string) => boolean,
): ReadonlyMap<string, Family> {
  const families = new Map<string, Family>();
  for (const task of tasks) {
    const counted = countedOf(task, reaped);
    if (counted === undefined) {
      continue;
    }
    const key = originKey(counted.origin);
    const family = families.get(key) ?? { origin: counted.origin, recipients: [], taskIds: [] };
    families.set(key, {
      ...family,
      recipients: withRecipient(family.recipients, counted.to),
      taskIds: [...family.taskIds, task.record.id],
    });
  }
  return families;
}

export type Verdict =
  | { kind: "admit" }
  | { kind: "reap-own"; reason: string }
  | { kind: "reap-other"; family: Family; reason: string };

/** A family as the global cap weighs it: its live posts, the caller's with the one being admitted. */
interface Weighed {
  family: Family;
  posts: number;
}

/** Whether `a` outranks `b` as the family to reap: more posts, ties to the younger origin (the higher entry). */
const outranks = (a: Weighed, b: Weighed): boolean =>
  a.posts > b.posts || (a.posts === b.posts && a.family.origin.entry > b.family.origin.entry);

/** What the caller's family-cap breach is, if any: conversations first, then posts. */
const familyBreach = (own: Family, to: ConversationId | undefined): string | undefined => {
  const conversations =
    own.recipients.length + (to !== undefined && own.recipients.includes(to) ? 0 : 1);
  if (conversations > FAMILY_CONVERSATION_CAP) {
    return `${String(conversations)} conversations active (cap ${String(FAMILY_CONVERSATION_CAP)})`;
  }
  const posts = own.taskIds.length + 1;
  return posts > FAMILY_POST_CAP
    ? `${String(posts)} posts active (cap ${String(FAMILY_POST_CAP)})`
    : undefined;
};

/**
 * What admitting one more call from `origin` does. `to` is the conversation it posts
 * to, or undefined for a start or fork, whose conversation is not yet made.
 */
export function verdict(
  families: ReadonlyMap<string, Family>,
  origin: Origin,
  to: ConversationId | undefined,
): Verdict {
  const key = originKey(origin);
  const own = families.get(key) ?? { origin, recipients: [], taskIds: [] };
  const breach = familyBreach(own, to);
  if (breach !== undefined) {
    return { kind: "reap-own", reason: breach };
  }
  const caller: Weighed = { family: own, posts: own.taskIds.length + 1 };
  const all = [
    ...[...families]
      .filter(([familyKey]) => familyKey !== key)
      .map(([, family]) => ({ family, posts: family.taskIds.length })),
    caller,
  ];
  const total = all.reduce((sum, weighed) => sum + weighed.posts, 0);
  if (total <= GLOBAL_POST_CAP) {
    return { kind: "admit" };
  }
  let largest = caller;
  for (const weighed of all) {
    if (outranks(weighed, largest)) {
      largest = weighed;
    }
  }
  const reason = `${String(total)} posts active daemon-wide (cap ${String(GLOBAL_POST_CAP)}); largest family`;
  return largest === caller
    ? { kind: "reap-own", reason }
    : { kind: "reap-other", family: largest.family, reason };
}
