Each of these looked right and passed against broken code until it was mutation-checked (SL-008):

- **Error-text leak tests.** V8's `JSON.parse` SyntaxError quotes only about 10 characters near the bad token. An 11-character marker placed elsewhere let a leaking mutant pass. Put a short marker (≤6 chars) *at* the bad token.
- **"Refuse before allocation".** Allocating a 0xFFFFFFFF-byte buffer succeeds on Linux (overcommit), so a size-cap test passes even when the code allocates first. Spy on `Buffer.alloc` / `allocUnsafe` and assert neither is called on the refusal.
- **Deep nesting.** A 200,000-deep JSON body parses fine with `JSON.parse`, but TypeBox `Value.Check` over a `Type.Cyclic` schema (and any recursive walk) throws `RangeError`. Wrap check/project and map any throw to a fixed-text refusal, and test with a deep body.

General rule: for every negative control, run the mutant once and watch it go red.
