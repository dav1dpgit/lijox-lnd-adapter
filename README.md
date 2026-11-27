# LIJOX Adapter

**Status: 0.146.1 (2026-11-26). Runs live on the author's two LND nodes and, since 2026-11-19, on an independent operator's Start9 node. No third-party audit.** Every release is an annotated git tag with each file's sha256 in `RELEASES.md`; the author's two nodes deploy a tag's files and compare their hashes to that table. `KNOWN-FINDINGS.md` records defects found in the field, with dates. `MACAROON.md` is the least-privilege LND macaroon recipe the adapter needs. This repository starts from a clean first commit; the private development history is not published.

The standard the adapter implements is at [dav1dpgit/LIJOX](https://github.com/dav1dpgit/LIJOX); the wallet at [dav1dpgit/lightninginajar](https://github.com/dav1dpgit/lightninginajar).

LiJ wallets are self-sovereign, multi-LSP-agnostic wallets built on
the LIJOX standard. The LIJOX standard is the open tooling that
separates wallets from operators' services — no wallet is captive to
any provider. A LIJOX Adapter is open-source, self-hosted software
that translates an operator's existing Lightning services into a
LIJOX-standard LSP for LiJ-class wallets — JIT channels, offline
holds, wake push, and the LIJOX manifest — under the operator's own
keys, own public addresses, own policies, and own registry choices.
Download, configure, serve. No permission asked, no secrets shared,
no home to phone.

A standard LSP serves wallets that are apps; a LIJOX Adapter lets an
operator serve wallets that are browsers, mostly asleep, and free to
leave — and makes that operator comparable, swappable, and honest by
construction.

LICENSE: MIT (see LICENSE).

STATUS: identity is fully operator-config (the adapter
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
- LND (Terminus), not stock LND, to serve LiJ wallets. The adapter
  opens every wallet channel zero-conf and without anchors (static
  remote key — LSPS2_COMMITMENT_TYPE=STATIC_REMOTE_KEY), because a
  LiJ wallet's 12 words alone recover such a channel and the wallet
  refuses an anchors channel from its own provider. Stock LND opens
  zero-conf channels only with anchors. LND (Terminus) is LND with
  one 62-line patch:
  https://github.com/dav1dpgit/lnd/commit/cf8f0d2cbdf380e038f180aa9adb5c4377f95f83
  It ships as a Docker image (docs/umbrel-operator-guide.md) and a
  StartOS package; docs/operator-docker-runbook.md §1a has the
  other routes.
- A Linux box (the node's own machine is fine). Node.js 20 or newer
  (developed on 22).
- Two public HTTPS/WSS hostnames you control, fronted however you
  like — Caddy, nginx, or an outbound tunnel (e.g. cloudflared) all
  work. One will serve the HTTP API, one the WebSocket proxy.
  Browser wallets require real TLS — no self-signed.

1. GET THE CODE — pinned to a release, verified
       git clone https://github.com/dav1dpgit/lijox-lnd-adapter && cd lijox-lnd-adapter
       git fetch --tags
       git checkout v0.146.1         # the newest tag — the last row of RELEASES.md
   Verify integrity against that row (since 0.57.0 every row lists
   each file's own sha256; a file the row calls unchanged keeps the
   hash of the last row that named it):
       sha256sum lij-adapter.js package.json config.env.example
   and so on for every file the row names. Every printed hash must
   equal the one RELEASES.md gives for that file at this version. (Rows up to 0.56.4 hashed a tarball instead —
   RELEASES.md explains both.) Then:
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
   - Update (until signed releases land): in /opt/lijox-adapter,
     git fetch --tags && git checkout v<NEW> (never a bare git pull),
     sha256sum the files the new row names and compare, then
     systemctl restart lijox-adapter. Read the row first — it is the
     changelog — and the boot banner must show the new version.
   - The JIT guard (0.104+): a JIT open that was funded and then
     failed counts against a rolling 24 h; at JIT_GUARD_ARM_AT the
     console reads "shutdown ARMED", at JIT_GUARD_HALT_AT every JIT
     open is refused until released from the console. Set both
     deliberately or leave the defaults. From 0.124.0 a held-funding
     failure (below) publishes nothing and is counted in its own
     column, never toward the halt.
   - Wallet trusts LSP (0.124.0): for a wallet that announces it
     (init feature bit 261 — LiJ engine v363+), a JIT channel's
     funding transaction is built and signed from your LND wallet but
     PUBLISHED ONLY ONCE THE WALLET HAS CLAIMED the payment. Refused →
     the channel is abandoned, the coins released, the wallet told —
     no chain fee, nothing tied up. Older wallets get the publish-first
     open as before. Needs six more RPCs in the key (MACAROON.md); the
     boot line "[JIT-HOLD] key probe" says whether you have them — a
     key without them keeps today's open and says so. LSPS2_FUNDING_HOLD
     =false turns it off for all. The signed transaction waits in
     DATA_DIR/jit-held-funding.json; the Console's "JIT funding" pane
     shows every record and its state; a RED orphan row means a
     channel left LND without this adapter abandoning it (read it).
     0.124.1: a record that says "waiting on LND's proof" is a held
     open whose stream timed out AFTER LND was told the txid — LND may
     still open that channel, so the coins stay leased until the
     wallet peer disconnects (LND cancels the reservation then) or
     the 48-hour lease ends; nothing to do. The funding's fee (both
     opens) is LND's estimate for LSPS2_FUNDING_FEE_TARGET_CONF blocks
     (144), floored at LSPS2_FUNDING_FEE_MIN_SAT_PER_VB (1), capped at
     LSPS2_FUNDING_FEE_MAX_SAT_PER_VB when set — until 0.124.0 it was
     a hard-coded 1 sat/vB.
   - Your money exposure: JIT opens spend YOUR onchain funds within
     the limits you set (CHANNEL_SIZE/MIN/MAX, JIT_MIN_ONCHAIN_
     RESERVE_SATS). Set them deliberately.
   - Lightning pays on-chain (0.120.0): a wallet pays an on-chain
     address from its Lightning balance through this box. It needs a
     FLOAT WALLET — a wallet in the box's own Bitcoin Core under an RPC
     user whose command list is whitelisted (rpcwhitelist, with
     rpcwhitelistdefault=0 beside it), holding no more than
     ONCHAIN_PAY_DAILY_SATS, topped up by hand — and a take-back seed
     (ONCHAIN_PAY_TAKEBACK_SEED; back it up with .env). The adapter
     gains no right on LND. ONCHAIN_PAY_FEE_SATS (1,000) is the flat,
     non-refundable fee; the lock's own miner fee is the sender's at
     the live rate. ONCHAIN_PAY_ENABLED=false stops NEW payments only:
     open ones run to their end. The Console's Float pane watches it.
   - Ask-the-provider fetches (0.119.3): a wallet whose payee's site
     refuses browser wallets asks this box to fetch the pay terms and
     the invoice for it (POST /v1/lnurl/fetch) — https on 443 to a
     public address only, nothing stored, the URL never logged;
     LNURL_FETCH_IP_PER_MIN (30) caps asks per address.
   - JIT promises (0.119.2): a wallet's promise lives for
     LSPS2_RESERVATION_HOURS (24) once its invoice secret is in, so the
     invoice can be paid for its whole life; LSPS2_MAX_LIVE_PROMISES_PER_WALLET
     (10) and LSPS2_MAX_LIVE_PROMISES (2,000) bound the memory. Promises
     are memory-only: a restart drops them and every held payment.

Design documents: the LIJOX repository's docs/ (start with
docs/lijox-provider-definition.md). Guides in this repository's docs/:
adapter-standalone-setup.md (a plain Linux box), operator-docker-runbook.md
(Docker), umbrel-operator-guide.md (Umbrel), tower-between-providers.md
(LND's own watchtower between providers). ops/relay is the relay kit: a
small rented server and a WireGuard tunnel that pass the connection to
your node unopened, so TLS ends on your own machine and no edge in the
middle reads the traffic (see ops/relay/README.md for what the rented
server can still see).

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
Every LIJOX adapter keeps, for any wallet that asks, one encrypted Black start kit per wallet identity:
the wallet's own fully signed latest force-close and its pre-signed sweep, encrypted under a key
only the wallet's 12 words can make. The box cannot read it. A wallet whose device, backup and
LSP are all gone recovers with the words alone by asking every listed adapter for its kit.
`POST /v1/kit` takes `{ pubkey, seq, kit, sig }` — the signature (ECDSA over secp256k1, verified
with Node's own crypto, no third-party code) binds the kit and its sequence number to the
wallet's NIP-06 key; the newest sequence wins, an older one is refused (409). `GET /v1/kit?npub=`
returns the record (ciphertext) or 404. Records live in `DATA_DIR/kits/<npub>.json`, at most
KIT_MAX_BYTES (65,536) each; the store evicts the oldest untouched record beyond 20,000, never one
touched in the last 90 days. `/health` advertises `kit_holder`. The standard is the wallet repository's
docs/black-start-standard.md.

**The channel state file (0.126.0).** `POST /v1/peer-storage/put` takes `{ node_pubkey, nonce, signature, version,
state_fp, file_b64 }` and keeps one encrypted file per wallet node key — 65,531 bytes at most, the size BOLT #1110
(peer storage) allows; the latest only; a lower `version` is refused (409). `POST /v1/peer-storage/meta` answers the
held `version` and `state_fp`; `POST /v1/peer-storage/get` hands the file back. Each request carries a single-use
`nonce` from `GET /lsps/registry/challenge` and the node key's signature over `lij-peer-storage-v1:<action>:<nonce>`
(a put adds `:<version>:<sha256 of the file>`). The holder cannot read the file. It is held for any wallet that proves
its key, not only this provider's own. See `peer-storage.js` and KNOWN-FINDINGS 0.126.0.

**The tower (0.128.0, off unless `TOWER_ENABLED=true`).** The provider keeps a wallet's encrypted penalty transactions
and reads every block for the old channel states they answer. `POST /v1/tower/put` takes `{ key, group, ts, signature,
items: [{ hint, blob }] }`: `hint` is the first 16 bytes of the old state's transaction id (as the chain stores it),
`blob` is the penalty transaction encrypted under SHA-256 of that whole id (ChaCha20-Poly1305, a zero nonce — the same
bytes The Eye of Satoshi keeps). `POST /v1/tower/drop` removes one channel's items; `POST /v1/tower/status` answers the
count, the bytes used, and whether the box is watching. Each request is signed (BIP-340) by a key the wallet makes for
this tower alone, over SHA-256 of `lijox-tower-v1|<action>|<key>|<group>|<ts>` (a put adds `|<sha256 of the items>`);
`ts` must be within ten minutes. The box cannot read an item until the old state it answers is in a block; then it
opens it, checks that it spends that transaction and nothing else, and publishes it through LND — the one paying the
higher fee first, again on every new block for 144 blocks. The blocks come from LND's ChainKit (`GetBestBlock`,
`GetBlockHash`, `GetBlock`), so the key must carry those three reads (MACAROON.md); a box whose key cannot read a block
keeps nothing and says so on `/health` (`tower.offered: false`). 5 MB a wallet key (`TOWER_QUOTA_BYTES`); a key silent
for 400 days is dropped (`TOWER_KEEP_DAYS`). What it does not do: it answers the main output of an old state, not its
HTLC outputs. See `tower.js`, `tower-watch.js` and KNOWN-FINDINGS 0.128.0.

**The tower on the registry record, and the joining drill (0.129.0).** A box with the tower turned on says so on its
registry record: `tower: { offered, quota_bytes, keep_days_silent, form }`, signed with the rest of the record as
`lijox-register:v5` (lij-worker 0.21.0; a registry that does not know the block gets the record without it).
`offered` is what the box is doing when it registers — watching or not — and the record is sent again when that
changes. **The drill** is the one check that proves a tower publishes. It is started by a command on the box —
`node lij-adapter.js --tower-drill "<the provider's name or node key>"` (0.129.1; the Console shows the drills and
starts nothing, because a drill spends the box's coins). This
box funds and signs a small transaction of its own (20,000 sats, `TOWER_DRILL_SATS`) to a one-time script, hands the
other provider's tower the transaction that spends it back — encrypted under the first one's id, exactly as a wallet
uploads — and then publishes the first. A tower that works publishes the answer by itself; the drill passes when the
answer is in a block at most six above the first transaction's. If it is not, this box publishes the answer itself to
take the coins back and the drill has failed. The cost is the two transactions' fees. See `tower-drill.js`.

**Who may use the tower: the voucher (0.130.0).** Until this release any key could sign in at a tower, so somebody
with no wallet at all could take every key slot. A wallet key is now admitted by a VOUCHER. The wallet makes one
voucher key from its 12 words; its own provider signs `lijox-voucher-v1|tower|<voucher key>` with its node key — once,
at the wallet's first fee, for the wallet's life (`POST /v1/tower/voucher`, the ask proven by the wallet's node key).
At a tower the wallet shows that signature with a use line signed by the voucher key,
`lijox-voucher-use-v1|<this tower's node key>|<the wallet's tower key here>`. The tower checks both, once, and the key
stays admitted for as long as it keeps coming; the provider is never asked again and can take nothing back. A copied
voucher is useless — at another tower the use line names the wrong tower — so nothing a tower keeps has to be secret
from a spammer. The registry is open, so a tower also counts per vouching provider (`TOWER_ISSUER_MAX_KEYS`,
`TOWER_ISSUER_NEW_PER_DAY`) and takes another provider's vouchers only when its own node sees that provider with at
least `TOWER_ISSUER_MIN_CAPACITY_SATS` of public channels (LND GetNodeInfo — both key recipes carry it from this
release) or the operator named it (`TOWER_ISSUERS_ALLOW`). `TOWER_ADMIT=open` (the default while wallets move over)
still takes a key without a voucher; `TOWER_ADMIT=voucher` requires one; keys held before stay admitted. The total
keys and the total bytes are settings now (`TOWER_MAX_KEYS`, `TOWER_MAX_BYTES`). The joining drill vouches for its own
one-time key. See `tower-admit.js` and KNOWN-FINDINGS 0.130.0.

**What arrived must cover what is paid on (0.130.1).** An intercepted HTLC carries two amounts: what arrived on it,
and what its onion asks this node to send on. LND compares them only when it forwards the HTLC itself. A JIT open —
and a held forward the adapter delivers with an HTLC of its own — is paid by the adapter, so the adapter compares
them: an HTLC on which less arrived than it asks to be sent on is failed back at the interceptor, and a set
of parts is refused whole, before any channel is opened, when the parts' arrived amounts sum to less than what would
be paid on plus the open fee. Every operator must run 0.130.1 or later before serving wallets. See KNOWN-FINDINGS
0.130.1 and `jit-arrived.test.js`.

**Requests inside the Lightning connection (0.137.0).** A wallet's payments and channel messages already travel
inside the Lightning connection, encrypted between the wallet's node key and this node's. Everything else a wallet
asked its provider was a web request to the API address, readable by whoever ends that address's TLS — on a
Cloudflare route, Cloudflare. From this release the adapter also takes requests inside the Lightning connection, in the
form of LSPS0 (bLIP-50): one Lightning message type, 37913, carrying one JSON-RPC 2.0 object. LND hands every message
of that type to the adapter with the sending peer's key (`cooperative-chain-bridge.js`), and `lijox-rpc.js` answers
through LND to the same peer. The caller is the connection's key, proven by the Lightning handshake: no signed proof
and no route token is read on this path. A request's answer is the body its web route gives (a refusal comes back as
an error whose code is the web route's status). JSON longer than 60,000 bytes travels in numbered parts
(`lijox.part`, at most 32). Limits are per peer, not per internet address: 120 requests a minute
(`LIJOX_RPC_PER_MIN`), 2,000,000 bytes held in parts. `lijox.hello` answers what this provider serves on the path;
`/health` carries `rpc: { lsps0: true }` so a wallet knows to ask. **One request is served both ways in this
release:** the wallet's settings (`lijox.prefs_set` = `POST /client/prefs`, one function). The web routes are all
unchanged, and a wallet on an older release never sends a 37913 message. A method that transfers money must carry
`rid` (32 hex characters) and runs once: a `rid` seen in the last 24 hours gets its stored answer
(`DATA_DIR/lijox-rid/`, kept across a restart; `lijox.what_became` reads it) — no such method is served yet.
The adapter also counts, per wallet key and day, tunnel openings with and without a pass and requests that came as a
web request though they have a form inside the connection (`form-counts.js`; counts only, 40 days).
`node lij-adapter.js --form-counts` prints the last 30 days; it is the number to read before `STATE_PASS_REQUIRED=1`
is set. Needs the chain bridge (`CHAIN_BRIDGE_ENABLED`, on by default) and the two custom-message permissions the
adapter's key already holds. See `lijox-rpc.js`, `form-counts.js` and their tests.

**The send path's asks inside the connection (0.138.0).** Three more requests are answered inside the Lightning
connection: `lijox.route_build` = `POST /v1/route/build`, `lijox.route_report` = `POST /v1/route/report`,
`lijox.outcome` = `GET /v1/outcome`. No money moves by these three; the payment is the Lightning payment that
follows. From this release a request that came inside the connection is carried out by its web route's own code
(`lijox-web-form.js`): the adapter hands its web handler a request it makes itself, marked with the connection's
key, and sends back what the route answered. So both forms run one piece of code — the same checks, the same
limits, the same answer. What stands in for what: the adapter puts its own route token on that request; the signed
proof a route asks for is met by the connection itself (the key a request names must be the connection's key, or it
is refused); the client's address becomes `ln:` and the first 16 characters of the wallet's key, so a limit per
address is a limit per wallet, and the journal's `[HTTP]` line says `inside the connection of <key>…`. No web
request can claim to have come inside a connection: the mark is not a header, a query field or a JSON field.
`node lij-adapter.js --form-counts` now also counts the route requests and outcome checks that still come as web
requests (their web form names no wallet, so they are counted by method).

**The wallet page's asks inside the connection (0.139.0).** Seven more requests are answered inside the Lightning
connection, each by its web route's own code. None of them moves money:
`lijox.lnurl_fetch` = `POST /v1/lnurl/fetch` (an answer longer than one message goes back in parts),
`lijox.onchain_quote` = `POST /v1/onchain-pay/quote`, `lijox.onchain_status` = `GET /v1/onchain-pay/status`,
`lijox.push_quote` = `GET /push/quote`, `lijox.push_status` = `GET /push/status/<hash>`,
`lijox.push_receivable` = `GET /push/receivable`, `lijox.push_note` = `GET /push/note/<hash>`.
Where the web form names the wallet's key, the request inside the connection is answered for the connection's own
key, whatever it names. The on-chain status read takes its signed proof from the query string; inside a connection
those fields are given the connection's mark, so the connection's key is the proof there too. `--form-counts` counts
the web forms of five of the seven. It does not count `GET /push/status/<hash>` and `GET /push/note/<hash>` as
older-form requests: a wallet of another provider reads a Push Key's status and note here by design, over the web,
and has no Lightning connection to this box.

**The requests that move money, inside the connection (0.140.0).** Five more requests are answered inside the
Lightning connection, each by its web route's own code: `lijox.onchain_open` = `POST /v1/onchain-pay/open`,
`lijox.onchain_release` = `POST /v1/onchain-pay/release`, `lijox.push_lock` = `POST /push/lock`,
`lijox.push_void` = `POST /push/void`, `lijox.push_claim` = `POST /push/claim` (65 s), and the read
`lijox.push_claim_status` = `GET /push/claim-status/<hash>`. Each of the five carries `rid`, 32 hex characters the
wallet makes once per tap. The path runs a route once for a `rid`, keeps the answer 24 hours, and gives that answer
again to the same `rid`; `lijox.what_became {rid}` says not known, started, or done with the answer. So a wallet
that got no answer can ask again without the request being carried out twice. A route that gave no answer within
its limit is not kept as an answer: its `rid` stays "started". `POST /push/deliver` is not moved: it is asked of the
provider that holds a Push Key by a wallet of another provider, which has no Lightning connection to this box.

**Receiving and channels, inside the connection (0.141.0).** Nine more requests are answered inside the Lightning
connection, each by its web route's own code: `lijox.jit_info` = `GET /lsps2/get_info`, `lijox.jit_buy` =
`POST /lsps2/buy`, `lijox.register_secret` = `POST /lsps2/register_secret` (both forms), `lijox.pending` =
`POST /lsps2/pending`, `lijox.openintent` = `POST /openintent`, `lijox.openintent_status` = `GET /openintent/<id>`,
`lijox.funding_status` = `GET /v1/jit-funding/status`, `lijox.lease_policy` = `GET /lease/policy`,
`lijox.wake_schedule` = `POST /v1/wake/schedule`. None moves money, so none carries `rid`: a buy makes a promise that
ends by itself, a secret is stored under a key, an open intent is a status record. Inside the connection the wallet's
key is the connection's key: the wake poll and the reminder times need no signature there; a channel secret is taken
only for a promise that same wallet bought; an open intent must name the connection's key. `GET /lsps2/get_info`
stays open as a web request: a wallet reads it for a provider it is not connected to.

**The rest of the wallet's requests, inside the connection (0.142.0).** Twenty-two more requests, from one table
(`REST142` in `lij-adapter.js`): the wallet's addresses (`lijox.lnurl_register`, `lijox.lnurl_release`,
`lijox.lnurl_display`, `lijox.lnurl_note`, `lijox.lnurl_register_open`), its standing (`lijox.heartbeat`,
`lijox.push_subscribe`, `lijox.nwc_register`, `lijox.nwc_unregister`, `lijox.subs_seller`, `lijox.tapedrop`), the
tower and the kit holder (`lijox.tower_voucher`, `lijox.tower_put`, `lijox.tower_status`, `lijox.tower_drop`,
`lijox.kit_put`), and chits (`lijox.delegate_register`, `lijox.delegate_void`, `lijox.delegate_refund` — these three
carry `rid` — and the reads `lijox.delegate_claims`, `lijox.delegate_refunds`, `lijox.delegate_slip`). Each is
carried out by its web route's own code with the body or the query the web request has. Where a route takes the node
key's challenge proof, the connection's key replaces it; where a route checks a signature the wallet makes by itself
(NWC, chits, the tower, the kit holder), that signature rides as before. A request inside the connection is limited
per wallet, not as one shared address.

**Two things the box now says truthfully (0.143.0).** (1) The journal wrote `[NWC] woke <wallet>` whenever the wake
call returned, also when no push had gone out. The wake now answers what happened, and the line follows it:
`[NWC] woke …` only for a push that went out; otherwise `[NWC] no wake went to … — <why>` (the wallet is connected and
needs none; a wake was asked for moments ago; the wallet has no push subscription here; push is off; the push service
did not take it). The Console's "wakes today" counts the pushes that went out and states the rest beside it. (2) The
store of diagnostic tapes: once it has filled it stays at its cap, and each new tape pushes out tapes older than
`TAPES_KEEP_DAYS` — that is routine and the journal line now says so. What matters is the room a new tape can still
get (the free bytes plus what the tapes older than the keep days hold): at zero a new tape is refused (507) and is not
kept here. The box states that room at start-up, on each sweep and in the Console ("tape store"), counts the refused
tapes since its start, and writes a refusal as `[TapeDrop] STORE FULL — … REFUSED and is not kept`. What is deleted
and when is unchanged.

**Two more requests inside the connection, and the provider's signed word on its record (0.144.0).** Two rows
joined the table: `lijox.channel_record` — the record a wallet's engine sends when a channel is ready
(`POST /lsps/registry/channels`); inside the connection it is stored under the connection's key, and the challenge and
the signature are not asked for — and `lijox.mix_seat` — a Mix seat taken in the wallet's own name
(`POST /tatara/seat`, signed by its node key). A ring-signed seat names no wallet and is refused inside the connection:
it stays a web request, as does every other Mix request. The registry record now carries `rpc: ["lsps0"]` while the
path is up: this provider's signed word that it takes requests inside the Lightning connection
(`lijox-register:v7`, the twin of lij-worker 0.24.0). Which methods it serves a wallet asks inside the connection
(`lijox.hello`). A registry that does not know the list is given the record without it.

**The checks a wallet makes before it connects, inside a check tunnel (0.145.0).** Before a wallet connects as itself
it asks this box up to four things: its statement and the pass, its channel state file, its channel list, and — in a
recovery — a close. They must be asked before the wallet connects as itself, so they cannot go inside its own
connection. From this release a wallet can ask them inside a short Lightning connection of its own, under a key made
for that one start: its WebSocket sends the text frame `lijox-check` before its first bytes. Such a tunnel is passed
through without a pass even where passes are required, is limited per internet address (`CHECK_TUNNELS_PER_MIN`,
12), and is closed after 20 seconds. Five more methods, each handed its web request's own body with the wallet's
real key and that key's signature inside: `lijox.state`, `lijox.registry_challenge`, `lijox.state_file`,
`lijox.my_channels`, `lijox.recover_close`. The key on a check tunnel is never taken as the wallet. It is served
those five and `lijox.hello` only, its requests are limited by the tunnel's internet address, and a key there that
holds a channel with this node gets the tunnel closed. The web forms of the five stay open.

**Not inside Lightning: what the operator is told (0.146.0).** A request that has a form inside the Lightning
connection and still comes as a web request is counted (since 0.137.0) — and from this release it is also said and
shown. The journal: `[RPC] NOT INSIDE LIGHTNING: <method> came as a web request from <the first 16 characters of the
wallet's key>…`, once an hour for a wallet and a method. The Console: the pane "Not inside Lightning" — today's web
requests of moved methods, how many wallets they name, which methods, and beside them today's requests inside the
connection. The five checks of 0.145.0 are counted too, but only for a wallet that holds a channel with this node: a
wallet of another provider asks them here as web requests by design. They are counted where their body is read and names the key,
before its proof is checked. Nothing is refused by this; refusing is `LIJOX_WEB_FORMS=refuse`, below.

**Refusing the old web forms (0.142.0, off by default).** `LIJOX_WEB_FORMS=refuse` makes this box answer 426 to the
web form of every moved request and not carry it out. Left out, so never refused: what a wallet of another provider
asks here by design (a Push Key's status, note, cancel and delivery; a chit's record; the kit holder; the tower),
a diagnostic tape (a wallet sends it when its connection has failed), the public reads, `GET /lsps2/get_info` without a wallet's key, and the checks a wallet makes before it connects.
Before turning it on, read `node lij-adapter.js --form-counts`: it lists the web forms wallets still send.

**The watch-only list of payments (0.140.0).** `lij-sm.js` writes the journal's `[SM-…]` lines and never touches
LND. It now learns of every answer the adapter writes to LND for an HTLC. A payment handed straight back to LND
leaves the list at once; until this release it was printed as `in flight … INTERCEPTED` once or twice after it was
over, and `/v1/outcome` answered "pending" for it for up to two and a half minutes.

**A wallet that is behind its channels is not passed through to LND (0.136.0).** LND closes a channel by force the
moment the other side reconnects with an older state; it does not ask why. What travels through the adapter's
tunnel is encrypted between the wallet
and LND, so the adapter cannot read the wallet's reconnect message, and LND's API gives out one of the two numbers it
compares, not both. What can decide is the wallet's own record. A wallet states, signed with its node key, the update
number of each channel record it holds (`POST /v1/state`); that number rises with every change and never falls. The
adapter keeps the highest number stated per wallet key and channel (`DATA_DIR/state-marks/`). A wallet that states a
lower number than its own high mark is behind: the answer names the channels with both numbers and carries no pass.
A wallet that is not behind gets a pass (good once, for 90 seconds) and presents it on its WebSocket before its first
bytes; the tunnel takes the pass before anything is opened to LND. A channel LND no longer holds open is left out of
the comparison. A wallet that presents no pass (an older wallet) is passed through as before, unless
`STATE_PASS_REQUIRED=1` is set in `.env`: then no wallet reaches LND without a pass. The limit of this: the high mark
is as fresh as the wallet's last statement (a wallet states after each change of state). See `state-marks.js`,
`ws-tunnel.js` and their tests.

**Confirmations for a channel a wallet funds (0.135.0).** When a wallet opens a channel to this node with its own
coins, LND tells the wallet's node how many confirmations it asks for before the channel can be used. LND does not give
that number out over its API, so the adapter states it on the registry record (`chan_confs: {min, max}`, signed with
the rest as `lijox-register:v6`) for a wallet to show before anyone opens a channel. It takes the first of these that
holds: `CHAN_CONFS` in `.env` (one number, `3`, or a range, `3-6`); `bitcoin.defaultchanconfs` in the lnd.conf that
`TATARA_LND_CONF` names; LND's own rule (3 for a small channel, rising with its size to 6). The boot line
`[ChanConfs] …` says which one it took. A wallet checks the statement at every channel it funds against the number LND
really asked for and shows any difference, so a wrong statement is seen. A registry that does not know the block gets
the record without it. This is not the number for a channel the provider opens to a wallet.

**Subscriptions — the provider's part (0.134.0).** A subscription is an agreement between a wallet user and a
merchant; nothing is ever sent automatically. The provider does four small things (`subs.js`; the format's design rounds
are not yet published). (1) **Reminder times:** a wallet hands its own provider a list of times
(`POST /v1/wake/schedule`, the node key's proof, at most 64, none more than 400 days ahead); at each one the provider
sends the wake push `{"t":"due"}` — unless the wallet is live at that moment. The provider is told times only: no
merchant, no plan, no amount. (2) **A plan server beside the adapter** (the sidecar, its own repository), when
`SUBS_SIDECAR_URL`, `SUBS_SIDECAR_LOCAL` and `SUBS_SIDECAR_SECRET` are set: `/subs/…` is the plan server's public
route (plans, agreements, status, invoices — handed to the sidecar on this box, the answer returned as it came), and a
local route that only the sidecar on this box can use (the shared secret, a loopback socket, no mark of the public
front) gives it what it needs from LND, because only the adapter writes to LND: an invoice of this node for a
business selling from its own node, or an invoice on a wallet user's next SELLING HASH. (3) **A wallet user who
sells** registers selling hashes under its selling name (`subs--…`, made from its node key; nobody's address — the
public address routes answer "unknown name" for it), each with the signature of its selling key, which the paying
wallet checks: the provider can refuse or delay such a payment and cannot collect it. The payment takes the
Lightning-address path unchanged — held, the wallet woken, delivered — and the seller's phone takes it only after it
has read the invoice's description here (`GET /lnurl/note/<hash>`, `subs.description`) and checked its tag. A seller's
requests to the sidecar pass through `POST /v1/subs/seller` after the node key's proof; the sidecar holds no key of
any seller. `SUBS_SELLER_FEE_PCT` (and `SUBS_SELLER_FEE_CAP_SAT`) is the seller service's fee, taken off what is
delivered and shown on its own line of the PL. (4) **One-use addresses**, when `LNURLP_ONE_USE_HOST` is set: a name of
the form `once--<12 characters>` for one payment back to a wallet (a refund), under the host THIS provider names —
never claimed at the shared address host — with at most five payment hashes, used up by its first settled payment and
dropped after 35 days. A name with `--` in it is reserved for these two kinds. A payment hash now lives under one
name on a box, and a registration's answer carries `wallet_next_index`, the next index across every name of that
wallet. A seller picks how it pays the provider: the share of each payment above, or — where the sidecar on this box offers a plan with the id `seller-service` — a monthly subscription to it. For a seller on the monthly plan the sidecar marks each invoice it asks for `no_fee`, and no share of that payment is kept.

**Zaps — each wallet's choice (0.131.0, 0.132.0).** With `ZAPS_ENABLED=true` the provider OFFERS zaps from Nostr
apps (NIP-57). An address takes them only while the wallet that owns it has turned them on: the wallet's own signed
choice, `POST /client/prefs { client_pubkey, zaps: true|false }` with the node key's proof over `prefs-zaps:1` or
`prefs-zaps:0`, kept beside its holding choice. A wallet that never chose has them off: its addresses answer as they
did before zaps existed and nothing is ever published for it. For a wallet that has them on: the plain address answer
carries `allowsNostr: true` and `nostrPubkey`; the Register answer does not. `nostrPubkey` is that ADDRESS's own
receipt key, made from the box's secret (`DATA_DIR/zap-receipt.key`, made once) and the address name — no one key
signs for two addresses. A zap request in the callback's `nostr` parameter is checked before a hash is reserved —
signature, kind 9734, one `p` tag, at most one `e`, `a`, `P`, `k` and `amount` tag, the amount tag equal to the
amount — and a bad one is refused with its reason; a good one's invoice is tied to the request itself (its
description hash) instead of the address metadata. When the invoice settles, and the wallet still has zaps on, a
receipt (kind 9735) signed with the address's key goes to `ZAP_RELAYS` (default relay.primal.net, relay.damus.io,
nos.lol), tried three times. The receipt is dated when the SENDER'S payment reached this provider, not when the
wallet took it. The relays the sender names are used only with `ZAP_REQUEST_RELAYS=true`, because they are any
server the sender picks. Every relay connection is wss:// to a public address, checked when the socket connects.
What an operator should know: the box connects to the relays itself, so they see its outgoing address; and a receipt
can only be sent after the wallet took the payment, so the relays see when that was. See `zap.js` and
KNOWN-FINDINGS 0.131.0 and 0.132.0.

**A wallet's sent payment, settled or failed here while the wallet is offline (0.133.0).** An HTLC leaves a channel
only when both sides sign, so a payment the provider settles or fails while the sending wallet is offline waits on
that wallet's channel until it connects. A settled one makes LND close the channel on-chain 16 blocks below the
HTLC's expiry if the wallet has not come back (LND 0.21 and above; 10 before — `lnd-margins.js` reads the running
LND's version, `LND_INCOMING_BROADCAST_DELTA` overrides; 0.133.4). `sent-watch.js` reads LND every 2 minutes (it settles, fails, closes
and pays nothing), sorts each such HTLC — in flight, completed, returned, or undecided — and wakes the wallet through
its push subscription: at once, then about a day, six hours and one hour before the block (kinds `sent_completed`,
with the time to open by, and `sent_returned`). On any doubt nothing is sent, and nothing is sent past the block. The
Console's card "Pending HTLCs" lists every pending HTLC on the box with the block at which a channel goes on-chain
over it (0.133.3 — it then holds what the Channels pane counts); one within 100 blocks of that block is marked, and
counted on Guardrails. It is a report and has no button. No setting; the state is `DATA_DIR/sent-watch.json`. See
`sent-watch.js`, `sent-watch.test.js`, `console-sent-watch.test.js` and KNOWN-FINDINGS 0.133.0. From 0.133.2 the
Console's cards are measured in a browser before a release (`console-layout.check.mjs`: every card one tile of the
condensed size, at a desk width and a phone width; it needs `PLAYWRIGHT_MODULE`).

