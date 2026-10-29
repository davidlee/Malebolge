// The mail projection: a validated envelope and its classification to the item the
// renderer fills.
//
// A projection copies only the fields the contract names, so a field added to a
// later v1 envelope is neither rendered nor counted (F-39). Every sender-written
// text a shown item carries is taken from the classification's `seen` — the window
// Jev's state was stripped from — so the agent's view is a prefix of Jev's (design
// § Jev's window). It shortens only `subject` (a core field cannot be left out)
// and the body (to the caller's `max_bytes`); everything else is shown whole or
// named in `cut`.

import { cutRendered, renderedLength } from "../untrusted-block.ts";
import type { Withheld } from "./policy.ts";
import {
  isRfc3339,
  type Address,
  type Body,
  type Classification,
  type ClassifyOutcome,
  type Mailbox,
  type ReadData,
  type Seen,
  type Summary,
  type ThreadItem,
} from "./source.ts";

/** The fixed set of cut names, in the order a `cut` list names them. */
export const CUT_ORDER = [
  "subject",
  "jev",
  "from",
  "sender_domains",
  "mailbox_ids",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "sender",
  "sent_at",
  "size",
  "preview",
  "keywords",
  "attachments",
  "body",
] as const;

export type CutName = (typeof CUT_ORDER)[number];

type Entries = (readonly [string, unknown])[];

/** One projected item: what is always shown, what may be filled, and the body. */
export interface ProjectedItem {
  readonly core: readonly (readonly [string, unknown])[];
  readonly fill: readonly (readonly [CutName, unknown])[];
  readonly body?: string;
  readonly cut: readonly CutName[];
}

/** A mailbox as shown: the seven contract fields, in contract order. */
export interface ProjectedMailbox {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly role: string | null;
  readonly sort_order: number;
  readonly total_emails: number;
  readonly unread_emails: number;
}

/** A cut subject is at most this many rendered bytes, quotes and `…` included. */
export const SUBJECT_MAX_BYTES = 200;

const ELLIPSIS = "…";

/** The UTC millisecond form of a contract-valid `received_at` (24 bytes). */
export function normaliseReceivedAt(raw: string): string {
  if (!isRfc3339(raw)) {
    throw new Error("malformed received_at");
  }
  return new Date(Date.parse(raw)).toISOString();
}

export type TruncationReason = "server" | "message_limit";

const TRUNCATION_REASONS: readonly TruncationReason[] = ["server", "message_limit"];

/** The flags only the read's parts know: the window carries neither (design § Jev's window). */
export interface ReadBodyFlags {
  readonly is_encoding_problem: boolean;
  readonly truncated_by: readonly TruncationReason[];
}

/** The read's parts' encoding problem ORed; their distinct truncation reasons in order. */
export function readBodyFlags(bodies: readonly Body[]): ReadBodyFlags {
  return {
    is_encoding_problem: bodies.some((part) => part.is_encoding_problem),
    truncated_by: TRUNCATION_REASONS.filter((reason) =>
      bodies.some((part) => part.truncated_by === reason),
    ),
  };
}

// ------------------------------------------------------------- projection

function orderedCuts(names: Iterable<CutName>): CutName[] {
  const wanted = new Set(names);
  return CUT_ORDER.filter((name) => wanted.has(name));
}

function capSubject(subject: string | null): { value: string | null; cuts: CutName[] } {
  if (subject === null) {
    return { value: null, cuts: [] };
  }
  const capped = cutRendered(subject, SUBJECT_MAX_BYTES, ELLIPSIS);
  return { value: capped.text, cuts: capped.cut ? ["subject"] : [] };
}

/** The address lists a read shows; `seen` carries an `_omitted` count for each. */
const READ_ADDRESS_LISTS = ["from", "sender", "reply_to", "to", "cc", "bcc"] as const;
/** The one address list a summary shows. */
const SUMMARY_ADDRESS_LISTS = ["from"] as const;

/** Each shown list whose `_omitted` count is non-zero, as a cut name (design § Jev's window). */
function omittedCuts(seen: Seen, lists: readonly (typeof READ_ADDRESS_LISTS)[number][]): CutName[] {
  return lists.filter((list) => seen[`${list}_omitted`] > 0);
}

/**
 * `text` when it fits `maxBytes` raw UTF-8 bytes; otherwise its longest code-point
 * prefix that does, and that it was cut. Never splits a surrogate pair, and adds no
 * suffix (design § Jev's window).
 */
function cutRawBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, cut: false };
  }
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    end += character.length;
  }
  return { text: text.slice(0, end), cut: true };
}

/**
 * The window's body text: its parts joined by a blank line, then cut to
 * the caller's `max_bytes` raw bytes (design § Jev's window).
 */
function seenBody(seen: Seen, maxBytes: number): { body: string; cut: boolean } {
  const cut = cutRawBytes(seen.bodies.map((part) => part.text).join("\n\n"), maxBytes);
  return { body: cut.text, cut: cut.cut };
}

/** `value` as every rendered number is written: 2 decimal places (design § Rendering). */
function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One answer as `jev` renders it: by shape alone, numbers to 2 dp (design § Rendering). */
function jevAnswer(answer: Classification["answers"][string]): unknown {
  if ("noul" in answer) {
    return roundTo2(answer.noul);
  }
  if ("choice" in answer) {
    return [answer.choice, roundTo2(answer.confidence)];
  }
  return [roundTo2(answer.score), roundTo2(answer.confidence)];
}

/**
 * The `jev` value some answers render to, and whether it had to be cut: each answer
 * by shape alone, in the answers' own order, while the rendered value fits
 * `JEV_MAX_BYTES`; the first answer that does not fit ends it (design § Rendering).
 */
export function jevOfAnswers(answers: Classification["answers"]): {
  value: Record<string, unknown>;
  cut: boolean;
} {
  const kept: Entries = [];
  for (const [question, answer] of Object.entries(answers)) {
    const rendered: readonly [string, unknown] = [question, jevAnswer(answer)];
    const candidate = Object.fromEntries([...kept, rendered]);
    if (renderedLength(candidate) > JEV_MAX_BYTES) {
      return { value: Object.fromEntries(kept), cut: true };
    }
    kept.push(rendered);
  }
  return { value: Object.fromEntries(kept), cut: false };
}

/** The `jev` core value for one outcome, classified or not. */
export function jevField(outcome: ClassifyOutcome): {
  value: Record<string, unknown>;
  cut: boolean;
} {
  if (!("classified" in outcome)) {
    return { value: { unclassified: outcome.unclassified }, cut: false };
  }
  return jevOfAnswers(outcome.classified.answers);
}

function summaryEntries(
  item: Summary,
  classified: Classification,
): { core: Entries; cuts: CutName[] } {
  const subject = capSubject(classified.seen.subject);
  const jev = jevOfAnswers(classified.answers);
  const cuts = [...subject.cuts];
  if (jev.cut) {
    cuts.push("jev");
  }
  return {
    core: [
      ["id", item.id],
      ["thread_id", item.thread_id],
      ["received_at", normaliseReceivedAt(item.received_at)],
      ["subject", subject.value],
      ["is_seen", item.is_seen],
      ["is_flagged", item.is_flagged],
      ["has_attachment", item.has_attachment],
      ["jev", jev.value],
    ],
    cuts: orderedCuts(cuts),
  };
}

/**
 * The five body flags: `is_truncated` and `conversion_failed` from the window's
 * bodies, `is_encoding_problem` and `truncated_by` from the read's parts, and
 * `output_truncated` from malebolge's own cut (design § Jev's window).
 */
function bodyFlagEntries(read: ReadBodyFlags, seen: Seen, outputTruncated: boolean): Entries {
  return [
    ["is_truncated", seen.bodies.some((body) => body.is_truncated) || seen.bodies_omitted > 0],
    ["is_encoding_problem", read.is_encoding_problem],
    ["conversion_failed", seen.bodies.some((body) => body.conversion_failed)],
    ["truncated_by", read.truncated_by],
    ["output_truncated", outputTruncated],
  ];
}

function projectAddresses(addresses: readonly Address[]): { name: string | null; email: string }[] {
  return addresses.map((address) => ({ name: address.name, email: address.email }));
}

interface ProjectedAttachment {
  readonly part_id: string;
  readonly blob_id: string;
  readonly name: string | null;
  readonly type: string;
  readonly size: number;
}

/**
 * The window's attachments joined by index to the read's: `type` and `name` from
 * `seen`, `part_id`, `blob_id` and `size` from the read's attachment at the same
 * index. An index the read lacks drops that seen entry and names `attachments` in
 * cut: an id is never invented (design § Jev's window).
 */
