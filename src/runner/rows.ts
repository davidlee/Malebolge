// The job store's column codec (design §5.3): the one place model values and
// SQLite columns convert. Times are epoch ms in the model and ISO-8601 UTC
// text with milliseconds in a column (lexical order is time order); flags are
// booleans and 0/1; JSON fields are text; an absent optional field is NULL.
// Pure. Decoding is strict: a column holding anything the encoder could not
// have written is a corrupt row, and throws.

import type { SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { isStringArray, setDefined } from "../fields.ts";
import { isRecord, type JsonRecord } from "../json.ts";
import { type Ceilings, readCeilings } from "./config.ts";
import type { JobRecord } from "./jobs.ts";
import type { SubmitRequest } from "./protocol.ts";
import {
  type EndReason,
  type EventKind,
  isEndReason,
  isEventKind,
  isJobClass,
  isJobState,
  type JobClass,
} from "./vocab.ts";

/** A validated submission, its base ref resolved: what `submit` stores. */
export type NewJob = Omit<SubmitRequest, "op" | "requestId" | "baseRef"> & { baseRef: string };

/** A `jobs` row. */
export interface Job extends JobRecord, NewJob {
  id: string;
  conversationId?: string;
  /** Resolved ladder output, set at preparing. */
  policy?: JsonRecord;
  baseOid?: string;
  endReason?: EndReason;
  stateEnteredAt: number;
  modelRequests: number;
  /** Immutable once set. */
  reviewedOid?: string;
  quarantineRef?: string;
  class?: JobClass;
  failure?: JsonRecord;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** A failed/cancelled notice acked by Emacs. */
  announcedAt?: number;
}

/** A `job_events` row: append-only audit (DEC-057). */
export interface JobEvent {
  seq: number;
  jobId: string;
  at: number;
  kind: EventKind;
  payload: JsonRecord;
}

/** An event before the store numbers it. */
export type NewEvent = Omit<JobEvent, "seq">;

/** A column's values: SQL row. */
export type Row = Record<string, SqliteValue>;

interface Codec<T> {
  encode: (value: T) => SqliteValue;
  /** Throws naming what the column should hold. */
  decode: (raw: unknown) => T;
}

// --- codecs by kind ----------------------------------------------------------

const MAX_TIME = Date.parse("9999-12-31T23:59:59.999Z");

/** Within the four-digit-year range, where ISO text sorts in time order. */
const isEpochMs = (ms: number): boolean => Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_TIME;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Epoch ms as the ISO-8601 UTC text a time column holds; the wire uses it too. */
export function isoTime(ms: number): string {
  if (!isEpochMs(ms)) {
    throw new Error(`time must be integer epoch ms in years 1970-9999: ${String(ms)}`);
  }
  return new Date(ms).toISOString();
}

const time: Codec<number> = {
  encode: isoTime,
  decode: (raw) => {
    const ms = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (isEpochMs(ms) && new Date(ms).toISOString() === raw) {
      return ms;
    }
    throw new Error("must be ISO-8601 UTC text with milliseconds");
  },
};

const flag: Codec<boolean> = {
  encode: (value) => (value ? 1 : 0),
  decode: (raw) => {
    if (raw === 0 || raw === 1) {
      return raw === 1;
    }
    throw new Error("must be 0 or 1");
  },
};

const count: Codec<number> = {
  encode: (value) => {
    if (!isCount(value)) {
      throw new Error(`count must be a non-negative integer: ${String(value)}`);
    }
    return value;
  },
  decode: (raw) => {
    if (isCount(raw)) {
      return raw;
    }
    throw new Error("must be a non-negative integer");
  },
};

const text: Codec<string> = {
  encode: (value) => value,
  decode: (raw) => {
    if (typeof raw === "string") {
      return raw;
    }
    throw new Error("must be text");
  },
};

/** Text holding one member of a closed vocabulary. */
function member<T extends string>(isMember: (value: string) => value is T): Codec<T> {
  const codec: Codec<T> = {
    encode: (value) => value,
    decode: (raw) => {
      if (typeof raw === "string" && isMember(raw)) {
        return raw;
      }
      throw new Error("is not a known value");
    },
  };
  return codec;
}

/** JSON text whose parsed value `read` accepts (or throws on). */
function json<T>(read: (value: unknown) => T): Codec<T> {
  const codec: Codec<T> = {
    encode: (value) => JSON.stringify(value),
    decode: (raw) => {
      if (typeof raw !== "string") {
        throw new Error("must be JSON text");
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error("is not JSON");
      }
      return read(value);
    },
  };
  return codec;
}

const guarded =
  <T>(guard: (value: unknown) => value is T, expected: string): ((value: unknown) => T) =>
  (value) => {
    if (guard(value)) {
      return value;
    }
    throw new Error(`must hold ${expected}`);
  };

const object = json(guarded(isRecord, "an object"));
const stringArray = json(guarded(isStringArray, "an array of strings"));
const ceilings = json(
  (value): Partial<Ceilings> => readCeilings(guarded(isRecord, "an object")(value)),
);

/** NULL for an absent value. */
const optional = <T>(codec: Codec<T>): Codec<T | undefined> => ({
  encode: (value) => (value === undefined ? null : codec.encode(value)),
  decode: (raw) => (raw === null ? undefined : codec.decode(raw)),
});

// --- jobs ----------------------------------------------------------------------

type JobField = keyof Job;

/** Each field's codec, in `jobs` column order (BINDING: the v1 DDL's order). */
const JOB_CODECS: { [K in JobField]: Codec<Job[K]> } = {
  id: text,
  submissionId: text,
  conversationId: optional(text),
  state: member(isJobState),
  mode: text,
  directive: text,
  repo: text,
  baseRef: text,
  allowedPaths: stringArray,
  tags: stringArray,
  context: object,
  source: object,
  ceilings,
  policy: optional(object),
  baseOid: optional(text),
  endReason: optional(member(isEndReason)),
  pauseRequested: flag,
  pauseCount: count,
  stateEnteredAt: time,
  runningSince: optional(time),
  activeMs: count,
  modelRequests: count,
  reviewedOid: optional(text),
  quarantineRef: optional(text),
  class: optional(member(isJobClass)),
  failure: optional(object),
  createdAt: time,
  updatedAt: time,
  startedAt: optional(time),
  finishedAt: optional(time),
  announcedAt: optional(time),
};

const isJobField = (key: string): key is JobField => key in JOB_CODECS;

/** Every job field, in column order. */
export const JOB_FIELDS: readonly JobField[] = Object.keys(JOB_CODECS).filter(isJobField);

/** The column holding `field`: its snake-case name. */
export const columnOf = (field: string): string =>
  field.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** A row's key for messages; never throws, whatever the column holds. */
const label = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? JSON.stringify(value) : "?";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Column `column` of `row` through `codec`; a refusal names the row. */
function decodeColumn<T>(where: string, row: JsonRecord, column: string, codec: Codec<T>): T {
  try {
    return codec.decode(row[column]);
  } catch (error) {
    throw new Error(`corrupt ${where}: ${column} ${errorMessage(error)}`, { cause: error });
  }
}

const encodeField = <K extends JobField>(job: Pick<Job, K>, field: K): SqliteValue =>
  JOB_CODECS[field].encode(job[field]);

/** `job` as a `jobs` row keyed by column, in column order. */
export function encodeJob(job: Job): Row {
  return Object.fromEntries(JOB_FIELDS.map((field) => [columnOf(field), encodeField(job, field)]));
}

/** The job a `jobs` row holds; throws on a corrupt row. */
export function decodeJob(row: JsonRecord): Job {
  const where = `jobs row ${label(row["id"])}`;
  const field = <K extends JobField>(key: K): Job[K] =>
    decodeColumn(where, row, columnOf(key), JOB_CODECS[key]);
  return setDefined<Job>(
    {
      id: field("id"),
      submissionId: field("submissionId"),
      state: field("state"),
      mode: field("mode"),
      directive: field("directive"),
      repo: field("repo"),
      baseRef: field("baseRef"),
      allowedPaths: field("allowedPaths"),
      tags: field("tags"),
      context: field("context"),
      source: field("source"),
      ceilings: field("ceilings"),
      pauseRequested: field("pauseRequested"),
      pauseCount: field("pauseCount"),
      stateEnteredAt: field("stateEnteredAt"),
      activeMs: field("activeMs"),
      modelRequests: field("modelRequests"),
      createdAt: field("createdAt"),
      updatedAt: field("updatedAt"),
    },
    {
      conversationId: field("conversationId"),
      policy: field("policy"),
      baseOid: field("baseOid"),
      endReason: field("endReason"),
      runningSince: field("runningSince"),
      reviewedOid: field("reviewedOid"),
      quarantineRef: field("quarantineRef"),
      class: field("class"),
      failure: field("failure"),
      startedAt: field("startedAt"),
      finishedAt: field("finishedAt"),
      announcedAt: field("announcedAt"),
    },
  );
}

// --- job_events ----------------------------------------------------------------

const eventKind = member(isEventKind);

/** `event` as a `job_events` row; `seq` is SQLite's. */
export function encodeEvent(event: NewEvent): Row {
  return {
    job_id: event.jobId,
    at: time.encode(event.at),
    kind: event.kind,
    payload: object.encode(event.payload),
  };
}

/** The event a `job_events` row holds; throws on a corrupt row. */
export function decodeEvent(row: JsonRecord): JobEvent {
  const where = `job_events row ${label(row["seq"])}`;
  return {
    seq: decodeColumn(where, row, "seq", count),
    jobId: decodeColumn(where, row, "job_id", text),
    at: decodeColumn(where, row, "at", time),
    kind: decodeColumn(where, row, "kind", eventKind),
    payload: decodeColumn(where, row, "payload", object),
  };
}

// --- job_schema ------------------------------------------------------------------

/** The version `job_schema` holds; it holds exactly one row. */
export function decodeSchemaVersion(rows: readonly JsonRecord[]): number {
  const [row, ...rest] = rows;
  if (row === undefined || rest.length > 0) {
    throw new Error(`corrupt job_schema: ${String(rows.length)} rows, expected 1`);
  }
  return decodeColumn("job_schema", row, "version", count);
}
