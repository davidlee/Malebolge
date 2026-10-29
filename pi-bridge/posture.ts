// SL-009 design sec-3/sec-7: pi's posture section (DEC-040: corpus prose
// authored later replaces these placeholders, keyed by posture).
import type { Posture } from "./wire.ts";

/** Placeholder posture texts for pi, keyed by posture. */
export const PI_POSTURE_TEXT: Readonly<Record<Posture, string>> = {
  delegate: "[placeholder: pi bridge posture delegate]",
  consult: "[placeholder: pi bridge posture consult]",
};

/**
 * sec-7 `before_agent_start`: `systemPrompt` with the stored pairing's posture
 * section appended. Pure: the shell does no I/O for it.
 */
export function withPosture(systemPrompt: string, posture: Posture): string {
  return `${systemPrompt}\n\n${PI_POSTURE_TEXT[posture]}`;
}
