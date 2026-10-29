// Shared helpers for the mail tests: fixture loading, builders for contract-valid
// but hostile values, a seeded PRNG for the property test, and readers for a
// rendered result. Nothing here knows how the implementation works; it only
// builds inputs and reads outputs.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, type JsonRecord } from "../../src/json.ts";
import {
  type Address,
  type Attachment,
  type Body,
  checkData,
  type Classification,
  type ClassifyOutcome,
  type ListData,
  type MailboxesData,
  type Mailbox,
  type MailSource,
  type ReadData,
  type Summary,
  type ThreadData,
  type ThreadItem,
  type Unclassified,
} from "../../src/mail/source.ts";

// ---------------------------------------------------------------- fixtures

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

/** The envelope kinds the contract defines (what `checkData` accepts). */
export type MailKind = Parameters<typeof checkData>[0];

export interface Envelope {
  readonly version: unknown;
  readonly kind: unknown;
  readonly data: unknown;
}

/** Fixture files under `real/` or `contract/`, as names relative to the fixtures directory. */
export function fixtureFiles(dir: "real" | "contract"): string[] {
  return readdirSync(join(FIXTURES_DIR, dir))
    .filter((file) => file.endsWith(".json") || file.endsWith(".jsonl"))
    .sort()
    .map((file) => `${dir}/${file}`);
}

/** Every envelope in a fixture file: one JSON document per non-empty line (zero for an empty page). */
export function loadEnvelopes(name: string): Envelope[] {
  const text = readFileSync(join(FIXTURES_DIR, name), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new Error(`${name}: not an object`);
      }
      return { version: parsed["version"], kind: parsed["kind"], data: parsed["data"] };
    });
}

type DataOf<K extends MailKind> = NonNullable<ReturnType<typeof checkData<K>>>;

/** `checkData`, throwing instead of returning undefined: for inputs that must be contract-valid. */
export function mustCheck<K extends MailKind>(kind: K, data: unknown): DataOf<K> {
  const checked = checkData(kind, data);
  if (checked === undefined) {
    throw new Error(`not valid ${kind} data`);
  }
  return checked;
}

/** The validated `data` of the first envelope of a fixture file, which must be of `kind`. */
export function loadData<K extends MailKind>(kind: K, name: string): DataOf<K> {
  const [envelope] = loadEnvelopes(name);
  if (envelope?.kind !== kind) {
    throw new Error(`${name}: expected a ${kind} envelope`);
  }
  return mustCheck(kind, envelope.data);
}

/** The validated `data` of every envelope of a read-after page file. */
export function loadReadPage(name: string): ReadData[] {
  return loadEnvelopes(name).map((envelope) => mustCheck("read", envelope.data));
}

// ----------------------------------------------------------- JSON surgery

/** A copy of `node` with the value at `path` replaced; `node` is untouched. */
export function setAt(node: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) {
    return value;
  }
  if (Array.isArray(node)) {
    const copy: unknown[] = node.slice();
    copy[Number(head)] = setAt(copy[Number(head)], rest, value);
    return copy;
  }
  if (isRecord(node)) {
    return { ...node, [head]: setAt(node[head], rest, value) };
  }
  throw new Error(`no ${String(head)} to set`);
}

/** A copy of `node` with the last key of `path` removed; `node` is untouched. */
export function withoutKey(node: unknown, path: readonly (string | number)[]): unknown {
  const [head, ...rest] = path;
  if (head === undefined) {
    throw new Error("no key to remove");
  }
  if (Array.isArray(node)) {
    const copy: unknown[] = node.slice();
    copy[Number(head)] = withoutKey(copy[Number(head)], rest);
    return copy;
  }
  if (isRecord(node)) {
    const key = String(head);
    if (rest.length === 0) {
      return Object.fromEntries(Object.entries(node).filter(([name]) => name !== key));
    }
    return { ...node, [key]: withoutKey(node[key], rest) };
  }
  throw new Error(`no ${String(head)} to remove`);
}

/** The key withExtraFields adds. */
export const FUTURE_FIELD = "x_future_field";

