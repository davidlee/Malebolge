// Local time with its offset: what the wake tools return, and what the wake
// input and the journal show. The model reads the quiet window in its own zone,
// so a UTC `Z` would misname the times it reasons about.

/** `ms` as ISO-8601 local time with its offset: the zone the quiet window is read in. */
export const localIso = (ms: number): string => {
  const date = new Date(ms);
  const pad = (n: number, width = 2): string =>
    String(Math.trunc(Math.abs(n))).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const zone =
    offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${zone}`
  );
};
