import { describe, expect, it } from "vitest";
import {
  checkSubmit,
  encodeError,
  encodeOk,
  parseRequest,
  peekRequestId,
  type Request,
} from "../../src/runner/protocol.ts";
import { exampleConfig, narrowedModes, scopedConfig } from "./config-fixture.ts";
import { codeOf } from "./refusal-fixture.ts";

const SUBMIT = {
  op: "submit",
  requestId: "r1",
  submissionId: "sat-7f3c",
  mode: "fix",
  directive: "fix the lint",
  repo: "satan",
  allowedPaths: ["satan/satan-db.el", "satan/test/"],
};

/** A valid request per op, with every optional field present. */
const FULL = {
  submit: {
    ...SUBMIT,
    baseRef: "main",
    tags: ["lint"],
    context: { proposal_id: "p1" },
    source: { mode_run_id: "m1" },
    ceilings: { model_requests: 10, cost_usd: 0.5, tokens: 1000, active_wall_clock_s: 60 },
  },
  cancel: { op: "cancel", requestId: "r2", jobId: "pj-1", reason: "no longer needed" },
  status: { op: "status", requestId: "r3", jobId: "pj-1" },
  list: { op: "list", requestId: "r4", states: ["queued", "failed"], limit: 5 },
  result: { op: "result", requestId: "r5", jobId: "pj-1" },
  "report-disposition": {
    op: "report-disposition",
    requestId: "r6",
    jobId: "pj-1",
    disposition: "promoted",
    branch: "satan/patch/pj-1",
  },
  ack: { op: "ack", requestId: "r7", jobIds: ["pj-1", "pj-2"] },
  watch: { op: "watch", requestId: "r8" },
} as const;

/** Fields each op cannot do without (besides `op` itself). */
const REQUIRED: [string, string[]][] = [
  ["submit", ["requestId", "submissionId", "mode", "directive", "repo", "allowedPaths"]],
  ["cancel", ["requestId", "jobId", "reason"]],
  ["status", ["requestId", "jobId"]],
  ["list", ["requestId"]],
  ["result", ["requestId", "jobId"]],
  ["report-disposition", ["requestId", "jobId", "disposition", "branch"]],
  ["ack", ["requestId", "jobIds"]],
  ["watch", ["requestId"]],
];

const parse = (message: unknown): Request => parseRequest(JSON.stringify(message));

const field = (message: unknown, key: string): unknown =>
  typeof message === "object" && message !== null
    ? Object.entries(message).find(([k]) => k === key)?.[1]
    : undefined;

describe("parseRequest: every op round-trips a valid request", () => {
  it.each(Object.entries(FULL))("%s", (_op, message) => {
    expect(parse(message)).toMatchObject(message);
  });

  it("submit defaults its optional collections", () => {
    expect(parse(SUBMIT)).toEqual({ ...SUBMIT, tags: [], context: {}, source: {}, ceilings: {} });
  });

  it("report-disposition rejected needs no branch", () => {
    const message = {
      op: "report-disposition",
      requestId: "r",
      jobId: "j",
      disposition: "rejected",
    };
    expect(parse(message)).toEqual(message);
  });
});

