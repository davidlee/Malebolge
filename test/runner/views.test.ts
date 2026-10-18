import { describe, expect, it } from "vitest";
import type { Job } from "../../src/runner/rows.ts";
import {
  isReplayed,
  jobChangedFrame,
  REPLAY_STATES,
  resultBody,
  summary,
} from "../../src/runner/views.ts";
import { JOB_STATES } from "../../src/runner/vocab.ts";
import { NEW_JOB, T0 } from "./store-fixture.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

/** A queued job as the store writes it. */
const QUEUED: Job = {
  ...NEW_JOB,
  id: "pj-1",
  state: "queued",
  stateEnteredAt: T0,
  activeMs: 0,
  pauseRequested: false,
  pauseCount: 0,
  modelRequests: 0,
  createdAt: T0,
  updatedAt: T0 + 5,
};

const REVIEWED: Job = {
  ...QUEUED,
  state: "needs_review",
  endReason: "completed",
  class: "complete",
  baseOid: "b".repeat(40),
  reviewedOid: "r".repeat(40),
  quarantineRef: "refs/quarantine/pj-1",
  modelRequests: 7,
};

describe("summary", () => {
  it("carries identity, state and times as ISO text, and omits unset fields", () => {
    expect(summary(QUEUED)).toEqual({
      jobId: "pj-1",
      state: "queued",
      submissionId: "sub-1",
      mode: "fix",
      repo: "satan",
      baseRef: "main",
      createdAt: iso(T0),
      updatedAt: iso(T0 + 5),
    });
  });

  it("adds end reason, class, reviewed oid and announcement once set", () => {
    expect(summary({ ...REVIEWED, announcedAt: T0 + 9 })).toMatchObject({
      endReason: "completed",
      class: "complete",
      reviewedOid: "r".repeat(40),
      announcedAt: iso(T0 + 9),
    });
  });
});

describe("resultBody", () => {
  it("answers a collected job with its outcome and usage", () => {
    expect(resultBody(REVIEWED)).toEqual({
      jobId: "pj-1",
      state: "needs_review",
      class: "complete",
      endReason: "completed",
      baseOid: "b".repeat(40),
      reviewedOid: "r".repeat(40),
      quarantineRef: "refs/quarantine/pj-1",
      usage: { modelRequests: 7 },
    });
  });

  it("adds the collected event's quarantine, commits and diffstat", () => {
    const commits = [{ oid: "r".repeat(40), subject: "add src/a.ts" }];
    const diffstat = { files: 1, insertions: 1, deletions: 0 };
    expect(
      resultBody(REVIEWED, { quarantine: "/q.git", quarantineRef: "x", commits, diffstat }),
    ).toMatchObject({ quarantine: "/q.git", commits, diffstat });
  });

  it("answers an uncollected job with only what it holds", () => {
    expect(resultBody(QUEUED)).toEqual({
      jobId: "pj-1",
      state: "queued",
      usage: { modelRequests: 0 },
    });
  });
});

describe("watch frames", () => {
  it("frames a job as job_changed carrying its summary", () => {
    expect(jobChangedFrame(REVIEWED)).toEqual({ event: "job_changed", job: summary(REVIEWED) });
  });

  it("replays needs_review and unannounced failed or cancelled jobs, nothing else", () => {
    const replayed = JOB_STATES.filter((state) => isReplayed({ ...QUEUED, state }));
    expect(replayed).toEqual(["needs_review", "cancelled", "failed"]);
    expect(isReplayed({ ...QUEUED, state: "failed", announcedAt: T0 })).toBe(false);
    expect(isReplayed({ ...QUEUED, state: "needs_review", announcedAt: T0 })).toBe(true);
    expect([...REPLAY_STATES].sort()).toEqual([...replayed].sort());
  });
});
