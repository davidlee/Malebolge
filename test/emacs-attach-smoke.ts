// End-to-end smoke (SL-001 PHASE-05, design §6): batch Emacs running
// `emacs/malebolge.el` over the real `malebolge-attach --emacs`, against a fake
// daemon on a unix socket. A plain node script, not a vitest file: it shells
// out to emacs, which `vitest run` should not do.
//
// Checks:
//   1. a multiline draft submitted DURING a streamed answer reaches the socket
//      as exactly one `input` with the exact content, and no `quit` follows;
//   2. reattaching to a snapshot of those turns shows each role heading once
//      and ends the answer with exactly one blank line;
//   3. terminal attach still runs its line commands locally;
//   4. (SL-002 PHASE-03) a prefix-argument attach lists the store, picks from
//      the daemon's own ids, and sends the chosen target's argv;
//   5. (SL-010 PHASE-07) `new' asks for a topic over the daemon's `--topics'
//      names and sends `--topic NAME --new`.
//
// Event order: like the real daemon, the fake echoes a draft submitted
// mid-answer only after the answer ends. pi-durable queues input to a busy
// conversation in its inbox (`Conversation.submit`), so the user turn's
// message_end lands at a boundary; render.test.ts covers the interleaved order.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { isRecord } from "../src/json.ts";
import { encodeLine, lineSplitter } from "../src/ndjson.ts";
import { serveUnix } from "../src/unix-socket.ts";
import { type Recorder, recorder, tempDir } from "./fixtures.ts";

/** Every failure throws this; `run` prints it and exits nonzero. */
class SmokeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeFailure";
  }
}

const REPO = new URL("..", import.meta.url).pathname;
const ATTACH = join(REPO, "src", "attach-main.ts");
const EMACS_DIR = join(REPO, "emacs");
/** The whole check; a hang must fail rather than block. */
const OVERALL_MS = 20_000;

/** The id the stubbed picker answers; not the first, so the listing was read. */
const CHOSEN = 7;
/** The conversation the fake creates for a `--topic … --new' attach. */
const NEW_ID = 1;
/** What the fake daemon says it holds: ids newest first, as the daemon sends them. */
const LISTED = [9, CHOSEN, 3];

/** The topic the new-conversation check chooses, among the names the fake reports. */
const TOPIC = "work";

/** The draft: leading spaces, an interior blank line, a slash line, trailing spaces. */
const DRAFT = "first line\n\n  /not a command\nlast  ";
const BEFORE = "Satan speaks first.";
/** The streamed answer, and its cut point: the head streams before the draft, the rest after. */
const AFTER_HEAD = "Then Satan ";
const AFTER_REST = "answers.";
const AFTER = AFTER_HEAD + AFTER_REST;

/** `what` did not happen in time. */
const timeout = (what: string): SmokeFailure => new SmokeFailure(`timed out waiting for ${what}`);

/** `promise`, or a failure if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(timeout(`${what} (${String(ms)}ms)`));
    }, ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The fake daemon's events, built as the daemon sends them.
// ---------------------------------------------------------------------------

const userEntry = (text: string, id: string): unknown => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content: text }],
});

const assistantEntry = (text: string, id: string): unknown => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [{ role: "assistant", content: [{ type: "text", text }] }],
});

const partial = (text: string): unknown => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

/** Everything a snapshot event carries; the renderer reads `entries` and `generation`. */
const snapshotOf = (entries: unknown[]): Record<string, unknown> => ({
  type: "snapshot",
  entries,
  tools: [],
  nestedTools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: {},
});

/** One streamed delta of the current assistant message. */
const textDelta = (delta: string): string =>
  encodeLine({
    type: "message_update",
    usage: {},
    changes: [{ type: "text_delta", contentIndex: 0, delta }],
  });

/** A fake daemon on `path`, and what it received. */
interface FakeSocket {
  path: string;
  received: Recorder<unknown>;
}

/** What the fake does with one attached connection. */
type ServeSession = (socket: Socket) => Promise<void> | undefined;

