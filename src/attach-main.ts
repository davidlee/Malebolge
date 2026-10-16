#!/usr/bin/env node
// malebolge-attach: a line client of the running daemon.

import { attach } from "./attach.ts";
import { daemonSocket } from "./config.ts";

await attach(daemonSocket(process.env), process.stdin, process.stdout);
process.exit(0);