/** A deep copy with an unknown extra field added to every object (a future v1 addition). */
export function withExtraFields(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(withExtraFields);
  }
  if (isRecord(node)) {
    const entries = Object.entries(node).map(([key, value]) => [key, withExtraFields(value)]);
    return { ...Object.fromEntries(entries), [FUTURE_FIELD]: "future" };
  }
  return node;
}

// -------------------------------------------------------------------- PRNG

export interface Rng {
  /** An integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

/** A seeded generator (mulberry32): the same seed always makes the same values. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) {
        throw new Error("pick from an empty list");
      }
      return item;
    },
    chance: (probability) => next() < probability,
  };
}

// ----------------------------------------------------------- hostile values

/** Pieces that break naive escaping, measuring or cutting. */
const HOSTILE_PIECES: readonly string[] = [
  "<",
  ">",
  "&",
  '"',
  "\\",
  "\u0000",
  "\u001f",
  "\u007f",
  "\n",
  " ",
  "😀",
  "é",
  "€",
  "\ud800", // lone high surrogate
  "\udc00", // lone low surrogate
  "</mail-data>",
  '<mail-data untrusted="true">',
  "x",
];

/** Every hostile piece once. */
export const HOSTILE_ONCE = HOSTILE_PIECES.join("");

/** At least `length` UTF-16 units of hostile text. */
export function hostileText(rng: Rng, length: number): string {
  let text = "";
  while (text.length < length) {
    text += rng.pick(HOSTILE_PIECES);
  }
  return text;
}

const ID_CHARS: readonly string[] =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("");

/** A JMAP Id of exactly `length` characters (at most 255) starting with `tag`; `tag` is an Id too. */
export function idOf(length: number, tag: string): string {
  return tag.padEnd(length, "x");
}

/** A JMAP Id of `length` random Id characters after `prefix`. */
export function randomId(rng: Rng, length: number, prefix: string): string {
  let id = prefix;
  while (id.length < length) {
    id += rng.pick(ID_CHARS);
  }
  return id;
}

/** The canonical cursor with the longest rendering: int64 min and a 255-byte id (278 rendered bytes). */
export function longestCursor(tag = "c"): string {
  return `-9223372036854775808:${idOf(255, tag)}`;
}

// ---------------------------------------------------------------- builders

export function addressOf(n: number, nameLength = 12): Address {
  return {
    name: `Person ${String(n)}`.padEnd(nameLength, "n"),
    email: `person${String(n)}@example.com`,
  };
}

export function addressesOf(count: number, nameLength = 12): Address[] {
  return Array.from({ length: count }, (_, n) => addressOf(n, nameLength));
}

export function summaryOf(overrides: Partial<Summary> = {}): Summary {
  return {
    id: "Msg1",
    thread_id: "Thr1",
    received_at: "2026-10-27T16:58:00Z",
    subject: "Hello",
    from: [addressOf(1)],
    preview: "A preview",
    is_seen: false,
    is_flagged: false,
    mailbox_ids: ["mbx1"],
    has_attachment: false,
    cursor: "1793120280000:Msg1",
    ...overrides,
  };
}

export function bodyPartOf(overrides: Partial<Body> = {}): Body {
  return {
    part_id: "1",
    source_type: "text",
    text: "body text",
    is_truncated: false,
    truncated_by: null,
    is_encoding_problem: false,
    conversion_failed: false,
    ...overrides,
  };
}

export function attachmentOf(overrides: Partial<Attachment> = {}): Attachment {
  return {
    part_id: "2",
    blob_id: "Gblob1",
    name: "report.pdf",
    type: "application/pdf",
    size: 2048,
    disposition: "attachment",
    cid: null,
    ...overrides,
  };
}

export function readOf(overrides: Partial<ReadData> = {}): ReadData {
  return {
    ...summaryOf(),
    sent_at: "2026-10-27T16:57:30Z",
    size: 5120,
    keywords: ["$seen"],
    sender: [],
    to: [addressOf(2)],
    cc: [],
    bcc: [],
    reply_to: [],
    message_id: ["<m1@example.com>"],
    in_reply_to: [],
    references: [],
    bodies: [bodyPartOf()],
    attachments: [],
    provenance: { account_id: "u1234", email_state: "state-1" },
    output_truncated: false,
    ...overrides,
  };
}

export function inStoreThreadItem(overrides: Partial<Summary> = {}): ThreadItem {
  return { ...summaryOf(overrides), in_store: true };
}

export function absentThreadItem(id: string): ThreadItem {
  return { id, in_store: false };
}

export function mailboxOf(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: "mbx1",
    name: "Inbox",
    parent_id: null,
    role: "inbox",
    sort_order: 1,
    total_emails: 10,
    unread_emails: 3,
    ...overrides,
  };
}

