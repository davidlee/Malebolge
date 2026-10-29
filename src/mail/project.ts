// The mail projection: a validated envelope to the item the renderer fills.
//
// A projection copies only the fields the contract names, so a field added to a
// later v1 envelope is neither rendered nor counted (F-39). The only fields it
// ever shortens are `subject` and `message_id`, because a core field cannot be
// left out; everything else is shown whole or named in `cut`.

import { cutRendered } from "../untrusted-block.ts";
import {
  isRfc3339,
  type Address,
  type Attachment,
  type Body,
  type Mailbox,
  type ReadData,
  type Summary,
  type ThreadItem,
} from "./source.ts";

/** The fixed set of cut names, in the order a `cut` list names them. */
export const CUT_ORDER = [
  "subject",
  "message_id",
  "from",
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
  "in_reply_to",
  "references",
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
/** At most this many `message_id` entries are shown. */
export const MESSAGE_ID_MAX_ENTRIES = 5;
/** A cut `message_id` entry is at most this many rendered bytes, `…` included. */
export const MESSAGE_ID_ENTRY_MAX_BYTES = 256;

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

/** The one body and one flag set the parts of a message fold into. */
export interface FoldedBody {
  readonly body: string;
  readonly is_truncated: boolean;
  readonly is_encoding_problem: boolean;
  readonly conversion_failed: boolean;
  readonly truncated_by: readonly TruncationReason[];
}

/** The parts' texts joined by a blank line; flags ORed; distinct reasons in order. */
export function foldBodies(bodies: readonly Body[]): FoldedBody {
  return {
    body: bodies.map((part) => part.text).join("\n\n"),
    is_truncated: bodies.some((part) => part.is_truncated),
    is_encoding_problem: bodies.some((part) => part.is_encoding_problem),
    conversion_failed: bodies.some((part) => part.conversion_failed),
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

function capMessageIds(ids: readonly string[]): { value: string[]; cut: boolean } {
  const kept = ids.slice(0, MESSAGE_ID_MAX_ENTRIES);
  const capped = kept.map((id) => cutRendered(id, MESSAGE_ID_ENTRY_MAX_BYTES, ELLIPSIS));
  return {
    value: capped.map((entry) => entry.text),
    cut: ids.length > kept.length || capped.some((entry) => entry.cut),
  };
}

function summaryEntries(summary: Summary): { core: Entries; cuts: CutName[] } {
  const subject = capSubject(summary.subject);
  return {
    core: [
      ["id", summary.id],
      ["thread_id", summary.thread_id],
      ["received_at", normaliseReceivedAt(summary.received_at)],
      ["subject", subject.value],
      ["is_seen", summary.is_seen],
      ["is_flagged", summary.is_flagged],
      ["has_attachment", summary.has_attachment],
    ],
    cuts: subject.cuts,
  };
}

function bodyFlagEntries(folded: FoldedBody, outputTruncated: boolean): Entries {
  return [
    ["is_truncated", folded.is_truncated],
    ["is_encoding_problem", folded.is_encoding_problem],
    ["conversion_failed", folded.conversion_failed],
    ["truncated_by", folded.truncated_by],
    ["output_truncated", outputTruncated],
  ];
}

function projectAddresses(addresses: readonly Address[]): { name: string | null; email: string }[] {
  return addresses.map((address) => ({ name: address.name, email: address.email }));
}

function projectAttachments(attachments: readonly Attachment[]): ProjectedAttachment[] {
  return attachments.map((attachment) => ({
    part_id: attachment.part_id,
    blob_id: attachment.blob_id,
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    disposition: attachment.disposition,
    cid: attachment.cid,
  }));
}

interface ProjectedAttachment {
  readonly part_id: string;
  readonly blob_id: string;
  readonly name: string | null;
  readonly type: string;
  readonly size: number;
  readonly disposition: string | null;
  readonly cid: string | null;
}

function summaryFill(summary: Summary): ProjectedItem["fill"] {
  return [
    ["from", projectAddresses(summary.from)],
    ["mailbox_ids", summary.mailbox_ids],
    ["preview", summary.preview],
  ];
}

function readFill(read: ReadData): ProjectedItem["fill"] {
  return [
    ["from", projectAddresses(read.from)],
    ["mailbox_ids", read.mailbox_ids],
    ["to", projectAddresses(read.to)],
    ["cc", projectAddresses(read.cc)],
    ["bcc", projectAddresses(read.bcc)],
    ["reply_to", projectAddresses(read.reply_to)],
    ["sender", projectAddresses(read.sender)],
    ["sent_at", read.sent_at],
    ["size", read.size],
    ["preview", read.preview],
    ["keywords", read.keywords],
    ["in_reply_to", read.in_reply_to],
    ["references", read.references],
    ["attachments", projectAttachments(read.attachments)],
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
export function projectListItem(summary: Summary, heldBack = false): ProjectedItem {
  const entries = summaryEntries(summary);
  const core: Entries = [...entries.core];
  if (heldBack) {
    core.push(["held_back", true]);
  }
  core.push(["cut", entries.cuts]);
  return projected(core, summaryFill(summary), entries.cuts);
}

/** A `mail_thread` entry: in the store it is a list item with `in_store`, else id only. */
export function projectThreadItem(entry: ThreadItem): ProjectedItem {
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
  const entries = summaryEntries(entry);
  return projected(
    [...entries.core, ["in_store", true], ["cut", entries.cuts]],
    summaryFill(entry),
    entries.cuts,
  );
}

/** A `mail_new` item: summary core, body flags, `cut`; no message_id or account_id. */
export function projectNew(read: ReadData, heldBack = false): ProjectedItem {
  const entries = summaryEntries(read);
  const folded = foldBodies(read.bodies);
  const core: Entries = [...entries.core];
  if (heldBack) {
    core.push(["held_back", true]);
  }
  core.push(...bodyFlagEntries(folded, read.output_truncated), ["cut", entries.cuts]);
  return projected(core, readFill(read), entries.cuts, folded.body);
}

/** A `mail_read` item: summary core, body flags, message_id, account_id, `cut`. */
export function projectRead(read: ReadData): ProjectedItem {
  const entries = summaryEntries(read);
  const folded = foldBodies(read.bodies);
  const messageIds = capMessageIds(read.message_id);
  const cuts: CutName[] = [...entries.cuts];
  if (messageIds.cut) {
    cuts.push("message_id");
  }
  return projected(
    [
      ...entries.core,
      ...bodyFlagEntries(folded, read.output_truncated),
      ["message_id", messageIds.value],
      ["account_id", read.provenance.account_id],
      ["cut", orderedCuts(cuts)],
    ],
    readFill(read),
    orderedCuts(cuts),
    folded.body,
  );
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
