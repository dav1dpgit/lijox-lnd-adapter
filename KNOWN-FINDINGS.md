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

## 2026-11-05 — wallet trusts LSP: the funding is published only once the wallet has claimed (0.124.0)

**The hole.** A JIT open published the channel's funding transaction BEFORE the wallet had claimed the payment
(`OpenChannelSync` builds, signs and publishes in one call). When the wallet refused — Oct 6: the wallet rejected its own
payment; the provider was out ~519 sats of chain fees and 35,400 sats of capital for a day — nothing came in. A hostile
wallet, or a million throw-away wallets, could repeat it for free. The JIT guard (0.104.0 / 0.111.0) limited the damage;
it did not remove the hole. The adapter had advertised `client_trusts_lsp: true` since v1 without doing it.

**The fix (jit-funding.js; the wallet repo's docs/design/jit-trust/wallet-trusts-lsp-v0.1.md).** For a wallet whose init
features carry bit 261 (LiJ engine v363+; read from LND's `ListPeers`), the channel is opened through LND's streaming
`OpenChannel` with a PSBT funding shim and `no_publish`: LND sets `NoFundingTxBit` and never stores or publishes the
transaction (v0.20.1-beta lnwallet/reservation.go 400–403, funding/manager.go 758–773 and 2811 — not at funding_signed,
not at a restart). The adapter funds it with `FundPsbt` (the coins leased under its own lock id for 48 h), signs it with
`FinalizePsbt` (publishes nothing), writes the record — the signed bytes included — to `DATA_DIR/jit-held-funding.json`
BEFORE LND learns the txid, then `FundingStateStep(psbt_verify, skip_finalize)`; LND goes on to funding_created; the
zero-conf channel is open with its funding unpublished; the payment is forwarded exactly as before. Claimed → the record
says `paid` before the payer is settled, then `PublishTransaction`. Refused → `AbandonChannel` (i_know_what_i_am_doing —
the PSBT shim sets no thaw height), `ReleaseOutput` for every coin, and the peer message `JitFundingAbandoned` (32823) so
the wallet drops a channel it owns nothing in (LND itself tells a peer nothing about an abandoned channel —
peer/brontide.go 2178–2194). ONE open function serves both rails (the interceptor's and the delivery rail's). Wallets
without the bit get the publish-first open, unchanged.

**The sweep** (boot + every minute) finishes what a crash interrupted: a `funded` record LND never listed → coins
released; a `held` channel with the wallet's balance > 0 → published (the promise is kept); `held`, empty and idle ten
minutes → abandoned; a channel gone from LND that this adapter did not abandon → `orphan`, RED on the Console (if the
wallet had claimed, the provider owes it); `paid` → published; `published` → sent again every ten minutes until one
confirmation; stray leases released. `GET /v1/jit-funding/status` answers a wallet's question about its own record — the
engine's audit drops a channel it owns nothing in only when this provider says `abandoned`.

**The guard.** A held-funding failure counts in its own column (`abandoned_24h`) and toward the wallet's own block, never
toward the arm or the halt: nothing was published, no chain fee bled, and counting it would hand three throw-away wallets
a free switch that turns JIT off for everyone (DP, question 3 of the design).

**The key.** Six more RPCs — OpenChannel, FundingStateStep, FundPsbt, FinalizePsbt, ReleaseOutput, ListLeases (MACAROON.md).
The boot probe ("[JIT-HOLD] key probe") says whether the key has them; without them every open publishes first, as
before, and `/health` and `get_info` say `jit_funding_hold.key_ok: false`.

**Not changed.** The forward itself, the fee law, the promise clock, the offline hold, the Terminus channel type (the same
parser arm serves both open calls — fork rpcserver.go 2327–2341), the funding fee (1 sat/vB, as the old open).

## 2026-11-10 — Register amount sharing: the agreed rate on a shop's static QR (0.125.0)

**What it is for.** A shop runs the wallet's Register mode beside its own register. The customer types the register's
total in the shop's currency; the figure on the shop's screen must be the figure the customer typed. Until now two
wallets converted at two rates at two times, and the Register valued the payment at a third.

**What this adapter now does** (`register-quote.js`; the design is the wallet repo's docs/register-mode-plan-v2.md and
-v2.1.md):
- **The Register answer.** A first call with the flag `?register` (the shop's Register QR; a `name@host` lookup never adds
  it) answers with the shop's business name as the payee line, the shop's currency and rate in LNURL PR #251's shape
  (`currencies`: code, name, symbol, decimals, `multiplier` = msats per smallest unit, three decimals) with
  `quote.expires`, and a callback address that carries a **rate stamp** in its path: `/lnurl/cb/<name>/r/<stamp>`.
- **The plain answer hides the business name again.** A lookup without the flag gets "Pay <name> — Lightning in a Jar",
  as before 0.119.1. The business name reaches a payor only through the Register QR.
- **The stamp** is this provider's own text — name, currency, multiplier, decimals, expiry, a random id — under an
  HMAC-SHA256 with a key kept in `DATA_DIR/register-stamp.key` (made at first use, mode 0600). Ten minutes unused; one
  use. It says nothing about the payor.
- **The stamped callback** makes the invoice for exactly the msats sent, with a 10-minute life (a plain one keeps 20),
  and writes on the entry "this invoice, these msats, at this rate" plus the figure in the shop's currency by the one
  rounding rule (round half up, both ways). It also accepts PR #251's `amount=<smallest units>.<CODE>`.
- **Never a refusal over the stamp.** Unreadable, changed, made for another name, past its ten minutes, already used with
  another amount or on an invoice already paid → the request is a plain one (no rate recorded), and the journal says why.
  The same stamp with the same msats while its invoice is still unpaid returns the same invoice (a wallet asking again
  after a lost answer).
- **The shop's currency** is filed by the shop's wallet with its name (`POST /lnurl/display`, the new `currency` field;
  the proof then covers `<the display record>:<CODE>`). No currency filed, or no rate held for it → the Register answer
  carries the name alone and the placeholder stamp `-`.
- **The Register's reads**, token-gated and owner-only under the node key's proof: `GET /lnurl/register/open` (the
  invoices asked for at an agreed rate and not yet settled, in the order asked) and the `register` record on
  `GET /lnurl/note/<hash>`.

**What a payor's wallet needs.** Nothing: the stamp rides the callback address every wallet calls back unchanged. A
wallet that reads `currencies` can show the shop's currency and convert with the multiplier.

**0.125.1.** `GET /lnurl/note/<hash>` (owner-only, as before) also answers `invoice_msat`, `delivered_msat` and
`fee_kept_msat` for any payment to the name — the Register shows a provider fee on its own line for a plain payment too.

**0.126.0.** The channel state file's holder (`peer-storage.js`; `POST /v1/peer-storage/put | meta | get`). A wallet
keeps one encrypted file here, 65,531 bytes at most — the size and the rule of BOLT #1110 peer storage (bytes the holder
cannot read, the latest only, given back to its owner), carried over HTTPS because LND has no peer storage messages in
any release. Known limits: (1) the holder is the wallet's channel partner — the one party that gains from handing back
an old file; the wallet does not trust it for freshness and checks a restored state against its Black start kit, held
by parties that do not gain. (2) Any node key that proves itself is held for, up to 20,000 wallets; a key costs nothing
to make, so the cap can be filled by someone who wants to — a full holder refuses new wallets and keeps serving the
ones it holds. (3) A lower number is refused, but the number is the wallet's own clock: a wallet whose clock was far
ahead once cannot store again until real time passes that number or the operator removes its two files in
`DATA_DIR/peer-storage/`. (4) Each request costs one LND `verifymessage`; the limits are 600 an hour per address and
300 an hour per key (`PEER_STORAGE_IP_PER_HOUR`, `PEER_STORAGE_KEY_PER_HOUR`).

**0.127.0.** A delivery in parts (`deliver-parts.js`; `deliverInParts` in `lij-adapter.js`). Found in the field
2026-11-11: a wallet with two channels and over 500,000 sats of room in total could not be paid 420,000 sats to its
Lightning address by another wallet on the same provider. `deliverToWallet` sent one HTLC over the one channel with the
most room, and an amount above that room went to a new channel open whatever the other channels held. Now the channels
are read together: when they have the room, each takes a part (the most room first), all parts under the one hash, and
nothing is opened; `walletReceivable` answers the same way, so no opening fee is quoted for an amount the parts carry.
Known limits: (1) proven only against stand-ins in `deliver-parts.test.js` — LND's handling of several `SendToRoute`
calls for one hash is read from its source, and the first field run is the proof; (2) every channel taking a part must
be active, otherwise the delivery waits for the next sweep; (3) if one part fails, the others wait in the wallet until
its own timeout for an incomplete payment, and the delivery is tried again after that; (4) a wallet paying an INVOICE
of another wallet on this provider still asks for one route for the whole amount — that send is not split to fit the
receiving wallet's channels (the wallet's engine decides the split from its own channels only).