/** `isRecord` and `type` is `type`; the receive side's frame predicate. */
const frameOf =
  (type: string) =>
  (value: unknown): boolean =>
    isRecord(value) && value["type"] === type;

/**
 * The fake daemon's answer to `{"type":"list","topics":true}': every topic's
 * name, as `--topics` prints them, `default` first.
 */
const topicsReply = (): Record<string, unknown> => ({
  type: "topics",
  profile: "room",
  topics: [{ name: "default" }, { name: TOPIC, cwd: "/tmp" }],
});

/**
 * A fake daemon on `path`: answers the attach frame with `attachReply` then
 * runs `serve`, and answers a `list` frame before closing, as the daemon's own
 * clean close does: the topics for a `topics:true` listing, `LISTED` and its
 * summaries otherwise.  Records every frame the client sends.
 */
async function fakeDaemon(
  path: string,
  received: Recorder<unknown>,
  attachReply: Record<string, unknown>,
  serve: ServeSession,
): Promise<FakeSocket> {
  const server = await serveUnix(path, (socket) => {
    socket.on("error", () => socket.destroy());
    socket.on(
      "data",
      lineSplitter((line) => {
        const value: unknown = JSON.parse(line);
        received.push(value);
        if (isRecord(value) && value["type"] === "list") {
          socket.end(
            encodeLine(
              value["topics"] === true
                ? topicsReply()
                : {
                    type: "conversations",
                    conversations: LISTED,
                    truncated: false,
                    // SL-010: the chooser's lines are `id<TAB>topic<TAB>model`.
                    summaries: {
                      "9": { topic: "work", model: "faux/faux-2" },
                      [String(CHOSEN)]: { topic: "default", model: "faux/faux-1" },
                      "3": { topic: "default" },
                    },
                  },
            ),
          );
        }
        if (isRecord(value) && value["type"] === "attach") {
          socket.write(encodeLine(attachReply));
          // The session runs on after the exchange; its failures are the checks'.
          Promise.resolve(serve(socket)).catch(() => socket.destroy());
        }
      }),
    );
  });
  servers.push(server);
  return { path, received };
}

/** Every fake daemon started, closed once the checks end. */
const servers: { close: () => Promise<void> }[] = [];

// ---------------------------------------------------------------------------
// Emacs and node children.
// ---------------------------------------------------------------------------

interface Child {
  stdout: () => string;
  stderr: () => string;
  /** Resolves with the exit code once both streams have ended. */
  done: Promise<number>;
  kill: () => void;
}

/** Spawn `command` with `args`, collecting its output. */
function startChild(
  command: string,
  args: string[],
  options: { env: Record<string, string>; stdin?: string },
): Child {
  const child = spawn(command, args, {
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
  });
  child.stdin.on("error", () => undefined);
  if (options.stdin !== undefined) {
    child.stdin.end(options.stdin);
  }
  return {
    stdout: () => out,
    stderr: () => err,
    done: within(
      new Promise<number>((resolve) => {
        child.on("close", (code) => {
          resolve(code ?? 1);
        });
      }),
      OVERALL_MS / 2,
      `${command} exiting`,
    ),
    kill: (): void => {
      child.kill("SIGKILL");
    },
  };
}

/** The answer's last word: a draft cut in mid-stream splits the rest under a continuation cue. */
const AFTER_TAIL = AFTER_REST;

/** An elisp regexp: the transcript ends with the completed answer and its blank line. */
const ANSWER_DONE = `(concat (regexp-quote ${JSON.stringify(AFTER_TAIL)}) "\n\n\\\\'")`;

/** An elisp regexp: the transcript ends with the draft's echo as a user turn. */
const ECHOED = `(concat (regexp-quote ${JSON.stringify(`You:\n${DRAFT}\n`)}) "\\\\'")`;

/** An elisp regexp matching the head delta once the renderer has shown it. */
const STREAMING = `(regexp-quote ${JSON.stringify(AFTER_HEAD)})`;

