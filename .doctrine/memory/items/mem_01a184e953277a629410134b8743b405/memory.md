Two vitest runs with coverage enabled, in the same checkout at the same time
(a pi worker and the host gate, or two workers), collide on `coverage/.tmp`
and one fails with ENOENT. It is not a test failure.

How to apply: never run the full suite concurrently. Targeted runs use
`npx vitest run <files> --coverage.enabled=false`; the one authoritative gate
is `nix develop -c just check`, run alone. Seen across SL-006's implementation
run (notes § Implementation run).
