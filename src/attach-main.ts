#!/usr/bin/env node
// malebolge-attach: a line client of the running daemon.

import { attach } from "./attach.ts";
import { type AttachInvocation, attachInvocationOf, UsageError } from "./attach-invocation.ts";
import { attachSocket } from "./config.ts";
import { createRenderer } from "./render.ts";
import { frameOf, replyTypeOf, request } from "./request.ts";
import { codeOf } from "./unix-socket.ts";

const USAGE = [
  "usage: malebolge-attach [--list [--topic NAME]] | [--topics]",
  " | [--set-topic NAME [--dir DIR | --no-dir]]",
  " | [--conversation N | --new [--cwd DIR] | --topic NAME [--new [--cwd DIR]]] [--emacs]",
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

try {
  const invocation = invocationOf(process.argv.slice(2));
  const socketPath = attachSocket(process.env);
  if (invocation.mode === undefined) {
    await attach(socketPath, process.stdin, process.stdout, invocation);
  } else {
    // Every request-reply mode: one frame through `request`, and its reply on stdout.
    const reply = await request(
      socketPath,
      frameOf(invocation),
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
