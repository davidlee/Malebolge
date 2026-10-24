# An injected seam needs its own test of the real implementation

When a function takes an injected lookup (git root, clock, socket) so tests can stub it, test the default implementation directly too: SL-003 PHASE-05's gitRootOf returned cwd, not the repo root, and every --here test passed because all of them stubbed it.