function projectAttachments(
  read: ReadData,
  seen: Seen,
): { value: ProjectedAttachment[]; cut: boolean } {
  const value: ProjectedAttachment[] = [];
  for (const [index, attachment] of seen.attachments.entries()) {
    const part = read.attachments[index];
    if (part === undefined) {
      continue;
    }
    value.push({
      part_id: part.part_id,
      blob_id: part.blob_id,
      name: attachment.name,
      type: attachment.type,
      size: part.size,
    });
  }
  return {
    value,
    cut: seen.attachments_omitted > 0 || value.length < seen.attachments.length,
  };
}

function summaryFill(summary: Summary, seen: Seen): ProjectedItem["fill"] {
  return [
    ["from", projectAddresses(seen.from)],
    ["mailbox_ids", summary.mailbox_ids],
    ["preview", summary.preview],
  ];
}

function readFill(
  read: ReadData,
  seen: Seen,
  attachments: ProjectedAttachment[],
): ProjectedItem["fill"] {
  return [
    ["from", projectAddresses(seen.from)],
    ["mailbox_ids", read.mailbox_ids],
    ["to", projectAddresses(seen.to)],
    ["cc", projectAddresses(seen.cc)],
    ["bcc", projectAddresses(seen.bcc)],
    ["reply_to", projectAddresses(seen.reply_to)],
    ["sender", projectAddresses(seen.sender)],
    ["sent_at", read.sent_at],
    ["size", read.size],
    ["preview", read.preview],
    ["keywords", read.keywords],
    ["attachments", attachments],
  ];
}

function projected(
  core: Entries,
  fill: ProjectedItem["fill"],
  cut: CutName[],
  body?: string,
): ProjectedItem {
  const item: ProjectedItem = { core, fill, cut };
  return body === undefined ? item : { ...item, body };
}

/** A `mail_list` item: the summary core, held_back when held, then `cut`. */
export function projectListItem(
  summary: Summary,
  classified: Classification,
  heldBack = false,
): ProjectedItem {
  const seen = classified.seen;
  const entries = summaryEntries(summary, classified);
  const cuts = orderedCuts([...entries.cuts, ...omittedCuts(seen, SUMMARY_ADDRESS_LISTS)]);
  const core: Entries = [...entries.core];
  if (heldBack) {
    core.push(["held_back", true]);
  }
  core.push(["cut", cuts]);
  return projected(core, summaryFill(summary, seen), cuts);
}

/**
 * A `mail_thread` entry: in the store it is a list item with `in_store`, else id
 * only. `classified` is undefined only for an `in_store: false` entry.
 */
export function projectThreadItem(
  entry: ThreadItem,
  classified: Classification | undefined,
): ProjectedItem {
  if (!entry.in_store) {
    return {
      core: [
        ["id", entry.id],
        ["in_store", false],
      ],
      fill: [],
      cut: [],
    };
  }
  if (classified === undefined) {
    throw new Error("an in-store thread entry needs its classification");
  }
  const seen = classified.seen;
  const entries = summaryEntries(entry, classified);
  const cuts = orderedCuts([...entries.cuts, ...omittedCuts(seen, SUMMARY_ADDRESS_LISTS)]);
  return projected(
    [...entries.core, ["in_store", true], ["cut", cuts]],
    summaryFill(entry, seen),
    cuts,
  );
}

/** What a read item shows before its tool adds its own core fields. */
interface ReadParts {
  readonly core: Entries;
  readonly flags: Entries;
  readonly fill: ProjectedItem["fill"];
  readonly body: string;
  readonly cut: CutName[];
}

/**
 * The parts `mail_new` and `mail_read` share: the summary core, the body flags,
 * the fill and the window's body cut to `maxBytes` raw bytes, and the cut names
 * (design § Jev's window).
 */
function readParts(read: ReadData, classified: Classification, maxBytes: number): ReadParts {
  const seen = classified.seen;
  const entries = summaryEntries(read, classified);
  const body = seenBody(seen, maxBytes);
  const attachments = projectAttachments(read, seen);
  const cuts: CutName[] = [...entries.cuts, ...omittedCuts(seen, READ_ADDRESS_LISTS)];
  if (attachments.cut) {
    cuts.push("attachments");
  }
  return {
    core: entries.core,
    flags: bodyFlagEntries(readBodyFlags(read.bodies), seen, body.cut),
    fill: readFill(read, seen, attachments.value),
    body: body.body,
    cut: orderedCuts(cuts),
  };
}

