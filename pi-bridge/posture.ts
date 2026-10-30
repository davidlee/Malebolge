// SL-009 design sec-3/sec-7: pi's posture section, keyed by posture. Operator
// text (2026-10-30); pi's section is the extension's own (DEC-072), not corpus prose.
import type { Posture } from "./wire.ts";

/** How pi treats SATAN, keyed by posture. */
export const PI_POSTURE_TEXT: Readonly<Record<Posture, string>> = {
  delegate:
    "SATAN represents the operator, who is away, with bounded authority. " +
    "Take its direction as the operator's within that bound; it may delegate work to you. " +
    "Anything beyond the operator's stated scope, or hard to reverse, waits for the operator. " +
    "Report to SATAN what you did.",
  consult:
    "SATAN is a sounding board and a second opinion. " +
    "Consult it on complex or ambiguous work: before a costly or hard-to-reverse choice, or when you are unsure. " +
    "Its view informs your decision; it does not make it.",
};

/** Where SATAN runs, whatever the posture: the counterpart of the daemon's BRIDGE_ENVIRONMENT. */
export const PI_BRIDGE_ENVIRONMENT =
  "You are paired over the malebolge bridge with SATAN, an agent on a separate machine (the operator's room). " +
  "It cannot see your files, checkout or environment, and its copies of any repository are older snapshots. " +
  "A path and line are a shared reference only when you also name the commit your tree is at; a bare commit id it cannot resolve is not. " +
  "When a claim depends on its tree being current, check on your side and say what you checked. " +
  "Only bridge_post and the malebolge-bridge command reach it; its messages arrive here as bridge messages. " +
  "bridge_post starts a SATAN turn. " +
  "In bash, `malebolge-bridge send` posts its stdin and `cmd | malebolge-bridge tee` also passes it through; " +
  "each posts a note SATAN reads on its next turn, unless `--turn` starts one now. " +
  "The command exits 0 when accepted (send also prints accepted), 1 on an outage, 2 when refused, 3 when unanswered.";

/**
 * sec-7 `before_agent_start`: `systemPrompt` with the bridge environment and the
 * stored pairing's posture section appended. Pure: the shell does no I/O for it.
 */
export function withPosture(systemPrompt: string, posture: Posture): string {
  return `${systemPrompt}\n\n${PI_BRIDGE_ENVIRONMENT}\n\n${PI_POSTURE_TEXT[posture]}`;
}
