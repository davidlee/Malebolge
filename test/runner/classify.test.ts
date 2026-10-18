import { describe, expect, it } from "vitest";
import {
  classify,
  type ClassifyInput,
  disallowedPaths,
  normaliseAllowedEntry,
  pathAllowed,
} from "../../src/runner/classify.ts";

describe("pathAllowed", () => {
  it("allows anything under a prefix entry ending in /", () => {
    const allowed = ["satan/", "test/"];
    expect(pathAllowed("satan/x.el", allowed)).toBe(true);
    expect(pathAllowed("test/y.el", allowed)).toBe(true);
    expect(pathAllowed("core/dl-path.el", allowed)).toBe(false);
  });

  it("matches an entry without a trailing / exactly", () => {
    const allowed = ["satan/satan.el"];
    expect(pathAllowed("satan/satan.el", allowed)).toBe(true);
    expect(pathAllowed("satan/satan-broker.el", allowed)).toBe(false);
    expect(pathAllowed("satan/satan.elc", allowed)).toBe(false);
  });

  it("lets a prefix entry match itself but not a sibling sharing its name", () => {
    expect(pathAllowed("satan/", ["satan/"])).toBe(true);
    expect(pathAllowed("satan-extra/x", ["satan/"])).toBe(false);
  });

  it("strips a leading ./ from entry and path alike", () => {
    expect(pathAllowed("notes/foo.md", ["./notes/"])).toBe(true);
    expect(pathAllowed("./notes/foo.md", ["notes/"])).toBe(true);
  });

  it("never matches an empty entry or an empty path", () => {
    expect(pathAllowed("x", [""])).toBe(false);
    expect(pathAllowed("", [""])).toBe(false);
    expect(pathAllowed("", ["a/"])).toBe(false);
  });

  it("never allows an absolute path or one with a .. segment, even under a prefix", () => {
    expect(pathAllowed("/etc/passwd", ["/"])).toBe(false);
    expect(pathAllowed("satan/../core/x", ["satan/"])).toBe(false);
    expect(pathAllowed("..", ["a/"])).toBe(false);
  });

  it("does not trim whitespace: a padded path is a different path", () => {
    expect(pathAllowed(" satan/x ", ["satan/"])).toBe(false);
  });
});

describe("disallowedPaths", () => {
  it("lists the offending paths in input order", () => {
    const changed = ["satan/x.el", "core/dl-faces.el", "AGENTS.md"];
    expect(disallowedPaths(changed, ["satan/"])).toEqual(["core/dl-faces.el", "AGENTS.md"]);
  });

  it("is empty when every path is allowed", () => {
    expect(disallowedPaths(["satan/x"], ["satan/"])).toEqual([]);
  });
});

describe("normaliseAllowedEntry", () => {
  it.each([
    ["./satan/", "satan/"],
    ["satan/x.el", "satan/x.el"],
    ["./a/./b", "a/./b"],
    ["a..b/c", "a..b/c"],
  ])("normalises %s to %s", (entry, expected) => {
    expect(normaliseAllowedEntry(entry)).toBe(expected);
  });

  it.each([
    ["", /empty/],
    ["./", /empty/],
    ["/etc", /absolute/],
    ["../x", /\.\./],
    ["a/../b", /\.\./],
    ["a/..", /\.\./],
    [" satan/", /whitespace/],
    ["satan/ ", /whitespace/],
  ])("refuses %j", (entry, reason) => {
    expect(() => normaliseAllowedEntry(entry)).toThrow(reason);
  });
});

const collected = (
  over: { ancestryOk?: boolean; changedPaths?: string[]; commitCount?: number } = {},
): ClassifyInput["collection"] => ({
  ok: true,
  ancestryOk: true,
  changedPaths: ["satan/x.el"],
  commitCount: 1,
  ...over,
});

const input = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  endReason: "completed",
  collection: collected(),
  allowedPaths: ["satan/"],
  ...over,
});

describe("classify", () => {
  it("one in-allowlist commit after completion is complete and needs_review", () => {
    expect(classify(input())).toEqual({
      class: "complete",
      state: "needs_review",
      flagged: false,
      offending: [],
    });
  });

  it("a path outside the allowlist is a path_violation that fails, listing the offender", () => {
    const result = classify(input({ collection: collected({ changedPaths: ["core/bad.el"] }) }));
    expect(result).toMatchObject({
      class: "path_violation",
      state: "failed",
      offending: ["core/bad.el"],
    });
  });

  it("a disallowed path in any commit of the set is a path_violation (all commits, I6)", () => {
    const paths = ["satan/a.el", "satan/b.el", "core/c.el"];
    const result = classify(
      input({ collection: collected({ changedPaths: paths, commitCount: 3 }) }),
    );
    expect(result.class).toBe("path_violation");
  });

  it("failed ancestry alone is a path_violation", () => {
    const result = classify(input({ collection: collected({ ancestryOk: false }) }));
    expect(result).toMatchObject({ class: "path_violation", state: "failed", offending: [] });
  });

  it("path_violation outranks every end_reason", () => {
    for (const endReason of ["completed", "error", "ceiling_exceeded"] as const) {
      const result = classify(
        input({ endReason, collection: collected({ changedPaths: ["core/x"] }) }),
      );
      expect(result.class).toBe("path_violation");
    }
  });

  it("no commits beyond base is no_changes and fails, even after completion", () => {
    const result = classify(input({ collection: collected({ commitCount: 0, changedPaths: [] }) }));
    expect(result).toMatchObject({ class: "no_changes", state: "failed" });
  });

  it("a collection or check error is an error that fails", () => {
    expect(classify(input({ collection: { ok: false } }))).toMatchObject({
      class: "error",
      state: "failed",
    });
  });

  it("end_reason error with valid commits is an error that fails", () => {
    expect(classify(input({ endReason: "error" }))).toMatchObject({
      class: "error",
      state: "failed",
    });
  });

  it.each(["ceiling_exceeded", "usage_unavailable", "room_unavailable"] as const)(
    "end_reason %s with valid commits is partial, flagged, and needs_review",
    (endReason) => {
      expect(classify(input({ endReason }))).toEqual({
        class: "partial",
        state: "needs_review",
        flagged: true,
        offending: [],
      });
    },
  );

  it("a cancelled job with commits is cancelled, its class still recorded", () => {
    const result = classify(input({ endReason: "cancelled" }));
    expect(result.state).toBe("cancelled");
    expect(result.class).toBe("partial");
    expect(result.flagged).toBe(false);
  });

  it("a cancelled job that broke the allowlist is cancelled with path_violation recorded", () => {
    const result = classify(
      input({ endReason: "cancelled", collection: collected({ changedPaths: ["core/x"] }) }),
    );
    expect(result).toMatchObject({ class: "path_violation", state: "cancelled" });
  });

  it("a cancelled job with no commits is cancelled, recorded no_changes", () => {
    const result = classify(
      input({
        endReason: "cancelled",
        collection: collected({ commitCount: 0, changedPaths: [] }),
      }),
    );
    expect(result).toMatchObject({ class: "no_changes", state: "cancelled" });
  });

  it("a cancelled job whose collection failed is cancelled, recorded error", () => {
    const result = classify(input({ endReason: "cancelled", collection: { ok: false } }));
    expect(result).toMatchObject({ class: "error", state: "cancelled" });
  });
});
