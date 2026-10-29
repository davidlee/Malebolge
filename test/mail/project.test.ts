// VT-3: the projection, from a validated envelope to a ProjectedItem.

import { describe, expect, it } from "vitest";
import {
  CUT_ORDER,
  foldBodies,
  jevField,
  MESSAGE_ID_ENTRY_MAX_BYTES,
  MESSAGE_ID_MAX_ENTRIES,
  normaliseReceivedAt,
  type ProjectedItem,
  projectListItem,
  projectMailbox,
  projectNew,
  projectRead,
  projectThreadItem,
  projectWithheld,
  SENDER_DOMAIN_MAX_BYTES,
  SENDER_DOMAINS_MAX,
  senderDomains,
  SUBJECT_MAX_BYTES,
} from "../../src/mail/project.ts";
import { type Withheld, WITHHOLD_POLICY } from "../../src/mail/policy.ts";
import type { Address, ClassifyOutcome } from "../../src/mail/source.ts";
import {
  absentThreadItem,
  addressOf,
  attachmentOf,
  bodyPartOf,
  classificationOf,
  type Envelope,
  fixtureFiles,
  inStoreThreadItem,
  loadEnvelopes,
  mailboxOf,
  mustCheck,
  readOf,
  renderedBytes,
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
  "in_reply_to",
  "references",
  "attachments",
];

describe("limits", () => {
  it("are the sec-4 figures", () => {
    expect(SUBJECT_MAX_BYTES).toBe(200);
    expect(MESSAGE_ID_MAX_ENTRIES).toBe(5);
    expect(MESSAGE_ID_ENTRY_MAX_BYTES).toBe(256);
    expect(CUT_ORDER).toEqual([
      "subject",
      "jev",
      "message_id",
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
      "in_reply_to",
      "references",
      "attachments",
      "body",
    ]);
  });
});

describe("subject", () => {
  it("a 300-byte subject is shortened to at most 200 rendered bytes, ends in an ellipsis and is named in cut", () => {
    const item = projectListItem(summaryOf({ subject: "s".repeat(300) }), classificationOf("Msg1"));
    const subject = textAt(item, "subject");
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.startsWith("sss")).toBe(true);
    expect(renderedBytes(subject)).toBe(200); // the longest prefix that fits: not over-cut
    expect(listAt(item, "cut")).toEqual(["subject"]);
    expect(item.cut).toEqual(["subject"]);
  });

  it("is measured rendered, not raw: 300 `<` (six bytes each) still ends within 200", () => {
    const item = projectListItem(summaryOf({ subject: "<".repeat(300) }), classificationOf("Msg1"));
    const subject = textAt(item, "subject");
    expect(subject.endsWith("…")).toBe(true);
    expect(renderedBytes(subject)).toBeLessThanOrEqual(200);
    expect(renderedBytes(subject)).toBeGreaterThan(200 - 6);
    expect(item.cut).toContain("subject");
  });

  it("is cut at a code-point boundary, never inside an astral character", () => {
    for (const unit of ["😀", "é", "€"]) {
      const subject = textAt(
        projectListItem(summaryOf({ subject: unit.repeat(120) }), classificationOf("Msg1")),
        "subject",
      );
      expect(subject.isWellFormed()).toBe(true);
      expect(renderedBytes(subject)).toBeLessThanOrEqual(200);
    }
  });

  it("is kept as received at exactly 200 rendered bytes, shortened one byte over", () => {
    const fits = projectListItem(summaryOf({ subject: "s".repeat(198) }), classificationOf("Msg1"));
    expect(textAt(fits, "subject")).toBe("s".repeat(198));
    expect(fits.cut).toEqual([]);
    const over = projectListItem(summaryOf({ subject: "s".repeat(199) }), classificationOf("Msg1"));
    expect(textAt(over, "subject")).not.toBe("s".repeat(199));
    expect(over.cut).toEqual(["subject"]);
  });

  it("stays null when absent, and no cut is named", () => {
    const item = projectListItem(summaryOf({ subject: null }), classificationOf("Msg1"));
    expect(coreOf(item)["subject"]).toBeNull();
    expect(item.cut).toEqual([]);
  });
});