**A delivery in parts (0.127.0).** When the provider itself delivers a payment to a wallet (a Lightning address
payment, a Push Key, a chit) and no one channel to the wallet has the room but its channels together do, the payment
goes in parts — one HTLC per channel, the same hash and payment secret, the whole amount in every part's MPP record —
and no channel is opened. `LSPS2_DELIVER_MAX_PARTS` (4) and `LSPS2_DELIVER_MIN_PART_SATS` (1000) are the settings.
See `deliver-parts.js` and KNOWN-FINDINGS 0.127.0. From 0.127.1 a route request for a wallet on this provider that no one
channel can carry, but its channels together can, is answered `no_route` with `parts_sats` — the sizes a sender can
split the payment into.

**The Black start page at `/recover` (0.109+).** Every LIJOX adapter also serves the wallet site's own recovery
page — the one self-contained file `recover/index.html` shipped with each release, its hash in RELEASES.md — at
`GET /recover`. A user with only the 12 words reaches it at any provider when lightninginajar.xyz does not open;
the page asks the providers and the chain servers only, and this box learns nothing from it. `/health` carries
`recover_page` (the page's build). This is a LIJOX standard like the watchtower: a provider serves the page.

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

`NWC_ENABLED=true` turns it on (off by default — an operator's choice; the wallet's NWC screen
under Connections greys where a provider does not offer it). `POST /v1/nwc/register` and `/unregister` take the
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

## Connection routes into the box — `routes` and `reach` (0.108+)

A wallet reaches a provider through the three addresses in its registry record: the API (`endpoint`), the
browser's Lightning peer link (`wss_url`) and the block-filter server (`filter_url`). What sits between the
wallet and the box on those addresses is the operator's business, and the record now says it: `PUBLIC_REACH`
is signed into the record as route 1's `reach` — `cloudflare` when a Cloudflare tunnel ends TLS at
Cloudflare's edge (the default when unset; the honest word for every box set up with the tunnel), `direct`
when TLS ends on the operator's own machine (a blind TCP relay such as `ops/relay`, or a port forward).
Wallets show the word as a badge and may prefer or refuse a reach. A second connection route into the same box goes in as
`ROUTE_2_REACH` / `ROUTE_2_HTTPS_URL` / `ROUTE_2_WSS_URL` / `ROUTE_2_FILTER_URL` (a third as `ROUTE_3_*`) —
for example the direct names as route 1 and the Cloudflare names as route 2, so a wallet that loses one route
takes the other. The record is signed as `lijox-register:v4` (registry 0.13.0+; an older registry gets the first
route alone, as v3). Two checks keep the word honest without the operator's say: a route that claims `direct` but
answers with Cloudflare's own header (`cf-ray`) is registered as `cloudflare` and the journal says so; an unset
`PUBLIC_REACH` on a route that answers without that header gets a hint to set `direct`. A second route's filter
server is offered only when it answers `/tip`, as route 1's is; a malformed second route is skipped with a line,
never refused. `/health` carries `routes` and `routes_notes`; the console's settings report lists them (its rows are still labelled "Front doors").
The routes are checked once this box itself is listening (0.108.1 — until then the boot asked before its own port
was open, and every route read `HTTP 502` in the journal; the reach reading was right regardless).
`node routes.test.js` checks the record against the registry's bytes and every case of the checks.

## Mix pools — LIJOX's Tatara (0.97+; public rooms 0.106+)

With `TATARA_ENABLED=true` the adapter offers its wallets coinjoin pools built on the public joinstr v2
code: the provider keeps the waiting list (seats signed by a per-seat key), starts a pool when
`TATARA_MIN_PEOPLE` have joined (3–6 people; `TATARA_SIZES`, each at least 10,000 sats), wakes the
seats by push, relays the pool's messages (`/tatara/relay`) and forwards coin checks and payouts to
other providers so that no wallet's payout ever passes through its own provider. Channel pools
(0.103+, `TATARA_CHANNEL_POOLS`, `TATARA_CHANNEL_SIZES`) pay a pool's exit straight into a new
channel; the sizes are checked against LND's own channel limits read from `TATARA_LND_CONF`. From
0.106.0 a pool size with seats waiting but fewer than the minimum gets a room on a public nostr
relay (`TATARA_PUBLIC_ROOMS`, `TATARA_PUBLIC_RELAY`, `TATARA_ROOM_WINDOW_S`): a joinstr v2 pool
announcement signed by a key the host makes for the room, open to anyone with a joinstr wallet, and
honoured only once a stranger has registered a coin whose ownership proof verifies and whose coin
is on the chain as registered; the outcome is never read off the relay — the seats' signed reports
decide. 0.107.0 adds the room's stranger count to a seat's check-in. The registry record carries the
`tatara` block (`lijox-register:v3`, signed field by field). The changes made to the public joinstr
code are the wallet repository's `docs/joinstr-patches.md`; the design rounds and security reviews are
not yet published; the tests are `tatara-*.test.js`. Nothing in a room announcement names LIJOX.

## The operator console (0.71+)

The adapter serves its own monitor at `/console` on a separate port (`CONSOLE_PORT`, default 7004), bound to loopback and the Tailscale interface only — it has no place on the public tunnel. Login is a six-digit TOTP code and nothing else (`node lij-adapter.js --totp-enroll` prints the secret for `config.env` and the setup key for an authenticator app); a code is accepted once, five wrong codes lock the address for ten minutes, a correct one opens a 12-hour session bound to the caller's address. The page loads nothing from anywhere (CSP `default-src 'none'`, script and style by hash) and the adapter makes no outbound call on its behalf — there is no update check by design.

Panes: guardrails (the live open-fee multiplier and its inputs, the per-wallet open ladder, JIT sizing, the lease), a settings report (every dial the box runs on, its value and where it came from — read-only; the console never writes to LND or to `.env`; LND's actual fee policy on wallet channels is read beside the advertised numbers), PL (day / MTD / YTD / LTD with a calendar, from a fee ledger the adapter writes when a fee is actually kept plus LND's forwarding, payment and chain history; daily snapshots so life-to-date never rescans), node, balances, channels (Tor/clearnet per peer, lease clock with what last renewed it, a per-channel note, exclude/include from the lease), wallets served (with an operator label), pending, unconfirmed on-chain, registry status, SCB backup legs, loops. Notes and labels live in `console-notes.json` in the data folder — per instance, never in git. Some panes need read-only LND permissions the original macaroon lacks (`GetTransactions`, `ForwardingHistory`, `ClosedChannels`, `ChannelBalance`, `PendingSweeps`); a pane says which one it is missing rather than guessing, and `bake-permissions.json` carries them for the next bake.

The lease (a silent wallet's channel is force-closed after `LEASE_DAYS`, its balance paid to the wallet's own address) measures liveliness as *contact*: any message or API call from the wallet renews it, stamped when the wallet acts, persisted once per session. It considers every channel except the ones the operator excludes in the console, and it closes nothing until that exclusion list has been saved at least once. See KNOWN-FINDINGS for the two defects that shaped this (2026-09-08).

Names and marks (Lightning in a Jar, LiJ, LIJOX, the jar logo) are not licensed with the code — see [TRADEMARKS.md](TRADEMARKS.md).