/** Elisp helpers both sessions share: wait for transcript text, and read it. */
const smokeHelpers = (totalMs: number): string => `
(defun mlb-smoke-text ()
  (with-current-buffer malebolge-buffer-name
    (buffer-substring-no-properties (point-min) (point-max))))

(defun mlb-smoke-wait (want)
  (let ((deadline (+ (float-time) ${String(totalMs / 1000)})))
    (while (and (not (string-match-p want (mlb-smoke-text)))
                (< (float-time) deadline))
      (accept-process-output nil 0.05))
    (string-match-p want (mlb-smoke-text))))

(defun mlb-smoke-fail (why out-file)
  (write-region (mlb-smoke-text) nil out-file)
  (princ (format "smoke: %s\\n" why) #'external-debugging-output)
  (kill-emacs 2))

(defun mlb-smoke-finish (out-file)
  (accept-process-output nil 0.2)
  (write-region (mlb-smoke-text) nil out-file)
  (kill-emacs 0))
`;

/** Attach, submit a multiline draft while the answer streams, detach, and save the transcript. */
const draftDuringStreamElisp = (outFile: string): string => `
(malebolge-attach)
(unless (mlb-smoke-wait ${STREAMING})
  (mlb-smoke-fail "the answer never started streaming" ${JSON.stringify(outFile)}))
(when (string-match-p ${ANSWER_DONE} (mlb-smoke-text))
  (mlb-smoke-fail "the answer completed before the draft was submitted" ${JSON.stringify(outFile)}))
(with-current-buffer (get-buffer malebolge-draft-buffer-name)
  (goto-char (point-max))
  (insert ${JSON.stringify(DRAFT)}))
(malebolge-submit)
(unless (mlb-smoke-wait ${ECHOED})
  (mlb-smoke-fail "the draft was never echoed after the answer" ${JSON.stringify(outFile)}))
(malebolge-quit)
(unless (mlb-smoke-wait (regexp-quote "[status] detached"))
  (mlb-smoke-fail "the client never detached" ${JSON.stringify(outFile)}))
(mlb-smoke-finish ${JSON.stringify(outFile)})
`;

/** Attach, let the process die, reattach in the same Emacs, and save the transcript. */
const reattachElisp = (outFile: string): string => `
(malebolge-attach)
(unless (mlb-smoke-wait ${ANSWER_DONE})
  (mlb-smoke-fail "the first snapshot never arrived" ${JSON.stringify(outFile)}))
(delete-process (get-buffer-process malebolge-buffer-name))
;; Let comint's sentinel write its "Process malebolge …" line before reattaching.
(accept-process-output nil 0.1)
(malebolge-attach)
(unless (mlb-smoke-wait ${ANSWER_DONE})
  (mlb-smoke-fail "the second snapshot never arrived" ${JSON.stringify(outFile)}))
(mlb-smoke-finish ${JSON.stringify(outFile)})
`;

/** Attach under a prefix argument, the picker answering CHOSEN, and save the transcript. */
const targetedElisp = (outFile: string): string => `
(require 'cl-lib)
(cl-letf (((symbol-function 'completing-read)
           (lambda (_prompt collection &rest _)
             ;; SL-010: each candidate is a whole line: id<TAB>topic<TAB>model.
             (let ((line (cl-find-if
                          (lambda (candidate)
                            (equal (malebolge--candidate-id candidate)
                                   ${JSON.stringify(String(CHOSEN))}))
                          collection)))
               (unless line
                 (mlb-smoke-fail "the listing never offered the chosen id"
                                 ${JSON.stringify(outFile)}))
               line))))
  (malebolge-attach t))
(unless (mlb-smoke-wait ${ANSWER_DONE})
  (mlb-smoke-fail "the chosen conversation's snapshot never arrived"
                  ${JSON.stringify(outFile)}))
(malebolge-quit)
(unless (mlb-smoke-wait (regexp-quote "[status] detached"))
  (mlb-smoke-fail "the client never detached" ${JSON.stringify(outFile)}))
(mlb-smoke-finish ${JSON.stringify(outFile)})
`;

/**
 * Attach under a prefix argument, `new' at the conversation prompt and TOPIC at
 * the topic prompt, then save the transcript.  The topic prompt must be offered
 * the daemon's names: an Emacs that never asks fails here, not silently.
 */