**0.127.1.** Two things from the UM890's journal of 2026-11-11 05:56 (a 410,000-sat address payment to a wallet whose
two channels had 269,029 sats of room at most). (1) THE CHANNEL AN OPEN DELIVERS OVER. `deliverToWallet` opened a new
channel and then waited for "a channel" only while it had none in hand — a wallet that already had a channel kept the
old one, so the payment went into the channel without the room (LND: `TEMPORARY_CHANNEL_FAILURE` on our own link),
the new channel was abandoned unused, the guard filed the failure under the OLD channel's funding point, and after two
tries the wallet was blocked from JIT opens for 24 hours; the next payment was then refused at once. The delivery now
goes over the channel that call opened, found by its funding point. Every delivery-rail open for a wallet that already
had a channel was exposed to this; a wallet with no channel was not. A wallet blocked this way is released from the
Console. (2) `parts_sats` in the route answer: a request for a wallet on this provider that no one channel can carry
but its active channels together can is still answered `no_route`, now with the part sizes that fit; a wallet engine
that knows the field can send the payment in those parts (no engine reads it yet).

**0.127.2.** No change to what the adapter does: one comment line in `deliver-parts.js` reworded before the public
release. A box on 0.127.1 runs the same code.

**0.127.3.** The Console's JIT guard line (`console.js` `jitGuardLine`). Found in the field 2026-11-12: with one wallet
blocked from JIT opens after two held-funding opens failed, the Guardrails pane read "none in the last 24 h" and, under
it, "1 wallet blocked from JIT opens". The first line counts only opens whose funding was PUBLISHED and then failed
(the figure that arms and halts the guard); held-funding failures and a wallet's own block are counted apart. The line
now says what it counts — "no JIT open with published funding failed in the last 24 h" — names the held-funding
failures and the blocked wallets beside it, and is not shown as all clear while either exists. With nothing failed and
nobody blocked it reads "no failed JIT open in the last 24 h". No change to the guard itself.