describe("parseRequest: invalid_request", () => {
  it.each(Object.entries(FULL))("refuses an unknown key on %s", (_op, message) => {
    expect(codeOf(() => parse({ ...message, surprise: 1 }))).toBe("invalid_request");
  });

  it.each(REQUIRED.flatMap(([op, keys]) => keys.map((key) => [op, key] as const)))(
    "refuses %s without %s",
    (op, key) => {
      const rest = Object.entries(FULL).find(([name]) => name === op)?.[1];
      const message = Object.fromEntries(Object.entries(rest ?? {}).filter(([k]) => k !== key));
      expect(codeOf(() => parse(message))).toBe("invalid_request");
    },
  );

  it.each([
    ["non-JSON", "not json"],
    ["a non-object", "[1]"],
    ["an unknown op", JSON.stringify({ op: "promote", requestId: "r" })],
    ["a missing op", JSON.stringify({ requestId: "r" })],
    ["an empty requestId", JSON.stringify({ ...FULL.watch, requestId: "" })],
    ["a numeric requestId", JSON.stringify({ ...FULL.watch, requestId: 7 })],
  ])("refuses %s", (_label, line) => {
    expect(codeOf(() => parseRequest(line))).toBe("invalid_request");
  });

  it.each([
    ["submit allowedPaths empty", { ...SUBMIT, allowedPaths: [] }],
    ["submit allowedPaths climbing", { ...SUBMIT, allowedPaths: ["../x"] }],
    ["submit allowedPaths absolute", { ...SUBMIT, allowedPaths: ["/etc"] }],
    ["submit allowedPaths padded", { ...SUBMIT, allowedPaths: [" satan/"] }],
    ["submit allowedPaths empty entry", { ...SUBMIT, allowedPaths: [""] }],
    ["submit tags not strings", { ...SUBMIT, tags: [1] }],
    ["submit context an array", { ...SUBMIT, context: [] }],
    ["submit source a string", { ...SUBMIT, source: "x" }],
    ["submit ceilings with unknown key", { ...SUBMIT, ceilings: { soft_threshold: 0.5 } }],
    ["submit ceiling zero", { ...SUBMIT, ceilings: { tokens: 0 } }],
    ["submit fractional model_requests", { ...SUBMIT, ceilings: { model_requests: 1.5 } }],
    ["list unknown state", { ...FULL.list, states: ["sleeping"] }],
    ["list limit zero", { ...FULL.list, limit: 0 }],
    ["ack empty jobIds", { ...FULL.ack, jobIds: [] }],
    ["disposition unknown", { ...FULL["report-disposition"], disposition: "shrugged" }],
    [
      "promoted without branch",
      { op: "report-disposition", requestId: "r", jobId: "j", disposition: "promoted" },
    ],
    [
      "rejected with branch",
      {
        op: "report-disposition",
        requestId: "r",
        jobId: "j",
        disposition: "rejected",
        branch: "b",
      },
    ],
  ])("refuses %s", (_label, message) => {
    expect(codeOf(() => parse(message))).toBe("invalid_request");
  });

  it("accepts and normalises ./satan/ as a prefix entry", () => {
    const request = parse({ ...SUBMIT, allowedPaths: ["./satan/"] });
    expect(field(request, "allowedPaths")).toEqual(["satan/"]);
  });
});

describe("parseRequest: base_ref_invalid", () => {
  it.each([
    "HEAD",
    "@",
    "refs/heads/main",
    "a..b",
    "-x",
    "/x",
    "x/",
    "x.lock",
    "x.",
    "a//b",
    "a b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[",
    "a\\b",
    "a@{1}",
    "a/.hidden",
    "a/b.lock/c",
    "tab\there",
  ])("refuses baseRef %j", (baseRef) => {
    expect(codeOf(() => parse({ ...SUBMIT, baseRef }))).toBe("base_ref_invalid");
  });

  it.each(["main", "feature/x-1", "release_2.0", "a.b/c"])("accepts baseRef %j", (baseRef) => {
    expect(field(parse({ ...SUBMIT, baseRef }), "baseRef")).toBe(baseRef);
  });

  it("a non-string baseRef is invalid_request", () => {
    expect(codeOf(() => parse({ ...SUBMIT, baseRef: 3 }))).toBe("invalid_request");
  });
});

describe("peekRequestId", () => {
  it("finds the requestId of a line that fails to parse as a request", () => {
    expect(peekRequestId(JSON.stringify({ op: "nope", requestId: "r9" }))).toBe("r9");
  });

  it.each(["not json", "[]", '{"requestId":4}', "{}"])("is null for %s", (line) => {
    expect(peekRequestId(line)).toBeNull();
  });
});

describe("responses", () => {
  it("encodeOk echoes the requestId first and spreads the body", () => {
    expect(JSON.stringify(encodeOk("r1", { jobId: "pj-1", state: "queued" }))).toBe(
      '{"requestId":"r1","ok":true,"jobId":"pj-1","state":"queued"}',
    );
  });

  it("encodeError carries code and message, with a null requestId when unknown", () => {
    expect(encodeError(null, "invalid_request", "bad")).toEqual({
      requestId: null,
      ok: false,
      error: { code: "invalid_request", message: "bad" },
    });
  });
});

