/** What a caught value says: an Error's message, else its text. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
