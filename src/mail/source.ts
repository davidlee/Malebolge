// The mail port: the v1 contract schemas (extra fields allowed, so a later
// addition is neither refused nor copied), the one canonical-cursor check, and
// the MailSource interface. Nothing here does I/O.

import { Type, type Static } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

/** The JMAP Id form (RFC 8621): 1 to 255 of A-Z a-z 0-9 _ -. */
export const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;

/** Whether `value` is a JMAP Id, the only id form a store id can take. */
export function isJmapId(value: string): boolean {
  return JMAP_ID.test(value);
}

const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;

/** A canonical cursor: `<ms>:<id>`, the id in the JMAP Id form (so it holds no `:`). */
const CANONICAL_CURSOR = /^(0|-?[1-9][0-9]*):(.+)$/;

function isInt64(value: bigint): boolean {
  return value >= INT64_MIN && value <= INT64_MAX;
}

/**
 * EX-1: the one canonical-cursor check: `""`, or `<ms>:<id>` with `<ms>` a
 * canonical decimal int64 and `<id>` a JMAP Id.
 */
export function isCanonicalCursor(value: string): boolean {
  if (value === "") {
    return true;
  }
  const match = CANONICAL_CURSOR.exec(value);
  if (match === null) {
    return false;
  }
  const [, ms, id] = match;
  if (ms === undefined || id === undefined || !isJmapId(id)) {
    return false;
  }
  return isInt64(BigInt(ms));
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Whether `value` is an RFC 3339 date-time the host can parse. */
export function isRfc3339(value: string): boolean {
  return RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

// ---------------------------------------------------------------- schemas

const Id = Type.String({ pattern: JMAP_ID.source, minLength: 1, maxLength: 255 });
const Cursor = Type.Refine(Type.String(), isCanonicalCursor);
const Rfc3339 = Type.Refine(Type.String(), isRfc3339);
const NullableString = Type.Union([Type.String(), Type.Null()]);

export const AddressSchema = Type.Object({
  name: NullableString,
  email: Type.String(),
});
export type Address = Static<typeof AddressSchema>;

export const MailboxSchema = Type.Object({
  id: Id,
  name: Type.String(),
  parent_id: Type.Union([Id, Type.Null()]),
  role: NullableString,
  sort_order: Type.Integer(),
  total_emails: Type.Integer(),
  unread_emails: Type.Integer(),
});
export type Mailbox = Static<typeof MailboxSchema>;

const summaryProperties = {
  id: Id,
  thread_id: Id,
  received_at: Rfc3339,
  subject: NullableString,
  from: Type.Array(AddressSchema),
  preview: Type.String(),
  is_seen: Type.Boolean(),
  is_flagged: Type.Boolean(),
  mailbox_ids: Type.Array(Id),
  has_attachment: Type.Boolean(),
  cursor: Cursor,
};

export const SummarySchema = Type.Object(summaryProperties);
export type Summary = Static<typeof SummarySchema>;

export const BodySchema = Type.Object({
  part_id: Type.String(),
  source_type: Type.Union([Type.Literal("text"), Type.Literal("html")]),
  text: Type.String(),
  is_truncated: Type.Boolean(),
  truncated_by: Type.Union([Type.Literal("server"), Type.Literal("message_limit"), Type.Null()]),
  is_encoding_problem: Type.Boolean(),
  conversion_failed: Type.Boolean(),
});
export type Body = Static<typeof BodySchema>;

export const AttachmentSchema = Type.Object({
  part_id: Type.String(),
  blob_id: Id,
  name: NullableString,
  type: Type.String(),
  size: Type.Integer(),
  disposition: NullableString,
  cid: NullableString,
});
export type Attachment = Static<typeof AttachmentSchema>;

export const ReadSchema = Type.Object({
  ...summaryProperties,
  sent_at: NullableString,
  size: Type.Integer(),
  keywords: Type.Array(Type.String()),
  sender: Type.Array(AddressSchema),
  to: Type.Array(AddressSchema),
  cc: Type.Array(AddressSchema),
  bcc: Type.Array(AddressSchema),
  reply_to: Type.Array(AddressSchema),
  message_id: Type.Array(Type.String()),
  in_reply_to: Type.Array(Type.String()),
  references: Type.Array(Type.String()),
  bodies: Type.Array(BodySchema),
  attachments: Type.Array(AttachmentSchema),
  provenance: Type.Object({ account_id: Id, email_state: Type.String() }),
  output_truncated: Type.Boolean(),
});
export type ReadData = Static<typeof ReadSchema>;

const listProperties = {
  limit: Type.Integer(),
  items: Type.Array(SummarySchema),
};

/** A list page carries exactly one of `offset` and `after` (contract § list). */
export const ListSchema = Type.Refine(
  Type.Union([
    Type.Object({ ...listProperties, offset: Type.Integer() }),
    Type.Object({ ...listProperties, after: Cursor }),
  ]),
  (page) => !("offset" in page && "after" in page),
);
export type ListData = Static<typeof ListSchema>;

const ThreadInStoreSchema = Type.Object({
  ...summaryProperties,
  in_store: Type.Literal(true),
});
const ThreadAbsentSchema = Type.Object({
  id: Id,
  in_store: Type.Literal(false),
});
export const ThreadItemSchema = Type.Union([ThreadInStoreSchema, ThreadAbsentSchema]);
export type ThreadItem = Static<typeof ThreadItemSchema>;

export const ThreadSchema = Type.Object({
  id: Id,
  total: Type.Integer(),
  truncated: Type.Boolean(),
  items: Type.Array(ThreadItemSchema),
});
export type ThreadData = Static<typeof ThreadSchema>;

export const MailboxesSchema = Type.Object({
  items: Type.Array(MailboxSchema),
});
export type MailboxesData = Static<typeof MailboxesSchema>;

/** The data schema of each envelope kind the contract defines. */
export const KIND_SCHEMAS = {
  mailboxes: MailboxesSchema,
  list: ListSchema,
  read: ReadSchema,
  thread: ThreadSchema,
};

export type MailKind = keyof typeof KIND_SCHEMAS;

export type DataOf<K extends MailKind> = Static<(typeof KIND_SCHEMAS)[K]>;

/**
 * The validated data of an envelope of `kind`, or undefined when it is not
 * contract-valid: the adapter fails closed and says `contract violation`.
 */
export function checkData<K extends MailKind>(kind: K, data: unknown): DataOf<K> | undefined {
  const schema = KIND_SCHEMAS[kind];
  if (!Value.Check(schema, data)) {
    return undefined;
  }
  return data;
}

// -------------------------------------------------------------------- port

/** The filters both listing verbs take; each value is already validated. */
export interface MailFilters {
  mailbox?: string;
  unread?: boolean;
  from?: string;
}

export interface ListQuery {
  limit: number;
  offset: number;
  filters: MailFilters;
  signal?: AbortSignal;
}

export interface ReadQuery {
  id: string;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface ReadAfterQuery {
  after: string;
  limit: number;
  maxBytes: number;
  since?: string;
  filters: MailFilters;
  signal?: AbortSignal;
}

export interface ThreadQuery {
  id: string;
  limit: number;
  signal?: AbortSignal;
}

/** The mail tools' port (DEC-026): queries carry validated, clamped values. */
export interface MailSource {
  mailboxes(signal?: AbortSignal): Promise<MailboxesData>;
  list(query: ListQuery): Promise<ListData>;
  read(query: ReadQuery): Promise<ReadData>;
  readAfter(query: ReadAfterQuery): Promise<ReadData[]>;
  thread(query: ThreadQuery): Promise<ThreadData>;
}

/** Why a MailSource call failed. */
export type MailFailure = "usage" | "failed" | "timeout" | "spawn" | "contract" | "oversize";

/** A MailSource call that failed; `message` is safe to show the model (never raw stderr). */
export class MailSourceError extends Error {
  readonly failure: MailFailure;

  constructor(failure: MailFailure, message: string) {
    super(message);
    this.name = "MailSourceError";
    this.failure = failure;
  }
}
