// pi -> SATAN, the bridge's inbound direction (SL-009 design sec-4 "pi -> SATAN:
// inbound", "Withdrawal notice", "Framing and caps"; sec-5 "Loop budget"; DEC-069,
// DEC-078): one `post` or `post-once` becomes one durable submission — a turn
// (input, followed up while busy) or a note (a write the next turn's context holds)
// — and a post's turn is followed detached, appending one outbox note if it is
// withdrawn instead of delivered. A duplicate request id is accepted again and
// submits nothing.

import type {
  ConversationId,
  Submission,
  SubmissionDraft,
  SubmissionId,
} from "@earendil-works/pi-durable";
import { BRIDGE_BODY_MAX_BYTES, capHeadTail, type MessageKind } from "../../pi-bridge/wire.ts";
import { context } from "../context.ts";
import { messageOf } from "../message-of.ts";
import { type Ending, endingOf } from "../submission-ending.ts";
import { notifyBestEffort, scheduledKey } from "../task-support.ts";
import { escapeXml } from "../xml.ts";
import type { BridgeHost } from "./listener.ts";
import {
  admitTurn,
  appendOutbox,
  type Check,
  isBridged,
  pairingDoc,
  pairingSnapshot,
  refill,
} from "./pairing.ts";

/** A bridge message's entry kind, for both turn and note (data `{kind, project}`). */
export const BRIDGE_ENTRY_KIND = "satan.bridge";

/** A post's dedupe key: conversation-scoped (DEC-078). */
export const bridgeRequestId = (conversation: ConversationId, id: string): string =>
  `bridge:${String(conversation)}:${id}`;

/**
 * What the model reads: `<bridge from="pi" project="…" kind="…">…</bridge>`; project,
 * kind and the capped body all escaped, so nothing pi sends can close the envelope.
 */
export function bridgeContent(project: string, kind: MessageKind, text: string): string {
  const body = escapeXml(capHeadTail(text, BRIDGE_BODY_MAX_BYTES));
  return (
    `<bridge from="pi" project="${escapeXml(project)}" kind="${escapeXml(kind)}">` +
    `${body}</bridge>`
  );
}

/** The withdrawal notice text: one outbox note pi reads instead of a turn that never ran. */
export const notDeliveredText = (
  id: string,
  ending: Exclude<Ending, { kind: "delivered" }>,
): string => `bridge message ${id} not delivered: ${ending.kind} (${ending.reason})`;

/**
 * One watch per submission id: `start` runs only for an id not yet in `watches`, so
 * a resend on a newer connection joins the original's watch instead of adding one.
 */
export function followOnce(
  watches: Map<SubmissionId, Promise<void>>,
  id: SubmissionId,
  start: () => Promise<void>,
): void {
  if (watches.has(id)) {
    return;
  }
  watches.set(id, start());
}

/** What `submitInbound` needs: the host, and the listener-wide watch map. */
export interface Inbound {
  host: BridgeHost;
  watches: Map<SubmissionId, Promise<void>>;
}

/**
 * A turn's spend commit (DEC-078): a request id already admitted is a duplicate and
 * spends nothing; else `admitTurn` decides, and a refusal submits nothing.
 */
const admitOnce = (
  host: BridgeHost,
  conversation: ConversationId,
  requestId: string | undefined,
): Promise<Check | "duplicate"> =>
  host.session.harness.commit(async (tx) => {
    if (
      requestId !== undefined &&
      (await tx.submissionByRequest(conversation, requestId)) !== undefined
    ) {
      return "duplicate";
    }
    return admitTurn(await pairingDoc(tx, conversation));
  }, context);

/** The turn's draft: input placed as a bridge entry, followed up while the conversation is busy. */
const turnDraft = (
  project: string,
  text: string,
  requestId: string | undefined,
): SubmissionDraft => ({
  type: "input",
  whenBusy: "followUp",
  content: bridgeContent(project, "turn", text),
  entry: { kind: BRIDGE_ENTRY_KIND, data: { kind: "turn", project } },
  ...(requestId === undefined ? {} : { requestId }),
});

/** The note's draft: a write whose model content is the envelope, so the next turn sees it. */
const noteDraft = (
  host: BridgeHost,
  project: string,
  text: string,
  requestId: string | undefined,
): SubmissionDraft => ({
  type: "write",
  entry: {
    kind: BRIDGE_ENTRY_KIND,
    data: { kind: "note", project },
    model: [{ role: "user", content: bridgeContent(project, "note", text), timestamp: host.now() }],
  },
  ...(requestId === undefined ? {} : { requestId }),
});

/**
 * A turn's admission: `undefined` when its draft may be submitted, else the answer to give —
 * a duplicate's `{ok: true}`, which submits nothing and starts no watch, or a refusal.
 */
const admissionFor = async (
  host: BridgeHost,
  conversation: ConversationId,
  kind: MessageKind,
  requestId: string | undefined,
): Promise<Check | undefined> => {
  if (kind !== "turn") {
    return undefined;
  }
  const admission = await admitOnce(host, conversation, requestId);
  if (admission === "duplicate") {
    return { ok: true };
  }
  return admission.ok ? undefined : admission;
};

