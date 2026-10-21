#!/usr/bin/env node
// malebolge-attach: a line client of the running daemon.

import { attach, attachTargetOf, UsageError } from "./attach.ts";
import { attachSocket } from "./config.ts";
import type { AttachTarget } from "./protocol.ts";
import { codeOf } from "./unix-socket.ts";

const USAGE = "usage: malebolge-attach [--conversation N | --new [--cwd DIR]]";

/** The target the command line names; a refusal is one line and exit 2, before any connect. */
function targetOf(args: string[]): AttachTarget {
  try {
    return attachTargetOf(args);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    process.exit(2);
  }
}

try {
  await attach(attachSocket(process.env), process.stdin, process.stdout, {
    target: targetOf(process.argv.slice(2)),
  });
} catch (error) {
  // A connect failure or a refused attach: attach has already said why, so no stack trace.
  if (codeOf(error) === undefined) {
    throw error;
  }
  process.exit(1);
}
process.exit(0);
