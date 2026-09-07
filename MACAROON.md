# The adapter's macaroon — least privilege, baked by YOU

A macaroon is LND's permission key. Every call the adapter makes to
your node carries one, and LND allows only what that macaroon
permits. `admin.macaroon` permits EVERYTHING — including sending all
funds away. The adapter does not need everything.

Nothing in this repository bakes anything. This page is the recipe.
You run it once, on your own machine, against your own LND. The
result goes into `LIJ_ADAPTER_MACAROON_HEX` in your .env.

## What the adapter actually calls (derived from the code, v0.58.0; delegate module added 2026-09-01)

| LND RPC | used for |
|---|---|
| lnrpc.Lightning/GetInfo | identity, health |
| lnrpc.Lightning/SignMessage | registry registration proof (lijox-register:v1, 0.58.0) |
| lnrpc.Lightning/ListChannels, PendingChannels | channel state |
| lnrpc.Lightning/WalletBalance | onchain reserve guard |
| lnrpc.Lightning/GetChanInfo, QueryRoutes | route building |
| lnrpc.Lightning/ListPeers, ConnectPeer | critical-peer keepalive, wallet checks |
| lnrpc.Lightning/LookupInvoice | payment forensics, LNURLp |
| lnrpc.Lightning/OpenChannelSync | JIT channel opens |
| lnrpc.Lightning/SendCustomMessage, SubscribeCustomMessages | chain bridge |
| invoicesrpc.Invoices/AddHoldInvoice, SettleInvoice, CancelInvoice | offline holds, trampoline settle, delegate |
| routerrpc.Router/HtlcInterceptor | JIT + hold interception |
| routerrpc.Router/SendToRouteV2 | trampoline forwarding |
| chainrpc.ChainNotifier/RegisterBlockEpochNtfn, RegisterConfirmationsNtfn, RegisterSpendNtfn | chain bridge watches |
| walletrpc.WalletKit/PublishTransaction | wallet broadcast relay |
| walletrpc.WalletKit/EstimateFee | fee estimates |
| lnrpc.Lightning/VerifyMessage, GetNodeInfo, AddInvoice, DecodePayReq, ListPayments, SendPaymentSync; routerrpc.Router/SendPaymentV2 | DELEGATE PAYMENT module (slip self-auth, funding invoice, spend, refund) — missing from the v0.58.0 derivation; found 2026-09-01 when every delegate register died on the strict key |
| lnrpc.Lightning/UpdateChannelPolicy | per-channel fee policy enforcement (planned) — baked now so no re-bake later |

## RECOMMENDED — strict per-RPC macaroon (exactly the table above)

    lncli bakemacaroon --save_to lijox-adapter.macaroon --root_key_id 4545 \
      uri:/lnrpc.Lightning/GetInfo \
      uri:/lnrpc.Lightning/SignMessage \
      uri:/lnrpc.Lightning/ListChannels \
      uri:/lnrpc.Lightning/PendingChannels \
      uri:/lnrpc.Lightning/WalletBalance \
      uri:/lnrpc.Lightning/GetChanInfo \
      uri:/lnrpc.Lightning/QueryRoutes \
      uri:/lnrpc.Lightning/ListPeers \
      uri:/lnrpc.Lightning/ConnectPeer \
      uri:/lnrpc.Lightning/LookupInvoice \
      uri:/lnrpc.Lightning/OpenChannelSync \
      uri:/lnrpc.Lightning/SendCustomMessage \
      uri:/lnrpc.Lightning/SubscribeCustomMessages \
      uri:/invoicesrpc.Invoices/AddHoldInvoice \
      uri:/invoicesrpc.Invoices/SettleInvoice \
      uri:/invoicesrpc.Invoices/CancelInvoice \
      uri:/routerrpc.Router/HtlcInterceptor \
      uri:/routerrpc.Router/SendToRouteV2 \
      uri:/chainrpc.ChainNotifier/RegisterBlockEpochNtfn \
      uri:/chainrpc.ChainNotifier/RegisterConfirmationsNtfn \
      uri:/chainrpc.ChainNotifier/RegisterSpendNtfn \
      uri:/walletrpc.WalletKit/PublishTransaction \
      uri:/walletrpc.WalletKit/EstimateFee \
      uri:/lnrpc.Lightning/VerifyMessage \
      uri:/lnrpc.Lightning/GetNodeInfo \
      uri:/lnrpc.Lightning/AddInvoice \
      uri:/lnrpc.Lightning/DecodePayReq \
      uri:/lnrpc.Lightning/ListPayments \
      uri:/lnrpc.Lightning/SendPaymentSync \
      uri:/routerrpc.Router/SendPaymentV2 \
      uri:/lnrpc.Lightning/UpdateChannelPolicy

