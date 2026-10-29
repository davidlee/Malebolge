// EX-1: the v1 contract schemas and the one canonical-cursor check.

import { describe, expect, it } from "vitest";
import { isRecord } from "../../src/json.ts";
import {
  checkData,
  isCanonicalCursor,
  isJmapId,
  isRfc3339,
  KIND_SCHEMAS,
} from "../../src/mail/source.ts";
import {
  fixtureFiles,
  idOf,
  loadEnvelopes,
  type MailKind,
  setAt,
  withExtraFields,
  FUTURE_FIELD,
  withoutKey,
} from "./mail-fixtures.ts";

const ALL_FIXTURES = [...fixtureFiles("real"), ...fixtureFiles("contract")];

function isMailKind(kind: unknown): kind is MailKind {
  return typeof kind === "string" && Object.keys(KIND_SCHEMAS).includes(kind);
}

/** Every envelope of every fixture, as [file, kind, data]; an unknown kind is its own test's failure. */
function allData(): [string, MailKind, unknown][] {
  return ALL_FIXTURES.flatMap((file) =>
    loadEnvelopes(file).flatMap((envelope): [string, MailKind, unknown][] => {
      if (envelope.version !== 1 || !isMailKind(envelope.kind)) {
        return [];
      }
      return [[file, envelope.kind, envelope.data]];
    }),
  );
}

/** The keys of `data`'s `seen`, or none when it has none: only a well-formed fixture has any. */
function seenKeys(data: unknown): string[] {
  if (!isRecord(data) || !isRecord(data["seen"])) {
    return [];
  }
  return Object.keys(data["seen"]);
}

/**
 * withExtraFields, except that in a classify `answers` map a new key is a new
 * question, so the future entry there takes a known answer shape.
 */
function withFutureFields(data: unknown): unknown {
  const extended = withExtraFields(data);
  if (isRecord(extended) && isRecord(extended["answers"])) {
    return setAt(extended, ["answers", FUTURE_FIELD], { noul: 0.5, [FUTURE_FIELD]: "future" });
  }
  return extended;
}

describe("fixtures", () => {
  it("cover every verb in both directories", () => {
    const expected = {
      real: ["list", "mailboxes", "read", "thread"],
      contract: ["list", "mailboxes", "read", "thread", "classify"],
    };
    for (const dir of ["real", "contract"] as const) {
      const kinds = new Set(
        fixtureFiles(dir).flatMap((file) => loadEnvelopes(file).map((e) => e.kind)),
      );
      expect([...kinds].sort()).toEqual([...expected[dir]].sort());
    }
  });

  it("hold only v1 envelopes of a known kind", () => {
    for (const file of ALL_FIXTURES) {
      for (const envelope of loadEnvelopes(file)) {
        if (envelope.version !== 1 || !isMailKind(envelope.kind)) {
          throw new Error(`${file}: not a v1 envelope of a known kind`);
        }
      }
    }
  });

  it("classify.json passes checkData, with and without an extra field at every level", () => {
    const [envelope] = loadEnvelopes("contract/classify.json");
    expect(checkData("classify", envelope?.data)).toBeDefined();
    expect(checkData("classify", withFutureFields(envelope?.data))).toBeDefined();
  });

  it("include an empty read --after page", () => {
    expect(loadEnvelopes("contract/read-after-empty.jsonl")).toEqual([]);
  });

  it.each(allData())("%s: %s data passes checkData", (_file, kind, data) => {
    expect(checkData(kind, data)).toBeDefined();
  });

  it.each(allData())(
    "%s: %s data passes checkData with an extra field at every level",
    (_file, kind, data) => {
      expect(checkData(kind, withFutureFields(data))).toBeDefined();
    },
  );
});