/** The inbound message's draft: a turn for input, a note for a write. */
const draftOf = (
  host: BridgeHost,
  project: string,
  message: { kind: MessageKind; text: string },
  requestId: string | undefined,
): SubmissionDraft =>
  message.kind === "turn"
    ? turnDraft(project, message.text, requestId)
    : noteDraft(host, project, message.text, requestId);

/**
 * Follow a post's turn to its withdrawal notice: only a post's turn is followed, since its id
 * is what a notice can name and a post-once is never retried (DEC-075). The watch is detached
 * from the caller's line chain.
 */
const followPostedTurn = (
  inbound: Inbound,
  conversation: ConversationId,
  message: { kind: MessageKind; id?: string },
  submission: Submission,
): void => {
  if (message.kind !== "turn" || message.id === undefined) {
    return;
  }
  const { host } = inbound;
  const id = message.id;
  followOnce(inbound.watches, submission.id, () =>
    watchWithdrawal(host, conversation, id, submission),
  );
};

/** Submit the draft and follow a posted turn: the answer, or the reason the submit could not be made. */
async function submitAndFollow(
  inbound: Inbound,
  conversation: ConversationId,
  message: { kind: MessageKind; id?: string },
  draft: SubmissionDraft,
): Promise<Check> {
  const { host } = inbound;
  try {
    const target = await host.session.harness.conversation(conversation, context);
    if (target === undefined) {
      return { ok: false, reason: "conversation unreachable" };
    }
    const submission = await target.submit(draft, context);
    followPostedTurn(inbound, conversation, message, submission);
    return { ok: true };
  } catch (error) {
    // The spend stands: one unit is lost with no turn (DEC-078 residual).
    return { ok: false, reason: messageOf(error) };
  }
}

/**
 * Submit one inbound message: post when `id` is given, post-once when not. `{ok: true}`
 * means queued — a duplicate included, which submits nothing and starts no watch.
 */
export async function submitInbound(
  inbound: Inbound,
  conversation: ConversationId,
  message: { kind: MessageKind; text: string; id?: string },
): Promise<Check> {
  const { host } = inbound;
  const doc = await pairingSnapshot(host.session.harness, conversation);
  const project = doc?.project ?? "";
  const requestId =
    message.id === undefined ? undefined : bridgeRequestId(conversation, message.id);
  const refusal = await admissionFor(host, conversation, message.kind, requestId);
  if (refusal !== undefined) {
    return refusal;
  }
  return submitAndFollow(
    inbound,
    conversation,
    message,
    draftOf(host, project, message, requestId),
  );
}

/** Append the notice, or say once why it could not be: no write, one log, one notify (F-4). */
async function noticeOrNotify(
  host: BridgeHost,
  conversation: ConversationId,
  notice: string,
): Promise<void> {
  let appended: { ok: true; seq: number } | { ok: false; reason: string };
  try {
    appended = await host.session.harness.commit(
      async (tx) => appendOutbox(await pairingDoc(tx, conversation), "note", notice),
      context,
    );
  } catch (error) {
    host.log(
      `bridge: conversation ${String(conversation)}: ${notice}; notice not appended: ${messageOf(error)}`,
    );
    return;
  }
  if (appended.ok) {
    return;
  }
  host.log(
    `bridge: conversation ${String(conversation)}: ${notice}; notice not appended: ${appended.reason}`,
  );
  await notifyBestEffort(
    host.satan,
    scheduledKey(conversation),
    "bridge message not delivered",
    `${notice}; ${appended.reason}`,
  );
}

/** Follow one posted turn to its settlement: a failed wait is logged once and appends nothing. */
async function watchWithdrawal(
  host: BridgeHost,
  conversation: ConversationId,
  id: string,
  submission: Submission,
): Promise<void> {
  let ending: Ending;
  try {
    ending = endingOf(await submission.wait(context));
  } catch (error) {
    host.log(
      `bridge: conversation ${String(conversation)}: message ${id}: wait failed: ${messageOf(error)}`,
    );
    return;
  }
  if (ending.kind === "delivered") {
    return;
  }
  await noticeOrNotify(host, conversation, notDeliveredText(id, ending));
}

/**
 * Refill `conversation`'s budget in its own commit when it has a bridged pairing; a
 * plain conversation is untouched, so no pairing document is ever written for it.
 */
export async function refillBridged(host: BridgeHost, conversation: ConversationId): Promise<void> {
  const doc = await pairingSnapshot(host.session.harness, conversation);
  if (doc === undefined || !isBridged(doc)) {
    return;
  }
  await host.session.harness.commit(async (tx) => {
    refill(await pairingDoc(tx, conversation));
  }, context);
}

/** `ServeOptions.onOperatorInput` for the room daemon: waits for the host, then refills. */
export const operatorRefill =
  (host: Promise<BridgeHost>) =>
  async (conversation: ConversationId): Promise<void> =>
    refillBridged(await host, conversation);
