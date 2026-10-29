# ASM-002: The gateway's client unix socket serves Jev's path as the relay on 127.0.0.1:4000 does

<!-- Knowledge record body — context, detail, links. The structured, queried
     fields live in the sister `record-NNN.toml`; this prose is free-form and is
     never structurally parsed (the storage rule). -->


## Validation — SL-007 PHASE-01 VA-1 (2026-10-29, seat preflight, host)

`socat TCP-LISTEN:4107,bind=127.0.0.1,fork UNIX-CONNECT:/run/llm-gateway-client/api.sock`,
then unauthenticated requests on screwtape's path (`/v1/systemone`, from
`screwtape/jev/client.gleam`) to the relay `:4000` and the bridge `:4107`:

| request | :4000 (relay) | :4107 (bridged client socket) |
|---|---|---|
| GET  | 404 `{"error": "llm-gateway: no such route"}` | identical |
| POST `{}` | 401 `{"error":{"message":"unknown key","type":"auth_error","param":"None","code":"401"}}` | identical |

Same status, content type (application/json) and body. The claim holds.
