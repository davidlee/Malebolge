// The five mail tools (design sec-4): bounds clamped, inputs refused before any
// port call, the cursor computed from the validated envelopes, and one text
// result each. No I/O here: the MailSource and "now" are injected.

import type { Context } from "@earendil-works/chord/context";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { isRecord, type JsonRecord } from "../json.ts";
import { bounded, type Clamp, type Range, report } from "../ranges.ts";
import {
  projectListItem,
  projectMailbox,
  projectNew,
  projectRead,
  projectThreadItem,
} from "./project.ts";
import { renderMailboxes, renderPage } from "./render.ts";
import {
  isCanonicalCursor,
  isJmapId,
  isUtcDate,
  type MailFilters,
  type MailSource,
  MailSourceError,
  type ReadAfterQuery,
  type ReadData,
} from "./source.ts";

// ------------------------------------------------------- ranges and clamps

export const NEW_LIMIT: Range = { min: 1, max: 20, default: 10 };
export const NEW_MAX_BYTES: Range = { min: 512, max: 8192, default: 4096 };
export const READ_MAX_BYTES: Range = { min: 1024, max: 32768, default: 16384 };
export const THREAD_LIMIT: Range = { min: 1, max: 40, default: 20 };
export const LIST_LIMIT: Range = { min: 1, max: 40, default: 20 };
export const LIST_OFFSET: Range = { min: 0, max: 10000, default: 0 };
/** mail_new's joint clamp: max_bytes <= floor(NEW_JOINT_BYTES / limit). */
export const NEW_JOINT_BYTES = 40 * 1024;
/** Held back: received_at later than now + this. */
export const HELD_BACK_AFTER_MS = 10 * 60 * 1000;
export const FROM_MAX_BYTES = 256;

/**
 * mail_new at limit 1 cannot make progress on an oversize failure: the one
 * message it may ask for is itself over the ceiling.
 */
export const OVERSIZE_AT_LIMIT_1 =
  "screwtape output over 4 MiB at limit 1: the next message cannot be read";

type MailBound = "limit" | "max_bytes" | "offset";

interface NewBounds {
  readonly limit: number;
  readonly maxBytes: number;
  readonly clamps: Clamp<MailBound>[];
}

/** mail_new's two bounds, the joint one applied to the already-clamped limit. */
function newBounds(args: JsonRecord): NewBounds {
  const clamps: Clamp<MailBound>[] = [];
  const limit = bounded(args["limit"], NEW_LIMIT, "limit", clamps);
  const asked = bounded(args["max_bytes"], NEW_MAX_BYTES, "max_bytes", clamps);
  const maxBytes = Math.min(asked, Math.floor(NEW_JOINT_BYTES / limit));
  if (maxBytes !== asked) {
    report(clamps, "max_bytes", maxBytes);
  }
  return { limit, maxBytes, clamps };
}

// ------------------------------------------------------------ validation

/** Bad tool arguments: refused before the port, in a message that never repeats the value. */
export class MailInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailInputError";
  }
}

const CONTROL = /\p{Cc}/u;

function idOf(tool: string, param: string, raw: unknown): string {
  // Not a bare isJmapId call: the Id form allows a leading "-", and screwtape
  // would read such a value as an option (design sec-4 "Inputs").
  if (typeof raw !== "string" || raw.startsWith("-") || !isJmapId(raw)) {
    throw new MailInputError(
      `${tool}: ${param} must be a mail id ([A-Za-z0-9_-], 1 to 255 characters)`,
    );
  }
  return raw;
}

function fromOf(tool: string, raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const ok =
    typeof raw === "string" &&
    Buffer.byteLength(raw, "utf8") <= FROM_MAX_BYTES &&
    !raw.startsWith("-") &&
    !CONTROL.test(raw);
  if (!ok) {
    throw new MailInputError(
      `${tool}: from must be at most ${String(FROM_MAX_BYTES)} bytes, with no control characters and no leading "-"`,
    );
  }
  return raw;
}

function afterOf(raw: unknown): string {
  if (typeof raw !== "string" || !isCanonicalCursor(raw)) {
    throw new MailInputError('mail_new: after must be "" or a cursor from a previous next');
  }
  return raw;
}

function sinceOf(raw: unknown, after: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (after !== "") {
    throw new MailInputError('mail_new: since is only allowed with after ""');
  }
  if (typeof raw !== "string" || !isUtcDate(raw)) {
    throw new MailInputError("mail_new: since must be a date, YYYY-MM-DD");
  }
  return raw;
}

/** The filters given, and only those; each value is checked here. */
function filtersOf(tool: string, args: JsonRecord): MailFilters {
  const filters: MailFilters = {};
  const from = fromOf(tool, args["from"]);
  const unread = args["unread"];
  if (args["mailbox"] !== undefined) {
    filters.mailbox = idOf(tool, "mailbox", args["mailbox"]);
  }
  if (typeof unread === "boolean") {
    filters.unread = unread;
  }
  if (from !== undefined) {
    filters.from = from;
  }
  return filters;
}

