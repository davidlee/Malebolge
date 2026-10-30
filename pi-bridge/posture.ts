// SL-009 design sec-3/sec-7: pi's posture section (DEC-040: corpus prose
// authored later replaces these placeholders, keyed by posture).
import type { Posture } from "./wire.ts";

/** Placeholder posture texts for pi, keyed by posture. */
export const PI_POSTURE_TEXT: Readonly<Record<Posture, string>> = {
  delegate: "[placeholder: pi bridge posture delegate]",
  consult: "[placeholder: pi bridge posture consult]",
};

/** Where SATAN runs, whatever the posture: the counterpart of the daemon's BRIDGE_ENVIRONMENT. */
export const PI_BRIDGE_ENVIRONMENT =
  "You are paired over the malebolge bridge with SATAN, an agent on a separate machine (the operator's room). " +
  "It cannot see your files, checkout or environment, and its copies of any repository are older snapshots. " +
  "Send it content, not paths or commit ids. " +
  "Only bridge_post and the malebolge-bridge command reach it; its messages arrive here as bridge messages. " +
  "In bash, `malebolge-bridge send` posts its stdin and `cmd | malebolge-bridge tee` also passes it through; " +
  "both post a note SATAN reads on its next turn, and `--turn` starts that turn now.";

/**
 * sec-7 `before_agent_start`: `systemPrompt` with the bridge environment and the
 * stored pairing's posture section appended. Pure: the shell does no I/O for it.
 */
export function withPosture(systemPrompt: string, posture: Posture): string {
  return `${systemPrompt}\n\n${PI_BRIDGE_ENVIRONMENT}\n\n${PI_POSTURE_TEXT[posture]}`;
}
