// VT-3: the projection, from a validated envelope to a ProjectedItem.

import { describe, expect, it } from "vitest";
import {
  CUT_ORDER,
  jevField,
  normaliseReceivedAt,
  type ProjectedItem,
  projectListItem,
  projectMailbox,
  projectNew,
  projectRead,
  readBodyFlags,
  projectThreadItem,
  projectWithheld,
  SENDER_DOMAIN_MAX_BYTES,
  SENDER_DOMAINS_MAX,
  senderDomains,
  SUBJECT_MAX_BYTES,
} from "../../src/mail/project.ts";
import { type Withheld, WITHHOLD_POLICY } from "../../src/mail/policy.ts";
import type {
  Address,
  Classification,
  ClassifyOutcome,
  ReadData,
  Seen,
  Summary,
  ThreadItem,
} from "../../src/mail/source.ts";
import {
  ANY_MAX_BYTES,
  absentThreadItem,
  addressOf,
  attachmentOf,
  bodyPartOf,
  bytesOf,
  classificationOf,
  classifiedAs,
  type Envelope,
  fixtureFiles,
  inStoreThreadItem,
  loadEnvelopes,
  mailboxOf,
  mustCheck,
  readOf,
  renderedBytes,
  seenOf,
  summaryOf,
  withExtraFields,
} from "./mail-fixtures.ts";

const coreOf = (item: ProjectedItem): Record<string, unknown> => Object.fromEntries(item.core);
const coreKeys = (item: ProjectedItem): string[] => item.core.map(([key]) => key);
const fillKeys = (item: ProjectedItem): string[] => item.fill.map(([key]) => key);

function textAt(item: ProjectedItem, key: string): string {
  const value = coreOf(item)[key];
  if (typeof value !== "string") {
    throw new Error(`${key} is not a string`);
  }
  return value;
}