const newInTopicElisp = (outFile: string): string => `
(require 'cl-lib)
(cl-letf (((symbol-function 'completing-read)
           (lambda (prompt collection &rest _)
             (if (string-prefix-p "Topic: " prompt)
                 (progn
                   (unless (member ${JSON.stringify(TOPIC)} collection)
                     (mlb-smoke-fail "the topic prompt never offered the topic"
                                     ${JSON.stringify(outFile)}))
                   ${JSON.stringify(TOPIC)})
               (unless (member "new" collection)
                 (mlb-smoke-fail "the picker never offered new"
                                 ${JSON.stringify(outFile)}))
               "new"))))
  (malebolge-attach t))
(unless (mlb-smoke-wait ${ANSWER_DONE})
  (mlb-smoke-fail "the new conversation's snapshot never arrived"
                  ${JSON.stringify(outFile)}))
(malebolge-quit)
(unless (mlb-smoke-wait (regexp-quote "[status] detached"))
  (mlb-smoke-fail "the client never detached" ${JSON.stringify(outFile)}))
(mlb-smoke-finish ${JSON.stringify(outFile)})
`;

/** The env the Emacs-side attach child needs: the fake socket, and `node`'s own flags. */
const attachEnv = (socketPath: string): Record<string, string> => ({
  MALEBOLGE_SOCKET: socketPath,
  ...(process.execArgv.length > 0 ? { NODE_OPTIONS: process.execArgv.join(" ") } : {}),
});

/** Run one batch Emacs session against `socketPath`, writing its transcript to `outFile`. */
function emacsSession(socketPath: string, session: string): Child {
  const elisp = `(progn
(setq malebolge-attach-command (list "node" ${JSON.stringify(ATTACH)}))
${smokeHelpers(OVERALL_MS / 4)}
${session})`;
  // The attach child inherits Emacs's environment, so the fake socket rides along.
  return startChild(
    "emacs",
    ["--batch", "-Q", "-L", EMACS_DIR, "-l", "malebolge", "--eval", elisp],
    {
      env: attachEnv(socketPath),
      stdin: "",
    },
  );
}
// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------

/** `lines` that are a frame of `type`. */
const framesOf = (lines: readonly unknown[], type: string): unknown[] =>
  lines.filter((line) => isRecord(line) && line["type"] === type);

const expect = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new SmokeFailure(message);
  }
};

const equal = (actual: unknown, wanted: unknown, what: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new SmokeFailure(
      `${what}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`,
    );
  }
};

/** Count non-overlapping occurrences of `needle` in `text`. */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/** 1: a draft submitted during a streamed answer, over batch Emacs and the real attach. */
async function checkDraftDuringStream(dir: string): Promise<void> {
  const received = recorder<unknown>();
  const fake = await fakeDaemon(
    join(dir, "live.sock"),
    received,
    { type: "attached", conversation: 1 },
    async (socket) => {
      socket.write(
        encodeLine(snapshotOf([userEntry(BEFORE, "u-0"), assistantEntry(BEFORE, "a-0")])),
      );
      socket.write(encodeLine({ type: "message_start", message: partial("") }));
      socket.write(textDelta(AFTER_HEAD));
      // The draft arrives mid-answer: the rest streams only once it is received.
      // The waiter is fed by the data handler, so this is event-driven, not a poll.
      const input = await received.next(frameOf("input"));
      socket.write(textDelta(AFTER_REST));
      socket.write(encodeLine({ type: "message_end", entry: assistantEntry(AFTER, "a-answer") }));
      // The queued input enters the conversation at the boundary, after the answer.
      const content = isRecord(input) ? String(input["content"]) : "";
      socket.write(encodeLine({ type: "message_end", entry: userEntry(content, "u-live") }));
    },
  );
  const transcriptFile = join(dir, "live.txt");
  const emacs = emacsSession(fake.path, draftDuringStreamElisp(transcriptFile));
  try {
    const code = await emacs.done;
    const transcript = await readFile(transcriptFile, "utf8").catch(() => "");
    equal(
      code,
      0,
      `batch emacs exit (stderr: ${emacs.stderr()}; transcript: ${JSON.stringify(transcript)})`,
    );
    const inputs = framesOf(received.items, "input");
    equal(inputs, [{ type: "input", content: DRAFT }], "socket input frames");
    equal(framesOf(received.items, "quit"), [], "quit frames reaching the socket");
    expect(
      countOf(transcript, `You:\n${DRAFT}\n`) === 1,
      `transcript echoes the draft once under "You:": ${JSON.stringify(transcript)}`,
    );
    expect(
      transcript.includes(`Satan:\n${AFTER}\n\nYou:\n${DRAFT}\n[status] detached\n`),
      `the answer completes with one blank line, the draft follows as one user turn, then detaches: ${JSON.stringify(transcript)}`,
    );
  } finally {
    emacs.kill();
  }
}

