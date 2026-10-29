#!/bin/sh
# rerun all VA-1 probes: ./run-all.sh   (or: node drive.mjs ex1|ex5|ex6|ex7|ex7b)
cd "$(dirname "$0")" && for p in ex1 ex5 ex6 ex7 ex7b; do echo "=== $p"; node drive.mjs $p; done
