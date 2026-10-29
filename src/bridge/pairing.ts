// The pairing document (SL-009 design sec-3, DEC-065, DEC-072): one conversation's
// bridge pairing — the hash of the token pi holds, the stored posture, the outbox
// and the turn budget — and every pure rule over it, so the tests exercise the
// rules on plain values without a socket. Conversation scope, forked `initial`: a
// fork of a bridged conversation is not bridged and inherits no token hash.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type ConversationId,
  type DocumentObserver,
  type DocumentReader,
  type DocumentWatch,
  defineDoc,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  BRIDGE_BODY_MAX_BYTES,
  capHeadTail,
  type MessageKind,
  type Posture,
} from "../../pi-bridge/wire.ts";
import { context } from "../context.ts";

/** Unacked messages kept before pi is told it is not draining (DEC-066). */
export const BRIDGE_OUTBOX_CAP = 32;

/** Bridge-started SATAN turns admitted between refills (DEC-070). */
export const BRIDGE_TURN_BUDGET = 10;

/* eslint-disable @typescript-eslint/consistent-type-definitions -- document values are JSON: a type alias, as IndexDoc's, satisfies defineDoc's JsonObject bound */
/** One message SATAN left for pi: its seq, what it is, and the text capped at the body cap. */
export type OutboxEntry = { seq: number; kind: MessageKind; text: string };

/** What one conversation's pairing holds; the empty value is "not bridged". */
export type PairingDoc = {
  /** sha256(token) hex; `""` = no pairing (the document's initial value). */
  tokenHash: string;
  /** Stored at pair, never changed: a new posture is a new pairing (DEC-072). */
  posture: Posture;
  /** The project that named the topic; naming only (DEC-065). */
  project: string;
  ended: boolean;
  /** The outbox allocator: a seq is never reused (DEC-066). */
  nextSeq: number;
  outbox: OutboxEntry[];
  /** Bridge-started SATAN turns since the last refill (DEC-070). */
  spent: number;
};
/* eslint-enable @typescript-eslint/consistent-type-definitions */

/**
 * The pairing document. Not exported: `pairingDoc` is the only accessor, so
 * nothing outside this module names the document. Conversation scope and one
 * checkpoint every 50 deltas, as the topic index (`src/topics.ts`).
 */
const PairingDocument = defineDoc<PairingDoc>({
  kind: "malebolge.bridge",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    tokenHash: "",
    posture: "delegate",
    project: "",
    ended: false,
    nextSeq: 1,
    outbox: [],
    spent: 0,
  }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** `conversation`'s pairing, read in the caller's commit. */
export const pairingDoc = (tx: Tx, conversation: ConversationId): Promise<PairingDoc> =>
  tx.doc(PairingDocument, conversation);

/**
 * `conversation`'s committed pairing, read without a commit: `undefined` when no
 * commit ever wrote it, so a read that refuses (a resume of a plain conversation)
 * writes nothing.
 */
export const pairingSnapshot = (
  reader: Pick<DocumentReader, "snapshot">,
  conversation: ConversationId,
): Promise<Readonly<PairingDoc> | undefined> =>
  reader.snapshot(PairingDocument, conversation, context);

/**
 * A non-creating watch on `conversation`'s pairing: `undefined` when no commit ever
 * wrote it, so a bound bridge connection follows a pairing without creating one.
 */
export const watchPairing = (
  observer: Pick<DocumentObserver, "watchDoc">,
  conversation: ConversationId,
): Promise<DocumentWatch<PairingDoc> | undefined> =>
  observer.watchDoc(PairingDocument, conversation, context);

/** Whether a pairing was ever opened on `doc`: only its token hash says so. */
export const isBridged = (doc: PairingDoc): boolean => doc.tokenHash !== "";

/** A fresh token: 32 random bytes, base64url (sent once, stored only as its hash). */
export const mintToken = (): string => randomBytes(32).toString("base64url");

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

/** `token`'s sha256, hex: what the document stores (DEC-065). */
export const hashToken = (token: string): string => digest(token).toString("hex");

/** Whether the stored hash and the presented token agree, in constant time. */
const sameHash = (stored: string, token: string): boolean =>
  timingSafeEqual(digest(stored), digest(hashToken(token)));

/** Open a pairing on `doc`: a fresh token hash, posture and project, and nothing else left over. */
export function openPairing(
  doc: PairingDoc,
  posture: Posture,
  project: string,
  token: string,
): void {
  doc.tokenHash = hashToken(token);
  doc.posture = posture;
  doc.project = project;
  doc.ended = false;
  doc.nextSeq = 1;
  doc.outbox = [];
  doc.spent = 0;
}

/** Yes or the refusal `checkToken` reads; every rule states its own reason. */
export type Check = { ok: true } | { ok: false; reason: string };

/**
 * Whether `token` resumes this pairing: not bridged, then a bad token, then an
 * ended pairing. The token is judged before `ended`, so the state of a pairing is
 * never told to a caller that does not hold it.
 */
export function checkToken(doc: PairingDoc, token: string): Check {
  if (!isBridged(doc)) {
    return { ok: false, reason: "not a bridged conversation" };
  }
  if (!sameHash(doc.tokenHash, token)) {
    return { ok: false, reason: "bad token" };
  }
  if (doc.ended) {
    return { ok: false, reason: "pairing ended" };
  }
  return { ok: true };
}

/** Append one message to the outbox, capped head-and-tail; its seq, or the refusal. */
export function appendOutbox(
  doc: PairingDoc,
  kind: MessageKind,
  text: string,
): { ok: true; seq: number } | { ok: false; reason: string } {
  if (!isBridged(doc)) {
    return { ok: false, reason: "not a bridged conversation" };
  }
  if (doc.ended) {
    return { ok: false, reason: "pairing ended" };
  }
  if (doc.outbox.length >= BRIDGE_OUTBOX_CAP) {
    return { ok: false, reason: "outbox full, pi is not draining" };
  }
  const seq = doc.nextSeq;
  doc.outbox.push({ seq, kind, text: capHeadTail(text, BRIDGE_BODY_MAX_BYTES) });
  doc.nextSeq = seq + 1;
  return { ok: true, seq };
}

/** Forget the entry with exactly `seq`: false when no entry carries it (an unknown or repeated ack). */
export function ackEntry(doc: PairingDoc, seq: number): boolean {
  const at = doc.outbox.findIndex((entry) => entry.seq === seq);
  if (at < 0) {
    return false;
  }
  doc.outbox.splice(at, 1);
  return true;
}

/** Admit one bridge-started turn against the budget, spending it only when admitted (DEC-070). */
export function admitTurn(doc: PairingDoc): Check {
  if (doc.spent >= BRIDGE_TURN_BUDGET) {
    return { ok: false, reason: "budget exhausted, waiting on the operator" };
  }
  doc.spent += 1;
  return { ok: true };
}

/** The operator (or its turn) granted another budget: spent resets, nothing else moves. */
export function refill(doc: PairingDoc): void {
  doc.spent = 0;
}

/** End the pairing, idempotently; the conversation stays an ordinary transcript (DEC-065). */
export function endPairing(doc: PairingDoc): void {
  doc.ended = true;
}