**Order of the rides.** This adapter can ride before the wallet page that uses it: older pages never send the flag and
never file a currency. One visible change at the ride: a plain address lookup stops showing the business name.

**Not changed.** The hash pool, the hold, the hand-on to the payee, the fees, the range check (it still applies to
every request), the 20-minute life of a plain invoice.

## 2026-11-10 — the funding fee in LND's own unit, and three smaller things (0.124.2)

**How it was found.** Every journal of a held open since 0.124.1 read `funding fee 2 sat/vB (LND's 144-block estimate 1.0
sat/vB)`. LND's estimate on a quiet day is its own floor, 253 sat/kw — 1.012 sat/vB. 0.124.1 turned the estimate into
sat/vB and rounded UP to a whole number, so 1.012 became 2: every JIT funding paid about twice the rate it was meant to.

**Now.** The rate is kept in sat/kw from LND's answer to LND's call, with no rounding (1 sat/vB = 250 sat/kw):
- **the held open** hands it to `FundPsbt` as `sat_per_kw` (field 11 of FundPsbtRequest at v0.20.1-beta) — exact;
- **the publish-first open** (`OpenChannelSync`) takes whole sat/vB only (`sat_per_vbyte`, field 1 of
  OpenChannelRequest), so it takes the NEAREST whole sat/vB to the same number (1.012 → 1; 1.6 → 2);
- the floor and cap dials stay in sat/vB (`LSPS2_FUNDING_FEE_MIN_SAT_PER_VB`, `_MAX_SAT_PER_VB`); the rate is never
  below LND's own relay floor of 253 sat/kw, which LND would refuse.
The journal line names the unit: `funding fee 253 sat/kw = 1.01 sat/vB, given to LND in sat/kw (…)`.

**A journal line when "paid" is written.** `[JIT-HOLD] PAID written for <funding> (was held) — on disk before the payer is
settled; the publish follows`. The code always wrote `paid` before the settle and published after; nothing in the journal
showed that order.

**Refused opens are off the fee ladder.** A JIT open was counted on the wallet's open fee ladder at the open. A held open
that ended with its funding never published (abandoned on the wallet's refusal, or cancelled) is not an open the wallet
got; its stamp now comes off that wallet's ladder — exactly the stamp that open wrote (`ladder_ts` on the held record),
once (`ladder_off`). A record revived to a real channel goes back on. The publish-first open is unchanged: its funding
is public the moment it opens.

**Not changed.** The dials' names and defaults; the 144-block target; the sweep; the key (no new URI — `FundPsbt` was
already in it).

## 2026-11-05 — the review's fixes (0.124.1): the timeout trap, the fail-closed abandon, the polled fee