describe("message_id (mail_read)", () => {
  it("keeps the first 5 of 7 entries, in order, and names message_id in cut", () => {
    const ids = Array.from({ length: 7 }, (_, n) => `<m${String(n)}@example.com>`);
    const item = projectRead(readOf({ message_id: ids }), classificationOf("Msg1"));
    expect(coreOf(item)["message_id"]).toEqual(ids.slice(0, 5));
    expect(item.cut).toContain("message_id");
    expect(listAt(item, "cut")).toContain("message_id");
  });

  it("shortens a 300-byte entry to at most 256 rendered bytes ending in an ellipsis", () => {
    const item = projectRead(
      readOf({ message_id: ["short", "m".repeat(300)] }),
      classificationOf("Msg1"),
    );
    const [first, second] = listAt(item, "message_id");
    expect(first).toBe("short");
    expect(typeof second).toBe("string");
    expect(renderedBytes(second)).toBe(256);
    expect(String(second).endsWith("…")).toBe(true);
    expect(item.cut).toContain("message_id");
  });

  it("measures an entry rendered: 100 `<` still ends within 256", () => {
    const item = projectRead(readOf({ message_id: ["<".repeat(100)] }), classificationOf("Msg1"));
    const [entry] = listAt(item, "message_id");
    expect(renderedBytes(entry)).toBeLessThanOrEqual(256);
    expect(String(entry).endsWith("…")).toBe(true);
    expect(item.cut).toContain("message_id");
  });

  it("leaves 5 entries of 256 rendered bytes untouched and cut-free", () => {
    const ids = Array.from({ length: 5 }, (_, n) => `${String(n)}${"m".repeat(253)}`);
    const item = projectRead(readOf({ message_id: ids }), classificationOf("Msg1"));
    expect(renderedBytes(ids[0])).toBe(256);
    expect(coreOf(item)["message_id"]).toEqual(ids);
    expect(item.cut).not.toContain("message_id");
  });

  it("is empty when the message has none", () => {
    expect(
      coreOf(projectRead(readOf({ message_id: [] }), classificationOf("Msg1")))["message_id"],
    ).toEqual([]);
  });

  it("is not shown by mail_new, which reads the same envelope", () => {
    const item = projectNew(
      readOf({ message_id: ["a", "b", "c", "d", "e", "f", "g"] }),
      classificationOf("Msg1"),
    );
    expect(coreKeys(item)).not.toContain("message_id");
    expect(item.cut).not.toContain("message_id");
  });
});

describe("bodies fold", () => {
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

  it("joins the texts in order by a blank line, ORs the flags, lists distinct reasons", () => {
    expect(foldBodies(parts)).toEqual({
      body: "alpha\n\nbeta\n\n\n\ndelta\n\neps",
      is_truncated: true,
      is_encoding_problem: true,
      conversion_failed: true,
      truncated_by: ["server", "message_limit"], // distinct, in that order, wherever they occur
    });
  });

  it("lists only the reasons that occur, and none when nothing was truncated", () => {
    expect(foldBodies([alpha, eps]).truncated_by).toEqual(["message_limit"]);
    expect(foldBodies([bodyPartOf(), bodyPartOf()])).toEqual({
      body: "body text\n\nbody text",
      is_truncated: false,
      is_encoding_problem: false,
      conversion_failed: false,
      truncated_by: [],
    });
  });

  it("is empty for a message with no text parts", () => {
    expect(foldBodies([])).toEqual({
      body: "",
      is_truncated: false,
      is_encoding_problem: false,
      conversion_failed: false,
      truncated_by: [],
    });
  });

  it("projects to one body (last, outside the fill) and one flag set in the core", () => {
    const item = projectRead(
      readOf({ bodies: parts, output_truncated: true }),
      classificationOf("Msg1"),
    );
    expect(item.body).toBe("alpha\n\nbeta\n\n\n\ndelta\n\neps");
    const core = coreOf(item);
    expect(core["is_truncated"]).toBe(true);
    expect(core["is_encoding_problem"]).toBe(true);
    expect(core["conversion_failed"]).toBe(true);
    expect(core["truncated_by"]).toEqual(["server", "message_limit"]);
    expect(core["output_truncated"]).toBe(true);
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
    const item = projectNew(readOf({ bodies: parts }), classificationOf("Msg1"));
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
    expect(() =>
      projectListItem(summaryOf({ received_at: receivedAt }), classificationOf("Msg1")),
    ).toThrow("malformed received_at");
    expect(() =>
      projectThreadItem(
        { ...summaryOf({ received_at: receivedAt }), in_store: true },
        classificationOf("Msg1"),
      ),
    ).toThrow("malformed received_at");
    expect(() => projectNew(readOf({ received_at: receivedAt }), classificationOf("Msg1"))).toThrow(
      "malformed received_at",
    );
    expect(() =>
      projectRead(readOf({ received_at: receivedAt }), classificationOf("Msg1")),
    ).toThrow("malformed received_at");
  });

  it("is what the core carries, in place of the raw text", () => {
    const item = projectListItem(
      summaryOf({ received_at: "2026-10-27T16:58:00.123456789+05:30" }),
      classificationOf("Msg1"),
    );
    expect(coreOf(item)["received_at"]).toBe("2026-10-27T11:28:00.123Z");
  });
});

