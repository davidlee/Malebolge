// Fake binaries for tests that put a directory first on a daemon's PATH: a
// repo's tool set supplying a hostile `head`, `stat`, `test` or `git`.

import { accessSync, chmodSync, constants, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** `dir/name`, an executable `#!/bin/sh` script running `body`; its path. */
export function fakeBin(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The host's executable `name`: an absolute path, the first on the test
 * process's PATH. What a selectively hostile fake `exec`s for the arguments
 * it does not target (by name it would find itself first; `command -v`
 * would answer a shell builtin such as `test`).
 */
export function realBin(name: string): string {
  const found = (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((dir) => join(dir, name))
    .find(isExecutableFile);
  if (found === undefined) {
    throw new Error(`no ${name} on PATH`);
  }
  return found;
}

/**
 * `dir`, then the entries of the test process's PATH holding no executable
 * `name`: a daemon PATH on which `name` cannot be found.
 */
export function pathWithout(name: string, dir: string): string {
  const kept = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((entry) => !isExecutableFile(join(entry, name)));
  return [dir, ...kept].join(delimiter);
}
