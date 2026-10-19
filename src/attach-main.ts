#!/usr/bin/env node
// malebolge-attach: a line client of the running daemon.

import { attach } from "./attach.ts";
import { attachSocket } from "./config.ts";

await attach(attachSocket(process.env), process.stdin, process.stdout);
process.exit(0);
