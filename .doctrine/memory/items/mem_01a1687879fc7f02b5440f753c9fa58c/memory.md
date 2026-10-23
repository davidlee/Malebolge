`src/render.ts`'s `Printable` union is the *client's* frame vocabulary, and
`toPrintable` throws `not an event: …` for anything outside it. So a phase that
adds a daemon reply (SL-002 PHASE-01's `{"type":"conversations",…}`) cannot
assert it through `lineClient(socketPath, toPrintable)`.

Two ways out; take the second:

1. Widen `Printable` early — it forces a renderer handler and drags the next
   phase's work into this one, and `render.test.ts` coverage with it.
2. Decode strictly in the test that needs the frame (SL-002: `listingFrame`,
   narrowed on `isRecord`, `Array.isArray`, element `typeof`, and the
   `"truncated"` key), and let the rendering phase add the `Printable` case
   with its own red test.

The teardown list in `test/daemon.test.ts` is typed `{ close: () => void }[]`
for exactly this reason: one afterEach closes clients of either vocabulary, so
a second frame type needs no second list. Do not type it `LineClient<Printable>[]`.