describe("checkData rejects", () => {
  const [, , read] = allData().find(([file]) => file === "contract/read.json") ?? [];
  const [, , list] = allData().find(([file]) => file === "contract/list-after.json") ?? [];
  const [, , thread] = allData().find(([file]) => file === "contract/thread.json") ?? [];
  const [, , mailboxes] = allData().find(([file]) => file === "contract/mailboxes.json") ?? [];
  const [classifyEnvelope] = loadEnvelopes("contract/classify.json");
  const classify = classifyEnvelope?.data;

  it("an answer of no known shape", () => {
    expect(
      checkData("classify", setAt(classify, ["answers", "primary_purpose"], {})),
    ).toBeUndefined();
    expect(
      checkData("classify", setAt(classify, ["answers", "primary_purpose"], { label: "x" })),
    ).toBeUndefined();
  });

  it("a probability outside [0, 1]", () => {
    expect(
      checkData("classify", setAt(classify, ["answers", "security_related", "noul"], 1.5)),
    ).toBeUndefined();
    expect(
      checkData("classify", setAt(classify, ["answers", "security_related", "noul"], -0.1)),
    ).toBeUndefined();
    expect(
      checkData("classify", setAt(classify, ["answers", "primary_purpose", "confidence"], 2)),
    ).toBeUndefined();
  });

  it("a seen missing a field", () => {
    const keys = seenKeys(classify);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(checkData("classify", withoutKey(classify, ["seen", key]))).toBeUndefined();
    }
  });

  const badIds = ["", "a b", "a:b", "-a\n", "é", idOf(256, "Long")];

  it.each(badIds.map((id) => [JSON.stringify(id), id]))(
    "an id %s outside the JMAP Id form",
    (_label, id) => {
      expect(checkData("read", setAt(read, ["id"], id))).toBeUndefined();
      expect(checkData("read", setAt(read, ["thread_id"], id))).toBeUndefined();
      expect(checkData("read", setAt(read, ["mailbox_ids", 0], id))).toBeUndefined();
      expect(checkData("read", setAt(read, ["attachments", 0, "blob_id"], id))).toBeUndefined();
      expect(checkData("read", setAt(read, ["provenance", "account_id"], id))).toBeUndefined();
      expect(checkData("list", setAt(list, ["items", 0, "id"], id))).toBeUndefined();
      expect(checkData("thread", setAt(thread, ["id"], id))).toBeUndefined();
      expect(checkData("thread", setAt(thread, ["items", 0, "id"], id))).toBeUndefined();
      expect(checkData("thread", setAt(thread, ["items", 1, "id"], id))).toBeUndefined();
      expect(checkData("mailboxes", setAt(mailboxes, ["items", 0, "id"], id))).toBeUndefined();
      expect(
        checkData("mailboxes", setAt(mailboxes, ["items", 1, "parent_id"], id)),
      ).toBeUndefined();
    },
  );

  it("accepts a 255-byte id where the form allows one", () => {
    const id = idOf(255, "Longest");
    expect(checkData("read", setAt(read, ["id"], id))).toBeDefined();
    expect(checkData("read", setAt(read, ["provenance", "account_id"], id))).toBeDefined();
  });

  it.each(["+5:x", "05:x", "-0:x", "5:", ":x", "5:a:b", "9223372036854775808:x", "abc"])(
    "a non-canonical cursor %s",
    (cursor) => {
      expect(checkData("read", setAt(read, ["cursor"], cursor))).toBeUndefined();
      expect(checkData("list", setAt(list, ["items", 0, "cursor"], cursor))).toBeUndefined();
      expect(checkData("list", setAt(list, ["after"], cursor))).toBeUndefined();
      expect(checkData("thread", setAt(thread, ["items", 1, "cursor"], cursor))).toBeUndefined();
    },
  );

  it("accepts the empty cursor as an after position", () => {
    expect(checkData("list", setAt(list, ["after"], ""))).toBeDefined();
  });

  it.each([
    "yesterday",
    "2026-10-27",
    "2026-10-27 16:58:00Z",
    "2026-10-27T16:58:00",
    "2026-10-27T16:58:00+0530",
    "2026-13-45T99:00:00Z",
    "",
  ])("a malformed received_at %s", (receivedAt) => {
    expect(checkData("read", setAt(read, ["received_at"], receivedAt))).toBeUndefined();
    expect(checkData("list", setAt(list, ["items", 0, "received_at"], receivedAt))).toBeUndefined();
  });

  it("a source_type that is not text or html", () => {
    expect(
      checkData("read", setAt(read, ["bodies", 0, "source_type"], "markdown")),
    ).toBeUndefined();
  });

  it("a truncated_by that is not server, message_limit or null", () => {
    expect(checkData("read", setAt(read, ["bodies", 0, "truncated_by"], "client"))).toBeUndefined();
    expect(
      checkData("read", setAt(read, ["bodies", 0, "truncated_by"], "message_limit")),
    ).toBeDefined();
    expect(checkData("read", setAt(read, ["bodies", 0, "truncated_by"], null))).toBeDefined();
  });

  it("a field of the wrong type or a missing contract field", () => {
    expect(checkData("read", setAt(read, ["size"], "big"))).toBeUndefined();
    expect(checkData("read", setAt(read, ["is_seen"], 0))).toBeUndefined();
    expect(checkData("read", setAt(read, ["from", 0, "email"], null))).toBeUndefined();
    expect(checkData("read", setAt(read, ["bodies"], "text"))).toBeUndefined();
    expect(
      checkData("mailboxes", setAt(mailboxes, ["items", 0, "total_emails"], 1.5)),
    ).toBeUndefined();
    expect(checkData("thread", setAt(thread, ["total"], "5"))).toBeUndefined();
    expect(checkData("list", setAt(list, ["limit"], undefined))).toBeUndefined();
  });

  it("a list carrying neither offset nor after, or both", () => {
    expect(checkData("list", { limit: 2, items: [] })).toBeUndefined();
    expect(checkData("list", { offset: 0, after: "", limit: 2, items: [] })).toBeUndefined();
  });

  it("data that is not an object, and the wrong kind's data", () => {
    expect(checkData("read", null)).toBeUndefined();
    expect(checkData("list", "x")).toBeUndefined();
    expect(checkData("read", mailboxes)).toBeUndefined();
    expect(checkData("mailboxes", thread)).toBeUndefined();
  });
});