/** A `mail_new` item: summary core, held_back when held, body flags, `cut`; no account_id. */
export function projectNew(
  read: ReadData,
  classified: Classification,
  maxBytes: number,
  heldBack = false,
): ProjectedItem {
  const parts = readParts(read, classified, maxBytes);
  const core: Entries = [...parts.core];
  if (heldBack) {
    core.push(["held_back", true]);
  }
  core.push(...parts.flags, ["cut", parts.cut]);
  return projected(core, parts.fill, parts.cut, parts.body);
}

/** A `mail_read` item: summary core, body flags, account_id, `cut`. */
export function projectRead(
  read: ReadData,
  classified: Classification,
  maxBytes: number,
): ProjectedItem {
  const parts = readParts(read, classified, maxBytes);
  return projected(
    [...parts.core, ...parts.flags, ["account_id", read.provenance.account_id], ["cut", parts.cut]],
    parts.fill,
    parts.cut,
    parts.body,
  );
}

// --------------------------------------------- the pre-filter and withheld items

/** `jev`'s bound in rendered bytes (design § Rendering). */
export const JEV_MAX_BYTES = 288;
/** At most this many distinct sender domains in a withheld item's fill. */
export const SENDER_DOMAINS_MAX = 10;
/** A sender domain over this many raw UTF-8 bytes contributes nothing. */
export const SENDER_DOMAIN_MAX_BYTES = 253;

/**
 * The distinct sender domains of `from`: the text after the last `@` of each
 * address, lowercased, deduplicated in first-appearance order, at most
 * `SENDER_DOMAINS_MAX` (design § The pre-filter). An address with no `@`, an empty
 * domain or a domain over `SENDER_DOMAIN_MAX_BYTES` raw bytes contributes nothing.
 */
export function senderDomains(from: readonly Address[]): string[] {
  const domains: string[] = [];
  for (const address of from) {
    const at = address.email.lastIndexOf("@");
    const domain = at === -1 ? "" : address.email.slice(at + 1);
    if (domain === "" || Buffer.byteLength(domain, "utf8") > SENDER_DOMAIN_MAX_BYTES) {
      continue;
    }
    const lowercased = domain.toLowerCase();
    if (domains.length < SENDER_DOMAINS_MAX && !domains.includes(lowercased)) {
      domains.push(lowercased);
    }
  }
  return domains;
}

/** A `withheld` value as it renders: reason and detail, and the score for a hostile one. */
function withheldField(withheld: Withheld): Record<string, unknown> {
  if (withheld.reason === "hostile") {
    return { reason: withheld.reason, detail: withheld.detail, score: roundTo2(withheld.score) };
  }
  return { reason: withheld.reason, detail: withheld.detail };
}

/**
 * A withheld item: the core, the two fill fields, and none of the sender's text
 * (design § The pre-filter). Every field is named here, so nothing of the envelope
 * reaches the agent through this projection.
 */
export function projectWithheld(
  item: Summary | ReadData,
  outcome: ClassifyOutcome,
  withheld: Withheld,
  flags: { heldBack?: boolean; inStore?: boolean; size?: number } = {},
): ProjectedItem {
  const jev = jevField(outcome);
  const cuts: CutName[] = jev.cut ? ["jev"] : [];
  const core: Entries = [
    ["id", item.id],
    ["thread_id", item.thread_id],
    ["received_at", normaliseReceivedAt(item.received_at)],
  ];
  if (flags.size !== undefined) {
    core.push(["size", flags.size]);
  }
  core.push(
    ["is_seen", item.is_seen],
    ["is_flagged", item.is_flagged],
    ["has_attachment", item.has_attachment],
    ["jev", jev.value],
    ["withheld", withheldField(withheld)],
  );
  if (flags.heldBack === true) {
    core.push(["held_back", true]);
  }
  if (flags.inStore !== undefined) {
    core.push(["in_store", flags.inStore]);
  }
  core.push(["cut", cuts]);
  return {
    core,
    fill: [
      ["sender_domains", senderDomains(item.from)],
      ["mailbox_ids", item.mailbox_ids],
    ],
    cut: cuts,
  };
}

/** A `mail_mailboxes` entry: the seven contract fields, in order. */
export function projectMailbox(mailbox: Mailbox): ProjectedMailbox {
  return {
    id: mailbox.id,
    name: mailbox.name,
    parent_id: mailbox.parent_id,
    role: mailbox.role,
    sort_order: mailbox.sort_order,
    total_emails: mailbox.total_emails,
    unread_emails: mailbox.unread_emails,
  };
}
