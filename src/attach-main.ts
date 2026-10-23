#!/usr/bin/env node
// malebolge-attach: a line client of the running daemon.

import { attach, type AttachInvocation, attachInvocationOf, UsageError } from "./attach.ts";
import { attachSocket } from "./config.ts";
import { codeOf } from "./unix-socket.ts";

const USAGE = "usage: malebolge-attach [--conversation N | --new [--cwd DIR]] [--emacs]";

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
  await attach(attachSocket(process.env), process.stdin, process.stdout, invocation);
} catch (error) {
  // A connect failure or a refused attach: attach has already said why, so no stack trace.
  if (codeOf(error) === undefined) {
    throw error;
  }
  process.exit(1);
}
process.exit(0);