describe("core key order", () => {
  it("mail_list: summary core, held_back only when held, cut last", () => {
    expect(coreKeys(projectListItem(summaryOf(), classificationOf("Msg1")))).toEqual([
      ...SUMMARY_CORE,
      "cut",
    ]);
    const held = projectListItem(summaryOf(), classificationOf("Msg1"), true);
    expect(coreKeys(held)).toEqual([...SUMMARY_CORE, "held_back", "cut"]);
    expect(coreOf(held)["held_back"]).toBe(true);
    expect(coreOf(held)["cut"]).toEqual([]);
  });

  it("mail_thread: an in-store entry has in_store: true before cut", () => {
    const item = projectThreadItem(inStoreThreadItem(), classificationOf("Msg1"));
    expect(coreKeys(item)).toEqual([...SUMMARY_CORE, "in_store", "cut"]);
    expect(coreOf(item)["in_store"]).toBe(true);
  });

  it("mail_new: summary core, then the body flags, then cut", () => {
    expect(coreKeys(projectNew(readOf(), classificationOf("Msg1")))).toEqual([
      ...SUMMARY_CORE,
      ...BODY_FLAGS,
      "cut",
    ]);
    expect(coreKeys(projectNew(readOf(), classificationOf("Msg1"), true))).toEqual([
      ...SUMMARY_CORE,
      "held_back",
      ...BODY_FLAGS,
      "cut",
    ]);
  });

  it("mail_read: summary core, body flags, message_id, account_id, then cut", () => {
    const item = projectRead(
      readOf({ provenance: { account_id: "acct9", email_state: "s" } }),
      classificationOf("Msg1"),
    );
    expect(coreKeys(item)).toEqual([
      ...SUMMARY_CORE,
      ...BODY_FLAGS,
      "message_id",
      "account_id",
      "cut",
    ]);
    expect(coreOf(item)["account_id"]).toBe("acct9");
  });

  it("carries the summary values through", () => {
    const item = projectListItem(
      summaryOf({
        id: "I1",
        thread_id: "T1",
        subject: "S",
        is_seen: true,
        is_flagged: true,
        has_attachment: true,
      }),
      classificationOf("Msg1"),
    );
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
    for (const item of [
      projectListItem(summaryOf(), classificationOf("Msg1")),
      projectThreadItem(inStoreThreadItem(), classificationOf("Msg1")),
    ]) {
      expect(fillKeys(item)).toEqual(["from", "mailbox_ids", "preview"]);
      expect(item.body).toBeUndefined();
    }
  });

  it("read and new fill the 14 fields in the fixed order, then carry the body apart", () => {
    for (const item of [
      projectRead(readOf(), classificationOf("Msg1")),
      projectNew(readOf(), classificationOf("Msg1")),
    ]) {
      expect(fillKeys(item)).toEqual(READ_FILL);
      expect(item.body).toBe("body text");
    }
  });

  it("projects addresses to name and email, attachments to the 7 contract fields", () => {
    const item = projectRead(
      readOf({
        from: [{ name: null, email: "a@example.com" }],
        attachments: [attachmentOf({ name: null, cid: "cid1", disposition: null })],
      }),
      classificationOf("Msg1"),
    );
    const fill = Object.fromEntries(item.fill);
    expect(fill["from"]).toEqual([{ name: null, email: "a@example.com" }]);
    expect(JSON.stringify(fill["attachments"])).toBe(
      JSON.stringify([
        {
          part_id: "2",
          blob_id: "Gblob1",
          name: null,
          type: "application/pdf",
          size: 2048,
          disposition: null,
          cid: "cid1",
        },
      ]),
    );
    expect(JSON.stringify(fill["to"])).toBe(JSON.stringify([addressOf(2)]));
  });

  it("shortens nothing in the fill: a 40-entry to list and a long preview come through whole", () => {
    const to = Array.from({ length: 40 }, (_, n) => addressOf(n, 80));
    const item = projectNew(readOf({ to, preview: "p".repeat(5000) }), classificationOf("Msg1"));
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
    expectNoStrays(projectRead(noisy, classificationOf("Msg1")));
  });

  it("does not survive in a new", () => {
    expectNoStrays(projectNew(noisy, classificationOf("Msg1")));
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
    if (summary === undefined || entry === undefined) {
      throw new Error("no item");
    }
    expectNoStrays(projectListItem(summary, classificationOf("Msg1")));
    expectNoStrays(projectThreadItem(entry, classificationOf("Msg1")));
  });

  it("does not show the cursor, email_state, the provenance object or the bodies list", () => {
    const item = projectRead(noisy, classificationOf("Msg1"));
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

/** Projects every item an envelope carries, checking the shape; returns how many. */
function projectEnvelope(envelope: Envelope): number {
  switch (envelope.kind) {
    case "list": {
      const { items } = mustCheck("list", envelope.data);
      for (const summary of items) {
        expect(
          coreOf(projectListItem(summary, classificationOf("Msg1")))["received_at"],
        ).toHaveLength(24);
      }
      return items.length;
    }
    case "thread": {
      const { items } = mustCheck("thread", envelope.data);
      for (const entry of items) {
        expect(projectThreadItem(entry, classificationOf("Msg1")).core.length).toBeGreaterThan(1);
      }
      return items.length;
    }
    case "read": {
      const read = mustCheck("read", envelope.data);
      expect(projectRead(read, classificationOf("Msg1")).body).toBeDefined();
      expect(projectNew(read, classificationOf("Msg1")).body).toBeDefined();
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
  const BENIGN: ClassifyOutcome = { id: "Msg1", classified: classificationOf("Msg1") };
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