/** Summary fields at their longest: 255-byte ids and cursor, a long hostile subject, every flag, fill larger than a share. */
export function maxSummaryFields(tag: string): Partial<Summary> {
  return {
    id: idOf(255, `${tag}-id`),
    thread_id: idOf(255, `${tag}-thread`),
    subject: "<".repeat(300),
    from: addressesOf(40, 60),
    preview: "p".repeat(3000),
    is_seen: true,
    is_flagged: true,
    mailbox_ids: Array.from({ length: 20 }, (_, n) => idOf(255, `${tag}-mbx${String(n)}`)),
    has_attachment: true,
    cursor: longestCursor(tag),
  };
}

export function maxSummary(tag: string): Summary {
  return summaryOf(maxSummaryFields(tag));
}

/** A read envelope at its longest core (ids, subject, 7 long message ids, every flag) with fill larger than a `mail_new` share. */
export function maxRead(tag: string): ReadData {
  return readOf({
    ...maxSummaryFields(tag),
    sent_at: "s".repeat(5000),
    keywords: Array.from({ length: 300 }, (_, n) => `keyword-${String(n)}`),
    sender: addressesOf(40, 60),
    to: addressesOf(40, 60),
    cc: addressesOf(40, 60),
    bcc: addressesOf(40, 60),
    reply_to: addressesOf(40, 60),
    message_id: Array.from({ length: 7 }, (_, n) => `<${String(n)}${"m".repeat(300)}@example.com>`),
    in_reply_to: Array.from(
      { length: 40 },
      (_, n) => `<r${String(n)}${"r".repeat(60)}@example.com>`,
    ),
    references: Array.from(
      { length: 80 },
      (_, n) => `<f${String(n)}${"f".repeat(60)}@example.com>`,
    ),
    bodies: [
      bodyPartOf({
        part_id: "1",
        text: ">".repeat(4096),
        is_truncated: true,
        truncated_by: "server",
        is_encoding_problem: true,
        conversion_failed: true,
      }),
      bodyPartOf({ part_id: "2", text: "tail", is_truncated: true, truncated_by: "message_limit" }),
    ],
    attachments: Array.from({ length: 50 }, (_, n) =>
      attachmentOf({
        part_id: String(n),
        blob_id: idOf(255, `${tag}-blob${String(n)}`),
        name: "n".repeat(100),
      }),
    ),
    provenance: { account_id: idOf(255, `${tag}-acct`), email_state: "e".repeat(100) },
    output_truncated: true,
  });
}

// -------------------------------------------------------- random hostile data

export type Size = "small" | "mixed" | "max";

function scaled(rng: Rng, size: Size, small: number, mixedMax: number, max: number): number {
  const byLabel = { small, mixed: rng.int(0, mixedMax), max };
  return byLabel[size];
}

function nullable<T>(rng: Rng, value: T): T | null {
  return rng.chance(0.2) ? null : value;
}

function hostileAddresses(rng: Rng, size: Size, max: number): Address[] {
  return Array.from({ length: scaled(rng, size, 1, max, max) }, () => ({
    name: nullable(rng, hostileText(rng, scaled(rng, size, 8, 60, 60))),
    email: hostileText(rng, scaled(rng, size, 10, 60, 120)),
  }));
}