/** 2: reattaching to those turns shows each heading once and one blank line before EOF. */
async function checkReattach(dir: string): Promise<void> {
  const received = recorder<unknown>();
  const fake = await fakeDaemon(
    join(dir, "reattach.sock"),
    received,
    { type: "attached", conversation: 1 },
    (socket) => {
      socket.write(
        encodeLine(
          snapshotOf([
            userEntry(BEFORE, "u-0"),
            assistantEntry(BEFORE, "a-0"),
            userEntry(DRAFT, "u-1"),
            assistantEntry(AFTER, "a-1"),
          ]),
        ),
      );
    },
  );
  const transcriptFile = join(dir, "reattach.txt");
  const emacs = emacsSession(fake.path, reattachElisp(transcriptFile));
  try {
    const code = await emacs.done;
    const transcript = await readFile(transcriptFile, "utf8").catch(() => "");
    equal(
      code,
      0,
      `reattach emacs exit (stderr: ${emacs.stderr()}; transcript: ${JSON.stringify(transcript)})`,
    );
    equal(countOf(transcript, "You:"), 2, "user headings in the reattached transcript");
    equal(countOf(transcript, "Satan:"), 2, "assistant headings in the reattached transcript");
    expect(
      transcript.includes(DRAFT),
      `the earlier draft is shown verbatim: ${JSON.stringify(transcript)}`,
    );
    expect(
      transcript.endsWith("\n\n"),
      `the answer ends in one blank line: ${JSON.stringify(transcript.slice(-20))}`,
    );
    expect(
      !transcript.includes("Process malebolge"),
      `no comint process message survives reattach: ${JSON.stringify(transcript)}`,
    );
  } finally {
    emacs.kill();
  }
}

/** 3: terminal attach keeps its line commands, and `/quit` stays local. */
async function checkTerminal(dir: string): Promise<void> {
  const received = recorder<unknown>();
  const fake = await fakeDaemon(
    join(dir, "terminal.sock"),
    received,
    { type: "attached", conversation: 1 },
    () => undefined,
  );
  const child = startChild(process.execPath, [ATTACH], {
    env: attachEnv(fake.path),
    stdin: "hello\n/abort\n/quit\n",
  });
  try {
    const code = await child.done;
    equal(code, 0, `terminal attach exit (stderr: ${child.stderr()})`);
    equal(
      framesOf(received.items, "input"),
      [{ type: "input", content: "hello" }],
      "terminal input frames",
    );
    equal(framesOf(received.items, "abort"), [{ type: "abort" }], "terminal abort frames");
    equal(framesOf(received.items, "quit"), [], "quit frames reaching the socket");
    expect(
      child.stdout().includes("[detached]"),
      `terminal attach prints the detach: ${JSON.stringify(child.stdout())}`,
    );
  } finally {
    child.kill();
  }
}

/**
 * 4: a prefix-argument attach lists the store, picks, and sends the chosen
 * target's argv.  The fake's list reply carries summaries, so the picker sees
 * `id<TAB>topic<TAB>model` lines and must answer a whole one.  The argv is
 * `--conversation CHOSEN`, so the socket must see the attach frame naming it --
 * the argument reaching the client is what the picker got right, not the frame
 * the fake happened to expect.
 */
