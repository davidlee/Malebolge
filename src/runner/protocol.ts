// The control socket schema (design §5.2, DEC-058): one JSON object per line,
// every operation parsed in full before any effect. Pure: the socket server
// (control.ts) owns the I/O. Unknown keys and invalid values are refused.

import {
  onlyKeys,
  optionalPositiveInt,
  optionalRecord,
  optionalString,
  optionalStringArray,
  parseObject,
  requireString,
  requireStringArray,
  setDefined,
} from "../fields.ts";
import type { JsonRecord } from "../json.ts";
import {
  CEILING_KEYS,
  type Ceilings,
  readCeilings,
  type RepoConfig,
  type RunnerConfig,
} from "./config.ts";
import { normaliseAllowedEntry } from "./classify.ts";
import { type ErrorCode, isRunnerError, RunnerError } from "./errors.ts";
import { JOB_STATES, type JobState } from "./vocab.ts";

export interface SubmitRequest {
  op: "submit";
  requestId: string;
  submissionId: string;
  mode: string;
  directive: string;
  repo: string;
  allowedPaths: string[];
  /** Absent until `checkSubmit` resolves it against the repo's default branch. */
  baseRef?: string;
  tags: string[];
  context: JsonRecord;
  source: JsonRecord;
  /** Values that may only lower the configured maxima. */
  ceilings: Partial<Ceilings>;
}

export interface ListRequest {
  op: "list";
  requestId: string;
  states?: JobState[];
  limit?: number;
}

interface DispositionBase {
  op: "report-disposition";
  requestId: string;
  jobId: string;
}

export type Request =
  | SubmitRequest
  | { op: "cancel"; requestId: string; jobId: string; reason: string }
  | { op: "status"; requestId: string; jobId: string }
  | ListRequest
  | { op: "result"; requestId: string; jobId: string }
  | (DispositionBase & { disposition: "promoted"; branch: string })
  | (DispositionBase & { disposition: "rejected" })
  | { op: "ack"; requestId: string; jobIds: string[] }
  | { op: "watch"; requestId: string };

type OpRequest<K extends Request["op"]> = Extract<Request, { op: K }>;
type Handlers = {
  [K in Request["op"]]: (fields: JsonRecord, requestId: string) => OpRequest<K>;
};

/** Refuses any key of `fields` outside `op`, `requestId` and `own`. */
function closed(fields: JsonRecord, op: Request["op"], own: readonly string[]): void {
  onlyKeys(fields, ["op", "requestId", ...own], op);
}

// --- base ref shape (git check-ref-format --branch, minus existence) ------

