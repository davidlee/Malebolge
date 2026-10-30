// SL-009 design sec-7, DEC-073: the loud failure texts. One outageText serves
// the extension (index.ts via shell.ts) and the command (malebolge-bridge).
// Imported by the command, so: node-only, erasable TypeScript, no pi packages.
import { spawn } from "node:child_process";
import type { Notice } from "./state.ts";

/** What a failure names, as far as known (DEC-073). Never the token. */
export interface Ends {
  /** pi's project root basename. */
  project: string;
  socket: string;
  /** pi's session id. */
  session?: string;
  conversation?: string;
}

/** Best-effort desktop notification (ASM-005: may fail in the jail; never throws). */
export type NotifyDesktop = (summary: string, body: string) => void;

/** The summary a desktop notification carries: what failed, in two words. */
export const OUTAGE_SUMMARY = "malebolge bridge";

/** `text` with its line breaks folded: a notice is one line. */
function oneLine(text: string): string {
  return text.replaceAll(/\s*[\r\n]+\s*/g, " ").trim();
}

/** Every known end as one clause, in the order a reader looks for them: never empty. */
function endsText(ends: Ends): string {
  const parts = [`project ${ends.project}`];
  if (ends.session !== undefined && ends.session !== "") {
    parts.push(`pi session ${ends.session}`);
  }
  if (ends.conversation !== undefined && ends.conversation !== "") {
    parts.push(`conversation ${ends.conversation}`);
  }
  parts.push(`socket ${ends.socket}`);
  return parts.join(", ");
}

/** The text of an outage or a not-bound call: names every known end; `reason` when one is known. */
export function outageText(ends: Ends, reason?: string): string {
  const why = reason === undefined || reason === "" ? "not connected" : reason;
  return oneLine(`${OUTAGE_SUMMARY}: ${why}; ${endsText(ends)}`);
}

/** A post whose reply never came: outcome unknown, not resent, naming the ends. */
export function unknownText(ends: Ends): string {
  return oneLine(`${OUTAGE_SUMMARY}: outcome unknown, not resent; ${endsText(ends)}`);
}

/** The notices that only state what happened: no reason, no phase, nothing to look up. */
type QuietNotice = Extract<
  Notice,
  {
    kind:
      | "recovered"
      | "forked pairing"
      | "end unanswered"
      | "ended"
      | "ended locally"
      | "not paired";
  }
>;

/** The text of a notice that carries no reason of its own. */
function quietText(notice: QuietNotice, ends: Ends): string {
  switch (notice.kind) {
    case "recovered":
      return oneLine(`${OUTAGE_SUMMARY}: reconnected; ${endsText(ends)}`);
    case "forked pairing":
      return oneLine(
        `${OUTAGE_SUMMARY}: this session is a fork; the pairing stays with the session that made it`,
      );
    case "end unanswered":
      return oneLine(
        `${OUTAGE_SUMMARY}: the daemon did not answer the end; the pairing here is dropped`,
      );
    case "ended":
      return oneLine(`${OUTAGE_SUMMARY}: pairing ended`);
    case "ended locally":
      return oneLine(
        `${OUTAGE_SUMMARY}: pairing dropped here only; the daemon's pairing is left as is`,
      );
    case "not paired":
      return oneLine(
        `${OUTAGE_SUMMARY}: not paired; run /bridge pair delegate or /bridge pair consult`,
      );
  }
}

/** The text of one state.ts notice. */
export function noticeText(notice: Notice, ends: Ends): string {
  if (notice.kind === "outage") {
    return outageText(ends, notice.reason);
  }
  if (notice.kind === "pair failed") {
    return pairFailedText(notice, ends);
  }
  if (notice.kind === "refused") {
    return oneLine(`${OUTAGE_SUMMARY}: refused: ${notice.reason}`);
  }
  if (notice.kind === "busy") {
    return oneLine(
      `${OUTAGE_SUMMARY}: busy (${notice.phase}); end the current pairing first, or wait for reconnect`,
    );
  }
  return quietText(notice, ends);
}

/** A `pair failed` notice: the reason, and whether the daemon may have kept a pairing it made. */
type PairFailed = Extract<Notice, { kind: "pair failed" }>;

/** The conversation a failed pair may have left the daemon paired with: by id when known. */
function pairedConversation(notice: PairFailed): string {
  return notice.conversation === undefined || notice.conversation === ""
    ? "the attached conversation"
    : `conversation ${notice.conversation}`;
}

/**
 * A failed pairing: the reason, and whether the daemon may have kept a pairing.
 * Pair creates nothing now (DEC-104), so the clause names what it may have
 * paired, never a conversation it may have created.
 */
function pairFailedText(notice: PairFailed, ends: Ends): string {
  const paired = notice.mayHavePaired
    ? `; the daemon may have paired ${pairedConversation(notice)}`
    : "";
  return oneLine(`${OUTAGE_SUMMARY}: pairing failed: ${notice.reason}${paired}; ${endsText(ends)}`);
}

/** `notify-send summary body`, detached; a missing binary or failure is swallowed. */
export const notifyDesktop: NotifyDesktop = (summary, body) => {
  try {
    const child = spawn("notify-send", [summary, body], { stdio: "ignore", detached: true });
    // ENOENT arrives as an event, not a throw: a missing notify-send is not the caller's problem.
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Swallowed on purpose: a desktop notification is best-effort (ASM-005).
  }
};
