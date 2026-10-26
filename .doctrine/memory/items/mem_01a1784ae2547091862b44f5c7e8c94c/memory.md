`recorder<T>().next(match)` (test/fixtures.ts) runs `items.find(match)` over the
whole history, so it resolves immediately when an older item matches. A second
`stopServer` in one test returned on the first stop's "closed" log line.

With several connections it also returned after only ONE handle saw the close,
so another handle was given a dead client (`write EPIPE`). The fix:
snapshot a count, act, then wait until the count reaches the expected total
(e.g. one "closed" line per `fixture.openConnections()`), as
`test/satan-tools.test.ts` `stopServer` now does.

A pi worker misdiagnosed this as a transport bug and added an `'end'` listener
to `unix-socket-transport.ts`. Check the helper before the product.
