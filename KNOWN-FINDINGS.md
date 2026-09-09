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