function hostileStrings(rng: Rng, size: Size, max: number, length: number): string[] {
  return Array.from({ length: scaled(rng, size, 1, max, max) }, () =>
    hostileText(rng, scaled(rng, size, 10, length, length)),
  );
}

const RECEIVED_FORMS: readonly string[] = [
  "2026-10-27T16:58:00Z",
  "2026-10-27T16:58:00.123456789+05:30",
  "2026-10-27T16:58:00-00:00",
];
const CURSOR_MS: readonly string[] = [
  "0",
  "-5",
  "1793120280000",
  "-9223372036854775808",
  "9223372036854775807",
];

/** A contract-valid summary with hostile text; `tag` keeps ids distinct within a page. */
export function randomSummary(rng: Rng, size: Size, tag: string): Summary {
  const id = randomId(rng, scaled(rng, size, 12, 255, 255), tag);
  return summaryOf({
    id,
    thread_id: randomId(rng, scaled(rng, size, 12, 255, 255), `${tag}t`),
    received_at: rng.pick(RECEIVED_FORMS),
    subject: nullable(rng, hostileText(rng, scaled(rng, size, 20, 400, 400))),
    from: hostileAddresses(rng, size, 40),
    preview: hostileText(rng, scaled(rng, size, 30, 1000, 3000)),
    is_seen: rng.chance(0.5),
    is_flagged: rng.chance(0.5),
    mailbox_ids: Array.from({ length: scaled(rng, size, 1, 6, 20) }, (_, n) =>
      randomId(rng, scaled(rng, size, 8, 255, 255), `${tag}m${String(n)}`),
    ),
    has_attachment: rng.chance(0.5),
    cursor: `${rng.pick(CURSOR_MS)}:${id}`,
  });
}

function randomBody(rng: Rng, size: Size, n: number): Body {
  const truncated = rng.chance(0.5);
  return bodyPartOf({
    part_id: String(n),
    source_type: rng.pick(["text", "html"] as const),
    text: hostileText(rng, scaled(rng, size, 50, 2000, 3000)),
    is_truncated: truncated,
    truncated_by: truncated ? rng.pick(["server", "message_limit"] as const) : null,
    is_encoding_problem: rng.chance(0.3),
    conversion_failed: rng.chance(0.3),
  });
}

function randomAttachment(rng: Rng, size: Size, tag: string, n: number): Attachment {
  return attachmentOf({
    part_id: String(n),
    blob_id: randomId(rng, scaled(rng, size, 8, 255, 255), `${tag}b${String(n)}`),
    name: nullable(rng, hostileText(rng, 40)),
    type: hostileText(rng, 20),
    size: rng.int(0, 1_000_000),
    disposition: nullable(rng, "attachment"),
    cid: nullable(rng, hostileText(rng, 20)),
  });
}

/** A contract-valid read envelope with hostile text and lists; `size` scales every list. */
export function randomRead(rng: Rng, size: Size, tag: string): ReadData {
  return readOf({
    ...randomSummary(rng, size, tag),
    sent_at: nullable(rng, "2026-10-27T16:57:30Z"),
    size: rng.int(0, 10_000_000),
    keywords: hostileStrings(rng, size, 40, 30),
    sender: hostileAddresses(rng, size, 40),
    to: hostileAddresses(rng, size, 40),
    cc: hostileAddresses(rng, size, 40),
    bcc: hostileAddresses(rng, size, 40),
    reply_to: hostileAddresses(rng, size, 40),
    message_id: hostileStrings(rng, size, 8, 400),
    in_reply_to: hostileStrings(rng, size, 8, 100),
    references: hostileStrings(rng, size, 100, 100),
    bodies: Array.from({ length: scaled(rng, size, 1, 4, 3) }, (_, n) => randomBody(rng, size, n)),
    attachments: Array.from({ length: scaled(rng, size, 0, 5, 50) }, (_, n) =>
      randomAttachment(rng, size, tag, n),
    ),
    provenance: {
      account_id: randomId(rng, scaled(rng, size, 8, 255, 255), "a"),
      email_state: hostileText(rng, 30),
    },
    output_truncated: rng.chance(0.5),
  });
}

