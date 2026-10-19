// Readers for untrusted JSON objects: each takes one field and returns it
// typed, or throws an Error naming the field. Callers map the Error onto
// their own error vocabulary.

import { isRecord, type JsonRecord } from "./json.ts";

/** The object a line of JSON holds. */
export function parseObject(line: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("line is not JSON");
  }
  if (!isRecord(value)) {
    throw new Error("message must be an object");
  }
  return value;
}

/** Field `key` when present and passing `guard`; `undefined` when absent. */
function optionalField<T>(
  fields: JsonRecord,
  key: string,
  guard: (value: unknown) => value is T,
  expected: string,
): T | undefined {
  const value = fields[key];
  if (value === undefined || guard(value)) {
    return value;
  }
  throw new Error(`${key} must be ${expected}`);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isPositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const isPositiveInt = (value: unknown): value is number =>
  isPositiveNumber(value) && Number.isInteger(value);
export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

export const optionalString = (fields: JsonRecord, key: string): string | undefined =>
  optionalField(fields, key, isString, "a string");

export const optionalBoolean = (fields: JsonRecord, key: string): boolean | undefined =>
  optionalField(fields, key, isBoolean, "a boolean");

export const optionalPositiveNumber = (fields: JsonRecord, key: string): number | undefined =>
  optionalField(fields, key, isPositiveNumber, "a positive number");

export const optionalPositiveInt = (fields: JsonRecord, key: string): number | undefined =>
  optionalField(fields, key, isPositiveInt, "a positive integer");

export const optionalStringArray = (fields: JsonRecord, key: string): string[] | undefined =>
  optionalField(fields, key, isStringArray, "an array of strings");

export const optionalRecord = (fields: JsonRecord, key: string): JsonRecord | undefined =>
  optionalField(fields, key, isRecord, "an object");

/** The value `read` takes from field `key`; throws when it is absent. */
export function required<T>(
  fields: JsonRecord,
  key: string,
  read: (fields: JsonRecord, key: string) => T | undefined,
): T {
  const value = read(fields, key);
  if (value === undefined) {
    throw new Error(`${key} is required`);
  }
  return value;
}

/** A non-empty string field. */
export function requireString(fields: JsonRecord, key: string): string {
  const value = fields[key];
  if (isString(value) && value !== "") {
    return value;
  }
  throw new Error(`${key} must be a non-empty string`);
}

/** A non-empty array of strings. */
export function requireStringArray(fields: JsonRecord, key: string): string[] {
  const value = fields[key];
  if (isStringArray(value) && value.length > 0) {
    return value;
  }
  throw new Error(`${key} must be a non-empty array of strings`);
}

/** `base` plus `key`, unless `value` is undefined. */
export function withOptional<T extends JsonRecord>(
  base: T,
  key: string,
  value: string | undefined,
): T {
  return value === undefined ? base : { ...base, [key]: value };
}

/** `base` with each defined entry of `optional` set. */
export function setDefined<T extends object>(
  base: T,
  optional: { [K in keyof T]?: T[K] | undefined },
): T {
  const defined = Object.entries(optional).filter(([, value]) => value !== undefined);
  return { ...base, ...Object.fromEntries(defined) };
}

/** Throws naming the first key of `fields` not in `allowed`. */
export function onlyKeys(fields: JsonRecord, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(fields).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Error(`${where}: unknown key ${unknown}`);
  }
}

/** `~` and `~/x` against `home`. */
export function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}