describe("checkSubmit", () => {
  const config = exampleConfig();
  const submit = (message: Record<string, unknown>): Extract<Request, { op: "submit" }> => {
    const request = parse({ ...SUBMIT, ...message });
    if (request.op !== "submit") {
      throw new Error("fixture is not a submit");
    }
    return request;
  };

  it("resolves an omitted baseRef to the repo default branch", () => {
    expect(checkSubmit(submit({}), config).baseRef).toBe("main");
  });

  it("keeps an explicit baseRef", () => {
    expect(checkSubmit(submit({ baseRef: "dev" }), config).baseRef).toBe("dev");
  });

  it("refuses a repo missing from the config as invalid_request", () => {
    const request = submit({ repo: "elsewhere" });
    expect(codeOf(() => checkSubmit(request, config))).toBe("invalid_request");
    expect(() => checkSubmit(request, config)).toThrow(/unknown repo "elsewhere"/);
  });

  it("refuses a mode with no [mode.*] table as invalid_request", () => {
    const request = submit({ mode: "bogus" });
    expect(codeOf(() => checkSubmit(request, config))).toBe("invalid_request");
    expect(() => checkSubmit(request, config)).toThrow(/unknown mode "bogus"/);
  });

  describe("mode scope (DEC-069)", () => {
    const scoped = (paths: string): ReturnType<typeof exampleConfig> =>
      scopedConfig(`repos = ["satan"]\nallowed_paths = ${paths}`);

    it.each([
      ["a prefix covers itself", '["satan/"]', ["satan/"], true],
      ["a prefix covers a file under it", '["satan/"]', ["satan/satan-broker.el"], true],
      ["a prefix does not cover the bare name", '["satan/"]', ["satan"], false],
      ["a prefix does not cover a sibling", '["satan/"]', ["satanic/"], false],
      ["an exact file covers itself", '["a.el"]', ["a.el"], true],
      ["an exact file does not cover a prefix", '["a.el"]', ["a.el/"], false],
    ])("%s", (_label, modeAllows, submitted, admitted) => {
      const request = submit({ allowedPaths: submitted });
      const run = (): unknown => checkSubmit(request, scoped(modeAllows));
      if (admitted) {
        expect(run).not.toThrow();
      } else {
        expect(codeOf(run)).toBe("invalid_request");
        expect(run).toThrow(/does not allow paths .*; it allows: /);
      }
    });

    it("names only the uncovered entries, in input order", () => {
      const request = submit({ allowedPaths: ["satan/x.el", "docs/", "other.el"] });
      expect(() => checkSubmit(request, scoped('["satan/"]'))).toThrow(
        /does not allow paths docs\/, other\.el; it allows: satan\//,
      );
    });

    it("answers a repo outside the mode, and an unknown repo, with the repos the mode allows", () => {
      const request = submit({ repo: "elsewhere" });
      expect(codeOf(() => checkSubmit(request, scoped('["satan/"]')))).toBe("invalid_request");
      expect(() => checkSubmit(request, scoped('["satan/"]'))).toThrow(
        /mode "fix" does not allow repo "elsewhere"; it allows: satan/,
      );
    });

    it('"*" admits any normal path', () => {
      const request = submit({ allowedPaths: ["any/where/", "x.el"] });
      expect(() => checkSubmit(request, config)).not.toThrow();
    });

    it("refuses NEW_JOB's shape once its mode's paths narrow", () => {
      const request = submit({ allowedPaths: ["src/"] });
      const narrowed = { ...config, modes: narrowedModes() };
      expect(() => checkSubmit(request, narrowed)).toThrow(/does not allow paths src\//);
    });
  });

  it.each(["toString", "__proto__", "constructor"])(
    "treats repo %s as just another unknown name",
    (repo) => {
      expect(codeOf(() => checkSubmit(submit({ repo }), config))).toBe("invalid_request");
    },
  );
});