// ---------------------------------------------------------------- cursor

export interface PagePosition {
  next: string;
  caughtUp: boolean;
  heldBack: readonly boolean[];
}

/** Whether an envelope arrived so far in the future that it is not passed yet. */
export function isHeldBack(read: ReadData, now: number): boolean {
  return Date.parse(read.received_at) > now + HELD_BACK_AFTER_MS;
}

/**
 * The page's cursor facts, judged on the validated envelopes. `next` stops just
 * before the first held-back message, so a later call sees it again; the rule
 * reads received_at, never the cursor's text.
 */
export function pagePosition(
  page: readonly ReadData[],
  after: string,
  limit: number,
  now: number,
): PagePosition {
  const heldBack = page.map((read) => isHeldBack(read, now));
  const first = heldBack.indexOf(true);
  const last = first === -1 ? page.at(-1) : page[first - 1];
  return {
    next: last?.cursor ?? after,
    caughtUp: page.length < limit || first !== -1,
    heldBack,
  };
}

// ---------------------------------------------------------------- the tools

export interface MailDeps {
  readonly source: MailSource;
  readonly now: () => number;
}

const Id = (description: string): TSchema => Type.String({ description });
const Count = (description: string): TSchema => Type.Integer({ description });

const NEW_PARAMETERS = Type.Object({
  after: Type.String({ description: '"" to start, or the header\'s next' }),
  since: Type.Optional(
    Type.String({
      description: 'A date, YYYY-MM-DD: mail from midnight UTC that day; only with after ""',
    }),
  ),
  limit: Type.Optional(Count("Messages per page (1-20)")),
  max_bytes: Type.Optional(Count("Bytes per body (512-8192)")),
  mailbox: Type.Optional(Id("A mailbox id from mail_mailboxes")),
  unread: Type.Optional(Type.Boolean({ description: "Only unread messages" })),
  from: Type.Optional(Type.String({ description: "Only messages from this sender" })),
});

const READ_PARAMETERS = Type.Object({
  id: Id("The message id"),
  max_bytes: Type.Optional(Count("Bytes of body (1024-32768)")),
});

const THREAD_PARAMETERS = Type.Object({
  id: Id("The thread id"),
  limit: Type.Optional(Count("Entries to show (1-40)")),
});

const LIST_PARAMETERS = Type.Object({
  limit: Type.Optional(Count("Messages per page (1-40)")),
  offset: Type.Optional(Count("Messages to skip (0-10000)")),
  mailbox: Type.Optional(Id("A mailbox id from mail_mailboxes")),
  unread: Type.Optional(Type.Boolean({ description: "Only unread messages" })),
  from: Type.Optional(Type.String({ description: "Only messages from this sender" })),
});

const NEW_DESCRIPTION =
  'Read new mail in arrival order, from a cursor. Pass after "" to start (with since, a date YYYY-MM-DD, to skip mail before midnight UTC that day), then pass the header\'s next back as after. caught_up: true means nothing more is waiting now. A message dated more than 10 minutes ahead is shown with held_back: true and not passed; it returns on later calls. limit 1-20 (default 10); max_bytes 512-8192 (default 4096, at most 40960 / limit) bounds each body. Filters: mailbox (an id from mail_mailboxes), unread, from. If a call fails as over 4 MiB, retry with limit 1.';

const READ_DESCRIPTION =
  "Read one message by id: its headers, attachments list and body. max_bytes 1024-32768 (default 16384) bounds the body.";

const THREAD_DESCRIPTION =
  "Show a thread by its thread_id: the last limit entries in thread order (1-40, default 20); the header gives total and whether older entries were left out. If a call fails as over 4 MiB, retry with limit 1.";

const LIST_DESCRIPTION =
  "List messages newest first, a page at a time: limit 1-40 (default 20), offset 0-10000. Offset paging shifts when new mail syncs between calls, so a page can repeat or skip messages; use mail_new to follow new mail. Filters: mailbox (an id from mail_mailboxes), unread, from. If a call fails as over 4 MiB, retry with limit 1.";

const MAILBOXES_DESCRIPTION =
  "List the mailboxes: their ids (for the mailbox filter), names, roles and message counts. The counts are the mail server's; the other tools read a local mirror of a configured window of mail, so a mailbox can count messages they cannot reach.";

interface MailToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly text: (args: JsonRecord, context: Context) => Promise<string>;
}

/**
 * One mail tool. The model's arguments are read as untrusted JSON, so a
 * MailInputError or MailSourceError becomes the error result the model sees,
 * while anything else (an abort, a bug) is thrown.
 */