**How it was found.** Before 0.124.0 rode, an independent review (fresh eyes; it read the adapter, the engine and LND
v0.20.1-beta's source) was asked eight questions about the held open's money paths. Three findings could lose money; a
dozen were smaller. DP: "Go ahead." The design round is the wallet repo's docs/design/jit-trust/wallet-trusts-lsp-v0.3.md.

**1. The timeout trap (money).** Once `FundingStateStep(psbt_verify)` has been sent, LND finishes the channel ON ITS OWN:
the one-shot signal in `PsbtIntent.Verify` fires (lnwallet/chanfunding/psbt_assembler.go 293–303), `Cancel` shares that
one-shot and so changes nothing afterwards (439–446), the funding manager's zombie sweeper never expires PSBT reservations
(funding/manager.go 5233–5252), and the `OpenChannel` RPC loop does not watch the stream's context. 0.124.0's open, on its
25-s deadline or a dropped connection, sent `shim_cancel`, released the coins and closed the record as `cancelled` — while
LND could still open the channel when the wallet answered late. A payment could then land over a channel whose record was
closed; the payer would be settled; nothing would publish; the released coins could be spent elsewhere, making the held
transaction unpublishable for good. FIX: after the verify is sent (`verify_sent_at`, stamped before the call) nothing is
released on a failure; the record stays `funded`; the sweep frees the coins only on LND's own proof that the reservation
is dead — the wallet peer absent from `ListPeers`, or its `last_flap_ns` after the verify (LND cancels a peer's
reservations when it disconnects: server.go 4616 → `CancelPeerReservations`). A channel in LND's pending list counts as
present. A channel LND lists against a `cancelled`/`abandoned` record is RED and revived to `held`. The stream is
cancelled once `chan_pending` has been read (LND's RPC loop would otherwise sit until `chan_open`).

**2. The abandon's race (money, narrow).** `abandon()` read the channel once (balance, HTLCs) and then told LND to abandon;
a payment landing between the two calls would be the wallet's sats in a channel LND then wipes (`AbandonChannel` checks
nothing — rpcserver.go 3283–3301). FIX: the record goes to `abandoning` FIRST and the payment paths refuse it from that
moment (`lnurlpClientChannel` skips it; the interceptor FAILs a real-channel forward whose scid maps to it); a 2-s grace
lets a send that picked the channel a moment ago reach LND; then LND is read; only a channel just read EMPTY is abandoned.

**3. Fail-open on an LND read error.** The abandon went ahead "by the verdict" when LND could not be read. FIX: it stops,
the record goes back to `held`, the sweep retries. Only an empty channel just read is ever abandoned.

**The smaller ones, all fixed.** The sweep honoured a flow's claim on a record (`live`) before publishing — a claim could
wait up to ten minutes; publishes now come first. The late settle (the in-flight park) wrote the SETTLE before `paid`;
the order is now `paid` first on all three rails. The delivery rail published the held funding when the payment went over
ANOTHER listed channel; now only when the paid channel IS the held one. An orphan's lease was released as a stray though
an orphan can come back; it is kept. A `funded` record whose channel sat in LND's pending list read as "never listed";
the pending list is read. A crash between `FundPsbt` and the record left a lease nobody knew for 48 h; a pre-fund record
(`funding`) is written BEFORE `FundPsbt` and released by the sweep after ten minutes. A crash inside `abandon()` made a
false orphan; the `abandoning` state is finished by the sweep. A claim on a closed record was swallowed; `markPaid` now
moves any unpublished record with the bytes and says MANUAL ATTENTION. The signed transactions lived in one file; each
record also has a copy in `DATA_DIR/jit-held-funding.d/`, and a corrupt state file rebuilds from them, loudly. Abandoned
records were pruned after 14 days so a wallet away longer learned nothing; a tombstone answers "abandoned" for good.

**The fee (DP 00:01, "Go with polling the correct current fee rate, floored at 1 sat/vB", "the dials as variables").**
Both opens — the held one in `FundPsbt`, the publish-first one in `OpenChannelSync` (`sat_per_vbyte`, field 1) — now
carry LND's estimate (`/v2/wallet/estimatefee/{target}`, sat/kw × 4 / 1000, rounded up) for `LSPS2_FUNDING_FEE_TARGET_CONF`
blocks (144), never below `LSPS2_FUNDING_FEE_MIN_SAT_PER_VB` (1), never above `LSPS2_FUNDING_FEE_MAX_SAT_PER_VB` when set
(0 = no cap); no estimate → the floor. Until 0.124.0 every JIT open carried a hard-coded 1 sat/vB — the Oct 6 fee was the
same number. The rate used is in the record and on the Console.

**Noted, not changed.** `/v1/jit-funding/status` is gated by the shared route token like every wallet route: a wallet of
this provider holding the token can read another wallet's held-funding state word if it already knows that wallet's node
key and the outpoint (information only; it cannot cause a drop). The engine's `funding_known_to_books` input is always
false for an inbound channel (the wallet's books hold its own transactions) — the on-chain check that matters is
`confirmations`; the engine note says so.


## 2026-11-04 — the state kit's receipts on the Backups pane (0.123.0; the box recovery v0.1)

**What had one copy.** The float wallet of Lightning pays on-chain (the float itself and the key of every open lock), this
adapter's env (the VAPID pair — every Wake push subscription dies with it; the take-back seed; the console secret), its
state files (the push subscriptions, the wallets' Black start kit copies, the Lightning-address names, the Push Keys,
the lease state, the on-chain pay records, the Mix), bitcoin.conf's rpcauth lines, the tunnel's credentials, the units —
each on the box only. The SCB kit covered the channels; nothing covered these (the S41 runbook docketed the adapter's
state as "v2 — its own encryption ruling").

**The state kit** (the wallet repo's `ops/um890-scb/lij-state-kit.sh`, a daily timer at 00:20 after the SCB cloud leg):
one `age`-encrypted archive of exactly those pieces plus a manifest, shipped by the SCB kit's two legs — the LAN box
(seven days kept) and the worker's new `/lsp-state` door (lij-worker 0.19.0; the SCB door's twin, its own keys, the
newest and one before, 20 MB the line) — signed by the node key as the SCB is. The age key's private half is printed and
kept with the seed words; neither leg can read a byte. Not in it: the LND seed, channel.db, wallet.db, the chain, the tapes.

**This release** adds nothing to the adapter's doors: `state-kit-status.js` READS the kit's receipts from the SCB state
folder (`LIJ_SCB_STATE_DIR`, default /var/lib/lij-scb — the manifest and `status-state-{local,cloud}.json`) and the
Console's Backups pane shows them: what is in the archive (the file count, the size, when it was built, the adapter's
sha and Core's and LND's versions it names, anything that was missing), then each leg as the SCB's — ok or failed, the
last run and the last shipment apart, stale past 26 h, the leg's words. A box without the kit sees one dim row naming
the runbook. The manifest carries file names, sizes and hashes, never a secret; the pane never shows the recipient or the
node key.

## 2026-11-04 — fractional fee rates, the provider's half (0.122.0; Lightning pays on-chain Phase 2, design v0.7)

**A floor of 4 sat/vB nobody ruled.** The chain bridge turned LND's fee estimate (sat/kw) into the bundle's whole sat/vB
with `Math.max(4, Math.ceil(kw / 250))` — every wallet on this provider believed "fast" was never under 4 sat/vB, and
every on-chain action of every wallet (sweeps, opens, closes, releases) paid at least that, however quiet the mempool.
Gone: the bundle's whole numbers are now `ceil(kw / 250)` with LND's own floor (253 sat/kw ≈ 1.01 sat/vB) and nothing
else. The bundle's fields stay whole and the protocol version stays 2 — an older wallet refuses a changed version byte.

**The exact rates, a new message.** `FeeRatesKw` (type 32821, odd — an older wallet ignores it): fast / medium / slow
in sat/kw and the relay floor of the node they come from (253: LND's), sent right after every ChainDataBundle. A v362
engine reads it and feeds its estimator the exact numbers; the picker shows one decimal.

**The rail goes decimal.** `liveLockRate` reads Core's `estimatesmartfee 1 conservative` as a decimal (Core already
floors at its relay fee: 1 sat/vB on Core 29, 0.1 on 30 and later; a guard floor of 0.1 here); the lock's fee is
`ceil(vbytes × rate)`, rounded up once; `sendtoaddress fee_rate` takes the decimal as Core does. The quote carries
`lock_rate_sat_vb` as the decimal (no engine reads it as an integer — the page only prints it), and two whole numbers for
the engine in sat per kilo-vbyte: `lock_rate_sat_kvb`, and `release_rate_sat_kvb` — Core's six-block estimate, the
suggestion for the wallet's release (the rule: never a release below the rate expected to confirm within 6 blocks; the
wallet takes the higher of its own reading and this). The lock's bump still adds 2 sat/vB. `/release` already took a
faster copy for the same hash (state `released` allowed; Core's `testmempoolaccept` + `sendrawtransaction` do the
replacement) — the wallet's speed-up (Phase 3) uses it as is.