describe("isCanonicalCursor", () => {
  it.each([
    "",
    "0:x",
    "5:x",
    "-5:x",
    "1793120280000:StlqDajM7cCB",
    "9223372036854775807:x",
    "-9223372036854775808:x",
    `5:${idOf(255, "I")}`,
    "5:a-b_C9",
  ])("accepts %s", (cursor) => {
    expect(isCanonicalCursor(cursor)).toBe(true);
  });

  it.each([
    "+5:x",
    "05:x",
    "00:x",
    "-0:x",
    "-05:x",
    "9223372036854775808:x",
    "-9223372036854775809:x",
    "99999999999999999999:x",
    "5:",
    ":x",
    "5:a:b",
    "5",
    "x",
    " 5:x",
    "5:x ",
    "5:x\n",
    "5.0:x",
    "1e3:x",
    "5:a b",
    `5:${idOf(256, "I")}`,
  ])("refuses %j", (cursor) => {
    expect(isCanonicalCursor(cursor)).toBe(false);
  });
});

describe("isJmapId", () => {
  it("is the Id form: 1 to 255 of A-Z a-z 0-9 _ -", () => {
    expect(isJmapId("StlqDajM7cCB")).toBe(true);
    expect(isJmapId("P-F")).toBe(true);
    expect(isJmapId("_-")).toBe(true);
    expect(isJmapId(idOf(255, "I"))).toBe(true);
    expect(isJmapId("")).toBe(false);
    expect(isJmapId(idOf(256, "I"))).toBe(false);
    expect(isJmapId("a:b")).toBe(false);
    expect(isJmapId("a\n")).toBe(false);
  });
});

describe("isRfc3339", () => {
  it.each([
    "2026-10-27T16:58:00Z",
    "2026-10-27T16:58:00.5Z",
    "2026-10-27T16:58:00.123456789+05:30",
    "2026-10-27T16:58:00-00:00",
  ])("accepts %s", (value) => {
    expect(isRfc3339(value)).toBe(true);
  });

  it.each([
    "",
    "2026-10-27",
    "2026-10-27 16:58:00Z",
    "2026-10-27T16:58:00",
    "2026-13-45T99:00:00Z",
    "2026-10-27T16:58:00Z\n",
  ])("refuses %j", (value) => {
    expect(isRfc3339(value)).toBe(false);
  });
});