Then hex it into your .env:

    xxd -p -c 2000 lijox-adapter.macaroon
    # paste the output as LIJ_ADAPTER_MACAROON_HEX=...

With this key the adapter can serve wallets fully and prove the
node's identity to LIJOX registries (SignMessage — added 0.58.0 for
lijox-register:v1; it signs statements as your node but moves
nothing), yet it CANNOT send your onchain coins, close channels,
pay arbitrary invoices, mint macaroons, or read your seed. LND's REST
endpoints check the same URI permissions, so one key covers both
transports the adapter uses.

Verify the URI names against YOUR lnd version before baking:

    lncli listpermissions | grep -E "GetInfo|AddHoldInvoice|HtlcInterceptor"

If a name differs on your build, use the name your node prints.

## SIMPLER — entity-level macaroon (coarser, one honest caveat)

    lncli bakemacaroon --save_to lijox-adapter.macaroon --root_key_id 4545 \
      info:read invoices:read invoices:write offchain:read offchain:write \
      onchain:read onchain:write peers:read peers:write message:write

Caveat, stated plainly: `onchain:write` at entity level also permits
SendCoins (spending onchain funds), because LND cannot split "open a
channel and broadcast" from "send coins" at this granularity. If
that bothers you — it should — use the strict recipe above.

## Why --root_key_id 4545 (pick any number you like)

Baking from a DEDICATED root key means this macaroon can be revoked
alone, without touching anything else that talks to your node:

    lncli deletemacaroonid 4545     # kills every macaroon from that root key

Rotate by deleting the id and baking again with a new one. This is
per-service key isolation: one service, one root key, independent
revocation.

## The lease module exception (only if you enable LEASE_ENABLE)

The dormant lease module shells out to `lncli closechannel`, and
`lncli` reads its own macaroon (admin by default) — the adapter's
macaroon is not involved there. If you enable lease, either accept
that lncli path or point LEASE_LNCLI at a wrapper using a macaroon
with `uri:/lnrpc.Lightning/CloseChannel`. Channel closing is
deliberately NOT in the adapter's own key.

## Proof it works

Start the adapter. The first-run doctor makes a real authenticated
call — "LND REST reachable, macaroon accepted, node identity
matches" means your baked key is live. A permission you missed shows
up as a plain LND "permission denied" naming the RPC; add that URI
and rebake.

## REST alternative (no lncli needed — umbrelOS, or any box with the admin macaroon on disk)

POST the same URI list to LND's REST `/v1/macaroon` as `{"entity":"uri","action":"<URI>"}` pairs with the admin
macaroon; the answer is `{"macaroon":"<hex>"}` — already the hex your .env wants. Root key id 4546 was used for the
2026-09-01 re-bake (4545 = the original strict key; `lncli deletemacaroonid 4545` once the new key is proven).

## LSPs that do not offer delegate payments

Bake `bake-permissions-nodelegate.json` instead (the original list + UpdateChannelPolicy). Note: one of the seven
delegate RPC names was rejected by a newer LND build (`invalid permission action`) on 2026-09-01 — CONFIRMED 2026-09-01 via
`GET /v1/macaroon/permissions`: the Umbrel's newer LND lacks `/lnrpc.Lightning/SendPaymentSync` (the other six exist).
The delegate REFUND path still calls it (`POST /v1/channels/transactions`) — DOCKET 0.65.0: move the refund pay to
`/v2/router/send` (SendPaymentV2) so the full list bakes on every LND build. Until then, omit SendPaymentSync on such
nodes and expect delegate refunds to fail there.