## 2026-11-04 — the lease's one warning; the Backups pane says what, where and when (0.121.0)

**The lease's one warning (DP's item 1).** The lease closes a channel whose wallet has not been heard from in LEASE_DAYS
(any contact resets it). From 0.121.0 the hourly cycle sends ONE push to the wallet LEASE_WARN_DAYS (2) before that —
"Your channel closes in 2 days — open LiJ once to renew the channel lease for another 60 days. This will be your only
alert." (the wallet's service worker says it; the days are the lease's own term). Only a wallet with a Wake push
subscription can be reached (a live wallet needs none — its contact is the renewal); once per channel lifetime — the
stamp (`warned_ms`) lives on the lease record, which is born with the channel and pruned with it; never in dry run (a
close that will not happen is no alarm); never for an excluded channel. The push rides the ordinary wake rail
(`t: 'lease'`, `days_left`, `ttl_days`), kept at the push service for two days. The lease log records `warned`.

**The Backups pane (DP's item 2 — "what is being backed up should be listed").** The kit's two legs ship LND's
`channel.backup`, the STATIC channel backup: every channel's point and peer, enough to get the funds back by a force
close from each peer after a disaster — not balances, not keys. Balances are not a file that can be backed up safely
(an old `channel.db` restored and used broadcasts an old commitment and the peer's penalty takes the channel); LND's
recovery is seed + SCB → the peers publish their latest commitments → every channel closes at its true balance. The
local leg runs on every change of the file (and whatever else LND writes in that folder) and once a day; the cloud leg
once a day, shipping only when the file's hash changed; each run stamps ok — so the old pane's "ok 6 min ago" was a RUN,
not a shipment. The pane now says WHAT (the file, its size, the channel count, when it last changed, its hash — read from
LIJ_SCB_FILE, default LND's mainnet channel.backup) and per leg WHERE it goes and the last RUN and the last SHIPMENT told
apart (the leg's last-sha file is written only when a shipment happened). OPEN, DP's ruling 11-04: the kit does not cover
the float wallet's descriptors, the adapter's secrets and state (the take-back seed, the VAPID keys, the lease state,
the push subscriptions, the kit-holder store, the registry identity) or the box's configs — a design note "the box
recovery" comes before Phase 2/3.

## 2026-11-02 — Lightning pays on-chain, the provider's half (0.120.0)

**What it is (DP's name; the design docs/design/onchain-pay/lightning-paying-onchain-v0.6.md in the wallet repo).** A LiJ wallet pays an on-chain address from its Lightning balance: it pays this box two hold payments — A (the provider's flat fee ONCHAIN_PAY_FEE_SATS + the lock's miner fee, kept once the lock is sent) and B (the recipient's amount + the release's fee + a speed-up reserve, under the wallet's own payment hash H) — and this box's FLOAT WALLET (`core-rpc.js`: a Bitcoin Core wallet behind a whitelisted RPC user, twelve commands, never a right on LND) sends THE LOCK to a HAND-OVER ADDRESS made for this payment (`btc-tx.js`: OP_SIZE 32 EQUAL IF SHA256 H EQUALVERIFY W ELSE DROP T CLTV DROP L ENDIF CHECKSIG). The wallet releases to the recipient after one confirmation, publishing the secret; this box collects B only when the release is IN A BLOCK (LND's spend notifier; DP 20:43 — at the mempool a provider could hold both B and its coins if the release never confirmed). A wallet that never releases: at T the take-back returns the coins to the float and B is cancelled.

**The take-back is the one transaction the adapter signs** (Bitcoin Core's signer knows only the standard script shapes), under eight controls (v0.6 §9.1): every record carries an HMAC under a key from ONCHAIN_PAY_TAKEBACK_SEED and an edited record is never acted on (and never re-signed); the lock's output is re-read from Bitcoin Core and must match the script rebuilt from H, W, L, T and the amount; the destination must be an address the float reports as its own (getaddressinfo ismine); never before block T; testmempoolaccept before sendrawtransaction; the take-backs due are on the Float pane and every one is journaled; the code's fingerprint is the release row's sha256; RFC 6979 signatures, pinned by vectors (`btc-tx.test.js` against BIP-143's published signature, byte for byte). Nothing is mixed up between wallets or payments (DP 21:28): every route is signed by the wallet's node key (the `onchain-pay` proof action), a record answers only the wallet whose key is on it (another wallet's ask is "not found"), the hand-over address differs per payment, a lock pays one hand-over output, a take-back spends one lock.

**0.120.4 / 0.120.5 — DP's settings after the first payment (13:0x).** The floor is 10,000 sats (was 20,000); the provider's fee is 1,000 sats + 0.2% of the amount (ONCHAIN_PAY_FEE_PPM defaults to 2000; was 0) — both parts kept once the lock is sent; the Balances pane shows the float wallet's balance in its own box and inside Treasury; the Float pane hands out a fresh top-up address of the float wallet on a tap (getnewaddress, kept in onchain-pay/float.json until the next tap; Core cannot show the next unused address without handing it out).

**0.120.3 — and a height hint (read in LND's source, 12:4x).** LND's txnotifier also refuses a registration whose height hint is 0 ("a height hint greater than 0 must be provided") — 0.120.2's watches were refused with that message in turn, and the Console kept the first field payment open; the hint is the bound of LND's backward scan when a watch is registered after the fact, and the lock's block is now that hint for both watches. The Mix's spend watch (below) lacks the hint as well as the script.

**0.120.2 — the watches carry the output script (found in the journal of DP's first ride, 11-03 12:17).** LND's chain notifier refuses a confirmation or spend registration without the output's script ("an output script must be provided"); 0.120.0 sent none, so the lock's confirmation and the hand-over's spend were never seen — the wallet would have been paid on-chain and B never collected. Every watch now carries the hand-over output's P2WSH script. OPEN FINDING, the same shape elsewhere: tatara-channels.js's spend watch on a pool's inputs (`watchSpend({ txid, vout })`, lij-adapter.js 2703) registers with an empty script too — the Mix's "funding in a block / input went elsewhere" line never fires on LND 0.20; the inputs' scripts are needed there; its own fix and test next.

**The float's own balance is the limiter (DP 23:39).** Every quote reads the float wallet's balance from Bitcoin Core at that moment (not the ten-minute probe) and subtracts the locks of the quotes and openings already standing; a lock the remainder cannot cover is refused ("this provider's float cannot cover this payment right now"), whatever the daily ceiling still allows. The Float pane shows the balance, what standing quotes reserve and what is free.

**Off strands nobody.** ONCHAIN_PAY_ENABLED=false refuses new quotes; the watches, the collection on confirmation, the take-backs, the wake push, status and the Float pane keep running. The fence is probed at boot (a command outside the list must come back 403); an open fence refuses quotes. `onchain-pay.test.js` (70 checks) runs the happy path, the walk-away, every refusal, the controls, Off, the fence, the restart and the keeping-apart against stand-ins; `core-rpc.test.js` (17) the door; `btc-tx.test.js` (85) the bytes. The ride (the float wallet on the UM890) and the wallet's half (engine v361, page v1082) follow.

## 2026-11-02 — a pay site that refused browser wallets ended the payment; the console's Pending column lied (0.119.3)

**The fetch for the phone (DP's UX list item 2, the Bitcoin Jungle case of 10-29).** The wallet page fetches a payee's pay terms and its invoice straight from the payee's server; a server with no CORS header refuses a browser wallet, and both fetches failed with one message. Now the page tries direct first and, on a refusal, asks its provider (`POST /v1/lnurl/fetch`, `lnurl-fetch.js`) to fetch the same URL for it — only with its Privacy switch "Ask the provider" On (default On, Off means off); the LUD-06 description-hash check stays on the phone. The route is behind the route token and a per-address limit; it fetches https on 443 only, to a public address only (judged by what the name resolves to, the socket pinned to that address with the name in SNI and the Host header, so a name cannot be aimed at the box or the LAN after the check), follows no redirect, reads at most 64 KiB in 10 s, answers the body verbatim and says when it is not JSON. The journal keeps a count; the URL — the payee — is never logged: it is the wallet's business.

**The Pending pane (item 5).** Its column was headed "txid" and showed the channel's funding point cut to 16 characters; no closing txid was sent. Now three columns: the channel point, the closing txid (closing, force-closing and waiting-close rows carry one), the limbo balance. **Every shortened identifier in the console (item 1)** — pubkeys, channel points, scids, hashes, txids, outpoints — is a tap-to-copy of its full value; the JIT pane's scids, keys and hashes had been cut by the adapter before they were sent and are sent whole now. **The Balances pane (item 6)** gains a Pending box: unconfirmed on-chain + in flight + opening + closing (LND's limbo total), with the four parts under it.

## 2026-11-02 — a JIT promise died at the 10-minute quote clock while its invoice lived an hour (0.119.2)

**The promise clock (the S66 write-up "JIT promise removal clock — write-up v1"; seen in the code, not on a box).** Every JIT promise carried two clocks: the QUOTE (`promise_expires_at`, LSPS2_PROMISE_VALIDITY_SECS, 10 min, which the code's own comment calls "soft, advisory") and the RESERVATION (`reservation_expires_at`, LSPS2_RESERVATION_HOURS, 24 h, "hard" — the HTLC interceptor, the held-payment path, the same-LSP route builder and the console's "expires" column all read it). The reaper `reapExpiredJitBuys()` deleted every promise on the QUOTE clock, and ran only at the start of the next `/lsps2/buy` — from any wallet. So wallet A's invoice (the page gives it 60 minutes; the wallet registers its secret before it shows the invoice) lost its promise the moment wallet B asked more than 10 minutes later: a direct payment to A then failed (`F4: no promise + unknown SCID`); a same-LSP LiJ payer was told the invoice was stale (`REFUSING substitution`); a payment held for A while asleep failed on the wake (`promise gone for held HTLC`); a chit held for a sleeping shop read "the shop's payment code has lapsed". With few wallets the trigger was rare — the UM890's journal for the last 24 h on 11-02 had none of those lines — and it grew with every wallet added. Fixed in 0.119.2: ONE CLOCK DELETES — a promise whose secret is registered lives to the reservation; an ask with no secret (never shown, so never payable) still goes at the quote; the reaper also runs on the 10-minute sweep. Because a registered promise now lives a day, two box settings bound the memory: `LSPS2_MAX_LIVE_PROMISES_PER_WALLET` (10 — over it the wallet's oldest IDLE promise — no shards, no open in flight, no held payment naming it — is dropped for the new ask, so a shop re-making an invoice after a typo is never refused; every one busy = the ask is refused) and `LSPS2_MAX_LIVE_PROMISES` (2,000 — over it the ask is refused, 429, plain words). The console's JIT · now pane shows how long ago each promise was asked (dim past 60 minutes — a LiJ invoice's life) and names the 24-hour column for what it is. Still memory-only: an adapter restart drops every promise and every held payment (the write-up's item E, later). Not done (item D, the spec): the wallet does not tell the adapter its invoice's real end.

## 2026-10-28 — the console sorted its time columns by their words (0.119.1); the Register name reaches the payer (0.119.1)

**The console's sort (DP's finding, S65).** Clicking "lease" on the Channels pane, or "last heard" / "first seen" on the Wallets pane, ordered the rows wrongly. The sort key was parsed from the cell's TEXT: "58 d left" with the "contact · 3.2 h ago" line under it became the number 583.2; "3.2 h ago" sorted as 3.2 against "12 min ago" as 12; a month-first date became its digits. Fixed in 0.119.1: those cells carry `data-sort` — the lease as the milliseconds left (past ttl negative; no stamp, then excluded, last), the three stamps as milliseconds — and the sort reads it first; the words are only shown. console-sort.test.js lifts the two functions from the client script and pins the old defect beside the fix.

**The Register name (DP, S65 — "This bump is fine for Register"; engine v359).** A Register mode's shop name lived only on the merchant's phone; every sending wallet showed the provider's own line ("Pay <name> — Lightning in a Jar") as the payee. Now the name's owner files the display name under the node key's proof (`POST /lnurl/display`, record `display:<name>:<sha256 of the text>`; the text in its clean form — NFC, no control characters, trimmed, at most 40 code points — or refused), the entry keeps it (dropped with the name at release), and the pay terms' text/plain carries it. Note the LUD-06 seal: an invoice's description hash is over the terms served at that moment; a rename between a payer's terms fetch and the callback makes that one invoice refused by the payer's wallet (seconds, once).

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


## 2026-10-27 — Kimi K3.1 Pro's round 2, F13 / F24 / K6a: signed writes sign their effect (0.119.0, with engine v358, page v1074 and lij-worker 0.18.0)

DP 12:21 ("Agreed on all of 0 … and then 3. Go"). Three findings of the second round, each needing the engine, the
adapter and the worker in lockstep; each reachable only by a party on the path (the tunnel or relay operator, or a
broken TLS) who keeps a wallet's real signature and swaps what rides beside it:
- **F13 — three signed writes did not sign the data that decides their effect.** The channel record's proof bound the
  `channel_id` alone (`registry.js`: the funding outpoint, the value, the keys id and a close could all be swapped);
  the push subscription's proof bound nothing of the subscription (`handlePushSubscribe`: the endpoint and keys could
  be replaced — wake pushes to a stranger's endpoint); the Lightning-address registration's record covered each
  entry's hash alone (`lnurlpRegisterRecordId`: the secret, the life and the index were uncovered). FIXED: the records
  now bind every field — `post-channel` "<channel_id>:<sha256 over the canonical record's other fields>"
  (`channelRecordId`), `push-subscribe` "sub:<sha256 over endpoint, p256dh, auth>" (`pushSubscriptionRecordId`),
  `lnurl-register` lines of `hash:secret:expires:index` — the twins of lij-core registry_client's
  `channel_record_id`, `push_subscription_record_id` and `lnurlp_register_record_id` (engine v358), pinned by vectors
  on both sides (registry.test.js, lnurlp-auth.test.js, push-subscribe-proof.test.js). The OLD forms are accepted
  for THIS ONE RELEASE and logged ("signed in the OLD form … an engine before v358") — this release rides before the
  engine; 0.120.0 refuses them.
- **F24 — TapeDrop accepted a tape under any CONNECTED pubkey.** `/tapedrop`'s only check was that the claimed
  `client_pubkey` was a connected peer, so any connected peer could file evidence under another wallet's key. FIXED:
  a page from v1074 sends the tape as text (`tape_json`) with the node key's proof over
  `tapedrop:<tape_id>:<sha256 of the text>` (`tapedropRecordId`, lnurlpAuthCheck — the 0.112.0 digest; "tapedrop"
  joins the engine's fixed proof list) and the file holds that text; an older page's unsigned drop is still taken this
  one release through the old peer check, its file named `claimed-…` and the journal saying the attribution was never
  proven; 0.120.0 refuses unsigned drops. tapedrop-proof.test.js (10).
- **K6a — the cloud-copy push's proof bound no copy** (the worker's finding 6a: the digest was action‖nonce‖pubkey, so a
  captured authorisation could push any copy at any number). Not this repository's code: FIXED in lij-worker 0.18.0
  (`lij-backup-v2`: the digest carries the copy's fingerprint and its number; v1 still taken from older engines for one
  release) and engine v358 (signs v2, says `auth_v: 2`). Recorded here because the three ride together.
- **/recover** carried in this release is the wallet repo's v989 (the directory's two doors, the direct door first).

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

**0.127.4.** Receivability first on the address rail (`receive-words.js`, the callback in `lij-adapter.js`). Found in
the field 2026-11-12: 8,000 sats sent to an address whose wallet could receive 7,510; the amount was over the channel's
room, so delivery needed a new channel, and the amount was under that provider's opening fee. The callback had made the
invoice anyway; the payer's sats were held, delivery refused, the hold was cancelled, and the payer's wallet said only
that the recipient declined. The callback now reads `walletReceivable` before it uses a hash, and refuses with an LNURL
error of at most 140 characters that says what the wallet can receive now and what a new channel costs. It also
refuses, before minting, a payment that needs an open the JIT guard would refuse. Not covered: a payment that fits when
the invoice is made and no longer fits when it is paid — that one is still refused at delivery, as before.

**0.128.0.** Two things.

*The tower* (`tower.js`, `tower-watch.js`, three routes and the start-up check in `lij-adapter.js`, a Console card).
LIJOX watch duty W1: the provider keeps wallets' encrypted penalty transactions and watches the chain for the old
states they answer. Off unless `TOWER_ENABLED=true`. What is checked: the encryption gives The Eye of Satoshi's own
test bytes; a block is believed only when its header hashes to the hash asked for; a held item is published only when
it opens with the old state's id AND spends that transaction and nothing else; after a stop the blocks missed are read
(2,016 at most — a longer gap is said in the journal and the older blocks are NOT read); the last twelve heights are
read again when their hash changes. Known limits, stated: (1) main output only — an old state's HTLC outputs are not
answered; (2) the watch looks every 30 seconds and a wallet's delay is 144 blocks, so a box down for a day can miss the
window; (3) the fee of a penalty is fixed when the wallet signs it — the box cannot raise it; the wallet sends two, at
two rates; (4) a put replayed inside its ten minutes keeps nothing twice, a drop replayed inside its ten minutes drops
again what the wallet may have put back; (5) nothing here has run against a real old state on the chain — the checks
are unit checks and a stand-in boot. The registry record does not carry the tower yet (that needs the worker's twin);
`/health` and `get_info` do.

*The chit refund* (`delegate.js`). Found 2026-11-13 while re-baking the key: the refund paid through
`POST /v1/channels/transactions` (SendPaymentSync), which LND 0.21 no longer has — the bake refused the permission, and
a refund asked of an LND 0.21 box could not have paid. No refund had failed on either box (the journal count was 0).
The refund now pays through `/v2/router/send` with the spend rail's fee limit and timeout. A payment whose outcome is
not known when the answer is due is no longer written down as failed: the chit stays `PAYING`, the answer is 503
`REFUND_PENDING`, and the next ask reads LND's own payment record — paid (200, `resolved_earlier: true`), failed (owed
again), or still unknown (409 `REFUND_IN_FLIGHT`). Before this an unknown outcome was booked as failed, and a wallet
that asked again with a new invoice could have been paid twice. `delegate-refund.test.js` (17 checks).

**0.129.0.** *The tower on the registry record* (`canonicalRegisterMsg` — the twin of lij-worker 0.21.0 — and
`registerWithRegistry` in `lij-adapter.js`). A record with a tower block signs as `lijox-register:v5`; one without
signs exactly as before, so a box with the tower off is untouched. `offered` on the record is the state at
registration; the first registration after a start is signed before the block reads have been tried and says "not
offered", and the record is sent again the moment the reads pass. A wallet must still ask the provider's `/health`
before it counts on a tower: the record can be up to six hours old.

*The joining drill* (`tower-drill.js`, the Console's Tower card, `POST /console/tower-drill`). Known limits, stated:
(1) it proves the tower published ONE answer on ONE day — not that it will tomorrow; (2) a pass needs the drilled
tower's node to relay a transaction and a miner to take it within six blocks: the answer pays twice the rate LND
estimates for two blocks, and a fee spike in those six blocks can fail a tower that did publish; (3) the drilling box
must itself be able to read blocks (its own tower turned on and watching); (4) the drill's one-time key and the answer
sit in `DATA_DIR/tower/drills.json` (owner-only) until the drill ends — losing that file while a drill runs loses the
drill amount if the tower also fails; (5) the transaction that stands in for an old state pays an ordinary script, not
a channel's: the drill exercises the tower's hint match, decryption, input check and publish, not LDK's penalty
signing (that is the wallet's side, tested in the engine). Not run against a real tower before this release — the
checks are unit checks with the real holder and watch behind a stand-in chain (`tower-drill.test.js`, 20).

**0.129.1.** The joining drill is started on the box, not from the Console. 0.129.0 put a "Drill" button and
`POST /console/tower-drill` in the Console; a drill spends the operator's coins (two on-chain fees), and the Console's
rule is that it shows information and moves no money. Both are removed. `node lij-adapter.js --tower-drill "<name or
node key>"` writes a request file (`DATA_DIR/tower/drill-request`) and exits; the running adapter reads it within
twenty seconds, removes it, and starts the drill or says in the journal why not. The Console's Tower card lists the
drills and their results. No drill was run with the button.

