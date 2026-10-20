#!/usr/bin/env node
// malebolge-attach: a line client of the running daemon.

import { attach } from "./attach.ts";
import { attachSocket } from "./config.ts";
import { codeOf } from "./unix-socket.ts";

try {
  await attach(attachSocket(process.env), process.stdin, process.stdout);
} catch (error) {
  // A connect failure: attach has already said why, so no stack trace.
  if (codeOf(error) === undefined) {
    throw error;
  }
  process.exit(1);
}
process.exit(0);
