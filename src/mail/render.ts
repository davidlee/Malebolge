// Mail rendering: the one measure, the one cut, the fill, the header and the page.
//
// Every size here is a rendered size: the UTF-8 length of JSON.stringify plus
// the `<`, `>`, `&` escapes. Nothing is measured on raw text (EX-2), so an
// item's line is measured exactly as it is sent.

import type { CutName, ProjectedItem, ProjectedMailbox } from "./project.ts";
import { isCanonicalCursor } from "./source.ts";

/** The whole result, header and wrapper included (pi's DEFAULT_MAX_BYTES). */
export const MAIL_MAX_BYTES = 50 * 1024;
/** Room kept for the header and the block's fixed wrapper. */
export const HEADER_RESERVE = 2 * 1024;
/** What the wrapper's fixed text and newlines are charged, below HEADER_RESERVE. */
export const WRAPPER_BYTES = 64;
/** The header's own room. */
export const HEADER_MAX_BYTES = HEADER_RESERVE - WRAPPER_BYTES;
/** What the items (and the newlines between them) share. */
export const ITEMS_MAX_BYTES = MAIL_MAX_BYTES - HEADER_RESERVE;

const OPEN_TAG = '<mail-data untrusted="true">';
const CLOSE_TAG = "</mail-data>";
const BODY_KEY_BYTES = 8; // `,"body":`
const KNOWN_GAPS =
  "known gaps: late arrivals with an older received_at are not returned; filters do not reopen passed positions";

/** Each item's room: the items' 48 KiB less the newlines between them, divided equally. */
export function shareOf(limit: number): number {
  return Math.floor((ITEMS_MAX_BYTES - (limit - 1)) / limit);
}

/** `value` as one data line: JSON, with every `<`, `>` and `&` escaped. */
export function dataLine(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/** The bytes `value` takes on the line: the one size measure in the mail tools. */
export function renderedLength(value: unknown): number {
  return Buffer.byteLength(dataLine(value), "utf8");
}

/** The longest code-point prefix of `chars` whose rendering, with `suffix`, fits. */
function longestFittingPrefix(chars: readonly string[], maxBytes: number, suffix: string): string {
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (renderedLength(chars.slice(0, middle).join("") + suffix) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return chars.slice(0, low).join("") + suffix;
}

/**
 * `text` when it fits `maxBytes` rendered; otherwise its longest code-point
 * prefix plus `suffix` that does. Never splits a surrogate pair.
 */
export function cutRendered(
  text: string,
  maxBytes: number,
  suffix = "",
): { text: string; cut: boolean } {
  if (renderedLength(text) <= maxBytes) {
    return { text, cut: false };
  }
  return { text: longestFittingPrefix(Array.from(text), maxBytes, suffix), cut: true };
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

/** Mailboxes whole, in order, while they fit the items' room. */
export function fitMailboxes(mailboxes: readonly ProjectedMailbox[]): {
  lines: string[];
  shown: number;
  of: number;
} {
  const lines: string[] = [];
  let used = 0;
  for (const mailbox of mailboxes) {
    const line = dataLine(mailbox);
    const cost = lines.length === 0 ? Buffer.byteLength(line) : Buffer.byteLength(line) + 1;
    if (used + cost > ITEMS_MAX_BYTES) {
      break;
    }
    lines.push(line);
    used += cost;
  }
  return { lines, shown: lines.length, of: mailboxes.length };
}

// -------------------------------------------------------------- the header

export type MailTool = "mail_new" | "mail_read" | "mail_thread" | "mail_list" | "mail_mailboxes";

export interface Clamp {
  readonly name: "limit" | "max_bytes" | "offset";
  readonly to: number;
}

export interface HeaderFacts {
  readonly tool: MailTool;
  readonly items: number;
  readonly withCuts: number;
  readonly heldBack?: number;
  readonly next?: string;
  readonly caughtUp?: boolean;
  readonly clamps: readonly Clamp[];
  readonly thread?: { readonly total: number; readonly truncated: boolean };
  readonly shown?: { readonly shown: number; readonly of: number };
  readonly knownGaps?: boolean;
}

function count(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`mail header: ${what} is not a count`);
  }
  return value;
}

function assertWithin(text: string, maxBytes: number, what: string): void {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${what} is over ${String(maxBytes)} bytes`);
  }
}

function itemsLine(facts: HeaderFacts): string {
  const head = `${facts.tool}: ${String(count(facts.items, "items"))} items, ${String(
    count(facts.withCuts, "with cuts"),
  )} with cuts`;
  if (facts.heldBack === undefined) {
    return head;
  }
  return `${head}, ${String(count(facts.heldBack, "held back"))} held back`;
}

function nextLine(next: string): string {
  if (!isCanonicalCursor(next)) {
    throw new Error("mail header: next is not a canonical cursor");
  }
  return `next: ${dataLine(next)}`;
}

function clampsLine(clamps: readonly Clamp[]): string {
  return clamps
    .map((clamp) => `${clamp.name} clamped to ${String(count(clamp.to, "clamp"))}`)
    .join("; ");
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
  const lines = [itemsLine(facts)];
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
  const body = lines.map((line) => `${line}\n`).join("");
  const result = `${header}\n${OPEN_TAG}\n${body}${CLOSE_TAG}`;
  assertWithin(result, MAIL_MAX_BYTES, "mail result");
  return result;
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
  const { lines, shown, of } = fitMailboxes(mailboxes);
  const header = renderHeader({
    tool: "mail_mailboxes",
    items: shown,
    withCuts: 0,
    clamps: [],
    shown: { shown, of },
  });
  return renderResult(header, lines);
}
