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
| lnrpc.Lightning/GetTransactions, walletrpc.WalletKit/PendingSweeps | 0.71.1 console: the Unconfirmed on-chain pane (read-only; the pane says so if they are missing) |
| lnrpc.Lightning/ForwardingHistory, ClosedChannels, ChannelBalance | 0.72.0 console: PL (routing fees, close classification) and channel balances — read-only; the PL card names any of these it lacks |
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
| lnrpc.Lightning/AbandonChannel | TATARA CHANNEL POOLS (0.103.0+): drop a pool's pending inbound channel whose funding can never confirm (an input spent elsewhere, 6 deep) — called with i_know_what_i_am_doing, on pending channels of Tatara pools only (tatara-channels.js) |
| lnrpc.Lightning/DecodePayReq, ListPayments, VerifyMessage; routerrpc.Router/SendPaymentV2 | PUSH KEY HOLDER (0.82.0+): read the recipient's provider's invoice, pay it, probe it, verify a void's signature. The same four the delegate module uses — a key without them holds and delivers on its own provider only, and cannot verify a void; the adapter probes them at boot and says so (0.83.1). In bake-permissions-nodelegate.json from 0.83.1. |
| lnrpc.Lightning/DeleteCanceledInvoice | PUSH KEY (0.116.0+, Kimi round 2 F6): after a claim burns on this provider (the claimant's wallet refused the delivery), the canceled claim invoice is deleted so the real recipient can claim the hash here again (LND never mints a hash twice otherwise). Without it the adapter logs the gap at boot and a burned claim's hash stays unclaimable here. |
| lnrpc.Lightning/OpenChannel, FundingStateStep; walletrpc.WalletKit/FundPsbt, FinalizePsbt, ReleaseOutput, ListLeases | WALLET TRUSTS LSP (0.124.0+, jit-funding.js): a JIT channel's funding is built and signed from LND's own wallet but PUBLISHED ONLY ONCE THE WALLET HAS CLAIMED the payment — the streaming OpenChannel with a PSBT shim (`no_publish`), FundPsbt (the coins leased under the adapter's own lock id), FinalizePsbt (signs, publishes nothing), FundingStateStep (psbt_verify with skip_finalize; shim_cancel on a failed open), ReleaseOutput/ListLeases (the coins back when the payment is refused; strays at boot). None of these can spend coins to anyone: FundPsbt and FinalizePsbt only build and sign a transaction whose one foreign output is the channel's own 2-of-2; PublishTransaction (already in the key) sends it. The adapter probes the six at boot — a key without them keeps today's publish-first open and says so. In both bake-permissions files. |
| routerrpc.Router/XImportMissionControl | ROUTING REPORTS (baked 2026-10-25, used from the next release — docs/design/pathfinding in the wallet repo): the adapter writes the routing failures a wallet reports (signed, Privacy → LSP → Routing reports) into its own LND's mission control, so later route asks avoid them. It writes LND's routing memory only — it moves no funds. In both bake-permissions files. |
| chainrpc.ChainKit/GetBestBlock, GetBlockHash, GetBlock | THE TOWER'S BLOCK WATCH (baked 2026-11-13, used from 0.128.0 — the wallet repo's docs/lijox-watch-standard-r1.md): the tower reads each new block's transaction ids to notice an old channel state it holds a penalty for. Three reads; nothing is written or spent. A box whose key lacks them keeps the tower off and says so. `ops/rebake.py` bakes the key again from the permission file and replaces the one .env line. |

## RECOMMENDED — strict per-RPC macaroon (exactly the table above)

    lncli bakemacaroon --save_to lijox-adapter.macaroon --root_key_id 4545 \
      uri:/lnrpc.Lightning/GetInfo \
      uri:/lnrpc.Lightning/SignMessage \
      uri:/lnrpc.Lightning/ListChannels \
      uri:/lnrpc.Lightning/PendingChannels \
      uri:/lnrpc.Lightning/AbandonChannel \
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
      uri:/routerrpc.Router/SendPaymentV2 \
      uri:/lnrpc.Lightning/UpdateChannelPolicy \
      uri:/routerrpc.Router/XImportMissionControl \
      uri:/lnrpc.Lightning/DeleteCanceledInvoice \
      uri:/lnrpc.Lightning/OpenChannel \
      uri:/lnrpc.Lightning/FundingStateStep \
      uri:/walletrpc.WalletKit/FundPsbt \
      uri:/walletrpc.WalletKit/FinalizePsbt \
      uri:/walletrpc.WalletKit/ReleaseOutput \
      uri:/walletrpc.WalletKit/ListLeases \
      uri:/chainrpc.ChainKit/GetBestBlock \
      uri:/chainrpc.ChainKit/GetBlockHash \
      uri:/chainrpc.ChainKit/GetBlock

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

## 2026-11-13 — `/lnrpc.Lightning/SendPaymentSync` is out of the list

LND 0.21 no longer has it (in 0.20.1's rpcserver.go, absent from 0.21.8's): a bake that names it is refused whole
("invalid permission action"). It is removed from `bake-permissions.json` (47 permissions with the three block reads).
STILL OPEN IN THE CODE: the delegate REFUND path calls it (`POST /v1/channels/transactions`, delegate.js) — on a node
running LND 0.21 a chit's refund fails and stays owed until that call is moved to `/v2/router/send`.

**Closed in 0.128.0 (2026-11-13).** The refund now pays through `/v2/router/send` (`routerrpc.Router/SendPaymentV2`,
already in both lists) and reads its outcome from `ListPayments`. No call to SendPaymentSync is left in the code.