async function checkTargetedAttach(dir: string): Promise<void> {
  const received = recorder<unknown>();
  const fake = await fakeDaemon(
    join(dir, "targeted.sock"),
    received,
    { type: "attached", conversation: CHOSEN },
    (socket) => {
      socket.write(encodeLine(snapshotOf([assistantEntry(AFTER, "a-target")])));
    },
  );
  const transcriptFile = join(dir, "targeted.txt");
  const emacs = emacsSession(fake.path, targetedElisp(transcriptFile));
  try {
    const code = await emacs.done;
    const transcript = await readFile(transcriptFile, "utf8").catch(() => "");
    equal(
      code,
      0,
      `targeted emacs exit (stderr: ${emacs.stderr()}; transcript: ${JSON.stringify(transcript)})`,
    );
    equal(framesOf(received.items, "list"), [{ type: "list" }], "the picker's listing frames");
    equal(
      framesOf(received.items, "attach"),
      [{ type: "attach", conversation: CHOSEN }],
      "the argv the picker chose",
    );
    expect(
      transcript.includes(`attached to conversation ${String(CHOSEN)}`),
      `the transcript names the conversation: ${JSON.stringify(transcript)}`,
    );
  } finally {
    emacs.kill();
  }
}

/**
 * 5: `new' asks for a topic, and the client sends `--topic NAME --new'.
 * The fake answers the topics question, so the picker's prompt is offered real
 * names; the argv the client builds is what reaches the socket, so the attach
 * frame naming the topic is the check, not a frame the fake happened to expect.
 */
async function checkNewInTopic(dir: string): Promise<void> {
  const received = recorder<unknown>();
  const fake = await fakeDaemon(
    join(dir, "new-topic.sock"),
    received,
    { type: "attached", conversation: NEW_ID },
    (socket) => {
      socket.write(encodeLine(snapshotOf([assistantEntry(AFTER, "a-topic")])));
    },
  );
  const transcriptFile = join(dir, "new-topic.txt");
  const emacs = emacsSession(fake.path, newInTopicElisp(transcriptFile));
  try {
    const code = await emacs.done;
    const transcript = await readFile(transcriptFile, "utf8").catch(() => "");
    equal(
      code,
      0,
      `new-in-topic emacs exit (stderr: ${emacs.stderr()}; transcript: ${JSON.stringify(transcript)})`,
    );
    equal(
      framesOf(received.items, "list"),
      [{ type: "list" }, { type: "list", topics: true }],
      "the store listing, then the topic names the prompt offered",
    );
    equal(
      framesOf(received.items, "attach"),
      [{ type: "attach", topic: TOPIC, new: true }],
      "the argv the topic choice named",
    );
    expect(
      transcript.includes(`attached to conversation ${String(NEW_ID)}`),
      `the transcript names the new conversation: ${JSON.stringify(transcript)}`,
    );
  } finally {
    emacs.kill();
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/** The checks, in order; the transcript files live in one temp directory. */
async function run(): Promise<void> {
  const { dir, cleanup } = await tempDir();
  const started = Date.now();
  try {
    const checks: [string, (d: string) => Promise<void>][] = [
      ["draft submitted during a streamed answer", checkDraftDuringStream],
      ["reattach shows role cues and spacing", checkReattach],
      ["terminal attach line commands", checkTerminal],
      ["prefix-argument attach sends the chosen target", checkTargetedAttach],
      ["new in a topic sends --topic and --new", checkNewInTopic],
    ];
    for (const [name, check] of checks) {
      await within(check(dir), OVERALL_MS, name);
      process.stdout.write(`ok - ${name}\n`);
    }
    process.stdout.write(`smoke passed in ${String(Date.now() - started)}ms\n`);
  } finally {
    await cleanup();
  }
}

try {
  await within(run(), OVERALL_MS + 2_000, "the smoke check");
  for (const server of servers) {
    await server.close().catch(() => undefined);
  }
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`smoke FAILED: ${message}\n`);
  process.exit(1);
}
