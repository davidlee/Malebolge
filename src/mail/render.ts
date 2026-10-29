// Mail rendering: the fill, the header and the page.
//
// Every size here is a rendered size: the UTF-8 length of JSON.stringify plus
// the `<`, `>`, `&` escapes. Nothing is measured on raw text (EX-2), so an
// item's line is measured exactly as it is sent. The measure, the cut and the
// wrapper belong to the shared untrusted block (SL-008 design sec-4).

import type { Clamp } from "../ranges.ts";
import {
  assertWithin,
  clampsLine,
  count,
  cutRendered,
  dataLine,
  fitWhole,
  HEADER_MAX_BYTES,
  ITEMS_MAX_BYTES,
  renderBlock,
} from "../untrusted-block.ts";
import type { CutName, ProjectedItem, ProjectedMailbox } from "./project.ts";
import { type PolicyQuestion, WITHHOLD_POLICY } from "./policy.ts";
import { isCanonicalCursor } from "./source.ts";

/** The mail block's tag, as `<mail-data untrusted="true">` (design § Framing item 1). */
export const MAIL_TAG = "mail-data";
const BODY_KEY_BYTES = 8; // `,"body":`
const KNOWN_GAPS =
  "known gaps: late arrivals with an older received_at are not returned; filters do not reopen passed positions";

/** Each item's room: the items' 48 KiB less the newlines between them, divided equally. */
export function shareOf(limit: number): number {
  return Math.floor((ITEMS_MAX_BYTES - (limit - 1)) / limit);
}

// ---------------------------------------------------------------- the fill

interface FitDraft {
  readonly item: ProjectedItem;
  readonly fill: (readonly [CutName, unknown])[];
  readonly cuts: CutName[];
  outputTruncated: boolean;
}

function coreFlag(item: ProjectedItem, key: string): boolean {
  const entry = item.core.find(([name]) => name === key);
  return entry?.[1] === true;
}

function entryValue(
  key: string,
  value: unknown,
  cuts: readonly CutName[],
  outputTruncated: boolean,
): unknown {
  if (key === "cut") {
    return cuts;
  }
  if (key === "output_truncated") {
    return outputTruncated;
  }
  return value;
}

/** The data line of an item with `fill` added, `cuts` named and `body` last. */
function renderLine(
  draft: FitDraft,
  fill: readonly (readonly [CutName, unknown])[],
  cuts: readonly CutName[],
  outputTruncated: boolean,
  body: string | undefined,
): string {
  const entries: (readonly [string, unknown])[] = draft.item.core.map(([key, value]) => [
    key,
    entryValue(key, value, cuts, outputTruncated),
  ]);
  entries.push(...fill);
  if (body !== undefined) {
    entries.push(["body", body]);
  }
  return dataLine(Object.fromEntries(entries));
}

/** The cuts to reserve while testing fill entry `from`: so far, later ones and the body. */
function reserveCuts(draft: FitDraft, from: number): CutName[] {
  const reserved = [...draft.cuts];
  for (let index = from; index < draft.item.fill.length; index++) {
    const entry = draft.item.fill[index];
    if (entry !== undefined && !reserved.includes(entry[0])) {
      reserved.push(entry[0]);
    }
  }
  if (draft.item.body !== undefined) {
    addCut(reserved, "body");
  }
  return reserved;
}

function addCut(cuts: CutName[], name: CutName): void {
  if (!cuts.includes(name)) {
    cuts.push(name);
  }
}

function addFill(draft: FitDraft, share: number): void {
  for (let index = 0; index < draft.item.fill.length; index++) {
    const entry = draft.item.fill[index];
    if (entry === undefined) {
      continue;
    }
    const line = renderLine(
      draft,
      [...draft.fill, entry],
      reserveCuts(draft, index + 1),
      draft.outputTruncated,
      undefined,
    );
    if (Buffer.byteLength(line, "utf8") <= share) {
      draft.fill.push(entry);
    } else {
      addCut(draft.cuts, entry[0]);
    }
  }
}

/** The body takes what remains of the share, cut on a code-point boundary. */
function addBody(draft: FitDraft, share: number): string | undefined {
  const { body } = draft.item;
  if (body === undefined) {
    return undefined;
  }
  const whole = renderLine(draft, draft.fill, draft.cuts, draft.outputTruncated, body);
  if (Buffer.byteLength(whole, "utf8") <= share) {
    return body;
  }
  addCut(draft.cuts, "body");
  draft.outputTruncated = true;
  const bare = renderLine(draft, draft.fill, draft.cuts, true, undefined);
  const remaining = share - Buffer.byteLength(bare, "utf8") - BODY_KEY_BYTES;
  if (remaining < 2) {
    return undefined;
  }
  return cutRendered(body, remaining).text;
}

/**
 * One item's line, within `share`: the core whole, the fill fields that fit
 * (each whole or left out and named), then the body cut to what remains.
 */
export function fitItem(
  item: ProjectedItem,
  share: number,
): { line: string; cut: readonly CutName[] } {
  const draft: FitDraft = {
    item,
    fill: [],
    cuts: [...item.cut],
    outputTruncated: coreFlag(item, "output_truncated"),
  };
  addFill(draft, share);
  const body = addBody(draft, share);
  const line = renderLine(draft, draft.fill, draft.cuts, draft.outputTruncated, body);
  if (Buffer.byteLength(line, "utf8") > share) {
    throw new Error("mail item exceeds its share");
  }
  return { line, cut: draft.cuts };
}

