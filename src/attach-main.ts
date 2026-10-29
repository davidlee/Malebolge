#!/usr/bin/env node
// malebolge-attach: a line client of the running daemon.

import { attach } from "./attach.ts";
import {
  type AttachInvocation,
  attachInvocationOf,
  HereRefusedError,
  resolveHere,
  type ResolvedInvocation,
  UsageError,
} from "./attach-invocation.ts";
import { attachSocket } from "./config.ts";
import { createRenderer } from "./render.ts";
import { requestFrameOf, replyTypeOf, request } from "./request.ts";
import { codeOf } from "./unix-socket.ts";

const USAGE = [
  "usage: malebolge-attach [--list [--topic NAME | --here]] | [--topics]",
  " | [--set-topic NAME [--dir DIR | --no-dir | --here] [--toolset NAME | --no-toolset] [--model REF | --no-model]]",
  " | [--conversation N | --new [--cwd DIR] | (--topic NAME | --here) [--new [--cwd DIR]]] [--emacs]",
].join("\n");

/** The invocation the command line names; a refusal is one line and exit 2, before any connect. */
function invocationOf(args: string[]): AttachInvocation {
  try {
    return attachInvocationOf(args);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exit(2);
  }
}

/** `--here` resolved against the answering daemon; a refusal is one line and exit 1, before any frame. */
async function resolved(
  invocation: AttachInvocation,
  socketPath: string,
): Promise<ResolvedInvocation> {
  try {
    return await resolveHere(invocation, socketPath, process.stderr);
  } catch (error) {
    if (!(error instanceof HereRefusedError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

try {
  const parsed = invocationOf(process.argv.slice(2));
  const socketPath = attachSocket(process.env);
  const invocation = await resolved(parsed, socketPath);
  if (invocation.mode === undefined) {
    await attach(socketPath, process.stdin, process.stdout, invocation);
  } else {
    // Every request-reply mode: one frame through `request`, and its reply on stdout.
    const reply = await request(
      socketPath,
      requestFrameOf(invocation),
      replyTypeOf(invocation),
      process.stderr,
      invocation.wait,
    );
    process.stdout.write(createRenderer()(reply));
  }
} catch (error) {
  // A connect failure or a refused attach: attach has already said why, so no stack trace.
  if (codeOf(error) === undefined) {
    throw error;
  }
  process.exit(1);
}
process.exit(0);
