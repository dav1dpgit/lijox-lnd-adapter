# LIJOX Adapter

**Status: pre-release (0.70.1). Runs live on two LND nodes, both the author's. No third-party audit.** Every release is an annotated git tag with the file hashes in `RELEASES.md`; the two nodes deploy by checking out a tag and comparing the file hash to that table. `KNOWN-FINDINGS.md` records defects found in the field, with dates. `MACAROON.md` is the least-privilege LND macaroon recipe the adapter needs. This repository starts from a clean first commit; the private development history is not published.

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

Names and marks (Lightning in a Jar, LiJ, LIJOX, the jar logo) are not licensed with the code — see [TRADEMARKS.md](TRADEMARKS.md).
