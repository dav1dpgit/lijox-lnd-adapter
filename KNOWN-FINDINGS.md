# KNOWN FINDINGS — RELEASE BLOCKERS
This repository MUST NOT go public while this file lists anything.

| # | file | what | fix |
|---|------|------|-----|
| — | (empty — milestone 1 complete, v0.47.0) | | |

History: seven operator-identity couplings were imported knowingly at
ee53b20 and removed in milestone 1 (peer/pubkey/WAN-IP literals →
operator config; registry default → optional/empty; PUBLIC URLs +
origin lists → REQUIRED with startup refusal; delegate store path →
LIJ_DATA_DIR/__dirname). Gate rule stands: full-tree scan with the
maintainer's private patterns file before any release tag.

## 2026-09-02 — the 30-day cliff, lost preimages, and registry-first LSP (S43)
- Engine registered static-address hashes with LDK for 30 days; the adapter
  kept free hashes forever and minted the oldest first. Any address older
  than a month whose 50 weren't consumed was refused by the phone as
  expired, the adapter retried the permanent refusal until the hold window,
  and the sender's sats sat held. FIXED: engine v229 (30-year life, `expires`
  + `index` in the registration) + adapter 0.67.0 (honors `expires`, mints
  live-only, counts live-only, cancels the outer on a definitive refusal,
  probes ListPayments for in-flight truth) + 0.67.1 (pre-0.67.0 random
  hashes retired once).
- Preimages were random per device in one storage key that was never in
  the backup bundle. FIXED: v229 derives them from the seed by index; the
  pool is a cache; v228 also ships the cache in the bundle.
- The wallet page used the LIJOX registry's FIRST viable entry as "the LSP"
  for every LNURLp call; with LiJ-Node-2 listed first, pay codes were
  minted at an LSP holding no channel (21,000-sat minimum) and UM890
  addresses starved of top-ups. FIXED: page v666 resolves the engine's peer
  by pubkey. See lightning-in-a-jar/docs/static-address-model.md.
- The delivery belt re-sent SendToRoute for the same hash after the 25 s RPC
  deadline; LND refused each with "attempted value exceeds payment amount".
  A receiver claiming after the deadline was paid without the outer
  settling (LSP loss). FIXED 0.67.0 (ListPayments probe; blind fallback on
  the Umbrel's macaroon — ListPayments is not in bake-permissions-nodelegate).

## 2026-09-03 — the fixed bolt11 open charged a different fee (S44)
Found reading the fee sites for DP's new opening-fee law. Three settings
priced a channel open: the LNURL rail and the open-amount flush charged
max(LSPS2_VAR_MIN_FEE_MSAT, LSPS2_VAR_FEE_PPM × amount) × escalators; the
FIXED bolt11 buy charged LSPS2_CHANNEL_OPEN_FEE_SATS flat (default 2,500
sats, no %, no escalators) — the 0.61.0 startup warning said that knob "is
not what this box charges" while the buy handler still charged it. Fixed in
0.69.0: one function, `channelOpenFeeMsat`, computes every opening fee
(LNURL, bolt11 fixed, bolt11 open-amount + its held-replay; LSPS1 when it
returns); knobs renamed rail-neutral (CHANNEL_OPEN_FEE_MIN_SATS /
CHANNEL_OPEN_FEE_PPM, defaults 100 / 100), the flat knob ignored with a
warning. Not a blocker; recorded so the public README can state the law.

## 2026-09-04 — the Umbrel's lease close could never run (S44)
`LEASE_LNCLI=docker exec lightning_lnd_1 lncli` on the Umbrel, and
`leaseForceClose` passed that whole string to `execFile` as the program name,
which fails ENOENT. The lease loop's close (and 0.70.0's recover-close, which
reuses it) could not have executed on that box; the UM890 (`lncli` on PATH)
was unaffected. Fixed in 0.70.1: the string is split on whitespace — first
token is the program, the rest lead the arguments. Found while reading the
Umbrel's .env line during the 0.70.0 ride; not observed in a journal.

## 2026-09-08 — a dead cooperative close lingered as "unconfirmed" in LND's wallet