const BASE_REF_FLAWS: readonly (readonly [RegExp, string])[] = [
  [/^(?:@|HEAD|)$/, "is not a branch name"],
  [/^refs\//, "must be a short branch name, not a full ref"],
  [/^[-/]/, "starts with - or /"],
  [/(?:[/.]|\.lock)$/, "ends with /, . or .lock"],
  [/\.\.|\/\/|@\{/, "contains .., // or @{"],
  [/[\u0000-\u0020\u007f~^:?*[\\]/, "contains a space, control or forbidden character"],
  [/(?:^|\/)\.|\.lock(?:\/|$)/, "has a component starting with . or ending in .lock"],
];

/** `ref` when it is shaped like a branch name; otherwise `base_ref_invalid`. */
function checkBaseRefShape(ref: string): string {
  const flaw = BASE_REF_FLAWS.find(([flaw]) => flaw.test(ref));
  if (flaw !== undefined) {
    throw new RunnerError("base_ref_invalid", `baseRef ${JSON.stringify(ref)} ${flaw[1]}`);
  }
  return ref;
}

// --- per-op readers ---------------------------------------------------------

function readCeilingsField(fields: JsonRecord): Partial<Ceilings> {
  const ceilings = optionalRecord(fields, "ceilings") ?? {};
  onlyKeys(ceilings, CEILING_KEYS, "ceilings");
  return readCeilings(ceilings);
}

function readSubmit(fields: JsonRecord, requestId: string): SubmitRequest {
  closed(fields, "submit", [
    "submissionId",
    "mode",
    "directive",
    "repo",
    "allowedPaths",
    "baseRef",
    "tags",
    "context",
    "source",
    "ceilings",
  ]);
  const baseRef = optionalString(fields, "baseRef");
  return setDefined<SubmitRequest>(
    {
      op: "submit",
      requestId,
      submissionId: requireString(fields, "submissionId"),
      mode: requireString(fields, "mode"),
      directive: requireString(fields, "directive"),
      repo: requireString(fields, "repo"),
      allowedPaths: requireStringArray(fields, "allowedPaths").map(normaliseAllowedEntry),
      tags: optionalStringArray(fields, "tags") ?? [],
      context: optionalRecord(fields, "context") ?? {},
      source: optionalRecord(fields, "source") ?? {},
      ceilings: readCeilingsField(fields),
    },
    { baseRef: baseRef === undefined ? undefined : checkBaseRefShape(baseRef) },
  );
}

const isJobState = (value: string): value is JobState =>
  JOB_STATES.some((state) => state === value);

function readStates(fields: JsonRecord): JobState[] | undefined {
  const states = optionalStringArray(fields, "states");
  const unknown = states?.find((state) => !isJobState(state));
  if (unknown !== undefined) {
    throw new Error(`states: unknown state ${unknown}`);
  }
  return states?.filter(isJobState);
}

function readList(fields: JsonRecord, requestId: string): ListRequest {
  closed(fields, "list", ["states", "limit"]);
  return setDefined<ListRequest>(
    { op: "list", requestId },
    { states: readStates(fields), limit: optionalPositiveInt(fields, "limit") },
  );
}

function readDisposition(fields: JsonRecord, requestId: string): OpRequest<"report-disposition"> {
  closed(fields, "report-disposition", ["jobId", "disposition", "branch"]);
  const base = {
    op: "report-disposition",
    requestId,
    jobId: requireString(fields, "jobId"),
  } as const;
  const disposition = requireString(fields, "disposition");
  if (disposition === "promoted") {
    return { ...base, disposition, branch: requireString(fields, "branch") };
  }
  if (disposition !== "rejected") {
    throw new Error("disposition must be promoted or rejected");
  }
  if (fields["branch"] !== undefined) {
    throw new Error("branch is only for a promoted disposition");
  }
  return { ...base, disposition };
}

const HANDLERS: Handlers = {
  submit: readSubmit,
  cancel: (fields, requestId) => {
    closed(fields, "cancel", ["jobId", "reason"]);
    return {
      op: "cancel",
      requestId,
      jobId: requireString(fields, "jobId"),
      reason: requireString(fields, "reason"),
    };
  },
  status: (fields, requestId) => {
    closed(fields, "status", ["jobId"]);
    return { op: "status", requestId, jobId: requireString(fields, "jobId") };
  },
  list: readList,
  result: (fields, requestId) => {
    closed(fields, "result", ["jobId"]);
    return { op: "result", requestId, jobId: requireString(fields, "jobId") };
  },
  "report-disposition": readDisposition,
  ack: (fields, requestId) => {
    closed(fields, "ack", ["jobIds"]);
    return { op: "ack", requestId, jobIds: requireStringArray(fields, "jobIds") };
  },
  watch: (fields, requestId) => {
    closed(fields, "watch", []);
    return { op: "watch", requestId };
  },
};

const isOp = (value: unknown): value is Request["op"] =>
  typeof value === "string" && Object.hasOwn(HANDLERS, value);

function readRequest(fields: JsonRecord): Request {
  const requestId = requireString(fields, "requestId");
  const op = fields["op"];
  if (!isOp(op)) {
    throw new Error(`unknown op ${JSON.stringify(op)}`);
  }
  return HANDLERS[op](fields, requestId);
}

/**
 * The request on `line`. Throws `RunnerError`: `base_ref_invalid` for a
 * malformed baseRef, `invalid_request` for anything else wrong.
 */
export function parseRequest(line: string): Request {
  try {
    return readRequest(parseObject(line));
  } catch (error) {
    if (isRunnerError(error)) {
      throw error;
    }
    throw new RunnerError(
      "invalid_request",
      error instanceof Error ? error.message : String(error),
      {
        cause: error,
      },
    );
  }
}

/** The `requestId` of a line that may not be a valid request; `null` if it has none. */
export function peekRequestId(line: string): string | null {
  try {
    const requestId = parseObject(line)["requestId"];
    return typeof requestId === "string" && requestId !== "" ? requestId : null;
  } catch {
    return null;
  }
}

// --- responses ---------------------------------------------------------------

export type Response =
  | ({ requestId: string; ok: true } & JsonRecord)
  | { requestId: string | null; ok: false; error: { code: ErrorCode; message: string } };

export const encodeOk = (requestId: string, body: JsonRecord): Response => ({
  requestId,
  ok: true,
  ...body,
});

export const encodeError = (
  requestId: string | null,
  code: ErrorCode,
  message: string,
): Response => ({
  requestId,
  ok: false,
  error: { code, message },
});

// --- config-dependent submit checks ------------------------------------------

type SubmitCheck = (request: SubmitRequest, config: RunnerConfig) => void;

function knownRepo(request: SubmitRequest, config: RunnerConfig): RepoConfig {
  const repo = config.repos.get(request.repo);
  if (repo === undefined) {
    throw new RunnerError("invalid_request", `unknown repo ${JSON.stringify(request.repo)}`);
  }
  return repo;
}

function knownMode(request: SubmitRequest, config: RunnerConfig): void {
  if (!config.modes.has(request.mode)) {
    throw new RunnerError("invalid_request", `unknown mode ${JSON.stringify(request.mode)}`);
  }
}

/** Further checks that need the config (e.g. ceilings against maxima) join here. */
const SUBMIT_CHECKS: readonly SubmitCheck[] = [knownMode];

/**
 * `request` checked against `config`, with an omitted `baseRef` resolved to
 * the repo's default branch. Existence of the branch is the git layer's check.
 */
export function checkSubmit(
  request: SubmitRequest,
  config: RunnerConfig,
): SubmitRequest & { baseRef: string } {
  const repo = knownRepo(request, config);
  for (const check of SUBMIT_CHECKS) {
    check(request, config);
  }
  return { ...request, baseRef: request.baseRef ?? repo.defaultBranch };
}
