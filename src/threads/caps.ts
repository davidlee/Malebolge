// Families and the verdict (SL-006 design § Counting; PHASE-06 EX-4, VT-3): what
// posts are live per origin, and what admitting one more post does. Pure: the caller
// reads an inspection, this counts and decides; no Tx and no harness.

import type { TaskId, TaskInspection } from "@earendil-works/pi-durable";
import { FAMILY_CAP, GLOBAL_CAP } from "./admission.ts";
import { type Origin, originKey } from "./origin.ts";
import { isPostInput, POST_KIND } from "./task.ts";

/** One origin's active posts, in inspection order. */
export interface Family {
  origin: Origin;
  active: number;
  taskIds: readonly TaskId[];
}

/**
 * The origin a task is counted under, or nothing. Only a live post counts: a task of
 * another kind, a parked (`blocked`) one, a notice (`post-failed`, `family-reaped`,
 * which are cap-exempt) or one whose family was reaped adds nothing.
 */
const countedOriginOf = (
  task: TaskInspection,
  reaped: (key: string) => boolean,
): Origin | undefined => {
  const { record, state } = task;
  if (record.kind !== POST_KIND || state.kind === "blocked" || !isPostInput(record.input)) {
    return undefined;
  }
  const { origin } = record.input;
  return record.input.letter === "post" && !reaped(originKey(origin)) ? origin : undefined;
};

/** Active posts per origin key: live satan.post tasks whose letter is post; blocked tasks and reaped origins left out. */
export function familiesOf(
  tasks: readonly TaskInspection[],
  reaped: (key: string) => boolean,
): ReadonlyMap<string, Family> {
  const families = new Map<string, Family>();
  for (const task of tasks) {
    const origin = countedOriginOf(task, reaped);
    if (origin === undefined) {
      continue;
    }
    const key = originKey(origin);
    const family = families.get(key);
    families.set(
      key,
      family === undefined
        ? { origin, active: 1, taskIds: [task.record.id] }
        : { ...family, active: family.active + 1, taskIds: [...family.taskIds, task.record.id] },
    );
  }
  return families;
}

export type Verdict =
  | { kind: "admit" }
  | { kind: "reap-own"; reason: string }
  | { kind: "reap-other"; family: Family; reason: string };

/** The caller's family once the post being admitted is live: its entry's active posts + 1, or 1 with no entry. */
const ownFamily = (families: ReadonlyMap<string, Family>, origin: Origin): Family => {
  const entry = families.get(originKey(origin));
  return entry === undefined
    ? { origin, active: 1, taskIds: [] }
    : { ...entry, active: entry.active + 1 };
};

/** Every family as the admission would leave it: the caller's counted with its +1. */
const withCaller = (families: ReadonlyMap<string, Family>, own: Family): readonly Family[] => {
  const key = originKey(own.origin);
  const others = [...families]
    .filter(([familyKey]) => familyKey !== key)
    .map(([, family]) => family);
  return [...others, own];
};

/** Whether `a` outranks `b` as the family to reap: more active, ties to the younger origin (the higher entry). */
const outranks = (a: Family, b: Family): boolean =>
  a.active > b.active || (a.active === b.active && a.origin.entry > b.origin.entry);

/** The largest family of `all`, starting from `first`. */
const largestOf = (all: readonly Family[], first: Family): Family => {
  let largest = first;
  for (const family of all) {
    if (outranks(family, largest)) {
      largest = family;
    }
  }
  return largest;
};

/** What admitting one more post from `origin` does. */
export function verdict(families: ReadonlyMap<string, Family>, origin: Origin): Verdict {
  const own = ownFamily(families, origin);
  if (own.active > FAMILY_CAP) {
    return {
      kind: "reap-own",
      reason: `${String(own.active)} active (cap ${String(FAMILY_CAP)})`,
    };
  }
  const all = withCaller(families, own);
  let total = 0;
  for (const family of all) {
    total += family.active;
  }
  if (total <= GLOBAL_CAP) {
    return { kind: "admit" };
  }
  const largest = largestOf(all, own);
  const reason = `${String(total)} active daemon-wide (cap ${String(GLOBAL_CAP)}); largest family`;
  return originKey(largest.origin) === originKey(origin)
    ? { kind: "reap-own", reason }
    : { kind: "reap-other", family: largest, reason };
}