**Seen:** the UM890's `walletbalance` showed `unconfirmed_balance: 189994` for days
with no activity. `lncli listchaintxns` had three 0-conf transactions labelled
`lij-broadcast:N` (the adapter's chain-bridge broadcast label): `fd916231…`
(189,994 sats to us) and two 0-amount ones. `bitcoin-cli getmempoolentry` answered
"not in mempool" for all three; `pendingsweeps` was empty.

**Cause:** `fd916231…` was a wallet's cooperative close, broadcast through this node
on 2026-09-03, then double-spent by the wallet's holder commitment (`f27b2772…`,
block 965353 — the boot force-close defect fixed by the engine's `lij_coop_hold`).
The real funds arrived via the commitment and are confirmed. LND's wallet keeps a
published transaction whose inputs were spent by another confirmed transaction as
"unconfirmed" indefinitely and counts it in `unconfirmed_balance`; the 0-amount
ones are other wallets' broadcasts LND recorded because it published them.

**Fix (operator's hand):** verify `getmempoolentry` says "not in mempool", then
`lncli wallet removetx <txid>` for each. Result: `unconfirmed_balance: 0`, confirmed
unchanged. Nothing moves; a record of an impossible transaction is deleted.

**Console:** 0.71.1's Unconfirmed on-chain pane shows such transactions (needs
GetTransactions in the macaroon). A "remove dead transaction" action behind
arm-and-confirm is on the phase-2 list.

## 2026-09-08 — the lease considered every channel, not only wallets' (found before dry run was turned off)

**Seen:** DP asked whether the lease only affects wallet channels before switching
`LEASE_DRY_RUN` off. Reading the cycle: it walked EVERY channel in `listchannels`
— exchange peers, routing peers, the other LSP — skipping only `LEASE_WORLD_PEER`
and `LEASE_EXCLUDE_CHANPOINTS`. With dry run off, any of those peers offline for
60 days (Tor hiccups included) would have been force-closed. Compounded by the
stamping defect fixed in 0.72.2 (a wallet online between hourly ticks kept
ageing). The dry run — on since the lease shipped — was the only protection.

**Fix (0.72.4, DP RULED — "a safe list of what is excluded, rather than the
reverse; I know with whom I have channels open"):** the lease considers every
channel EXCEPT the ones on the operator's exclusion list, set and saved from the
console per channel (DATA_DIR/lease-exclude.json — per instance, gitignored, never
shared). Until that list has been saved at least once, the lease refuses to close
anything, even with dry run off (`exclusion_list_unsaved` / `would_close_unsaved_list`
in the log): an unset list is not consent. The 0.72.3 wallet-recognition stays
only as the console's "wallet" label.

**Before flipping dry run off on any box:** ride ≥0.72.4, exclude every
non-wallet channel in the console (the Guardrails row must show "list saved" and
the right excluded count), read `lease-log.ndjson` for `would_close` (wallet
channels only), and re-seed if stamps predate 0.72.2.

## 2026-09-10 — the "admin" secret was public, and one admin route sat on the internet

**Seen:** while comparing against Alby Hub's 2026 management-API breach. The adapter's
`ADAPTER_SECRET` is by design the route token every wallet receives from the registry
(`route_macaroon`) — a capability token, public. The setup guide (0.71.0) called it
"admin and route auth", and `GET /admin/registry/channels` (the wallets' channel
records) was served on the public API behind that token, i.e. to anyone.

**Fix (0.74.0):** the route is retired (410); the records are on the console's
Wallets pane (loopback + Tailscale, TOTP). Docs corrected: there is no admin secret
on the public API and nothing must ever be gated by the route token alone. The console
remains the only management surface and never reaches the internet.

## 2026-10-24 — the external review (Kimi K3 via OpenRouter; S63): four adapter findings fixed in 0.111.0

**Seen:** the review package built from f9312fb (the public-API extracts of lij-adapter.js plus the modules); every
finding checked against the whole tree before anything changed.

- **Anyone could force-close every idle wallet channel.** `POST /lease/ttl` sat behind the published route token and
  accepted 0.0001 days; `GET /lease/status` listed every channel point; the next hourly cycle closed. `/health/jit`
  (the operator's float, every wallet's balances, live promises, held payments) and `/ops/loops` (backup staleness)
  answered the same token. **Fix:** the four routes answer 410; the data and the setter are on the console (loopback +
  Tailscale, TOTP): GET /console/lease, the lease setter on each channel row (floor one day, arm + confirm), the JIT · now
  pane. The lease was put into dry run on both boxes the night the finding landed and comes off with this ride.
- **Anyone shown a JIT invoice could make the payment fail.** `/lsps2/register_secret` let any caller overwrite a
  promise's payment secret (the scid is in the invoice's route hints); the forward then carried the wrong secret, the
  wallet refused it after the channel had opened, and the failure counted toward the guard. The hash-keyed store (plain
  invoices) overwrote too and its 500-entry FIFO could be flushed with junk. **Fix:** the first registration wins (the
  wallet registers before it shows the invoice; the same values again are fine; other values are refused 409); the hash
  store is bounded by count (5000) and age (nothing younger than two hours is evicted; full = 503).
- **A payment larger than its promise opened a channel that could never carry it.** The fixed-promise path had no
  branch for an HTLC above size + fee: the channel was sized from the promise, LND refused the bigger forward after the
  funding was published, the operator paid the open's chain fee, the payee paid nothing. The open-amount flush capped the
  sizing and forwarded the full sum (the same outcome). **Fix:** an HTLC above the promise is failed back at the door
  (TEMPORARY_CHANNEL_FAILURE), nothing opens; an open-amount set above the ceiling is refused whole, on the live path and
  on the replay. A payer who overpays a fixed-amount JIT invoice is refused now — rare, and the right side to err on.
- **One wallet could switch JIT off for everyone, for free, as often as it liked.** The guard counted funded-but-failed
  opens; three from one wallet (a wrong secret for its own promise suffices) halted JIT on every rail until released.
  **Fix (DP's ruling):** the halt counts DISTINCT WALLETS — his failsafe for a griefer with a million wallets stands, wallet
  number three still halts JIT for everyone; a single wallet's repeat failures block THAT wallet alone at
  JIT_GUARD_WALLET_AT (default 2; not 1 — S46's Register-QR incident was a wallet refusing payments because its block
  height lagged), for 24 h after its last failure or until released from the Console's Guardrails, which lists the
  blocked wallets. What remains, stated plainly: three throwaway wallets can still halt JIT at no cost — the price of
  zero-conf JIT; the guard is the answer until a wallet pays something before an open.

Still open from the same review, in order of weight: unsigned `/client/prefs` (any wallet's hold dial set to 0); the chit
refund's double pay on a transport error; the held-HTLC pool with no ceiling; the route-lookup, Push claim and kit-store
limits; `cf-connecting-ip` trusted from any socket (harmless behind the relay kit's Caddy, which strips it — other setups
must).

## 2026-10-24 — the external review, item 3: the Lightning address is signed (0.112.0)

- **Anyone holding the published route token could take a wallet's Lightning address.** `POST /lnurl/register` and
  `POST /lnurl/release` sat behind the route token (published to every wallet, i.e. anyone) and checked only that the
  pubkey STRING in the body matched the record — and a wallet's node pubkey is in every invoice it hands out. A stranger
  could release `alice@…` and register it again under his own key with his own hashes; every payer who kept the address
  would then pay him. **Fix (DP: "3 is a go, no grace period"):** both calls carry the push-subscribe proof — a
  single-use challenge from `GET /lsps/registry/challenge`, signed by the wallet's node key over the action and the
  record asked for: `<name>:<count>:<sha256 of the hash fields>` to register (a probe signs over the empty list), the
  name to release. The adapter rebuilds the record from the body it received, so a proof for one body is no proof for
  another; the signer must be the record's key; the nonce is spent only after the signature held. Unsigned calls are
  refused (401) from 0.112.0 — wallet engine v352 / page v1061 shipped first and sign both. `lnurlp-auth.test.js`
  (a1–a2) pins the record rule with the engine's own vectors and the refusals.


## 2026-10-26 — Phase C: the registry's two doors (0.118.0, with lij-worker 0.17.0 and lij-registry on the UM890)

DP 21:41: "keep the worker as the Cloudflare door. Agreed that the box has the same rules as the worker so they
behave the same. Go." (docs/design/routes/phase-c-r1.md §4.4 in the wallet repo.) Not a defect — the step recorded:
- **One registry address was all this box knew.** The LIJOX registry now has two doors — the box's direct door
  (`registry.lightninginajar.xyz`, the worker's own code under Node on the UM890 with a file store) and the worker
  on Cloudflare — kept level by a mirror the box drives. `LIJOX_REGISTRIES` lists every door this box enrolls at
  (comma-separated; the first is the one it reads); `LIJOX_REGISTRY` is read as a one-entry list; empty is
  registry-free as before. One signed record is posted to every door — the same bytes at each, so the mirror has
  nothing to level; a door older than lij-worker 0.13.0 gets the first door alone (v3), signed once more for it. The
  signed departure (`--unregister`) and every name claim, release or transfer go to each door ('taken' if any door
  says so, 'ok' if any door took it). The provider list is read from the first door that answers. The console's
  Registry row lists every door and its last answer; the snapshot carries `urls` and `doors`. A door that cannot be
  reached is that door's error for the hour, never a skipped registration elsewhere. The SCB push (ops/um890-scb's
  script) still names the worker alone — the mirror carries the copy to the box.

## 2026-10-26 — Kimi K3.1 Pro's round 2, B-19 made right and the one-open rule (0.117.0, with engine v356)

DP's 19:13 rulings: B-19 "(b). Go."; F21 "Go ahead, yes, but make sure it doesn't cause any trouble with normal
opens/payments. Be triply careful".
- **F9 / B-19 — the early-arrival sibling rescue could only misfire.** It was built for a real case (specimen 3d832527:
  the first shard of a JIT payment rode the wallet's existing real channel before any hash→promise binding existed;
  its sibling went to the alias; the aggregate starved) but keyed on `invoiceSecretsByHash`, which the engine fills
  only for PLAIN invoices — a JIT invoice registered its secret by scid, never by hash. So B-19 could never see the
  payment it was built for, and the only payments it could bind were plain-invoice ones, held with no window timer.
  Now engine v356 registers a fixed JIT invoice's secret by hash as well, with the promise's scid beside it
  (`jit_scid`); this adapter keeps the scid on the entry, B-19 binds a shard only when the hash's registered secret
  equals the promise's (the promise the entry names, else the peer's sole fixed promise — a plain invoice can never
  match), and arms the B-11 window timer when it creates the aggregate (a short set fails back and resets). The
  trampoline (B-10) skips an entry that carries `jit_scid`: a JIT invoice's held first shard is a part of a larger
  payment, and paying it alone would be refused by the wallet and trip the A2 latch against the siblings. A box on
  0.117.0 with an older engine sees no `jit_scid` and B-19 binds nothing (the secret never matches) — safe.
- **F21 — two deliveries to one wallet at once opened two channels.** An address sweep and a Push claim (or two
  payments to one name) both saw "no room" and passed the reserve check (the chain balance had not moved yet) and
  both called openChannelSync — two channels, two chain fees, the floor undercut by one funding; and a 'retry' after
  the RPC deadline re-entered while LND was still opening the first. Scoped to the DELIVERY rail only
  (`deliverToWallet`): one open per wallet at a time (`deliverOpening`; a second caller answers 'retry' — the sweep's
  next tick, as any retry); the reserve check adds the fundings of opens in flight; after a deadline the record is
  kept 90 s and the next entry reads LND's pending list for that wallet — pending means wait for it to list, nothing
  means open again. The pending list is read ONLY after a deadline, so a wallet with some other pending channel (a
  channel pool's) is never held back. The JIT interceptor path (`openChannelAndForward`, its per-promise
  `inFlightOpens` and settle-all) is untouched — DP: a working process is not to be impaired. The console snapshot
  lists `deliver_opening`.

## 2026-10-26 — Kimi K3.1 Pro's round 2, the proofs (0.116.0, with engine v355 and page v1069)

DP's rulings of 17:00/17:17 that needed the engine: F10 "Agreed", F4+F6 "Both. Agreed." (as corrected), F14 "Yes", K1
"Agreed". Engine v355 adds `lsp_proof(endpoint, action, record_id)` — the 0.112.0 proof for any action on a fixed list
(heartbeat, lsps2-pending, client-prefs, push-claim, push-deliver, push-claim-status, lnurl-note): the page assembles
the record from the body it is about to send, the engine signs the provider's single-use challenge over it with the
node key, this adapter rebuilds the record and refuses anything else (`lnurlpAuthCheck`). **A box on 0.116.0 needs
wallets on page v1069 or later** — an older page's claims, prefs and note reads are refused and its held payments do
not replay until it updates (the PWA updates on open). Deploy the page first.
- **F10 — self-declared pubkeys counted as proof of life.** `/health?client=`, the GET wake poll, `/client/prefs`, a JIT
  buy and `register_secret` all stamped `walletLastActiveMs` from a pubkey anyone can type (it is in every invoice); the
  replay gate and the wake gate read that stamp. A stranger could push a held payment's replay through while the
  phone's socket was alive but the app frozen — the open fails, the payment is failed back early. Now the stamp comes
  only from a verified proof: `POST /v1/heartbeat` (the page sends it every 30 s while open; record `hb:<unix s>`,
  within 90 s of now), the signed `POST /lsps2/pending` (`pending:<unix s>`), `/client/prefs` (`prefs:<hold_ms>`, the
  proof required — the dial was writable by anyone naming the pubkey), and the register/release/report/claim that were
  signed already. `/health?client=` and the GET poll still answer and stamp the Wallets pane's "last heard"; the buy and
  `register_secret` stamp nothing. The journal line for an unsigned ping says "contact only".
- **F4 — a stranger with a Push hash could claim at a provider under the real recipient's pubkey** (and read its
  claim-status). The claim, the delivery ask and the claim-status read carry the claimant's node-key proof over the
  hash, its own key, the secret's digest and the cross-provider fields (`claim:…`), the invoice it hands over
  (`deliver:…`), or the hash (`claim-status:…`, the fields in the query string).
- **F6 — a squat could cost the operator a JIT open and burn the hash for the real recipient.** The JIT open on a
  claim is KEPT (a new wallet needs it). The guard: a second PROVEN claimant replaces an unpaid (reserved) claim — the
  same invoice, the record now the second one's; a claim the holder has paid belongs to its claimant until it ends; a
  key whose claim delivery burned after a channel was opened for it is refused further claims that need an open for
  24 h (`claim_open_blocked`, `PUSH_CLAIM_OPEN_BLOCK_MS`); and after a burn the canceled claim invoice is DELETED from
  LND (`DeleteCanceledInvoice`, `DELETE /v1/invoices?invoice_hash=`) so the real recipient can claim the hash here
  again — LND never mints a hash twice otherwise. The key is probed at boot; without the URI the gap is logged and a
  burned claim's hash stays unclaimable here, as before. The URI is in both bake-permissions files and MACAROON.md.
- **F14, the second half — the payer's-note read** took a self-asserted pubkey as the owner: the proof is required
  (`note:<hash>:<client>`).
- **K1 — the free interval at a switch.** The wallet's release may name the provider it moves to (`transfer_to`); this
  provider then sends the registry the signed transfer (worker 0.15.0, `lijox-name:v1:transfer:<name>:<oldpk>:<ts>:<newpk>`)
  instead of a release, and the name is never free in between; the answer says `transferred`. A plain release frees
  the name as before.

## 2026-10-26 — Kimi K3.1 Pro's round 2, the numbers and F14 (0.115.0)

DP's rulings of 17:17 PDT, the ones with a number or a plain yes and no engine work in them:
- **F17 — TapeDrop had no disk bound.** A connected peer (any node through the tunnel) could post ~5 MiB an hour per
  address for good; nothing ever deleted a tape. DP: "256MiB total with the oldest past 30 days deleted first." Now
  `tapesSweep` runs before every write: at the cap the oldest tapes past the keep window go first, oldest first, until
  the new tape fits; a tape younger than the window is never deleted — a store full of young tapes refuses the drop
  (507 `TAPES_FULL`, a journal line). `TAPES_MAX_BYTES` and `TAPES_KEEP_DAYS` are box settings, on the Settings report.
- **F22 — the Lightning-address hash store had no ceiling per name.** Any proven key could grow its name's pool by
  ~20 KB a request, every request persisted. DP: "500 live entries per name." The register counts the LIVE free
  entries (reserved, accepted, settled and expired ones are not a pool), adds up to the cap and answers `capped: true`
  with the cap named; the wallet tops up at 20 live, so no wallet nears it. `LNURLP_MAX_LIVE_PER_NAME` is a box setting.
- **F14 — `/lsps2/pending` without `client` listed every wallet's held payments** (hash8, msat, deadline, client8) to
  any holder of the published route token — the reconnaissance for F10. DP: "Yes." It needs `client` now (400 without);
  the operator's whole view has been the console's JIT · now pane since 0.111.0.

## 2026-10-26 — Kimi K3.1 Pro's round 2, DP's rulings 1–3 (0.114.0): the in-flight park, the settle truth, the chit refund

DP's rulings on RULINGS.md §B at 17:00 PDT: "1. (F19) Agreed. 2. (F1) Agreed. 3. (F2+F3) Agreed. Fix this hole." While
closing F2/F3 the same two holes turned up on the LNURL-pay rail (its hold timer cancelled with no in-flight check; its
settle was never read) and on the claim side of Push (a hard timeout counted as a failed try; twelve of them cancelled
the holder's payment while LND could still deliver) — closed with the same shapes.
- **F1 — the JIT rail failed the payer back while LND still ran the inner payment.** sendToRouteV2Hard's 30-s bomb (or
  LND's "payment is in transition") answered FAIL_TEMP at once; when the inner then SUCCEEDED, LND paid the wallet from
  this node's balance and the payer had already been refunded — the operator paid the recipient. Now `jitInflight` parks
  every circuit of the hash (the request's, the promise's shards, the held record's entries) and returns HOLD; a 15-s
  probe reads ListPayments (the LNURLP belt's way): SUCCEEDED → every circuit SETTLED with the preimage plus the success
  bookkeeping (guard, PL, lease, the promise consumed); FAILED → every circuit FAILed and the guard told; neither by
  three blocks before the inbound's auto_fail_height (or six hours with no tip) → FAILed, with the one residue logged
  (`MANUAL ATTENTION hash=`: an inner that settles after that is paid from the node's balance). trampolineForwardHeld's
  fallback used to RESUME a second HTLC with the same hash after a hard timeout — it parks; a re-delivered HTLC of a
  parked hash joins the park; the held-queue watchdog re-arms (2 min) instead of failing a parked hash; the console
  snapshot lists `inflight_parked`. Without ListPayments in the macaroon the probe is blind and the block deadline rules.
- **F3 — a failed settle was recorded as settled.** `lndRequest` hands LND's error body back as data, so
  `await lndPost('/v2/invoices/settle')` never threw: "invoice already canceled" counted as settled, the record said
  taken/settled, the recipient had the sats and the sender's HTLC was later failed back by LND — a free payment. Now
  `settleInvoice` (push.js) / `lndSettleHoldOrThrow` (lij-adapter.js) read the answer; a refused settle leaves
  `settle_pending` with the preimage KEPT; the watcher retries the settle alone every 15 s (never the inner); a hold
  LND cancels under it becomes `paid_unsettled` with `MANUAL ATTENTION` in the reason and the journal (grep
  `PAID BUT UNSETTLED`). The sender's wake and the PL row follow the real settle. Sites: settleOuter, the claim's settle
  (settleIn), the LNURLP delivery and its late probe. bootResume resumes settle_pending records.
- **F2 — the window timers cancelled with no in-flight check.** The Push expiry timer, the claim-window timer and the
  LNURLP hold timer (both arms) now wait a minute at a time while `_delivering` / `deliver_inflight_at` / `_inflight_at`
  is set, and probe meanwhile. A direct delivery marks the record and, after a hard timeout or an "in flight" refusal,
  answers `{ error: 'in_flight' }` (the page shows "Not available: in_flight" until its next update says "On their
  way"); the claim side (`deliverIn`) keeps `deliver_inflight_at` and `probeIn` reads ListPayments instead of a second
  send or a counted failure. A delivery that outruns the RPC and then FAILS at LND is cleared by the probe, and the next
  window tick returns the sats.
- **F19 — the chit refund fee drain.** `/delegate/refund` paid any invoice ≤ the remainder, each with the 50-sat fee
  allowance uncounted: a 1,000-sat remainder split into a million 1-msat refunds cost the operator 50 sats a time. Now a
  part-refund invoice is refused (`PARTIAL_REFUND`, the remainder named): the invoice asks for the whole remainder or
  carries no amount; the routing fee paid counts against the chit (`refunded_msat` += amount + fee; `refund_fee_msat`).
  A failed payment still leaves the chit OWED and uncounted.

**DP's further rulings (17:17):** F10 go (engine: the heartbeat and the pending poll carry a signature; adapter 0.115.0);
F4/F6 go, as corrected (signed claim routes; the guard tightened — one failed claim-open blocks the hash 24 h; the JIT
open on a claim kept); K1 the transfer op, K2 accept with cacheTtl 30 (worker 0.15.0); the numbers — TapeDrop 256 MiB
total, the oldest past 30 days unlinked first; the LNURL hash store 500 live entries per name; /lsps1/channel removed;
the per-IP rate limit awaits his word after the walk-through; F14 yes (refuse the unfiltered `/lsps2/pending`); **W-3
logged, not changed:** raise the holder's cap and, when a kit does not fit, split it into two kits — to be done with
the Offline room / Black start revamp. Open: F9/B-19 (recommended: make it see the JIT hash — engine registers the JIT
invoice's secret by hash too; bind only on a matching secret; arm the window timer), F21 (a scenario was asked for;
given), F13/F24 (the next engine round).

## 2026-10-26 — Kimi K3.1 Pro's round 2 (0.113.1): the defects fixed without a ruling; the rest wait on DP

The second outside review (K3.1 Pro over the 0.112.0 bundle; its findings and the three checks against the tree sit in
the wallet repo at ops/review/kimi/round2/, the rulings list in RULINGS.md there). 22 of its 24 adapter findings are
real. **Fixed in 0.113.1, no policy in them:**
- **F5 — every ONLINE open-amount JIT receive since 0.111.0 neither opened nor failed.** The 0.111.0 ceiling fix removed
  the capped sizing but left ``${sizingMsat}`` in the quiescence-flush log line; in strict mode that threw before the
  open, the timer's catch only logged, `_var_flushing` stayed true (every later flush skipped) and the parts sat until
  LND's auto-fail. No test covered flushVariable. Now the line reads the sum, and a flush that throws FAILs every part,
  resets the aggregate and clears the flag — the payer's wallet retries clean.
- **F18 — one request killed the process.** `/lnurl/register` (and release) with the name `__proto__` or `constructor`
  (the regex admitted both) reached Object.prototype through the plain-object registry; `.client_pubkey.toLowerCase()`
  on it threw inside the public async handler, nothing caught it, no `unhandledRejection` handler existed, Node 22
  exited — with every held HTLC, promise and watcher in memory. Any self-made key passed the 0.112.0 proof for a new
  name. Now: those names are refused (400), the registry is a null-prototype object, the HTTP handler is wrapped (a
  throw is logged and answered 500), and an unhandled rejection is logged, never fatal (the line `[Fatal?] unhandled
  rejection kept from exiting the process` is the alarm — grep the journal for it).
- **F20** — the on-chain reserve fail-fast wrote FAIL_TEMP and returned null, which flushVariable read as "hold engaged":
  one part failed, the rest held, the promise wedged. It returns FAIL_TEMP. **F7/F8** — the post-aggregation failures in
  openChannelAndForward (no scid, no secret, the send rejected or not succeeded, the peer gone at open time, the reserve)
  left the sibling shards unresolved until auto-fail; `jitFailSiblings` fails them back and resets the aggregate at every
  one; the B-16 divert path gets the 0.111.0 overshoot gate. **F11** — two concurrent `/delegate/register` for one nonce
  both minted a funding invoice (the later write won; a paid first invoice was orphaned): the register runs under
  `withNonceLock`, a same-digest repeat answers the stored invoice. **F16** — `/health` was a live getinfo per hit:
  memoised 2 s. **F15/F23** — NWC: a register/unregister older than the connection's last accepted one is refused; REQ
  filters take full 64-hex keys only (an empty string in `authors` matched every event).

**Open, each needing DP's ruling before code (RULINGS.md §B):** F19 the chit refund fee drain (a 1-msat refund paid with
the 50-sat fee allowance, never counted); F1 the JIT rail's fail-back on a hard timeout while LND's inner payment still
runs (a late success is paid from the operator's balance — the LNURLP rail already probes; the JIT rail and
trampolineForwardHeld's RESUME fallback do not); F2/F3 the Push expiry and claim-window timers cancelling with no
in-flight check, and a failed outer settle recorded as settled; F4/F6 the unsigned Push claim (a hash squat; a JIT open
to a stranger); F10 self-declared pubkeys as proof of life (the replay gate reads them); F9 B-19's early bind sees only
plain-invoice hashes; F13/F24 signed writes that do not sign their effect (on-path only); F21 concurrent JIT opens to one
wallet; F14 the unfiltered `/lsps2/pending`; F17/F22 caps with a number in them. NOT a bug: F12 (the SQLite store is dead
code — the in-memory store runs, a known limitation).

## 2026-10-26 — DP's Push Key test (B claiming while A was offline) and the routing reports (0.113.0)

- **The sender's wallet had to be open for its own Push to settle — and nothing told it.** A holder settles the sender's
  HTLC with the preimage the recipient revealed, but LND can only settle (or fail back) an HTLC on the sender's channel
  while the sender's wallet is connected; a wallet that stays closed past the HTLC's timelock risks a force close (the
  holder's LND goes to chain to collect a settled HTLC; the sender's own LDK goes to chain to reclaim an expired one),
  and the old 40-block margin left a last-minute take with under seven hours. **DP's five points, built as 0.113.0:**
  (1) the SENDER is woken when its push is taken (`push_taken`) and when it is returned (`push_returned`), with the time
  by which to open — the lock's HTLC expiry less LND's 10-block broadcast delta, read from the sender's channel; the
  wallet page says so on the Push screen too; (2) the timelock margin is 144 blocks (`PUSH_CLTV_MARGIN_BLOCKS`; 72 h →
  576); (3) a hold fee inside the lock's fee, `PUSH_HOLD_FEE_PPM_PER_DAY` per million per day of the window, 0 until the
  operator sets it; (4) the lease skips a channel with HTLCs on it (`skip_htlcs` in the lease log) and looks again next
  cycle; (5) a claim or a delivery is REFUSED when no open channel of the sender's carries the lock's HTLC
  (`sender_channel_closed`; LND unreadable → 503, never a guess) — this node never pays a recipient against a lock it
  could only collect on-chain. `push.test.js` (102 checks) pins all five.
- **A failed send replayed the same five routes** (the LunaNode send of 2026-10-25, CoinGate refusing four times on four
  different channels; docs/design/pathfinding/pathfinding-r9.md in the wallet repo). This node's LND never learned of the
  refusals — a failure message travels back encrypted for the sender alone, and the wallet excluded one channel pair
  per try, never the node. **Fix (DP agreed 2026-10-25; only the adapter writes to LND):** `POST /v1/route/report` —
  after a send ends the wallet (engine v353) sends ONE signed report of every refusal; this node checks the signature
  (the 0.112.0 proof over `route-report` and `<hash>:<count>:<sha256 of the refusal lines>`), keeps only pairs that sat
  on routes it handed out for that hash within 15 minutes, only temporary codes, at most `ROUTE_REPORT_MAX_PAIRS_PER_HOUR`
  (20) a wallet, and writes them into its own LND's mission control (`XImportMissionControl`, no force — the macaroon
  recipe of 2026-10-25). A route ask's own `ignored_pairs` / `ignored_nodes` never write (the wallet's Routing reports
  switch Off really means off). `route/build` now takes `ignored_nodes` (the node-first rule), answers `no_route` as a
  plain 200 when LND finds no path (the engine then asks once more avoiding only the refusing channels), and journals
  every answer hop by hop. The console has a Routing reports card. `route-report.test.js` (22 checks).
