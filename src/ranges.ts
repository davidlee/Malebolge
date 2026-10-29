// Tool input ranges and their clamps (SL-008 design sec-4): a bound clamped
// into its range, and the header's one entry per clamped name. The names are
// code literals, never input, so the header cannot carry untrusted text.

/** A bound's permitted values, and the one an omitted or unusable input takes. */
export interface Range {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** A bound the tool clamped, and its final value. */
export interface Clamp<N extends string = string> {
  readonly name: N;
  readonly to: number;
}

/** One entry per name, holding its final value: the header names a bound once. */
export function report<N extends string>(clamps: Clamp<N>[], name: N, to: number): void {
  const seen = clamps.findIndex((clamp) => clamp.name === name);
  if (seen === -1) {
    clamps.push({ name, to });
  } else {
    clamps[seen] = { name, to };
  }
}

/** The value clamped into `range`; an omitted or non-integer one takes the default. */
export function bounded<N extends string>(
  raw: unknown,
  range: Range,
  name: N,
  clamps: Clamp<N>[],
): number {
  const asked = typeof raw === "number" && Number.isInteger(raw) ? raw : range.default;
  const value = Math.min(Math.max(asked, range.min), range.max);
  if (value !== asked) {
    report(clamps, name, value);
  }
  return value;
}