function mailTool(spec: MailToolSpec): ToolRegistration {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    // Reading mail changes nothing: an interrupted call reruns after a restart.
    replay: "safe",
    execute: async (raw, _api, context) => {
      try {
        if (!isRecord(raw)) {
          throw new MailInputError(`${spec.name}: arguments must be an object`);
        }
        const text = await spec.text(raw, context);
        return { output: [{ type: "text", text }], isError: false };
      } catch (error) {
        if (error instanceof MailInputError || error instanceof MailSourceError) {
          return { output: [{ type: "text", text: error.message }], isError: true };
        }
        throw error;
      }
    },
  });
}

/** readAfter, with the one failure that reading at limit 1 cannot get past. */
async function readAfter(
  source: MailSource,
  query: ReadAfterQuery,
  limit: number,
): Promise<ReadData[]> {
  try {
    return await source.readAfter(query);
  } catch (error) {
    if (limit === 1 && error instanceof MailSourceError && error.failure === "oversize") {
      throw new MailSourceError("oversize", OVERSIZE_AT_LIMIT_1);
    }
    throw error;
  }
}

async function newText(deps: MailDeps, args: JsonRecord, context: Context): Promise<string> {
  const after = afterOf(args["after"]);
  const since = sinceOf(args["since"], after);
  const { limit, maxBytes, clamps } = newBounds(args);
  const query: ReadAfterQuery = {
    after,
    limit,
    maxBytes,
    filters: filtersOf("mail_new", args),
    signal: context.abortSignal,
  };
  if (since !== undefined) {
    query.since = since;
  }
  const page = await readAfter(deps.source, query, limit);
  const position = pagePosition(page, after, limit, deps.now());
  const heldBack = position.heldBack.filter((held) => held).length;
  return renderPage(
    {
      tool: "mail_new",
      heldBack,
      next: position.next,
      caughtUp: position.caughtUp,
      clamps,
      knownGaps: true,
    },
    page.map((read, index) => projectNew(read, position.heldBack[index] === true)),
    limit,
  );
}

async function readText(deps: MailDeps, args: JsonRecord, context: Context): Promise<string> {
  const clamps: Clamp<MailBound>[] = [];
  const id = idOf("mail_read", "id", args["id"]);
  const maxBytes = bounded(args["max_bytes"], READ_MAX_BYTES, "max_bytes", clamps);
  const read = await deps.source.read({ id, maxBytes, signal: context.abortSignal });
  return renderPage({ tool: "mail_read", clamps }, [projectRead(read)], 1);
}

async function threadText(deps: MailDeps, args: JsonRecord, context: Context): Promise<string> {
  const clamps: Clamp<MailBound>[] = [];
  const id = idOf("mail_thread", "id", args["id"]);
  const limit = bounded(args["limit"], THREAD_LIMIT, "limit", clamps);
  const thread = await deps.source.thread({ id, limit, signal: context.abortSignal });
  const { total, truncated } = thread;
  return renderPage(
    { tool: "mail_thread", clamps, thread: { total, truncated } },
    thread.items.map((item) => projectThreadItem(item)),
    limit,
  );
}

async function listText(deps: MailDeps, args: JsonRecord, context: Context): Promise<string> {
  const clamps: Clamp<MailBound>[] = [];
  const limit = bounded(args["limit"], LIST_LIMIT, "limit", clamps);
  const offset = bounded(args["offset"], LIST_OFFSET, "offset", clamps);
  const page = await deps.source.list({
    limit,
    offset,
    filters: filtersOf("mail_list", args),
    signal: context.abortSignal,
  });
  return renderPage(
    { tool: "mail_list", clamps },
    page.items.map((item) => projectListItem(item)),
    limit,
  );
}

async function mailboxesText(deps: MailDeps, context: Context): Promise<string> {
  const page = await deps.source.mailboxes(context.abortSignal);
  return renderMailboxes(page.items.map((mailbox) => projectMailbox(mailbox)));
}

/** The mail tools, in the order the design's table gives them. */
export function mailTools(deps: MailDeps): ToolRegistration[] {
  return [
    mailTool({
      name: "mail_new",
      description: NEW_DESCRIPTION,
      parameters: NEW_PARAMETERS,
      text: async (args, context) => newText(deps, args, context),
    }),
    mailTool({
      name: "mail_read",
      description: READ_DESCRIPTION,
      parameters: READ_PARAMETERS,
      text: async (args, context) => readText(deps, args, context),
    }),
    mailTool({
      name: "mail_thread",
      description: THREAD_DESCRIPTION,
      parameters: THREAD_PARAMETERS,
      text: async (args, context) => threadText(deps, args, context),
    }),
    mailTool({
      name: "mail_list",
      description: LIST_DESCRIPTION,
      parameters: LIST_PARAMETERS,
      text: async (args, context) => listText(deps, args, context),
    }),
    mailTool({
      name: "mail_mailboxes",
      description: MAILBOXES_DESCRIPTION,
      parameters: Type.Object({}),
      text: async (_args, context) => mailboxesText(deps, context),
    }),
  ];
}