function listAt(item: ProjectedItem, key: string): unknown[] {
  const value = coreOf(item)[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} is not a list`);
  }
  return value;
}

const SUMMARY_CORE = [
  "id",
  "thread_id",
  "received_at",
  "subject",
  "is_seen",
  "is_flagged",
  "has_attachment",
  "jev",
];
const BODY_FLAGS = [
  "is_truncated",
  "is_encoding_problem",
  "conversion_failed",
  "truncated_by",
  "output_truncated",
];
const READ_FILL = [
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
  "attachments",
];

describe("limits", () => {
  it("are the sec-4 figures", () => {
    expect(SUBJECT_MAX_BYTES).toBe(200);
    expect(CUT_ORDER).toEqual([
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
    ]);
  });

  it("names no field the projection never shows", () => {
    const names: readonly string[] = CUT_ORDER;
    for (const never of ["message_id", "in_reply_to", "references", "cid", "disposition"]) {
      expect(names).not.toContain(never);
    }
  });
});

describe("subject", () => {
  it("a 300-byte subject is shortened to at most 200 rendered bytes, ends in an ellipsis and is named in cut", () => {
    const summary = summaryOf({ subject: "s".repeat(300) });
    const item = projectListItem(summary, classifiedAs(summary));
    const subject = textAt(item, "subject");
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.startsWith("sss")).toBe(true);
    expect(renderedBytes(subject)).toBe(200); // the longest prefix that fits: not over-cut
    expect(listAt(item, "cut")).toEqual(["subject"]);
    expect(item.cut).toEqual(["subject"]);
  });

  it("is measured rendered, not raw: 300 `<` (six bytes each) still ends within 200", () => {
    const summary = summaryOf({ subject: "<".repeat(300) });
    const item = projectListItem(summary, classifiedAs(summary));
    const subject = textAt(item, "subject");
    expect(subject.endsWith("…")).toBe(true);
    expect(renderedBytes(subject)).toBeLessThanOrEqual(200);
    expect(renderedBytes(subject)).toBeGreaterThan(200 - 6);
    expect(item.cut).toContain("subject");
  });

  it("is cut at a code-point boundary, never inside an astral character", () => {
    for (const unit of ["😀", "é", "€"]) {
      const summary = summaryOf({ subject: unit.repeat(120) });
      const subject = textAt(projectListItem(summary, classifiedAs(summary)), "subject");
      expect(subject.isWellFormed()).toBe(true);
      expect(renderedBytes(subject)).toBeLessThanOrEqual(200);
    }
  });

  it("is kept as received at exactly 200 rendered bytes, shortened one byte over", () => {
    const fitting = summaryOf({ subject: "s".repeat(198) });
    const fits = projectListItem(fitting, classifiedAs(fitting));
    expect(textAt(fits, "subject")).toBe("s".repeat(198));
    expect(fits.cut).toEqual([]);
    const overflowing = summaryOf({ subject: "s".repeat(199) });
    const over = projectListItem(overflowing, classifiedAs(overflowing));
    expect(textAt(over, "subject")).not.toBe("s".repeat(199));
    expect(over.cut).toEqual(["subject"]);
  });

  it("stays null when absent, and no cut is named", () => {
    const summary = summaryOf({ subject: null });
    const item = projectListItem(summary, classifiedAs(summary));
    expect(coreOf(item)["subject"]).toBeNull();
    expect(item.cut).toEqual([]);
  });
});

describe("bodies", () => {
  const alpha = bodyPartOf({
    part_id: "1",
    text: "alpha",
    is_truncated: true,
    truncated_by: "message_limit",
  });
  const beta = bodyPartOf({ part_id: "2", text: "beta" });
  const empty = bodyPartOf({
    part_id: "3",
    text: "",
    conversion_failed: true,
    source_type: "html",
  });
  const delta = bodyPartOf({
    part_id: "4",
    text: "delta",
    is_encoding_problem: true,
    is_truncated: true,
    truncated_by: "server",
  });
  const eps = bodyPartOf({
    part_id: "5",
    text: "eps",
    is_truncated: true,
    truncated_by: "message_limit",
  });
  const parts = [alpha, beta, empty, delta, eps];

  it("ORs the read's encoding problem and lists its distinct reasons in order", () => {
    expect(readBodyFlags(parts)).toEqual({
      is_encoding_problem: true,
      truncated_by: ["server", "message_limit"], // distinct, in that order, wherever they occur
    });
  });

  it("lists only the reasons that occur, and none when nothing was truncated", () => {
    expect(readBodyFlags([alpha, eps]).truncated_by).toEqual(["message_limit"]);
    expect(readBodyFlags([bodyPartOf(), bodyPartOf()])).toEqual({
      is_encoding_problem: false,
      truncated_by: [],
    });
    expect(readBodyFlags([])).toEqual({ is_encoding_problem: false, truncated_by: [] });
  });

  it("projects to one body (last, outside the fill) and one flag set in the core", () => {
    // The read claims a cut of its own; only malebolge's max_bytes cut sets the flag now.
    const read = readOf({ bodies: parts, output_truncated: true });
    const item = projectRead(read, classifiedAs(read), ANY_MAX_BYTES);
    expect(item.body).toBe("alpha\n\nbeta\n\n\n\ndelta\n\neps");
    const core = coreOf(item);
    expect(core["is_truncated"]).toBe(true);
    expect(core["is_encoding_problem"]).toBe(true);
    expect(core["conversion_failed"]).toBe(true);
    expect(core["truncated_by"]).toEqual(["server", "message_limit"]);
    expect(core["output_truncated"]).toBe(false); // the body fits: nothing was cut
    for (const flag of BODY_FLAGS) {
      expect(coreKeys(item).filter((key) => key === flag)).toHaveLength(1);
    }
    expect(coreKeys(item)).not.toContain("bodies");
    expect(coreKeys(item)).not.toContain("body");
    expect(fillKeys(item)).not.toContain("bodies");
    expect(fillKeys(item)).not.toContain("body");
    expect(JSON.stringify(item)).not.toContain("part_id");
  });

  it("projects the same fold for mail_new", () => {
    const read = readOf({ bodies: parts });
    const item = projectNew(read, classifiedAs(read), ANY_MAX_BYTES);
    expect(item.body).toBe("alpha\n\nbeta\n\n\n\ndelta\n\neps");
    expect(coreOf(item)["truncated_by"]).toEqual(["server", "message_limit"]);
  });
});

describe("a thread entry not in the store", () => {
  it("is id and in_store: false only, with no fill, body or cut", () => {
    const item = projectThreadItem(absentThreadItem("MsgOut"), undefined);
    expect(item.core).toEqual([
      ["id", "MsgOut"],
      ["in_store", false],
    ]);
    expect(item.fill).toEqual([]);
    expect(item.body).toBeUndefined();
    expect(item.cut).toEqual([]);
    expect(JSON.stringify(Object.fromEntries(item.core))).toBe('{"id":"MsgOut","in_store":false}');
  });

  it("drops any other field the entry carries", () => {
    const [absent] = mustCheck(
      "thread",
      withExtraFields({ id: "T", total: 1, truncated: false, items: [absentThreadItem("MsgOut")] }),
    ).items;
    if (absent === undefined) {
      throw new Error("no item");
    }
    expect(projectThreadItem(absent, undefined).core).toEqual([
      ["id", "MsgOut"],
      ["in_store", false],
    ]);
  });
});

describe("received_at", () => {
  it("is normalised to UTC milliseconds (24 bytes)", () => {
    expect(normaliseReceivedAt("2026-10-27T16:58:00Z")).toBe("2026-10-27T16:58:00.000Z");
    expect(normaliseReceivedAt("2026-10-27T16:58:00.123456789+05:30")).toBe(
      "2026-10-27T11:28:00.123Z",
    );
    expect(normaliseReceivedAt("2026-10-27T16:58:00.5-02:00")).toBe("2026-10-27T18:58:00.500Z");
  });

  it.each([
    "yesterday",
    "",
    "2026-10-27",
    "2026-10-27T16:58:00",
    "2026-13-45T99:00:00Z",
    "2026-10-27T16:58:00Z\n",
  ])("fails closed on %j, in every projection that carries it", (receivedAt) => {
    expect(() => normaliseReceivedAt(receivedAt)).toThrow("malformed received_at");
    const summary = summaryOf({ received_at: receivedAt });
    const read = readOf({ received_at: receivedAt });
    expect(() => projectListItem(summary, classifiedAs(summary))).toThrow("malformed received_at");
    expect(() => projectThreadItem({ ...summary, in_store: true }, classifiedAs(summary))).toThrow(
      "malformed received_at",
    );
    expect(() => projectNew(read, classifiedAs(read), ANY_MAX_BYTES)).toThrow(
      "malformed received_at",
    );
    expect(() => projectRead(read, classifiedAs(read), ANY_MAX_BYTES)).toThrow(
      "malformed received_at",
    );
  });

  it("is what the core carries, in place of the raw text", () => {
    const summary = summaryOf({ received_at: "2026-10-27T16:58:00.123456789+05:30" });
    const item = projectListItem(summary, classifiedAs(summary));
    expect(coreOf(item)["received_at"]).toBe("2026-10-27T11:28:00.123Z");
  });
});

describe("core key order", () => {
  it("mail_list: summary core, held_back only when held, cut last", () => {
    const summary = summaryOf();
    expect(coreKeys(projectListItem(summary, classifiedAs(summary)))).toEqual([
      ...SUMMARY_CORE,
      "cut",
    ]);
    const held = projectListItem(summary, classifiedAs(summary), true);
    expect(coreKeys(held)).toEqual([...SUMMARY_CORE, "held_back", "cut"]);
    expect(coreOf(held)["held_back"]).toBe(true);
    expect(coreOf(held)["cut"]).toEqual([]);
  });

  it("mail_thread: an in-store entry has in_store: true before cut", () => {
    const entry = inStoreThreadItem();
    const item = projectThreadItem(entry, classifiedAs(entry));
    expect(coreKeys(item)).toEqual([...SUMMARY_CORE, "in_store", "cut"]);
    expect(coreOf(item)["in_store"]).toBe(true);
  });

  it("mail_new: summary core, then the body flags, then cut", () => {
    const read = readOf();
    expect(coreKeys(projectNew(read, classifiedAs(read), ANY_MAX_BYTES))).toEqual([
      ...SUMMARY_CORE,
      ...BODY_FLAGS,
      "cut",
    ]);
    expect(coreKeys(projectNew(read, classifiedAs(read), ANY_MAX_BYTES, true))).toEqual([
      ...SUMMARY_CORE,
      "held_back",
      ...BODY_FLAGS,
      "cut",
    ]);
  });

  it("mail_read: summary core, body flags, account_id, then cut", () => {
    const read = readOf({ provenance: { account_id: "acct9", email_state: "s" } });
    const item = projectRead(read, classifiedAs(read), ANY_MAX_BYTES);
    expect(coreKeys(item)).toEqual([...SUMMARY_CORE, ...BODY_FLAGS, "account_id", "cut"]);
    expect(coreOf(item)["account_id"]).toBe("acct9");
  });

  it("carries the summary values through", () => {
    const summary = summaryOf({
      id: "I1",
      thread_id: "T1",
      subject: "S",
      is_seen: true,
      is_flagged: true,
      has_attachment: true,
    });
    const item = projectListItem(summary, classifiedAs(summary));
    expect(item.core.slice(0, 7)).toEqual([
      ["id", "I1"],
      ["thread_id", "T1"],
      ["received_at", "2026-10-27T16:58:00.000Z"],
      ["subject", "S"],
      ["is_seen", true],
      ["is_flagged", true],
      ["has_attachment", true],
    ]);
  });
});

describe("fill order and content", () => {
  it("summaries fill from, mailbox_ids, preview; they carry no body", () => {
    const summary = summaryOf();
    const entry = inStoreThreadItem();
    for (const item of [
      projectListItem(summary, classifiedAs(summary)),
      projectThreadItem(entry, classifiedAs(entry)),
    ]) {
      expect(fillKeys(item)).toEqual(["from", "mailbox_ids", "preview"]);
      expect(item.body).toBeUndefined();
    }
  });

  it("read and new fill the 12 fields in the fixed order, then carry the body apart", () => {
    const read = readOf();
    for (const item of [
      projectRead(read, classifiedAs(read), ANY_MAX_BYTES),
      projectNew(read, classifiedAs(read), ANY_MAX_BYTES),
    ]) {
      expect(fillKeys(item)).toEqual(READ_FILL);
      expect(item.body).toBe("body text");
    }
  });

  it("projects addresses to name and email, attachments to the 5 contract fields", () => {
    const read = readOf({
      from: [{ name: null, email: "a@example.com" }],
      attachments: [attachmentOf({ name: null, cid: "cid1", disposition: null })],
    });
    const item = projectRead(read, classifiedAs(read), ANY_MAX_BYTES);
    const fill = Object.fromEntries(item.fill);
    expect(fill["from"]).toEqual([{ name: null, email: "a@example.com" }]);
    expect(JSON.stringify(fill["attachments"])).toBe(
      JSON.stringify([
        { part_id: "2", blob_id: "Gblob1", name: null, type: "application/pdf", size: 2048 },
      ]),
    );
    expect(JSON.stringify(fill["to"])).toBe(JSON.stringify([addressOf(2)]));
  });

  it("shortens nothing in the fill: a 40-entry to list and a long preview come through whole", () => {
    const to = Array.from({ length: 40 }, (_, n) => addressOf(n, 80));
    const read = readOf({ to, preview: "p".repeat(5000) });
    const item = projectNew(read, classifiedAs(read), ANY_MAX_BYTES);
    const fill = Object.fromEntries(item.fill);
    expect(fill["to"]).toEqual(to);
    expect(fill["preview"]).toBe("p".repeat(5000));
    expect(item.cut).toEqual([]);
  });
});

describe("fields outside the projection", () => {
  const MARKERS = ["x_future_field", "future", "state-1", "1793120280000:Msg1"];

  function expectNoStrays(item: ProjectedItem): void {
    const text = JSON.stringify({ core: item.core, fill: item.fill, body: item.body });
    for (const marker of MARKERS) {
      expect(text).not.toContain(marker);
    }
  }

  const noisy = mustCheck("read", withExtraFields(readOf()));

  it("does not survive in a read, at any depth", () => {
    expect(noisy).toHaveProperty("x_future_field"); // the input really carries them
    expect(noisy.provenance).toHaveProperty("x_future_field");
    expectNoStrays(projectRead(noisy, classifiedAs(noisy), ANY_MAX_BYTES));
  });

  it("does not survive in a new", () => {
    expectNoStrays(projectNew(noisy, classifiedAs(noisy), ANY_MAX_BYTES));
  });

  it("does not survive in a list or an in-store thread entry", () => {
    const [summary] = mustCheck(
      "list",
      withExtraFields({ offset: 0, limit: 1, items: [summaryOf()] }),
    ).items;
    const [entry] = mustCheck(
      "thread",
      withExtraFields({ id: "T", total: 1, truncated: false, items: [inStoreThreadItem()] }),
    ).items;
    if (summary === undefined || entry?.in_store !== true) {
      throw new Error("no item");
    }
    expectNoStrays(projectListItem(summary, classifiedAs(summary)));
    expectNoStrays(projectThreadItem(entry, classifiedAs(entry)));
  });

  it("does not show the cursor, email_state, the provenance object or the bodies list", () => {
    const item = projectRead(noisy, classifiedAs(noisy), ANY_MAX_BYTES);
    const keys = [...coreKeys(item), ...fillKeys(item)];
    for (const key of ["cursor", "provenance", "email_state", "bodies", "body"]) {
      expect(keys).not.toContain(key);
    }
  });

  it("does not survive in a mailbox", () => {
    const mailbox = mustCheck("mailboxes", withExtraFields({ items: [mailboxOf()] })).items[0];
    if (mailbox === undefined) {
      throw new Error("no mailbox");
    }
    expect(JSON.stringify(projectMailbox(mailbox))).toBe(
      JSON.stringify({
        id: "mbx1",
        name: "Inbox",
        parent_id: null,
        role: "inbox",
        sort_order: 1,
        total_emails: 10,
        unread_emails: 3,
      }),
    );
  });
});

const MAILBOX_KEYS = [
  "id",
  "name",
  "parent_id",
  "role",
  "sort_order",
  "total_emails",
  "unread_emails",
];

/** `entry`'s classification: none for an entry not in the store, which shows no text. */
function entryClassification(entry: ThreadItem): Classification | undefined {
  return entry.in_store ? classifiedAs(entry) : undefined;
}

/** Projects every item an envelope carries, checking the shape; returns how many. */
function projectEnvelope(envelope: Envelope): number {
  switch (envelope.kind) {
    case "list": {
      const { items } = mustCheck("list", envelope.data);
      for (const summary of items) {
        expect(coreOf(projectListItem(summary, classifiedAs(summary)))["received_at"]).toHaveLength(
          24,
        );
      }
      return items.length;
    }
    case "thread": {
      const { items } = mustCheck("thread", envelope.data);
      for (const entry of items) {
        expect(projectThreadItem(entry, entryClassification(entry)).core.length).toBeGreaterThan(1);
      }
      return items.length;
    }
    case "read": {
      const read = mustCheck("read", envelope.data);
      expect(projectRead(read, classifiedAs(read), ANY_MAX_BYTES).body).toBeDefined();
      expect(projectNew(read, classifiedAs(read), ANY_MAX_BYTES).body).toBeDefined();
      return 1;
    }
    case "mailboxes": {
      const { items } = mustCheck("mailboxes", envelope.data);
      for (const mailbox of items) {
        expect(Object.keys(projectMailbox(mailbox))).toEqual(MAILBOX_KEYS);
      }
      return items.length;
    }
    default:
      throw new Error(`unexpected kind ${String(envelope.kind)}`);
  }
}

/** The read verbs' fixtures: a classify envelope is not projected (its kind has no view). */
const READ_VERB_FIXTURES = [...fixtureFiles("real"), ...fixtureFiles("contract")].filter(
  (file) => file !== "contract/classify.json",
);

describe("every fixture projects without throwing", () => {
  it.each(READ_VERB_FIXTURES)("%s", (file) => {
    const projected = loadEnvelopes(file).map(projectEnvelope);
    expect(projected.reduce((sum, n) => sum + n, 0) > 0 || file.endsWith("empty.jsonl")).toBe(true);
  });
});

// ------------------------------------------ VT-2: sender text from `seen`

/** The six address lists a read shows; each has a `_omitted` count in `seen`. */
const ADDRESS_LISTS = ["from", "sender", "reply_to", "to", "cc", "bcc"] as const;
type AddressList = (typeof ADDRESS_LISTS)[number];

/** Addresses as every list shows them: name and email only. */
function addressesAsShown(addresses: readonly Address[]): { name: string | null; email: string }[] {
  return addresses.map(({ name, email }) => ({ name, email }));
}

/** `based`'s seen window with one list's `_omitted` count set: what screwtape reported. */
function seenWithOmitted(based: Summary | ReadData, list: AddressList, count: number): Seen {
  const seen = seenOf(based);
  const counts: Record<AddressList, number> = {
    from: seen.from_omitted,
    sender: seen.sender_omitted,
    reply_to: seen.reply_to_omitted,
    to: seen.to_omitted,
    cc: seen.cc_omitted,
    bcc: seen.bcc_omitted,
  };
  counts[list] = count;
  return {
    ...seen,
    from_omitted: counts.from,
    sender_omitted: counts.sender,
    reply_to_omitted: counts.reply_to,
    to_omitted: counts.to,
    cc_omitted: counts.cc,
    bcc_omitted: counts.bcc,
  };
}

/** The fill value of one key: the item as the renderer receives it. */
function fillAt(item: ProjectedItem, key: string): unknown {
  return Object.fromEntries(item.fill)[key];
}

describe("VT-2 sender text from seen (SL-007 PHASE-07)", () => {
  /** A read whose six lists each differ from the read the tool shows. */
  const seenSource = readOf({
    from: [addressOf(1), addressOf(2)],
    sender: [addressOf(3)],
    reply_to: [addressOf(4)],
    to: [addressOf(5)],
    cc: [addressOf(6)],
    bcc: [addressOf(7)],
  });

  it.each(ADDRESS_LISTS)("names a list with a non-zero _omitted count in cut", (list) => {
    const read = readOf();
    const seen = seenWithOmitted(seenSource, list, 2);
    const shown = projectRead(read, classificationOf(read.id, undefined, seen), ANY_MAX_BYTES);
    expect(shown.cut, list).toContain(list);
    expect(listAt(shown, "cut"), list).toContain(list);
    expect(fillAt(shown, list), list).toEqual(addressesAsShown(seenSource[list]));

    // A summary shows only `from`, and names it the same way.
    if (list === "from") {
      const summary = summaryOf({ from: [addressOf(8)] });
      const fromSource = summaryOf({ from: [addressOf(9), addressOf(10)] });
      const listed = projectListItem(
        summary,
        classificationOf(summary.id, undefined, seenWithOmitted(fromSource, "from", 1)),
      );
      expect(listed.cut, "mail_list's from").toContain("from");
      expect(fillAt(listed, "from"), "mail_list's from").toEqual(addressesAsShown(fromSource.from));
    }

    // A zero count names nothing, and the list shown is the window's own.
    const whole = projectRead(
      read,
      classificationOf(read.id, undefined, seenOf(read)),
      ANY_MAX_BYTES,
    );
    expect(whole.cut, list).not.toContain(list);
    expect(fillAt(whole, list), list).toEqual(addressesAsShown(read[list]));
  });

  it("names attachments in cut when attachments_omitted is non-zero", () => {
    const read = readOf({ attachments: [attachmentOf()] });
    const seen = { ...seenOf(read), attachments_omitted: 3 };
    const item = projectRead(read, classificationOf(read.id, undefined, seen), ANY_MAX_BYTES);
    expect(item.cut).toContain("attachments");
    expect(listAt(item, "cut")).toContain("attachments");
    const whole = projectRead(
      read,
      classificationOf(read.id, undefined, seenOf(read)),
      ANY_MAX_BYTES,
    );
    expect(whole.cut).not.toContain("attachments");
  });

  it("joins attachments by index", () => {
    const read = readOf({
      attachments: [
        attachmentOf({
          part_id: "read-part-0",
          blob_id: "read-blob-0",
          size: 11,
          name: "read-only-0.pdf",
          type: "read/type-0",
          cid: "read-only-cid-0",
          disposition: "inline",
        }),
        attachmentOf({
          part_id: "read-part-1",
          blob_id: "read-blob-1",
          size: 12,
          name: "read-only-1.pdf",
          type: "read/type-1",
          cid: "read-only-cid-1",
          disposition: "attachment",
        }),
        attachmentOf({
          part_id: "read-part-2",
          blob_id: "read-blob-2",
          name: "read-only-third.pdf",
        }),
      ],
    });
    const [first, second] = read.attachments;
    if (first === undefined || second === undefined) {
      throw new Error("the read needs two attachments");
    }
    const seen = {
      ...seenOf(read),
      attachments: [
        { type: "seen/type-0", name: "seen-0.txt" },
        { type: "seen/type-1", name: "seen-1.txt" },
      ],
    };
    const item = projectRead(read, classificationOf(read.id, undefined, seen), ANY_MAX_BYTES);
    expect(fillAt(item, "attachments")).toEqual([
      {
        part_id: first.part_id,
        blob_id: first.blob_id,
        name: "seen-0.txt",
        type: "seen/type-0",
        size: first.size,
      },
      {
        part_id: second.part_id,
        blob_id: second.blob_id,
        name: "seen-1.txt",
        type: "seen/type-1",
        size: second.size,
      },
    ]);
    const rendered = JSON.stringify(item.fill);
    for (const readOnly of [
      "read-only-0.pdf",
      "read-only-1.pdf",
      "read-only-third.pdf",
      "read-only-cid-0",
      "read-only-cid-1",
    ]) {
      expect(rendered, readOnly).not.toContain(readOnly);
    }
    for (const dropped of ["cid", "disposition"]) {
      expect(rendered, dropped).not.toContain(dropped);
    }

    // A window entry the read has no attachment for is dropped, never given an id, and named in cut.
    const short = readOf({ attachments: [first] });
    const longer = projectRead(short, classificationOf(short.id, undefined, seen), ANY_MAX_BYTES);
    expect(fillAt(longer, "attachments")).toEqual([
      {
        part_id: first.part_id,
        blob_id: first.blob_id,
        name: "seen-0.txt",
        type: "seen/type-0",
        size: first.size,
      },
    ]);
    expect(longer.cut).toContain("attachments");
    expect(item.cut).not.toContain("attachments");
  });

  it("cuts seen's body to max_bytes", () => {
    const read = readOf({
      bodies: [bodyPartOf({ text: "read-only body" })],
      output_truncated: true,
    });
    const seen: Seen = {
      ...seenOf(read),
      bodies: [{ text: "éééé", is_truncated: false, conversion_failed: false }],
    };
    const maxBytes = 5; // one byte into the third é: a raw-byte cut may not split it
    const item = projectRead(read, classificationOf(read.id, undefined, seen), maxBytes);
    const body = item.body ?? "";
    expect(seen.bodies[0]?.text.startsWith(body)).toBe(true);
    expect(body.isWellFormed()).toBe(true);
    expect(bytesOf(body)).toBeLessThanOrEqual(maxBytes);
    expect(body).toBe("éé"); // 4 raw bytes; a fifth would split the next character
    expect(coreOf(item)["output_truncated"]).toBe(true);

    const astral: Seen = {
      ...seen,
      bodies: [{ text: "😀😀😀", is_truncated: false, conversion_failed: false }],
    };
    const cut = projectRead(read, classificationOf(read.id, undefined, astral), 6);
    expect(cut.body).toBe("😀");
    expect(cut.body?.isWellFormed()).toBe(true);

    // A body the cut left whole is not called truncated, whatever the read says.
    const whole = projectRead(read, classificationOf(read.id, undefined, seen), ANY_MAX_BYTES);
    expect(whole.body).toBe("éééé");
    expect(coreOf(whole)["output_truncated"]).toBe(false);
    expect(JSON.stringify(item)).not.toContain("read-only body");
  });

  it("sets is_truncated from seen's bodies or bodies_omitted, and each other flag from its side", () => {
    const read = readOf({
      bodies: [
        bodyPartOf({
          text: "read-only body",
          is_truncated: false,
          conversion_failed: false,
          is_encoding_problem: true,
          truncated_by: "server",
        }),
      ],
    });
    const flagsOf = (
      body: Partial<Seen["bodies"][number]>,
      omitted = 0,
    ): Record<string, unknown> => {
      const seen: Seen = {
        ...seenOf(read),
        bodies: [{ text: "seen body", is_truncated: false, conversion_failed: false, ...body }],
        bodies_omitted: omitted,
      };
      const core = coreOf(
        projectNew(read, classificationOf(read.id, undefined, seen), ANY_MAX_BYTES),
      );
      return {
        is_truncated: core["is_truncated"],
        conversion_failed: core["conversion_failed"],
        is_encoding_problem: core["is_encoding_problem"],
        truncated_by: core["truncated_by"],
        output_truncated: core["output_truncated"],
      };
    };
    expect(flagsOf({})).toEqual({
      is_truncated: false,
      conversion_failed: false,
      is_encoding_problem: true,
      truncated_by: ["server"],
      output_truncated: false,
    });
    expect(flagsOf({ is_truncated: true })).toMatchObject({ is_truncated: true });
    expect(flagsOf({ conversion_failed: true })).toMatchObject({
      is_truncated: false,
      conversion_failed: true,
    });
    expect(flagsOf({}, 2)).toMatchObject({ is_truncated: true });
  });

  it("drops message_id, in_reply_to, references, cid and disposition", () => {
    const read = readOf({
      message_id: ["<read-only-message-id@example.com>"],
      in_reply_to: ["<read-only-parent@example.com>"],
      references: ["<read-only-reference@example.com>"],
      attachments: [attachmentOf({ cid: "read-only-cid", disposition: "inline" })],
    });
    const classified = classifiedAs(read);
    const item = projectRead(read, classified, ANY_MAX_BYTES);
    const rendered = JSON.stringify({
      core: item.core,
      fill: item.fill,
      body: item.body,
      cut: item.cut,
    });
    for (const dropped of ["message_id", "in_reply_to", "references", "cid", "disposition"]) {
      expect(coreKeys(item), dropped).not.toContain(dropped);
      expect(fillKeys(item), dropped).not.toContain(dropped);
      expect(item.cut, dropped).not.toContain(dropped);
      expect(rendered, dropped).not.toContain(dropped);
    }
    for (const value of [
      "read-only-message-id",
      "read-only-parent",
      "read-only-reference",
      "read-only-cid",
    ]) {
      expect(rendered, value).not.toContain(value);
    }
    expect(coreKeys(item)).toContain("account_id"); // the read's own field stays
    expect(coreKeys(projectNew(read, classified, ANY_MAX_BYTES))).not.toContain("message_id");
  });
});

// --------------------------------------------------------- sender domains

describe("senderDomains (SL-007 sec-15)", () => {
  const address = (email: string): Address => ({ name: null, email });
  const domainsOf = (...emails: readonly string[]): string[] =>
    senderDomains(emails.map((email) => address(email)));

  it("is the text after the last @, lowercased", () => {
    expect(domainsOf("a@Example.COM")).toEqual(["example.com"]);
    expect(domainsOf("local@part@Example.COM")).toEqual(["example.com"]);
    expect(domainsOf(`a@${"D".repeat(SENDER_DOMAIN_MAX_BYTES)}`)).toEqual([
      "d".repeat(SENDER_DOMAIN_MAX_BYTES),
    ]);
  });

  it("deduplicates in first-appearance order", () => {
    expect(domainsOf("a@b.example", "b@a.example", "c@B.Example", "d@a.example")).toEqual([
      "b.example",
      "a.example",
    ]);
  });

  it("keeps at most SENDER_DOMAINS_MAX, the first ones", () => {
    const emails = Array.from(
      { length: SENDER_DOMAINS_MAX + 5 },
      (_, n) => `user${String(n)}@host${String(n)}.example`,
    );
    const domains = domainsOf(...emails);
    expect(domains).toHaveLength(SENDER_DOMAINS_MAX);
    expect(domains).toEqual(
      emails.slice(0, SENDER_DOMAINS_MAX).map((_, n) => `host${String(n)}.example`),
    );
  });

  it("drops a domain over SENDER_DOMAIN_MAX_BYTES raw bytes, keeps one exactly that long", () => {
    const longest = "d".repeat(SENDER_DOMAIN_MAX_BYTES);
    const tooLong = "d".repeat(SENDER_DOMAIN_MAX_BYTES + 1);
    expect(domainsOf(`a@${longest}`)).toEqual([longest]);
    expect(domainsOf(`a@${tooLong}`)).toEqual([]);
    expect(domainsOf(`a@${tooLong}`, "b@kept.example")).toEqual(["kept.example"]);
  });

  it("contributes nothing for an address with no @ or a trailing @", () => {
    expect(domainsOf("nodomain")).toEqual([]);
    expect(domainsOf("trailing@")).toEqual([]);
    expect(domainsOf("nodomain", "b@kept.example", "trailing@")).toEqual(["kept.example"]);
  });
});

// --------------------------------------------------------- withheld items

const WITHHELD_CORE = [
  "id",
  "thread_id",
  "received_at",
  "is_seen",
  "is_flagged",
  "has_attachment",
  "jev",
  "withheld",
  "cut",
];
const WITHHELD_READ_CORE = [
  "id",
  "thread_id",
  "received_at",
  "size",
  "is_seen",
  "is_flagged",
  "has_attachment",
  "jev",
  "withheld",
  "cut",
];
/** Everything of the item a withheld projection must drop. */
const WITHHELD_DROPPED = [
  "subject",
  "preview",
  "from",
  "to",
  "cc",
  "bcc",
  "reply_to",
  "sender",
  "mailbox_ids", // kept as a fill key, so only the core is checked for it
  "attachments",
  "keywords",
  "message_id",
  "account_id",
  "bodies",
  "body",
  ...BODY_FLAGS,
];

describe("projectWithheld (SL-007 sec-15)", () => {
  const BENIGN: ClassifyOutcome = { id: "Msg1", classified: classifiedAs(summaryOf()) };
  const REPORTED: Withheld = { reason: "reported", detail: "phishing" };

  it("fills exactly sender_domains then mailbox_ids, for every item kind", () => {
    const summary = projectWithheld(summaryOf(), BENIGN, REPORTED);
    const read = projectWithheld(readOf(), BENIGN, REPORTED);
    const thread = projectWithheld(summaryOf(), BENIGN, REPORTED, { inStore: true });
    for (const item of [summary, read, thread]) {
      expect(fillKeys(item)).toEqual(["sender_domains", "mailbox_ids"]);
      expect(item.body).toBeUndefined();
    }
    expect(Object.fromEntries(summary.fill)).toEqual({
      sender_domains: ["example.com"],
      mailbox_ids: ["mbx1"],
    });
  });

  it("a summary's core is the interface's order; no size, no body", () => {
    const item = projectWithheld(summaryOf(), BENIGN, REPORTED);
    expect(coreKeys(item)).toEqual(WITHHELD_CORE);
    expect(coreOf(item)).not.toHaveProperty("size");
  });

  it("a read's core adds size, and nothing else", () => {
    const read = readOf();
    const item = projectWithheld(read, BENIGN, REPORTED, { size: read.size });
    expect(coreKeys(item)).toEqual(WITHHELD_READ_CORE);
    expect(coreOf(item)["size"]).toBe(5120);
  });

  it("writes size only when a flag gives it, at the read core's position", () => {
    const read = readOf();
    expect(coreKeys(projectWithheld(read, BENIGN, REPORTED))).toEqual(WITHHELD_CORE);
    expect(coreOf(projectWithheld(read, BENIGN, REPORTED, { size: read.size }))["size"]).toBe(5120);
  });

  it("an in-store thread item carries in_store after withheld", () => {
    const item = projectWithheld(summaryOf(), BENIGN, REPORTED, { inStore: true });
    expect(coreKeys(item)).toEqual([...WITHHELD_CORE.slice(0, -1), "in_store", "cut"]);
    expect(coreOf(item)["in_store"]).toBe(true);
  });

  it("names held_back only when the flag says so", () => {
    const held = projectWithheld(summaryOf(), BENIGN, REPORTED, { heldBack: true });
    expect(coreKeys(held)).toEqual([...WITHHELD_CORE.slice(0, -1), "held_back", "cut"]);
    expect(coreOf(held)["held_back"]).toBe(true);
    expect(coreKeys(projectWithheld(readOf(), BENIGN, REPORTED))).not.toContain("held_back");
  });

  it("carries none of the sender's text: subjects, previews, addresses, attachments, ids, body flags", () => {
    const item = projectWithheld(readOf(), BENIGN, REPORTED);
    const core = coreKeys(item);
    for (const dropped of WITHHELD_DROPPED) {
      expect(core).not.toContain(dropped);
    }
    const text = JSON.stringify(item.core);
    for (const dropped of [
      "subject",
      "preview",
      "from",
      "to",
      "attachments",
      "keywords",
      "message_id",
      "account_id",
      "bodies",
    ]) {
      expect(text).not.toContain(`"${dropped}"`);
    }
    for (const flag of BODY_FLAGS) {
      expect(text).not.toContain(`"${flag}"`);
    }
  });

  it("renders each withholding reason, a hostile score rounded to 2 dp", () => {
    const [policy] = WITHHOLD_POLICY;
    const cases: readonly (readonly [Withheld, Record<string, unknown>])[] = [
      [
        { reason: "reported", detail: "phishing" },
        { reason: "reported", detail: "phishing" },
      ],
      [
        { reason: "unclassified", detail: "unavailable" },
        { reason: "unclassified", detail: "unavailable" },
      ],
      [
        { reason: "missing_question", detail: policy.question },
        { reason: "missing_question", detail: policy.question },
      ],
      [
        { reason: "hostile", detail: policy.question, score: 0.8249 },
        { reason: "hostile", detail: policy.question, score: 0.82 },
      ],
    ];
    for (const [withheld, rendered] of cases) {
      expect(coreOf(projectWithheld(summaryOf(), BENIGN, withheld))["withheld"]).toEqual(rendered);
    }
  });

  it("takes jev from the outcome, classified or not", () => {
    const classified = projectWithheld(summaryOf(), BENIGN, REPORTED);
    expect(coreOf(classified)["jev"]).toEqual(jevField(BENIGN).value);
    const unclassified: ClassifyOutcome = { id: "Msg1", unclassified: "too_large" };
    expect(coreOf(projectWithheld(summaryOf(), unclassified, REPORTED))["jev"]).toEqual({
      unclassified: "too_large",
    });
  });
});
