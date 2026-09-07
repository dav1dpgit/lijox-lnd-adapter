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
