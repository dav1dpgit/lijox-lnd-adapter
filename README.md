# LIJOX Adapter

**Status: pre-release (0.74.0). Runs live on two LND nodes, both the author's. No third-party audit.** Every release is an annotated git tag with the file hashes in `RELEASES.md`; the two nodes deploy by checking out a tag and comparing the file hash to that table. `KNOWN-FINDINGS.md` records defects found in the field, with dates. `MACAROON.md` is the least-privilege LND macaroon recipe the adapter needs. This repository starts from a clean first commit; the private development history is not published.

The standard the adapter implements is at [dav1dpgit/LIJOX](https://github.com/dav1dpgit/LIJOX); the wallet at [dav1dpgit/lightninginajar](https://github.com/dav1dpgit/lightninginajar).

LiJ wallets are self-sovereign, multi-LSP-agnostic wallets built on
the LIJOX standard. The LIJOX standard is the open tooling that
separates wallets from operators' services — no wallet is captive to
any provider. A LIJOX Adapter is open-source, self-hosted software
that translates an operator's existing Lightning services into a
LIJOX-standard LSP for LiJ-class wallets — JIT channels, offline
holds, wake push, and the LIJOX manifest — under the operator's own
keys, own front door, own policies, and own registry choices.
Download, configure, serve. No permission asked, no secrets shared,
no home to phone.

A standard LSP serves wallets that are apps; a LIJOX Adapter lets an
operator serve wallets that are browsers, mostly asleep, and free to
leave — and makes that operator comparable, swappable, and honest by
construction.

LICENSE: MIT (see LICENSE).

STATUS: pre-release. Identity is fully operator-config (the adapter
refuses to start without it), state lives under one data root, a
first-run doctor checks your setup in plain sentences, and the
macaroon recipe is least-privilege (MACAROON.md). Known limitation,
stated honestly: the channel-record registry (a seed-only recovery
FALLBACK — wallets' primary device-loss recovery is their own
encrypted cloud backup, held elsewhere) is in memory and does not
survive a restart; acknowledged records are not re-sent by wallets.
By owner ruling this is DEFERRED: the record is a
seed-only convenience breadcrumb (the per-channel keys_id), the read
path is an unbuilt future wallet arc, funds are recoverable without
it, and wallets' encrypted cloud backup covers device loss.

═══════════════════════════════════════════════════════════════════
INSTALL — from zero to serving wallets
═══════════════════════════════════════════════════════════════════

WHAT YOU NEED BEFORE STARTING
- A running, synced LND node with onchain funds (JIT channels are
  opened from YOUR balance) and its P2P port reachable at a public
  host:port — that address becomes NODE_HOST.
- A Linux box (the node's own machine is fine). Node.js 20 or newer
  (developed on 22).
- Two public HTTPS/WSS hostnames you control, fronted however you
  like — Caddy, nginx, or an outbound tunnel (e.g. cloudflared) all
  work. One will serve the HTTP API, one the WebSocket proxy.
  Browser wallets require real TLS — no self-signed.

1. GET THE CODE — pinned to a release, verified
       git clone <this repository> && cd lijox-adapter
       git checkout v0.52.0          # latest release tag
   Verify integrity (see RELEASES.md for the checksum table):
       git archive --format=tar --prefix=lijox-adapter-0.52.0/ v0.52.0 | gzip -n | sha256sum
   The output must equal the sha256 listed in RELEASES.md for this
   version. Then:
       npm ci
   (npm ci installs the exact locked dependencies, including a small
   native build for better-sqlite3.)

2. BAKE THE ADAPTER'S MACAROON
   Follow MACAROON.md — one lncli command on your node, then hex the
   file. Do NOT hand the adapter your admin macaroon.

3. WRITE YOUR CONFIG
       cp config.env.example .env
       chmod 600 .env
   Fill the REQUIRED block (six values) plus the macaroon hex:
       ADAPTER_SECRET      openssl rand -hex 32
       NODE_PUBKEY         lncli getinfo | grep identity_pubkey
       NODE_HOST           your node's public p2p host:port
       PUBLIC_HTTPS_URL    e.g. https://lsp.yourdomain.tld
       PUBLIC_WSS_URL      e.g. wss://ws.yourdomain.tld
       WS_ALLOWED_ORIGINS  the wallet web origin(s) you will serve
       LIJ_ADAPTER_MACAROON_HEX   from step 2
   Everything else has working defaults; the file documents all of
   them in three zones.

4. FIRST START — LET THE DOCTOR TALK
       node lij-adapter.js
   The doctor checks your cert, macaroon, data dir, LND REST and
   gRPC, and that NODE_PUBKEY matches the node LND reports. It
   prints plain sentences for anything wrong; fix and start again
   until you see "[Doctor] all checks passed." Stop it (Ctrl-C)
   once it runs clean.

5. FRONT IT
   Point your two public hostnames at the adapter:
       PUBLIC_HTTPS_URL  →  http://localhost:7000
       PUBLIC_WSS_URL    →  http://localhost:7001  (websocket passthrough)
   Caddy example (two lines per host):
       lsp.yourdomain.tld {  reverse_proxy localhost:7000  }
       ws.yourdomain.tld  {  reverse_proxy localhost:7001  }
   An outbound tunnel works identically — map each hostname to the
   local port. Nothing requires an inbound firewall hole for 7000/
   7001 themselves if you tunnel.

6. RUN IT AS A SERVICE
       sudo useradd -r -s /usr/sbin/nologin lijox
       sudo mkdir -p /opt/lijox-adapter /var/lib/lijox-adapter /etc/lijox-adapter
       sudo cp -r . /opt/lijox-adapter
       sudo cp .env /etc/lijox-adapter/config.env
       sudo chown -R lijox:lijox /opt/lijox-adapter /var/lib/lijox-adapter
       sudo chown lijox:lijox /etc/lijox-adapter/config.env && sudo chmod 600 /etc/lijox-adapter/config.env
       sudo cp lijox-adapter.service /etc/systemd/system/
       sudo systemctl daemon-reload && sudo systemctl enable --now lijox-adapter
   Note: the unit sets LIJ_DATA_DIR=/var/lib/lijox-adapter, and the
   service user must be able to READ your LND tls.cert (adjust
   LND_TLS_CERT_PATH or group permissions accordingly).
   Logs:  journalctl -u lijox-adapter -f
   State: /var/lib/lijox-adapter

7. PROVE IT FROM OUTSIDE
       curl https://lsp.yourdomain.tld/health
   should answer JSON. Then point a LiJ-class wallet at your
   PUBLIC_HTTPS_URL / PUBLIC_WSS_URL pair and receive a payment —
   the first receive exercises a JIT channel open end to end.

8. OPERATING NOTES
   - Privacy defaults: client IPs are not logged; no registry is
     contacted unless you set one; nothing phones home.
   - Update (until signed releases land): git pull in /opt, then
     systemctl restart lijox-adapter. Read the changelog first.
   - Your money exposure: JIT opens spend YOUR onchain funds within
     the limits you set (CHANNEL_SIZE/MIN/MAX, JIT_MIN_ONCHAIN_
     RESERVE_SATS). Set them deliberately.

Design documents live in the LiJ repo:
docs/lijox-provider-definition.md · docs/separate-adapter-discovery.md

## The delegate rail and wallets on this LSP (0.78+)
A delegate spend (a chit) pays the bill from this node's own LND. LND cannot hold its own
outgoing payment the way the HTLC interceptor holds a forward, so a bill whose route hint names
this node — a wallet on this LSP — takes the hold rail instead of sendpayment when that wallet is
not connected with a channel that has room: the chit goes HELD, the wallet gets its wake push,
and the same delivery every held claim uses (a zero-conf JIT open when there is no channel,
then one HTLC for the bill's hash and secret) runs when the wallet connects, until the wallet's
hold window or the bill's expiry runs out. The chit is charged the bill's face; a JIT skim comes
out of what the merchant receives, as on every rail. A held spend cannot be voided; a spend that
never lands leaves the chit untouched. Knobs: DELEGATE_HOLD_TICK_MS (3000),
DELEGATE_HOLD_RETRY_MS (20000), DELEGATE_HOLD_MAX_TRIES (30), DELEGATE_HOLD_MIN_WINDOW_MS (30000),
DELEGATE_HOLD_EXPIRY_MARGIN_S (60). GET /delegate/slip/<nonce> reports `held` and `last_bill`.

## The kit holder — LIJOX Black start (0.79+)
Every LIJOX adapter keeps, for any wallet that asks, one sealed ESCAPE KIT per wallet identity:
the wallet's own fully signed latest force-close and its pre-signed sweep, encrypted under a key
only the wallet's 12 words can make. The box cannot read it. A wallet whose device, backup and
LSP are all gone recovers with the words alone by asking every listed adapter for its kit.
`POST /v1/kit` takes `{ pubkey, seq, kit, sig }` — the signature (ECDSA over secp256k1, verified
with Node's own crypto, no third-party code) binds the kit and its sequence number to the
wallet's NIP-06 key; the newest sequence wins, an older one is refused (409). `GET /v1/kit?npub=`
returns the record (ciphertext) or 404. Records live in `DATA_DIR/kits/<npub>.json`, at most
KIT_MAX_BYTES (65,536) each; the store evicts the oldest untouched record beyond 20,000, never one
touched in the last 90 days. `/health` advertises `kit_holder`. The standard is the LiJ repo's
docs/black-start-standard.md.

## NWC — the provider's half (0.86+)
A Nostr app (Nostur, Damus, Primal, Amethyst …) asks the LiJ wallet to pay a zap. The request is a
NIP-47 event with encrypted content (NIP-44, or the older NIP-04 most apps still send — the
wallet reads both; the adapter reads neither), addressed to the wallet's per-app service key and
signed by the app's client key. Nostr relays keep no such events (ephemeral kinds), so a sleeping
phone would miss them — this adapter keeps them, encrypted as they came, and wakes the phone
(`{t:"nwc"}`, content-free). LiJ opens, fetches, decrypts and — inside the wallet's own limits —
pays at once with its own keys (a repeat of a recent payee waits for the user's tap; over the
limits it refuses), then replies through the same relay. **The adapter never pays, never holds a key
that reads a request, never sees the invoice, the amount or the payee.**

`NWC_ENABLED=true` turns it on (off by default — an operator's choice; the wallet's Dials → NWC
greys where a provider does not offer it). `POST /v1/nwc/register` and `/unregister` take the
route token plus the wallet's node-key signature (LND VerifyMessage on
`lij-nwc-register:v1|service_pk|client_pk|expires_at|ttl_s|ts`), at most 10 connections per
wallet, kept in `DATA_DIR/nwc/registry.json`; the adapter drops one at its expiry itself. The
relay is a websocket at `/nwc` on the API server (the same tunnel): NIP-01 EVENT/REQ/CLOSE +
NIP-42 AUTH; it accepts 13194 (info) from a registered service key, 23194 (request) to a registered
service key from that connection's client key (created_at within ±10 min, kept until the earliest
of the wallet's ttl, the `expiration` tag and `NWC_REQUEST_TTL_CEILING_S`; 20 waiting per
connection), 23195 (reply) from a registered service key; anything else is refused unstored. A
request is served only to the NIP-42-authenticated service key it is addressed to; a reply to a
subscriber naming the client key. Stored events persist in `DATA_DIR/nwc/events.json` — a restart
drops nothing. Signatures are verified by `schnorr.js`, a vendored BIP-340 implementation gated by
the BIP's test vectors (`node schnorr.test.js`) — locked; changed only with the operator's word.
`get_info` and `/health` advertise `nwc`; the console reports the switch, the relay, connections,
waiting requests and wakes. `node nwc.test.js` runs the relay end to end.

## Your own block-filter server (0.87+)

A provider may offer its wallets its own block-filter server — the server a Lightning in a Jar wallet reads to
find its on-chain coins privately (BIP-158 filters: the server sees which blocks a wallet downloads, never its
addresses) and, when it carries the tweak index, its silent payments. Set `LIJOX_FILTER_URL` to the server's
public https address (`docs/adapter-standalone-setup.md` §10 sets up the server and the index). At every
registration the adapter asks the server for `/tip` (it must answer) and `/sp/info` (`spcommit-v1` = it serves the
silent-payment index), and only then puts `filter_url` and `filter_sp` into the signed LIJOX record
(`lijox-register:v2`; registry 0.8.0+). A server that does not answer is left out of that registration with a
plain sentence in the journal — wallets are never pointed at a dead server. Unset = nothing offered; the record is
v1 as before and wallets read the default server. `/health` carries `filter_server`; the console shows it.
`node registry-filter.test.js` checks the record and the check.

## The operator console (0.71+)

The adapter serves its own monitor at `/console` on a separate port (`CONSOLE_PORT`, default 7004), bound to loopback and the Tailscale interface only — it has no place on the public tunnel. Login is a six-digit TOTP code and nothing else (`node lij-adapter.js --totp-enroll` prints the secret for `config.env` and the setup key for an authenticator app); a code is accepted once, five wrong codes lock the address for ten minutes, a correct one opens a 12-hour session bound to the caller's address. The page loads nothing from anywhere (CSP `default-src 'none'`, script and style by hash) and the adapter makes no outbound call on its behalf — there is no update check by design.

Panes: guardrails (the live open-fee multiplier and its inputs, the per-wallet open ladder, JIT sizing, the lease), a settings report (every dial the box runs on, its value and where it came from — read-only; the console never writes to LND or to `.env`; LND's actual fee policy on wallet channels is read beside the advertised numbers), PL (day / MTD / YTD / LTD with a calendar, from a fee ledger the adapter writes when a fee is actually kept plus LND's forwarding, payment and chain history; daily snapshots so life-to-date never rescans), node, balances, channels (Tor/clearnet per peer, lease clock with what last renewed it, a per-channel note, exclude/include from the lease), wallets served (with an operator label), pending, unconfirmed on-chain, registry status, SCB backup legs, loops. Notes and labels live in `console-notes.json` in the data folder — per instance, never in git. Some panes need read-only LND permissions the original macaroon lacks (`GetTransactions`, `ForwardingHistory`, `ClosedChannels`, `ChannelBalance`, `PendingSweeps`); a pane says which one it is missing rather than guessing, and `bake-permissions.json` carries them for the next bake.

The lease (a silent wallet's channel is force-closed after `LEASE_DAYS`, its balance paid to the wallet's own address) measures liveliness as *contact*: any message or API call from the wallet renews it, stamped when the wallet acts, persisted once per session. It considers every channel except the ones the operator excludes in the console, and it closes nothing until that exclusion list has been saved at least once. See KNOWN-FINDINGS for the two defects that shaped this (2026-09-08).

Names and marks (Lightning in a Jar, LiJ, LIJOX, the jar logo) are not licensed with the code — see [TRADEMARKS.md](TRADEMARKS.md).
