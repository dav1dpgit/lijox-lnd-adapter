#!/usr/bin/env node
/**
 * LIJOX LSP Adapter Daemon v0.20
 * ==============================
 *
 * v0.20 VARIABLE (S27 design final v2 — open-amount JIT receive):
 *   - /lsps2/buy accepts ABSENT/0 payment_size_msat -> mode 'variable'.
 *     No completeness gate is possible without a total, BY CONSTRUCTION;
 *     the judge becomes QUIESCENCE (no new part for LSPS2_VAR_QUIESCE_MS).
 *   - handleVariableShard holds every part (floor + CLTV per part);
 *     flushVariable sizes the channel from the OBSERVED gross (capped by
 *     LSPS2_VAR_CEILING_MSAT), fee = channelOpenFeeMsat (0.69.0: the one
 *     opening-fee law, max(CHANNEL_OPEN_FEE_MIN_SATS, ceil(sum ×
 *     CHANNEL_OPEN_FEE_PPM / 1e6)) × escalators), then reuses
 *     openChannelAndForward verbatim: B-15 forwards sum - fee, B-11
 *     settle-all settles every part, B-13/offline holds inherit.
 *   - register_secret total_msat 0 = OPEN-AMOUNT SENTINEL (engine v188).
 *     0 is falsy -> the existing mpp_record fallback declares sum - fee;
 *     an amountless invoice claims whatever total is declared, so the
 *     deduction can never break claim equality.
 *   - get_info gains a `variable` block; engine refuses gracefully when
 *     absent. Fixed-mode paths byte-identical throughout.
 *   - Straggler part after flush: FAIL (sender already holds the
 *     preimage; the part refunds).
 *
 * v0.19 (D-1 JIT safety):
 *   - 2a: offline-receive branch FAILs the HTLC immediately instead of
 *     holding it (CLTV-bounded hold was not viable).
 *   - 2b: openChannelAndForward verifies the wallet is a live LND peer
 *     (/v1/peers) before opening; FAILs fast if absent rather than hanging
 *     on openChannelSync against a peer the lagging registry thinks is up.
 * v0.18.7 (revert SQLite-backed channel store; openChannelSync isolation):
 *
 *   v0.18.5/.6 introduced `better-sqlite3` (native module + 37 transitive
 *   packages) as the backing store for the LIJOX channel registry. After
 *   those deploys, ALL openChannelSync gRPC calls to LND started failing
 *   with `13 INTERNAL: grpc: error unmarshalling request: proto: cannot
 *   parse invalid wire-format data`, even after rolling back the proto
 *   field 30 change (wire bytes verified byte-identical to v0.18.4).
 *
 *   LND was not restarted (uptime 3 days), same version (0.20.1-beta), same
 *   wire bytes — yet rejects them now. The single Node-process-level change
 *   that remains across all the failures is the native better-sqlite3 load.
 *   Reverting registryChannelStore to the in-memory MemoryChannelStore so
 *   better-sqlite3 is never required, in order to isolate whether that's
 *   the trigger.
 *
 *   Registry persistence (survives adapter restart) becomes deferred until
 *   a different storage backend is identified that doesn't conflict with
 *   the gRPC stack. SqliteChannelStore class stays in registry.js for
 *   future use, just not instantiated here.
 *
 *   RETAINED from v0.18.5/.6:
 *     - Separate, looser admin rate limiter (60/min)
 *     - Admin endpoint uses store.getAll() interface (backend-agnostic)
 *     - JIT_CHANNEL_RESERVE_PERCENT env defined but no-op (REST-path
 *       implementation deferred)
 *
 * v0.18 (LSPS2 JIT Phase D.2 — trampoline-via-interceptor + offline-receive):
 *
 *   D.2 ARCHITECTURE: We do NOT use SCID-alias matching (LND assigns its
 *   own aliases; we can't pre-choose them). Instead we use a trampoline
 *   pattern via the HtlcInterceptor + SendToRouteV2:
 *
 *     1. Payer's HTLC arrives carrying our promised SCID X in onion
 *     2. LND can't forward (no channel with SCID X) → HtlcInterceptor
 *     3. We match X in pendingJitBuys → JIT recognized → HOLD HTLC
 *     4. openChannelSync to wallet (private + zero_conf, LND-assigned alias)
 *     5. sendToRouteV2 to wallet over the NEW channel with SAME payment_hash
 *        and amount = inbound_amount_msat - fee_msat
 *     6. Wallet's LDK settles via its pending invoice (payment_hash matches)
 *        → releases preimage
 *     7. SendToRouteV2 returns the preimage
 *     8. We SETTLE the original inbound HTLC via the interceptor with that
 *        preimage. Inbound settles upstream. Atomic, non-custodial.
 *
 *   OFFLINE RECEIVE: If the wallet is not in the chain-bridge peer registry
 *   when the HTLC arrives, the HTLC is held in pendingHtlcsForOfflineWallets
 *   (do not respond to interceptor — LND keeps the HTLC open). A watchdog
 *   timer auto-FAILs the HTLC at SAFETY_BLOCKS before its CLTV expiry. A
 *   reconnect-poll timer (every RECONNECT_POLL_SECS) checks the chain-bridge
 *   registry for the offline pubkeys; when a wallet reappears, the pending
 *   HTLCs for that pubkey are processed via the same channel-open + forward
 *   flow.
 *
 *   /lsps2/pending HTTP endpoint: Wallet can query for HTLCs being held on
 *   its behalf. Macaroon auth + client_pubkey in body. Read-only / UI-facing.
 *
 *   QUOTE/RESERVATION DECOUPLING (b1): pendingJitBuys entries gain two
 *   timestamps — quote_expires_at (soft, advisory for new invoices) and
 *   reservation_expires_at (hard, FAILs HTLCs after). LSP honors the quoted
 *   fee until reservation expiry — locked-in pricing, no recompute at HTLC
 *   time. Quote expiry advisory only.
 *
 *   PHASE A.1 IN-ADAPTER: /lsps2/buy POST handler now requires client_pubkey
 *   field (66 hex chars). The pending JIT buy entry stores client_pubkey
 *   alongside fee/size/timestamps. Rust side (Phase A.1) was committed
 *   separately.
 *
 *   SAFETY:
 *     - Default RESUME on any unhandled exception in the match path
 *     - 25s timeout on openChannelSync; FAIL(temporary_channel_failure) on hang
 *     - 25s timeout on sendToRouteV2; FAIL on hang or rejection
 *     - Watchdog FAILs offline HTLCs SAFETY_BLOCKS before CLTV expiry
 *     - inFlightOpens Set prevents duplicate channel-open per promise
 *     - reservation_expires_at enforces hard cutoff
 *
 *   CONFIG additions (env overrides in parentheses):
 *     channel_buffer_sats           default 50_000 (LSPS2_CHANNEL_BUFFER_SATS)
 *     reservation_validity_hours    default 24     (LSPS2_RESERVATION_HOURS)
 *     htlc_safety_blocks            default 10     (LSPS2_HTLC_SAFETY_BLOCKS)
 *     reconnect_poll_secs           default 5      (LSPS2_RECONNECT_POLL_SECS)
 *     openchannel_timeout_ms        default 25000  (LSPS2_OPENCHANNEL_TIMEOUT_MS)
 *   recover-close (0.70.0): POST /lsps/registry/recover-close — a wallet back with
 *     only its 12 words proves the node key (signmessage over a single-use
 *     registry nonce) and this LSP force-closes every channel it holds with it;
 *     refuses while an HTLC is in flight. The LSP's commitment pays the wallet's
 *     side to its pinned m/84 address, no delay. Uses LEASE_LNCLI for the close.
 *   open_fee_ppm / open_fee_min_msat (0.69.0): THE channel-opening fee — one
 *     law on every rail: max(floor, ppm × payment) × per-wallet × scarcity;
 *     defaults 100 sats / 100 ppm  (CHANNEL_OPEN_FEE_MIN_SATS, CHANNEL_OPEN_FEE_PPM;
 *     LSPS2_VAR_FEE_PPM / LSPS2_VAR_MIN_FEE_MSAT deprecated, LSPS2_CHANNEL_OPEN_FEE_SATS ignored)
 *   lnurlp.address_host (0.68.0): the neutral host static addresses are written
 *     under (name@lightninginajar.xyz); this LSP claims names there with its
 *     node key; empty = this LSP's own host  (LNURLP_ADDRESS_HOST)
 *   chan_policy (0.66.0): the fee policy of every channel opened to a wallet,
 *     set in the open and kept hourly on private wallet channels
 *     base_fee_msat                 default 0      (LIJ_CHAN_BASE_FEE_MSAT)
 *     fee_ppm                       default 1000   (LIJ_CHAN_FEE_PPM)
 *     enforce                       default true   (LIJ_CHAN_POLICY_ENFORCE)
 *     sendtoroute_timeout_ms        default 25000  (LSPS2_SENDTOROUTE_TIMEOUT_MS)
 *
 * v0.17 (LSPS2 JIT Phase D.1 — htlc-interceptor observability):
 *   - NEW: Subscribes to LND's Router HtlcInterceptor bidirectional stream
 *     on startup. Receives every HTLC LND wants to forward through LiJ-Node.
 *     Default action: RESUME unconditionally (no behavior change for any
 *     payment). If outgoing_requested_chan_id matches a pending_jit_buy
 *     SCID, logs [LSPS2] JIT match: scid=... payment_hash=... amount=...
 *     and still RESUMES. Phase D.2 (next session) will replace RESUME-on-
 *     match with the actual channel-open + HTLC forward logic.
 *   - SAFETY: match-and-respond is synchronous, no I/O in the HTLC response
 *     path. On any throw in match logic, defaults to RESUME. Stream
 *     auto-reconnects with backoff. Graceful shutdown closes the stream
 *     cleanly before exit. Default-RESUME on malformed handler output.
 *   - NEW: CONFIG.lsps2.interceptor_enabled (defaults true). Override with
 *     LSPS2_INTERCEPTOR_ENABLED=false to disable subsystem entirely.
 *   - NEW: /health response includes interceptor block: { enabled,
 *     connected, htlcs_seen, jit_matches, reconnects, errors, last_error }.
 *     Use to verify the subsystem is healthy without traffic.
 *   - NEW: makeRouterClient + subscribeHtlcInterceptor in lnd-grpc.js v0.3.
 *     Mirrors the existing makeChainNotifierClient pattern. Adds a
 *     bidirectional-stream wrapper (subscribeHtlcInterceptor) since the
 *     interceptor RPC needs client→server response messages, unlike the
 *     existing server-streaming wrappers (BlockEpoch, Conf, Spend).
 *   - NEW: router.proto file (sibling of lightning.proto). Minimal subset
 *     containing only the HtlcInterceptor RPC and its message types.
 *
 * v0.16 (LSPS2 JIT Phase A — get_info + buy endpoints):
 *   - NEW: GET /lsps2/get_info returns the LSP's LSPS2 service terms in
 *     both machine-readable (protocol-spec fields: min/max_payment_size_msat,
 *     base_fee_msat, fee_ppm, promise_validity_secs, client_trusts_lsp)
 *     and human-readable (display strings: human_summary, fee_pct_display,
 *     channel_open_fee_display) form.
 *   - NEW: POST /lsps2/buy issues a JIT channel promise. Body:
 *       { version, payment_size_msat, token? }
 *     Response:
 *       { jit_channel_scid, lsp_pubkey, fee_msat, promise_expires_at,
 *         human_summary }
 *     Promise stored in in-memory pendingJitBuys Map keyed by jit_channel_scid.
 *     Promise expires after CONFIG.lsps2.promise_validity_secs (600s default).
 *     Map is lost on adapter restart — wallets must retry on stale promise.
 *   - NEW: CONFIG.lsps2 block with channel-open fee, per-forward fee
 *     components, pricing inputs (capital_apr_bps, expected_lifetime_days,
 *     force_close_probability_bps, adversarial_reserve_bps), and
 *     forward-compatibility for the SuperScalar channel-factory model via
 *     channel_model field ("direct" today, "superscalar_leaf" future).
 *   - NEW: Env var overrides for tunable pricing fields: LSPS2_CHANNEL_OPEN_FEE_SATS,
 *     LSPS2_FEE_PPM, LSPS2_BASE_FEE_MSAT, LSPS2_MIN_PAYMENT_SIZE_MSAT,
 *     LSPS2_MAX_PAYMENT_SIZE_MSAT, LSPS2_PROMISE_VALIDITY_SECS.
 *   - NOT YET: actual JIT channel open is Phase D (htlc-interceptor +
 *     zero_conf channel_open). For now /lsps2/buy issues the promise only;
 *     no channel is opened until a real HTLC arrives with the matching SCID.
 *   - REMOVED: /lsps2/jit 501 stub (replaced by real endpoints).
 *   - SECURITY: both endpoints require adapter secret (same as other routes
 *     except /health). LSPS2 protocol-level "permissionless discovery" is
 *     served by the macaroon being public in the LIJOX registry.
 *
 * v0.15 (correct Cloudflare URLs + route_macaroon self-heal):
 *   - FIX: registerWithRegistry() now sends endpoint, route_endpoint,
 *     wss_url, AND route_macaroon on every restart, all derived from
 *     CONFIG.public (the Cloudflare-fronted URLs) and CONFIG.adapter
 *     (the shared LSP secret).
 *   - Pre-v0.15, registration only sent `endpoint` derived from
 *     NODE_HOST, but NODE_HOST is the Lightning P2P address — its
 *     Cloudflare tunnel is a raw TCP tunnel to port 9735, not an HTTP
 *     or WSS host. Browser wallets served from the wallet web origin
 *     couldn't fetch any HTTP URL the adapter advertised (mixed-content
 *     block), and the WSS URL was pointing at the wrong tunnel.
 *   - Pre-v0.15, route_macaroon was never sent at all, so it stayed null
 *     in the worker registry. Wallets reading registry got null and
 *     either sent no auth header or a stale cached value — either way,
 *     /v1/route/build returned 401 Unauthorized after any registry reset.
 *   - NEW: CONFIG.public.{https_url, wss_url} with lij-tunnel defaults.
 *     Override via PUBLIC_HTTPS_URL / PUBLIC_WSS_URL env vars.
 *   - /info endpoint's ws_proxy_url now uses CONFIG.public.wss_url.
 *   - SECURITY MODEL: route_macaroon is the shared LSP secret. Same value
 *     across all wallet users by design — it's a capability token for
 *     the public LSP, not a per-wallet credential. Exposing via /lsps is
 *     the wallet discovery mechanism. Rotate ADAPTER_SECRET if compromised.
 *   - After this patch, every adapter restart re-asserts all four fields
 *     to the worker registry — full self-heal, no more curl band-aids.
 *
 * v0.14 (cltv_expiry_delta fix for LSP→destination hop):
 *   - FIX: /v1/route/build now adjusts route.total_time_lock to include
 *     the LSP's own outgoing cltv_expiry_delta on the LSP→destination
 *     channel. LND's QueryRoutes treats the adapter as the source and
 *     returns routes where total_time_lock equals hops[0].expiry; LDK
 *     parses this as cltv_expiry_delta=0 for the LSP→destination hop;
 *     the LSP then rejects the HTLC with incorrect_cltv_expiry(0x100d)
 *     because its actual channel_update policy requires a positive delta.
 *     Observed against the LSP↔Umbrel channel (be3478e6,
 *     time_lock_delta=80).
 *   - Idempotent: only adjusts when total_time_lock < hops[0].expiry +
 *     policy.cltv_expiry_delta, so multi-hop routes where LND already
 *     accounts for the delta chain are left untouched.
 *   - Reuses the existing lookupChannelPolicy() introduced in v0.12.
 *
 * v0.13 (ignored_pairs retry exclusions):
 *   - NEW: POST /v1/route/build accepts ignored_pairs in the body for
 *     wallet retry-with-exclusion. Pairs are hex pubkeys client-side,
 *     converted to base64 before being passed to LND's QueryRoutes.
 *
 * v0.12 (LSP self-hop policy enrichment):
 *   - NEW: /v1/route/build response includes lsp_first_hop_policy with
 *     the LSP's actual outgoing-channel policy for the first downstream
 *     hop, so the wallet's self-hop prepend has correct fee+cltv data
 *     instead of relying on counterparty.forwarding_info (wrong direction).
 *   - NEW: lookupChannelPolicy() queries LND /v1/graph/edge/{chan_id}.
 *   - NEW: LOCAL_PUBKEY cached at startup from /v1/getinfo.
 *
 * v0.11 (Phase 10b route-hint support + peer keepalive):
 *   - NEW: POST /v1/route/build endpoint accepting full QueryRoutes body
 *     including route_hints. Lets wallets pay destinations behind
 *     unannounced channels (WoS, Strike, custodial wallets, LSPs, etc.)
 *     by passing invoice route_hints through to LND's pathfinder.
 *   - NEW: Critical-peer keepalive. Adapter maintains TCP connection to
 *     configured upstream peers (e.g. Umbrel) that UM890 depends on for
 *     outbound routing. Reconnects on inactivity. Runs every 60s plus
 *     before each /v1/route/build query.
 *   - Existing GET /v1/graph/routes/{pubkey}/{amount} preserved for
 *     backward compatibility — when upgrading to Cloudflare Pro (so SBFM
 *     bypass works), wallets can revert to GET endpoint and v0.11 can be
 *     downgraded to v0.9 cleanly.
 *   - New env var: CRITICAL_PEERS — comma-separated pubkey@host:port list.
 *     (v0.47: no default — operator-set.)
 *
 * v0.9 (CORS): added CORS preflight handling and Access-Control-Allow-*
 *   headers so browser-based LiJ wallets can call HTTP endpoints from
 *   the configured wallet origins without preflight block. Origins
 *   controlled by HTTP_ALLOWED_ORIGINS env var (falls back to
 *   WS_ALLOWED_ORIGINS).
 *
 * v0.8 (Phase 10b routing): added /v1/graph/routes/:pubkey/:amount endpoint.
 *   LiJ wallet calls this for multi-hop pathfinding when destination is not
 *   the direct LSP. Adapter proxies to LND's REST /v1/graph/routes using its
 *   own macaroon; client auth is the adapter secret, passed either as
 *   x-adapter-secret OR grpc-metadata-macaroon header (the latter is what
 *   Phase 10b's wallet code already sends as `route_macaroon_hex`).
 *
 * Turns any LND node into a LIJOX-compatible Lightning Service Provider.
 *
 * Cross-platform: runs anywhere LND runs (Umbrel, RaspiBlitz, VPS, bare metal).
 * Two dependencies: dotenv + ws (WebSocket). Uses Node.js built-in https/net.
 *
 * What this does:
 *   Port 7000 — HTTP API (channel open requests from LIJOX Worker)
 *   Port 7001 — WebSocket proxy (LiJ browser nodes connect as Lightning peers)
 *   Cooperative chain-data bridge — LiJ wallets subscribe to chain notifications
 *     via custom Lightning messages, the bridge responds via LND's
 *     /v1/custommessage endpoints. LSP-side handler for the LiJ chain protocol.
 *
 * Security:
 *   - Rate limiting on channel requests (per IP)
 *   - WebSocket origin validation (configured origins only)
 *   - Channel size caps (min/max enforced)
 *   - Adapter secret required for all channel operations
 *
 * Setup:
 *   1. npm install dotenv ws
 *   2. Create .env file (see below)
 *   3. node lij-adapter.js
 *
 * .env file:
 *   LND_ENDPOINT=https://localhost:8080
 *   LND_GRPC_ENDPOINT=localhost:10009                    (v0.6: gRPC for streaming RPCs)
 *   LND_TLS_CERT_PATH=/home/USER/.lnd/tls.cert           (v0.6: gRPC TLS cert path)
 *   LND_PEER_HOST=localhost
 *   LND_PEER_PORT=9735
 *   LIJ_ADAPTER_MACAROON_HEX=your_baked_macaroon_hex
 *   ADAPTER_PORT=7000
 *   WS_PROXY_PORT=7001
 *   ADAPTER_SECRET=pick_a_random_string
 *   LIJOX_REGISTRY=            (optional — leave unset to run registry-free)
 *   NODE_PUBKEY=your_lnd_node_pubkey
 *   NODE_HOST=your_public_ip:9735
 *   NODE_NAME=Your Node Name
 *   FEE_PPM=1000
 *   CHANNEL_SIZE_SATS=500000
 *   PUSH_SATS=250000
 *   MIN_CHANNEL_SATS=100000
 *   MAX_CHANNEL_SATS=2000000
 *   RATE_LIMIT_REQUESTS=3
 *   RATE_LIMIT_WINDOW_MS=3600000
 *   WS_ALLOWED_ORIGINS=https://wallet.example.com   (REQUIRED)
 *   CHAIN_BRIDGE_ENABLED=true   (v0.5: set false to disable bridge subsystem only)
 *   PUBLIC_HTTPS_URL=https://lsp.example.com   (REQUIRED: public HTTPS front of the adapter HTTP API)
 *   PUBLIC_WSS_URL=wss://ws.example.com         (REQUIRED: public WSS front of the browser peer proxy)
 *
 * v0.5 changes (from v0.4):
 *   - New cooperative chain-data bridge subsystem
 *   - Required macaroon scopes expanded: peers:read, peers:write, onchain:read,
 *     onchain:write (in addition to v0.4's info:read, offchain:read+write)
 *   - /health response now reports chain_bridge status
 *
 * v0.6 changes (from v0.5):
 *   - Pivoted chain bridge to native gRPC for streaming subscriptions.
 *     LND's REST gateway in this build hangs on server-streaming endpoints
 *     (HTTP_status=000 on /v1/custommessage/subscribe and /v1/peers/subscribe).
 *   - Added @grpc/grpc-js + @grpc/proto-loader as dependencies.
 *   - SubscribeCustomMessages and SendCustomMessage now go through gRPC.
 *   - Non-streaming endpoints (/v1/getinfo, /v2/wallet/estimatefee) stay on REST.
 *   - New env vars: LND_GRPC_ENDPOINT, LND_TLS_CERT_PATH.
 *
 * v0.7 changes (from v0.6) — Step 3 chainnotifier integration:
 *   - Added ChainNotifier gRPC client. Bridge subscribes to:
 *       RegisterBlockEpochNtfn   (single shared stream, fans out to all peers)
 *       RegisterConfirmationsNtfn (per-watch-tx, peer-multiplexed)
 *       RegisterSpendNtfn        (per-watch-output, peer-multiplexed)
 *   - Added WalletKit gRPC client. Bridge calls PublishTransaction to fulfill
 *     wallet BroadcastTx requests, classified as Relayed/Rejected/Unavailable.
 *   - Bridge produces five outbound message types (was one in v0.6):
 *       ChainDataBundle, BlockHeightUpdate, FundingTxConfirmed,
 *       ChannelStateUpdate, BroadcastAck.
 *   - /health now includes stream counts under chain_bridge.streams.
 */

'use strict';

require('dotenv').config();

const https  = require('https');
const http   = require('http');
const net    = require('net');
const url    = require('url');
const os     = require('os');
const crypto = require('crypto');  // v0.16: for jit_channel_scid generation
const { WebSocketServer } = require('ws');

// v0.5: cooperative chain bridge subsystem
// v0.6: gRPC client for streaming + custom message send
// v0.7: ChainNotifier + WalletKit clients added for Step 3 chainnotifier
const { startBridge } = require('./cooperative-chain-bridge');
const lijDelegate = require('./delegate.js'); // v0.23: DELEGATE PAYMENT — S25 side trip; the module's entire adapter footprint is this require + one router branch

// ── OPEN-INTENT v1 (v0.35.0, S30) — docs/openintent-v1.md ─────────────────
// Trustless Mode B: the CLIENT funds its own channel; this box only stores
// signed intents (idempotent by intent_id) and reports state derived from
// our own node's observation. Possession gate at POST: the claimed pubkey
// must be a connected peer right now; the BIP-340/lightning-message sig is
// recorded for audit, with signrpc verification as the marked hardening.
// States: RECEIVED → FUNDING_SEEN (pending open observed; funding txid
// known; sticky past expiry) → CONFIRMED; EXPIRED when expiry passes with
// nothing observed. NEGOTIATING reserved for acceptor-hook builds.
// ── v0.48 (D1): ONE state root. Every adapter state file lives under
// DATA_DIR (default: beside the code). Set LIJ_DATA_DIR to relocate —
// e.g. /var/lib/lijox-adapter — and the adapter creates it at boot.
const DATA_DIR = process.env.LIJ_DATA_DIR || __dirname;
try { require('fs').mkdirSync(DATA_DIR, { recursive: true }); }
catch (e) { console.error('DATA_DIR is not writable: ' + DATA_DIR + ' — ' + e.message); process.exit(1); }
// v0.48 (P4): client IPs are NOT logged unless the operator opts in.
const LOG_CLIENT_IP = (process.env.LOG_CLIENT_IP || 'off') === 'on';
// v0.54 (O3): wallet-side channel reserve at JIT open, in SATS.
// 0/unset = LND default (~1%) — proto3 cannot express true zero.
// Recommended minimum when set: the BOLT2 dust floor, ~354 sats.
const JIT_REMOTE_RESERVE_SATS = Math.max(0, parseInt(process.env.JIT_REMOTE_RESERVE_SATS || '0', 10) || 0);
// v0.54.6 (DP): the env is a CAP, not a flat value — per channel:
//   reserve = max(354 dust floor, min(CAP, 1% of channel size)).
// At channel_min 100k sats, 1% >= 1000 so this equals flat CAP today; the
// formula matters for operators allowing smaller channels.
function jitRemoteReserveFor(channelSats) {
  if (JIT_REMOTE_RESERVE_SATS <= 0) return 0;
  const onePct = Math.floor((parseInt(channelSats, 10) || 0) / 100);
  return Math.max(354, Math.min(JIT_REMOTE_RESERVE_SATS, onePct || JIT_REMOTE_RESERVE_SATS));
}
// ── v0.56.0 (S36, O5 full balance availability — DP GREEN) ──────────────────
// The wallet-side reserve on NEW JIT channels drops to the honest floor —
// max(354 BOLT2 dust, JIT_PREFUND_SATS) — governed by TWO daily governors
// (DP ruling): a COUNT of floor-reserve opens and an AGGREGATE capacity in
// sats. Above EITHER, the reserve reverts to the full 1% ("as before") and
// the prefund is suspended for that open. The PREFUND (default 400 sats,
// DP's round-up) is ADVERTISED via get_info/buy; the wallet adds it to the
// invoice (payer funds the floor), the settle-forward delivers gross − fee,
// so the 400 lands ON the user's side and leaves WITH them at close — it is
// their money, priced into the open. Behavior-neutral for wallets that do
// not yet read prefund_msat (LiJ v544+ does).
const JIT_PREFUND_SATS = Math.max(0, parseInt(process.env.JIT_PREFUND_SATS || '400', 10) || 0);
const JIT_FLOOR_MAX_OPENS_PER_DAY = Math.max(0, parseInt(process.env.JIT_FLOOR_MAX_OPENS_PER_DAY || '25', 10) || 0);
const JIT_FLOOR_MAX_SATS_PER_DAY = Math.max(0, parseInt(process.env.JIT_FLOOR_MAX_SATS_PER_DAY || '2000000', 10) || 0);
const FLOORGOV_PATH = require('path').join(DATA_DIR, 'floorgov.json');
let floorGov = { day: '', count: 0, sats: 0 };
try { floorGov = Object.assign(floorGov, JSON.parse(require('fs').readFileSync(FLOORGOV_PATH, 'utf8'))); } catch (e) {}
function floorGovSave() {
  try { require('fs').writeFileSync(FLOORGOV_PATH, JSON.stringify(floorGov)); }
  catch (e) { console.error(`[O5] floorgov persist failed: ${e.message}`); }
}
function floorGovToday() {
  const day = new Date().toISOString().slice(0, 10);   // UTC day bucket
  if (floorGov.day !== day) { floorGov = { day, count: 0, sats: 0 }; floorGovSave(); }
  return floorGov;
}
// Governor check. channelSats=0 = the advisory (buy/get_info) form: count +
// headroom only, optimistic on size — the OPEN-time check is authoritative.
function floorModeAllowed(channelSats) {
  const g = floorGovToday();
  const okCount = (JIT_FLOOR_MAX_OPENS_PER_DAY <= 0) || (g.count < JIT_FLOOR_MAX_OPENS_PER_DAY);
  const okSats  = (JIT_FLOOR_MAX_SATS_PER_DAY  <= 0) || (g.sats + (parseInt(channelSats, 10) || 0) <= JIT_FLOOR_MAX_SATS_PER_DAY);
  return okCount && okSats;
}
function floorGovRecord(channelSats) {
  const g = floorGovToday();
  g.count += 1; g.sats += (parseInt(channelSats, 10) || 0);
  floorGovSave();
  console.log(`[O5] floor-reserve open recorded: #${g.count} today, ${g.sats} sats aggregate (limits ${JIT_FLOOR_MAX_OPENS_PER_DAY}/day, ${JIT_FLOOR_MAX_SATS_PER_DAY} sats/day)`);
}
// The v0.56.0 reserve resolver: floor mode = max(354 dust, prefund, legacy
// JIT_REMOTE_RESERVE_SATS if set — the box's 400 aligns); percent mode =
// the full 1% (dust-floored), exactly the pre-knob behavior DP named.
function jitReserveForOpen(channelSats) {
  const onePct = Math.floor((parseInt(channelSats, 10) || 0) / 100);
  if (floorModeAllowed(channelSats)) {
    floorGovRecord(channelSats);
    const r = Math.max(354, JIT_PREFUND_SATS, JIT_REMOTE_RESERVE_SATS || 0);
    console.log(`[O5] reserve mode=floor: ${r} sats on ${channelSats}-sat channel`);
    return r;
  }
  const r = Math.max(354, onePct);
  console.log(`[O5] governor tripped — reserve mode=percent: ${r} sats (1%) on ${channelSats}-sat channel; prefund suspended for this open`);
  return r;
}
const OPENINTENT_PATH = require('path').join(DATA_DIR, 'openintents.json');
let openIntents = {};
try { openIntents = JSON.parse(require('fs').readFileSync(OPENINTENT_PATH, 'utf8')); } catch (e) { openIntents = {}; }
function openIntentsSave() {
  try { require('fs').writeFileSync(OPENINTENT_PATH, JSON.stringify(openIntents)); }
  catch (e) { console.error('[OpenIntent] store save failed: ' + e.message); }
}
const _oiStateCache = new Map();
async function openIntentObserve(rec) {
  const now = Date.now();
  const cached = _oiStateCache.get(rec.intent_id);
  if (cached && now - cached.ts < 5000) return cached;
  let state = 'RECEIVED';
  let funding_txid = rec.funding_txid || null;
  try {
    const open = await lndGet('/v1/channels');
    const hit = (open.channels || []).find(ch =>
      (ch.remote_pubkey || '').toLowerCase() === rec.client_pubkey.toLowerCase() &&
      Number(ch.capacity) === Number(rec.amount_sats));
    if (hit) { state = 'CONFIRMED'; funding_txid = String(hit.channel_point || '').split(':')[0] || funding_txid; }
  } catch (e) {}
  if (state !== 'CONFIRMED') {
    try {
      const pend = await lndGet('/v1/channels/pending');
      const hit = (pend.pending_open_channels || []).find(p => p.channel &&
        (p.channel.remote_node_pub || '').toLowerCase() === rec.client_pubkey.toLowerCase() &&
        Number(p.channel.capacity) === Number(rec.amount_sats));
      if (hit) { state = 'FUNDING_SEEN'; funding_txid = String(hit.channel.channel_point || '').split(':')[0] || funding_txid; }
    } catch (e) {}
  }
  if (funding_txid && state === 'RECEIVED') state = 'FUNDING_SEEN';
  if (state === 'RECEIVED' && now > Number(rec.expiry_ms || 0)) state = 'EXPIRED';
  const out = { ts: now, state: state, funding_txid: funding_txid };
  _oiStateCache.set(rec.intent_id, out);
  if (rec.last_state !== state) {
    rec.last_state = state;
    if (funding_txid) rec.funding_txid = funding_txid;
    openIntentsSave();
    console.log('[OpenIntent] ' + rec.intent_id.slice(0, 12) + '\u2026 \u2192 ' + state + (funding_txid ? (' funding=' + String(funding_txid).slice(0, 12) + '\u2026') : ''));
  }
  return out;
}
const _oiRate = new Map();
function oiRateLimited(ip) {
  const now = Date.now();
  let e = _oiRate.get(ip);
  if (!e || now > e.resetAt) { e = { n: 0, resetAt: now + 60000 }; _oiRate.set(ip, e); }
  e.n += 1;
  return e.n > 10;
}

// ── TAPEDROP (v0.36.0, S30) — mobile flight-recorder evidence pipe ────────
// Phones can't open a console; their close-tapes upload here instead.
// Possession-gated (uploader pubkey must be a live peer), 256KB cap,
// 20/hour per IP. Written to tapes/ beside the adapter + a journal digest.
const TAPES_DIR = require('path').join(DATA_DIR, 'tapes');
// 0.72.0 (S45 #10): the PL engine — fee ledger + daily snapshots (pl.js). Created
// at boot next to the console; the fee-realization points below write through
// plRecord, which is a no-op until then.
let plEngine = null;
function plRecord(kind, fields) { try { if (plEngine) plEngine.record(kind, fields); } catch (_) {} }
try { require('fs').mkdirSync(TAPES_DIR, { recursive: true }); } catch (e) {}
const _tdRate = new Map();
function tdRateLimited(ip) {
  const now = Date.now();
  let e = _tdRate.get(ip);
  if (!e || now > e.resetAt) { e = { n: 0, resetAt: now + 3600000 }; _tdRate.set(ip, e); }
  e.n += 1;
  return e.n > 20;
}
// \u2500\u2500 v0.44.0 (S32): TELEMETRY METER \u2014 the LSP stops expecting after a while.
// Telemetry is the wallet's choice (page v464 switch, purely client-side).
// The box meters per-pubkey tape recency; silent > TELEMETRY_DARK_MS marks
// the wallet telemetry-dark with ONE journal line, then silence \u2014 no
// nagging, no buffers, no bandwidth spent expecting. A tape re-lights it.
const TELEMETRY_DARK_MS = parseInt(process.env.LIJ_TELEMETRY_DARK_MS || String(24 * 3600 * 1000), 10);
const telemetryMeter = new Map();  // pk -> { lastAt, dark }
function telemetrySeen(pk) {
  const e = telemetryMeter.get(pk) || { lastAt: 0, dark: false };
  if (e.dark) console.log('[TelemetryMeter] ' + pk.slice(0, 16) + '\u2026 re-lit \u2014 tape after dark');
  e.lastAt = Date.now(); e.dark = false;
  telemetryMeter.set(pk, e);
}
setInterval(() => {
  const now = Date.now();
  for (const [pk, e] of telemetryMeter) {
    if (!e.dark && now - e.lastAt > TELEMETRY_DARK_MS) {
      e.dark = true;
      console.log('[TelemetryMeter] ' + pk.slice(0, 16) + '\u2026 telemetry dark >'
        + Math.round(TELEMETRY_DARK_MS / 3600000) + 'h \u2014 expectation released');
    }
  }
}, 3600000);

async function handleTapeDrop(req, res, ip) {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (tdRateLimited(ip)) return reply(429, { ok: false, code: 'RATE_LIMITED' });
  let b;
  try { b = await readBody(req); } catch (e) { return reply(400, { ok: false, code: 'BAD_JSON' }); }
  const pk = String(b.client_pubkey || '').toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(pk)) return reply(400, { ok: false, code: 'BAD_FIELDS' });
  const peers = await peersConnectedSet();
  if (!peers.has(pk)) return reply(403, { ok: false, code: 'PUBKEY_NOT_CONNECTED' });
  const payload = JSON.stringify(b.tape || b);
  if (payload.length > 262144) return reply(413, { ok: false, code: 'TOO_LARGE' });
  const id8 = String(b.tape_id || Date.now()).replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 24) || String(Date.now());
  const fname = require('path').join(TAPES_DIR, Date.now() + '-' + id8 + '.json');
  try { require('fs').writeFileSync(fname, payload); } catch (e) { return reply(500, { ok: false, code: 'WRITE_FAILED' }); }
  let digest = '';
  try {
    const t = b.tape || b;
    digest = ' reason=' + String((t.reason || '')).slice(0, 60) + ' events=' + ((t.tape && t.tape.events) ? t.tape.events.length : '?') + ' tip=' + JSON.stringify((t.tape && t.tape.bridge_tip) || null);
  } catch (e) {}
  console.log('[TapeDrop] ' + pk.slice(0, 16) + '\u2026 \u2192 ' + fname.split('/').pop() + digest);
  try { telemetrySeen(pk); } catch (e) {}  // v0.44.0: meter the expectation
  return reply(200, { ok: true });
}

async function handleOpenIntent(req, res, path, method, ip) {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (method === 'POST' && path === '/openintent') {
    if (oiRateLimited(ip)) return reply(429, { ok: false, code: 'RATE_LIMITED' });
    let b;
    try { b = await readBody(req); } catch (e) { return reply(400, { ok: false, code: 'BAD_JSON' }); }
    const id = String(b.intent_id || '').slice(0, 64);
    const pk = String(b.client_pubkey || '').toLowerCase();
    const amt = Number(b.amount_sats);
    if (!id || !/^[0-9a-f]{66}$/.test(pk) || !(amt > 0) || !b.sig) return reply(400, { ok: false, code: 'BAD_FIELDS' });
    if (openIntents[id]) {
      const st0 = await openIntentObserve(openIntents[id]);
      return reply(200, { ok: true, state: st0.state, funding_txid: st0.funding_txid || null, expiry_ms: openIntents[id].expiry_ms });
    }
    // Possession gate (v1): the claimed pubkey must be a live peer NOW.
    // HARDENING INSERTION POINT: signrpc.VerifyMessage(canonical, sig, pk)
    // replaces/augments this gate when the grpc wrapper grows the signer
    // service — the sig is recorded below either way for audit.
    const peers = await peersConnectedSet();
    if (!peers.has(pk)) return reply(403, { ok: false, code: 'PUBKEY_NOT_CONNECTED' });
    const expiry = Math.min(Number(b.expiry_ms) || 0, Date.now() + 7 * 86400000) || (Date.now() + 86400000);
    openIntents[id] = {
      v: 1, intent_id: id, client_pubkey: pk, amount_sats: amt,
      fee_rate_sat_vb: Number(b.fee_rate_sat_vb) || 0,
      created_ms: Number(b.created_ms) || Date.now(),
      expiry_ms: expiry,
      sig: String(b.sig).slice(0, 300),
      first_seen_ms: Date.now(), last_state: 'RECEIVED', funding_txid: null,
    };
    openIntentsSave();
    console.log('[OpenIntent] RECEIVED id=' + id.slice(0, 12) + '\u2026 pubkey=' + pk.slice(0, 16) + '\u2026 amt=' + amt);
    return reply(200, { ok: true, state: 'RECEIVED', expiry_ms: expiry });
  }
  if (method === 'GET' && path.startsWith('/openintent/')) {
    const id = path.slice('/openintent/'.length).slice(0, 64);
    const rec = openIntents[id];
    if (!rec) return reply(404, { ok: false, code: 'UNKNOWN_INTENT' });
    const st = await openIntentObserve(rec);
    return reply(200, { ok: true, state: st.state, funding_txid: st.funding_txid || null, expiry_ms: rec.expiry_ms });
  }
  return reply(404, { ok: false, code: 'NOT_FOUND' });
}
setInterval(function () {
  stampLoop('intent_prune', 3600000);
  const cut = Date.now() - 48 * 3600000;
  let n = 0;
  for (const idr of Object.keys(openIntents)) {
    const r = openIntents[idr];
    if (Number(r.expiry_ms || 0) < cut && r.last_state !== 'CONFIRMED') { delete openIntents[idr]; n++; }
  }
  if (n) { openIntentsSave(); console.log('[OpenIntent] pruned ' + n + ' stale intent(s)'); }
}, 3600000);

const {
  makeLightningClient,
  makeChainNotifierClient,
  makeWalletKitClient,
  makeRouterClient,
  makeLightningOpenChannelClient,
  subscribeHtlcInterceptor,
  openChannelSync,
  sendToRouteV2,
} = require('./lnd-grpc');

// v0.19: LSP channel registry for Phase 1c (seed-only wallet recovery).
// Wallets POST signed channel records here so they can be retrieved by signed
// challenge after total local-state loss. Auth is intrinsic (secp256k1
// signature over a single-use nonce); these routes are PUBLIC -- they dispatch
// BEFORE the authOk gate in the http.createServer handler.
// v0.18.7: reverted to in-memory MemoryChannelStore. SqliteChannelStore is
// still exported from registry.js for future use but NOT loaded here (we want
// to isolate whether the native `better-sqlite3` load is the trigger for
// today's openChannelSync wire-format failures). Records do NOT survive
// adapter restart; persistence is deferred until a non-conflicting backend
// is identified.
const {
  makeRegistryRouter,
  NonceStore: RegistryNonceStore,
  MemoryChannelStore: RegistryMemoryChannelStore,
  buildSignedMessage: registryBuildSignedMessage,
  verifySignature: registryVerifySignature,
  NONCE_LENGTH: REGISTRY_NONCE_LENGTH,
} = require('./registry');

// ── Config ────────────────────────────────────────────────────────────────────

// 0.69.0 (S44, DP GO): THE CHANNEL-OPENING FEE knobs — rail-neutral names.
// fee = max(CHANNEL_OPEN_FEE_MIN_SATS, ceil(amount × CHANNEL_OPEN_FEE_PPM / 1e6))
// × per-wallet escalator × scarcity multiplier, for EVERY channel open on
// every rail. Defaults 100 sats / 100 ppm (0.01 %): "100 sats for opens up to
// 1,000,000 sats, then 0.01 % above". Deprecated names still load:
// LSPS2_VAR_FEE_PPM → ppm; LSPS2_VAR_MIN_FEE_MSAT → floor (msat).
// LSPS2_CHANNEL_OPEN_FEE_SATS is IGNORED — the fixed bolt11 path used to
// charge it flat, outside the law; now every rail charges the one function.
function openFeePpmFromEnv() {
  if (process.env.CHANNEL_OPEN_FEE_PPM !== undefined) return parseInt(process.env.CHANNEL_OPEN_FEE_PPM, 10);
  if (process.env.LSPS2_VAR_FEE_PPM !== undefined) {
    console.warn('[Config] LSPS2_VAR_FEE_PPM is deprecated — rename it CHANNEL_OPEN_FEE_PPM (same meaning: the % part of the channel-opening fee, in ppm)');
    return parseInt(process.env.LSPS2_VAR_FEE_PPM, 10);
  }
  return 100;
}
function openFeeMinMsatFromEnv() {
  if (process.env.CHANNEL_OPEN_FEE_MIN_SATS !== undefined) return parseInt(process.env.CHANNEL_OPEN_FEE_MIN_SATS, 10) * 1000;
  if (process.env.LSPS2_VAR_MIN_FEE_MSAT !== undefined) {
    console.warn('[Config] LSPS2_VAR_MIN_FEE_MSAT is deprecated — rename it CHANNEL_OPEN_FEE_MIN_SATS (in SATS: the floor of the channel-opening fee)');
    return parseInt(process.env.LSPS2_VAR_MIN_FEE_MSAT, 10);
  }
  return 100000;
}
if (process.env.LSPS2_CHANNEL_OPEN_FEE_SATS !== undefined) {
  console.warn('[Config] LSPS2_CHANNEL_OPEN_FEE_SATS is IGNORED since 0.69.0 — the opening fee on every rail is max(CHANNEL_OPEN_FEE_MIN_SATS, CHANNEL_OPEN_FEE_PPM × amount); delete the line');
}
const CONFIG = {
  lnd: {
    endpoint:      process.env.LND_ENDPOINT  || 'https://localhost:8080',
    peer_host:     process.env.LND_PEER_HOST || 'localhost',
    peer_port:     parseInt(process.env.LND_PEER_PORT || '9735'),
    macaroon:      process.env.LIJ_ADAPTER_MACAROON_HEX || '',
    // v0.6: gRPC for streaming RPCs (REST gateway hangs on streams in this LND build)
    grpc_endpoint: process.env.LND_GRPC_ENDPOINT || 'localhost:10009',
    tls_cert_path: process.env.LND_TLS_CERT_PATH || `${os.homedir()}/.lnd/tls.cert`,
  },
  adapter: {
    port:    parseInt(process.env.ADAPTER_PORT  || '7000'),
    ws_port: parseInt(process.env.WS_PROXY_PORT || '7001'),
    secret:  process.env.ADAPTER_SECRET || '',
  },
  registry: process.env.LIJOX_REGISTRY || '', // v0.47 (Q3): registries are OPTIONAL — empty = enroll nowhere; plural REGISTRY list lands with the LIJOX-layer restructure
  node: {
    pubkey:  process.env.NODE_PUBKEY || '',
    host:    process.env.NODE_HOST   || '',
    name:    process.env.NODE_NAME   || 'LIJOX Node',
    fee_ppm: parseInt(process.env.FEE_PPM || '1000'),
  },
  channel: {
    size_sats: parseInt(process.env.CHANNEL_SIZE_SATS || '500000'),
    push_sats: parseInt(process.env.PUSH_SATS         || '250000'),
    min_sats:  parseInt(process.env.MIN_CHANNEL_SATS  || '100000'),
    max_sats:  parseInt(process.env.MAX_CHANNEL_SATS  || '2000000'),
    // v0.18.5: reserve_sat applied to JIT channels opened by this LSP to a
    // browser wallet. Percent of channel capacity. Default 0 → wallet can
    // spend the full receive amount. Set higher (e.g. 1) only if you have a
    // specific reason to demand a wallet-side reserve. LND honors 0 down to
    // dust_limit_satoshis.
    jit_channel_reserve_percent: parseInt(process.env.JIT_CHANNEL_RESERVE_PERCENT || '0'),
  },
  security: {
    rate_limit_requests:  parseInt(process.env.RATE_LIMIT_REQUESTS   || '3'),
    rate_limit_window_ms: parseInt(process.env.RATE_LIMIT_WINDOW_MS  || '3600000'),
    // v0.18.5: separate, looser rate limit for admin endpoints
    // (/admin/registry/channels, etc.) so operator inspection doesn't share
    // the 3/hour channel-open limit. 60/min default.
    admin_rate_limit_requests:  parseInt(process.env.ADMIN_RATE_LIMIT_REQUESTS  || '60'),
    admin_rate_limit_window_ms: parseInt(process.env.ADMIN_RATE_LIMIT_WINDOW_MS || '60000'),
    // v0.18.5: SqliteChannelStore DB file path.
    registry_db_path:     process.env.REGISTRY_DB_PATH || require('path').join(DATA_DIR, 'registry.db'),  // v0.48 (D1)
    ws_allowed_origins:   (process.env.WS_ALLOWED_ORIGINS || '')  // v0.47: REQUIRED (checked at startup)
                            .split(',').map(o => o.trim()).filter(Boolean),
  },
  // v0.5: chain bridge subsystem on/off switch (defaults enabled)
  chain_bridge: {
    enabled: (process.env.CHAIN_BRIDGE_ENABLED || 'true').toLowerCase() !== 'false',
  },
  // v0.21 LEASE (S25 item 0 == the Line-3 lease, LSP side): connection-
  // based channel expiry. "Heard from" = an authenticated peer connection
  // (DP-ratified recovery doctrine); the PWA cannot connect in the
  // background, so every reestablish IS a user touch. After ttl days
  // unheard-from, the LSP force-closes; the terminus pin pays the user's
  // balance to their m/84 tree directly (recovery-classes flavor B).
  // Fully dormant unless LEASE_ENABLE=true. DRY_RUN defaults ON: cycles
  // run and log would_close decisions but never broadcast.
  lease: {
    enabled:       (process.env.LEASE_ENABLE  || 'false').toLowerCase() === 'true',
    dry_run:       (process.env.LEASE_DRY_RUN || 'true').toLowerCase() !== 'false',
    days:          parseFloat(process.env.LEASE_DAYS || '60'),
    cycle_minutes: parseFloat(process.env.LEASE_CYCLE_MINUTES || '60'),
    exclude:       (process.env.LEASE_EXCLUDE_CHANPOINTS || '')
                     .split(',').map(s => s.trim()).filter(Boolean),
    lncli:         process.env.LEASE_LNCLI || 'lncli',
    state_path:    process.env.LEASE_STATE_PATH || require('path').join(DATA_DIR, 'lease-state.json'),  // v0.48 (D1)
    log_path:      process.env.LEASE_LOG_PATH   || require('path').join(DATA_DIR, 'lease-log.ndjson'),  // v0.48 (D1)
  },
  // v0.15: public Cloudflare-fronted URLs for HTTPS API and WSS proxy.
  // NODE_HOST is the Lightning P2P address (TCP-only tunnel to port 9735)
  // and is NOT usable as an HTTP or WSS host. The defaults below match
  // the lij-tunnel ingress config; override via env vars for other
  // deployments.
  public: {
    https_url: process.env.PUBLIC_HTTPS_URL || '',  // v0.47: REQUIRED (checked at startup)
    wss_url:   process.env.PUBLIC_WSS_URL   || '',  // v0.47: REQUIRED (checked at startup)
  },
  // v0.11: critical peers we must stay connected to for outbound routing.
  // Each entry is "pubkey@host:port". Adapter reconnects any that drop out
  // every 60s and before serving route-build queries.
  // v0.47: operator-set, no default — leave unset if the node needs no
  // pinned outbound conduits.
  critical_peers: (process.env.CRITICAL_PEERS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(spec => {
      const [pubkey, hostport] = spec.split('@');
      return { pubkey, hostport };
    }),
  // v0.16: LSPS2 JIT pricing & service terms. Drives /lsps2/get_info response.
  // Pricing rationale documented in docs/LSP_PRICING.md. Loss-leader posture:
  // channel-open fee priced below first-principles fair value to acquire flow
  // and positional liquidity ownership; per-send fees set at market (Zeus/WoS
  // comparable: 0.1% + 1 sat/send). Internal pricing_inputs are exposed in
  // /lsps2/get_info for transparency but NOT used at runtime — they document
  // the derivation so the fee fields can be tuned without recomputing.
  lsps2: {
    // Protocol-spec fields (LSPS2 standard)
    min_payment_size_msat:        parseInt(process.env.LSPS2_MIN_PAYMENT_SIZE_MSAT || '1000000'),       // 1k sat — true dust minimum
    max_payment_size_msat:        parseInt(process.env.LSPS2_MAX_PAYMENT_SIZE_MSAT || '1000000000'),    // 1M sat capacity cap
    // v0.20 VARIABLE: open-amount JIT knobs (the LSP-economics levers).
    variable_enabled:             (process.env.LSPS2_VAR_ENABLED || 'true') === 'true',
    // 0.69.0: the channel-opening fee law (see openFeePpmFromEnv above) —
    // shared by the open-amount flush, the fixed bolt11 buy and the LNURL rail.
    open_fee_ppm:                 openFeePpmFromEnv(),        // 100 = 0.01 % of the payment
    open_fee_min_msat:            openFeeMinMsatFromEnv(),    // 100,000 msat = 100 sats floor
    variable_quiesce_ms:          parseInt(process.env.LSPS2_VAR_QUIESCE_MS     || '8000',    10),  // silence = set final
    variable_ceiling_msat:        parseInt(process.env.LSPS2_VAR_CEILING_MSAT   || process.env.LSPS2_MAX_PAYMENT_SIZE_MSAT || '1000000000', 10),  // sizing cap
    // v0.32.0 (S30, DP designs 26 Jul): LSP self-protection knobs.
    jit_min_onchain_reserve_sats: parseInt(process.env.JIT_MIN_ONCHAIN_RESERVE_SATS || '2000000', 10),  // no JIT open below this confirmed on-chain floor
    jit_fee_free_opens:           parseInt(process.env.JIT_FEE_FREE_OPENS           || '5',       10),  // opens 1..N at base terms
    jit_fee_step_pct:             parseInt(process.env.JIT_FEE_STEP_PCT             || '50',      10),  // each open past N adds +pct of the whole base fee
    // v0.33.0 (S30, DP ratified): SCARCITY curve — identity-free, Sybil-proof,
    // honest-globally. Base terms while headroom ≥ ramp_start; linear to
    // max_pct at zero headroom; the reserve gate refuses below the floor.
    jit_scarcity_ramp_start_sats: parseInt(process.env.JIT_SCARCITY_RAMP_START_SATS || String(2 * parseInt(process.env.JIT_MIN_ONCHAIN_RESERVE_SATS || '2000000', 10)), 10),
    jit_scarcity_max_pct:         parseInt(process.env.JIT_SCARCITY_MAX_PCT         || '300',     10),
    base_fee_msat:                parseInt(process.env.LSPS2_BASE_FEE_MSAT         || '1000'),          // 1 sat per forward
    fee_ppm:                      parseInt(process.env.LSPS2_FEE_PPM               || '1000'),          // 0.1% per forward
    promise_validity_secs:        parseInt(process.env.LSPS2_PROMISE_VALIDITY_SECS || '600'),           // 10 min quote validity
    client_trusts_lsp:            true,                                                                  // v1 only
    supported_versions:           [1],

    // (0.69.0: the flat channel_open_fee_sats knob is gone — the fixed bolt11
    // buy charges channelOpenFeeMsat like every other rail; the manifest's
    // channel_open_fee_sats field is DERIVED from the floor, see openFeeBaselineSats.)

    // Forward-compatibility for SuperScalar channel-factory model
    channel_model:                'direct',  // "direct" today; "superscalar_leaf" when factories ship

    // Pricing inputs — exposed for transparency, not used at runtime.
    // When tuning CHANNEL_OPEN_FEE_* or fee_ppm, document the change here.
    pricing_inputs: {
      capital_apr_bps:              80,     // 0.8% APR — opportunity cost vs HODL baseline
      expected_lifetime_days:       90,     // cold-start; replace with empirical median after 100 channels
      force_close_probability_bps:  1000,   // 10% — browser-wallet risk profile
      adversarial_reserve_bps:      500,    // 5% margin
    },

    // v0.17 Phase D.1: htlc-interceptor subsystem on/off switch.
    // When enabled, adapter subscribes to LND HtlcInterceptor stream on
    // startup and observes every HTLC. Default action is RESUME for all
    // HTLCs; matches against pendingJitBuys are logged but not acted on.
    // Set LSPS2_INTERCEPTOR_ENABLED=false to disable the subsystem
    // entirely (revert to pre-v0.17 forwarding behavior).
    interceptor_enabled: (process.env.LSPS2_INTERCEPTOR_ENABLED || 'true').toLowerCase() !== 'false',

    // v0.18 Phase D.2: channel-open + trampoline parameters.
    channel_buffer_sats:        parseInt(process.env.LSPS2_CHANNEL_BUFFER_SATS    || '50000', 10),
    reservation_validity_hours: parseInt(process.env.LSPS2_RESERVATION_HOURS      || '24',    10),
    htlc_safety_blocks:         parseInt(process.env.LSPS2_HTLC_SAFETY_BLOCKS     || '10',    10),
    // B-11: MPP aggregation -- shards accumulate under the promise until the
    // sum completes or the window closes.
    agg_window_s:               parseInt(process.env.LSPS2_AGG_WINDOW_S           || '60',    10),
    min_shard_msat:             parseInt(process.env.LSPS2_MIN_SHARD_MSAT         || '1000',  10),
    reconnect_poll_secs:        parseInt(process.env.LSPS2_RECONNECT_POLL_SECS    || '5',     10),
    openchannel_timeout_ms:     parseInt(process.env.LSPS2_OPENCHANNEL_TIMEOUT_MS || '25000', 10),
    sendtoroute_timeout_ms:     parseInt(process.env.LSPS2_SENDTOROUTE_TIMEOUT_MS || '25000', 10),
  },
  // 0.66.0 (S43, DP): the fee policy of every channel this LSP opens to a
  // wallet — set IN the open (LND OpenChannelRequest fields 21–24) and kept
  // by an hourly sweep over private wallet channels (never the world peer).
  chan_policy: {
    base_fee_msat: parseInt(process.env.LIJ_CHAN_BASE_FEE_MSAT || '0',    10),
    fee_ppm:       parseInt(process.env.LIJ_CHAN_FEE_PPM       || '1000', 10),
    enforce:       (process.env.LIJ_CHAN_POLICY_ENFORCE || 'true').toLowerCase() !== 'false',
  },
  // 0.68.0 (S43, DP): the NEUTRAL ADDRESS HOST — the host every static address
  // is written under (name@lightninginajar.xyz). The registry worker answers
  // /.well-known/lnurlp/<name> there by returning THIS LSP's own answer; this
  // LSP claims each name at the worker (signed with its node key) when a wallet
  // registers it and releases it when the wallet releases. Empty = addresses
  // stay on this LSP's own host, as before.
  lnurlp: {
    address_host: String(process.env.LNURLP_ADDRESS_HOST || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
  },
};

// v0.49.1: macaroon presence moved into requireIdentityConfig so the
// operator sees EVERY missing item in one list instead of one at a time.

// v0.5: chain bridge handle, populated in main() if enabled
let chainBridge = null;

// v0.17 Phase D.1: htlc-interceptor handle and counters, populated in main().
// jit_matches separate from htlcs_seen — htlcs_seen comes from the gRPC
// wrapper (every HTLC observed), jit_matches comes from our own logic
// (subset of htlcs_seen where outgoing_requested_chan_id matched a
// pending JIT buy SCID).
let htlcInterceptor = null;
let interceptorJitMatches = 0;
let interceptorLastMatch = null;

// v0.18 Phase D.2: trampoline + offline-receive state.
//
// pendingHtlcsForOfflineWallets — HTLCs intercepted while the destination
// wallet was offline. Keyed by payment_hash_hex. Each entry includes the
// circuit_key (so we can FAIL/SETTLE the right HTLC later), the wallet's
// pubkey, amounts, expiry, and a back-reference to the promise that
// produced this match.
const pendingHtlcsForOfflineWallets = new Map();

// B-10: payment_secret registry for PLAIN invoices, keyed by payment_hash
// hex. JIT secrets live on the promise; plain invoices register here (engine
// v168+) so held forwards can settle via trampoline with the sender offline.
// Acceptance gates only, never claims -- the preimage stays recipient-only.
const invoiceSecretsByHash = new Map();

// B-16: payment_hash -> { promise, scidHex }. Set the moment ANY shard binds
// a promise; real-channel HTLCs whose hash is promise-bound DIVERT into that
// same aggregate instead of resuming (one payment, one bucket, whichever hop
// each shard rode). Released on settle-all and window-short.
const promiseByPaymentHash = new Map();

// inFlightOpens — per-promise lock to prevent duplicate channel-open
// attempts. Key = promise SCID hex. Cleared when the open + forward
// completes (success OR failure).
const inFlightOpens = new Set();

// htlcWatchdogs — Map<payment_hash_hex, setTimeout-handle>. Each offline
// HTLC has a watchdog scheduled near its CLTV expiry. On wallet reconnect
// + successful forward, the watchdog is cleared.
const htlcWatchdogs = new Map();
// v0.54.1 (b): hashes whose resolution (SETTLE/FAIL/RESUME) has been written
// to LND. The watchdog belt only FAILs circuits for hashes NOT in this set,
// so a late-firing belt can never double-resolve. Unpruned by design: holds
// are rare, entries are 64-byte strings.
const resolvedHtlcHashes = new Set();
// v0.54.1 (d): last time each wallet pubkey proved it is AWAKE (an actual
// HTTP request that carries its pubkey: buy, register_secret, prefs,
// pending poll, lnurl register). A live WebSocket is NOT awake.
const walletLastActiveMs = new Map();
const ACTIVE_WINDOW_MS = Math.max(5000, parseInt(process.env.LSPS2_ACTIVE_WINDOW_MS || '75000', 10) || 75000);  /* v0.55.5: the wallet's health cadence is ~60s; a 25s window starved 35s of every minute even with the heartbeat flowing */
function touchWalletActive(pubkeyHex) {
  if (pubkeyHex && /^[0-9a-f]{66}$/.test(String(pubkeyHex).toLowerCase()))
    walletLastActiveMs.set(String(pubkeyHex).toLowerCase(), Date.now());
}
function walletRecentlyActive(pubkeyHex) {
  const t = walletLastActiveMs.get(String(pubkeyHex || '').toLowerCase()) || 0;
  return (Date.now() - t) <= ACTIVE_WINDOW_MS;
}

// Lightning client dedicated to OpenChannelSync (separate proto loader
// scope from the v0.1 custom-message client). Populated in main().
let lightningOpenChannelClient = null;
let routerClient = null;     // shared with subscribeHtlcInterceptor

// Counters for offline-receive observability
let offlineHtlcsHeld = 0;
let offlineHtlcsSettled = 0;
let offlineHtlcsFailed = 0;
let trampolineForwardsAttempted = 0;
let trampolineForwardsSucceeded = 0;
let trampolineForwardsFailed = 0;

// Reconnect-poll timer handle, started in main()
let reconnectPollTimer = null;

// Current chain height (for watchdog scheduling; updated by chain bridge's
// block stream — we read it via /v1/getinfo as a fallback if not yet
// populated, but typically the chain bridge has set it well before any
// HTLC arrives).
let currentBlockHeight = 0;

// D-1 2c: bounded offline-hold tunables (read from .env; OFF by default).
// When disabled, the offline branch behaves exactly like 2a (fail fast).
// ── S21 State Machine · PHASE 0 (SHADOW) ──────────────────────────
// Observes only; writes nothing. Design: docs/design-lsps2-state-machine.md.
let SM;
// v0.54.3: the banner version is SINGLE-SOURCED from package.json — the
// 0.54.2 hotfix shipped with a stale banner constant (rule-2 violation:
// the banner is the operator's deploy tracker). A constant can drift; a
// read cannot.
// 0.71.0 (S45 #6+#10): `node lij-adapter.js --totp-enroll` prints a fresh console
// secret for config.env and the otpauth URI for an authenticator app, then exits.
if (process.argv.includes('--totp-enroll')) {
  const { totpEnroll } = require('./console');
  const e = totpEnroll('LIJOX console @ ' + require('os').hostname());
  console.log('\nCONSOLE_TOTP_SECRET=' + e.secret + '\n\nAdd that line to config.env, then in your authenticator app choose "enter a setup key"\nand type the secret (or add this URI):\n\n' + e.uri + '\n');
  process.exit(0);
}
const ADAPTER_LOGIC_VERSION = 'v' + require('./package.json').version; /* O3: JIT_REMOTE_RESERVE_SATS honored at gRPC open (field 25) — the deferred REST-path reserve override, un-deferred; startup line tells the truth */ /* P7: /health default answers wallet needs only (detail behind HEALTH_DETAIL=on incl. lnd_version + counters); /health/jit admin-gated unless detail on */ /* step 1: first-run doctor — startup-only checks (cert readable, macaroon present, data-dir write probe, REST+macaroon+identity-match with 5s timeout, gRPC TCP probe), plain-sentence failures, LIJOX_DOCTOR=off escape; banner reads this const */ void ADAPTER_LOGIC_VERSION;
try { SM = require('./lij-sm.js'); }
catch (e) { SM = { emit: () => {} }; console.warn('[SM] shadow module not loaded:', e.message); }

// ── FORWARD INTEGRITY (v0.37.0, S31) — F3 un-hangable sendToRouteV2 ──────
// The 2026-07-31 wedge (intent ea8a8c49): the grpc call neither resolved
// nor rejected past its configured deadline; the awaiting interceptor
// callback hung; the intent froze in FORWARDING with HTLCs unresolved.
// This wrapper guarantees resolution: configured timeout + 5s grace, then
// a synthetic FAILED attempt the existing status branch handles normally.
async function sendToRouteV2Hard(client, hash, route, timeoutMs, tag) {
  const hard = (parseInt(timeoutMs, 10) || 25000) + 5000;
  let timer;
  const bomb = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      status: 'HARD_TIMEOUT',
      failure: { code: 'F3_HARD_TIMEOUT' },
      preimage: Buffer.alloc(0),
    }), hard);
  });
  try {
    const r = await Promise.race([sendToRouteV2(client, hash, route, timeoutMs), bomb]);
    if (r && r.status === 'HARD_TIMEOUT') {
      console.error(`[LSPS2] F3 HARD TIMEOUT after ${hard}ms (${tag || 'forward'}) — treating as failed; underlying stream abandoned`);
    }
    return r;
  } finally { clearTimeout(timer); }
}

const OFFLINE_HOLD_ENABLED = process.env.LSPS2_OFFLINE_HOLD_ENABLED === 'true';
const OFFLINE_HOLD_CAP_MS = parseInt(process.env.LSPS2_OFFLINE_HOLD_CAP_MS || '180000', 10);
const OFFLINE_MIN_HEADROOM_BLOCKS = parseInt(process.env.LSPS2_OFFLINE_MIN_HEADROOM_BLOCKS || '18', 10);

// ── D-1 2c: Web Push wake infrastructure ────────────────────────────────────
// Subscriptions are written via the signed-challenge POST /lsps2/push-subscribe
// route (same auth model as the LIJOX registry). The store is a small JSON file
// in the adapter dir so it survives restarts (unlike the in-memory channel
// store). Wakes are content-free and TTL-bounded.
const webpush = require('web-push');
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:admin@example.com';
const PUSH_ENABLED      = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
const PUSH_SUBS_PATH    = require('path').join(DATA_DIR, 'push-subs.json');  // v0.48 (D1)
const PUSH_SUBS_MAX     = parseInt(process.env.PUSH_SUBS_MAX || '10000', 10);
if (PUSH_ENABLED) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log('[PUSH] VAPID configured — wake pushes enabled');
  } catch (e) {
    console.error(`[PUSH] VAPID setup failed (wakes disabled): ${e.message}`);
  }
} else {
  console.log('[PUSH] VAPID keys absent — wake pushes disabled');
}

let pushSubs = {};  // pubkeyHex(lowercase) -> PushSubscription
try {
  if (require('fs').existsSync(PUSH_SUBS_PATH)) {
    pushSubs = JSON.parse(require('fs').readFileSync(PUSH_SUBS_PATH, 'utf-8')) || {};
    console.log(`[PUSH] loaded ${Object.keys(pushSubs).length} push subscription(s)`);
  }
} catch (e) {
  console.error(`[PUSH] failed to load push-subs (${e.message}) — starting empty`);
  pushSubs = {};
}
function persistPushSubs() {
  try {
    require('fs').writeFileSync(PUSH_SUBS_PATH, JSON.stringify(pushSubs));
  } catch (e) {
    console.error(`[PUSH] failed to persist push-subs: ${e.message}`);
  }
}

// ── LNURLp "held-claim" server — v0.26.0 (S30), Option 1, DP GO ────────────
// Wallets pre-register payment HASHES (+ LDK payment_secrets); preimages
// never leave the device. A payer hits the public LNURLp endpoints; we mint
// an exact-amount HOLD invoice on the next free hash. When it goes ACCEPTED
// the payer's HTLCs are held BY LND (that is the offline buffer), we wake
// the wallet, and on its return we pay the inner one-hop leg locked to the
// same hash: the wallet's claim reveals the preimage, which settles the
// outer hold. We can deliver or refund (cancel); we cannot claim.
const LNURLP_PATH = require('path').join(DATA_DIR, 'lnurlp-registry.json');  // v0.48 (D1)
let lnurlpRegistry = {};
try {
  lnurlpRegistry = JSON.parse(require('fs').readFileSync(LNURLP_PATH, 'utf8'));
  console.log(`[LNURLP] loaded ${Object.keys(lnurlpRegistry).length} name(s)`);
} catch (e) {
  lnurlpRegistry = {};
}
// 0.67.0 (S43, DP — the robust static-address design, rule 2): a hash
// carries its own expiry. The wallet registers each hash in its own engine
// for a stated life (engine v229: 30 years) and hands the same `expires`
// (unix seconds) here; this LSP never mints an expired hash and counts only
// live ones as the pool, so the wallet's ordinary top-up (fires at open when
// fewer than 20 are live) refreshes a stale pool by itself. Entries from
// before 0.67.0 carry no expiry: they get the engine's OLD life (30 days
// from the name's registration — conservative; the top-up replaces them).
const LNURLP_LEGACY_LIFE_S = 30 * 86400;
function lnurlpNowS() { return Math.floor(Date.now() / 1000); }
function lnurlpEntryLive(e, nowS) {
  return e.status === 'free' && Number(e.expires || 0) > (nowS == null ? lnurlpNowS() : nowS);
}
function lnurlpLiveFree(rec) {
  const nowS = lnurlpNowS();
  return (rec && rec.entries || []).filter((e) => lnurlpEntryLive(e, nowS));
}
function lnurlpNextIndex(rec) {
  let max = -1;
  for (const e of (rec && rec.entries || [])) { if (Number.isFinite(e.index) && e.index > max) max = e.index; }
  return max + 1;
}
function lnurlpMigrateExpiry() {
  let stamped = 0, retired = 0, legacyOut = 0; const nowS = lnurlpNowS();
  for (const rec of Object.values(lnurlpRegistry)) {
    const legacy = Math.floor(Number(rec.created || Date.now()) / 1000) + LNURLP_LEGACY_LIFE_S;
    for (const e of (rec.entries || [])) {
      if (!Number.isFinite(e.expires)) { e.expires = legacy; stamped += 1; }
      if (e.status === 'free' && e.expires <= nowS) { e.status = 'expired'; retired += 1; }
    }
    // 0.67.1 (DP field 2026-09-02 07:07): a pre-0.67.0 RANDOM hash (no index)
    // is exactly the class a phone can lose; one such name refused a live
    // one this morning. Retire every unused random hash once, so only
    // seed-derived hashes (always recomputable by the wallet) stay live;
    // the wallet tops up at its next online open. In-flight entries untouched.
    if (!rec.legacy_retired_0671) {
      for (const e of (rec.entries || [])) {
        if (e.status === 'free' && !Number.isInteger(e.index)) { e.status = 'expired'; e.burn_reason = 'pre-0.67.0 random hash retired'; legacyOut += 1; }
      }
      rec.legacy_retired_0671 = true;
    }
  }
  if (stamped || retired || legacyOut) { lnurlpPersist(); console.log(`[LNURLP] expiry: stamped ${stamped} legacy hash(es), retired ${retired} expired, ${legacyOut} pre-0.67.0 random hash(es) retired (one-time)`); }
}
// v0.45 (S33, DP privacy pane): per-client preferences — today just the
// offline-hold window. Stored beside the lnurlp registry; clamped to the
// LSP's env cap. 0 = client asks for NO hold (fail fast when offline).
const CLIENT_PREFS_PATH = require('path').join(DATA_DIR, 'client-prefs.json');  // v0.48 (D1): CWD-dependence bug dies here
let clientPrefs = {};
try { clientPrefs = JSON.parse(require('fs').readFileSync(CLIENT_PREFS_PATH, 'utf8')); } catch (e) { clientPrefs = {}; }
function clientPrefsPersist() {
  try { require('fs').writeFileSync(CLIENT_PREFS_PATH, JSON.stringify(clientPrefs)); }
  catch (e) { console.error(`[prefs] persist failed: ${e.message}`); }
}
function clientHoldCapMs(pk) {
  const p = clientPrefs[(pk || '').toLowerCase()];
  // v0.55.1 R1: a wallet that never stated a preference gets the 3-minute
  // DEFAULT, not the LSP ceiling — raising the ceiling must never silently
  // lengthen anyone's hold. The ceiling caps EXPLICIT wishes only.
  if (!p || typeof p.hold_ms !== 'number') return Math.min(180000, OFFLINE_HOLD_CAP_MS);
  return Math.max(0, Math.min(p.hold_ms, OFFLINE_HOLD_CAP_MS));
}
function lnurlpPersist() {
  try { require('fs').writeFileSync(LNURLP_PATH, JSON.stringify(lnurlpRegistry)); }
  catch (e) { console.error(`[LNURLP] persist failed: ${e.message}`); }
}
const lnurlpWatchers = new Map();   // hashHex -> interval

// v0.30.0 (S30) — DP proposal: explicit hints through PUBLIC channels —
// ranked by the peer's balance toward us (real inbound that can carry the
// amount), peer's own advertised policy from the local graph edge. Fresh
// public channels are graph-invisible until gossip lands everywhere; a
// hint hands the payer the road early. Private channels stay LND's job
// via the invoice's private flag.
async function lnurlpBuildPublicHints(amtMsat) {
  try {
    const r = await lndGet('/v1/channels');
    const cands = (r.channels || [])
      .filter((c) => !c.private && BigInt(c.remote_balance || '0') * 1000n > amtMsat + 50000n)
      .sort((x, y) => Number(BigInt(y.remote_balance || '0') - BigInt(x.remote_balance || '0')));
    const hints = [];
    const roster = [];
    for (const c of cands) {
      if (hints.length >= 2) break;
      let edge = null;
      try { edge = await lndGet('/v1/graph/edge/' + c.chan_id); } catch (e) { continue; }
      if (!edge) continue;
      const peerPolicy = (edge.node1_pub === c.remote_pubkey) ? edge.node1_policy
        : (edge.node2_pub === c.remote_pubkey) ? edge.node2_policy : null;
      if (!peerPolicy) continue;
      hints.push({ hop_hints: [{
        node_id: c.remote_pubkey,
        chan_id: String(c.chan_id),
        fee_base_msat: parseInt(peerPolicy.fee_base_msat || '0', 10),
        fee_proportional_millionths: parseInt(peerPolicy.fee_rate_milli_msat || '0', 10),
        cltv_expiry_delta: parseInt(peerPolicy.time_lock_delta || '40', 10),
      }] });
      roster.push(c.remote_pubkey.slice(0, 12) + '…/' + c.chan_id);
    }
    if (roster.length) console.log(`[LNURLP] hint roster: ${roster.join(', ')}`);
    return hints;
  } catch (e) { return []; }
}

// v0.31.0 (S30): ONE metadata builder — the payRequest serves this exact
// string and the invoice's description_hash seals this exact string; the
// drift class ("Pay dp" vs "LNURLp dp") is structurally dead.
// 0.68.0: the host a name is written under — the neutral host when this LSP
// claimed the name there, else this LSP's own host (the request's Host).
function lnurlpAddrHost(req, rec) {
  const neutral = CONFIG.lnurlp.address_host;
  if (neutral && rec && rec.neutral) return neutral;
  return (req && req.headers && req.headers.host) || 'lsp';
}
// 0.68.0: name claim / release at the registry worker, signed like the
// registration itself (LND signmessage over a canonical line; the worker
// recovers the node key and checks it is a registered LSP). Returns
// 'ok' | 'taken' | 'unavailable'.
async function lnurlpNameAt(kind, name) {
  if (!CONFIG.registry || !CONFIG.lnurlp.address_host || !CONFIG.node.pubkey) return 'unavailable';
  try {
    const ts = Math.floor(Date.now() / 1000);
    const msg = 'lijox-name:v1:' + [kind, name, CONFIG.node.pubkey, String(ts)].map(encodeURIComponent).join(':');
    const signed = await lndPost('/v1/signmessage', { msg: Buffer.from(msg, 'utf8').toString('base64') });
    if (!signed || !signed.signature) return 'unavailable';
    const r = await httpsPost(`${CONFIG.registry}/names/${kind}`, { name, lsp_pubkey: CONFIG.node.pubkey, ts, signature: signed.signature });
    if (r && r.ok) return 'ok';
    if (r && /taken/i.test(String(r.error || ''))) return 'taken';
    return 'unavailable';
  } catch (e) { return 'unavailable'; }
}
// 0.68.0: one boot sweep — claim every name this LSP already holds (idempotent).
async function lnurlpNameSweep() {
  if (!CONFIG.registry || !CONFIG.lnurlp.address_host) return;
  let claimed = 0, taken = 0, down = 0;
  for (const [name, rec] of Object.entries(lnurlpRegistry)) {
    if (rec.neutral) continue;
    const r = await lnurlpNameAt('claim', name);
    if (r === 'ok') { rec.neutral = true; claimed += 1; }
    else if (r === 'taken') { rec.neutral_taken = true; taken += 1; }
    else { down += 1; break; }
  }
  if (claimed || taken) lnurlpPersist();
  console.log(`[LNURLP] neutral host ${CONFIG.lnurlp.address_host}: sweep claimed ${claimed}, taken elsewhere ${taken}${down ? ', worker unreachable ' + EMDASH + ' will retry next boot' : ''}`);
}
const EMDASH = '\u2014';

function lnurlpMetadata(name, host) {
  return JSON.stringify([
    ['text/plain', 'Pay ' + name + ' — Lightning in a Jar'],
    ['text/identifier', name + '@' + host],
  ]);
}
// v0.31.0 (S30): honest minimum — quoting 1 sat requires the best channel
// to actually CARRY it at fee 0 (local > 1 sat + the 50-sat delivery
// cushion); otherwise quote the JIT floor. Same helper for payRequest and
// callback so the quote and the gate cannot disagree.
// 0.67.0: per-IP mint ceiling for /lnurl/cb — 60 per rolling minute.
const lnurlpMintHits = new Map();
function lnurlpMintLimited(ip) {
  const now = Date.now(); const arr = (lnurlpMintHits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 60) { lnurlpMintHits.set(ip, arr); return true; }
  arr.push(now); lnurlpMintHits.set(ip, arr);
  if (lnurlpMintHits.size > 5000) lnurlpMintHits.clear();   // bounded
  return false;
}

function lnurlpMinMsat(chan, clientPubkey) {
  return (chan && chan.local_msat > 51000n)
    ? 1000
    : (Math.ceil(CONFIG.lsps2.open_fee_min_msat * jitFeeMultPct(clientPubkey) * scarcityMultPct() / 10000) + 1000000);   // v0.32.0×v0.33.0: quote and charge agree
}

// ── JIT self-protection — v0.32.0 (S30, DP designs 26 Jul) ───────────
// Floor: coins aren't free even when pubkeys are. Curve: price the repeat
// externality instead of banning it. Counters persist across restarts.
const JIT_COUNTERS_PATH = require('path').join(DATA_DIR, 'jit-counters.json');  // v0.48 (D1)
// 0.57.0 (j, DP RULED S39): ROLLING 90-DAY WINDOW — count only opens
// inside the trailing window; a farmer's afternoon prices like a farmer,
// years of honest opens do not. Shape: pubkey -> { opens: [ms,...] },
// pruned to the window and capped at 50 stamps. MIGRATION = FULL AMNESTY
// (DP blessed): legacy bare integers carry no dates, a window cannot
// backfill them — they are dropped; everyone starts at zero in-window.
const JIT_WINDOW_MS = Math.max(1, parseInt(process.env.LSPS2_JIT_WINDOW_DAYS || '90', 10)) * 86400000;
let jitOpenCounters = {};  // pubkey -> { opens: [ms,...] }
try {
  const rawCounters = JSON.parse(require('fs').readFileSync(JIT_COUNTERS_PATH, 'utf8'));
  for (const [ck, cv] of Object.entries(rawCounters)) {
    if (cv && Array.isArray(cv.opens)) {
      jitOpenCounters[ck] = { opens: cv.opens.filter((ts) => Number.isFinite(ts)) };
    }
    // bare integers (pre-0.57.0) fall through — amnesty
  }
} catch (e) { jitOpenCounters = {}; }
function jitCountersPersist() {
  try { require('fs').writeFileSync(JIT_COUNTERS_PATH, JSON.stringify(jitOpenCounters)); }
  catch (e) { console.error(`[JIT] counters persist failed: ${e.message}`); }
}
// Prune to the window (and a 50-stamp cap), return the in-window count.
function jitInWindow(k) {
  const e = jitOpenCounters[k];
  if (!e || !Array.isArray(e.opens)) return 0;
  const cutoff = Date.now() - JIT_WINDOW_MS;
  e.opens = e.opens.filter((ts) => ts >= cutoff).slice(-50);
  return e.opens.length;
}
function jitRecordOpen(pubkey) {
  const k = String(pubkey || '').toLowerCase();
  if (!jitOpenCounters[k]) jitOpenCounters[k] = { opens: [] };
  jitInWindow(k);
  jitOpenCounters[k].opens.push(Date.now());
  jitCountersPersist();
  console.log(`[JIT] open recorded for ${k.slice(0, 16)}… (${jitOpenCounters[k].opens.length} in ${Math.round(JIT_WINDOW_MS / 86400000)}d window)`);
  return jitOpenCounters[k].opens.length;
}
// Multiplier in percent for the UPCOMING (n+1-th) open of this wallet —
// n is now the IN-WINDOW count, free opens unchanged (jit_fee_free_opens).
function jitFeeMultPct(pubkey) {
  const k = String(pubkey || '').toLowerCase();
  const upcoming = jitInWindow(k) + 1;
  const extra = Math.max(0, upcoming - CONFIG.lsps2.jit_fee_free_opens);
  return 100 + CONFIG.lsps2.jit_fee_step_pct * extra;
}
// v0.33.0 (S30): the scarcity multiplier — refreshed every 30s from the
// on-chain balance; changes are logged; the boot line prints the whole
// self-protection posture.
let scarcityCache = { mult_pct: 100, confirmed: null, headroom: null, ts: 0 };
function scarcityMultPct() { return scarcityCache.mult_pct; }

// 0.61.0 (S42, DP RULED "connect the two sources"): ONE derivation of the
// open fee from the setting that actually charges it (LSPS2_VAR_MIN_FEE_MSAT),
// so the advertised number can never drift from the enforced one by hand.
// Baseline = a fresh wallet on a calm box (both multipliers 100%). The live
// quote applies the same two multipliers lnurlpFeeMsat applies, for THIS
// wallet, right now — an amount, not a formula. applies_up_to_sats is the
// receive size above which the proportional term exceeds the minimum.
function openFeeBaselineSats() { return Math.ceil(CONFIG.lsps2.open_fee_min_msat / 1000); }
function openFeeQuote(clientPubkey) {
  const minMsat = BigInt(CONFIG.lsps2.open_fee_min_msat);
  const pw = clientPubkey ? BigInt(jitFeeMultPct(clientPubkey)) : 100n;
  const sc = BigInt(scarcityMultPct());
  const feeMsat = (minMsat * pw * sc) / 10000n;
  const ppm = BigInt(CONFIG.lsps2.open_fee_ppm);
  const upTo = ppm > 0n ? Number((minMsat * 1000000n) / ppm / 1000n) : null;
  return {
    next_open_fee_sats:  Number((feeMsat + 999n) / 1000n),
    applies_up_to_sats:  upTo,
    per_wallet_mult_pct: Number(pw),
    scarcity_mult_pct:   Number(sc),
    baseline_sats:       openFeeBaselineSats(),
  };
}

// 0.62.0 (S42 field specimen c5539c2f, 2026-08-31 19:50): LND-truth checks
// for A3. "Did this attempt create a channel?" is answered by LND's channel
// list and pending list, never by the error text.
async function jitChannelsToPeer(pubkey) {
  const pk = String(pubkey || '').toLowerCase();
  const r = await lndGet('/v1/channels').catch(() => null);
  return ((r && r.channels) || []).filter(c => String(c.remote_pubkey || '').toLowerCase() === pk).length;
}
async function jitPendingOpensToPeer(pubkey) {
  const pk = String(pubkey || '').toLowerCase();
  const r = await lndGet('/v1/channels/pending').catch(() => null);
  return ((r && r.pending_open_channels) || []).filter(p => String((p.channel && p.channel.remote_node_pub) || '').toLowerCase() === pk).length;
}
async function refreshScarcity() {
  stampLoop('scarcity', 30000);
  try {
    const b = await lndGet('/v1/balance/blockchain');
    const confirmed = parseInt(b.confirmed_balance || '0', 10);
    const floor = CONFIG.lsps2.jit_min_onchain_reserve_sats;
    const ramp = Math.max(1, CONFIG.lsps2.jit_scarcity_ramp_start_sats);
    const maxPct = CONFIG.lsps2.jit_scarcity_max_pct;
    const H = confirmed - floor;
    let pct = 100;
    if (H <= 0) pct = maxPct;
    else if (H < ramp) pct = Math.round(100 + (maxPct - 100) * (ramp - H) / ramp);
    const prev = scarcityCache.mult_pct;
    scarcityCache = { mult_pct: pct, confirmed, headroom: H, ts: Date.now() };
    if (pct !== prev) {
      console.log(`[SCARCITY] multiplier ${prev}% → ${pct}% (onchain ${confirmed}, headroom ${H}, ramp ${ramp}, floor ${floor})`);
    }
  } catch (e) { /* keep last known */ }
}
setInterval(refreshScarcity, 30000);
setTimeout(async () => {
  await refreshScarcity();
  const c = CONFIG.lsps2;
  console.log(`[JIT] self-protection: floor=${c.jit_min_onchain_reserve_sats} ramp_start=${c.jit_scarcity_ramp_start_sats} max_mult=${c.jit_scarcity_max_pct}% | per-wallet(LNURLp): free_opens=${c.jit_fee_free_opens} step=${c.jit_fee_step_pct}% window=${Math.round(JIT_WINDOW_MS / 86400000)}d | live_mult=${scarcityMultPct()}% onchain=${scarcityCache.confirmed}`);
}, 6000);

async function jitReserveOk(fundingSats, who) {
  try {
    const b = await lndGet('/v1/balance/blockchain');
    const confirmed = parseInt(b.confirmed_balance || '0', 10);
    const floor = CONFIG.lsps2.jit_min_onchain_reserve_sats;
    if (confirmed - fundingSats < floor) {
      console.warn(`[RESERVE] JIT open REFUSED for ${who}: onchain ${confirmed} − ${fundingSats} < floor ${floor}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[RESERVE] balance check failed (${e.message}) — refusing open (fail-closed)`);
    return false;
  }
}

// 0.69.0 (S44, DP GO): THE ONE CHANNEL-OPENING FEE. Every rail calls this and
// nothing else computes an opening fee — LNURL delivery, the fixed bolt11 buy,
// the open-amount flush and its held-replay, and LSPS1 the day it returns.
// amountMsat = the payment the open is for; clientPubkey = the wallet (per-
// wallet escalator, v0.32.0); scarcityPct = the multiplier snapshotted when
// the terms were quoted (a promise's), else the live one (v0.33.0).
function channelOpenFeeMsat(amountMsat, clientPubkey, scarcityPct) {
  const ppmFee = (BigInt(amountMsat) * BigInt(CONFIG.lsps2.open_fee_ppm) + 999999n) / 1000000n;
  const floor = BigInt(CONFIG.lsps2.open_fee_min_msat);
  const base = ppmFee > floor ? ppmFee : floor;
  const pw = clientPubkey ? BigInt(jitFeeMultPct(clientPubkey)) : 100n;
  const sc = BigInt(parseInt(scarcityPct, 10) || scarcityMultPct());
  return (base * pw * sc) / 10000n;
}
function lnurlpFeeMsat(amountMsat, clientPubkey) { return channelOpenFeeMsat(amountMsat, clientPubkey); }

async function lnurlpClientChannel(clientPubkey) {
  // v0.27.0 (S30): best channel toward the client with LSP-side liquidity.
  // The ACTIVE gate is gone — a sleeping wallet's channel reads inactive,
  // which made every scan-while-asleep quote the JIT floor despite real
  // liquidity; held-claim delivery only needs the channel to EXIST (it
  // will be active when the wallet returns). Returns the ROUTING scid in
  // the alias dialect (alias_scids[0]) when present — LND's switch wants
  // the alias for option_scid_alias channels (the B-2 disease; the
  // trampoline never hit it because it echoes the intercepted alias).
  try {
    const r = await lndGet('/v1/channels');
    let best = null;
    for (const c of (r.channels || [])) {
      if ((c.remote_pubkey || '').toLowerCase() !== clientPubkey.toLowerCase()) continue;
      const localMsat = BigInt(c.local_balance || '0') * 1000n;
      const scid = (Array.isArray(c.alias_scids) && c.alias_scids.length)
        ? String(c.alias_scids[0]) : String(c.chan_id);
      if (!best || localMsat > best.local_msat) {
        best = { chan_id: String(c.chan_id), scid: scid, local_msat: localMsat, active: !!c.active };
      }
    }
    return best;
  } catch (e) { return null; }
}

// 0.67.0 (rule 3 + in-flight truth): once an attempt has gone to LND and LND
// still owns it (a deadline passed, or LND says a prior attempt is in flight),
// the belt must NOT fire another SendToRoute — it asks LND what became of the
// payment (ListPayments, in the UM890 macaroon) and acts on the answer:
// SUCCEEDED ⇒ settle the outer with the preimage (closes the loss hole where a
// receiver claiming after the 25 s RPC deadline was paid without the outer
// ever settling); FAILED with a permanent code ⇒ cancel the outer (refund the
// sender now); IN_FLIGHT ⇒ wait. Where ListPayments is not permitted (the
// Umbrel's delegate-free key) the belt re-sends at most once a minute — LND
// refuses a duplicate harmlessly — and says so once per boot.
const LNURLP_PERMANENT_CODES = new Set(['INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS', 'INVALID_ONION_VERSION', 'INVALID_ONION_HMAC', 'INVALID_ONION_KEY', 'INVALID_ONION_PAYLOAD']);
let lnurlpListPaymentsBlind = false;
async function lnurlpProbeInflight(name, entry) {
  if (lnurlpListPaymentsBlind) {
    if (Date.now() - entry._inflight_at > 60000) delete entry._inflight_at;   // allow one re-send a minute
    return;
  }
  let r;
  try { r = await lndGet('/v1/payments?include_incomplete=true&reversed=true&max_payments=100'); }
  catch (e) {
    if (/permission|403|401/i.test(e.message)) { lnurlpListPaymentsBlind = true; console.warn('[LNURLP] in-flight truth unavailable: ListPayments is not in this macaroon — the belt will re-send once a minute instead'); }
    return;
  }
  const pay = (r && r.payments || []).find((x) => String(x.payment_hash || '').toLowerCase() === entry.hash);
  if (!pay) { if (Date.now() - entry._inflight_at > 120000) delete entry._inflight_at; return; }
  if (pay.status === 'SUCCEEDED' && /^[0-9a-f]{64}$/i.test(String(pay.payment_preimage || ''))) {
    try { await lndPost('/v2/invoices/settle', { preimage: Buffer.from(pay.payment_preimage, 'hex').toString('base64') }); }
    catch (e) { console.error(`[LNURLP] ${name}: OUTER SETTLE FAILED after late inner success (${e.message}) — hash=${entry.hash} MANUAL ATTENTION`); }
    entry.status = 'settled'; entry.settled_at = Date.now(); delete entry._inflight_at; lnurlpPersist(); lnurlpStopWatch(entry.hash);
    console.log(`[LNURLP] ${name}: SETTLED (late — inner succeeded after the RPC deadline) hash=${entry.hash.slice(0,16)}…`);
  } else if (pay.status === 'FAILED') {
    delete entry._inflight_at;
    const reason = String(pay.failure_reason || '');
    if (/INCORRECT_PAYMENT_DETAILS/.test(reason)) {
      console.warn(`[LNURLP] ${name}: recipient refused (${reason}) — cancelling the held original now`);
      await lnurlpCancelOuter(name, entry, 'recipient refused: ' + reason);
    }
  }
}
async function lnurlpDeliver(name, entry) {
  if (entry.status !== 'accepted' || entry._delivering) return;
  if (entry._inflight_at) { await lnurlpProbeInflight(name, entry); return; }
  const rec = lnurlpRegistry[name];
  if (!rec) return;
  const client = rec.client_pubkey;
  if (!(await isPeerConnected(client))) return;   // v0.34.0: peer truth, not registry   // wake already sent; reconnect sweep retries
  entry._delivering = true;
  try {
    const amt = BigInt(entry.amount_msat);
    let chan = await lnurlpClientChannel(client);
    let feeMsat = 0n;
    if (!chan || chan.local_msat < amt + 50000n) {
      // JIT path: same fee law as every channel-opening receive.
      feeMsat = lnurlpFeeMsat(amt, client);
      if (amt <= feeMsat) {
        console.warn(`[LNURLP] ${name}: paid ${amt} msat <= fee ${feeMsat} — REFUNDING (cancel outer)`);
        await lnurlpCancelOuter(name, entry, 'amount under opening fee');
        return;
      }
      const sizeSats = computeChannelSizeSats(String(amt));
      if (!(await jitReserveOk(sizeSats, 'lnurlp:' + name))) {
        await lnurlpCancelOuter(name, entry, 'LSP on-chain reserve floor');
        return;
      }
      console.log(`[LNURLP] ${name}: no usable channel — zero-conf JIT open ${sizeSats} sats to ${client.slice(0,16)}…`);
      try {
        leaseRememberWalletPeer(client);   // 0.72.3: a JIT open marks the peer as a wallet for the lease
        await openChannelSync(lightningOpenChannelClient, {
          node_pubkey_string: client,
          local_funding_amount: sizeSats,
          push_sat: 0,
          sat_per_byte: 1,
          private: true,
          min_confs: 0,
          zero_conf: true,
          scid_alias: true,
          remote_chan_reserve_sat: jitReserveForOpen(sizeSats),   // v0.56.0 (O5): floor-or-percent, governor-gated
          commitment_type: process.env.LSPS2_COMMITMENT_TYPE || 'ANCHORS',
          ...openPolicyFields(),   // 0.66.0: the channel's fee policy, set in the open
        }, CONFIG.lsps2.openchannel_timeout_ms);
      } catch (e) {
        console.error(`[LNURLP] ${name}: open failed (${e.message}) — will retry on next sweep`);
        return;
      }
      for (let i = 0; i < 24 && !chan; i++) {
        await new Promise((r2) => setTimeout(r2, 500));
        chan = await lnurlpClientChannel(client);
      }
      if (!chan) { console.error(`[LNURLP] ${name}: opened channel never listed — retry next sweep`); return; }
      jitRecordOpen(client);   // v0.32.0: per-wallet open counter
    }
    const innerMsat = (amt - feeMsat).toString();
    const info = await lndGet('/v1/getinfo').catch(() => null);
    const tip = (info && info.block_height) || 0;
    if (!tip) { console.warn('[LNURLP] no live tip — retry next sweep'); return; }
    const expiry = tip + 80;
    const route = {
      total_time_lock: expiry,
      total_amt_msat: innerMsat,
      hops: [{
        chan_id: chan.scid,   // v0.27.0 (S30): alias dialect — see H1
        expiry: expiry,
        amt_to_forward_msat: innerMsat,
        fee_msat: '0',
        pub_key: client,
        tlv_payload: true,
        mpp_record: {
          payment_addr: Buffer.from(entry.secret, 'hex').toString('base64'),
          total_amt_msat: innerMsat,
        },
      }],
    };
    console.log(`[LNURLP] ${name}: delivering ${innerMsat} msat (fee ${feeMsat}) via scid=${chan.scid} (chan_id=${chan.chan_id}, active=${chan.active}) hash=${entry.hash.slice(0,16)}…`);
    let attempt;
    try {
      attempt = await sendToRouteV2Hard(routerClient, Buffer.from(entry.hash, 'hex'), route, CONFIG.lsps2.sendtoroute_timeout_ms, 'lnurlp');  /* F3 v0.37.0 */
    } catch (e) {
      console.error(`[LNURLP] ${name}: sendToRouteV2 rejected: ${e.message}`);
      if (/attempted value exceeds|DEADLINE_EXCEEDED|payment in flight|already/i.test(e.message)) entry._inflight_at = Date.now();   // 0.67.0: LND still owns an attempt — probe, don't re-send
      return;
    }
    if (!attempt || attempt.status !== 'SUCCEEDED') {
      const fc = attempt && attempt.failure ? attempt.failure.code : 'unknown';
      if (attempt && attempt.status === 'HARD_TIMEOUT') { entry._inflight_at = Date.now(); console.error(`[LNURLP] ${name}: attempt abandoned at the hard timeout — LND still owns it; probing`); return; }
      if (LNURLP_PERMANENT_CODES.has(fc)) {
        // 0.67.0 (rule 3): a definitive refusal ends the payment — the sender's sats go back now.
        console.warn(`[LNURLP] ${name}: recipient refused (${fc}) — cancelling the held original now, hash=${entry.hash.slice(0,16)}…`);
        await lnurlpCancelOuter(name, entry, 'recipient refused: ' + fc);
        return;
      }
      console.error(`[LNURLP] ${name}: inner leg did not succeed (status=${attempt ? attempt.status : 'none'} code=${fc}) — retry next sweep`);
      return;
    }
    const preB64 = Buffer.isBuffer(attempt.preimage)
      ? attempt.preimage.toString('base64')
      : Buffer.from(attempt.preimage, attempt.preimage.length === 64 ? 'hex' : 'base64').toString('base64');
    try {
      await lndPost('/v2/invoices/settle', { preimage: preB64 });
    } catch (e) {
      console.error(`[LNURLP] ${name}: OUTER SETTLE FAILED after inner success (${e.message}) — hash=${entry.hash} MANUAL ATTENTION`);
    }
    entry.status = 'settled';
    entry.settled_at = Date.now();
    delete entry._delivering;
    lnurlpPersist();
    lnurlpStopWatch(entry.hash);
    console.log(`[LNURLP] ${name}: SETTLED ${innerMsat} msat delivered, fee ${feeMsat} msat kept, hash=${entry.hash.slice(0,16)}…`);
    plRecord(feeMsat > 0n ? 'open_fee' : 'hold_fee', { msat: Number(feeMsat), wallet: client, name, hash: entry.hash });   // 0.72.0 PL ledger
    leaseTouch(client, 'lnurl:delivered');   // 0.73.0
  } finally {
    delete entry._delivering;
  }
}

async function lnurlpCancelOuter(name, entry, why) {
  try {
    await lndPost('/v2/invoices/cancel', { payment_hash: Buffer.from(entry.hash, 'hex').toString('base64') });
  } catch (e) {
    console.error(`[LNURLP] cancel failed for ${entry.hash.slice(0,16)}…: ${e.message}`);
  }
  entry.status = 'burned';
  entry.burn_reason = why;
  lnurlpPersist();
  lnurlpStopWatch(entry.hash);
}

function lnurlpStopWatch(hashHex) {
  const t = lnurlpWatchers.get(hashHex);
  if (t) { clearTimeout(t); lnurlpWatchers.delete(hashHex); }   // 0.65.0: timeout ids now (clearTimeout clears either kind in Node)
}

// 0.65.0 (S43, DP GO — speed): the watcher's cadence while the invoice is
// still UNPAID ('reserved'): 250 ms for the first 20 s after the mint, 1 s
// until 60 s, then the old 4 s. A payer scans and pays within seconds, and
// the flat 4 s poll was the largest single wait in a same-LSP send (avg 2 s).
// Keyed on entry.reserved_at (the mint), never on when the watcher started,
// so entries resumed at boot go straight to 4 s. Once ACCEPTED the deliverer
// belt keeps its 4 s. LookupInvoice is a local LND read on this box: nothing
// external, no peer, no chain. One poll at a time per invoice by construction
// (each poll schedules the next after it returns — setInterval could overlap).
function lnurlpWatchDelay(entry) {
  if (entry.status !== 'reserved') return 4000;
  const age = Date.now() - Number(entry.reserved_at || 0);
  if (age < 20000) return 250;
  if (age < 60000) return 1000;
  return 4000;
}

function lnurlpWatch(name, entry) {
  if (lnurlpWatchers.has(entry.hash)) return;
  const started = Date.now();
  const tick = async () => {
    try {
      const inv = await lndGet('/v1/invoice/' + entry.hash);
      const state = inv && inv.state;
      if (state === 'ACCEPTED' && entry.status === 'reserved') {
        entry.status = 'accepted';
        entry.amount_msat = String(inv.amt_paid_msat || entry.amount_msat);
        entry.accepted_at = Date.now();
        lnurlpPersist();
        const rec = lnurlpRegistry[name];
        console.log(`[LNURLP] ${name}: payment ACCEPTED (${entry.amount_msat} msat held) hash=${entry.hash.slice(0,16)}… — waking wallet`);
        if (rec) sendWakePush(rec.client_pubkey, 4200000).catch(() => {});  /* 0.57.0 (f): LNURLp rail window */
        lnurlpDeliver(name, entry).catch((e) => console.error(`[LNURLP] deliver error: ${e.message}`));
      } else if (state === 'ACCEPTED' && entry.status === 'accepted') {
        // v0.28.0 (S30): watcher belt — re-attempt every 4s while accepted;
        // deliverer self-guards (online, in-flight), so this is near-free.
        lnurlpDeliver(name, entry).catch((e) => console.error(`[LNURLP] watcher deliver error: ${e.message}`));
      } else if (state === 'SETTLED') {
        if (entry.status !== 'settled') { entry.status = 'settled'; lnurlpPersist(); }
        lnurlpStopWatch(entry.hash);
      } else if (state === 'CANCELED') {
        if (entry.status !== 'burned') { entry.status = 'burned'; entry.burn_reason = 'canceled/expired'; lnurlpPersist(); }
        lnurlpStopWatch(entry.hash);
      } else if (state === 'OPEN' && entry.status === 'reserved' && Date.now() - started > 1500000) {
        // 0.67.0: 25 min unpaid (invoice life is 20): past expiry — stop watching; LND cancels it.
        entry.status = 'burned'; entry.burn_reason = 'unpaid, expired';
        lnurlpPersist(); lnurlpStopWatch(entry.hash);
      }
    } catch (e) { /* transient lookup errors: keep watching */ }
    if (lnurlpWatchers.has(entry.hash)) lnurlpWatchers.set(entry.hash, setTimeout(tick, lnurlpWatchDelay(entry)));   // 0.65.0: stopped mid-tick ⇒ no re-arm
  };
  lnurlpWatchers.set(entry.hash, setTimeout(tick, lnurlpWatchDelay(entry)));
}

function lnurlpBootResume() {
  lnurlpMigrateExpiry();   // 0.67.0: stamp legacy entries, retire the expired
  let resumed = 0;
  for (const [name, rec] of Object.entries(lnurlpRegistry)) {
    for (const entry of (rec.entries || [])) {
      if (entry.status === 'reserved' || entry.status === 'accepted') {
        delete entry._delivering;
        lnurlpWatch(name, entry);
        resumed += 1;
      }
    }
  }
  if (resumed) console.log(`[LNURLP] boot: resumed ${resumed} in-flight watcher(s)`);
}
setTimeout(lnurlpBootResume, 8000);   // after LND connect settles

// Best-effort wake. Never throws into the HTLC path; a dead subscription
// (404/410 from the push service) is pruned so we don't keep retrying it.
async function sendWakePush(pubkeyHex, holdMsOverride) {
  if (!PUSH_ENABLED) return;
  const key = (pubkeyHex || '').toLowerCase();
  // v0.43.0 (S31): per-wallet throttle - MPP shards and resume-notify must
  // not machine-gun the device. One wake per wallet per 20s window (was 60s;
  // 60s swallowed a legitimate second notification during rapid testing).
  if (!global._lijWakePushAt) global._lijWakePushAt = {};
  const _wLast = global._lijWakePushAt[key] || 0;
  if (Date.now() - _wLast < 20000) {
    console.log(`[PUSH] wake throttled for ${key.slice(0,16)}... (${Date.now() - _wLast}ms since last)`);
    return;
  }
  global._lijWakePushAt[key] = Date.now();
  const sub = pushSubs[key];
  if (!sub) {
    console.log(`[PUSH] no subscription for ${key.slice(0,16)}… — no wake sent`);
    return;
  }
  try {
    // v0.55.6 (S36, DP UX fix): the wake payload now CARRIES the wallet's own
    // effective hold window (the same clientHoldCapMs the hold arming uses),
    // so the device notification can state the real number instead of the
    // v400-era hardcoded "3 minutes" — a wallet dialed to 30 min was being
    // told 3. TTL follows the same window: a push the service holds shorter
    // than the hold itself can expire before an offline device returns.
    // 0.57.0 (f): rail-aware — LNURLp wakes carry the rail's own window
    // (the 70-min watch constant), not the regular rail's clientHoldCapMs;
    // a wallet dialed to 3 min was being told 3 min about a payment the
    // LNURLp rail holds for over an hour.
    const holdMs = (typeof holdMsOverride === 'number' && holdMsOverride > 0) ? holdMsOverride : clientHoldCapMs(key);
    const holdS = Math.max(1, Math.round(holdMs / 1000));
    await webpush.sendNotification(sub, JSON.stringify({ t: 'wake', hold_s: holdS }), { TTL: Math.max(60, holdS) });
    console.log(`[PUSH] wake sent to ${key.slice(0,16)}… (hold_s=${holdS})`);
  } catch (e) {
    const status = e && e.statusCode;
    console.error(`[PUSH] wake send failed for ${key.slice(0,16)}…: ${e.message} (status=${status})`);
    if (status === 404 || status === 410) {
      delete pushSubs[key];
      persistPushSubs();
      console.log(`[PUSH] pruned dead subscription for ${key.slice(0,16)}…`);
    }
  }
}

// PUBLIC signed-challenge route: store a wake subscription for a pubkey. The
// wallet proves ownership by signing a single-use registry nonce over the
// 'push-subscribe' action, so nobody can register or overwrite another wallet's
// subscription. Verify the signature BEFORE consuming the nonce.
async function handlePushSubscribe(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return jsonResponse(res, { error: 'invalid_json' }, 400);
  }
  const { node_pubkey, nonce, signature, subscription } = body || {};
  if (!node_pubkey || !nonce || !signature || !subscription) {
    return jsonResponse(res, { error: 'missing_field',
      required: ['node_pubkey', 'nonce', 'signature', 'subscription'] }, 400);
  }
  if (!/^[0-9a-fA-F]{66}$/.test(node_pubkey)) {
    return jsonResponse(res, { error: 'field_bad', field: 'node_pubkey' }, 400);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(nonce)) {
    return jsonResponse(res, { error: 'field_bad', field: 'nonce' }, 400);
  }
  if (typeof subscription !== 'object' || !subscription.endpoint ||
      !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return jsonResponse(res, { error: 'field_bad', field: 'subscription' }, 400);
  }
  const message = registryBuildSignedMessage('push-subscribe', nonce, node_pubkey);
  const sig = registryVerifySignature(message, signature, node_pubkey);
  if (!sig.ok) {
    return jsonResponse(res, { error: sig.code || 'bad_signature' }, 401);
  }
  const nres = registryNonceStore.consume(nonce);
  if (!nres.ok) {
    return jsonResponse(res, { error: nres.code }, 401);
  }
  const key = node_pubkey.toLowerCase();
  const isNew = !Object.prototype.hasOwnProperty.call(pushSubs, key);
  if (isNew && Object.keys(pushSubs).length >= PUSH_SUBS_MAX) {
    return jsonResponse(res, { error: 'store_full' }, 503);
  }
  pushSubs[key] = subscription;
  persistPushSubs();
  console.log(`[PUSH] subscription stored for ${key.slice(0,16)}… (${isNew ? 'new' : 'updated'})`);
  return jsonResponse(res, { ok: true });
}

// ── Rate Limiter ──────────────────────────────────────────────────────────────
// Tracks channel open requests per IP. Resets after the window expires.
// Prevents a single IP from flooding channel open requests.

const rateLimitMap = new Map(); // ip -> { count, resetAt }

// v0.16: LSPS2 JIT promise registry. Each entry represents a buy commitment
// the LSP has made to a wallet — when an HTLC arrives with the matching
// jit_channel_scid, Phase D will open a 0-conf channel and forward the HTLC.
// In-memory only: promises are lost on adapter restart, in which case the
// wallet must call /lsps2/buy again. Each entry is reaped when it expires.
// Key: jit_channel_scid (16 hex chars). Value: { payment_size_msat, fee_msat,
// promise_expires_at, created_at, client_ip }.
const pendingJitBuys = new Map();

// v0.19: LIJOX channel registry storage. v0.18.7: reverted to in-memory
// MemoryChannelStore — better-sqlite3 native module is not required by this
// process. Registry data does NOT survive adapter restart; that's deferred
// until a different persistence backend is wired up. Both stores are PUBLIC
// (read by registry routes); auth on routes is intrinsic via signed challenge.
const registryNonceStore   = new RegistryNonceStore();
const registryChannelStore = new RegistryMemoryChannelStore();

// F4: cache of LND's real channel SCIDs (chan_id + alias_scids + peer_scid_alias)
// as decimal strings. Refreshed every reconnect-poll tick from LND ListChannels.
// null = never successfully loaded yet -> the interceptor handler stays in safe
// RESUME mode until the first successful load, so a legit forward is never wrongly
// failed on a cold cache. Used to tell a legitimate forward (RESUME) from a
// fake/stale JIT SCID (FAIL) when no pending promise matches the outgoing SCID.
let realChannelScids = null;

// v0.12: cached at startup from /v1/getinfo. Used by lookupChannelPolicy to
// determine which side of any channel is "us" (i.e. which direction's policy
// to return for the LSP self-hop fee calculation).
let LOCAL_PUBKEY = null;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    // Fresh window
    rateLimitMap.set(ip, {
      count:   1,
      resetAt: now + CONFIG.security.rate_limit_window_ms,
    });
    return false;
  }

  if (entry.count >= CONFIG.security.rate_limit_requests) {
    const resetIn = Math.ceil((entry.resetAt - now) / 60000);
    console.warn(`[Security] Rate limit hit for ${ip} — resets in ${resetIn} min`);
    return true;
  }

  entry.count++;
  return false;
}

// v0.18.5: Separate rate limiter for admin endpoints (registry dump etc.).
// The channel-open isRateLimited is 3/hour by design — too tight for
// operator inspection. This one defaults 60/min, own state, own config.
const adminRateLimitMap = new Map(); // ip -> { count, resetAt }

function isAdminRateLimited(ip) {
  const now = Date.now();
  const entry = adminRateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    adminRateLimitMap.set(ip, {
      count:   1,
      resetAt: now + CONFIG.security.admin_rate_limit_window_ms,
    });
    return false;
  }

  if (entry.count >= CONFIG.security.admin_rate_limit_requests) {
    const resetIn = Math.ceil((entry.resetAt - now) / 1000);
    console.warn(`[Security] Admin rate limit hit for ${ip} — resets in ${resetIn}s`);
    return true;
  }

  entry.count++;
  return false;
}

// Clean up expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
  for (const [ip, entry] of adminRateLimitMap.entries()) {
    if (now > entry.resetAt) adminRateLimitMap.delete(ip);
  }
}, 600000);

// v0.16: LSPS2 JIT helpers.

/** Generate a 16-hex-char (8-byte) SCID alias for a JIT promise. */
function generateJitScid() {
  return crypto.randomBytes(8).toString('hex');
}

/** Reap expired entries from pendingJitBuys. Cheap, called inline on writes. */
function reapExpiredJitBuys() {
  const now = Date.now();
  let reaped = 0;
  for (const [scid, entry] of pendingJitBuys.entries()) {
    if (now > entry.promise_expires_at) {
      pendingJitBuys.delete(scid);
      reaped++;
    }
  }
  if (reaped > 0) console.log(`[LSPS2] Reaped ${reaped} expired JIT promise(s)`);
}

/** Format an integer with comma thousands separators (display-only). */
function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

/** Build the human-readable summary string from current CONFIG.lsps2 values. */
function buildLsps2HumanSummary() {
  const c = CONFIG.lsps2;
  const feePct = (c.fee_ppm / 10000).toFixed(c.fee_ppm < 1000 ? 3 : 2);  // ppm → %
  const baseSat = Math.round(c.base_fee_msat / 1000);
  const validMin = Math.floor(c.promise_validity_secs / 60);
  return `Channel opening: ${fmtNum(openFeeBaselineSats())} sats. `
       + `Sending: ${feePct}% + ${baseSat} sat per payment. `
       + `Your offer is valid for ${validMin} minutes.`;
}

// v0.18 Phase D.2: htlc-interceptor request handler — trampoline path.
//
// MAY return synchronously (for non-matches / FAIL cases) or return a
// Promise (for matches that require channel-open + sendToRouteV2). The
// v0.4 gRPC wrapper handles both transparently.
//
// SAFETY: top-level try/catch sets default to RESUME for synchronous
// throws; the Promise chain has a .catch() to RESUME on rejection.
//
// HANDLER MAY ALSO return null to deliberately HOLD the HTLC (the
// offline-receive case). When null is returned, the wrapper does NOT
// write a response. The watchdog or the reconnect-poll path will
// eventually FAIL or SETTLE the held HTLC via the deferred-write hook
// exposed by the wrapper as htlcInterceptor.getCounters()._lastWrite.
async function handleInterceptedHtlc(req) {
  try { SM.emit('htlc_intercepted', { hash: (req.payment_hash && req.payment_hash.toString) ? req.payment_hash.toString('hex') : String(req.payment_hash || ''), scid: req.outgoing_requested_chan_id ? String(req.outgoing_requested_chan_id) : null, in_msat: String(req.incoming_amount_msat || '0'), ck: req.incoming_circuit_key ? (String(req.incoming_circuit_key.chan_id) + ':' + String(req.incoming_circuit_key.htlc_id)) : null }); } catch (_) {}
  // Always-safe default response.
  const RESUME = {
    incoming_circuit_key: req.incoming_circuit_key,
    action: 'RESUME',
  };
  const FAIL_TEMP = {
    incoming_circuit_key: req.incoming_circuit_key,
    action: 'FAIL',
    failure_code: 15,  // LND lnrpc TEMPORARY_CHANNEL_FAILURE (was mislabeled 7=EXPIRY_TOO_SOON, which LND rejects -> crashes interceptor)
  };
  const FAIL_UNKNOWN = {
    incoming_circuit_key: req.incoming_circuit_key,
    action: 'FAIL',
    failure_code: 1,   // LND lnrpc INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS (was mislabeled 16=REQUIRED_NODE_FEATURE_MISSING, which LND rejects -> crashes interceptor)
  };

  try {
    const outgoingScidDecimal = req.outgoing_requested_chan_id;
    if (!outgoingScidDecimal || outgoingScidDecimal === '0') return RESUME;

    const outgoingScidHex = BigInt(outgoingScidDecimal).toString(16).padStart(16, '0');
    const promise = pendingJitBuys.get(outgoingScidHex);
    if (!promise) {
      // F4 guard: no JIT promise for this outgoing SCID. RESUME only if it is a
      // real channel (a legitimate forward, e.g. a wallet sending a payment out
      // through us). If the SCID is neither a promise nor a real channel, it is a
      // fake/stale JIT SCID (expired promise, or promise lost across a restart).
      // RESUMEing such an HTLC leaves LND unable to resolve it and crashes the
      // interceptor with "missing preimage" -- so FAIL it cleanly instead.
      // SAFETY: realChannelScids === null means the channel list has not loaded
      // yet; in that cold-start window we RESUME (identical to pre-F4 behavior).
      if (realChannelScids === null) return RESUME;
      if (realChannelScids.has(String(outgoingScidDecimal))) {
        // B-1v2: real channel. RESUME as always when it is active or the peer
        // is live; when the peer is OFFLINE, LND would simply fail this
        // forward, so give it the same bounded hold as JIT (kind:'forward'):
        // wake the wallet, replay writes RESUME once the channel is back.
        // Same env gates, same cap, same watchdog. ANY error -> RESUME.
        try {
          // B-16: a sibling shard of a promise-bound payment must NOT slip
          // past the aggregate just because it fits a real channel (specimen
          // 7339fb24: 178k resumed to the recipient as a stray MPP partial
          // while 5,331k waited in the bucket). Divert it into the SAME
          // aggregate; completion mirrors the online open path exactly.
          {
            const _dHash = req.payment_hash ? Buffer.from(req.payment_hash).toString('hex') : null;
            const _bind = _dHash ? promiseByPaymentHash.get(_dHash) : null;
            if (_bind && _bind.promise && _bind.promise._shards) {
              if (resolvedHtlcHashes.has(_dHash)) {  /* v0.55.0 A4 */
                console.error(`[LSPS2] A4: divert-shard for TERMINAL hash ${_dHash.slice(0,16)}… — refusing, failing back`);
                return { incoming_circuit_key: req.incoming_circuit_key, action: 'FAIL', failure_code: 15 };
              }
              const dPromise = _bind.promise;
              const dGross = BigInt(dPromise.payment_size_msat) + BigInt(dPromise.fee_msat);
              const dOut = BigInt(req.outgoing_amount_msat || '0');
              const dCk = req.incoming_circuit_key || {};
              const dKey = `${dCk.chan_id || '0'}:${dCk.htlc_id || '0'}`;
              if (!dPromise._shards.has(dKey)) {
                dPromise._shards.set(dKey, { incoming_circuit_key: req.incoming_circuit_key, msat: dOut });
                try { SM.emit('shard_registered', { hash: _dHash }); } catch (_) {}
                dPromise._shard_sum_msat += dOut;
              }
              console.log(`[LSPS2] B-16 shard DIVERTED from real-channel scid=${outgoingScidDecimal}: +${dOut} -> ${dPromise._shard_sum_msat}/${dGross} msat (${dPromise._shards.size} shard(s))`);
              if (dPromise._shard_sum_msat < dGross) {
                return null;  // HOLD — siblings complete the aggregate
              }
              console.log(`[LSPS2] B-16 aggregation COMPLETE via divert — one open+forward`);
              if (inFlightOpens.has(_bind.scidHex)) {
                console.log(`[LSPS2] B-16: open already in flight for scid=${_bind.scidHex} — HOLD shard for settle-all`);
                return null;
              }
              inFlightOpens.add(_bind.scidHex);
              try { SM.emit('open_started', { hash: _dHash, scid: _bind.scidHex, total_msat: (dPromise.total_amt_msat != null) ? String(dPromise.total_amt_msat) : null, fee_msat: (dPromise.fee_msat != null) ? String(dPromise.fee_msat) : null }); } catch (_) {}
              return openChannelAndForward(req, dPromise, _bind.scidHex, _dHash)
                .then((resp) => {
                  inFlightOpens.delete(_bind.scidHex);
                  return resp;
                })
                .catch((e) => {
                  inFlightOpens.delete(_bind.scidHex);
                  try {
                    dPromise._openFails = (dPromise._openFails || 0) + 1;
                    if (dPromise._openFails >= 3) {
                      console.error(`[LSPS2] F2 evicting promise scid=${_bind.scidHex} after ${dPromise._openFails} open failures (stuck-promise guard)`);
                      pendingJitBuys.delete(_bind.scidHex);
                      if (dPromise._b16_hash) promiseByPaymentHash.delete(dPromise._b16_hash);
                    }
                  } catch (_) {}
                  console.error(`[LSPS2] B-16 openChannelAndForward rejected for scid=${_bind.scidHex}: ${e.message}`);
                  return FAIL_TEMP;
                });
            }
          }
          const chans = await lndGet('/v1/channels').catch(() => null);
          // B-3: the onion may carry the ALIAS (B-2 rewrite) -- match either.
          const _scidS = String(outgoingScidDecimal);
          const c = chans && (chans.channels || []).find(ch => String(ch.chan_id) === _scidS || (ch.alias_scids || []).map(String).includes(_scidS));
          if (!c) return RESUME;
          // B-19: early-arrival sibling rescue. Specimen 3d832527 (S-D): the
          // FIRST shard rode this real channel before any binding existed
          // (B-16's first-arrival hole), locked the sats that forced its
          // sibling onto the alias, and the aggregate starved. If this hash
          // has a registered invoice secret and the peer has EXACTLY ONE
          // live promise, bind and divert now — the aggregate forms
          // regardless of arrival order.
          {
            const _eHash = req.payment_hash ? Buffer.from(req.payment_hash).toString('hex') : null;
            if (_eHash && invoiceSecretsByHash.has(_eHash) && !promiseByPaymentHash.has(_eHash)) {
              const _cands = [];
              for (const [_psc, _ppr] of pendingJitBuys) {
                // v0.56.2 (run-2 conviction): FIXED promises only. A variable
                // promise has payment_size 0 — gross 0 — so the F1 size gate
                // can NEVER pass, and a lingering one captures every same-peer
                // secret-registered HTLC into refuse territory (the 18:31:26
                // gross-0 capture). Variable promises settle by their own
                // quiescence rail; early-bind is a fixed-promise concept.
                if (_ppr && _ppr.client_pubkey === c.remote_pubkey
                    && Date.now() <= _ppr.reservation_expires_at
                    && BigInt(_ppr.payment_size_msat || 0) > 0n) _cands.push([_psc, _ppr]);
              }
              if (_cands.length === 1) {
                const _sc = _cands[0][0];
                const _pr = _cands[0][1];
                // F1 (v0.42.0): SIZE GATE. B-19 previously bound ANY same-peer
                // HTLC with a registered secret to the sole live promise, with
                // no amount check -- so a 504-sat route-build probe got
                // captured into a stuck 104,100k promise and poisoned all
                // routing (journal 2026-07-31 07:56). A genuine shard is at
                // most the gross and at least a sane fraction of it; anything
                // far below cannot belong to this promise. Refuse the bind and
                // RESUME the HTLC on its own path.
                const _gGross = BigInt(_pr.payment_size_msat) + BigInt(_pr.fee_msat);
                const _hOut = BigInt(req.outgoing_amount_msat || '0');
                const _alreadyHeld = _pr._shard_sum_msat || 0n;
                // Ceiling: this HTLC plus what's held must not exceed gross.
                // Floor: a lone shard smaller than 1/100th of gross (and below
                // 10k sat) is not a plausible partial of THIS payment -- it is
                // an unrelated payment/probe. Both bounds must hold.
                const _plausible = (_hOut > 0n)
                  && (_alreadyHeld + _hOut <= _gGross)
                  && !(_hOut * 100n < _gGross && _hOut < 10000000n);
                if (!_plausible) {
                  // v0.56.2 (S36, DP run-2 conviction, journal 18:31:26): the
                  // refusal means "not THIS promise's payment" — it says
                  // NOTHING about peer reachability. The old raw RESUME here
                  // short-circuited the DECIDE→B-1 offline-hold rail and
                  // resumed the HTLC into a dead peer: no hold, no wake push,
                  // instant fail-back. Now the refusal FALLS THROUGH to the
                  // decision tape below, which holds+pushes when the wallet
                  // is genuinely offline and RESUMEs when it is live.
                  console.warn(`[LSPS2] F1 B-19 bind REFUSED: HTLC ${_hOut}msat implausible for promise gross ${_gGross}msat (held ${_alreadyHeld}) -- not this payment; falling through to offline evaluation (v0.56.2)`);
                } else {
                if (!_pr._shards) { _pr._shards = new Map(); _pr._shard_sum_msat = 0n; }
                _pr._b16_hash = _eHash;
                promiseByPaymentHash.set(_eHash, { promise: _pr, scidHex: _sc });
                const _dOut = BigInt(req.outgoing_amount_msat || '0');
                const _dCk = req.incoming_circuit_key || {};
                const _dKey = `${_dCk.chan_id || '0'}:${_dCk.htlc_id || '0'}`;
                if (!_pr._shards.has(_dKey)) {
                  _pr._shards.set(_dKey, { incoming_circuit_key: req.incoming_circuit_key, msat: _dOut });
                  try { SM.emit('shard_registered', { hash: _eHash }); } catch (_) {}
                  _pr._shard_sum_msat += _dOut;
                }
                const _dGross = BigInt(_pr.payment_size_msat) + BigInt(_pr.fee_msat);
                console.log(`[LSPS2] B-19 early-bind: hash=${_eHash.slice(0,16)}… → sole live promise scid=${_sc}; shard DIVERTED from real channel: +${_dOut} -> ${_pr._shard_sum_msat}/${_dGross} msat (${_pr._shards.size} shard(s))`);
                if (_pr._shard_sum_msat < _dGross) {
                  return null;  // HOLD — siblings complete the aggregate
                }
                if (inFlightOpens.has(_sc)) {
                  console.log(`[LSPS2] B-19: open already in flight for scid=${_sc} — HOLD shard for settle-all`);
                  return null;
                }
                inFlightOpens.add(_sc);
                try { SM.emit('open_started', { hash: _eHash, scid: _sc, total_msat: (_pr.total_amt_msat != null) ? String(_pr.total_amt_msat) : null, fee_msat: (_pr.fee_msat != null) ? String(_pr.fee_msat) : null }); } catch (_) {}
                return openChannelAndForward(req, _pr, _sc, _eHash)
                  .then((resp) => { inFlightOpens.delete(_sc); return resp; })
                  .catch((e) => { inFlightOpens.delete(_sc); try { _pr._openFails = (_pr._openFails || 0) + 1; if (_pr._openFails >= 3) { console.error(`[LSPS2] F2 evicting promise scid=${_sc} after ${_pr._openFails} open failures (stuck-promise guard)`); pendingJitBuys.delete(_sc); if (_pr._b16_hash) promiseByPaymentHash.delete(_pr._b16_hash); } } catch (_) {} console.error(`[LSPS2] B-19 openChannelAndForward rejected for scid=${_sc}: ${e.message}`); return FAIL_TEMP; });
                }   // v0.56.2: close the plausible-bind else — refusal falls through
              }
            }
          }
          // ── DECISION TAPE (v0.40.0, S31): these two exits were silent —
          // Test A (a919c37b) rode one with zero evidence. Behavior
          // identical; every verdict now logs with its source.
          const _dtHash = req.payment_hash ? Buffer.from(req.payment_hash).toString('hex').slice(0, 16) : '????';
          if (c.active) {
            console.log(`[DECIDE] ${_dtHash} fwd scid=${outgoingScidDecimal} in=${req.incoming_amount_msat}msat -> RESUME (channel ACTIVE per LND; wallet ${c.remote_pubkey.slice(0,16)}...; a half-open tunnel keeps this true until LND ping-timeout)`);
            sendWakePush(c.remote_pubkey).catch(() => {});  /* v0.41.0: notify-on-uncertain-resume */
            return RESUME;
          }
          const fwdOnline = await isPeerConnected(c.remote_pubkey);
          if (fwdOnline) {
            console.log(`[DECIDE] ${_dtHash} fwd scid=${outgoingScidDecimal} in=${req.incoming_amount_msat}msat -> RESUME (channel inactive but peer LISTED by LND; peers-cache age ${Date.now() - _peersCache.ts}ms)`);
            sendWakePush(c.remote_pubkey).catch(() => {});  /* v0.41.0: notify-on-uncertain-resume */
            return RESUME;
          }
          console.log(`[DECIDE] ${_dtHash} fwd scid=${outgoingScidDecimal} -> wallet OFFLINE by LND (channel inactive + peer not listed) - evaluating B-1 hold gates`);
          const pHash = req.payment_hash ? Buffer.from(req.payment_hash).toString('hex') : null;
          if (!pHash) return RESUME;
          const tipInfo = await lndGet('/v1/getinfo').catch(() => null);
          const fwdTip = (tipInfo && tipInfo.block_height) || 0;
          const fwdAutoFail = parseInt(req.auto_fail_height, 10) || 0;
          const fwdMargin = fwdAutoFail - fwdTip;
          const fwdHoldCap = clientHoldCapMs(c.remote_pubkey);   // v0.45: per-client dial
          const fwdCanHold = OFFLINE_HOLD_ENABLED && fwdHoldCap > 0 && fwdTip > 0 && fwdAutoFail > 0 &&
            fwdMargin >= OFFLINE_MIN_HEADROOM_BLOCKS;
          if (!fwdCanHold) {
            console.log(`[B-1] forward to offline client ${c.remote_pubkey.slice(0,16)}... -- cannot hold (enabled=${OFFLINE_HOLD_ENABLED}, margin=${fwdMargin}) -- RESUME (LND will fail it)`);
            return RESUME;
          }
          console.log(`[B-1] forward to offline client ${c.remote_pubkey.slice(0,16)}... -- HOLDING (cap ${Math.round(fwdHoldCap/1000)}s, margin=${fwdMargin}) payment_hash=${pHash}`);
          try { SM.emit('hold_created', { hash: pHash, cap_ms: fwdHoldCap }); } catch (_) {}
          const _b18fwdFirst = holdEntryAppend(pHash, {
            kind: 'forward',
            incoming_circuit_key: req.incoming_circuit_key,
            client_pubkey: c.remote_pubkey,
            outgoing_scid_hex: BigInt(outgoingScidDecimal).toString(16).padStart(16, '0'),
            outgoing_amount_msat: req.outgoing_amount_msat,
            incoming_amount_msat: req.incoming_amount_msat,
            outgoing_expiry: req.outgoing_expiry,
            auto_fail_height: fwdAutoFail,
            htlc_received_at: Date.now(),
            promise_ref: null,
            custom_records: req.custom_records || {},
          });
          offlineHtlcsHeld += 1;
          if (_b18fwdFirst) {
            scheduleHtlcWatchdog(pHash, fwdAutoFail, clientHoldCapMs(c.remote_pubkey));  /* v0.54.5: per-client */
            sendWakePush(c.remote_pubkey).catch(() => {});
          }
          return null;  // HOLD -- reconnect-poll RESUMEs it
        } catch (e) {
          console.warn(`[B-1] forward-hold check failed: ${e.message} -- RESUME`);
          return RESUME;
        }
      }
      console.warn(`[LSPS2] F4: no promise + unknown SCID ${outgoingScidDecimal} (hex ${outgoingScidHex}) -- FAIL (prevents missing-preimage stuck state)`);
      return FAIL_UNKNOWN;
    }

    const paymentHashHex = req.payment_hash
      ? Buffer.from(req.payment_hash).toString('hex')
      : '(missing)';

    // Validate the promise still active.
    const now = Date.now();
    if (now > promise.reservation_expires_at) {
      console.log(`[LSPS2] reservation expired for scid=${outgoingScidHex} payment_hash=${paymentHashHex} — FAIL`);
      pendingJitBuys.delete(outgoingScidHex);
      return FAIL_UNKNOWN;
    }

    // B-15 (invariant I1's sum-gate, absorbed live — first Phase 1 bite):
    // the floor is the GROSS invoice face, size + fee. The old floor
    // (size − fee) double-deducted the fee from a net figure — big MPP
    // shards skipped registration and rode the single path alone, opening
    // channels that forwarded a partial the recipient could never claim
    // (M2b2 specimen 45f2e97b, 21:47:29). A true single's face EQUALS
    // gross, so singles pass byte-identically (M2b1 proven).
    const outAmtMsat = BigInt(req.outgoing_amount_msat || '0');

    // v0.20 VARIABLE: open-amount promises have no size and no fee yet —
    // the fixed gross-gate below is meaningless for them. Route to the
    // variable handler (hold + quiescence judge) and stop here.
    if (promise.mode === 'variable') {
      return handleVariableShard(req, promise, outgoingScidHex, paymentHashHex);
    }

    const promiseSizeMsat = BigInt(promise.payment_size_msat);
    const promiseFeeMsat = BigInt(promise.fee_msat);
    const grossTotalMsat = promiseSizeMsat + promiseFeeMsat;
    if (outAmtMsat < grossTotalMsat) {
      // B-11: an under-total HTLC is an MPP SHARD, not an error. Register it
      // under the promise; the window bounds the wait; the SUM (vs the same
      // minAcceptable floor the single-HTLC check used) decides. Single-HTLC
      // senders never enter here -- zero behavior change for them.
      if (outAmtMsat < BigInt(CONFIG.lsps2.min_shard_msat)) {
        console.log(`[LSPS2] B-11 shard below floor for scid=${outgoingScidHex}: ${outAmtMsat} < ${CONFIG.lsps2.min_shard_msat} -- FAIL`);
        return FAIL_UNKNOWN;
      }
      if (!promise._shards) {
        promise._shards = new Map();
        promise._shard_sum_msat = 0n;
        promise._agg_deadline = Date.now() + (CONFIG.lsps2.agg_window_s * 1000);
        setTimeout(() => {
          // Window closed short: FAIL every registered shard (code 15) and
          // reset so a clean retry can start fresh. Promise stays live.
          if (promise._shards && promise._shard_sum_msat < (BigInt(promise.payment_size_msat) + BigInt(promise.fee_msat))) {
            console.warn(`[LSPS2] B-11 window closed short: ${promise._shard_sum_msat} msat across ${promise._shards.size} shard(s) -- FAILing all`);
            try { SM.emit('agg_window_short', { hash: promise._b16_hash || null }); } catch (_) {}
            if (promise._b16_hash) promiseByPaymentHash.delete(promise._b16_hash);
            if (htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite) {
              for (const [, sh] of promise._shards) {
                htlcInterceptor.getCounters()._lastWrite({
                  incoming_circuit_key: sh.incoming_circuit_key,
                  action: 'FAIL',
                  failure_code: 15,
                });
              }
            }
            promise._shards = null; promise._shard_sum_msat = 0n; promise._agg_deadline = 0; promise._agg_completed = false; /* F2 v0.37.0 */
          }
        }, CONFIG.lsps2.agg_window_s * 1000 + 250);
      }
      const ck = req.incoming_circuit_key || {};
      const ckKey = `${ck.chan_id || '0'}:${ck.htlc_id || '0'}`;
      if (!promise._shards.has(ckKey)) {
        promise._shards.set(ckKey, { incoming_circuit_key: req.incoming_circuit_key, msat: outAmtMsat });
        try { SM.emit('shard_registered', { hash: (req.payment_hash && req.payment_hash.toString) ? req.payment_hash.toString('hex') : String(req.payment_hash || '') }); } catch (_) {}
        promise._shard_sum_msat += outAmtMsat;
      }
      console.log(`[LSPS2] B-11 shard registered: +${outAmtMsat} -> ${promise._shard_sum_msat}/${grossTotalMsat} msat (${promise._shards.size} shard(s))`);
      // B-16: bind this payment hash to the promise so sibling shards that
      // ride a REAL channel divert into this same aggregate.
      if (paymentHashHex && paymentHashHex !== '(missing)') {
        promise._b16_hash = paymentHashHex;
        if (resolvedHtlcHashes.has(paymentHashHex)) {  /* v0.55.0 A4 */
          console.error(`[LSPS2] A4: bound-shard for TERMINAL hash ${paymentHashHex.slice(0,16)}… — refusing, failing back`);
          return { incoming_circuit_key: req.incoming_circuit_key, action: 'FAIL', failure_code: 15 };
        }
        promiseByPaymentHash.set(paymentHashHex, { promise, scidHex: outgoingScidHex });
      }
      if (promise._shard_sum_msat < grossTotalMsat) {
        return null;  // HOLD this shard -- more coming, or the window FAILs all
      }
      // ── FORWARD INTEGRITY (v0.37.0, S31): F4 exact-sum gate + F2 single-fire ──
      // Sum can only exceed gross when stale retry generations pollute the
      // aggregate (the 2026-07-31 double-forward). Never dispatch a wrong
      // sum: FAIL every registered sibling, reset the aggregate, let the
      // sender retry clean.
      if (promise._shard_sum_msat > grossTotalMsat) {
        console.error(`[LSPS2] F4 sum OVERSHOOT: ${promise._shard_sum_msat} > ${grossTotalMsat} msat across ${promise._shards.size} shard(s) — stale retry generations; FAILing all + reset`);
        try { SM.emit('var_flush_failed', { hash: promise._b16_hash || paymentHashHex, why: 'F4 sum overshoot' }); } catch (_) {}
        if (htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite) {
          for (const [_f4k, _f4sh] of promise._shards) {
            if (_f4k === ckKey) continue;  // triggering circuit resolves via the return below
            htlcInterceptor.getCounters()._lastWrite({
              incoming_circuit_key: _f4sh.incoming_circuit_key,
              action: 'FAIL',
              failure_code: 15,
            });
          }
        }
        if (promise._b16_hash) promiseByPaymentHash.delete(promise._b16_hash);
        promise._shards = null; promise._shard_sum_msat = 0n; promise._agg_deadline = 0; promise._agg_completed = false;
        return FAIL_TEMP;
      }
      if (promise._agg_completed) {
        console.log(`[LSPS2] F2 duplicate aggregation-complete suppressed (open+forward already proceeding)`);
        return null;
      }
      promise._agg_completed = true;
      console.log(`[LSPS2] B-11 aggregation COMPLETE -- proceeding with one open+forward`);
      // fall through: the unchanged flow below opens ONE channel and forwards
      // ONE payment; the settle section settles every shard's circuit key.
    }

    // CLTV safety: refuse to start if we wouldn't have time to open + forward.
    const tip = currentBlockHeight || 0;
    const autoFail = parseInt(req.auto_fail_height, 10) || 0;
    const margin = autoFail - tip;
    if (tip > 0 && autoFail > 0 && margin < CONFIG.lsps2.htlc_safety_blocks) {
      console.log(`[LSPS2] CLTV margin too tight for scid=${outgoingScidHex}: margin=${margin}, safety=${CONFIG.lsps2.htlc_safety_blocks} — FAIL`);
      return FAIL_TEMP;
    }

    // Per-promise lock — prevent duplicate channel-open if a retry arrives.
    if (inFlightOpens.has(outgoingScidHex)) {
      console.log(`[LSPS2] open already in flight for scid=${outgoingScidHex} — RESUME (let LND decide)`);
      return RESUME;
    }

    interceptorJitMatches += 1;
    interceptorLastMatch = {
      scid: outgoingScidHex,
      payment_hash: paymentHashHex,
      outgoing_amount_msat: req.outgoing_amount_msat,
      incoming_amount_msat: req.incoming_amount_msat,
      outgoing_expiry: req.outgoing_expiry,
      ts: now,
    };

    // Check wallet online status via chain-bridge registry.
    const walletOnline = await isPeerConnected(promise.client_pubkey);

    if (!walletOnline) {
      // D-1 2c: bounded safe hold. Fail fast (2a behavior) when the feature is
      // off, the chain tip / auto-fail height aren't known, or the payment
      // lacks comfortable CLTV headroom. Otherwise hold the HTLC briefly
      // (watchdog-capped), wake the wallet, and let the reconnect-poll replay
      // it through openChannelAndForward (which re-checks peer liveness) when
      // the user returns. Nothing is claimed while offline.
      // D-1 2c fix: the outer `tip` (currentBlockHeight) is unmaintained (0)
      // and only gates the online safety check, which is left untouched. Fetch
      // a LIVE tip here, scoped to the hold decision — shadows the outer
      // tip/margin for this block only. On getinfo failure tip stays 0 ->
      // canHold false -> safe fail-fast. No global / online-path change.
      const tip = (await lndGet('/v1/getinfo').catch(() => null))?.block_height || 0;
      const margin = autoFail - tip;
      const canHold =
        OFFLINE_HOLD_ENABLED &&
        tip > 0 && autoFail > 0 &&
        margin >= OFFLINE_MIN_HEADROOM_BLOCKS;
      if (!canHold) {
        console.log(`[LSPS2] wallet ${promise.client_pubkey.slice(0,16)}… offline — FAIL HTLC payment_hash=${paymentHashHex} (hold ${OFFLINE_HOLD_ENABLED ? 'on' : 'off'}, margin=${margin}/${OFFLINE_MIN_HEADROOM_BLOCKS})`);
        offlineHtlcsFailed += 1;
        return FAIL_TEMP;
      }
      const jitHoldCap = clientHoldCapMs(promise.client_pubkey);   // v0.45: per-client dial
      if (jitHoldCap <= 0) {
        console.log(`[LSPS2] wallet ${promise.client_pubkey.slice(0,16)}… offline — client prefers NO HOLD — FAIL fast payment_hash=${paymentHashHex}`);
        offlineHtlcsFailed += 1;
        return FAIL_TEMP;
      }
      console.log(`[LSPS2] wallet ${promise.client_pubkey.slice(0,16)}… offline — HOLDING (cap ${Math.round(jitHoldCap/1000)}s, margin=${margin}) payment_hash=${paymentHashHex}`);
      try { SM.emit('hold_created', { hash: paymentHashHex, cap_ms: jitHoldCap, via: 'jit' }); } catch (_) {}
      const _b18first = holdEntryAppend(paymentHashHex, {
        incoming_circuit_key: req.incoming_circuit_key,
        client_pubkey: promise.client_pubkey,
        outgoing_scid_hex: outgoingScidHex,
        outgoing_amount_msat: req.outgoing_amount_msat,
        incoming_amount_msat: req.incoming_amount_msat,
        outgoing_expiry: req.outgoing_expiry,
        auto_fail_height: autoFail,
        htlc_received_at: now,
        promise_ref: outgoingScidHex,
        custom_records: req.custom_records || {},
      });
      offlineHtlcsHeld += 1;
      if (_b18first) {
        scheduleHtlcWatchdog(paymentHashHex, autoFail, jitHoldCap);  /* v0.54.5: per-client */
        sendWakePush(promise.client_pubkey).catch(() => {});  // best-effort wake
      }
      return null;  // HOLD — wrapper writes nothing; reconnect-poll replays it
    }

    // v0.54.1 (d): the immediate-open path is RETIRED. A socket that looks
    // online can belong to a backgrounded, frozen wallet (2026-08-16); a
    // channel open needs the wallet actively co-signing. Every JIT match
    // now parks as a held payment with the refund timer and wake push; the
    // reconnect-poll opens the channel once the wallet proves activity
    // (walletRecentlyActive), typically within one 5s tick for a wallet
    // that is genuinely awake.
    {
      const _dTip = (await lndGet('/v1/getinfo').catch(() => null))?.block_height || 0;
      const _dAutoFail = parseInt(req.auto_fail_height, 10) || 0;
      const _dMargin = _dAutoFail - _dTip;
      const _dCap = clientHoldCapMs(promise.client_pubkey);
      if (!OFFLINE_HOLD_ENABLED || _dCap <= 0 || _dTip <= 0 || _dAutoFail <= 0 || _dMargin < OFFLINE_MIN_HEADROOM_BLOCKS) {
        console.log(`[LSPS2] JIT match but hold gates closed (hold=${OFFLINE_HOLD_ENABLED}, cap=${_dCap}, margin=${_dMargin}) — FAIL fast payment_hash=${paymentHashHex}`);
        offlineHtlcsFailed += 1;
        return FAIL_TEMP;
      }
      console.log(`[LSPS2] JIT match: scid=${outgoingScidHex} payment_hash=${paymentHashHex} — HOLDING (unified path v0.54.1; cap ${Math.round(_dCap/1000)}s, margin=${_dMargin}) — replay opens on proven wallet activity`);
      try { SM.emit('hold_created', { hash: paymentHashHex, cap_ms: _dCap, via: 'jit-unified' }); } catch (_) {}
      // v0.55.3 A6: retries of a HELD payment are duplicates, not MPP
      // siblings. For a fixed promise, once the held sum already covers the
      // expected gross (size + fee), every further full-amount HTLC is the
      // sender's retry loop re-sending — fail it back at the door instead of
      // stacking it into an over-sum forward (22:45:01: 21,500,000 vs
      // 7,100,000, LND 'attempted value exceeds payment amount').
      try {
        if (promise.payment_size_msat) {
          const _exp = BigInt(promise.payment_size_msat) + BigInt(promise.fee_msat || 0);
          const _ex = pendingHtlcsForOfflineWallets.get(paymentHashHex);
          const _held = (_ex && _ex.entries || []).reduce((a, e) => a + BigInt(e.outgoing_amount_msat || 0), 0n);
          if (_held >= _exp) {
            console.error(`[LSPS2] A6: duplicate full-amount retry HTLC for ${paymentHashHex.slice(0,16)}… (held ${_held} ≥ expected ${_exp}) — failing back`);
            return FAIL_TEMP;
          }
        }
      } catch (_) {}
      const _dFirst = holdEntryAppend(paymentHashHex, {
        incoming_circuit_key: req.incoming_circuit_key,
        client_pubkey: promise.client_pubkey,
        outgoing_scid_hex: outgoingScidHex,
        outgoing_amount_msat: req.outgoing_amount_msat,
        incoming_amount_msat: req.incoming_amount_msat,
        outgoing_expiry: req.outgoing_expiry,
        auto_fail_height: _dAutoFail,
        htlc_received_at: Date.now(),
        promise_ref: outgoingScidHex,
        custom_records: req.custom_records || {},
      });
      offlineHtlcsHeld += 1;
      if (_dFirst) {
        scheduleHtlcWatchdog(paymentHashHex, _dAutoFail, _dCap);  /* v0.54.5: per-client */
        sendWakePush(promise.client_pubkey).catch(() => {});
      }
      return null;  // HOLD — reconnect-poll replays it
    }
  } catch (e) {
    console.error(`[LSPS2] handleInterceptedHtlc threw: ${e.message} — defaulting RESUME`);
    return RESUME;
  }
}

// v0.18: is the given pubkey currently registered in the chain-bridge?
// The chain bridge's registry is populated when a wallet sends
// SubscribeChainData (their first message after WSS-connect). Eviction
// at consecutive failures means stale entries are pruned. Returns
// boolean.
function isWalletOnline(pubkeyHex) {
  if (!chainBridge) return false;
  try {
    const snapshot = chainBridge.registrySnapshot();
    const target = pubkeyHex.toLowerCase();
    return snapshot.some(entry => {
      // registrySnapshot truncates peer to 'aaaa…' format — match the prefix
      const prefix = entry.peer.replace(/[……]/g, '').toLowerCase();
      return target.startsWith(prefix);
    });
  } catch (e) {
    console.error(`[LSPS2] isWalletOnline error: ${e.message}`);
    return false;
  }
}

// v0.18: compute channel size for a JIT promise.
function computeChannelSizeSats(paymentSizeMsat) {
  const paymentSats = Math.ceil(Number(paymentSizeMsat) / 1000);
  return Math.max(paymentSats * 2, paymentSats + CONFIG.lsps2.channel_buffer_sats);
}

// v0.18: schedule a watchdog timer to FAIL an offline-held HTLC near its
// CLTV expiry. Conservative — fires at (auto_fail - SAFETY_BLOCKS - 2)
// blocks. Block time estimate: 10 minutes per block.
// B-18: append-or-create a held record. Returns true when this is the FIRST
// hold for the hash (caller arms the single watchdog + single wake push).
// ── S26: THE ATTEMPT JOURNAL (WoS retraction) ────────────────────────
// A wallet that was offline cannot know an incoming payment was attempted
// and then retracted — it only sees its own invoice sitting unpaid until
// expiry. The LSP is the one party that watched it happen, so it writes the
// fact down here and serves it back by payment hash.
const ATTEMPT_JOURNAL_PATH = process.env.ATTEMPT_JOURNAL_PATH
  || require('path').join(DATA_DIR, 'attempt-journal.json');  // v0.48 (D1)
const ATTEMPT_JOURNAL_MAX = 500;
let attemptJournal = {};
try {
  if (require('fs').existsSync(ATTEMPT_JOURNAL_PATH)) {
    attemptJournal = JSON.parse(require('fs').readFileSync(ATTEMPT_JOURNAL_PATH, 'utf-8')) || {};
    console.log(`[ATTEMPTS] loaded ${Object.keys(attemptJournal).length} journal entr(ies)`);
  }
} catch (e) {
  console.error(`[ATTEMPTS] failed to load journal (${e.message}) — starting empty`);
  attemptJournal = {};
}
function attemptJournalPersist() {
  try {
    const keys = Object.keys(attemptJournal);
    if (keys.length > ATTEMPT_JOURNAL_MAX) {
      // Ring: keep the newest ATTEMPT_JOURNAL_MAX by timestamp.
      keys.sort((a, b) => (attemptJournal[b].ts || 0) - (attemptJournal[a].ts || 0));
      const trimmed = {};
      for (const k of keys.slice(0, ATTEMPT_JOURNAL_MAX)) trimmed[k] = attemptJournal[k];
      attemptJournal = trimmed;
    }
    require('fs').writeFileSync(ATTEMPT_JOURNAL_PATH, JSON.stringify(attemptJournal));
  } catch (e) {
    console.error(`[ATTEMPTS] failed to persist journal: ${e.message}`);
  }
}
function attemptJournalWrite(paymentHashHex, outcome, amtMsat) {
  try {
    const h = String(paymentHashHex || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) return;
    attemptJournal[h] = { outcome: String(outcome), ts: Date.now(), amt_msat: Number(amtMsat || 0) };
    attemptJournalPersist();
    console.log(`[ATTEMPTS] ${outcome} ${h.slice(0, 16)}… amt=${Number(amtMsat || 0)}msat`);
  } catch (e) {}
}

function holdEntryAppend(paymentHashHex, record) {
  const entry = {
    incoming_circuit_key: record.incoming_circuit_key,
    outgoing_amount_msat: record.outgoing_amount_msat,
    incoming_amount_msat: record.incoming_amount_msat,
    outgoing_expiry: record.outgoing_expiry,
    outgoing_scid_hex: record.outgoing_scid_hex,
  };
  const existing = pendingHtlcsForOfflineWallets.get(paymentHashHex);
  if (existing) {
    const dup = (existing.entries || []).some(en =>
      en.incoming_circuit_key && record.incoming_circuit_key &&
      String(en.incoming_circuit_key.chan_id) === String(record.incoming_circuit_key.chan_id) &&
      String(en.incoming_circuit_key.htlc_id) === String(record.incoming_circuit_key.htlc_id));
    if (!dup) (existing.entries = existing.entries || []).push(entry);
    if (record.auto_fail_height && record.auto_fail_height < existing.auto_fail_height) {
      existing.auto_fail_height = record.auto_fail_height;  // tighter deadline wins
    }
    console.log(`[B-18] hold entry appended for ${paymentHashHex.slice(0,16)}…: ${existing.entries.length} shard(s) held (single watchdog, single push)`);
    return false;
  }
  record.entries = [entry];
  pendingHtlcsForOfflineWallets.set(paymentHashHex, record);
  return true;
}

function scheduleHtlcWatchdog(paymentHashHex, autoFailHeight, capMs) {
  // v0.54.5: the refund timer honors the PER-CLIENT hold choice (Privacy
  // dial → /client/prefs → clientHoldCapMs = min(user wish, LSP ceiling)).
  // Before this, the dial changed the log line but the timer stayed at the
  // global cap. CLTV headroom below still bounds everything.
  const effCapMs = (Number.isFinite(capMs) && capMs > 0) ? capMs : OFFLINE_HOLD_CAP_MS;
  const tip = currentBlockHeight || autoFailHeight - 144;  // assume ~1 day if no tip
  const blocksUntilDeadline = autoFailHeight - tip - CONFIG.lsps2.htlc_safety_blocks - 2;
  // D-1 2c: never hold longer than the configured cap (default 3 min), even if
  // the CLTV budget would allow more. The headroom gate guarantees the
  // CLTV-derived value is far larger, so in practice the cap is what fires.
  const cltvDerivedMs = blocksUntilDeadline * 10 * 60 * 1000;
  const msUntilDeadline = Math.min(effCapMs, Math.max(30_000, cltvDerivedMs));
  // v0.54.1 (b): belt — snapshot the circuit keys NOW so the timer can
  // order the refund even if the held-payment record is gone at fire time.
  const _beltHeld = pendingHtlcsForOfflineWallets.get(paymentHashHex);
  const _beltCircuits = _beltHeld
    ? (_beltHeld.entries || [ { incoming_circuit_key: _beltHeld.incoming_circuit_key } ]).map(e => e.incoming_circuit_key)
    : [];
  const handle = setTimeout(() => {
    const held = pendingHtlcsForOfflineWallets.get(paymentHashHex);
    if (!held) {
      // v0.54.1 (b): record gone but resolution never written — the exact
      // orphan class of 2026-08-16 (sender stuck pending until CLTV).
      if (!resolvedHtlcHashes.has(paymentHashHex) && _beltCircuits.length &&
          htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite) {
        console.warn(`[LSPS2] watchdog BELT: held record for ${paymentHashHex.slice(0,16)}… is gone with no resolution written — FAILing ${_beltCircuits.length} circuit(s) back to the sender`);
        for (const _ck of _beltCircuits) {
          htlcInterceptor.getCounters()._lastWrite({ incoming_circuit_key: _ck, action: 'FAIL', failure_code: 15 });
        }
        resolvedHtlcHashes.add(paymentHashHex);
        offlineHtlcsFailed += 1;
        try { SM.emit('watchdog_fired', { hash: paymentHashHex, belt: true }); } catch (_) {}
      }
      return;
    }
    console.warn(`[LSPS2] watchdog: HTLC ${paymentHashHex.slice(0,16)}… for offline wallet expired — FAIL`);
    try { SM.emit('watchdog_fired', { hash: paymentHashHex }); } catch (_) {}
    if (htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite) {
      const _wdList = held.entries || [ { incoming_circuit_key: held.incoming_circuit_key } ];
      for (const _en of _wdList) {
        htlcInterceptor.getCounters()._lastWrite({
          incoming_circuit_key: _en.incoming_circuit_key,
          action: 'FAIL',
          failure_code: 15,  // temporary_channel_failure (7 is EXPIRY_TOO_SOON -- LND rejects it and crashes the interceptor; same fix FAIL_TEMP received)
        });
      }
      console.warn(`[B-18] watchdog FAILed ${_wdList.length} held shard(s) for ${paymentHashHex.slice(0,16)}…`);
    }
    // S26: the wallet was offline for this whole story — journal it so a
    // reopened wallet can say "retracted" instead of waiting out the clock.
    try {
      const _jEntries = held.entries || [];
      let _jMsat = 0;
      for (const _je of _jEntries) {
        _jMsat += Number(_je.outgoing_amount_msat || _je.incoming_amount_msat || 0);
      }
      if (!_jMsat) _jMsat = Number(held.outgoing_amount_msat || held.incoming_amount_msat || 0);
      attemptJournalWrite(paymentHashHex, 'RETRACTED', _jMsat);
    } catch (_) {}
    pendingHtlcsForOfflineWallets.delete(paymentHashHex);
    htlcWatchdogs.delete(paymentHashHex);
    resolvedHtlcHashes.add(paymentHashHex);  /* v0.54.1 (b) */
    offlineHtlcsFailed += 1;
  }, msUntilDeadline);
  htlcWatchdogs.set(paymentHashHex, handle);
  console.log(`[LSPS2] watchdog scheduled for ${paymentHashHex.slice(0,16)}…: fires in ~${Math.round(msUntilDeadline/60000)} min${(Number.isFinite(capMs) && capMs > 0 && capMs !== OFFLINE_HOLD_CAP_MS) ? ' (client hold choice)' : ''}`);
  try { SM.emit('watchdog_scheduled', { hash: paymentHashHex, in_ms: msUntilDeadline }); } catch (_) {}
}

// v0.18: cancel a watchdog (called when the HTLC is settled or otherwise
// resolved before expiry).
function cancelHtlcWatchdog(paymentHashHex) {
  const handle = htlcWatchdogs.get(paymentHashHex);
  if (handle) { clearTimeout(handle); htlcWatchdogs.delete(paymentHashHex); }
}

// D-1 2b: is the wallet currently a connected LND peer? Uses the same
// /v1/peers REST call the critical-peer keepalive relies on (macaroon
// already permits it), so it is authoritative for whether openChannelSync
// can succeed and far fresher than the chain-bridge registry (~30 min lag).
// v0.34.0 (S30): ONE ORACLE — the resume paths now consult the same
// LND peer truth the HOLD decision uses. A 4s-cached /v1/peers snapshot
// serves every liveness check in a tick. The bridge registry (stale after
// iOS app-switch resumes: sockets reopen, no re-announce) survives as log
// flavor only.
let _peersCache = { ts: 0, set: new Set() };
async function peersConnectedSet() {
  const now = Date.now();
  if (now - _peersCache.ts < 4000) return _peersCache.set;
  try {
    const data = await lndGet('/v1/peers');
    _peersCache = { ts: now, set: new Set((data.peers || []).map(p => (p.pub_key || '').toLowerCase())) };
    // (0.72.2's lease stamp moved to leasePresenceTick — this function is only called
    // while HTLCs are pending, so it was never a reliable presence signal.)
  } catch (e) { /* keep last known */ }
  return _peersCache.set;
}
async function isPeerConnected(pubkeyHex) {
  return (await peersConnectedSet()).has((pubkeyHex || '').toLowerCase());
}

// ── v0.20 VARIABLE (S27 design final v2): open-amount JIT ────────────────────
// A zero-amount invoice has no total, so the fixed-mode completeness gate
// (sum >= size + fee) is impossible BY CONSTRUCTION. The judge becomes
// QUIESCENCE: hold every part; when no new part has arrived for
// variable_quiesce_ms, the set is final. The channel is sized from the
// OBSERVED gross (ceiling-capped); fee = max(min_fee, ceil(sum*ppm/1e6)),
// deducted once at flush. The wallet's amountless invoice claims WHATEVER
// total the final hop declares (engine registered the total_msat=0
// sentinel; openChannelAndForward's falsy-total fallback then declares
// sum - fee), so the deduction can never break claim equality. Offline
// hold, B-13 mid-open hold, watchdogs: inherited verbatim.
function handleVariableShard(req, promise, outgoingScidHex, paymentHashHex) {
  const FAIL_TEMP = {
    incoming_circuit_key: req.incoming_circuit_key,
    action: 'FAIL',
    failure_code: 15,
  };
  const outAmtMsat = BigInt(req.outgoing_amount_msat || '0');

  // Straggler after the set was committed: FAIL. If the flush settled, the
  // sender already holds the preimage (payment proven; this part refunds).
  if (promise._var_flushing) {
    console.log(`[LSPS2] v0.20 straggler after flush for scid=${outgoingScidHex} — FAIL`);
    return FAIL_TEMP;
  }

  // Per-part floor (same env the fixed path uses).
  if (outAmtMsat < BigInt(CONFIG.lsps2.min_shard_msat)) {
    console.log(`[LSPS2] v0.20 shard below floor for scid=${outgoingScidHex}: ${outAmtMsat} < ${CONFIG.lsps2.min_shard_msat} — FAIL`);
    return FAIL_TEMP;
  }

  // Per-part CLTV safety (mirror of the fixed path's pre-open check).
  const tip = currentBlockHeight || 0;
  const autoFail = parseInt(req.auto_fail_height, 10) || 0;
  const margin = autoFail - tip;
  if (tip > 0 && autoFail > 0 && margin < CONFIG.lsps2.htlc_safety_blocks) {
    console.log(`[LSPS2] v0.20 CLTV margin too tight for scid=${outgoingScidHex}: margin=${margin}, safety=${CONFIG.lsps2.htlc_safety_blocks} — FAIL`);
    return FAIL_TEMP;
  }

  if (!promise._shards) {
    promise._shards = new Map();
    promise._shard_sum_msat = 0n;
    promise._var_min_expiry = Number.POSITIVE_INFINITY;
    promise._var_min_autofail = Number.POSITIVE_INFINITY;
  }
  const ck = req.incoming_circuit_key || {};
  const ckKey = `${ck.chan_id || '0'}:${ck.htlc_id || '0'}`;
  if (!promise._shards.has(ckKey)) {
    promise._shards.set(ckKey, { incoming_circuit_key: req.incoming_circuit_key, msat: outAmtMsat });
    promise._shard_sum_msat += outAmtMsat;
    try { SM.emit('shard_registered', { hash: paymentHashHex, mode: 'variable' }); } catch (_) {}
  }
  const exp = parseInt(req.outgoing_expiry, 10) || 0;
  if (exp > 0 && exp < promise._var_min_expiry) promise._var_min_expiry = exp;
  if (autoFail > 0 && autoFail < promise._var_min_autofail) promise._var_min_autofail = autoFail;

  // B-16 mirror: bind hash -> promise so sibling shards that ride a REAL
  // channel divert into this same aggregate.
  if (paymentHashHex && paymentHashHex !== '(missing)') {
    promise._b16_hash = paymentHashHex;
    if (resolvedHtlcHashes.has(paymentHashHex)) {  /* v0.55.0 A4 */
      console.error(`[LSPS2] A4: shard for TERMINAL hash ${paymentHashHex.slice(0,16)}… — refusing, failing back`);
      return { incoming_circuit_key: req.incoming_circuit_key, action: 'FAIL', failure_code: 15 };
    }
    promiseByPaymentHash.set(paymentHashHex, { promise, scidHex: outgoingScidHex });
  }

  console.log(`[LSPS2] v0.20 variable shard: +${outAmtMsat} -> ${promise._shard_sum_msat} msat (${promise._shards.size} part(s)); quiesce ${CONFIG.lsps2.variable_quiesce_ms}ms re-armed`);

  // QUIESCENCE: every part re-arms the timer; silence flushes.
  if (promise._var_timer) clearTimeout(promise._var_timer);
  promise._var_timer = setTimeout(() => {
    flushVariable(promise, outgoingScidHex, paymentHashHex).catch((e) => {
      console.error(`[LSPS2] v0.20 flush error for scid=${outgoingScidHex}: ${e.message}`);
    });
  }, CONFIG.lsps2.variable_quiesce_ms);

  return null;  // HOLD — LND keeps the HTLC pending
}

async function flushVariable(promise, scidHex, paymentHashHex) {
  promise._var_timer = null;
  if (promise._var_flushing) return;
  if (!promise._shards || promise._shards.size === 0 || promise._shard_sum_msat <= 0n) return;
  if (inFlightOpens.has(scidHex)) {
    console.log(`[LSPS2] v0.20 flush: open already in flight for scid=${scidHex} — skip`);
    return;
  }
  promise._var_flushing = true;

  const c = CONFIG.lsps2;
  const sum = promise._shard_sum_msat;
  // 0.69.0: the one opening-fee law. Scarcity = the multiplier SNAPSHOTTED
  // into this promise at buy-time (v0.33.0; a promise without one charges base
  // terms, never above what was quoted); per-wallet = this wallet's escalator,
  // the same one get_info's open_fee_quote showed it.
  const fee = channelOpenFeeMsat(sum, promise.client_pubkey, parseInt(promise.scarcity_mult_pct, 10) || 100);
  const net = sum - fee;

  const writeOne = (r) => {
    if (htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite) {
      htlcInterceptor.getCounters()._lastWrite(r);
    }
  };

  if (net <= 0n) {
    console.warn(`[LSPS2] v0.20 flush: gross ${sum} msat <= fee ${fee} — FAILing all ${promise._shards.size} part(s)`);
    for (const [, sh] of promise._shards) {
      writeOne({ incoming_circuit_key: sh.incoming_circuit_key, action: 'FAIL', failure_code: 15 });
    }
    // v0.25.0 (S30): honest SM terminal.
    try { SM.emit('var_flush_failed', { hash: paymentHashHex, why: 'gross <= fee' }); } catch (_) {}
    if (promise._b16_hash) promiseByPaymentHash.delete(promise._b16_hash);
    promise._shards = null; promise._shard_sum_msat = 0n; promise._var_flushing = false;
    return;
  }

  // Sizing input ONLY — openChannelAndForward's forward math reads the
  // shard sum (B-15), never this field: observed gross, ceiling-capped.
  const ceiling = BigInt(c.variable_ceiling_msat);
  const sizingMsat = sum > ceiling ? ceiling : sum;
  promise.payment_size_msat = sizingMsat.toString();
  promise.fee_msat = fee.toString();
  // promise.total_amt_msat: the v188 sentinel (0) stays falsy -> the
  // mpp_record fallback declares exactly sum - fee. Do not touch it.

  // v0.25.0 (S30): VARIABLE DEFERS TO WAKE — fixed-mode parity. The
  // variable path never vetted receiver presence at intercept (the fixed
  // path's D-1 2c does), so an offline receiver fell through to
  // openChannelAndForward's D-1 2b FAIL-fast: no hold, no wake push,
  // "never arrived". Park the WHOLE aggregate in the held-queue instead;
  // the reconnect replay rebuilds the shard set from the entries and
  // opens when the wallet returns. Aggregation state resets here so a
  // post-watchdog fresh attempt starts clean, and a late sibling shard
  // during the hold re-aggregates and JOINS the same record (dedup by
  // circuit key; single watchdog, single push). Size/fee are recomputed
  // at replay from the rebuilt sum, so held-time values never bind.
  let varPeerOnline = true;
  try { varPeerOnline = await isPeerConnected(promise.client_pubkey); }
  catch (e) { console.warn(`[LSPS2] v0.25 flush liveness check errored (${e.message}) — proceeding to open`); }
  if (!varPeerOnline) {
    const holdTip = (await lndGet('/v1/getinfo').catch(() => null))?.block_height || 0;
    const holdAutoFail = (promise._var_min_autofail === Number.POSITIVE_INFINITY) ? 0 : promise._var_min_autofail;
    const holdMargin = holdAutoFail - holdTip;
    const varCanHold = OFFLINE_HOLD_ENABLED && holdTip > 0 && holdAutoFail > 0 && holdMargin >= OFFLINE_MIN_HEADROOM_BLOCKS;
    const varParts = Array.from(promise._shards.values());
    if (!varCanHold) {
      console.warn(`[LSPS2] v0.25 flush: receiver offline and hold unavailable (enabled=${OFFLINE_HOLD_ENABLED}, margin=${holdMargin}/${OFFLINE_MIN_HEADROOM_BLOCKS}) — FAILing all ${varParts.length} part(s)`);
      for (const sh of varParts) {
        writeOne({ incoming_circuit_key: sh.incoming_circuit_key, action: 'FAIL', failure_code: 15 });
      }
      // v0.25.0 (S30): honest SM terminal.
      try { SM.emit('var_flush_failed', { hash: paymentHashHex, why: 'receiver offline, hold unavailable' }); } catch (_) {}
      if (promise._b16_hash) promiseByPaymentHash.delete(promise._b16_hash);
      promise._shards = null; promise._shard_sum_msat = 0n; promise._var_flushing = false;
      return;
    }
    const varExpiry = String(promise._var_min_expiry === Number.POSITIVE_INFINITY ? 0 : promise._var_min_expiry);
    console.warn(`[LSPS2] v0.25 flush: receiver offline — HOLDING ${varParts.length} part(s) (cap ${Math.round(OFFLINE_HOLD_CAP_MS/1000)}s, margin=${holdMargin}) payment_hash=${paymentHashHex}`);
    try { SM.emit('hold_created', { hash: paymentHashHex, cap_ms: OFFLINE_HOLD_CAP_MS, via: 'var' }); } catch (_) {}
    let varFirstHold = false;
    for (const sh of varParts) {
      const _isFirst = holdEntryAppend(paymentHashHex, {
        incoming_circuit_key: sh.incoming_circuit_key,
        client_pubkey: promise.client_pubkey,
        outgoing_scid_hex: scidHex,
        outgoing_amount_msat: sh.msat.toString(),
        incoming_amount_msat: sh.msat.toString(),
        outgoing_expiry: varExpiry,
        auto_fail_height: holdAutoFail,
        htlc_received_at: Date.now(),
        promise_ref: scidHex,
        custom_records: {},
      });
      if (_isFirst) varFirstHold = true;
    }
    offlineHtlcsHeld += varParts.length;
    if (varFirstHold) {
      scheduleHtlcWatchdog(paymentHashHex, holdAutoFail, clientHoldCapMs(promise.client_pubkey));  /* v0.54.5: per-client */
      sendWakePush(promise.client_pubkey).catch(() => {});
    }
    promise._shards = null; promise._shard_sum_msat = 0n; promise._var_flushing = false;
    return;
  }

  // Synthetic completing request: a REAL part's circuit key (its return-
  // settle covers that part; the B-11 extras loop covers the rest), the
  // TIGHTEST expiry across parts, the observed gross as the face.
  const first = promise._shards.values().next().value;
  const synthetic = {
    incoming_circuit_key: first.incoming_circuit_key,
    outgoing_amount_msat: sum.toString(),
    incoming_amount_msat: sum.toString(),
    outgoing_expiry: String(promise._var_min_expiry === Number.POSITIVE_INFINITY ? 0 : promise._var_min_expiry),
    auto_fail_height: String(promise._var_min_autofail === Number.POSITIVE_INFINITY ? 0 : promise._var_min_autofail),
    custom_records: {},
  };

  console.log(`[LSPS2] v0.20 QUIESCENCE FLUSH: ${promise._shards.size} part(s), gross=${sum} fee=${fee} net=${net} — opening (sized from ${sizingMsat} msat)`);
  inFlightOpens.add(scidHex);
  let resp = null;
  try {
    resp = await openChannelAndForward(synthetic, promise, scidHex, paymentHashHex);
  } finally {
    inFlightOpens.delete(scidHex);
  }

  if (resp === null) {
    // B-13/offline hold path engaged inside: the synthetic circuit key is
    // parked in the held-queue; remaining parts stay on the promise; the
    // reconnect replay flows back through openChannelAndForward and its
    // settle-all covers every part.
    console.log(`[LSPS2] v0.20 flush: hold path engaged — parts parked, replay will complete`);
    return;
  }

  // No interceptor return context in a timer — write the completing
  // response ourselves. SETTLE: extras were settled inside; this settles
  // the synthetic's part. FAIL: fail the rest too, reset for clean retry.
  writeOne(resp);
  if (resp.action === 'FAIL') {
    const ckR = synthetic.incoming_circuit_key || {};
    const reqKey = `${ckR.chan_id || '0'}:${ckR.htlc_id || '0'}`;
    if (promise._shards) {
      for (const [key, sh] of promise._shards) {
        if (key === reqKey) continue;
        writeOne({ incoming_circuit_key: sh.incoming_circuit_key, action: 'FAIL', failure_code: 15 });
      }
    }
    if (promise._b16_hash) promiseByPaymentHash.delete(promise._b16_hash);
    promise._shards = null; promise._shard_sum_msat = 0n; promise._var_flushing = false;
    if (promise._finalVerdict) {  /* v0.55.0 A2 */
      console.error(`[LSPS2] A2: flush FAILed on FINAL verdict ${promise._finalVerdict} — promise LATCHED, no clean-retry`);
    } else {
      console.log(`[LSPS2] v0.20 flush FAILed — promise reset for a clean retry`);
    }
    // v0.25.0 (S30): honest SM terminal.
    try { SM.emit('var_flush_failed', { hash: paymentHashHex, why: 'open failed' }); } catch (_) {}
  }
}

// v0.18: the core D.2 path. Opens channel, sends payment over it, settles
// the inbound HTLC with the returned preimage. Returns the
// ForwardHtlcInterceptResponse to write back on the stream.
async function openChannelAndForward(req, promise, scidHex, paymentHashHex) {
  trampolineForwardsAttempted += 1;
  const FAIL_TEMP = {
    incoming_circuit_key: req.incoming_circuit_key,
    action: 'FAIL',
    failure_code: 15,  // B-14: TEMPORARY_CHANNEL_FAILURE — LND rejects 7 and the rejection kills the interceptor stream (journal 18:17:19, 34 s blind)
  };

  // D-1 2b: fresh peer-liveness gate. The chain-bridge registry that routed
  // us here can lag ~30 min, so confirm the wallet is a connected LND peer
  // right now. If not, FAIL fast instead of hanging to the openChannelSync
  // timeout (and avoid LND briefly tracking a half-open channel to a ghost).
  try {
    if (!(await isPeerConnected(promise.client_pubkey))) {
      trampolineForwardsFailed += 1;
      console.log(`[LSPS2] peer ${promise.client_pubkey.slice(0,16)}… not a live LND peer at open time — FAIL fast (D-1 2b)`);
      return FAIL_TEMP;
    }
  } catch (e) {
    console.warn(`[LSPS2] peer-liveness check errored (${e.message}) — proceeding with open attempt`);
  }

  // v0.55.0 A5: reservation preflight — never open on a dead promise.
  if (promise.reservation_expires_at && Date.now() > promise.reservation_expires_at) {
    trampolineForwardsFailed += 1;
    console.error(`[LSPS2] A5: promise reservation EXPIRED — failing all shards back, no open (hash=${paymentHashHex.slice(0,16)}…)`);
    resolvedHtlcHashes.add(paymentHashHex);
    try {
      if (htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite && promise._shards) {
        const _reqK = `${(req.incoming_circuit_key||{}).chan_id || '0'}:${(req.incoming_circuit_key||{}).htlc_id || '0'}`;
        for (const [k, sh] of promise._shards) { if (k !== _reqK) htlcInterceptor.getCounters()._lastWrite({ incoming_circuit_key: sh.incoming_circuit_key, action: 'FAIL', failure_code: 15 }); }
      }
    } catch (_) {}
    return FAIL_TEMP;
  }
  // v0.55.0 A3: HARD CAP — one channel open per promise, ever. The retry
  // storm of 2026-08-16 opened five real channels for one doomed payment.
  // (Alias-reuse on retryable failures is a noted follow-up; the cap alone
  // kills the burn class.)
  promise._openCount = (promise._openCount || 0) + 1;
  if (promise._openCount > 1) {
    trampolineForwardsFailed += 1;
    console.error(`[LSPS2] A3: open attempt #${promise._openCount} for one promise — REFUSED (cap=1); failing back (hash=${paymentHashHex.slice(0,16)}…)`);
    resolvedHtlcHashes.add(paymentHashHex);
    try { SM.emit('forward_result', { hash: paymentHashHex, ok: false, code: 'a3_cap' }); } catch (_) {}   // 0.62.0: the SM showed HOLDING@1173s after this fail-back
    return FAIL_TEMP;
  }
  const _a3ChansBefore = await jitChannelsToPeer(promise.client_pubkey);   // 0.62.0: baseline for the A3 release check
  // Step 1: open channel.
  const channelSizeSats = computeChannelSizeSats(promise.payment_size_msat);
  // v0.18.6: reserve override via proto field 30 was rolled back (see header).
  // CONFIG.channel.jit_channel_reserve_percent is RETAINED for future REST
  // path implementation but has no effect on this code path — LND uses its
  // default ~1% reserve regardless. Logged for observability.
  const desiredReserveSats = Math.floor(
    channelSizeSats * CONFIG.channel.jit_channel_reserve_percent / 100
  );
  if (CONFIG.channel.jit_channel_reserve_percent !== 0) {
    console.warn(`[LSPS2] JIT_CHANNEL_RESERVE_PERCENT=${CONFIG.channel.jit_channel_reserve_percent}% requested (would be ${desiredReserveSats} sat) but reserve-override is currently inoperative; LND default (~1%) will apply`);
  }
  // v0.32.0 (S30): on-chain reserve floor — fail-fast mirrors D-1 2b.
  if (!(await jitReserveOk(channelSizeSats, 'lsps2:' + promise.client_pubkey.slice(0, 16)))) {
    trampolineForwardsFailed += 1;
    if (htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite) {
      htlcInterceptor.getCounters()._lastWrite(FAIL_TEMP);
    }
    return null;
  }
  console.log(`[LSPS2] opening ${channelSizeSats}-sat channel to ${promise.client_pubkey.slice(0,16)}…`);
  const _dtOpenT0 = Date.now();  /* v0.40.0 */
  let channelPoint;
  try {
    leaseRememberWalletPeer(promise.client_pubkey);   // 0.72.3
    channelPoint = await openChannelSync(lightningOpenChannelClient, {
      node_pubkey_string: promise.client_pubkey,
      local_funding_amount: channelSizeSats,
      push_sat: 0,
      sat_per_byte: 1,
      private: true,
      min_confs: 0,
      zero_conf: true,
      scid_alias: true,
      remote_chan_reserve_sat: jitReserveForOpen(channelSizeSats),   // v0.56.0 (O5): floor-or-percent, governor-gated
      // T1 (terminus): env-gated commitment type. STATIC_REMOTE_KEY
      // requires the terminus-patched lnd (zero-conf x no-anchors
      // whitelist). Default ANCHORS preserves today's behavior until
      // .env sets LSPS2_COMMITMENT_TYPE.
      commitment_type: process.env.LSPS2_COMMITMENT_TYPE || 'ANCHORS',
      ...openPolicyFields(),   // 0.66.0: the channel's fee policy, set in the open
    }, CONFIG.lsps2.openchannel_timeout_ms);
    jitRecordOpen(promise.client_pubkey);   // v0.32.0: per-wallet open counter (success only)
  } catch (e) {
    // B-13: mid-open peer-disconnect -> HOLD + retry-open-on-reconnect.
    // The wallet passed the D-1 2b liveness gate but dropped mid-negotiation
    // (specimen 2026-07-06 22:17:58). LND aborts the pending zero-conf
    // channel on disconnect, so a fresh open on return is clean. Park the
    // triggering HTLC in the SAME held-queue the offline-at-intercept path
    // uses; the reconnect poll replays it through this very function.
    // B-11 shards stay parked on the promise; settle-all covers them.
    // Gates mirror D-1 2c: hold enabled, live tip, CLTV headroom.
    // ── F6 (v0.39.0, S31): hold-class revival ─────────────────────────────
    // Bust the 4s peer cache on ANY open failure: it answered "online" for
    // an entire retry storm (05:26 e5d62742) while LND said otherwise, so
    // the next shard must see LND truth and take the D-1 2c hold+push path.
    try { _peersCache = { ts: 0, set: new Set() }; } catch (_) {}
    // LND's actual phrasing is "peer <pubkey> is not online" -- the old
    // literal "peer is not online" NEVER matched (convicted across both
    // 2026-07-31 incidents), so B-13 mid-open holds were dead for this
    // class. "received funding error" is the backgrounded wallet's
    // acceptance gate refusing the open -- exactly the case hold+wake
    // exists for; the reconnect-poll replay retries the open once the
    // user returns and the gate is up.
    // v0.39.1 (S31): error-agnostic. "4 DEADLINE_EXCEEDED after 25s"
    // (half-open tunnel, frozen wallet mid-accept) matched nothing --
    // third silent class in one day. Every open failure in a JIT LSP is
    // the hold+wake case; the gates below bound it exactly as before.
    const disconnectClass = true; /* v0.39.1: every open failure holds when gates allow */
    if (disconnectClass && OFFLINE_HOLD_ENABLED) {
      const autoFail = parseInt(req.auto_fail_height, 10) || 0;
      const tip = (await lndGet('/v1/getinfo').catch(() => null))?.block_height || 0;
      const margin = autoFail - tip;
      if (tip > 0 && autoFail > 0 && margin >= OFFLINE_MIN_HEADROOM_BLOCKS) {
        console.warn(`[B-13] disconnect mid-open for scid=${scidHex} (${e.message}) — HOLDING (cap ${Math.round(OFFLINE_HOLD_CAP_MS/1000)}s, margin=${margin}) payment_hash=${paymentHashHex}`);
        try { SM.emit('hold_created', { hash: paymentHashHex, cap_ms: OFFLINE_HOLD_CAP_MS, via: 'b13' }); } catch (_) {}
        // 0.62.0 (S42 field specimen c5539c2f): A3 had counted this aborted
        // attempt, so the replay this hold exists for was REFUSED as
        // "attempt #2" and the payment failed back. A3 stops REAL channels
        // being opened twice for one promise; an attempt LND aborted before
        // funding created nothing and must not consume the cap. Verified
        // against LND: no new channel to this wallet, nothing pending.
        try {
          const _after = await jitChannelsToPeer(promise.client_pubkey);
          const _pend = await jitPendingOpensToPeer(promise.client_pubkey);
          if (_after <= _a3ChansBefore && _pend === 0) {
            promise._openCount = Math.max(0, (promise._openCount || 1) - 1);
            console.warn(`[A3] attempt released for ${paymentHashHex.slice(0,16)}… — LND created no channel (${_after} open, ${_pend} pending to this wallet); the replay may open once`);
          } else {
            console.warn(`[A3] attempt KEPT for ${paymentHashHex.slice(0,16)}… — a channel exists or is pending to this wallet (${_after} open, ${_pend} pending); cap holds`);
          }
        } catch (_) {}
        const _b18b13First = holdEntryAppend(paymentHashHex, {
          incoming_circuit_key: req.incoming_circuit_key,
          client_pubkey: promise.client_pubkey,
          outgoing_scid_hex: scidHex,
          outgoing_amount_msat: req.outgoing_amount_msat,
          incoming_amount_msat: req.incoming_amount_msat,
          outgoing_expiry: req.outgoing_expiry,
          auto_fail_height: autoFail,
          htlc_received_at: Date.now(),
          promise_ref: scidHex,
          custom_records: req.custom_records || {},
        });
        offlineHtlcsHeld += 1;
        if (_b18b13First) {
          scheduleHtlcWatchdog(paymentHashHex, autoFail, clientHoldCapMs(promise.client_pubkey));  /* v0.54.5: per-client */
          sendWakePush(promise.client_pubkey).catch(() => {});
        }
        return null;  // HOLD — reconnect-poll replays through openChannelAndForward
      }
      console.warn(`[B-13] disconnect mid-open but hold gates failed (tip=${tip}, autoFail=${autoFail}, margin=${margin}) — FAIL`);
    }
    trampolineForwardsFailed += 1;
    console.error(`[LSPS2] openChannelSync failed for scid=${scidHex} after ${Date.now() - _dtOpenT0}ms: ${e.message}`);
    if (/DEADLINE/i.test(e.message || '')) {
      console.warn(`[DECIDE] ${paymentHashHex.slice(0,16)} open DEADLINE - the gRPC call gave up but LND's funding negotiation CONTINUES; this open may COMPLETE in background when the wallet returns (the 2x 204k orphan class). Reconcile channels for ${promise.client_pubkey.slice(0,16)}... before the next open.`);
    }
    // F1 (v0.37.0): deregister the triggering shard so a sender retry
    // generation cannot double the aggregate sum (the 2026-07-31 wedge).
    try {
      const _f1ck = (req && req.incoming_circuit_key) || {};
      const _f1key = `${_f1ck.chan_id || '0'}:${_f1ck.htlc_id || '0'}`;
      if (promise && promise._shards && promise._shards.has(_f1key)) {
        const _f1sh = promise._shards.get(_f1key);
        promise._shards.delete(_f1key);
        try { promise._shard_sum_msat -= BigInt((_f1sh && _f1sh.msat) || 0); } catch (_) {}
        promise._agg_completed = false;
        console.warn(`[LSPS2] F1 deregistered failed shard ${_f1key}: sum now ${promise._shard_sum_msat} msat (${promise._shards.size} shard(s))`);
      }
    } catch (_) {}
    return FAIL_TEMP;
  }
  console.log(`[LSPS2] channel opened — funding txid index=${channelPoint.output_index} (${Date.now() - _dtOpenT0}ms)`);  /* v0.40.0 */
  try { SM.emit('open_result', { hash: paymentHashHex, ok: true }); } catch (_) {}

  // Step 2: find the SCID of the new channel via ListChannels. Zero-conf
  // channels have a placeholder real SCID but a usable alias_scids list.
  let newChannelScid;
  try {
    newChannelScid = await findChannelScid(promise.client_pubkey, channelPoint);
  } catch (e) {
    trampolineForwardsFailed += 1;
    console.error(`[LSPS2] findChannelScid failed: ${e.message}`);
    return FAIL_TEMP;
  }
  if (!newChannelScid) {
    trampolineForwardsFailed += 1;
    console.error(`[LSPS2] new channel has no usable SCID yet — FAIL`);
    return FAIL_TEMP;
  }

  // Step 3: build route + sendToRouteV2 with the inbound payment_hash.
  // B-15: aggregate-aware forward — when B-11 shards completed the gross,
  // forward Σ − fee (== size, the net the recipient expects), never the
  // triggering shard alone.
  const _inGross = (promise._shards && promise._shard_sum_msat > 0n)
    ? promise._shard_sum_msat
    : BigInt(req.outgoing_amount_msat);
  const forwardAmountMsat = (_inGross - BigInt(promise.fee_msat)).toString();
  // Option B: payment_secret is registered out-of-band by the wallet (POST
  // /lsps2/register_secret) right after it builds the invoice, BEFORE it is
  // shown to the payer. It is NOT in the intercepted HTLC: it lives in the
  // wallet's final-hop onion layer, encrypted for the wallet, which this
  // (penultimate) node cannot decrypt. Stored on the promise as a 32-byte
  // Buffer plus total_amt_msat (the NET the wallet expects == forwardAmountMsat).
  const paymentSecretBuf = promise.payment_secret || null;
  const totalAmtMsat = promise.total_amt_msat ? String(promise.total_amt_msat) : forwardAmountMsat;
  if (!paymentSecretBuf) {
    trampolineForwardsFailed += 1;
    console.error(`[LSPS2] no MPP payment_secret in incoming HTLC for scid=${scidHex} — FAIL`);
    return FAIL_TEMP;
  }

  const route = {
    total_time_lock: parseInt(req.outgoing_expiry, 10),
    total_fees_msat: '0',
    total_amt_msat: forwardAmountMsat,
    hops: [{
      chan_id: newChannelScid,
      amt_to_forward_msat: forwardAmountMsat,
      fee_msat: '0',
      expiry: parseInt(req.outgoing_expiry, 10),
      pub_key: promise.client_pubkey,
      tlv_payload: true,
      mpp_record: {
        payment_addr: paymentSecretBuf,
        total_amt_msat: totalAmtMsat,
      },
    }],
  };

  console.log(`[LSPS2] sendToRouteV2: forwarding ${forwardAmountMsat}msat to ${promise.client_pubkey.slice(0,16)}… via scid=${newChannelScid}`);
  let htlcAttempt;
  try {
    const paymentHash = Buffer.from(paymentHashHex, 'hex');
    htlcAttempt = await sendToRouteV2Hard(routerClient, paymentHash, route, CONFIG.lsps2.sendtoroute_timeout_ms, 'jit-or-trampoline');  /* F3 v0.37.0 */
  } catch (e) {
    trampolineForwardsFailed += 1;
    console.error(`[LSPS2] sendToRouteV2 rejected for scid=${scidHex}: ${e.message}`);
    try { SM.emit('forward_result', { hash: paymentHashHex, ok: false, code: 'reject:' + ((e && e.message) || '?') }); } catch (_) {}  /* F3 v0.37.0 */
    return FAIL_TEMP;
  }

  if (htlcAttempt.status !== 'SUCCEEDED' || !htlcAttempt.preimage || htlcAttempt.preimage.length === 0) {
    trampolineForwardsFailed += 1;
    const failCode = htlcAttempt.failure && htlcAttempt.failure.code;
    console.error(`[LSPS2] sendToRouteV2 did not succeed: status=${htlcAttempt.status} failure_code=${failCode}`);
    /* v0.55.0 A2: a FINAL-NODE verdict means the recipient's wallet itself
       refused this payment's details — no retry can ever succeed. Latch. */
    try {
      if (['INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS','FINAL_INCORRECT_CLTV_EXPIRY','FINAL_INCORRECT_HTLC_AMOUNT'].includes(String(failCode))) {
        promise._finalVerdict = String(failCode);
        resolvedHtlcHashes.add(paymentHashHex);
        console.error(`[LSPS2] A2: FINAL-NODE VERDICT ${failCode} — promise latched; clean-retry refused, further shards for this hash will be failed back`);
      }
    } catch (_) {}
    try { SM.emit('forward_result', { hash: paymentHashHex, ok: false, code: failCode }); } catch (_) {}
    return FAIL_TEMP;
  }

  trampolineForwardsSucceeded += 1;
  console.log(`[LSPS2] sendToRouteV2 succeeded — preimage received, SETTLING inbound`);
  plRecord('open_fee', { msat: Number(promise.fee_msat || 0), wallet: promise.client_pubkey, hash: paymentHashHex, scarcity_pct: promise.scarcity_mult_pct || 100 });   // 0.72.0 PL ledger
  leaseTouch(promise.client_pubkey, 'jit:settled');   // 0.73.0
  // B-16: payment settled — release the hash→promise binding.
  if (promise && promise._b16_hash) promiseByPaymentHash.delete(promise._b16_hash);
  try { SM.emit('settle', { hash: paymentHashHex }); } catch (_) {}
  // B-11: settle every EXTRA registered shard with the same preimage (shards
  // share the payment_hash) via the deferred write; the request's own circuit
  // key settles through the original return below. Single-HTLC flows have no
  // shard set -- unchanged.
  if (promise._shards && promise._shards.size) {
    const ckR = req.incoming_circuit_key || {};
    const reqKey = `${ckR.chan_id || '0'}:${ckR.htlc_id || '0'}`;
    let extra = 0;
    if (htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite) {
      for (const [key, sh] of promise._shards) {
        if (key === reqKey) continue;
        htlcInterceptor.getCounters()._lastWrite({
          incoming_circuit_key: sh.incoming_circuit_key,
          action: 'SETTLE',
          preimage: htlcAttempt.preimage,
        });
        extra += 1;
      }
    }
    console.log(`[LSPS2] B-11 settled ${extra} extra shard(s) + the completing HTLC`);
    promise._shards = null; promise._shard_sum_msat = 0n; promise._agg_deadline = 0; promise._agg_completed = false; /* F2 v0.37.0 */
  }

  // Promise consumed.
  pendingJitBuys.delete(scidHex);

  return {
    incoming_circuit_key: req.incoming_circuit_key,
    action: 'SETTLE',
    preimage: htlcAttempt.preimage,
  };
}

// v0.18: locate the SCID of a newly-opened channel by funding outpoint.
// For zero-conf channels, prefer alias_scids[0] over the placeholder
// confirmed_scid. Uses /v1/listchannels REST endpoint.
async function findChannelScid(peerPubkeyHex, channelPoint) {
  // The channel point's funding txid is in funding_txid_bytes (32-byte
  // buffer). For comparison with REST's hex-string-flipped txid format,
  // we need to reverse the bytes (LND wire format vs RPC display format).
  const txidBytes = channelPoint.funding_txid_bytes;
  if (!txidBytes || txidBytes.length !== 32) {
    throw new Error('channelPoint missing funding_txid_bytes');
  }
  // Reverse for display format (matches /v1/channels response).
  const txidHex = Buffer.from(txidBytes).reverse().toString('hex');
  const fundingOutpoint = `${txidHex}:${channelPoint.output_index}`;

  // Query the chain bridge's REST helper not directly accessible — instead
  // hit the LND REST endpoint with the same macaroon.
  const https = require('https');

  // F4b: a freshly-opened zero-conf channel may not have its alias_scids
  // populated in /v1/channels for a few hundred ms after openChannelSync returns
  // (caused "new channel has no usable SCID yet -- FAIL"). Retry the lookup until
  // a usable SCID appears or the budget is spent (~3s default, well within the
  // HTLC CLTV safety margin already checked before the open).
  // B-6: the replay path races the wallet's just-completed re-establishment;
  // 3s loses that race (M3b: open succeeded, alias never seen, clean FAIL,
  // orphan channel). 60 x 500ms = up to 30s of patience, still far inside
  // the 3-minute hold watchdog that bounds total exposure.
  const scidAttempts = (CONFIG.lsps2 && CONFIG.lsps2.scid_lookup_attempts) || 60;
  const scidDelayMs  = (CONFIG.lsps2 && CONFIG.lsps2.scid_lookup_delay_ms) || 500;

  const queryChannels = () => new Promise((resolve, reject) => {
    const opts = {
      hostname: CONFIG.lnd.rest_hostname || 'localhost',
      port:     CONFIG.lnd.rest_port || 8080,
      path:     `/v1/channels`,
      method:   'GET',
      rejectUnauthorized: false,
      headers:  { 'Grpc-Metadata-macaroon': CONFIG.lnd.macaroon },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body).channels || []); }
          catch (e) { reject(new Error(`parse: ${body.slice(0,200)}`)); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });

  for (let attempt = 0; attempt < scidAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, scidDelayMs));
    const channels = await queryChannels();
    for (const ch of channels) {
      if (ch.channel_point === fundingOutpoint) {
        // For zero-conf channels, prefer alias_scids[0] (the alias LND assigned).
        if (Array.isArray(ch.alias_scids) && ch.alias_scids.length > 0) {
          if (attempt > 0) console.log(`[LSPS2] findChannelScid: alias ready after ${attempt} retr${attempt === 1 ? 'y' : 'ies'} (~${attempt * scidDelayMs}ms)`);
          return String(ch.alias_scids[0]);
        }
        if (ch.chan_id && ch.chan_id !== '0') return String(ch.chan_id);
        // matched the channel but no usable SCID yet -- fall through and retry
      }
    }
  }
  console.warn(`[LSPS2] findChannelScid: no usable SCID for ${fundingOutpoint} after ${scidAttempts} attempts (~${scidAttempts * scidDelayMs}ms)`);
  return null;
}

// F4: refresh the realChannelScids cache from LND ListChannels. Collects every
// channel's chan_id, all alias_scids, and peer_scid_alias as decimal strings.
// Reuses findChannelScid's exact REST pattern (same host/port/macaroon/TLS). On
// success, atomically swaps in the new Set. On failure, keeps the last good Set
// (never resets to null after a successful load), so a transient LND blip cannot
// flip the handler into wrongly FAILing legitimate forwards.
async function refreshRealChannelScids() {
  const https = require('https');
  try {
    const channels = await new Promise((resolve, reject) => {
      const opts = {
        hostname: CONFIG.lnd.rest_hostname || 'localhost',
        port:     CONFIG.lnd.rest_port || 8080,
        path:     `/v1/channels`,
        method:   'GET',
        rejectUnauthorized: false,
        headers:  { 'Grpc-Metadata-macaroon': CONFIG.lnd.macaroon },
      };
      const req = https.request(opts, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(body).channels || []); }
            catch (e) { reject(new Error(`parse: ${body.slice(0,200)}`)); }
          } else reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    const next = new Set();
    for (const ch of channels) {
      if (ch.chan_id && ch.chan_id !== '0') next.add(String(ch.chan_id));
      if (Array.isArray(ch.alias_scids)) {
        for (const a of ch.alias_scids) if (a && a !== '0') next.add(String(a));
      }
      if (ch.peer_scid_alias && ch.peer_scid_alias !== '0') next.add(String(ch.peer_scid_alias));
    }
    realChannelScids = next;
  } catch (e) {
    console.warn(`[LSPS2] F4: refreshRealChannelScids failed: ${e.message} (keeping ${realChannelScids === null ? 'null/cold' : realChannelScids.size + ' cached'})`);
  }
}

// v0.18: process held HTLCs for a wallet that just came online. Iterates
// pendingHtlcsForOfflineWallets, runs the standard openChannel+forward
// flow for each match.
async function processPendingHtlcsForPubkey(pubkeyHex) {
  // D-1 2c replay gate: registry "online" (HTTP re-register) can precede the
  // wallet's Lightning P2P link to LND coming back. Replaying before the peer
  // is live drives openChannelAndForward into a ghost-peer FAIL (EXPIRY_TOO_SOON
  // stream crash). Hold until the peer is authoritatively connected; the 5s
  // poll retries next tick. Ample CLTV margin (~94 blocks) covers the wait.
  if (!(await isPeerConnected(pubkeyHex))) {
    // v0.34.0: speak only for the interesting shape (registry says online,
    // peer dead) — the every-5s genuinely-offline poll stays silent.
    if (isWalletOnline(pubkeyHex)) console.log(`[LSPS2] held HTLC for ${pubkeyHex.slice(0,16)}… — registered but peer not live yet, waiting`);
    return;
  }
  // v0.54.1 (d): a connected socket is NOT an awake wallet. A backgrounded
  // phone keeps the WebSocket open for a minute or two while the wallet
  // inside is frozen and cannot co-sign a channel open (2026-08-16). Only
  // proceed when the wallet has made a pubkey-bearing HTTP request within
  // the activity window; the wake push is already out and foregrounding
  // produces that request (pending poll / prefs / register_secret).
  if (!walletRecentlyActive(pubkeyHex)) {
    if (isWalletOnline(pubkeyHex)) console.log(`[LSPS2] held HTLC for ${pubkeyHex.slice(0,16)}… — socket alive but no wallet activity in ${Math.round(ACTIVE_WINDOW_MS/1000)}s (last: ${(walletLastActiveMs.get(pubkeyHex)? Math.round((Date.now()-walletLastActiveMs.get(pubkeyHex))/1000)+'s ago':'never')}) — waiting for the wallet to prove it is awake`);
    return;
  }
  try { SM.emit('replay_started', { pubkey: pubkeyHex }); } catch (_) {}
  for (const [paymentHashHex, held] of pendingHtlcsForOfflineWallets) {
    if (held.client_pubkey.toLowerCase() !== pubkeyHex.toLowerCase()) continue;
    // B-1v2: forward-kind holds (existing channel, peer was offline) replay
    // by simply RESUMEing -- LND forwards over the now-live channel. Requires
    // the CHANNEL active, not just the peer; if not yet, skip this tick
    // (5s poll retries; the watchdog still bounds the wait).
    if (held.kind === 'forward') {
      // B-10: if the invoice secret is registered, settle via TRAMPOLINE --
      // the adapter pays the recipient directly with the same payment_hash
      // and settles the inbound with the preimage (write queues if the
      // sender is offline). No secret -> legacy grace+RESUME below.
      const invSec = invoiceSecretsByHash.get(paymentHashHex);
      // B-18: the trampoline settles ONE payment in full; a multi-shard held
      // set must RESUME its shards instead (a partial trampoline pays a
      // fraction the recipient can never claim — M3a2 specimen).
      if (invSec && (!held.entries || held.entries.length === 1)) {
        try {
          const done = await trampolineForwardHeld(held, paymentHashHex, invSec);
          if (done) {
            pendingHtlcsForOfflineWallets.delete(paymentHashHex);
            cancelHtlcWatchdog(paymentHashHex);
            continue;
          }
          console.warn(`[B-10] trampoline did not complete for ${paymentHashHex.slice(0,16)}... -- falling back to RESUME path`);
        } catch (e) {
          console.error(`[B-10] trampoline error for ${paymentHashHex.slice(0,16)}...: ${e.message} -- falling back to RESUME path`);
        }
      }
      try {
        const chans = await lndGet('/v1/channels').catch(() => null);
        const scidDec = BigInt('0x' + held.outgoing_scid_hex).toString();
        // B-3: held entries store the onion scid, which may be the ALIAS.
        const c = chans && (chans.channels || []).find(ch => (String(ch.chan_id) === scidDec || (ch.alias_scids || []).map(String).includes(scidDec)) && ch.active);
        if (!c) { console.log(`[B-1] ${paymentHashHex.slice(0,16)}... peer live but channel not active yet -- waiting`); continue; }
        // B-9: active != forwardable. The alias needs a beat to register in
        // the switch's forwarding index after re-establish; RESUMEing on the
        // first sighting made non-strict forwarding see only the small
        // confirmed-scid channels (M4: 32/1 sat vs a 501-sat HTLC). Mark the
        // first active sighting and RESUME on a later tick.
        if (!held._activeSince) {
          held._activeSince = Date.now();
          console.log(`[B-9] ${paymentHashHex.slice(0,16)}... channel active -- grace before RESUME (forwarding index settling)`);
          continue;
        }
        if (Date.now() - held._activeSince < 4000) { continue; }
        if (htlcInterceptor && htlcInterceptor.getCounters && htlcInterceptor.getCounters()._lastWrite) {
          const _rsList = held.entries || [ { incoming_circuit_key: held.incoming_circuit_key } ];
          console.log(`[B-1] channel back -- RESUME ${_rsList.length} held forward shard(s) ${paymentHashHex.slice(0,16)}...`);
          try { SM.emit('resumed', { hash: paymentHashHex }); } catch (_) {}
          for (const _en of _rsList) {
            htlcInterceptor.getCounters()._lastWrite({
              incoming_circuit_key: _en.incoming_circuit_key,
              action: 'RESUME',
            });
          }
        }
        pendingHtlcsForOfflineWallets.delete(paymentHashHex);
        cancelHtlcWatchdog(paymentHashHex);
      } catch (e) {
        console.error(`[B-1] forward replay failed for ${paymentHashHex.slice(0,16)}...: ${e.message}`);
      }
      continue;
    }
    const promise = pendingJitBuys.get(held.promise_ref);
    if (!promise) {
      console.warn(`[LSPS2] reconnect-process: promise gone for held HTLC ${paymentHashHex.slice(0,16)}… — FAIL`);
      if (htlcInterceptor && htlcInterceptor.getCounters()._lastWrite) {
        const _pgList = held.entries || [ { incoming_circuit_key: held.incoming_circuit_key } ];
        for (const _en of _pgList) {
          htlcInterceptor.getCounters()._lastWrite({
            incoming_circuit_key: _en.incoming_circuit_key,
            action: 'FAIL',
            failure_code: 15,  // B-14: TEMPORARY_CHANNEL_FAILURE — LND rejects 16 the same way (see the 833 comment); latent crasher on the held-forward fail path
          });
        }
      }
      pendingHtlcsForOfflineWallets.delete(paymentHashHex);
      cancelHtlcWatchdog(paymentHashHex);
      resolvedHtlcHashes.add(paymentHashHex);  /* v0.54.1 (b) */
      offlineHtlcsFailed += 1;
      continue;
    }
    if (inFlightOpens.has(held.promise_ref)) continue;
    inFlightOpens.add(held.promise_ref);  /* v0.54.1 (c): guard set BEFORE the open — the replay is now the ONLY opener, and two ticks can never double-open */

    const _jitEntries = held.entries || [ {
      incoming_circuit_key: held.incoming_circuit_key,
      outgoing_amount_msat: held.outgoing_amount_msat,
      incoming_amount_msat: held.incoming_amount_msat,
      outgoing_expiry: held.outgoing_expiry,
    } ];
    console.log(`[LSPS2] wallet ${pubkeyHex.slice(0,16)}… back online — processing held HTLC ${paymentHashHex.slice(0,16)}… (${_jitEntries.length} shard(s))`);
    inFlightOpens.add(held.promise_ref);
    // B-18: rebuild the aggregate so B-15's forward (Σ − fee) and the
    // settle-all path cover EVERY shard, exactly as on the live path.
    if (!promise._shards) { promise._shards = new Map(); promise._shard_sum_msat = 0n; }
    for (const _en of _jitEntries) {
      const _ck = _en.incoming_circuit_key || {};
      const _key = `${_ck.chan_id || '0'}:${_ck.htlc_id || '0'}`;
      if (!promise._shards.has(_key)) {
        promise._shards.set(_key, { incoming_circuit_key: _en.incoming_circuit_key, msat: BigInt(_en.outgoing_amount_msat || '0') });
        promise._shard_sum_msat += BigInt(_en.outgoing_amount_msat || '0');
      }
    }
    // v0.25.0 (S30): variable promises recompute size/fee from the
    // REBUILT sum — held-time values may predate sibling shards that
    // joined the hold during the offline window. Fixed promises keep
    // their quoted values untouched. Belt: a rebuilt gross at or under
    // the floor can never fund net>0 — FAIL the set instead.
    if (promise.mode === 'variable' && promise._shard_sum_msat > 0n) {
      const _vsum = promise._shard_sum_msat;
      const _vfee = channelOpenFeeMsat(_vsum, promise.client_pubkey, parseInt(promise.scarcity_mult_pct, 10) || 100);   // 0.69.0: the one law
      if (_vsum <= _vfee) {
        console.warn(`[LSPS2] v0.25 replay: rebuilt gross ${_vsum} msat <= fee ${_vfee} — FAILing ${_jitEntries.length} held part(s)`);
        if (htlcInterceptor && htlcInterceptor.getCounters()._lastWrite) {
          for (const _fe of _jitEntries) {
            htlcInterceptor.getCounters()._lastWrite({ incoming_circuit_key: _fe.incoming_circuit_key, action: 'FAIL', failure_code: 15 });
          }
        }
        pendingHtlcsForOfflineWallets.delete(paymentHashHex);
        cancelHtlcWatchdog(paymentHashHex);
        inFlightOpens.delete(held.promise_ref);
        resolvedHtlcHashes.add(paymentHashHex);  /* v0.54.1 (b) */
        offlineHtlcsFailed += _jitEntries.length;
        continue;
      }
      const _vceil = BigInt(CONFIG.lsps2.variable_ceiling_msat);
      promise.payment_size_msat = (_vsum > _vceil ? _vceil : _vsum).toString();
      promise.fee_msat = _vfee.toString();
    }
    const _last = _jitEntries[_jitEntries.length - 1];
    // Synthesize a request-like object for openChannelAndForward.
    const syntheticReq = {
      incoming_circuit_key: _last.incoming_circuit_key,
      outgoing_amount_msat: _last.outgoing_amount_msat,
      incoming_amount_msat: _last.incoming_amount_msat,
      outgoing_expiry: _last.outgoing_expiry,
      auto_fail_height: held.auto_fail_height,
      payment_hash: Buffer.from(paymentHashHex, 'hex'),
      custom_records: held.custom_records,
    };
    openChannelAndForward(syntheticReq, promise, held.promise_ref, paymentHashHex)
      .then((resp) => {
        inFlightOpens.delete(held.promise_ref);
        // v0.54.1 (a): openChannelAndForward returning null means HOLD —
        // the open failed and B-13 re-parked the payment. The held record
        // and its refund timer MUST survive; only a resolution actually
        // WRITTEN to LND may clear them. This is the 2026-08-16 root cause.
        if (!resp) {
          console.warn(`[LSPS2] replay: open returned HOLD/no-result for ${paymentHashHex.slice(0,16)}… — held payment and refund timer stay in place`);
          return;
        }
        if (resp && htlcInterceptor && htlcInterceptor.getCounters()._lastWrite) {
          htlcInterceptor.getCounters()._lastWrite(resp);
          resolvedHtlcHashes.add(paymentHashHex);  /* v0.54.1 (b) */
          if (resp.action === 'SETTLE') offlineHtlcsSettled += 1;
          else offlineHtlcsFailed += 1;
          // v0.25.0 (S30): a failed multi-entry held set must FAIL every
          // sibling circuit key, not just the synthetic's — otherwise the
          // rest dangle at LND until CLTV.
          if (resp.action === 'FAIL' && _jitEntries.length > 1) {
            const _lck = _last.incoming_circuit_key || {};
            const _lkey = `${_lck.chan_id || '0'}:${_lck.htlc_id || '0'}`;
            let _fanned = 0;
            for (const _fe of _jitEntries) {
              const _fck = _fe.incoming_circuit_key || {};
              if (`${_fck.chan_id || '0'}:${_fck.htlc_id || '0'}` === _lkey) continue;
              htlcInterceptor.getCounters()._lastWrite({ incoming_circuit_key: _fe.incoming_circuit_key, action: 'FAIL', failure_code: 15 });
              _fanned += 1;
            }
            if (_fanned) console.warn(`[LSPS2] v0.25 replay FAIL fanned to ${_fanned} sibling shard(s) for ${paymentHashHex.slice(0,16)}…`);
          }
        }
        pendingHtlcsForOfflineWallets.delete(paymentHashHex);
        cancelHtlcWatchdog(paymentHashHex);
      })
      .catch((e) => {
        inFlightOpens.delete(held.promise_ref);
        console.error(`[LSPS2] held-HTLC processing failed for ${paymentHashHex.slice(0,16)}…: ${e.message}`);
        // Leave HTLC in held-state for watchdog to FAIL on expiry.
      });
  }
}

// v0.18: poll the chain-bridge registry every CONFIG.lsps2.reconnect_poll_secs.
// For each pending offline HTLC, check if its wallet is now online; if so,
// trigger the open+forward flow.
function reconnectPollTick() {
  stampLoop('reconnect_poll', (CONFIG.lsps2.reconnect_poll_secs || 30) * 1000);
  // F4: keep the real-channel SCID cache warm every tick (fire-and-forget),
  // independent of whether there are offline HTLCs to process.
  refreshRealChannelScids();
  // v0.28.0 (S30): the LNURLp sweep lives ABOVE the early return — the
  // v0.26 placement at the bottom sat behind
  // `pendingHtlcsForOfflineWallets.size === 0 return` and never executed
  // once (field: watchers resumed, wallet online, zero attempts).
  for (const [lnName, lnRec] of Object.entries(lnurlpRegistry)) {
    // v0.34.0: no registry pre-filter — the deliverer gates on peer truth.
    for (const lnEntry of (lnRec.entries || [])) {
      if (lnEntry.status === 'accepted') {
        lnurlpDeliver(lnName, lnEntry).catch((e) =>
          console.error(`[LNURLP] sweep deliver error: ${e.message}`));
      }
    }
  }
  if (pendingHtlcsForOfflineWallets.size === 0) return;
  // De-duplicate pubkeys among pending HTLCs (one wallet may have multiple).
  const pubkeys = new Set();
  for (const [, held] of pendingHtlcsForOfflineWallets) {
    pubkeys.add(held.client_pubkey.toLowerCase());
  }
  for (const pubkey of pubkeys) {
    // v0.34.0 (S30): no registry gate — the callee checks LND peer truth
    // (the oracle the HOLD used) and stays silent while genuinely offline.
    processPendingHtlcsForPubkey(pubkey).catch((e) =>
      console.error(`[LSPS2] reconnect-poll processPendingHtlcsForPubkey error: ${e.message}`));
  }
  // v0.34.0 (S30): the v0.26 bottom sweep removed — redundant since v0.28
  // moved the sweep above the early return; one sweep, one gate, one oracle.
}

// ── Channel Size Validator ────────────────────────────────────────────────────

function validateChannelSize(requested_sats) {
  const size = requested_sats || CONFIG.channel.size_sats;
  if (size < CONFIG.channel.min_sats) {
    throw new Error(
      `Channel too small: ${size} sats (minimum ${CONFIG.channel.min_sats})`
    );
  }
  if (size > CONFIG.channel.max_sats) {
    throw new Error(
      `Channel too large: ${size} sats (maximum ${CONFIG.channel.max_sats})`
    );
  }
  return size;
}

// ── LND Client (native https) ─────────────────────────────────────────────────

const lndUrl = new url.URL(CONFIG.lnd.endpoint);

function lndRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname:           lndUrl.hostname,
      port:               lndUrl.port || 8080,
      path,
      method,
      rejectUnauthorized: false, // LND self-signed cert — safe on localhost
      headers: {
        'Grpc-Metadata-macaroon': CONFIG.lnd.macaroon,
        'Content-Type':           'application/json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data}`)); }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const lndGet  = path         => lndRequest('GET',  path, null);
const lndPost = (path, body) => lndRequest('POST', path, body);

// v0.12: look up a public channel's policy for the direction outbound FROM us.
// Used by POST /v1/route/build to tell the wallet what fee/cltv WE will charge
// on our first outgoing hop (the LSP self-hop), since the wallet's local view
// of our policy (LDK ChannelDetails.counterparty.forwarding_info) describes
// the OPPOSITE direction (counterparty→wallet, not wallet→peer-via-us).
// Returns null on any lookup failure; caller decides how to handle.
// 0.66.0 (S43, DP): CHANNEL FEE POLICY.
// LSP-1 kept showing LND's config default (base 2000 msat) on freshly opened
// wallet channels because the open never said what the policy should be. Now
// (1) every open carries it (LND OpenChannelRequest fields 21–24, lnd ≥ 0.16;
// older LND ignores unknown fields, no harm), and (2) enforceChannelPolicy
// corrects channels opened before 0.66.0: PRIVATE channels only, never the
// world peer, only when the live policy differs, one UpdateChannelPolicy per
// channel (in both boxes' macaroons). Runs 30 s after boot and hourly. The
// world/exchange channels are never read or written here.
function openPolicyFields() {
  return {
    base_fee: CONFIG.chan_policy.base_fee_msat,
    fee_rate: CONFIG.chan_policy.fee_ppm,
    use_base_fee: true,
    use_fee_rate: true,
  };
}
async function enforceChannelPolicy(reason) {
  if (!CONFIG.chan_policy.enforce || !LOCAL_PUBKEY) return;
  const want = CONFIG.chan_policy;
  let chans;
  try { chans = await lndGet('/v1/channels'); } catch (e) { console.warn(`[POLICY] listchannels failed: ${e.message}`); return; }
  let checked = 0, fixed = 0;
  for (const c of (chans.channels || [])) {
    if (!c.private || (LEASE_WORLD_PEER && c.remote_pubkey === LEASE_WORLD_PEER)) continue;
    const edge = await lndGet(`/v1/graph/edge/${c.chan_id}`).catch(() => null);   // quiet: a zero-conf channel has no edge until it confirms
    if (!edge) continue;
    const mine = edge.node1_pub === LOCAL_PUBKEY ? edge.node1_policy : (edge.node2_pub === LOCAL_PUBKEY ? edge.node2_policy : null);
    if (!mine) continue;
    checked++;
    const base = Number(mine.fee_base_msat), ppm = Number(mine.fee_rate_milli_msat);
    if (base === want.base_fee_msat && ppm === want.fee_ppm) continue;
    const [txid, idx] = String(c.channel_point).split(':');
    try {
      await lndPost('/v1/chanpolicy', {
        chan_point: { funding_txid_str: txid, output_index: Number(idx) },
        base_fee_msat: String(want.base_fee_msat),
        fee_rate_ppm: want.fee_ppm,
        time_lock_delta: Number(mine.time_lock_delta) || 80,
      });
      fixed++;
      console.log(`[POLICY] ${c.remote_pubkey.slice(0,16)}… chan ${c.chan_id}: base ${base}→${want.base_fee_msat} msat, ppm ${ppm}→${want.fee_ppm} (${reason})`);
    } catch (e) {
      console.warn(`[POLICY] chan ${c.chan_id}: update failed: ${e.message}`);
    }
  }
  console.log(`[POLICY] sweep (${reason}): ${checked} wallet channel(s) read, ${fixed} corrected — want base ${want.base_fee_msat} msat / ${want.fee_ppm} ppm`);
}

async function lookupChannelPolicy(chanId) {
  if (!LOCAL_PUBKEY) {
    console.warn('[v0.12] lookupChannelPolicy called before LOCAL_PUBKEY cached');
    return null;
  }
  try {
    const edge = await lndGet(`/v1/graph/edge/${chanId}`);
    if (!edge || !edge.node1_pub || !edge.node2_pub) {
      console.warn(`[v0.12] graph/edge/${chanId}: missing node pubs in response`);
      return null;
    }
    let policy;
    if      (edge.node1_pub === LOCAL_PUBKEY) policy = edge.node1_policy;
    else if (edge.node2_pub === LOCAL_PUBKEY) policy = edge.node2_policy;
    else {
      console.warn(`[v0.12] chan ${chanId}: LOCAL_PUBKEY ${LOCAL_PUBKEY.slice(0,16)}... is neither endpoint`);
      return null;
    }
    if (!policy) {
      console.warn(`[v0.12] chan ${chanId}: outbound-from-us policy is null (channel disabled or stale?)`);
      return null;
    }
    // LND calls the ppm field fee_rate_milli_msat; BOLT 7 calls it
    // fee_proportional_millionths. Same semantic (fee in millionths per msat).
    return {
      fee_base_msat:               policy.fee_base_msat,
      fee_proportional_millionths: parseInt(policy.fee_rate_milli_msat || '0', 10),
      cltv_expiry_delta:           parseInt(policy.time_lock_delta || '0', 10),
    };
  } catch (e) {
    console.warn(`[v0.12] lookupChannelPolicy(${chanId}) failed: ${e.message}`);
    return null;
  }
}

// ── LSP Operations ────────────────────────────────────────────────────────────

// ── B-2: scid-alias dialect rewrite ─────────────────────────────────────────
// For private channels that negotiated option_scid_alias, LND's switch
// indexes the link under the ALIAS and refuses the real scid in onions (the
// privacy feature working as designed). External senders use the alias from
// the invoice hint and forward fine; our route answers carried the REAL scid
// and died with UnknownNextPeer. Rewrite any hop whose chan_id matches one of
// OUR channels carrying alias_scids to that alias -- the dialect the invoice
// speaks. Other nodes' hops are never in the map, so they pass untouched.
async function rewriteHopsToAliases(routes) {
  try {
    const data = await lndGet('/v1/channels');
    const aliasByReal = new Map();
    for (const ch of (data.channels || [])) {
      if (ch.alias_scids && ch.alias_scids.length > 0 && ch.chan_id) {
        aliasByReal.set(String(ch.chan_id), String(ch.alias_scids[0]));
      }
    }
    if (!aliasByReal.size) return routes;
    for (const r of (routes || [])) {
      for (const h of (r.hops || [])) {
        const alias = aliasByReal.get(String(h.chan_id));
        if (alias) {
          console.log(`[B-2] hop scid rewrite: ${h.chan_id} -> alias ${alias}`);
          h.chan_id = alias;
        }
      }
    }
  } catch (e) {
    console.warn(`[B-2] alias rewrite skipped: ${e.message}`);
  }
  return routes;
}

// ── B-1v2: same-LSP offline route synthesis ─────────────────────────────────
// LND's QueryRoutes prunes inactive channels and knows nothing of JIT promise
// SCIDs, so a LiJ sender paying a same-LSP recipient who is offline (or not
// yet channeled) gets "no routes" even though WE know the hop. When LND cannot
// answer, synthesize the one-hop LSP-as-source route ourselves. Fires ONLY on
// LND failure/empty; every working path is untouched. The handler's B-2 alias
// rewrite runs downstream and dialect-corrects these hops like any others.
// GUARD (B-1 lesson): if the wallet sent ignored_pairs it is routing around a
// bounce -- never re-offer the hop it just excluded.
async function routeBuildWithSynthesis(destination, amountSat, lndBody, routeHints) {
  // B-17v2 (hop pinning, hoisted): run a66fcc00 proved the escaping shard's
  // real route came from LND's OWN pathfinder — v1's pin sat below this
  // early return and never ran. A request whose hint scid is a live JIT
  // promise for this destination is paying a JIT invoice; it never consults
  // the pathfinder and falls straight to promise synthesis, so every shard
  // rides the alias into one aggregate by construction.
  let pinnedToPromise = false;
  let hintScidHexSeen = null;  /* v0.55.0 A1 */
  try {
    const hhScid = routeHints && routeHints[0] && routeHints[0].hop_hints
      && routeHints[0].hop_hints[0] && routeHints[0].hop_hints[0].chan_id;
    if (hhScid != null) {
      const hintHex = BigInt(String(hhScid)).toString(16).padStart(16, '0');
      hintScidHexSeen = hintHex;  /* v0.55.0 A1 */
      const hp = pendingJitBuys.get(hintHex);
      if (hp && hp.client_pubkey === destination && Date.now() <= hp.reservation_expires_at) {
        pinnedToPromise = true;
        console.log(`[SYNTH] B-17v2 hint scid=${hintHex} is a live JIT promise — pinning to the alias (pathfinder skipped)`);
      } else {
        // B-19: the pin declined silently at 16:09:34 (specimen 3d832527);
        // it now states its reasons.
        console.log(`[SYNTH] B-19 pin-miss: hint scid=${hintHex} not pinned (promise=${hp ? 'found' : 'absent'}${hp ? `, client_match=${hp.client_pubkey === destination}, unexpired=${Date.now() <= hp.reservation_expires_at}` : ''})`);
      }
    }
  } catch (e) {}
  let lndResp = null, lndErr = null;
  if (!pinnedToPromise) {
    try {
      lndResp = await lndPost(`/v1/graph/routes/${destination}/${amountSat}`, lndBody);
    } catch (e) { lndErr = e; }
    if (lndResp && Array.isArray(lndResp.routes) && lndResp.routes.length > 0) {
      return lndResp;  // LND answered -- normal path, nothing synthesized.
    }
  }

  if (lndBody && Array.isArray(lndBody.ignored_pairs) && lndBody.ignored_pairs.length > 0) {
    console.log(`[SYNTH] skipping synthesis: wallet excluded ${lndBody.ignored_pairs.length} pair(s) (routing around a bounce)`);
    if (lndErr) throw lndErr;
    return lndResp || { routes: [] };
  }

  let hintDelta = 0;
  try {
    const hh = routeHints && routeHints[0] && routeHints[0].hop_hints && routeHints[0].hop_hints[0];
    if (hh && hh.cltv_expiry_delta) hintDelta = parseInt(hh.cltv_expiry_delta, 10) || 0;
  } catch (e) {}

  let chanIdDecimal = null, chanCapacity = null, flavor = null;
  let a1Refused = false;   // v0.56.4 (6e)
  try {
    const data = pinnedToPromise ? null : await lndGet('/v1/channels');
    // B-8: a peer may have SEVERAL channels (JIT churn). Pick the one with
    // the most LSP-side spendable that covers the amount; .find()'s first
    // match was the drained old channel and starved everything behind it.
    const mine = ((data && data.channels) || []).filter(ch => ch.remote_pubkey === destination);
    if (mine.length) {
      const amtN = Number(amountSat) || 0;
      let best = null, bestSpend = -Infinity;
      for (const ch of mine) {
        const sp = Number(ch.local_balance || 0) - Number(ch.local_chan_reserve_sat || 0);
        if (sp > bestSpend) { best = ch; bestSpend = sp; }
      }
      if (best && bestSpend >= amtN) {
        chanIdDecimal = String(best.chan_id); chanCapacity = String(best.capacity || amountSat); flavor = 'channel';
      } else {
        console.log(`[SYNTH] no channel to ${destination.slice(0,16)}... can carry ${amtN} (best spendable ${bestSpend === -Infinity ? 'n/a' : bestSpend} across ${mine.length}) -- trying JIT promise`);
      }
    }
  } catch (e) {}

  if (!chanIdDecimal) {
    const now = Date.now();
    // v0.55.0 A1: HINT-FAITHFUL selection. The old loop took the FIRST live
    // promise for the destination (Map insertion order) and ignored the
    // payer's hint — with two live promises for one wallet, every payment
    // boarded the older rail and met the wrong payment_secret (incident
    // 2026-08-16, five burned opens). Now: a PINNED hint uses ITS OWN scid;
    // a present-but-unmatched hint REFUSES substitution (stale invoice —
    // say so, never misroute); only a hintless request may fall back.
    if (pinnedToPromise && hintScidHexSeen) {
      chanIdDecimal = BigInt('0x' + hintScidHexSeen).toString();
      chanCapacity = String(amountSat);
      flavor = 'jit-pinned';
    } else if (hintScidHexSeen) {
      console.log(`[SYNTH] A1: hint scid=${hintScidHexSeen} is not a live matching promise — REFUSING substitution (stale invoice; payer needs a fresh one). No route synthesized.`);
      a1Refused = true;   // v0.56.4 (6e): label the routeless response below
    } else {
      for (const [scidHex, p] of pendingJitBuys) {
        if (p.client_pubkey === destination && now <= p.reservation_expires_at) {
          chanIdDecimal = BigInt('0x' + scidHex).toString();
          chanCapacity = String(amountSat);
          flavor = 'jit';
          break;
        }
      }
    }
  }

  if (!chanIdDecimal) {
    // v0.56.4 (S36, 6e payer-visible A1 refusal — DP-confirmed, additive on
    // the ALREADY-FAILING path only): when A1 refused substitution, the
    // routeless response carries a structured token so the SENDER's wallet
    // can say why ('stale QR — ask for a fresh one') instead of a generic
    // route failure. A labeled response beats throwing lndErr here — the
    // payment fails either way; only the sentence improves. Every other
    // branch is byte-identical.
    if (a1Refused) {
      const _resp = (lndResp && typeof lndResp === 'object') ? lndResp : { routes: [] };
      if (!Array.isArray(_resp.routes) || _resp.routes.length === 0) {
        _resp.routes = _resp.routes || [];
        _resp.lijox_refusal = { code: 'stale_jit_promise' };
        return _resp;
      }
    }
    if (lndErr) throw lndErr;
    return lndResp || { routes: [] };
  }

  const info = await lndGet('/v1/getinfo').catch(() => null);
  const tip = (info && info.block_height) || 0;
  if (!tip) {
    if (lndErr) throw lndErr;
    return lndResp || { routes: [] };
  }

  const finalDelta = Math.max(hintDelta, 80);
  const expiry = tip + finalDelta;
  const amtMsat = String(amountSat * 1000);
  console.log(`[SYNTH] no LND route to ${destination.slice(0,16)}... -- synthesizing one-hop (${flavor}) chan_id=${chanIdDecimal} expiry=${expiry} (tip=${tip}, delta=${finalDelta})`);
  return {
    routes: [{
      total_time_lock: expiry,
      total_fees: '0',
      total_amt: String(amountSat),
      total_fees_msat: '0',
      total_amt_msat: amtMsat,
      hops: [{
        chan_id: chanIdDecimal,
        chan_capacity: chanCapacity,
        amt_to_forward: String(amountSat),
        fee: '0',
        expiry: expiry,
        amt_to_forward_msat: amtMsat,
        fee_msat: '0',
        pub_key: destination,
        tlv_payload: true,
      }],
    }],
    _synth: flavor,
  };
}

// ── B-10: trampoline settle for held forwards ───────────────────────────────
// Mirrors the JIT forward core: one-hop route over the held channel's scid
// (the onion's alias -- what the recipient link speaks), SendToRouteV2 with
// the SAME payment_hash, and on preimage settle the inbound via the deferred
// interceptor write. Returns true on settle.
async function trampolineForwardHeld(held, paymentHashHex, invSec) {
  const scidDec = BigInt('0x' + held.outgoing_scid_hex).toString();
  const info = await lndGet('/v1/getinfo').catch(() => null);
  const tip = (info && info.block_height) || 0;
  if (!tip) { console.warn('[B-10] no live tip -- skip trampoline this tick'); return false; }
  const amtMsat = String(held.outgoing_amount_msat);
  const expiry = tip + 80;
  const route = {
    total_time_lock: expiry,
    total_amt_msat: amtMsat,
    hops: [{
      chan_id: scidDec,
      expiry: expiry,
      amt_to_forward_msat: amtMsat,
      fee_msat: '0',
      pub_key: held.client_pubkey,
      tlv_payload: true,
      mpp_record: {
        payment_addr: Buffer.from(invSec.payment_secret, 'hex').toString('base64'),
        total_amt_msat: amtMsat,
      },
    }],
  };
  const paymentHash = Buffer.from(paymentHashHex, 'hex');
  console.log(`[B-10] trampoline: forwarding ${amtMsat}msat to ${held.client_pubkey.slice(0,16)}... via scid=${scidDec} (held forward)`);
  let htlcAttempt;
  try {
    htlcAttempt = await sendToRouteV2Hard(routerClient, paymentHash, route, CONFIG.lsps2.sendtoroute_timeout_ms, 'jit-or-trampoline');  /* F3 v0.37.0 */
  } catch (e) {
    console.error(`[B-10] sendToRouteV2 rejected: ${e.message}`);
    return false;
  }
  if (!htlcAttempt || htlcAttempt.status !== 'SUCCEEDED') {
    const failCode = htlcAttempt && htlcAttempt.failure ? htlcAttempt.failure.code : 'unknown';
    console.error(`[B-10] trampoline did not succeed: status=${htlcAttempt ? htlcAttempt.status : 'none'} failure_code=${failCode}`);
    /* v0.55.0 A2 (trampoline site): same final-node latch. */
    try {
      if (['INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS','FINAL_INCORRECT_CLTV_EXPIRY','FINAL_INCORRECT_HTLC_AMOUNT'].includes(String(failCode))) {
        resolvedHtlcHashes.add(paymentHashHex);
        console.error(`[B-10] A2: FINAL-NODE VERDICT ${failCode} — hash latched; further shards will be failed back`);
      }
    } catch (_) {}
    return false;
  }
  // v0.54.1 (e): the outbound is PAID — the inbound settle is now a debt
  // the LSP is owed. It must be written no matter what; _lastWrite (v0.54.1
  // (f)) delivers to the live interceptor stream or queues until it is
  // back. Declaring success without this write is how the LSP pays out
  // and never collects (suspected in early testing per DP, 2026-08-16).
  console.log(`[B-10] preimage received -- SETTLING inbound for ${paymentHashHex.slice(0,16)}... (delivery guaranteed: live stream or queue)`);
  htlcInterceptor.getCounters()._lastWrite({
    incoming_circuit_key: held.incoming_circuit_key,
    action: 'SETTLE',
    preimage: htlcAttempt.preimage,
  });
  resolvedHtlcHashes.add(paymentHashHex);
  return true;
}

async function connectPeer(pubkey, host) {
  console.log(`[LSP] Connecting to peer ${pubkey}@${host}`);
  const result = await lndPost('/v1/peers', {
    addr: { pubkey, host },
    perm: false,
  });
  if (result.message && !result.message.includes('already')) {
    throw new Error(`Peer connect failed: ${result.message}`);
  }
  console.log(`[LSP] Peer connected or already connected`);
  return true;
}

async function openChannel(pubkey, size_sats, push_sats) {
  leaseRememberWalletPeer(pubkey);   // 0.72.3
  console.log(`[LSP] Opening channel to ${pubkey} — ${size_sats} sats, pushing ${push_sats}`);
  const result = await lndPost('/v1/channels', {
    node_pubkey_string:   pubkey,
    local_funding_amount: String(size_sats),
    push_sat:             String(push_sats),
    private:              true,
    spend_unconfirmed:    false,
  });
  if (result.code && result.code !== 0) {
    throw new Error(`Channel open failed: ${result.message}`);
  }
  console.log(`[LSP] Channel opening: txid=${result.funding_txid_str}`);
  return result;
}

async function waitForPeer(pubkey, timeoutMs = 30000) {
  console.log(`[LSP] Waiting for peer ${pubkey} to appear (browser-node flow)...`);
  const start = Date.now();
  const pollIntervalMs = 1000;
  while (Date.now() - start < timeoutMs) {
    const data = await lndGet('/v1/peers');
    const peers = data.peers || [];
    if (peers.some(p => p.pub_key === pubkey)) {
      console.log(`[LSP] Peer ${pubkey} confirmed connected`);
      return true;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Peer ${pubkey} did not connect within ${timeoutMs}ms — ensure browser wallet has established WebSocket connection first`);
}
async function hasChannelWith(pubkey) {
  const data = await lndGet('/v1/channels');
  const channels = data.channels || [];
  return channels.some(c => c.remote_pubkey === pubkey);
}

// ── v0.11: Critical-peer keepalive ────────────────────────────────────────────
// UM890's outbound routing depends on staying connected to upstream peers
// (initially Umbrel via hairpin NAT). The Umbrel channel has been observed
// going inactive repeatedly when the peer connection drops — the channel
// itself stays open on-chain but LND marks it inactive and refuses to use it
// for outbound payments. Reconnecting the peer brings the channel active
// within ~10 seconds. This helper runs on a 60s timer and before each
// route-build query, so user-facing latency is bounded.
//
// Hardening backlog (separate work): (a) migrate Umbrel-9735 to Cloudflare
// TCP tunnel so we don't depend on the home router port-forward, (b) prefer
// the Tor onion address that Umbrel actually gossips, (c) systemd timer as a
// belt-and-suspenders fallback if the adapter is restarting.

let lastPeerCheckMs = 0;

async function ensureCriticalPeersConnected(force = false) {
  // Cheap fast-path: don't hammer LND. If we checked < 30s ago and aren't
  // explicitly forcing, skip. The 60s background timer handles the slow path.
  const now = Date.now();
  if (!force && now - lastPeerCheckMs < 30000) {
    return { skipped: true };
  }
  lastPeerCheckMs = now;

  if (CONFIG.critical_peers.length === 0) {
    return { skipped: true, reason: 'no critical peers configured' };
  }

  let peersList;
  try {
    const data = await lndGet('/v1/peers');
    peersList = (data.peers || []).map(p => p.pub_key);
  } catch (e) {
    console.error(`[Keepalive] Failed to list peers: ${e.message}`);
    return { error: e.message };
  }

  const actions = [];
  for (const { pubkey, hostport } of CONFIG.critical_peers) {
    if (peersList.includes(pubkey)) {
      // Already connected — nothing to do.
      continue;
    }
    console.warn(`[Keepalive] Critical peer ${pubkey.slice(0,20)}... not connected; reconnecting to ${hostport}`);
    try {
      // LND's /v1/peers POST takes addr: { pubkey, host } where host is "ip:port".
      const result = await lndPost('/v1/peers', {
        addr: { pubkey, host: hostport },
        perm: true,
      });
      if (result.message && !result.message.includes('already')) {
        console.error(`[Keepalive] Peer reconnect failed for ${pubkey.slice(0,20)}...: ${result.message}`);
        actions.push({ pubkey, ok: false, message: result.message });
      } else {
        console.log(`[Keepalive] Peer ${pubkey.slice(0,20)}... reconnect initiated`);
        actions.push({ pubkey, ok: true });
      }
    } catch (e) {
      console.error(`[Keepalive] Peer reconnect error for ${pubkey.slice(0,20)}...: ${e.message}`);
      actions.push({ pubkey, ok: false, message: e.message });
    }
  }
  return { actions };
}

function startCriticalPeerKeepalive() {
  if (CONFIG.critical_peers.length === 0) {
    console.log('[Keepalive] No critical peers configured — keepalive disabled');
    return;
  }
  const peerSummary = CONFIG.critical_peers
    .map(p => `${p.pubkey.slice(0,16)}...@${p.hostport}`)
    .join(', ');
  console.log(`[Keepalive] Critical peer keepalive started for: ${peerSummary}`);
  console.log('[Keepalive] Check interval: 60s; force-check before each /v1/route/build query');

  // Background timer: every 60 seconds, check & reconnect missing peers.
  setInterval(() => {
    stampLoop('keepalive', 60000);
    ensureCriticalPeersConnected(true).catch(e => {
      console.error(`[Keepalive] Background check failed: ${e.message}`);
    });
  }, 60000);

  // Run once immediately on startup so we don't wait 60s for the first check.
  // Delayed 5s to let LND fully initialize after our own startup.
  setTimeout(() => {
    ensureCriticalPeersConnected(true).catch(() => {});
  }, 5000);
}

// ── WebSocket Proxy ───────────────────────────────────────────────────────────
// Browser-based LiJ nodes cannot make raw TCP connections.
// This proxy accepts WebSocket connections and pipes them to LND's TCP port 9735.
//
// Security: validates Origin header against allowed origins whitelist.
// Only connections from configured origins are accepted.

function startWebSocketProxy() {
  const wss = new WebSocketServer({
    port: CONFIG.adapter.ws_port,
    verifyClient: ({ origin, req }, cb) => {
      // Allow connections with no origin (e.g. direct testing tools)
      // but reject origins that are set and not in the whitelist
      if (origin && !CONFIG.security.ws_allowed_origins.includes(origin)) {
        console.warn(`[Security] WebSocket rejected — unauthorized origin: ${origin}`);
        cb(false, 403, 'Forbidden');
        return;
      }
      cb(true);
    },
  });

  wss.on('connection', (ws, req) => {
    const clientIp = req.headers['cf-connecting-ip'] // Cloudflare real IP
      || req.headers['x-forwarded-for']
      || req.socket.remoteAddress;
    const origin = req.headers.origin || 'unknown';

    console.log(`[WS] Peer connection from ${clientIp} (origin: ${origin})`);

    // Open a raw TCP connection to LND's peer port
    const tcp = net.createConnection({
      host: CONFIG.lnd.peer_host,
      port: CONFIG.lnd.peer_port,
    });

    tcp.on('connect', () => {
      console.log(`[WS] TCP tunnel open to ${CONFIG.lnd.peer_host}:${CONFIG.lnd.peer_port}`);
    });

    // WebSocket → TCP
    ws.on('message', data => {
      if (tcp.writable) {
        tcp.write(typeof data === 'string' ? Buffer.from(data) : data);
      }
    });

    // TCP → WebSocket
    tcp.on('data', data => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    });

    // Teardown
    ws.on('close', () => {
      console.log(`[WS] Peer disconnected: ${clientIp}`);
      tcp.destroy();
    });

    ws.on('error', err => {
      console.error(`[WS] WebSocket error: ${err.message}`);
      tcp.destroy();
    });

    tcp.on('close', () => {
      if (ws.readyState === ws.OPEN) ws.close();
    });

    tcp.on('error', err => {
      console.error(`[WS] TCP error: ${err.message}`);
      if (ws.readyState === ws.OPEN) ws.close();
    });
  });

  wss.on('listening', () => {
    console.log(`[WS] WebSocket proxy listening on port ${CONFIG.adapter.ws_port}`);
    console.log(`[WS] Allowed origins: ${CONFIG.security.ws_allowed_origins.join(', ')}`);
  });

  wss.on('error', err => {
    console.error(`[WS] Server error: ${err.message}`);
  });
}

// ── Registry Registration ─────────────────────────────────────────────────────

function httpsPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(endpoint);
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── 0.58.0 (a): lijox-register:v1 canonical message ─────────────────────────
// The registration record is SIGNED by the node identity key (LND
// signmessage) over every advertised field; the registry worker verifies by
// public-key recovery and refuses anything else. This function is the
// VERBATIM twin of canonicalRegisterMsg in lij-worker/src/index.js — any
// change there changes here in the same release, or registration 403s.
function canonicalRegisterMsg(f) {
  const s = (v) => (v === null || v === undefined) ? '' : String(v);
  const n = (v) => String(Number(v) || 0);
  const fields = [
    s(f.pubkey), n(f.ts), s(f.name), s(f.endpoint), s(f.wss_url),
    s(f.route_endpoint), s(f.route_macaroon),
    n(f.fee_ppm), n(f.fee_base_sats), n(f.channel_open_fee_sats),
    n(f.max_channel_size_sats), (f.supports_jit ? '1' : '0'),
  ];
  return 'lijox-register:v1:' + fields.map(encodeURIComponent).join(':');
}

// 0.71.0: verbatim twin of the worker's canonicalUnregisterMsg (lij-worker/src/index.js).
function canonicalUnregisterMsg(pubkey, ts) {
  return 'lijox-unregister:v1:' + [String(pubkey), String(Number(ts) || 0)].map(encodeURIComponent).join(':');
}
// 0.71.0: registry liveness. The worker marks a record stale after 24h without a
// registration, so we re-register every LIJOX_REGISTER_EVERY_HOURS (6). The
// console reads registryStatus.
const registryStatus = { last_ok: 0, last_error: '', next_ms: 0, every_h: parseFloat(process.env.LIJOX_REGISTER_EVERY_HOURS || '6') };
let registryTimer = null;

// `node lij-adapter.js --unregister`: sign a departure with the node key and POST
// it; the worker deletes the record. Operator's hand only — never on restart.
async function unregisterFromRegistry() {
  if (!CONFIG.registry) { console.log('[Registry] no registry configured — nothing to leave'); return { ok: false, code: 'NO_REGISTRY' }; }
  const ts = Math.floor(Date.now() / 1000);
  const canonical = canonicalUnregisterMsg(CONFIG.node.pubkey, ts);
  const signed = await lndPost('/v1/signmessage', { msg: Buffer.from(canonical, 'utf8').toString('base64') });
  if (!signed || !signed.signature) throw new Error('LND signmessage returned no signature; LND said: ' + JSON.stringify(signed).slice(0, 300));
  const result = await httpsPost(`${CONFIG.registry}/lsps/unregister`, { pubkey: CONFIG.node.pubkey, ts, signature: signed.signature });
  console.log('[Registry] Unregister:', result);
  return result;
}

async function registerWithRegistry() {
  if (!CONFIG.registry) {
    console.log('[Registry] no registry configured — running registry-free (LIJOX registries are optional)');
    return;
  }
  if (!CONFIG.node.pubkey || !CONFIG.node.host) {
    console.warn('[Registry] NODE_PUBKEY or NODE_HOST not set — skipping');
    return;
  }
  console.log(`[Registry] Registering with ${CONFIG.registry}`);
  try {
    // v0.15: register with Cloudflare-fronted URLs and shared macaroon.
    // - endpoint, route_endpoint, wss_url from CONFIG.public so the
    //   worker registry self-asserts the correct HTTPS/WSS hostnames on
    //   every restart. NODE_HOST is the Lightning P2P (TCP-only) tunnel
    //   host and must NOT be used as an HTTP/WSS URL host.
    // - route_macaroon = CONFIG.adapter.secret (i.e. ADAPTER_SECRET env
    //   var) so wallets reading the registry record receive the auth
    //   token they need to call /v1/route/build. Without this, the
    //   wallet sends no usable auth header and the adapter responds 401
    //   Unauthorized. This is a SHARED LSP secret, not a per-wallet
    //   credential — see header changelog for the security model.
    // 0.58.0 (b, S41 review #2 fix): registration is SIGNED. ts bounds the
    // proof (worker rejects |now-ts| > 600s); the signature binds the FULL
    // record, so nothing advertised can be altered after signing. A failed
    // signmessage aborts here — never send a body the worker will 403.
    const body = {
      name:           CONFIG.node.name,
      pubkey:         CONFIG.node.pubkey,
      endpoint:       CONFIG.public.https_url,
      route_endpoint: CONFIG.public.https_url,
      route_macaroon: CONFIG.adapter.secret,
      wss_url:        CONFIG.public.wss_url,
      fee_ppm:        CONFIG.node.fee_ppm,
      // 0.60.0 (S41 close, DP): ADVERTISE the policy the box already
      // ENFORCES — these fields sat in the canonical's field list (signed
      // as '0') but were never sent, so the registry served 0 and the
      // marketplace card showed '—' while the box enforced 20k/60k. The
      // verbatim canonical twin on the worker covers them unchanged.
      fee_base_sats:  0,
      channel_open_fee_sats: openFeeBaselineSats(),   // 0.61.0: DERIVED from LSPS2_VAR_MIN_FEE_MSAT — the number lnurlpFeeMsat charges at baseline
      max_channel_size_sats: CONFIG.channel.max_sats,
      supports_jit:   true,
      ts:             Math.floor(Date.now() / 1000),
    };
    const canonical = canonicalRegisterMsg(body);
    const signed = await lndPost('/v1/signmessage', {
      msg: Buffer.from(canonical, 'utf8').toString('base64'),
    });
    if (!signed || !signed.signature) {
      // 0.59.0 (b, docketed S41): quote LND VERBATIM — the macaroon abort
      // took an inference to diagnose; a constant-string log convicts
      // nothing. Next time the journal names the cause itself.
      throw new Error('LND signmessage returned no signature — registration aborted; LND said: ' + JSON.stringify(signed).slice(0, 300));
    }
    body.signature = signed.signature;
    const result = await httpsPost(`${CONFIG.registry}/lsps/register`, body);
    console.log('[Registry] Registered:', result);
    if (result && result.ok) { registryStatus.last_ok = Date.now(); registryStatus.last_error = ''; }
    else registryStatus.last_error = (result && (result.error || JSON.stringify(result))) || 'unknown';
  } catch (e) {
    console.error('[Registry] Registration failed:', e.message);
    registryStatus.last_error = e.message;
  }
  registryStatus.next_ms = Date.now() + registryStatus.every_h * 3600 * 1000;
}

// ── 0.73.0: console notes — per instance, DATA_DIR/console-notes.json, never in git.
// Shape keeps the old lij-console's notes.json (summary + per-channel-point notes),
// adds wallet labels (per pubkey). The old file is imported once if ours is absent.
const CONSOLE_NOTES_PATH = process.env.CONSOLE_NOTES_PATH || require('path').join(DATA_DIR, 'console-notes.json');
let consoleNotes = { version: 1, summary: { text: '', updated: 0 }, channels: {}, wallets: {} };
try {
  const fs0 = require('fs');
  if (fs0.existsSync(CONSOLE_NOTES_PATH)) {
    const j = JSON.parse(fs0.readFileSync(CONSOLE_NOTES_PATH, 'utf8'));
    consoleNotes = Object.assign(consoleNotes, j, { summary: Object.assign({ text: '', updated: 0 }, j.summary || {}), channels: j.channels || {}, wallets: j.wallets || {} });
  } else {
    const old = process.env.CONSOLE_NOTES_IMPORT || require('path').join(require('os').homedir(), 'lij-console', 'notes.json');
    if (fs0.existsSync(old)) {
      const j = JSON.parse(fs0.readFileSync(old, 'utf8'));
      consoleNotes.summary = Object.assign({ text: '', updated: 0 }, j.summary || {});
      consoleNotes.channels = j.channels || {};
      fs0.writeFileSync(CONSOLE_NOTES_PATH, JSON.stringify(consoleNotes, null, 1));
      console.log(`[Console] imported notes from ${old} (${Object.keys(consoleNotes.channels).length} channel notes)`);
    }
  }
} catch (e) { console.error('[Console] notes load failed: ' + e.message); }
function consoleNotesSave() { require('fs').writeFileSync(CONSOLE_NOTES_PATH, JSON.stringify(consoleNotes, null, 1)); }
function consoleNoteSet(kind, key, text) {
  const t = String(text || '').slice(0, 2000);
  if (kind === 'summary') consoleNotes.summary = { text: t, updated: Date.now() };
  else if (kind === 'channel') { if (!/^[0-9a-f]{64}:\d+$/.test(key)) throw new Error('bad channel point'); if (t) consoleNotes.channels[key] = { text: t, updated: Date.now() }; else delete consoleNotes.channels[key]; }
  else if (kind === 'wallet') { if (!/^0[23][0-9a-f]{64}$/.test(key)) throw new Error('bad pubkey'); if (t) consoleNotes.wallets[key] = { label: t.slice(0, 80), updated: Date.now() }; else delete consoleNotes.wallets[key]; }
  else throw new Error('bad kind');
  consoleNotesSave();
  return { ok: true, kind, key, text: t };
}

// ── 0.74.0 (DP): the SETTINGS REPORT — read-only. Every dial the box runs on, with
// its value and its source (.env or the adapter's default). Secrets: set/unset only.
// Nothing here can be changed from the console; changing any of it is a text file
// and a restart, and the pane says so.
function settingsReport() {
  const E = process.env;
  const src = (name) => (E[name] !== undefined && E[name] !== '') ? '.env' : 'default';
  const row = (group, label, name, value, unit, note) => ({ group, label, name, value, unit: unit || '', source: src(name), note: note || '' });
  const L = CONFIG.lsps2, C = CONFIG.channel, N = CONFIG.node, Ls = CONFIG.lease;
  const rows = [
    row('Advertised fees', 'routing fee (card)', 'FEE_PPM', N.fee_ppm, 'ppm', 'advertised only — what a payment pays is LND\'s policy on the channel (see LND actual)'),
    row('Advertised fees', 'LSPS2 base fee', 'LSPS2_BASE_FEE_MSAT', L.base_fee_msat, 'msat', 'per forward, advertised in get_info and route hints'),
    row('Advertised fees', 'LSPS2 fee', 'LSPS2_FEE_PPM', L.fee_ppm, 'ppm', 'per forward, advertised'),
    row('Channel-open fee', 'open fee', 'LSPS2_VAR_FEE_PPM', L.open_fee_ppm, 'ppm', 'of the opening payment; the JIT, bolt11 and LNURL rails share it'),
    row('Channel-open fee', 'open fee floor', 'LSPS2_OPEN_FEE_MIN_MSAT', L.open_fee_min_msat, 'msat', 'the least an open costs the wallet'),
    row('JIT sizing (inbound liquidity)', 'size rule', '', 'max(2 × payment, payment + buffer)', '', 'computeChannelSizeSats — the inbound room a first receive gets'),
    row('JIT sizing (inbound liquidity)', 'buffer', 'LSPS2_CHANNEL_BUFFER_SATS', L.channel_buffer_sats, 'sats', 'added above the payment'),
    row('JIT sizing (inbound liquidity)', 'channel min', 'MIN_CHANNEL_SATS', C.min_sats, 'sats', ''),
    row('JIT sizing (inbound liquidity)', 'channel default', 'CHANNEL_SIZE_SATS', C.size_sats, 'sats', ''),
    row('JIT sizing (inbound liquidity)', 'channel max', 'MAX_CHANNEL_SATS', C.max_sats, 'sats', 'JIT opens are not capped by this (intentional, S44)'),
    row('JIT sizing (inbound liquidity)', 'payment min', 'LSPS2_MIN_PAYMENT_SIZE_MSAT', L.min_payment_size_msat, 'msat', ''),
    row('JIT sizing (inbound liquidity)', 'payment max', 'LSPS2_MAX_PAYMENT_SIZE_MSAT', L.max_payment_size_msat, 'msat', ''),
    row('JIT sizing (inbound liquidity)', 'open-amount JIT', 'LSPS2_VAR_ENABLED', L.variable_enabled, '', 'variable-amount receives'),
    row('JIT sizing (inbound liquidity)', 'quiesce', 'LSPS2_VAR_QUIESCE_MS', L.variable_quiesce_ms, 'ms', 'silence that finalises an open-amount set'),
    row('Guardrails', 'on-chain reserve floor', 'JIT_MIN_ONCHAIN_RESERVE_SATS', L.jit_min_onchain_reserve_sats, 'sats', 'no JIT open below this confirmed balance'),
    row('Guardrails', 'scarcity ramp start', 'JIT_SCARCITY_RAMP_START_SATS', L.jit_scarcity_ramp_start_sats, 'sats', 'headroom where the open-fee multiplier starts rising'),
    row('Guardrails', 'scarcity max', 'JIT_SCARCITY_MAX_PCT', L.jit_scarcity_max_pct, '%', 'multiplier at zero headroom'),
    row('Guardrails', 'free opens per wallet', 'JIT_FEE_FREE_OPENS', L.jit_fee_free_opens, '', 'per window'),
    row('Guardrails', 'step after free opens', 'JIT_FEE_STEP_PCT', L.jit_fee_step_pct, '%', 'each further open adds this'),
    row('Guardrails', 'window', 'LSPS2_JIT_WINDOW_DAYS', Math.round(JIT_WINDOW_MS / 86400000), 'days', ''),
    row('Guardrails', 'floor opens per day', 'JIT_FLOOR_MAX_OPENS_PER_DAY', JIT_FLOOR_MAX_OPENS_PER_DAY, '', ''),
    row('Guardrails', 'promise validity', 'LSPS2_PROMISE_VALIDITY_SECS', L.promise_validity_secs, 's', ''),
    row('Lease', 'enabled', 'LEASE_ENABLE', Ls.enabled, '', ''),
    row('Lease', 'dry run', 'LEASE_DRY_RUN', Ls.dry_run, '', 'true = logs would_close, never closes'),
    row('Lease', 'silence before close', 'LEASE_DAYS', Ls.days, 'days', 'per-channel ttl overrides it (lease state)'),
    row('Lease', 'cycle', 'LEASE_CYCLE_MINUTES', Ls.cycle_minutes, 'min', 'a close lands within one cycle of the ttl'),
    row('Lease', 'session gap', 'LEASE_SESSION_GAP_MIN', Math.round(LEASE_SESSION_GAP_MS / 60000), 'min', 'contact after this much silence = a new session (one write, one log line)'),
    row('Lease', 'exclusions', '', Object.values(leaseExclude.chan_points || {}).filter((v) => v && v.excluded).length + ' from console' + (Ls.exclude.length ? ' + ' + Ls.exclude.length + ' from .env' : ''), '', leaseExclude.saved_at ? 'list saved' : 'list NEVER saved — the lease closes nothing'),
    row('Lease', 'lncli command', 'LEASE_LNCLI', Ls.lncli, '', 'the box\'s admin lncli, used only by the lease close'),
    row('Registry', 'registry', 'LIJOX_REGISTRY', CONFIG.registry || '(none — registry-free)', '', ''),
    row('Registry', 're-register every', 'LIJOX_REGISTER_EVERY_HOURS', registryStatus.every_h, 'h', 'the registry marks a record stale after 24 h without one'),
    row('Registry', 'advertised name', 'NODE_NAME', N.name, '', ''),
    row('Registry', 'advertised host', 'NODE_HOST', N.host, '', 'Tor or clearnet URI for peers'),
    row('Front doors', 'API port', 'ADAPTER_PORT', CONFIG.adapter.port, '', ''),
    row('Front doors', 'WS proxy port', 'WS_PROXY_PORT', CONFIG.adapter.ws_port, '', ''),
    row('Front doors', 'public HTTPS', 'PUBLIC_HTTPS_URL', CONFIG.public.https_url, '', ''),
    row('Front doors', 'public WSS', 'PUBLIC_WSS_URL', CONFIG.public.wss_url, '', ''),
    row('Front doors', 'allowed origins', 'WS_ALLOWED_ORIGINS', E.WS_ALLOWED_ORIGINS || '(default)', '', ''),
    row('Console', 'port', 'CONSOLE_PORT', E.CONSOLE_PORT || 7004, '', 'loopback + Tailscale only'),
    row('Console', 'session', 'CONSOLE_SESSION_HOURS', E.CONSOLE_SESSION_HOURS || 12, 'h', ''),
    row('Console', 'Tailscale bind', 'CONSOLE_TAILSCALE', E.CONSOLE_TAILSCALE || 'true', '', ''),
    row('Secrets', 'route token (published)', 'ADAPTER_SECRET', E.ADAPTER_SECRET ? 'set' : 'unset', '', 'a capability token every wallet receives via the registry — not an admin secret'),
    row('Secrets', 'LND macaroon', 'LIJ_ADAPTER_MACAROON_HEX', E.LIJ_ADAPTER_MACAROON_HEX ? 'set' : 'unset', '', 'least-privilege bake (MACAROON.md)'),
    row('Secrets', 'console TOTP', 'CONSOLE_TOTP_SECRET', E.CONSOLE_TOTP_SECRET ? 'set' : 'unset', '', ''),
    row('Secrets', 'VAPID (web push)', 'VAPID_PRIVATE_KEY', E.VAPID_PRIVATE_KEY ? 'set' : 'unset', '', ''),
    row('Paths', 'data dir', 'LIJ_DATA_DIR', DATA_DIR, '', 'registries, tapes, lease state, notes, PL'),
    row('Paths', 'LND REST', 'LND_ENDPOINT', (CONFIG.lnd && CONFIG.lnd.endpoint) || '', '', ''),
  ];
  return rows;
}

// ── 0.71.0: the console's snapshot — what the panes show, assembled here so the
// console module knows nothing about the adapter's internals. Balances and
// channels from LND's REST API; wallets from the LNURL registry; leases, loops,
// registry status and backup legs from this process. Tor/clearnet per peer from
// listpeers' address.
async function consoleSnapshot() {
  const fs = require('fs');
  const [info, chans, peers, pending, wb, txsAll] = await Promise.all([
    lndGet('/v1/getinfo').catch(() => ({})),
    lndGet('/v1/channels').catch(() => ({ channels: [] })),
    lndGet('/v1/peers').catch(() => ({ peers: [] })),
    lndGet('/v1/channels/pending').catch(() => ({})),
    lndGet('/v1/balance/blockchain').catch(() => ({})),
    lndGet('/v1/transactions').catch(() => ({})),
  ]);
  // 0.73.4 (DP): "opened on" — the funding transaction's timestamp from the wallet's
  // chain history (needs GetTransactions in the macaroon); otherwise the block the
  // short channel id points at (an alias scid — zero-conf — carries no block).
  const txTime = {};
  for (const t of ((txsAll && txsAll.transactions) || [])) txTime[t.tx_hash] = Number(t.time_stamp) * 1000;
  // 0.71.2: channel balances are summed from ListChannels — ChannelBalance is not in
  // the URI-level macaroon (bake-permissions.json), so 0.71.0/0.71.1 showed 0/0.
  let sumLocal = 0, sumRemote = 0, sumUnsettled = 0;
  for (const c of (chans.channels || [])) { sumLocal += Number(c.local_balance || 0); sumRemote += Number(c.remote_balance || 0); sumUnsettled += Number(c.unsettled_balance || 0); }
  // 0.73.4/0.73.5: the old console's Principles 1 & 2 (DP, v0.5) — metrics only, no target (DP).
  // From the LSP's seat: wallet OUTBOUND = the wallets' spendable = remote on wallet
  // channels; wallet INBOUND = the wallets' receive room = local on wallet channels;
  // ext OUT = local on non-wallet channels (what the LSP can push to the network);
  // ext IN = remote on non-wallet channels. P1 cover = ext_out / wallet_out;
  // P2 cover = ext_in / wallet_in. ALL channels, as the old console did — 0.73.5 counted
  // active ones only, and wallet channels are inactive whenever the phone is closed,
  // so the wallet side summed to 0 and both covers read n/a (DP, 2026-09-10).
  const pr = { wallet_out: 0, wallet_in: 0, ext_out: 0, ext_in: 0, wallet_n: 0, ext_n: 0, wallet_active: 0, ext_active: 0 };
  for (const c of (chans.channels || [])) {
    if (c.active) { if (leaseIsWalletPeer(c.remote_pubkey)) pr.wallet_active++; else pr.ext_active++; }
    if (leaseIsWalletPeer(c.remote_pubkey)) { pr.wallet_out += Number(c.remote_balance || 0); pr.wallet_in += Number(c.local_balance || 0); pr.wallet_n++; }
    else { pr.ext_out += Number(c.local_balance || 0); pr.ext_in += Number(c.remote_balance || 0); pr.ext_n++; }
  }
  pr.p1_cover = pr.wallet_out ? pr.ext_out / pr.wallet_out : null;
  pr.p2_cover = pr.wallet_in ? pr.ext_in / pr.wallet_in : null;
  // 0.74.5 (DP): the old console's top boxes — Treasury, On-chain, Can send, Can receive,
  // Top inbound peer (the routing-fee box is PL's now and was left out on purpose).
  let localActive = 0, remoteActive = 0, nActive = 0, extInActive = 0, top = null;
  for (const c of (chans.channels || [])) {
    if (!c.active) continue;
    nActive++; localActive += Number(c.local_balance || 0); remoteActive += Number(c.remote_balance || 0);
    if (!leaseIsWalletPeer(c.remote_pubkey)) { const r = Number(c.remote_balance || 0); extInActive += r; if (!top || r > top.sats) top = { pubkey: c.remote_pubkey, alias: c.peer_alias || '', label: (consoleNotes.wallets[c.remote_pubkey] || {}).label || '', sats: r }; }
  }
  const onchainTotal = Number(wb.confirmed_balance || 0) + Number(wb.unconfirmed_balance || 0);
  const boxes = {
    treasury: sumLocal + onchainTotal, onchain_total: onchainTotal, anchor_reserve: Number(wb.reserved_balance_anchor_chan || 0),
    can_send: localActive, can_receive: remoteActive, n_active: nActive,
    top_inbound: top ? { alias: top.label || top.alias || top.pubkey.slice(0, 12) + '…', sats: top.sats, pct: extInActive ? top.sats / extInActive : 0 } : null,
  };
  const peerAddr = {};
  for (const p of (peers.peers || [])) peerAddr[p.pub_key] = p.address || '';
  // 0.74.0: LND's ACTUAL fee policy on wallet channels, read-only (GetChanInfo), so the
  // advertised numbers on the settings report can be checked against what is charged.
  const lndPolicy = { checked: 0, matches: 0, mismatches: [], error: '' };
  try {
    const own = String(info.identity_pubkey || '').toLowerCase();
    const walletChans = (chans.channels || []).filter((c) => leaseIsWalletPeer(c.remote_pubkey) && c.chan_id && String(c.chan_id) !== '0').slice(0, 12);
    for (const c of walletChans) {
      const ci = await lndGet('/v1/graph/edge/' + c.chan_id).catch(() => null);
      if (!ci || !ci.node1_policy) continue;
      const pol = String(ci.node1_pub || '').toLowerCase() === own ? ci.node1_policy : ci.node2_policy;
      if (!pol) continue;
      lndPolicy.checked++;
      const base = Number(pol.fee_base_msat || 0), ppm = Number(pol.fee_rate_milli_msat || 0);
      if (base === CONFIG.lsps2.base_fee_msat && ppm === CONFIG.lsps2.fee_ppm) lndPolicy.matches++;
      else lndPolicy.mismatches.push({ chan_id: String(c.chan_id), base_msat: base, ppm });
    }
  } catch (e) { lndPolicy.error = String(e && e.message || e).slice(0, 80); }
  const walletPubkeys = new Set(Object.values(lnurlpRegistry).map((r) => r && r.client_pubkey).filter(Boolean));
  const nowMs = Date.now();
  const channels = (chans.channels || []).map((c) => {
    const lease = leaseState.channels && leaseState.channels[c.channel_point];
    let leaseTxt = '';
    if (lease && lease.last_seen_ms) {
      // 0.71.1: the effective ttl is the channel's own or the global default —
      // ttl_days is null by default, which 0.71.0 read as 0 ("past ttl" everywhere).
      const daysLeft = leaseTtlDays(lease) - (nowMs - lease.last_seen_ms) / 86400000;
      leaseTxt = (daysLeft > 0 ? Math.floor(daysLeft) + ' d left' : 'past ttl') + (!(CONFIG.lease && CONFIG.lease.enabled) ? ' (lease off)' : (CONFIG.lease.dry_run ? ' (dry run)' : ''));
    }
    return {
      remote_pubkey: c.remote_pubkey, alias: c.peer_alias || '', address: peerAddr[c.remote_pubkey] || '',
      capacity: Number(c.capacity), local_balance: Number(c.local_balance), remote_balance: Number(c.remote_balance),
      active: !!c.active, private: !!c.private, pending_htlcs: (c.pending_htlcs || []).length,
      wallet: leaseIsWalletPeer(c.remote_pubkey), lease: leaseTxt, excluded: leaseIsExcluded(c.channel_point), channel_point: c.channel_point,
      last_seen_ms: lease ? (lease.last_seen_ms || 0) : 0, last_source: lease ? (lease.last_source || '') : '',
      opened_ms: txTime[String(c.channel_point || '').split(':')[0]] || 0,
      opened_block: (() => { try { const h = Number(BigInt(c.chan_id || '0') >> 40n); return (h > 0 && h < 8000000) ? h : 0; } catch (_) { return 0; } })(),
      initiator: !!c.initiator,
      note: (consoleNotes.channels[c.channel_point] || {}).text || '', label: (consoleNotes.wallets[c.remote_pubkey] || {}).label || '',
    };
  }).sort((a, b) => {   // 0.73.3 (DP): the LiJ wallet channels together first, then the peer-node/LSP channels; within each group by peer, then by channel — a wallet's channels sit next to each other
    if (a.wallet !== b.wallet) return a.wallet ? -1 : 1;
    if (a.remote_pubkey !== b.remote_pubkey) {
      const la = (a.label || a.alias || a.remote_pubkey).toLowerCase(), lb = (b.label || b.alias || b.remote_pubkey).toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      return a.remote_pubkey < b.remote_pubkey ? -1 : 1;
    }
    return a.channel_point < b.channel_point ? -1 : a.channel_point > b.channel_point ? 1 : 0;
  });
  // 0.71.1: "first seen" = the name's registration; "last heard" = the newest
  // lease stamp for that wallet's channel(s) (the lease loop stamps a channel
  // whenever its peer is connected), or its newest hold/settle.
  const heardByPeer = {};
  for (const rec of Object.values((leaseState && leaseState.channels) || {})) if (rec && rec.peer && rec.last_seen_ms) heardByPeer[rec.peer] = Math.max(heardByPeer[rec.peer] || 0, rec.last_seen_ms);
  const wallets = [];
  const remoteByPeer = {};   // 0.74.3: the wallet's side of its channel(s)
  for (const c of (chans.channels || [])) remoteByPeer[c.remote_pubkey] = (remoteByPeer[c.remote_pubkey] || 0) + Number(c.remote_balance || 0);
  for (const [name, rec] of Object.entries(lnurlpRegistry)) {
    if (!rec) continue;
    const entries = rec.entries || [];
    let act = 0; for (const e of entries) { if (e && e.accepted_at > act) act = e.accepted_at; if (e && e.settled_at > act) act = e.settled_at; }
    wallets.push({ pubkey: rec.client_pubkey || '', name, holds: entries.filter((e) => e && e.status === 'accepted').length, hashes: entries.length, first_seen_ms: rec.created || 0, last_heard_ms: Math.max(heardByPeer[rec.client_pubkey] || 0, act), label: (consoleNotes.wallets[rec.client_pubkey] || {}).label || '', remote_sats: remoteByPeer[rec.client_pubkey] === undefined ? null : remoteByPeer[rec.client_pubkey] });
  }
  const walletCount = new Set(wallets.map((w) => w.pubkey).filter(Boolean)).size;   // distinct by pubkey — a wallet with several pay codes counts once
  // 0.71.1: unconfirmed on-chain — the wallet's 0-conf transactions and LND's
  // pending sweeps. Needs GetTransactions / PendingSweeps in the macaroon;
  // without them the pane says so instead of guessing.
  const unconfirmed = {};
  try {
    const tx = await lndGet('/v1/transactions');
    if (tx && tx.transactions) unconfirmed.txs = tx.transactions.filter((t) => Number(t.num_confirmations) === 0).map((t) => ({ txid: t.tx_hash, amount: Number(t.amount), fee: Number(t.total_fees), label: t.label || '', time_ms: Number(t.time_stamp) * 1000 }));
    else unconfirmed.error = 'GetTransactions: ' + JSON.stringify(tx).slice(0, 120);
  } catch (e) { unconfirmed.error = 'GetTransactions: ' + e.message; }
  try {
    const sw = await lndGet('/v2/wallet/sweeps/pending');
    if (sw && sw.pending_sweeps) unconfirmed.sweeps = sw.pending_sweeps.map((x) => ({ outpoint: ((x.outpoint || {}).txid_str || '') + ':' + ((x.outpoint || {}).output_index || 0), amount: Number(x.amount_sat), kind: x.witness_type || '', fee_rate: x.sat_per_vbyte || x.requested_sat_per_vbyte || '', tries: x.broadcast_attempts || 0 }));
  } catch (_) {}
  if (unconfirmed.error && !unconfirmed.sweeps) unconfirmed.error += ' — add lnrpc.Lightning/GetTransactions and walletrpc.WalletKit/PendingSweeps to the macaroon (MACAROON.md) to see this pane';
  const pend = [];
  for (const [kind, key] of [['opening', 'pending_open_channels'], ['closing', 'pending_closing_channels'], ['force-closing', 'pending_force_closing_channels'], ['waiting close', 'waiting_close_channels']]) {
    for (const x of (pending[key] || [])) { const ch = x.channel || {}; pend.push({ kind, remote_pubkey: ch.remote_node_pub || '', capacity: Number(ch.capacity || 0), channel_point: ch.channel_point || '' }); }
  }
  const backups = {};
  const SCB_DIR = process.env.LIJ_SCB_STATE_DIR || '/var/lib/lij-scb';
  for (const leg of ['local', 'cloud']) {
    try {
      const st = JSON.parse(fs.readFileSync(`${SCB_DIR}/status-${leg}.json`, 'utf8'));
      backups[leg] = { ok: st.ok !== false, at_ms: (st.last_ok || st.last_attempt || 0) * 1000, stale: !st.last_ok || (nowMs / 1000 - st.last_ok) > 26 * 3600, note: st.err || '' };
    } catch (_) {}
  }
  const loops = {};
  for (const [name, v] of Object.entries(loopStamps)) loops[name] = { last: v.last || 0, period_ms: v.period_ms, stale: !v.last || (nowMs - v.last) > Math.max(5 * v.period_ms, 120000) };
  let tapes = 0, lastTape = 0;
  try { for (const f of fs.readdirSync(TAPES_DIR)) { tapes++; const t = parseInt(f.split('-')[0], 10); if (t > lastTape) lastTape = t; } } catch (_) {}
  const pendingOpenLocal = (pending.pending_open_channels || []).reduce((a, x) => a + Number((x.channel || {}).local_balance || 0), 0);
  return {
    node: { alias: info.alias, pubkey: info.identity_pubkey, version: info.version, block_height: info.block_height, synced: !!info.synced_to_chain, synced_to_graph: info.synced_to_graph, num_peers: info.num_peers, num_active: info.num_active_channels, num_inactive: info.num_inactive_channels, num_pending: info.num_pending_channels, uris: info.uris || [] },
    balances: { onchain_confirmed: Number(wb.confirmed_balance || 0), onchain_unconfirmed: Number(wb.unconfirmed_balance || 0), local: sumLocal, remote: sumRemote, unsettled: sumUnsettled, pending_open_local: pendingOpenLocal, reserved_anchor: Number(wb.reserved_balance_anchor_chan || 0), principles: pr, boxes },
    // 0.71.2 (DP: "bring in the guardrail multipliers we set for the desktop" — the
    // [JIT] self-protection boot line, live): the scarcity multiplier and its inputs,
    // the per-wallet open ladder, the JIT sizing and the daily floor cap.
    guardrails: {
      live_mult_pct: scarcityMultPct(), onchain_confirmed: scarcityCache.confirmed, headroom: scarcityCache.headroom, refreshed_ms: scarcityCache.ts,
      reserve_floor_sats: CONFIG.lsps2.jit_min_onchain_reserve_sats, ramp_start_sats: CONFIG.lsps2.jit_scarcity_ramp_start_sats, max_mult_pct: CONFIG.lsps2.jit_scarcity_max_pct,
      free_opens: CONFIG.lsps2.jit_fee_free_opens, step_pct: CONFIG.lsps2.jit_fee_step_pct, window_days: Math.round(JIT_WINDOW_MS / 86400000), floor_max_opens_per_day: JIT_FLOOR_MAX_OPENS_PER_DAY,
      channel_min_sats: CONFIG.channel.min_sats, channel_size_sats: CONFIG.channel.size_sats, channel_max_sats: CONFIG.channel.max_sats,
      open_fee_min_sats: Math.round(CONFIG.lsps2.open_fee_min_msat / 1000), fee_ppm: CONFIG.node.fee_ppm, lease_days: CONFIG.lease.days, lease_enabled: !!(CONFIG.lease && CONFIG.lease.enabled), lease_dry_run: !!(CONFIG.lease && CONFIG.lease.dry_run), lease_cycle_min: CONFIG.lease.cycle_minutes,
      lease_list_saved_at: leaseExclude.saved_at || 0, lease_excluded: (chans.channels || []).filter((c) => leaseIsExcluded(c.channel_point)).length, lease_leased: (chans.channels || []).filter((c) => !leaseIsExcluded(c.channel_point) && c.remote_pubkey !== LEASE_WORLD_PEER).length,
    },
    channels, wallets, wallet_count: walletCount, pending: pend, unconfirmed, summary_note: consoleNotes.summary.text || '',
    settings: settingsReport(), lnd_policy: lndPolicy,
    registry_records: (() => { const out = {}; try { for (const [pk, inner] of registryChannelStore.byPubkey) out[pk] = Array.from(inner.values()).map((r) => ({ channel_id: r.channel_id, funding: r.funding_txid + ':' + r.funding_vout, value_sat: r.channel_value_sat, close_height: r.close_height || null })); } catch (_) {} return out; })(),
    registry: { url: CONFIG.registry || '', last_ok: registryStatus.last_ok, last_error: registryStatus.last_error, next_ms: registryStatus.next_ms, every_h: registryStatus.every_h, https_url: CONFIG.public.https_url, wss_url: CONFIG.public.wss_url },
    backups, loops, watchdog: !!process.env.NOTIFY_SOCKET, uptime_s: Math.round(process.uptime()), tapes, last_tape_ms: lastTape,
  };
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function authOk(req) {
  // v0.8: accept secret via either x-adapter-secret (other adapter routes) or
  // grpc-metadata-macaroon (Phase 10b wallet code already sends this for
  // route queries). Header names are lowercased by Node's http parser.
  const secret = CONFIG.adapter.secret;
  return (
    (req.headers['x-adapter-secret']        || '') === secret ||
    (req.headers['grpc-metadata-macaroon']  || '') === secret
  );
}

function getClientIp(req) {
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']
    || req.socket.remoteAddress
    || 'unknown';
}

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errResponse(res, msg, status = 400) {
  jsonResponse(res, { error: msg }, status);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        // 0.73.0: any POST that names its wallet is proof of life for the lease
        if (parsed && typeof parsed.client_pubkey === 'string') leaseTouch(parsed.client_pubkey, 'api:' + String(req.url || '').split('?')[0]);
        resolve(parsed);
      }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// v0.19: build the LIJOX registry router. Takes our existing helpers as
// dependencies so handlers use the same response shapes as the rest of the
// adapter (jsonResponse/errResponse + readBody for body parsing).
const registryRouter = makeRegistryRouter({
  nonceStore:   registryNonceStore,
  channelStore: registryChannelStore,
  jsonResponse,
  errResponse,
  readBody,
});

// ── CORS handling (v0.9) ──────────────────────────────────────────────────────
// Browser-based wallets call HTTP endpoints cross-origin
// and need CORS preflight + headers. Origins from HTTP_ALLOWED_ORIGINS env var.

const HTTP_ALLOWED_ORIGINS = (process.env.HTTP_ALLOWED_ORIGINS
  || process.env.WS_ALLOWED_ORIGINS || '')  // v0.47: falls back to the WS origin list; REQUIRED via WS_ALLOWED_ORIGINS
  .split(',').map(s => s.trim()).filter(Boolean);

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && HTTP_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin',  origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Adapter-Secret, Grpc-Metadata-Macaroon');
    res.setHeader('Access-Control-Max-Age',       '86400');
    res.setHeader('Vary',                         'Origin');
  }
}

// ═════════════════════════════════════════════════════════════════════
// v0.21 LEASE — connection-based channel expiry (the Line-3 lease).
// last_seen = the most recent cycle in which this channel's peer held an
// authenticated connection. Expiry fires an LSP force-close via stock
// lncli: REST CloseChannel is a streaming RPC and the REST gateway hangs
// on streams in this LND build (see CONFIG.lnd comment); a gRPC helper in
// lnd-grpc.js is the future refinement. State survives restarts
// (lease-state.json); every decision appends to lease-log.ndjson.
// POST /lease/ttl (per-channel override) is THE hook the future
// PAID-EXTENSION flow calls after payment — v1 auth is the adapter
// secret; the fuller build fronts it with an order+invoice flow that
// lands on this same setter.
const leaseFs = require('fs');
// ── 0.72.3 (DP asked "are we certain the lease only impacts wallets?" — it was NOT:
// the cycle walked EVERY channel in listchannels — exchange peers, routing peers,
// the Umbrel — skipping only LEASE_WORLD_PEER and LEASE_EXCLUDE_CHANPOINTS; the dry
// run was the only protection). The lease now considers a channel ONLY when its
// peer is a known LiJ wallet: a pubkey this adapter opened a JIT channel to
// (persisted here, survives restarts), or one that registered a pay-code pool
// (lnurlpRegistry), or one holding a live LSPS2 promise. Everything else is
// skipped and logged once per boot as skip_non_wallet.
const LEASE_WALLETS_PATH = process.env.LEASE_WALLETS_PATH || require('path').join(DATA_DIR, 'lease-wallet-peers.json');
let leaseWalletPeers = new Set();
try { leaseWalletPeers = new Set(JSON.parse(require('fs').readFileSync(LEASE_WALLETS_PATH, 'utf8')).map((k) => String(k).toLowerCase())); } catch (_) {}
function leaseRememberWalletPeer(pubkey) {
  const k = String(pubkey || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(k) || leaseWalletPeers.has(k)) return;
  leaseWalletPeers.add(k);
  try { require('fs').writeFileSync(LEASE_WALLETS_PATH, JSON.stringify([...leaseWalletPeers])); } catch (e) { console.error('[LEASE] wallet-peer file write failed: ' + e.message); }
}
function leaseIsWalletPeer(pubkey) {
  const k = String(pubkey || '').toLowerCase();
  if (leaseWalletPeers.has(k)) return true;
  for (const rec of Object.values(lnurlpRegistry)) if (rec && String(rec.client_pubkey || '').toLowerCase() === k) return true;
  for (const pr of promiseByPaymentHash.values()) if (pr && String(pr.client_pubkey || '').toLowerCase() === k) return true;
  return false;
}
// ── 0.72.4 (DP RULED, 2026-09-08: "I would rather have a safe list of what is
// EXCLUDED from the lease, rather than the reverse. I know with whom I have
// channels open."): the lease considers every channel EXCEPT the ones on the
// operator's exclusion list — set and saved from the console, per instance,
// in DATA_DIR/lease-exclude.json (gitignored; never shared). Until the operator
// has SAVED the list at least once, the lease closes nothing (it behaves as a
// dry run and logs exclusion_list_unsaved once per boot): an unset list is not
// consent. The wallet-peer recognition above is used for LABELS only.
const LEASE_EXCLUDE_PATH = process.env.LEASE_EXCLUDE_PATH || require('path').join(DATA_DIR, 'lease-exclude.json');
let leaseExclude = { version: 1, saved_at: 0, chan_points: {} };   // cp -> { excluded: bool, peer, note, set_at }
try { const j = JSON.parse(require('fs').readFileSync(LEASE_EXCLUDE_PATH, 'utf8')); if (j && j.chan_points) leaseExclude = Object.assign({ version: 1, saved_at: 0, chan_points: {} }, j); } catch (_) {}
function leaseExcludeSave() {
  leaseExclude.saved_at = Date.now();
  require('fs').writeFileSync(LEASE_EXCLUDE_PATH, JSON.stringify(leaseExclude, null, 1));
}
function leaseIsExcluded(cp) {
  if (CONFIG.lease.exclude.includes(cp)) return true;                       // .env list still honoured
  const e = leaseExclude.chan_points[cp];
  return !!(e && e.excluded);
}
function leaseListSaved() { return !!leaseExclude.saved_at; }
let leaseUnsavedLogged = false;
// ── 0.73.0 (DP RULED 2026-09-08: "any contact" is liveliness; measure it when the
// wallet ACTS, not when the adapter happens to look; write once per session):
// leaseTouch(pubkey, source) is called from every place a wallet identifies
// itself — every custom message a peer sends (the chain bridge), every POST body
// carrying client_pubkey (readBody), the GET routes that name a wallet, the JIT
// interceptor, the LNURL delivery, tapes. It stamps last_seen on every lease
// record with that peer, in memory. A SESSION starts when the previous stamp is
// older than LEASE_SESSION_GAP_MIN (10): that first touch persists the state and
// writes one `touch` line with its source; later touches in the session only
// move the in-memory stamp (the hourly cycle persists it anyway).
const LEASE_SESSION_GAP_MS = Math.max(1, parseFloat(process.env.LEASE_SESSION_GAP_MIN || '10')) * 60000;
function leaseTouch(pubkey, source) {
  try {
    const k = String(pubkey || '').toLowerCase();
    if (!/^0[23][0-9a-f]{64}$/.test(k) || !leaseState || !leaseState.channels) return;
    const now = Date.now();
    let newSession = false, hit = false;
    for (const [cp, rec] of Object.entries(leaseState.channels)) {
      if (!rec || String(rec.peer || '').toLowerCase() !== k) continue;
      hit = true;
      if (!rec.last_seen_ms || now - rec.last_seen_ms > LEASE_SESSION_GAP_MS) { newSession = true; rec.last_source = source; }
      rec.last_seen_ms = now;
    }
    if (hit && newSession) { leaseSaveState(); leaseLog({ event: 'touch', peer: k.slice(0, 16), source }); }
  } catch (_) {}
}
// (0.72.5's 30-second presence poll is retired — with contact-driven stamps it is
// not a measure of anything; the hourly cycle still stamps peers that are merely
// connected, which is what a routing peer's "contact" looks like.)
// ── 0.72.5: LEASE PRESENCE LOOP. Every 30 s: one listpeers, and every lease record
// whose peer is connected gets last_seen_ms = now; persisted when anything moved.
// (0.72.2 put the stamp inside peersConnectedSet(), which the adapter only calls
// while HTLCs are pending for an offline wallet — so in ordinary conditions it never
// ran, and DP's channel stayed at 58 d through a day of use.) Runs whenever the
// adapter runs, lease enabled or not, so the stamps are true the day it is enabled.
let leasePresenceDirty = false;
async function leasePresenceTick() {
  stampLoop('lease_presence', 30000);
  try {
    const data = await lndGet('/v1/peers');
    const connected = new Set((data.peers || []).map((p) => String(p.pub_key || '').toLowerCase()));
    const now = Date.now();
    if (leaseState && leaseState.channels) {
      for (const rec of Object.values(leaseState.channels)) {
        if (rec && rec.peer && connected.has(String(rec.peer).toLowerCase())) { rec.last_seen_ms = now; leasePresenceDirty = true; }
      }
    }
    if (leasePresenceDirty) { leasePresenceDirty = false; leaseSaveState(); }
  } catch (_) { /* keep last known */ }
}
// (not scheduled since 0.73.0 — see leaseTouch above)
const LEASE_WORLD_PEER = (process.env.LEASE_WORLD_PEER || '').trim(); // v0.47: operator-set pubkey of a world conduit that must never be leased; empty = no exclusion
let leaseState = { version: 1, channels: {} }; // chan_point -> { last_seen_ms, ttl_days, peer }
let leaseTimer = null;
// ── 0.57.0 (a): LOOP STAMPS — every stamped loop marks its cycle so a
// silent multi-day stall can't hide (the lease was the only stamped loop
// while reconnect-poll — the one that delivers offline-held HTLCs — ran
// dark). stampLoop(name, periodMs) at the top of each tick; GET /ops/loops
// (item b, authOk-gated — NEVER /health) serves the aggregate.
const loopStamps = {};
function stampLoop(name, periodMs) {
  const e = loopStamps[name] || (loopStamps[name] = { count: 0, period_ms: periodMs, last: 0 });
  e.count += 1; e.last = Date.now(); e.period_ms = periodMs;
}
let leaseCycles = 0;
let leaseLastCycleAt = 0;

function leaseLoadState() {
  try {
    const raw = JSON.parse(leaseFs.readFileSync(CONFIG.lease.state_path, 'utf8'));
    if (raw && raw.channels) leaseState = raw;
  } catch (_) { /* first run: empty state */ }
}
function leaseSaveState() {
  try { leaseFs.writeFileSync(CONFIG.lease.state_path, JSON.stringify(leaseState, null, 1)); }
  catch (e) { console.error(`[Lease] state save failed: ${e.message}`); }
}
function leaseLog(entry) {
  try { leaseFs.appendFileSync(CONFIG.lease.log_path, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n'); }
  catch (_) {}
}
function leaseTtlDays(rec) {
  return (rec && typeof rec.ttl_days === 'number' && rec.ttl_days > 0) ? rec.ttl_days : CONFIG.lease.days;
}

// ── 0.70.0 (S44, DP GO — Piece B): RECOVER-CLOSE ─────────────────────────────
// A wallet that comes back with ONLY its 12 words has no channel state, so it
// cannot reestablish; LND answers its "unknown channel" error by wiping the
// link and closing nothing (link.go processRemoteError → LinkFailureForceNone),
// and the lease timer never fires while that wallet keeps connecting. This
// endpoint is the missing piece: the wallet proves it owns the node key and
// asks this LSP to force-close every channel it holds with that key. The LSP's
// commitment pays the wallet's side to its pinned m/84 address, no delay.
//   POST /lsps/registry/recover-close  { node_pubkey, nonce, signature }
//   nonce     = a single-use challenge from GET /lsps/registry/challenge
//   signature = LND-style signmessage (zbase32) over "lij-recover-close-v1:" + nonce
//               by the NODE key — verified by LND /v1/verifymessage; the
//               recovered pubkey must equal node_pubkey (private nodes are never
//               "valid" in LND's graph sense; equality is the proof — S26).
// Refuses, closing NOTHING, when any of those channels carries an HTLC in
// flight (payments_in_flight; the wallet retries in minutes). Never closes
// without a fresh, consumed nonce — a replay months later must not close
// channels the wallet opened since.
const RECOVER_CLOSE_DOMAIN = 'lij-recover-close-v1:';
async function handleRecoverClose(req, res, ip) {
  if (isRateLimited(ip)) return errResponse(res, 'Rate limit exceeded', 429);
  let body;
  try { body = await readBody(req); } catch (e) { return errResponse(res, 'Invalid JSON'); }
  const pk = String(body.node_pubkey || '').toLowerCase().trim();
  const nonce = String(body.nonce || '').toLowerCase().trim();
  const sig = String(body.signature || '').trim();
  if (!/^0[23][0-9a-f]{64}$/.test(pk)) return errResponse(res, 'node_pubkey must be 66 lowercase hex chars');
  if (!/^[0-9a-f]{64}$/.test(nonce)) return errResponse(res, 'nonce must be 64 hex chars');
  if (!sig) return errResponse(res, 'Missing signature');
  // 1. signature → recovered pubkey must equal the claimed node key
  let recovered = '';
  try {
    const r = await lndRequest('POST', '/v1/verifymessage', {
      msg: Buffer.from(RECOVER_CLOSE_DOMAIN + nonce, 'utf8').toString('base64'),
      signature: sig,
    });
    const emsg = String((r && (r.message || r.error)) || '');
    if (!r || (!r.pubkey && /permission|macaroon|unauthenticated|unavailable|deadline|connection|EOF|unimplemented/i.test(emsg))) {
      return jsonResponse(res, { ok: false, reason: 'verify_unavailable' }, 503);
    }
    recovered = String((r && r.pubkey) || '').toLowerCase();
  } catch (e) {
    return jsonResponse(res, { ok: false, reason: 'verify_unavailable' }, 503);
  }
  if (!recovered || recovered !== pk) {
    console.warn(`[Recover] BAD_SIG from ${ip} for ${pk.slice(0, 16)}`);
    return jsonResponse(res, { ok: false, reason: 'bad_signature' }, 401);
  }
  // 2. consume the nonce AFTER the signature check (same order as the registry)
  const nr = registryNonceStore.consume(nonce);
  if (!nr.ok) return jsonResponse(res, { ok: false, reason: nr.code }, 400);
  // 3. what this LSP holds with that key
  let open = [], pending = [];
  try {
    const r = await lndGet('/v1/channels');
    open = ((r && r.channels) || []).filter(c => String(c.remote_pubkey || '').toLowerCase() === pk);
  } catch (e) {
    return jsonResponse(res, { ok: false, reason: 'lnd_unavailable' }, 503);
  }
  try {
    const pr = await lndGet('/v1/channels/pending');
    for (const k of ['pending_open_channels', 'pending_closing_channels', 'pending_force_closing_channels', 'waiting_close_channels']) {
      for (const pc of ((pr && pr[k]) || [])) {
        const ch = pc.channel || pc;
        if (String(ch.remote_node_pub || '').toLowerCase() === pk) pending.push({ chan_point: ch.channel_point, state: k });
      }
    }
  } catch (e) { /* pending list is informational */ }
  if (!open.length) {
    console.log(`[Recover] close-all ${pk.slice(0, 16)}: no open channels (${pending.length} pending)`);
    return jsonResponse(res, { ok: true, reason: 'no_channels', closed: [], pending });
  }
  // 4. refuse while a payment is in flight — nothing closes in this case
  const inFlight = open.filter(c => Array.isArray(c.pending_htlcs) && c.pending_htlcs.length > 0)
                       .map(c => ({ chan_point: c.channel_point, htlcs: c.pending_htlcs.length }));
  if (inFlight.length) {
    console.log(`[Recover] close-all ${pk.slice(0, 16)}: refused, ${inFlight.length} channel(s) with HTLCs in flight`);
    return jsonResponse(res, { ok: false, reason: 'payments_in_flight', in_flight: inFlight, retry_after_s: 120 }, 409);
  }
  // 5. force-close each (the same lncli call the lease loop uses)
  const closed = [], failed = [];
  for (const c of open) {
    const parts = String(c.channel_point || '').split(':');
    try {
      const out = await leaseForceClose(parts[0], parts[1]);
      closed.push({ chan_point: c.channel_point, capacity_sats: Number(c.capacity) || 0, wallet_side_sats: Number(c.remote_balance) || 0, result: out.slice(0, 200) });
      console.log(`[Recover] close-all ${pk.slice(0, 16)}: force-closed ${c.channel_point}`);
    } catch (e) {
      failed.push({ chan_point: c.channel_point, error: String(e.message || e).slice(0, 200) });
      console.error(`[Recover] close-all ${pk.slice(0, 16)}: close FAILED ${c.channel_point}: ${e.message}`);
    }
  }
  if (!closed.length) return jsonResponse(res, { ok: false, reason: 'close_failed', failed, pending }, 500);
  return jsonResponse(res, { ok: true, closed, failed, pending });
}

function leaseForceClose(fundingTxid, outputIndex) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    // 0.70.1 (S44): LEASE_LNCLI may be a COMMAND WITH ARGUMENTS ("docker exec
    // lightning_lnd_1 lncli" on the Umbrel). execFile takes a bare program
    // name — the whole string was looked up as one executable and failed
    // ENOENT, so no lease close (and no recover-close) could ever run there.
    // Split on whitespace: first token is the program, the rest lead the args.
    const parts = String(CONFIG.lease.lncli || 'lncli').trim().split(/\s+/).filter(Boolean);
    execFile(parts[0],
      parts.slice(1).concat(['closechannel', '--force', '--funding_txid', fundingTxid, '--output_index', String(outputIndex)]),
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`lncli: ${err.message} ${String(stderr || '').slice(0, 200)}`));
        resolve(String(stdout || ''));
      });
  });
}
async function leaseCycle() {
  leaseCycles++;
  leaseLastCycleAt = Date.now();
  stampLoop('lease', Math.max(1, CONFIG.lease.cycle_minutes) * 60000);  // 0.58.0 (c): stamp the timer's REAL period (was hardcoded 60s; cycle default is hourly — freshness math read every lease loop as 59min late)
  const now = leaseLastCycleAt;
  let chans, peers;
  try {
    [chans, peers] = await Promise.all([lndGet('/v1/channels'), lndGet('/v1/peers')]);
  } catch (e) {
    leaseLog({ event: 'cycle_error', error: e.message });
    return;
  }
  const connected = new Set((peers.peers || []).map(p => p.pub_key));
  const seen = new Set();
  for (const c of (chans.channels || [])) {
    if (c.remote_pubkey === LEASE_WORLD_PEER) continue;
    const cp = c.channel_point;
    seen.add(cp);
    let rec = leaseState.channels[cp];
    if (!rec) {
      rec = leaseState.channels[cp] = { last_seen_ms: now, ttl_days: null, peer: c.remote_pubkey };
      leaseLog({ event: 'seed', chan_point: cp, peer: c.remote_pubkey.slice(0, 16) });
    }
    if (connected.has(c.remote_pubkey)) { if (!rec.last_seen_ms || now - rec.last_seen_ms > LEASE_SESSION_GAP_MS) rec.last_source = 'connected'; rec.last_seen_ms = now; } // heard from
    const idleMs = now - rec.last_seen_ms;
    const ttlMs = leaseTtlDays(rec) * 86400000;
    if (idleMs <= ttlMs) continue;
    if (leaseIsExcluded(cp)) continue;               // 0.72.4: the operator's exclusion list (console) + the .env list
    const detail = {
      chan_point: cp,
      peer: c.remote_pubkey.slice(0, 16),
      idle_days: Number((idleMs / 86400000).toFixed(3)),
      ttl_days: leaseTtlDays(rec),
    };
    if (CONFIG.lease.dry_run) {
      leaseLog(Object.assign({ event: 'would_close' }, detail));
      continue;
    }
    if (!leaseListSaved()) {
      // 0.72.4: no exclusion list has ever been saved from the console — refuse to close.
      if (!leaseUnsavedLogged) { leaseUnsavedLogged = true; leaseLog({ event: 'exclusion_list_unsaved', note: 'lease will not close anything until the operator saves the exclusion list in the console' }); console.error('[LEASE] would close ' + cp + ' but the exclusion list has never been saved from the console — refusing (see lease-log.ndjson)'); }
      leaseLog(Object.assign({ event: 'would_close_unsaved_list' }, detail));
      continue;
    }
    leaseLog(Object.assign({ event: 'closing' }, detail));
    try {
      const parts = cp.split(':');
      const out = await leaseForceClose(parts[0], parts[1]);
      leaseLog(Object.assign({ event: 'close_broadcast' }, detail, { lncli: out.slice(0, 400) }));
    } catch (e) {
      leaseLog(Object.assign({ event: 'close_error' }, detail, { error: e.message }));
    }
  }
  for (const cp of Object.keys(leaseState.channels)) {
    if (!seen.has(cp)) {
      leaseLog({ event: 'prune_gone', chan_point: cp });
      delete leaseState.channels[cp];
    }
  }
  leaseSaveState();
}
// ═════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════
// v0.22 RATES — LSP-proxied BTC ticker (DP ruling: "through the LSP.
// No IP leaks."). The upstream price API is fetched from THIS box
// only; wallets read GET /rates. In-memory cache, TTL-refreshed,
// single-flight; on upstream failure the last good answer serves
// (flagged stale) up to RATES_STALE_SECONDS, then 503.
const RATES_TTL_MS   = parseFloat(process.env.RATES_TTL_SECONDS   || '120')  * 1000;
const RATES_STALE_MS = parseFloat(process.env.RATES_STALE_SECONDS || '3600') * 1000;
const RATES_UPSTREAM = process.env.RATES_UPSTREAM ||
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur,gbp,jpy,cad,aud,chf,cny,inr,brl,mxn,krw,sek,nok,dkk,pln,czk,zar,try,nzd,sgd,hkd';
let ratesCache = null;    // { rates: {USD: n, ...}, fetched_at_ms }
let ratesFetching = null; // single-flight promise

function ratesFetchUpstream() {
  if (ratesFetching) return ratesFetching;
  ratesFetching = new Promise((resolve) => {
    try {
      const u = new URL(RATES_UPSTREAM);
      const rq = require('https').request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'accept': 'application/json', 'user-agent': 'lij-lsp-rates/0.22' },
        timeout: 8000,
      }, (rs) => {
        let body = '';
        rs.on('data', (c) => { body += c; });
        rs.on('end', () => {
          try {
            const j = JSON.parse(body);
            const btc = j && j.bitcoin;
            if (btc && typeof btc.usd === 'number') {
              const rates = {};
              Object.keys(btc).forEach((k) => {
                if (typeof btc[k] === 'number') rates[k.toUpperCase()] = btc[k];
              });
              ratesCache = { rates: rates, fetched_at_ms: Date.now() };
            }
          } catch (e) { /* keep last good */ }
          resolve();
        });
      });
      rq.on('error', () => resolve());
      rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} resolve(); });
      rq.end();
    } catch (e) { resolve(); }
  });
  ratesFetching.then(() => { ratesFetching = null; }, () => { ratesFetching = null; });
  return ratesFetching;
}
async function ratesHandler(res) {
  if (!ratesCache || (Date.now() - ratesCache.fetched_at_ms) > RATES_TTL_MS) {
    await ratesFetchUpstream();
  }
  if (!ratesCache) return errResponse(res, 'rates unavailable', 503);
  const age = Date.now() - ratesCache.fetched_at_ms;
  if (age > RATES_STALE_MS) return errResponse(res, 'rates stale beyond limit', 503);
  return jsonResponse(res, {
    ok: true,
    usd_per_btc: ratesCache.rates.USD,
    rates: ratesCache.rates,
    fetched_at: new Date(ratesCache.fetched_at_ms).toISOString(),
    stale: age > RATES_TTL_MS,
  });
}
// ═════════════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const parsed = new url.URL(req.url, `http://localhost:${CONFIG.adapter.port}`);
  const path   = parsed.pathname;
  const method = req.method;
  const ip     = getClientIp(req);

  console.log(LOG_CLIENT_IP ? `[HTTP] ${method} ${path} from ${ip}` : `[HTTP] ${method} ${path}`);  // v0.48 (P4): IP logging is opt-in

  // v0.9: CORS headers on every response, plus OPTIONS preflight short-circuit
  setCorsHeaders(req, res);
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check — no auth required
  if (path === '/health' && method === 'GET') {
    /* v0.55.4: scope-free heartbeat parse. 0.55.1 referenced an
       out-of-scope parse var; its try/catch swallowed the ReferenceError,
       silently dropping every v539 heartbeat (second-send starvation). */
    { const _m = String(req.url||'').match(/[?&]client(?:_pubkey)?=([0-9a-fA-F]{66})/); if (_m) { touchWalletActive(_m[1].toLowerCase()); console.log(`[HB] awake heartbeat from ${_m[1].slice(0,16)}…`); } }  /* v0.55.5: the [HTTP] logger strips query strings, so the heartbeat must announce itself */
    try {
      const info = await lndGet('/v1/getinfo');
      // v0.5: include chain bridge status if running
      // v0.7: also surface gRPC stream counts and tip cache state for ops visibility
      const chain_bridge_status = chainBridge
        ? {
            enabled: true,
            registered_peers: chainBridge.registrySize(),
            streams: chainBridge.streamCounts(),
          }
        : { enabled: false };
      // v0.17: htlc-interceptor status. Counters come from the wrapper
      // (htlcs_seen, reconnects, errors); jit_matches is our own.
      // v0.18: filter internal-only `_lastWrite` from getCounters() output.
      const rawCounters = htlcInterceptor ? htlcInterceptor.getCounters() : {};
      const publicCounters = {};
      for (const k of Object.keys(rawCounters)) {
        if (!k.startsWith('_')) publicCounters[k] = rawCounters[k];
      }
      const interceptor_status = htlcInterceptor
        ? {
            enabled: true,
            ...publicCounters,
            jit_matches: interceptorJitMatches,
            pending_jit_buys: pendingJitBuys.size,
            last_match: interceptorLastMatch,
            // v0.18 Phase D.2:
            offline_htlcs_held:               pendingHtlcsForOfflineWallets.size,
            offline_htlcs_held_total:         offlineHtlcsHeld,
            offline_htlcs_settled:            offlineHtlcsSettled,
            offline_htlcs_failed:             offlineHtlcsFailed,
            trampoline_forwards_attempted:    trampolineForwardsAttempted,
            trampoline_forwards_succeeded:    trampolineForwardsSucceeded,
            trampoline_forwards_failed:       trampolineForwardsFailed,
            in_flight_opens:                  inFlightOpens.size,
            watchdogs:                        htlcWatchdogs.size,
          }
        : { enabled: false };
      // v0.53 (P7 fingerprint audit): the default /health answers what
      // wallets actually consume (ok, active_channels, interceptor
      // enabled+connected) plus operator-chosen identity — and withholds
      // box-profiling detail (lnd version, ops counters, per-wallet
      // bridge counts) unless HEALTH_DETAIL=on.
      const HEALTH_DETAIL = (process.env.HEALTH_DETAIL || 'off') === 'on';
      const base = {
        ok:              true,
        node:            CONFIG.node.pubkey,
        name:            CONFIG.node.name,
        active_channels: info.num_active_channels,
        synced:          info.synced_to_chain,
        ws_proxy_port:   CONFIG.adapter.ws_port,
        channel_limits:  {
          min_sats: CONFIG.channel.min_sats,
          max_sats: CONFIG.channel.max_sats,
        },
        chain_bridge:    HEALTH_DETAIL ? chain_bridge_status
                                       : { enabled: !!chainBridge },
        interceptor:     HEALTH_DETAIL ? interceptor_status
                                       : { enabled: !!htlcInterceptor,
                                           connected: (rawCounters.connected !== undefined ? rawCounters.connected : null) },
      };
      if (HEALTH_DETAIL) base.lnd_version = info.version;
      return jsonResponse(res, base);
    } catch (e) {
      return jsonResponse(res, { ok: false, error: e.message }, 503);
    }
  }

  // v0.19: LIJOX registry routes are PUBLIC (signed-challenge auth, see
  // registry.js). MUST dispatch BEFORE the authOk gate below -- adapter
  // secret is the wrong auth model for these endpoints. Any exception
  // here logs + 500s rather than falling through to the auth gate.
  if (path === '/lsps/registry/recover-close' && method === 'POST') {   // 0.70.0 (S44): public, signed-challenge auth
    try { return await handleRecoverClose(req, res, ip); }
    catch (e) { console.error('[Recover] handler threw:', e); return errResponse(res, 'Internal error', 500); }
  }
  if (path.startsWith('/lsps/registry/')) {
    try {
      const handled = await registryRouter.tryHandle(req, res, parsed);
      if (handled) return;
    } catch (e) {
      console.error('[Registry] handler threw:', e);
      return errResponse(res, 'Internal error', 500);
    }
  }

  // D-1 2c: push-subscribe is a PUBLIC signed-challenge route (same auth model
  // as the LIJOX registry). MUST dispatch before the authOk gate below.
  if (path === '/lsps2/push-subscribe' && req.method === 'POST') {
    try {
      await handlePushSubscribe(req, res);
      return;
    } catch (e) {
      console.error('[PUSH] subscribe handler threw:', e);
      return errResponse(res, 'Internal error', 500);
    }
  }

  // v0.21: LEASE POLICY is a PUBLIC read (static JSON, zero I/O) — the
  // wallet fetches it once to render the Connections expiry line. The
  // fuller LIJOX manifest carries lease_ttl inside the signed envelope;
  // this endpoint is the v1 bridge until the manifest work lands.
  if (path === '/lease/policy' && req.method === 'GET') {
    return jsonResponse(res, {
      ok: true,
      enabled: CONFIG.lease.enabled,
      lease_ttl_days: CONFIG.lease.days,
      heard_from: 'any authenticated peer connection resets the clock',
    });
  }

  // v0.22: RATES is a PUBLIC read — see the module above. Wallets call
  // this; only the LSP's own IP ever touches the upstream ticker.
  if (path === '/rates' && req.method === 'GET') {
    return ratesHandler(res);
  }

  // S26: attempt journal read. Hash-scoped — the caller must already hold
  // the payment hashes (they are its own invoices), so this reveals nothing
  // a guesser could reach; capped to keep it from becoming a scanner.
  if (path === '/attempts' && req.method === 'GET') {
    let hashes = [];
    try {
      const q = new URL(req.url, 'http://lsp.local').searchParams;
      hashes = String(q.get('hashes') || '').split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => /^[0-9a-f]{64}$/.test(h))
        .slice(0, 50);
    } catch (e) { hashes = []; }
    const attempts = {};
    for (const h of hashes) { if (attemptJournal[h]) attempts[h] = attemptJournal[h]; }
    return jsonResponse(res, { ok: true, attempts });
  }

  // v0.23: DELEGATE PAYMENT — self-contained module (see delegate.js;
  // design ledgered in docs/session25.md). Own auth model: register and
  // void self-authenticate via the slip's node-key signature; the spend
  // endpoint requires DELEGATE_SECRET (Page-scoped — the master adapter
  // secret never leaves this box). Disable = comment this branch.
  if (path.startsWith('/delegate/')) {
    return lijDelegate.handle(req, res, path, req.method, lndRequest);
  }

  // ── OPEN-INTENT v1 (v0.35.0) — docs/openintent-v1.md; pre-auth like
  // /delegate (client-signed objects, possession-gated at the handler).
  if (path === '/openintent' || path.startsWith('/openintent/')) {
    return handleOpenIntent(req, res, path, method,
      String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '?'));
  }

  // ── TAPEDROP (v0.36.0) — mobile flight-recorder evidence pipe.
  if (method === 'POST' && path === '/tapedrop') {
    return handleTapeDrop(req, res,
      String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '?'));
  }

  // All other routes require auth
  // ── LNURLp public surface — v0.26.0 (S30). The payRequest + callback MUST
  // be world-reachable (arbitrary payer wallets); /lnurl/register self-checks
  // authOk (adapter-secret header) so everything lives in one block.
  if (method === 'GET' && path.startsWith('/.well-known/lnurlp/')) {
    const name = path.slice('/.well-known/lnurlp/'.length).toLowerCase();
    const rec = lnurlpRegistry[name];
    if (!rec) return jsonResponse(res, { status: 'ERROR', reason: 'unknown name' }, 404);
    const host = req.headers.host || 'lsp';
    const chan = await lnurlpClientChannel(rec.client_pubkey);
    return jsonResponse(res, {
      tag: 'payRequest',
      callback: 'https://' + host + '/lnurl/cb/' + name,
      minSendable: lnurlpMinMsat(chan, rec.client_pubkey),   // v0.31.0 honest / v0.32.0 escalated
      maxSendable: CONFIG.lsps2.variable_ceiling_msat,
      metadata: lnurlpMetadata(name, lnurlpAddrHost(req, rec)),   // 0.68.0: the address host, not necessarily this host
      commentAllowed: 0,
    });
  }
  if (method === 'GET' && path.startsWith('/lnurl/cb/')) {
    const name = path.slice('/lnurl/cb/'.length).toLowerCase();
    const rec = lnurlpRegistry[name];
    if (!rec) return jsonResponse(res, { status: 'ERROR', reason: 'unknown name' }, 404);
    const amount = parsed.searchParams.get('amount');
    const amt = amount && /^\d+$/.test(amount) ? BigInt(amount) : 0n;
    const chan = await lnurlpClientChannel(rec.client_pubkey);
    const minMsat = BigInt(lnurlpMinMsat(chan, rec.client_pubkey));   // v0.31.0/v0.32.0: same helper as the quote
    if (amt < minMsat || amt > BigInt(CONFIG.lsps2.variable_ceiling_msat)) {
      return jsonResponse(res, { status: 'ERROR', reason: 'amount out of range' }, 400);
    }
    // 0.67.0: never mint an expired hash (the wallet's engine would refuse
    // it); retire what we pass over so the pool count tells the truth.
    const nowS0 = lnurlpNowS();
    let entry = null;
    for (const e of (rec.entries || [])) {
      if (e.status !== 'free') continue;
      if (Number(e.expires || 0) <= nowS0) { e.status = 'expired'; continue; }
      entry = e; break;
    }
    if (!entry) { lnurlpPersist(); return jsonResponse(res, { status: 'ERROR', reason: 'no capacity — receiver must refresh their pay code' }, 503); }
    // 0.67.0 (bedtime security item): a public endpoint that burns a hash per
    // call gets a per-IP ceiling — 60 mints a minute is a café on one NAT, not a bot.
    if (lnurlpMintLimited(String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '?'))) {
      return jsonResponse(res, { status: 'ERROR', reason: 'too many requests — try again in a minute' }, 429);
    }
    entry.status = 'reserved';
    entry.amount_msat = amt.toString();
    entry.reserved_at = Date.now();
    lnurlpPersist();
    let hodl;
    try {
      // v0.30.0 (S30): explicit public-road hints + private flag, with
      // graceful fallbacks if LND dislikes the combination.
      const pubHints = await lnurlpBuildPublicHints(amt);
      // v0.31.0 (S30): LUD-06 seal — the invoice carries `h` =
      // SHA-256 of the EXACT metadata string served (no `d`, no memo,
      // no second string to drift). cltv 400→144: a day of hold
      // headroom without demanding 2.8 days of sender HTLC lockup.
      const metaStr = lnurlpMetadata(name, lnurlpAddrHost(req, rec));   // 0.68.0: sealed under the address host
      const mintBody = {
        hash: Buffer.from(entry.hash, 'hex').toString('base64'),
        value_msat: amt.toString(),
        description_hash: require('crypto').createHash('sha256').update(metaStr, 'utf8').digest('base64'),
        expiry: '1200',   // 0.67.0: an unpaid reservation lives 20 min (was 60) — a payer pays in seconds; a griefer burns fewer hashes
        cltv_expiry: '144',
        private: true,
      };
      if (pubHints.length) mintBody.route_hints = pubHints;
      try {
        hodl = await lndPost('/v2/invoices/hodl', mintBody);
      } catch (e1) {
        if (pubHints.length) {
          console.warn(`[LNURLP] mint with hints+private refused (${e1.message}) — retrying hints-only`);
          try {
            const b2 = Object.assign({}, mintBody); delete b2.private;
            hodl = await lndPost('/v2/invoices/hodl', b2);
          } catch (e2) {
            console.warn(`[LNURLP] hints-only refused (${e2.message}) — retrying private-only`);
            const b3 = Object.assign({}, mintBody); delete b3.route_hints;
            hodl = await lndPost('/v2/invoices/hodl', b3);
          }
        } else {
          throw e1;
        }
      }
    } catch (e) {
      entry.status = 'burned'; entry.burn_reason = 'hodl mint failed: ' + e.message;
      lnurlpPersist();
      return jsonResponse(res, { status: 'ERROR', reason: 'could not mint invoice' }, 500);
    }
    lnurlpWatch(name, entry);
    console.log(`[LNURLP] ${name}: minted hold invoice ${amt} msat hash=${entry.hash.slice(0,16)}…`);
    return jsonResponse(res, { pr: hodl.payment_request, routes: [] });
  }
  if (method === 'GET' && path === '/quorum/defaults') {
    // v0.46 (S33, DP design): the LSP declares the default quorum endpoint
    // set; wallets merge additions on top, never fewer. World-readable —
    // reveals nothing but public explorer URLs.
    const eps = (process.env.LIJ_QUORUM_DEFAULT_ENDPOINTS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const defaults = eps.length ? eps : [
      'https://blockstream.info/api',
      'https://mempool.space/api',
      'https://btcscan.org/api',
      'https://mempool.emzy.de/api',
    ];
    return jsonResponse(res, { ok: true, endpoints: defaults });
  }
  if (method === 'POST' && path === '/client/prefs') {
    if (!authOk(req)) return jsonResponse(res, { ok: false, error: 'auth' }, 401);
    const bodyStr = await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 8192) { req.destroy(); resolve(null); } });
      req.on('end', () => resolve(b));
      req.on('error', () => resolve(null));
    });
    let body = null;
    try { body = JSON.parse(bodyStr); } catch (e) {}
    if (!body || !/^[0-9a-f]{66}$/.test((body.client_pubkey || '').toLowerCase())
        || typeof body.hold_ms !== 'number' || body.hold_ms < 0 || body.hold_ms > 86400000) {
      return jsonResponse(res, { ok: false, error: 'bad request' }, 400);
    }
    const pk = body.client_pubkey.toLowerCase();
    clientPrefs[pk] = Object.assign(clientPrefs[pk] || {}, { hold_ms: Math.round(body.hold_ms), updated: Date.now() });
    clientPrefsPersist();
    const eff = clientHoldCapMs(pk);
    touchWalletActive(String((body && body.client_pubkey) || '').toLowerCase());  /* v0.54.4 (d): prefs = awake proof */
    console.log(`[prefs] ${pk.slice(0, 16)}… hold_ms=${body.hold_ms} effective=${eff} (lsp cap ${OFFLINE_HOLD_CAP_MS})`);
    return jsonResponse(res, { ok: true, hold_ms_effective: eff, lsp_cap_ms: OFFLINE_HOLD_CAP_MS });
  }
  if (method === 'POST' && path === '/lnurl/register') {
    if (!authOk(req)) return jsonResponse(res, { ok: false, error: 'auth' }, 401);
    const bodyStr = await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 262144) { req.destroy(); resolve(null); } });
      req.on('end', () => resolve(b));
      req.on('error', () => resolve(null));
    });
    let body = null;
    try { body = JSON.parse(bodyStr); } catch (e) {}
    if (!body || !/^[a-z0-9_-]{2,32}$/.test(body.name || '')
        || !/^[0-9a-f]{66}$/.test((body.client_pubkey || '').toLowerCase())
        || !Array.isArray(body.hashes)) {
      return jsonResponse(res, { ok: false, error: 'bad request' }, 400);
    }
    const name = body.name.toLowerCase();
    const existing = lnurlpRegistry[name];
    if (existing && existing.client_pubkey.toLowerCase() !== body.client_pubkey.toLowerCase()) {
      return jsonResponse(res, { ok: false, error: 'name taken' }, 409);
    }
    const rec = existing || { client_pubkey: body.client_pubkey.toLowerCase(), entries: [], created: Date.now() };
    // 0.68.0: a new name is claimed at the neutral host first; taken there means
    // taken here (the wallet tries a longer name). Worker down = the name lives
    // on this LSP's host until the next boot sweep claims it.
    if (!existing && CONFIG.lnurlp.address_host) {
      const c = await lnurlpNameAt('claim', name);
      if (c === 'taken') return jsonResponse(res, { ok: false, error: 'name taken' }, 409);
      if (c === 'ok') rec.neutral = true;
    }
    const seen = new Set(rec.entries.map((e) => e.hash));
    let added = 0;
    for (const h of body.hashes.slice(0, 100)) {
      if (!h || !/^[0-9a-f]{64}$/.test((h.hash || '').toLowerCase())
          || !/^[0-9a-f]{64}$/.test((h.secret || '').toLowerCase())) continue;
      const hh = h.hash.toLowerCase();
      if (seen.has(hh)) continue;
      // 0.67.0: the wallet states each hash's life (engine v229: 30 years);
      // an older engine states none and gets its own old 30-day life.
      const nowS = lnurlpNowS();
      const exp = Number(h.expires);
      const entry = { hash: hh, secret: h.secret.toLowerCase(), status: 'free',
        expires: (Number.isFinite(exp) && exp > nowS) ? Math.floor(exp) : nowS + LNURLP_LEGACY_LIFE_S };
      if (Number.isInteger(h.index) && h.index >= 0) entry.index = h.index;
      rec.entries.push(entry);
      seen.add(hh); added += 1;
    }
    lnurlpRegistry[name] = rec;
    lnurlpPersist();
    const free = lnurlpLiveFree(rec).length;   // 0.67.0: live ones only
    touchWalletActive(rec.client_pubkey);  /* v0.55.1 R2 */
    console.log(`[LNURLP] register: ${name} += ${added} hash(es); live pool ${free}; next_index ${lnurlpNextIndex(rec)}`);
    return jsonResponse(res, { ok: true, pool_size: free, added: added, next_index: lnurlpNextIndex(rec), address: name + '@' + lnurlpAddrHost(req, rec) });   // 0.68.0: the address as written
  }
  // ── 0.57.0 (g): LNURLp name RELEASE — same auth wall as register; the
  // pubkey must match the record (a wrong name can't free someone else's).
  // Refused while any entry is reserved/accepted: a held payment's story
  // must finish (settle or burn) before the name dies.
  if (method === 'POST' && path === '/lnurl/release') {
    if (!authOk(req)) return jsonResponse(res, { ok: false, error: 'auth' }, 401);
    const relStr = await new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 4096) { req.destroy(); resolve(null); } });
      req.on('end', () => resolve(b));
      req.on('error', () => resolve(null));
    });
    let rel = null;
    try { rel = JSON.parse(relStr); } catch (e) {}
    const relName = String((rel && rel.name) || '').toLowerCase();
    const relPk = String((rel && rel.client_pubkey) || '').toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(relName) || !/^[0-9a-f]{66}$/.test(relPk)) {
      return jsonResponse(res, { ok: false, error: 'bad request' }, 400);
    }
    const relRec = lnurlpRegistry[relName];
    if (!relRec) return jsonResponse(res, { ok: false, error: 'not found' }, 404);
    if (relRec.client_pubkey.toLowerCase() !== relPk) {
      return jsonResponse(res, { ok: false, error: 'pubkey mismatch' }, 403);
    }
    const relBusy = relRec.entries.filter((e) => e.status === 'reserved' || e.status === 'accepted').length;
    if (relBusy) return jsonResponse(res, { ok: false, error: 'entries in flight: ' + relBusy }, 409);
    if (relRec.neutral) { await lnurlpNameAt('release', relName); }   // 0.68.0: free the neutral name too
    delete lnurlpRegistry[relName];
    lnurlpPersist();
    console.log(`[LNURLP] release: ${relName} freed by ${relPk.slice(0, 16)}…`);
    return jsonResponse(res, { ok: true, released: true });
  }

  // ── PENDING INTENTS GET (v0.38.0, S31) — Pulse W2 wake poll ────────────
  // GET /lsps2/pending[?client=<66-hex>] → non-terminal intents fusing the
  // offline held-HTLC map with shadow-SM truth (so OPENING/FORWARDING, not
  // just HOLDING, surface). Read-only; no body; no interceptor writes.
  // v0.54.4: HOISTED above the auth wall — this handler sat BELOW the
  // catch-all authOk gate since S31 and never answered a single wallet
  // (the frontend's bare fetch carries no auth header). A valid ?client
  // poll now also marks the wallet AWAKE for the (d) replay gate.
  // The POST form is retained untouched below the wall. Alpha note: without ?client
  // this lists ALL wallets' pending — fine single-tenant; revisit at the
  // external-tester gate.
  if (path === '/lsps2/pending' && method === 'GET') {
    try { const _q = new URL(req.url, 'http://lsp.local').searchParams; if (_q.get('client_pubkey')) leaseTouch(_q.get('client_pubkey'), 'api:/lsps2/pending'); } catch (_) {}   // 0.73.0
    let clientQ = null;
    try {
      const q = new URL(req.url, 'http://lsp.local').searchParams;
      const c = String(q.get('client') || '').trim().toLowerCase();
      if (/^[0-9a-f]{66}$/.test(c)) clientQ = c;
    } catch (_) {}
    if (clientQ) touchWalletActive(clientQ);  /* (d): wake-poll = awake proof */
    const byHash = {};
    // held-HTLC map: authoritative amounts + expiry for HOLDING forwards
    try {
      for (const [ph, held] of pendingHtlcsForOfflineWallets) {
        const cpk = String(held.client_pubkey || '').toLowerCase();
        if (clientQ && cpk !== clientQ) continue;
        byHash[ph] = {
          hash8: ph.slice(0, 16),
          state: 'HOLDING',
          held_msat: String(held.outgoing_amount_msat),
          auto_fail_height: held.auto_fail_height,
          client8: cpk ? cpk.slice(0, 16) : null,
        };
      }
    } catch (_) {}
    // shadow-SM snapshot: adds OPENING/FORWARDING and live age/state
    try {
      const snap = (SM && typeof SM.snapshot === 'function') ? SM.snapshot() : [];
      for (const it of snap) {
        let cpk = null;
        try {
          const b = promiseByPaymentHash.get(it.hash);
          cpk = (b && b.promise && b.promise.client_pubkey) || null;
        } catch (_) {}
        const cpkL = cpk ? String(cpk).toLowerCase() : null;
        if (clientQ && cpkL && cpkL !== clientQ) continue;
        if (clientQ && !cpkL && !byHash[it.hash]) continue; // unknown owner, filtered query
        const row = byHash[it.hash] || { hash8: String(it.hash).slice(0, 16), client8: cpkL ? cpkL.slice(0, 16) : null };
        row.state = it.state;            // SM state wins (more advanced than held)
        row.age_s = it.age_s;
        row.sum_msat = it.sum_msat;
        row.scid = it.scid;
        byHash[it.hash] = row;
      }
    } catch (_) {}
    return jsonResponse(res, { ok: true, pending: Object.values(byHash) });
  }

  if (!authOk(req)) {
    console.warn(`[Security] Unauthorized request from ${ip}`);
    return errResponse(res, 'Unauthorized', 401);
  }

  // LSPS1: Pre-opened channel request
  if (false) { /* LSPS1 disabled 2026-05-10 - re-enable only after Sybil resistance lands */

    // Rate limiting
    if (isRateLimited(ip)) {
      return errResponse(res,
        `Rate limit exceeded — max ${CONFIG.security.rate_limit_requests} channel requests per hour`,
        429
      );
    }

    let body;
    try { body = await readBody(req); }
    catch (e) { return errResponse(res, 'Invalid JSON'); }

    const { client_pubkey, client_host, inbound_sats, is_browser_node } = body;
    if (!client_pubkey) return errResponse(res, 'Missing client_pubkey');
    if (!client_host)   return errResponse(res, 'Missing client_host');

    // Validate pubkey format (basic hex check)
    if (!/^[0-9a-f]{66}$/.test(client_pubkey)) {
      console.warn(`[Security] Invalid pubkey format from ${ip}: ${client_pubkey}`);
      return errResponse(res, 'Invalid client_pubkey format');
    }

    // Channel size validation
    let size;
    try {
      size = validateChannelSize(inbound_sats);
    } catch (e) {
      return errResponse(res, e.message);
    }

    try {
      const hasChannel = await hasChannelWith(client_pubkey);
      if (hasChannel) {
        return jsonResponse(res, { ok: true, status: 'already_open', client_pubkey });
      }

      if (is_browser_node) {
        await waitForPeer(client_pubkey);
      } else {
        await connectPeer(client_pubkey, client_host);
      }

      const push = Math.floor(size / 2);
      const result = await openChannel(client_pubkey, size, push);

      return jsonResponse(res, {
        ok:            true,
        status:        'opening',
        channel_point: result.funding_txid_str
          ? `${result.funding_txid_str}:${result.output_index}`
          : null,
        size_sats:     size,
        push_sats:     push,
        client_pubkey,
      });
    } catch (e) {
      console.error('[LSPS1] Error:', e.message);
      return errResponse(res, e.message, 500);
    }
  }

  // v0.16: LSPS2 Phase A — get_info endpoint. Returns the LSP's service
  // terms in both machine-readable (LSPS2 protocol fields) and
  // human-readable (display strings) form. Auth required.
  // ── 0.63.0 (S42, DP GO — the sender's after-the-fact truth) ─────────────
  // "Did my payment settle?" for a wallet whose driver died mid-flight and whose
  // engine has already forgotten the fulfilled record. Answered from what this
  // box KNOWS: the LNURLp registry (static-address payments it was payee for),
  // LND's own invoice ledger (any invoice minted here), the HTLC state machine
  // (intercepted forwards). One in-memory pass + at most one LND read. Gated by
  // the adapter secret like every wallet call. Vocabulary: settled | failed |
  // pending | unpaid | unknown — never a guess.
  if (path === '/v1/outcome' && method === 'GET') {
    const _hq = String(new URL(req.url, 'http://lsp.local').searchParams.get('hash') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(_hq)) return jsonResponse(res, { ok: false, error: 'bad hash' }, 400);
    const out = { ok: true, hash: _hq, outcome: 'unknown', source: null, ts: Date.now() };
    try {
      for (const name of Object.keys(lnurlpRegistry)) {
        const e = (lnurlpRegistry[name].entries || []).find((x) => x.hash === _hq);
        if (e) {
          out.source = 'lnurlp'; out.status = e.status; out.burn_reason = e.burn_reason || null;
          out.outcome = e.status === 'settled' ? 'settled'
            : e.status === 'accepted' ? 'pending'
            : (e.status === 'free' || e.status === 'reserved') ? 'unpaid'
            : 'failed';   // burned: canceled / refunded / expired
          break;
        }
      }
    } catch (_) {}
    if (out.outcome === 'unknown' || out.outcome === 'unpaid') {
      try {
        const inv = await lndGet('/v1/invoice/' + _hq);
        if (inv && inv.state) {
          out.source = out.source || 'invoice'; out.invoice_state = inv.state;
          out.outcome = inv.state === 'SETTLED' ? 'settled' : inv.state === 'ACCEPTED' ? 'pending' : inv.state === 'CANCELED' ? 'failed' : 'unpaid';
        }
      } catch (_) {}
    }
    if (out.outcome === 'unknown' && SM && typeof SM.lookup === 'function') {
      try {
        const it = SM.lookup(_hq);
        if (it) {
          out.source = 'sm'; out.sm_state = it.state;
          out.outcome = it.state === 'SETTLED' ? 'settled'
            : (it.state === 'FAILED' || it.state === 'EXPIRED' || it.state === 'ABANDONED') ? 'failed'
            : (it.state === 'PASSTHROUGH' || it.state === 'RESUMED') ? 'unknown'
            : 'pending';
        }
      } catch (_) {}
    }
    return jsonResponse(res, out);
  }
  if (path === '/lsps2/get_info' && method === 'GET') {
    const c = CONFIG.lsps2;
    const _cq = (new URL(req.url, 'http://lsp.local').searchParams.get('client') || '').toLowerCase();   // 0.61.0
    const _client = /^[0-9a-f]{66}$/.test(_cq) ? _cq : null;
    const feePct = (c.fee_ppm / 10000).toFixed(c.fee_ppm < 1000 ? 3 : 2);
    const baseSat = Math.round(c.base_fee_msat / 1000);
    return jsonResponse(res, {
      // Protocol fields
      supported_versions:    c.supported_versions,
      min_payment_size_msat: String(c.min_payment_size_msat),
      max_payment_size_msat: String(c.max_payment_size_msat),
      base_fee_msat:         String(c.base_fee_msat),
      fee_ppm:               c.fee_ppm,
      promise_validity_secs: c.promise_validity_secs,
      client_trusts_lsp:     c.client_trusts_lsp,
      // LIJOX extension fields
      channel_open_fee_sats: openFeeBaselineSats(),   // 0.61.0: derived — same number the registry advertises
      open_fee_quote:        openFeeQuote(_client),    // 0.61.0: THIS wallet's next open, multipliers applied — an amount, not a formula
      channel_model:         c.channel_model,
      // v0.56.0 (O5 full balance availability): the payer-funds-the-floor
      // prefund and the live reserve policy — a manifest-era shopping fact
      // (Dm3 reserve_policy) advertised at the source. prefund_msat is the
      // CURRENT-mode advisory; the buy response stamps the binding value.
      prefund_msat:          String(floorModeAllowed(0) ? JIT_PREFUND_SATS * 1000 : 0),
      reserve_policy: (function () { const g = floorGovToday(); return {
        mode_now:          floorModeAllowed(0) ? 'floor' : 'percent',
        floor_sats:        Math.max(354, JIT_PREFUND_SATS, JIT_REMOTE_RESERVE_SATS || 0),
        percent_fallback:  '1%',
        floor_opens_today: g.count,
        floor_sats_today:  g.sats,
        max_opens_per_day: JIT_FLOOR_MAX_OPENS_PER_DAY,
        max_sats_per_day:  JIT_FLOOR_MAX_SATS_PER_DAY,
      }; })(),
      // Human-readable display
      human_summary:            buildLsps2HumanSummary(),
      fee_pct_display:          `${feePct}%`,
      fee_sat_per_send_display: `${baseSat} sat + ${feePct}% per send`,
      channel_open_fee_display: `${fmtNum(openFeeBaselineSats())} sats (or ${(c.open_fee_ppm / 10000).toFixed(2)}% of the payment, whichever is more)`,   // 0.69.0
      // v0.20 VARIABLE: open-amount terms (engine v188+ reads this; when
      // this field is absent the engine refuses open-amount gracefully).
      variable: {
        enabled:      c.variable_enabled,
        // v0.33.0 (S30): the advertised terms ARE the live price — captions
        // built from these match the charge (buy snapshots the same
        // multiplier seconds later). Raw base + multiplier alongside for
        // transparency and the published rule.
        fee_ppm:      Math.round(c.open_fee_ppm * scarcityMultPct() / 100),
        min_fee_msat: String(Math.round(c.open_fee_min_msat * scarcityMultPct() / 100)),
        base_fee_ppm:      c.open_fee_ppm,
        base_min_fee_msat: String(c.open_fee_min_msat),
        scarcity_mult_pct: scarcityMultPct(),
        scarcity_rule: 'base terms while on-chain headroom ≥ ' + c.jit_scarcity_ramp_start_sats + ' sats above the ' + c.jit_min_onchain_reserve_sats + '-sat floor; rises linearly to ' + c.jit_scarcity_max_pct + '% at zero headroom; opens refuse below the floor',
      },
      // Pricing transparency
      pricing_inputs:        c.pricing_inputs,
    });
  }

  // v0.16: LSPS2 Phase A — buy endpoint. Issues a JIT channel promise.
  // Body: { version, payment_size_msat, token? }
  //   - version: must be 1
  //   - payment_size_msat: integer, msat (NOT sat), within [min, max]
  //   - token: optional, ignored in Phase A (Phase D may use for paid tiers)
  // Returns: { jit_channel_scid, lsp_pubkey, fee_msat, promise_expires_at,
  //           human_summary }
  // Side effect: stores the promise in pendingJitBuys keyed by jit_channel_scid.
  // Phase D (htlc-interceptor) is what actually opens the channel when the
  // matching HTLC arrives. In Phase A there is no enforcement that the
  // promise gets used; it just expires.
  // v0.18 Phase D.2: /lsps2/pending — read-only query for HTLCs being held
  // for a specific wallet. Body: { client_pubkey }. The held HTLCs surface
  // for UI display ("you have a pending payment"). Adapter-side processing
  // is automatic via reconnect-poll, so this endpoint is informational only.
  if (path === '/lsps2/pending' && method === 'POST') {
    // v0.54.4: 0.54.1's GET plumbing here was REDUNDANT and unreachable —
    // the real GET wake-poll endpoint is the v0.38 PENDING INTENTS handler,
    // now hoisted ABOVE the auth wall (it sat below it, dead, since S31).
    let body;
    try { body = await readBody(req); }
    catch (e) { return errResponse(res, `Invalid JSON body: ${e.message}`); }
    const pubkey = (body && body.client_pubkey || '').toLowerCase().trim();
    if (!pubkey || pubkey.length !== 66 || !/^[0-9a-f]{66}$/.test(pubkey)) {
      return errResponse(res, 'client_pubkey must be 66 lowercase hex chars');
    }
    touchWalletActive(pubkey);  /* (d): a pending poll proves the wallet is awake */
    const pending = [];
    for (const [paymentHashHex, held] of pendingHtlcsForOfflineWallets) {
      if (held.client_pubkey.toLowerCase() === pubkey) {
        pending.push({
          payment_hash:         paymentHashHex,
          scid:                 held.outgoing_scid_hex,
          outgoing_amount_msat: String(held.outgoing_amount_msat),
          incoming_amount_msat: String(held.incoming_amount_msat),
          outgoing_expiry:      held.outgoing_expiry,
          auto_fail_height:     held.auto_fail_height,
          htlc_received_at:     held.htlc_received_at,
        });
      }
    }
    return jsonResponse(res, { pending });
  }


  // Option B: register the BOLT11 payment_secret for a JIT promise. The wallet
  // POSTs this immediately after building its JIT invoice and BEFORE showing it,
  // so the secret is in place before any payment can arrive. We need it to
  // rebuild the final hop in sendToRouteV2 -- the secret is in the wallet's onion
  // layer, which this node cannot decrypt. NOT the preimage (cannot claim funds).
  // Body: { jit_channel_scid (16 hex), payment_secret (64 hex), total_msat }.
  if (path === '/lsps2/register_secret' && method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return errResponse(res, `Invalid JSON body: ${e.message}`); }

    // B-10: hash-keyed registration for PLAIN invoices (no promise, no scid).
    // The wallet posts { payment_hash, payment_secret, total_msat } at invoice
    // creation; held forwards read it for the trampoline final hop. Bounded
    // FIFO 500. The JIT (scid-keyed) path below is untouched.
    if (body && body.payment_hash && !body.jit_channel_scid) {
      const ph  = String(body.payment_hash).toLowerCase().trim();
      const sec = String(body.payment_secret || '').toLowerCase().trim();
      const tm  = typeof body.total_msat === 'string' ? parseInt(body.total_msat, 10) : body.total_msat;
      if (!/^[0-9a-f]{64}$/.test(ph))  return errResponse(res, 'payment_hash must be 64 lowercase hex chars');
      if (!/^[0-9a-f]{64}$/.test(sec)) return errResponse(res, 'payment_secret must be 64 lowercase hex chars (32 bytes)');
      if (!Number.isInteger(tm) || tm <= 0) return errResponse(res, 'total_msat must be a positive integer');
      invoiceSecretsByHash.set(ph, { payment_secret: sec, total_msat: String(tm), at: Date.now() });
      while (invoiceSecretsByHash.size > 500) {
        invoiceSecretsByHash.delete(invoiceSecretsByHash.keys().next().value);
      }
      console.log(`[B-10] invoice secret registered for hash=${ph.slice(0,16)}...`);
      try { SM.emit('secret_registered', { hash: ph }); } catch (_) {}
      return jsonResponse(res, { ok: true, keyed: 'payment_hash' });
    }
    const scid = (body && body.jit_channel_scid || '').toLowerCase().trim();
    const secretHex = (body && body.payment_secret || '').toLowerCase().trim();
    const totalMsat = typeof body.total_msat === 'string'
      ? parseInt(body.total_msat, 10) : body.total_msat;

    if (!/^[0-9a-f]{16}$/.test(scid)) {
      return errResponse(res, 'jit_channel_scid must be 16 lowercase hex chars');
    }
    if (!/^[0-9a-f]{64}$/.test(secretHex)) {
      return errResponse(res, 'payment_secret must be 64 lowercase hex chars (32 bytes)');
    }
    // v0.20 VARIABLE: total_msat 0 is the OPEN-AMOUNT SENTINEL (engine
    // v188 registers it for zero-amount invoices). 0 stays falsy on the
    // promise, so openChannelAndForward's existing fallback declares
    // total = sum - fee at flush. Negative/non-integer still rejected.
    if (!Number.isInteger(totalMsat) || totalMsat < 0) {
      return errResponse(res, 'total_msat must be a non-negative integer (0 = open-amount sentinel)');
    }

    // Look up the promise under the same key the buy handler stored it under.
    const promise = pendingJitBuys.get(scid);
    if (!promise) {
      return errResponse(res, `No pending JIT promise for scid ${scid} (expired, or buy not called)`, 404);
    }
    promise.payment_secret = Buffer.from(secretHex, 'hex');
    promise.total_amt_msat = totalMsat;
    touchWalletActive(promise.client_pubkey);  /* v0.55.1 R2 */
    console.log(`[LSPS2] register_secret: scid=${scid} total_msat=${totalMsat} (payment_secret stored on promise)`);
    try { SM.emit('secret_registered', { scid: String(scid) }); } catch (_) {}
    return jsonResponse(res, { ok: true, scid });
  }

  if (path === '/lsps2/buy' && method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return errResponse(res, `Invalid JSON body: ${e.message}`); }

    const c = CONFIG.lsps2;
    const version          = body.version;
    const paymentSizeMsat  = body.payment_size_msat;

    if (version !== 1) {
      return errResponse(res, `Unsupported version: ${version} (supported: ${c.supported_versions.join(', ')})`);
    }
    // Accept either number or numeric string per LSPS2 spec (large integers
    // are commonly stringified for JSON safety).
    const sizeMsat = typeof paymentSizeMsat === 'string'
      ? parseInt(paymentSizeMsat, 10)
      : paymentSizeMsat;
    // v0.20 VARIABLE: absent or 0 payment_size_msat = OPEN-AMOUNT buy. The
    // engine (v188+) omits the field entirely for zero-amount invoices; the
    // channel is sized from the observed shard sum at quiescence flush.
    const isVariableBuy = (paymentSizeMsat === undefined || paymentSizeMsat === null || sizeMsat === 0);
    if (isVariableBuy && !c.variable_enabled) {
      return errResponse(res, 'Open-amount (variable) JIT is not enabled on this LSP');
    }
    if (!isVariableBuy) {
      if (!Number.isInteger(sizeMsat) || sizeMsat <= 0) {
        return errResponse(res, 'Invalid payment_size_msat (expect positive integer)');
      }
      if (sizeMsat < c.min_payment_size_msat) {
        return errResponse(res, `payment_size_msat ${sizeMsat} below minimum ${c.min_payment_size_msat}`);
      }
      if (sizeMsat > c.max_payment_size_msat) {
        return errResponse(res, `payment_size_msat ${sizeMsat} above maximum ${c.max_payment_size_msat}`);
      }
    }

    // v0.18 Phase A.1: require client_pubkey (66 lowercase hex chars).
    const clientPubkey = (body.client_pubkey || '').toLowerCase().trim();
    if (!clientPubkey || clientPubkey.length !== 66 || !/^[0-9a-f]{66}$/.test(clientPubkey)) {
      return errResponse(res, 'client_pubkey must be 66 lowercase hex chars (compressed secp256k1 pubkey)');
    }

    // Reap expired promises before insert (cheap; bounded by map size).
    reapExpiredJitBuys();

    const scid = generateJitScid();
    const now = Date.now();
    const expiresAt = now + (c.promise_validity_secs * 1000);
    const feeMsat = isVariableBuy ? 0 : Number(channelOpenFeeMsat(sizeMsat, clientPubkey));  // 0.69.0: the one law (was a flat knob); open-amount fee is computed at flush

    // v0.18 Phase D.2: store client_pubkey + dual timestamps.
    // - quote_expires_at: SOFT (advisory; new invoices issued before this)
    // - reservation_expires_at: HARD (HTLCs FAILed after this)
    // - promise_expires_at: kept for backwards-compat with the /buy response
    //   field name; equals quote_expires_at.
    const reservationExpiresAt = now + CONFIG.lsps2.reservation_validity_hours * 3600 * 1000;
    // v0.56.0 (O5): stamp the binding prefund at BUY (the wallet builds the
    // invoice from this; the open-time governor check remains authoritative
    // for the RESERVE — a between-buy-and-open flip is logged, never lossy:
    // the paid prefund still forwards to the user's side).
    const prefundMsat = floorModeAllowed(0) ? JIT_PREFUND_SATS * 1000 : 0;
    pendingJitBuys.set(scid, {
      mode:                    isVariableBuy ? 'variable' : 'fixed',   // v0.20
      payment_size_msat:       isVariableBuy ? 0 : sizeMsat,
      fee_msat:                feeMsat,
      prefund_msat:            prefundMsat,   // v0.56.0 (O5)
      client_pubkey:           clientPubkey,
      scarcity_mult_pct:       scarcityMultPct(),   // v0.33.0: snapshot — flush charges THIS
      promise_expires_at:      expiresAt,
      quote_expires_at:        expiresAt,
      reservation_expires_at:  reservationExpiresAt,
      created_at:              now,
      client_ip:               ip,
    });

    const validMin = Math.floor(c.promise_validity_secs / 60);
    const summary = `Pay ${fmtNum(Math.ceil(feeMsat / 1000))} sats to open a channel. `
                  + `You'll be able to receive up to ${fmtNum(Math.floor(sizeMsat / 1000))} sats after this. `
                  + `Offer valid for ${validMin} minutes.`;

    touchWalletActive(clientPubkey);  /* v0.55.1 R2: a buy proves awake */
    console.log(`[LSPS2] Buy: scid=${scid} size=${sizeMsat}msat fee=${feeMsat}msat expires=${new Date(expiresAt).toISOString()} ip=${ip}`);

    return jsonResponse(res, {
      jit_channel_scid:   scid,
      lsp_pubkey:         CONFIG.node.pubkey,
      fee_msat:           String(feeMsat),
      prefund_msat:       String(prefundMsat),   // v0.56.0 (O5): binding for this promise
      promise_expires_at: expiresAt,
      human_summary:      summary,
    });
  }

  // Node info
  if (path === '/info' && method === 'GET') {
    try {
      const info = await lndGet('/v1/getinfo');
      return jsonResponse(res, {
        pubkey:       CONFIG.node.pubkey,
        host:         CONFIG.node.host,
        name:         CONFIG.node.name,
        fee_ppm:      CONFIG.node.fee_ppm,
        channels:     info.num_active_channels,
        synced:       info.synced_to_chain,
        ws_proxy_url: CONFIG.public.wss_url,  // v0.15: was NODE_HOST-derived, broken
        channel_limits: {
          min_sats: CONFIG.channel.min_sats,
          max_sats: CONFIG.channel.max_sats,
        },
      });
    } catch (e) {
      return errResponse(res, e.message, 500);
    }
  }

  // v0.8 — Phase 10b routing: proxy LND's /v1/graph/routes for LiJ wallet
  // pathfinding. Wallet calls this for multi-hop sends where destination is
  // not the direct LSP. Adapter forwards to LND using its own server-side
  // macaroon, so wallets don't need LND credentials.
  //
  // Already past authOk above — caller authenticated via adapter secret.
  if (path.startsWith('/v1/graph/routes/') && method === 'GET') {
    const parts = path.split('/').filter(Boolean);
    // Expected shape: ['v1', 'graph', 'routes', '<pubkey>', '<amount>']
    if (parts.length !== 5) {
      return errResponse(res, 'Bad path — expected /v1/graph/routes/{pubkey}/{amount_sats}');
    }
    const destPubkey = parts[3];
    const amountSats = parts[4];

    if (!/^[0-9a-f]{66}$/.test(destPubkey)) {
      return errResponse(res, 'Invalid destination pubkey format (expect 66 hex chars)');
    }
    if (!/^\d+$/.test(amountSats) || parseInt(amountSats, 10) <= 0) {
      return errResponse(res, 'Invalid amount — must be positive integer sats');
    }

    console.log(`[Phase10b] Route query: dest=${destPubkey.slice(0,20)}... amount=${amountSats} sats from ${ip}`);

    // v0.11: ensure critical peers are connected before serving the query
    // (cheap if already up, restorative if Umbrel dropped). Don't block on
    // failure — let LND respond with its own error if peer is genuinely down.
    try { await ensureCriticalPeersConnected(); } catch (e) {
      console.warn(`[Phase10b] Peer keepalive warning: ${e.message}`);
    }

    try {
      // LND REST: GET /v1/graph/routes/{pub_key}/{amt}  (amt in satoshis)
      const lndResp = await lndGet(`/v1/graph/routes/${destPubkey}/${amountSats}`);
      // Pass through unchanged so the wallet's parse_lnd_route_response sees
      // the native LND format it expects.
      return jsonResponse(res, lndResp);
    } catch (e) {
      console.error(`[Phase10b] LND route query failed: ${e.message}`);
      return errResponse(res, `LND route query failed: ${e.message}`, 502);
    }
  }

  // v0.13 (extends v0.11 + v0.12) — Phase 10b retry: POST /v1/route/build accepts the
  // full QueryRoutes parameter set including route_hints. Lets wallets pay
  // destinations behind unannounced channels (WoS, Strike, custodial wallets).
  //
  // Wallet sends:
  //   { destination, amount_sat, route_hints, fee_limit_sat? }
  // Adapter calls LND POST /v1/graph/routes/{pubkey}/{amount} with the body
  // shape LND expects (route_hints embedded in JSON body), then returns
  // LND's response verbatim so the wallet's parse_lnd_route_response works
  // unchanged.
  //
  // route_hints shape (matches LND/BOLT11):
  //   [
  //     { hop_hints: [
  //         { node_id, chan_id, fee_base_msat, fee_proportional_millionths,
  //           cltv_expiry_delta }
  //       ] }
  //   ]
  //
  // Already past authOk above.
  if (path === '/v1/route/build' && method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return errResponse(res, `Invalid JSON body: ${e.message}`);
    }

    const destination   = body.destination;
    const amountSat     = body.amount_sat;
    const routeHints    = body.route_hints;
    const feeLimitSat   = body.fee_limit_sat;
    const ignoredPairs  = body.ignored_pairs;  // v0.13: wallet retry exclusions

    if (!destination || !/^[0-9a-f]{66}$/.test(destination)) {
      return errResponse(res, 'Invalid or missing destination (expect 66 hex chars)');
    }
    // ── 0.57.0 (i): destination == this LSP — server twin of engine v222.
    // LND asked to route from itself to itself over public hints can only
    // answer out-and-back on one channel (which LDK rightly rejects); the
    // wallet's v222 self-hop is the correct route and ignores this call's
    // result anyway. Refuse with a named error instead of a doomed query.
    if (LOCAL_PUBKEY && destination.toLowerCase() === String(LOCAL_PUBKEY).toLowerCase()) {
      // 0.62.1 (S42 field specimen, DP 2026-09-01: iOS → Android same-LSP 4,000-sat
      // send, 5/5 "HTTP 422" in two seconds): the 0.57.0 (i) refusal answered
      // 422, but the engine's fetch helper turns ANY non-OK status into a failed
      // attempt BEFORE apply_lsp_route_and_send — the v222 "ignore the result"
      // branch never ran, so every same-LSP send through the retry path failed
      // since 0.57.0. Answer 200 with an empty route body: the engine's own
      // self-hop takes over as designed. (Durable form: the engine skips the
      // ask for internal sends — next engine release.)
      console.log('[Phase10b] route/build: destination is this LSP — answering empty (internal send, wallet self-hop applies)');
      return jsonResponse(res, { ok: false, error: 'destination_is_lsp', routes: [], internal: true }, 200);
    }
    if (!Number.isInteger(amountSat) || amountSat <= 0) {
      return errResponse(res, 'Invalid or missing amount_sat (expect positive integer)');
    }
    if (routeHints !== undefined && !Array.isArray(routeHints)) {
      return errResponse(res, 'route_hints must be an array (or omitted)');
    }
    // v0.13: validate ignored_pairs shape if present
    if (ignoredPairs !== undefined) {
      if (!Array.isArray(ignoredPairs)) {
        return errResponse(res, 'ignored_pairs must be an array (or omitted)');
      }
      for (const pair of ignoredPairs) {
        if (!pair || typeof pair !== 'object') {
          return errResponse(res, 'ignored_pairs entries must be objects with from/to');
        }
        if (!/^[0-9a-f]{66}$/.test(pair.from || '')) {
          return errResponse(res, 'ignored_pairs[].from must be 66 hex chars (compressed pubkey)');
        }
        if (!/^[0-9a-f]{66}$/.test(pair.to || '')) {
          return errResponse(res, 'ignored_pairs[].to must be 66 hex chars (compressed pubkey)');
        }
      }
    }

    const numHints = Array.isArray(routeHints) ? routeHints.length : 0;
    const numExcluded = Array.isArray(ignoredPairs) ? ignoredPairs.length : 0;
    console.log(`[Phase10b] POST route/build: dest=${destination.slice(0,20)}... amount=${amountSat} sats hints=${numHints} excluded=${numExcluded} from ${ip}`);

    // v0.11: force a peer check before this query — Phase 10b's whole point is
    // multi-hop routing through Umbrel, so we want the upstream channel active
    // before LND tries to find a path.
    try { await ensureCriticalPeersConnected(true); } catch (e) {
      console.warn(`[Phase10b POST] Peer keepalive warning: ${e.message}`);
    }

    // Build the LND POST body. LND's QueryRoutes accepts pub_key + amt in the
    // URL path AND additional fields in the body. We put pub_key/amt in both
    // path and body — the URL-path version is what LND actually uses for those
    // two fields, and the body is required to be valid JSON.
    const lndBody = {
      pub_key: destination,
      amt:     String(amountSat),
    };
    if (Array.isArray(routeHints) && routeHints.length > 0) {
      lndBody.route_hints = routeHints;
    }
    // v0.13: pass through ignored_pairs to LND's QueryRoutes for retry-with-
    // exclusion. LND REST expects bytes fields as base64 — convert from the
    // hex format wallet sends. Wallet sends [{ from: <66-hex>, to: <66-hex> }];
    // LND expects [{ from: <base64-of-33-bytes>, to: <base64-of-33-bytes> }].
    if (Array.isArray(ignoredPairs) && ignoredPairs.length > 0) {
      lndBody.ignored_pairs = ignoredPairs.map(pair => ({
        from: Buffer.from(pair.from, 'hex').toString('base64'),
        to:   Buffer.from(pair.to,   'hex').toString('base64'),
      }));
    }
    if (Number.isInteger(feeLimitSat) && feeLimitSat > 0) {
      lndBody.fee_limit = { fixed: String(feeLimitSat) };
    }
    // v0.24.1 (S29): mission-control-weighted pathfinding. The A/B probe
    // convicted MC-blind QueryRoutes: fee-cheapest one-shot paths thread
    // stale edges (mid-hops in the 857k–938k graveyard band) while the
    // same query with MC on returns the proven ACINQ→e960fd83 corridor.
    // Default ON; ROUTE_BUILD_USE_MC=off restores the old behavior.
    if ((process.env.ROUTE_BUILD_USE_MC || 'on') !== 'off') {
      lndBody.use_mission_control = true;
    }

    try {
      // LND REST POST: /v1/graph/routes/{pub_key}/{amt} with body
      // B-1v2: wrapper synthesizes the one-hop route when LND cannot answer
      // (same-LSP recipient offline, or JIT promise unknown to the graph).
      // The B-2 alias rewrite below dialect-corrects synthesized hops too.
      const lndResp = await routeBuildWithSynthesis(destination, amountSat, lndBody, routeHints);
      // v0.12: attach our own outgoing-channel policy for the first hop so the
      // wallet can correctly compute the LSP self-hop fee. Without this the
      // wallet falls back to ChannelDetails.counterparty.forwarding_info which
      // describes the WRONG direction (counterparty→wallet, not wallet→peer-via-us).
      try {
        const firstHopChanId = lndResp && lndResp.routes && lndResp.routes[0]
          && lndResp.routes[0].hops && lndResp.routes[0].hops[0]
          && lndResp.routes[0].hops[0].chan_id;
        if (firstHopChanId) {
          const policy = await lookupChannelPolicy(firstHopChanId);
          if (policy) {
            lndResp.lsp_first_hop_policy = policy;
            console.log(`[Phase10b] lsp_first_hop_policy for chan ${firstHopChanId}: base=${policy.fee_base_msat} ppm=${policy.fee_proportional_millionths} cltv=${policy.cltv_expiry_delta}`);

            // v0.14 cltv adjustment: bake the LSP's outgoing cltv_expiry_delta
            // into route.total_time_lock. LND's QueryRoutes treats us as the
            // source and returns routes where total_time_lock equals
            // hops[0].expiry (no delta added for "us" forwarding through our
            // own channel). But the actual sender is the wallet one hop
            // upstream, so the LSP IS a real forwarder here and must apply
            // its own outgoing cltv_delta. Without this, the wallet sees
            // cltv_expiry_delta=0 for the LSP→destination hop in the parsed
            // LDK route, builds an onion with no buffer at that hop, and
            // the LSP rejects the HTLC with incorrect_cltv_expiry(0x100d).
            //
            // Idempotent: only adjusts upward if needed. Multi-hop routes
            // where LND already accounts for the cltv chain are left alone.
            const lspCltvDelta = policy.cltv_expiry_delta;
            if (Number.isInteger(lspCltvDelta) && lspCltvDelta > 0
                && Array.isArray(lndResp.routes)) {
              for (const route of lndResp.routes) {
                if (!route || !Array.isArray(route.hops) || route.hops.length === 0) continue;
                const ttl = Number(route.total_time_lock);
                const e0  = Number(route.hops[0].expiry);
                if (!Number.isInteger(ttl) || !Number.isInteger(e0)) continue;
                const minRequired = e0 + lspCltvDelta;
                if (ttl < minRequired) {
                  console.log(`[Phase10b] v0.14 cltv adjustment: total_time_lock ${ttl} → ${minRequired} (+${lspCltvDelta} for LSP outgoing on chan ${firstHopChanId})`);
                  route.total_time_lock = minRequired;
                }
              }
            }
          } else {
            console.warn(`[Phase10b] no lsp_first_hop_policy attached (lookup failed for chan ${firstHopChanId})`);
          }
        }
      } catch (e) {
        console.warn(`[Phase10b] lsp_first_hop_policy enrichment skipped: ${e.message}`);
      }
      // B-2: dialect-correct the answer -- any hop over one of OUR alias-
      // negotiated channels must carry the ALIAS (what the switch indexes),
      // not the real scid (which it refuses by design). Runs AFTER the
      // policy/cltv steps so those keep using the real scid for lookups.
      if (lndResp && lndResp.routes) { await rewriteHopsToAliases(lndResp.routes); }
      // B-7: hold signal for the sender. _synth marks answers we built
      // because LND had none -- destination offline (channel) or
      // unchanneled (jit). Tell the wallet a bounded hold is in play.
      if (lndResp && lndResp._synth && typeof OFFLINE_HOLD_ENABLED !== 'undefined' && OFFLINE_HOLD_ENABLED) {
        // B-12: only signal a hold when one is PLAUSIBLE -- synth also fires
        // for online JIT (promise scids are never in LND's graph), and an
        // online recipient completes in seconds; the held UI would be noise.
        const _peerLive = await isPeerConnected(destination).catch(() => false);
        if (!_peerLive) {
          // v0.56.2 (S36 s3 conviction): the cap told to the SENDER is the
          // DESTINATION wallet's effective hold (same clientHoldCapMs the
          // hold arming and the wake push use) — the old line quoted the LSP
          // CEILING (3600s) while the armed watchdog ran the client's 180s,
          // so the sender was told to wait an hour for a 3-minute hold.
          const _dstHoldS = Math.max(1, Math.round(clientHoldCapMs(destination) / 1000));
          lndResp.lsp_hold = { active: true, kind: lndResp._synth, cap_s: _dstHoldS };
          console.log(`[B-7] hold signal attached (kind=${lndResp._synth}, cap=${_dstHoldS}s — destination's dial)`);
        }
      }
      return jsonResponse(res, lndResp);
    } catch (e) {
      console.error(`[Phase10b POST] LND route query failed: ${e.message}`);
      return errResponse(res, `LND route query failed: ${e.message}`, 502);
    }
  }

  // v0.19: LIJOX registry admin dump. Same `x-adapter-secret` auth as every
  // other admin route (we're past the authOk gate above). Rate-limited via
  // the SEPARATE admin rate limiter (v0.18.5; 60/min default), so legitimate
  // operator inspection doesn't share the 3/hour channel-open limit.
  // Returns the full registry contents grouped by node_pubkey. Exposes the
  // same data the LSP already sees via LND operation (funding outpoints,
  // channel values, counterparties) plus channel_keys_id_hex which is
  // meaningless without the wallet's seed — so no incremental sensitive-data
  // exposure vs the operator's existing visibility.
  // ── B-5: JIT flight-panel (read-only) ────────────────────────────────────
  if (path === '/health/jit' && method === 'GET') {
    if (isAdminRateLimited(ip)) {
      return errResponse(res, 'Rate limit exceeded', 429);
    }
    // v0.53 (P7): /health/jit is an OPS view (reserve figures, per-wallet
    // hold counts, world-conduit state). Public only when the operator
    // opts into detail; otherwise it requires the admin secret.
    if ((process.env.HEALTH_DETAIL || 'off') !== 'on' && !authOk(req)) {
      return errResponse(res, 'Unauthorized (set HEALTH_DETAIL=on to make this public, or send the admin secret)', 401);
    }
    try {
      const [chans, pend, info, bal] = await Promise.all([
        lndGet('/v1/channels').catch(() => ({ channels: [] })),
        lndGet('/v1/channels/pending').catch(() => ({})),
        lndGet('/v1/getinfo').catch(() => ({})),
        lndGet('/v1/balance/blockchain').catch(() => ({})),
      ]);
      // v0.47: the "world conduit" is the first critical peer (operator-set); no baked pubkey.
      const WORLD_PEER_PUBKEY = (CONFIG.critical_peers[0] || {}).pubkey || '';
      const world = WORLD_PEER_PUBKEY ? (chans.channels || []).find(c => c.remote_pubkey === WORLD_PEER_PUBKEY) : undefined;
      const pendingOpens = ((pend.pending_open_channels) || []).map(p => ({
        peer: (p.channel && p.channel.remote_node_pub || '').slice(0, 16),
        capacity: p.channel && p.channel.capacity,
        confirmation_height: p.confirmation_height,
      }));
      const pendingByPeer = {};
      for (const p of pendingOpens) pendingByPeer[p.peer] = (pendingByPeer[p.peer] || 0) + 1;
      const nowMs = Date.now();
      const promises = [];
      for (const [scidHex, pr] of pendingJitBuys) {
        promises.push({ scid: scidHex.slice(0, 12), client: (pr.client_pubkey || '').slice(0, 16), expires_in_s: Math.round(((pr.reservation_expires_at || 0) - nowMs) / 1000) });
      }
      const holds = [];
      for (const [ph, h] of pendingHtlcsForOfflineWallets) {
        holds.push({ payment_hash: ph.slice(0, 16), kind: h.kind || 'jit', client: (h.client_pubkey || '').slice(0, 16), age_s: Math.round((nowMs - (h.htlc_received_at || nowMs)) / 1000) });
      }
      return jsonResponse(res, {
        ok: true,
        tip: info.block_height || 0,
        onchain_float_sat: bal.confirmed_balance || bal.total_balance || '0',
        world_channel: world ? {
          active: !!world.active,
          lsp_can_send_out: Number(world.local_balance || 0) - Number(world.local_chan_reserve_sat || 0),
          lsp_can_receive_in: Number(world.remote_balance || 0) - Number(world.remote_chan_reserve_sat || 0),
          capacity: world.capacity,
        } : null,
        client_channels: (chans.channels || []).filter(c => c.remote_pubkey !== UMBREL).map(c => ({
          peer: c.remote_pubkey.slice(0, 16),
          active: !!c.active,
          lsp_spendable: Number(c.local_balance || 0) - Number(c.local_chan_reserve_sat || 0),
          client_spendable: Number(c.remote_balance || 0) - Number(c.remote_chan_reserve_sat || 0),
        })),
        pending_opens: pendingOpens,
        pending_opens_by_peer: pendingByPeer,
        live_promises: promises,
        aggregating: (() => {
          const out = [];
          for (const [scidHex, pr] of pendingJitBuys) {
            if (pr._shards && pr._shards.size) {
              out.push({
                scid: scidHex.slice(0, 12),
                shards: pr._shards.size,
                sum_msat: String(pr._shard_sum_msat),
                window_remaining_s: Math.max(0, Math.round(((pr._agg_deadline || 0) - Date.now()) / 1000)),
              });
            }
          }
          return out;
        })(),
        held_htlcs: holds,
      });
    } catch (e) {
      return errResponse(res, `health/jit failed: ${e.message}`, 500);
    }
  }
  // v0.21: LEASE admin surfaces. GET /lease/status = the observation
  // panel (per-channel countdowns; zero LND I/O — state is at most one
  // cycle old). POST /lease/ttl = the per-channel override setter and
  // THE endpoint the future paid-extension flow calls after payment.
  // ── 0.57.0 (b): gated loop aggregate. Sits below the catch-all authOk
  // wall like /lease/status — NEVER on /health (public surface stays
  // minimal). stale = no cycle within max(5×period, 120s).
  if (path === '/ops/loops' && method === 'GET') {
    const now = Date.now();
    const loops = {};
    for (const [k, v] of Object.entries(loopStamps)) {
      loops[k] = {
        count: v.count,
        period_ms: v.period_ms,
        last_ms_ago: v.last ? (now - v.last) : null,
        stale: v.last ? (now - v.last) > Math.max(5 * v.period_ms, 120000) : true,
      };
    }
    // ── 0.59.0 (a, DP RULED S41): SCB BACKUP DASHBOARD — a save failure on
    // either leg (LAN Pi / cloud worker) must DISPLAY here, the surface the
    // operator already checks. The push scripts (ops/um890-scb/ in the lij
    // repo) stamp status-{local,cloud}.json on EVERY outcome; this block
    // reads them, computes staleness against the daily belt (26h), and
    // raises backup_alert when any configured leg failed its last attempt
    // or went stale. Absent file = leg not configured — reported, never
    // alarmed (an LSP without the backup kit stays quiet).
    const SCB_STATE_DIR = process.env.LIJ_SCB_STATE_DIR || '/var/lib/lij-scb';
    const backup = {};
    let backupAlert = false;
    for (const leg of ['local', 'cloud']) {
      try {
        const st = JSON.parse(require('fs').readFileSync(`${SCB_STATE_DIR}/status-${leg}.json`, 'utf8'));
        const lastOkAgoS = st.last_ok ? Math.round(now / 1000 - st.last_ok) : null;
        const stale = lastOkAgoS === null || lastOkAgoS > 26 * 3600;
        const legAlert = st.ok === false || stale;
        backup[leg] = {
          configured: true,
          ok: st.ok !== false,
          err: st.err || '',
          last_ok_ago_s: lastOkAgoS,
          last_attempt_ago_s: st.last_attempt ? Math.round(now / 1000 - st.last_attempt) : null,
          stale,
          alert: legAlert,
        };
        if (legAlert) backupAlert = true;
      } catch (e) {
        backup[leg] = { configured: false };
      }
    }
    return jsonResponse(res, { ok: true, pid: process.pid, uptime_s: Math.round(process.uptime()), backup_alert: backupAlert, backup, loops });
  }

  if (path === '/lease/status' && method === 'GET') {
    if (isAdminRateLimited(ip)) return errResponse(res, 'Rate limit exceeded', 429);
    const nowMs = Date.now();
    const channels = Object.entries(leaseState.channels).map(([cp, rec]) => {
      const ttl = leaseTtlDays(rec);
      const idleDays = (nowMs - rec.last_seen_ms) / 86400000;
      return {
        chan_point: cp,
        peer: (rec.peer || '').slice(0, 16),
        last_seen: new Date(rec.last_seen_ms).toISOString(),
        idle_days: Number(idleDays.toFixed(3)),
        ttl_days_effective: ttl,
        ttl_override: (typeof rec.ttl_days === 'number' && rec.ttl_days > 0) ? rec.ttl_days : null,
        days_remaining: Number((ttl - idleDays).toFixed(3)),
        excluded: CONFIG.lease.exclude.includes(cp),
      };
    });
    return jsonResponse(res, {
      ok: true,
      enabled: CONFIG.lease.enabled,
      dry_run: CONFIG.lease.dry_run,
      wallet_peers_known: leaseWalletPeers.size,
      exclusion_list: { saved_at: leaseExclude.saved_at || 0, excluded: Object.entries(leaseExclude.chan_points).filter(([, v]) => v && v.excluded).map(([cp]) => cp) },   // 0.72.4
      default_ttl_days: CONFIG.lease.days,
      cycle_minutes: CONFIG.lease.cycle_minutes,
      cycles: leaseCycles,
      last_cycle_at: leaseLastCycleAt ? new Date(leaseLastCycleAt).toISOString() : null,
      channels,
    });
  }
  if (path === '/lease/ttl' && method === 'POST') {
    if (isAdminRateLimited(ip)) return errResponse(res, 'Rate limit exceeded', 429);
    let body;
    try { body = await readBody(req); }
    catch (_) { return errResponse(res, 'Invalid JSON'); }
    const cp = String(body.chan_point || '');
    if (!/^[0-9a-f]{64}:[0-9]+$/.test(cp)) return errResponse(res, 'chan_point must be <txid>:<index>');
    const raw = body.ttl_days;
    const clearing = raw === null || raw === 0 || raw === undefined;
    const ttl = Number(raw);
    if (!clearing && (!Number.isFinite(ttl) || ttl <= 0 || ttl > 3650)) {
      return errResponse(res, 'ttl_days must be a number in (0, 3650], or null to clear');
    }
    let rec = leaseState.channels[cp];
    if (!rec) rec = leaseState.channels[cp] = { last_seen_ms: Date.now(), ttl_days: null, peer: '' };
    rec.ttl_days = clearing ? null : ttl;
    leaseSaveState();
    leaseLog({ event: 'ttl_set', chan_point: cp, ttl_days: rec.ttl_days });
    return jsonResponse(res, { ok: true, chan_point: cp, ttl_days: rec.ttl_days, default_ttl_days: CONFIG.lease.days });
  }

  // 0.74.0 (DP): the public /admin/registry/channels route is RETIRED. It answered with the
  // wallets' channel records to anyone holding the published route token — a
  // management read on the internet. The same records are on the console's Wallets
  // pane (loopback + Tailscale, TOTP). No caller ever depended on it (audited 2026-09-10).
  if (path === '/admin/registry/channels') {
    return errResponse(res, 'retired: this data is on the operator console (0.74.0)', 410);
  }

  return errResponse(res, 'Not found', 404);
});

// ── Startup ───────────────────────────────────────────────────────────────────

// ── v0.47 required-config check (D6: a misconfigured money service refuses
// to start, in plain sentences). The operator's identity set has NO defaults.
function requireIdentityConfig() {
  const missing = [];
  if (!CONFIG.adapter.secret)            missing.push('ADAPTER_SECRET — the admin/route auth secret. Generate: openssl rand -hex 32');
  if (!CONFIG.node.pubkey)               missing.push('NODE_PUBKEY — your Lightning node public key');
  if (!CONFIG.node.host)                 missing.push('NODE_HOST — your node\'s public Lightning P2P address host:port');
  if (!CONFIG.public.https_url)          missing.push('PUBLIC_HTTPS_URL — the public HTTPS URL fronting this adapter');
  if (!CONFIG.public.wss_url)            missing.push('PUBLIC_WSS_URL — the public WSS URL fronting the browser peer proxy');
  if (!CONFIG.security.ws_allowed_origins.length) missing.push('WS_ALLOWED_ORIGINS — comma list of wallet web origins allowed to connect');
  if (!CONFIG.lnd.macaroon)              missing.push('LIJ_ADAPTER_MACAROON_HEX — the macaroon the adapter uses to talk to LND (baking recipe in config.env.example)');
  if (missing.length) {
    console.error('This adapter will not start until it knows who it is. Missing required configuration:');
    for (const m of missing) console.error('  · ' + m);
    console.error('Set these in .env (see config.env.example) and start again.');
    process.exit(1);
  }
}

// ── v0.49 first-run doctor ─────────────────────────────────────────
// Startup-only checks (performance rule: nothing here runs per request).
// Each failure is a plain sentence naming the fix. LIJOX_DOCTOR=off skips.
async function runStartupDoctor() {
  if ((process.env.LIJOX_DOCTOR || 'on') === 'off') {
    console.log('[Doctor] skipped (LIJOX_DOCTOR=off).');
    return;
  }
  const fs = require('fs');
  const problems = [];

  // 1. LND TLS certificate readable
  try { fs.accessSync(CONFIG.lnd.tls_cert_path, fs.constants.R_OK); }
  catch { problems.push(`Cannot read the LND TLS certificate at ${CONFIG.lnd.tls_cert_path}. Point LND_TLS_CERT_PATH at your lnd tls.cert file.`); }

  // (macaroon presence is enforced by requireIdentityConfig; the REST check below proves it WORKS)

  // 3. Data directory actually writable (mkdir succeeding is not proof)
  try {
    const probe = require('path').join(DATA_DIR, '.doctor-write-probe');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
  } catch (e) { problems.push(`The data directory ${DATA_DIR} is not writable: ${e.message}. Fix its permissions or set LIJ_DATA_DIR elsewhere.`); }

  // 4. LND REST reachable + macaroon accepted + node identity matches config
  if (!problems.length) {
    try {
      const info = await Promise.race([
        lndGet('/v1/getinfo'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 5s')), 5000)),
      ]);
      const lndPub = info && info.identity_pubkey;
      if (!lndPub) {
        problems.push(`LND answered at ${CONFIG.lnd.endpoint} but returned no identity — the macaroon may be invalid or lnd is still starting.`);
      } else if (lndPub !== CONFIG.node.pubkey) {
        problems.push(`NODE_PUBKEY in your config (${String(CONFIG.node.pubkey).slice(0,16)}…) is not the node LND reports (${lndPub.slice(0,16)}…). Fix NODE_PUBKEY — wallets and registries key on it.`);
      } else {
        console.log(`[Doctor] LND REST reachable, macaroon accepted, node identity matches (${lndPub.slice(0,16)}…).`);
      }
    } catch (e) {
      problems.push(`Cannot reach LND REST at ${CONFIG.lnd.endpoint}: ${e.message}. Is lnd running? Are LND_ENDPOINT and LND_TLS_CERT_PATH right?`);
    }

    // 5. LND gRPC port reachable (HTLC interception and the chain bridge need it)
    await new Promise(resolve => {
      const [gh, gpRaw] = String(CONFIG.lnd.grpc_endpoint).split(':');
      const gp = parseInt(gpRaw || '10009');
      const sock = require('net').connect({ host: gh, port: gp, timeout: 4000 });
      sock.once('connect', () => { console.log(`[Doctor] LND gRPC port reachable at ${CONFIG.lnd.grpc_endpoint}.`); sock.destroy(); resolve(); });
      const bad = why => () => { problems.push(`Cannot reach LND gRPC at ${CONFIG.lnd.grpc_endpoint} (${why}). HTLC interception needs this port; check LND_GRPC_ENDPOINT.`); sock.destroy(); resolve(); };
      sock.once('timeout', bad('timeout'));
      sock.once('error',   e => bad(e.message)());
    });
  }

  if (problems.length) {
    console.error('The adapter found problems it cannot start with:');
    for (const m of problems) console.error('  · ' + m);
    console.error('Fix these and start again. (LIJOX_DOCTOR=off skips these checks, at your own risk.)');
    process.exit(1);
  }
  console.log('[Doctor] all checks passed.');
}

async function main() {
  requireIdentityConfig();
  await runStartupDoctor();
  console.log('╔═══════════════════════════════════════╗');
  console.log(`║   LIJOX Adapter ${ADAPTER_LOGIC_VERSION.padEnd(22)}║`);
  console.log('║   Open Lightning Service Provider     ║');
  console.log('╚═══════════════════════════════════════╝');

  // Verify LND connection
  console.log('[Startup] Connecting to LND...');
  let info;
  try {
    info = await lndGet('/v1/getinfo');
  } catch (e) {
    console.error('[Startup] LND connection failed:', e.message);
    process.exit(1);
  }
  // v0.12: cache our identity pubkey so lookupChannelPolicy can determine
  // which side of any channel is "us".
  LOCAL_PUBKEY = info.identity_pubkey;
  console.log(`[Startup] LND connected: ${info.alias} (${info.num_active_channels} active channels, pubkey ${LOCAL_PUBKEY.slice(0,16)}...)`);
  console.log(`[Startup] Channel limits: ${CONFIG.channel.min_sats}–${CONFIG.channel.max_sats} sats`);
  // v0.56.1: the startup line tells the TRUTH — v0.56.0 changed the open-site
  // resolver to O5 floor-or-percent but left this line printing the retired
  // 0.54.6 cap formula.
  {
    const _g = floorGovToday();
    const _floor = Math.max(354, JIT_PREFUND_SATS, JIT_REMOTE_RESERVE_SATS || 0);
    console.log(`[Startup] JIT wallet-side reserve (O5): floor ${_floor} sats while governors allow; full 1% (dust-floored) above either limit (gRPC field 25 — new channels only)`);
    console.log(`[Startup] O5 governors: ${JIT_FLOOR_MAX_OPENS_PER_DAY}/day opens, ${JIT_FLOOR_MAX_SATS_PER_DAY} sats/day aggregate — today ${_g.count} open(s), ${_g.sats} sats; prefund ${JIT_PREFUND_SATS} sats (payer-funds-the-floor, suspended on tripped opens)`);
  }
  console.log(`[Startup] Rate limit (channel-open): ${CONFIG.security.rate_limit_requests} req / ${CONFIG.security.rate_limit_window_ms / 60000} min`);
  console.log(`[Startup] Rate limit (admin):        ${CONFIG.security.admin_rate_limit_requests} req / ${CONFIG.security.admin_rate_limit_window_ms / 1000}s`);
  console.log(`[Startup] Registry store:            in-memory (v0.18.7 — does not survive restart; SQLite backend deferred)`);

  // Start WebSocket proxy
  startWebSocketProxy();

  // v0.5: Start cooperative chain-data bridge (Step 2 — bridge wake-up)
  // v0.6: Initialize gRPC Lightning client first, share it with the bridge.
  // v0.7: Also initialize ChainNotifier + WalletKit clients (Step 3).
  if (CONFIG.chain_bridge.enabled) {
    try {
      const grpcOpts = {
        grpcEndpoint: CONFIG.lnd.grpc_endpoint,
        tlsCertPath:  CONFIG.lnd.tls_cert_path,
        macaroonHex:  CONFIG.lnd.macaroon,
      };
      const lightningClient     = makeLightningClient(grpcOpts);
      const chainNotifierClient = makeChainNotifierClient(grpcOpts);
      const walletKitClient     = makeWalletKitClient(grpcOpts);
      console.log(`[Startup] gRPC clients ready: Lightning + ChainNotifier + WalletKit (endpoint=${CONFIG.lnd.grpc_endpoint})`);

      chainBridge = startBridge({
        onPeerActivity: (peerHex, typeId) => leaseTouch(peerHex, 'msg:' + typeId),   // 0.73.0
        lightningClient,
        chainNotifierClient,
        walletKitClient,
        hostname: lndUrl.hostname,
        port:     parseInt(lndUrl.port || '8080', 10),
        macaroon: CONFIG.lnd.macaroon,
      });
      console.log('[Startup] Cooperative chain bridge: started');
    } catch (e) {
      console.error('[Startup] Cooperative chain bridge failed to start:', e.message);
      console.error('[Startup] Continuing without bridge — set CHAIN_BRIDGE_ENABLED=false to suppress');
      chainBridge = null;
    }
  } else {
    console.log('[Startup] Cooperative chain bridge: disabled via CHAIN_BRIDGE_ENABLED=false');
  }

  // (0.61.0's LSPS2_CHANNEL_OPEN_FEE_SATS mismatch warning retired in 0.69.0 —
  // the knob is ignored and says so at config load.)

  // 0.71.0: `--unregister` — leave the registry and exit (operator's hand only).
  if (process.argv.includes('--unregister')) {
    try { const r = await unregisterFromRegistry(); process.exit(r && r.ok ? 0 : 1); }
    catch (e) { console.error('[Registry] Unregister failed:', e.message); process.exit(1); }
  }

  // Register with LIJOX registry, then re-register on a cadence (0.71.0: the
  // worker marks a record stale after 24h without one).
  await registerWithRegistry();
  if (CONFIG.registry && registryStatus.every_h > 0) {
    registryTimer = setInterval(() => { registerWithRegistry().catch(() => {}); stampLoop('registry', registryStatus.every_h * 3600 * 1000); }, registryStatus.every_h * 3600 * 1000);
  }

  // 0.71.0: the operator console (loopback + Tailscale, TOTP). Disabled until
  // CONSOLE_TOTP_SECRET is set — see --totp-enroll.
  try {
    const { createPL } = require('./pl');
    plEngine = createPL({
      dataDir: DATA_DIR, lndGet, lndPost, log: (l) => console.log(l),
      isWalletPubkey: (pk) => Object.values(lnurlpRegistry).some((r) => r && r.client_pubkey === pk) || Object.values((leaseState && leaseState.channels) || {}).some((r) => r && r.peer === pk),
      channelPoints: () => new Set(Object.keys((leaseState && leaseState.channels) || {}).map((cp) => cp.split(':')[0])),
      rates: () => (ratesCache && ratesCache.rates) || null,
    });
    const { createConsole } = require('./console');
    const con = createConsole({ version: ADAPTER_LOGIC_VERSION, lndGet, snapshot: consoleSnapshot, pl: (date, opts) => plEngine.report(date, opts), log: (l) => console.log(l),
      // 0.72.4: the one operator action so far — lease exclusions (safety-increasing, so behind the session only)
      setNote: async (kind, key, text) => consoleNoteSet(kind, key, text),   // 0.73.0 notes + labels
      setLeaseExclude: async (cp, excluded, peer) => {
        if (!/^[0-9a-f]{64}:\d+$/.test(cp)) throw new Error('bad channel point');
        const prev = leaseExclude.chan_points[cp] || {};
        leaseExclude.chan_points[cp] = { excluded: !!excluded, peer: String(peer || prev.peer || '').slice(0, 66), set_at: Date.now() };
        leaseExcludeSave();
        leaseLog({ event: 'exclude_set', chan_point: cp, excluded: !!excluded, peer: String(peer || '').slice(0, 16) });
        return { ok: true, chan_point: cp, excluded: !!excluded, saved_at: leaseExclude.saved_at };
      },
    });
    con.start();
  } catch (e) { console.error('[Console] failed to start:', e.message); }

  // v0.11: Start critical-peer keepalive (Umbrel etc. — see CRITICAL_PEERS env).
  // Runs every 60s; also force-checked before each /v1/route/build query.
  startCriticalPeerKeepalive();

  // v0.17: Start htlc-interceptor subsystem (LSPS2 Phase D.1).
  // Subscribes to LND's Router HtlcInterceptor bidirectional gRPC stream.
  // On every HTLC LND wants to forward, we receive a request and respond
  // RESUME unconditionally. Matches against pending JIT buys are logged
  // for telemetry (Phase D.1) — Phase D.2 will replace the RESUME-on-match
  // with channel-open + HTLC-forward logic.
  if (CONFIG.lsps2.interceptor_enabled) {
    try {
      const grpcOpts = {
        grpcEndpoint: CONFIG.lnd.grpc_endpoint,
        tlsCertPath:  CONFIG.lnd.tls_cert_path,
        macaroonHex:  CONFIG.lnd.macaroon,
      };
      // v0.18: dedicated OpenChannel client + share routerClient between
      // HtlcInterceptor and SendToRouteV2.
      routerClient = makeRouterClient(grpcOpts);
      lightningOpenChannelClient = makeLightningOpenChannelClient(grpcOpts);
      htlcInterceptor = subscribeHtlcInterceptor(routerClient, handleInterceptedHtlc, 'Interceptor');
      console.log('[Startup] HtlcInterceptor: subscribed (LSPS2 Phase D.2 — trampoline-via-interceptor)');

      // v0.18: kick off reconnect-poll timer for offline-HTLC processing.
      reconnectPollTimer = setInterval(reconnectPollTick, CONFIG.lsps2.reconnect_poll_secs * 1000);
      console.log(`[Startup] reconnect-poll: every ${CONFIG.lsps2.reconnect_poll_secs}s`);
      // F4: warm the real-channel SCID cache immediately so the interceptor guard
      // has data before the first HTLC, rather than waiting one poll cycle.
      refreshRealChannelScids().then(() =>
        console.log(`[Startup] F4 guard active: realChannelScids warmed (${realChannelScids ? realChannelScids.size : 0} scids)`));
    } catch (e) {
      console.error('[Startup] HtlcInterceptor / D.2 init failed:', e.message);
      console.error('[Startup] Continuing without interceptor — set LSPS2_INTERCEPTOR_ENABLED=false to suppress');
      htlcInterceptor = null;
      routerClient = null;
      lightningOpenChannelClient = null;
    }
  } else {
    console.log('[Startup] HtlcInterceptor: disabled via LSPS2_INTERCEPTOR_ENABLED=false');
  }

  // Start HTTP API server
  // ── 0.57.0 (c): WATCHDOG PETTING — in-process supervisor. With
  // NOTIFY_SOCKET present (unit carries WatchdogSec=90 + NotifyAccess=all),
  // pet systemd every 30s via systemd-notify — but ONLY while the liveness-
  // critical loops are fresh; a stalled critical loop stops the petting and
  // systemd restarts us. No NOTIFY_SOCKET ⇒ no-op, so the code ships safely
  // ahead of the live-unit edit (SHIP TOGETHER: DP pastes the unit lines in
  // the same release window). A loop that has never started is skipped —
  // a booting service must not be parked for warming up.
  const WATCHDOG_CRITICAL = ['reconnect_poll', 'scarcity', 'keepalive'];
  setInterval(() => {
    stampLoop('watchdog_pet', 30000);
    if (!process.env.NOTIFY_SOCKET) return;
    const wnow = Date.now();
    for (const wname of WATCHDOG_CRITICAL) {
      const we = loopStamps[wname];
      if (!we || !we.last) continue;
      if (wnow - we.last > Math.max(5 * we.period_ms, 120000)) {
        console.error(`[WATCHDOG] NOT petting: loop '${wname}' stale ${wnow - we.last}ms — letting systemd restart us`);
        return;
      }
    }
    try { require('child_process').execFile('systemd-notify', ['WATCHDOG=1'], () => {}); } catch (e) {}
  }, 30000);

  server.listen(CONFIG.adapter.port, () => {
    console.log(`[Startup] HTTP API listening on port ${CONFIG.adapter.port}`);
    console.log(`[Startup] Health: http://localhost:${CONFIG.adapter.port}/health`);
    console.log(`[Startup] Ready to open channels for LiJ wallets`);
  });

  // v0.21: LEASE startup — dormant unless LEASE_ENABLE=true. State loads
  // either way so /lease/status can answer; the cycle timer runs only
  // when enabled. The first cycle runs immediately and SEEDS every
  // existing channel at last_seen=now — grace by construction: nothing
  // can be past-ttl until a full ttl elapses from this moment.
  leaseLoadState();
  if (CONFIG.lease.enabled) {
    leaseCycle().catch(e => console.error(`[Lease] first cycle failed: ${e.message}`));
    leaseTimer = setInterval(() => {
      leaseCycle().catch(e => console.error(`[Lease] cycle failed: ${e.message}`));
    }, Math.max(1, CONFIG.lease.cycle_minutes) * 60000);
    console.log(`[Startup] Lease: ACTIVE${CONFIG.lease.dry_run ? ' (DRY RUN)' : ''} — ttl ${CONFIG.lease.days}d, cycle ${CONFIG.lease.cycle_minutes}m`);
  } else {
    console.log('[Startup] Lease: dormant (LEASE_ENABLE!=true)');
  }
  // 0.68.0: neutral-host name sweep — 20 s after boot (after the registry registration).
  if (CONFIG.lnurlp.address_host) {
    setTimeout(() => lnurlpNameSweep().catch((e) => console.warn(`[LNURLP] name sweep failed: ${e.message}`)), 20000);
    console.log(`[Startup] Neutral address host: ${CONFIG.lnurlp.address_host}`);
  }
  // 0.66.0: channel fee-policy sweep — 30 s after boot, then hourly.
  if (CONFIG.chan_policy.enforce) {
    setTimeout(() => enforceChannelPolicy('boot').catch(e => console.warn(`[POLICY] boot sweep failed: ${e.message}`)), 30000);
    setInterval(() => enforceChannelPolicy('hourly').catch(e => console.warn(`[POLICY] hourly sweep failed: ${e.message}`)), 3600000);
    console.log(`[Startup] Channel fee policy: base ${CONFIG.chan_policy.base_fee_msat} msat / ${CONFIG.chan_policy.fee_ppm} ppm — set in every open; sweep 30 s after boot, then hourly`);
  } else {
    console.log('[Startup] Channel fee policy: opens carry the policy; sweep OFF (LIJ_CHAN_POLICY_ENFORCE=false)');
  }
}

// Graceful shutdown — clean up bridge before exit
function shutdown(signal) {
  console.log(`\n[Shutdown] received ${signal}`);
  // v0.18: stop reconnect poll + clear all watchdogs.
  if (reconnectPollTimer) {
    try { clearInterval(reconnectPollTimer); } catch (_) {}
    reconnectPollTimer = null;
  }
  if (registryTimer) { try { clearInterval(registryTimer); } catch (_) {} registryTimer = null; }
  if (leaseTimer) {
    try { clearInterval(leaseTimer); } catch (_) {}
    leaseTimer = null;
  }
  for (const [, handle] of htlcWatchdogs) {
    try { clearTimeout(handle); } catch (_) {}
  }
  htlcWatchdogs.clear();
  if (htlcInterceptor) {
    try { htlcInterceptor.stop(); } catch (e) { console.error('[Shutdown] interceptor stop error:', e.message); }
  }
  if (chainBridge) {
    try { chainBridge.stop(); } catch (e) { console.error('[Shutdown] bridge stop error:', e.message); }
  }
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(e => {
  console.error('[Fatal]', e);
  process.exit(1);
});