export function randomThreadItem(rng: Rng, size: Size, tag: string): ThreadItem {
  if (rng.chance(0.3)) {
    return absentThreadItem(randomId(rng, scaled(rng, size, 12, 255, 255), tag));
  }
  return { ...randomSummary(rng, size, tag), in_store: true };
}

// ------------------------------------------------------ reading a rendered result

export const OPEN_TAG = '<mail-data untrusted="true">';
export const CLOSE_TAG = "</mail-data>";

function resultLines(result: string): { lines: string[]; open: number } {
  const lines = result.split("\n");
  const open = lines.indexOf(OPEN_TAG);
  if (open < 0 || lines.at(-1) !== CLOSE_TAG) {
    throw new Error("not a mail result");
  }
  return { lines, open };
}

/** The data lines between the open and close tags. */
export function dataLinesOf(result: string): string[] {
  const { lines, open } = resultLines(result);
  return lines.slice(open + 1, -1);
}

/** The header lines before the open tag. */
export function headerLinesOf(result: string): string[] {
  const { lines, open } = resultLines(result);
  return lines.slice(0, open);
}

/** A data line parsed back to its object. */
export function parseLine(line: string): JsonRecord {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) {
    throw new Error("data line is not an object");
  }
  return parsed;
}

/** Bytes as the host sends them: measured on the actual output, never on raw input. */
export function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The rendered size of a value: UTF-8 length after JSON.stringify and the
 * `<`, `>`, `&` escapes. An independent statement of the rule, so the tests
 * do not trust the implementation's own measure.
 */
export function renderedBytes(value: unknown): number {
  const json = JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return bytesOf(json);
}

// ------------------------------------------------------------- a fake port

/** What a fake port answers per verb: the data, or an Error to fail with. */
export interface FakeReplies {
  readonly mailboxes?: MailboxesData | Error;
  readonly list?: ListData | Error;
  readonly read?: ReadData | Error;
  readonly readAfter?: ReadData[] | Error;
  readonly thread?: ThreadData | Error;
  readonly classify?: Readonly<Record<string, Classification | Unclassified>> | Error;
}

export interface RecordedCall {
  readonly verb: keyof FakeReplies;
  /** The query as the tool passed it, without its signal. */
  readonly query: object;
  readonly signal: AbortSignal | undefined;
}

export interface FakeMailSource extends MailSource {
  readonly calls: readonly RecordedCall[];
}

/**
 * A MailSource that records every call and answers from `replies`. A verb
 * with no reply fails when called, so a tool reaching for the wrong verb shows.
 */
export function fakeMailSource(replies: FakeReplies = {}): FakeMailSource {
  const calls: RecordedCall[] = [];
  const answer = <T>(
    verb: keyof FakeReplies,
    { signal, ...query }: { signal?: AbortSignal | undefined },
    reply: T | Error | undefined,
  ): Promise<T> => {
    calls.push({ verb, query, signal });
    if (reply === undefined) {
      return Promise.reject(new Error(`unexpected ${verb} call`));
    }
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return {
    calls,
    mailboxes: (signal) => answer("mailboxes", { signal }, replies.mailboxes),
    list: (query) => answer("list", query, replies.list),
    read: (query) => answer("read", query, replies.read),
    readAfter: (query) => answer("readAfter", query, replies.readAfter),
    thread: (query) => answer("thread", query, replies.thread),
    classify: (query): Promise<ClassifyOutcome[]> => {
      const reply = replies.classify;
      if (reply === undefined || reply instanceof Error) {
        return answer<ClassifyOutcome[]>("classify", query, reply);
      }
      const outcomes: ClassifyOutcome[] = query.ids.map((id) => {
        const found = reply[id];
        if (found === undefined) {
          return { id, unclassified: "failed" };
        }
        return typeof found === "string" ? { id, unclassified: found } : { id, classified: found };
      });
      return answer("classify", query, outcomes);
    },
  };
}
