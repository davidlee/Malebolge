// How a host bound names itself in an error or a journal line.

const HOUR_MS = 60 * 60 * 1000;

/** `ms` as a bound names it: whole hours as `2h`, anything else in milliseconds. */
export const durationOf = (ms: number): string =>
  ms % HOUR_MS === 0 ? `${(ms / HOUR_MS).toString()}h` : `${ms.toString()}ms`;
