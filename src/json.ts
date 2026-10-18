// Narrowing for parsed JSON, which arrives as `unknown`: callers check shape
// here instead of asserting a type.

export type JsonRecord = Record<string, unknown>;

/** A JSON object: not null, not an array. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