// -------------------------------------------------------------- the header

export type MailTool = "mail_new" | "mail_read" | "mail_thread" | "mail_list" | "mail_mailboxes";

export interface HeaderFacts {
  readonly tool: MailTool;
  readonly items: number;
  readonly withCuts: number;
  readonly heldBack?: number;
  /** The items whose sender-written text the pre-filter withheld (design § The pre-filter). */
  readonly withheld?: number;
  /** The policy questions withheld items were missing, names of the policy table only. */
  readonly missingQuestions?: readonly PolicyQuestion[];
  readonly next?: string;
  readonly caughtUp?: boolean;
  readonly clamps: readonly Clamp[];
  readonly thread?: { readonly total: number; readonly truncated: boolean };
  readonly shown?: { readonly shown: number; readonly of: number };
  readonly knownGaps?: boolean;
}

function itemsLine(facts: HeaderFacts): string {
  let line = `${facts.tool}: ${String(count(facts.items, "items"))} items, ${String(
    count(facts.withCuts, "with cuts"),
  )} with cuts`;
  if (facts.heldBack !== undefined) {
    line = `${line}, ${String(count(facts.heldBack, "held back"))} held back`;
  }
  if (facts.withheld !== undefined) {
    const withheld = count(facts.withheld, "withheld");
    if (withheld > 0) {
      line = `${line}, ${String(withheld)} withheld`;
    }
  }
  return line;
}

/**
 * One line per distinct missing policy question, in the table's order. A name the
 * table does not hold fails closed: the header is trusted text (design § The pre-filter).
 */
function missingQuestionLines(names: readonly PolicyQuestion[]): string[] {
  const known: readonly string[] = WITHHOLD_POLICY.map((row) => row.question);
  for (const name of names) {
    if (!known.includes(name)) {
      throw new Error("mail header: a missing question is not in the policy table");
    }
  }
  const wanted: readonly PolicyQuestion[] = names;
  return WITHHOLD_POLICY.filter((row) => wanted.includes(row.question)).map(
    (row) => `missing question: ${row.question}`,
  );
}

function nextLine(next: string): string {
  if (!isCanonicalCursor(next)) {
    throw new Error("mail header: next is not a canonical cursor");
  }
  return `next: ${dataLine(next)}`;
}

function threadLine(thread: { readonly total: number; readonly truncated: boolean }): string {
  return `total: ${String(count(thread.total, "total"))}, truncated: ${String(thread.truncated)}`;
}

function shownLine(shown: { readonly shown: number; readonly of: number }): string {
  return `shown ${String(count(shown.shown, "shown"))} of ${String(count(shown.of, "of"))}`;
}

/**
 * The trusted header: only literals this code writes and values in fixed
 * forms. A value that is not in one fails closed, so the header cannot carry
 * untrusted text.
 */
export function renderHeader(facts: HeaderFacts): string {
  const lines = [itemsLine(facts), ...missingQuestionLines(facts.missingQuestions ?? [])];
  if (facts.next !== undefined) {
    lines.push(nextLine(facts.next));
  }
  if (facts.caughtUp !== undefined) {
    lines.push(`caught_up: ${String(facts.caughtUp)}`);
  }
  if (facts.clamps.length > 0) {
    lines.push(clampsLine(facts.clamps));
  }
  if (facts.thread !== undefined) {
    lines.push(threadLine(facts.thread));
  }
  if (facts.shown !== undefined) {
    lines.push(shownLine(facts.shown));
  }
  if (facts.knownGaps === true) {
    lines.push(KNOWN_GAPS);
  }
  const header = lines.join("\n");
  assertWithin(header, HEADER_MAX_BYTES, "mail header");
  return header;
}

// -------------------------------------------------------- the result, page

/** The header, then the untrusted block: one data line per item, nothing else. */
export function renderResult(header: string, lines: readonly string[]): string {
  return renderBlock(MAIL_TAG, header, lines);
}

/** One page: every item on its line within `shareOf(limit)`, counted into the header. */
export function renderPage(
  facts: Omit<HeaderFacts, "items" | "withCuts">,
  items: readonly ProjectedItem[],
  limit: number,
): string {
  if (items.length > limit) {
    throw new Error("mail page has more items than its limit");
  }
  const fitted = items.map((item) => fitItem(item, shareOf(limit)));
  const withCuts = fitted.filter((fit) => fit.cut.length > 0).length;
  return renderResult(
    renderHeader({ ...facts, items: items.length, withCuts }),
    fitted.map((fit) => fit.line),
  );
}

/** The mailboxes page: the ones that fit, and `shown N of M` in the header. */
export function renderMailboxes(mailboxes: readonly ProjectedMailbox[]): string {
  const { lines, shown, of } = fitWhole(mailboxes);
  const header = renderHeader({
    tool: "mail_mailboxes",
    items: shown,
    withCuts: 0,
    clamps: [],
    shown: { shown, of },
  });
  return renderResult(header, lines);
}
