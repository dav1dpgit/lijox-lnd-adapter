// push.js — 0.82.0 (S49, DP GO 2026-09-25 01:07 — PUSH KEY, step B: the provider's half). 0.113.0: see the S63 note below.
// 0.83.0 (S49, DP GO 15:37 — the first field finding): RECEIVABILITY FIRST. The recipient's provider asks
// walletReceivable (the deliverToWallet law: room in the channel → in full; else a JIT open at the one
// opening fee, or a refusal) before it mints a claim invoice or tries a direct delivery, and offers the
// same answer at GET /push/receivable so the claim sheet can say it before the tap; a refusal carries a
// reason the wallet can put in words (cannot_receive: under_open_fee | provider_reserve). A delivery-time
// burn keeps an end_code, read back at GET /push/claim-status/<hash>; the holder's /push/deliver failure
// carries a code beside LND's reason. Before this, the far wallet's "no room" reached the sender's provider
// as LND's one word, INCORRECT_PAYMENT_DETAILS, and the wallet showed that.
// 0.83.1 (S49, the second field finding): THE HOLDER'S KEY. A cross-provider delivery needs four LND RPCs the
// recipient's side never needs — DecodePayReq, SendPaymentV2, ListPayments, VerifyMessage — and a key baked
// without them (the delegate-free recipe, before 0.83.1) answered "permission denied", which read here as
// "invoice unreadable". Now probeKey() asks LND four harmless questions at boot, capability.cross_provider says
// the truth, /health and get_info carry the missing URIs, and a permission error on the path says so (holder_key).
// 0.83.2: A CLAIM INVOICE LIVES AS LONG AS THE KEY. LND keeps an expired invoice as CANCELED and refuses a hash it
// already has, so a claim invoice minted with the lock's 20-minute life made every second claim of the same key
// on that provider die at mint. Now its expiry is the key's remaining window (+10 min, ≤ 7 d), an idle claim
// keeps its OPEN invoice for a retry, and /push/claim reads LND's state of an existing invoice before answering.
// 0.84.0: a delivery our own LND refuses (TEMPORARY_CHANNEL_FAILURE from our link — no room after all) is retried
// three times, then burned as no_room so the wallet reads it in words; the room itself is now computed right
// (lij-adapter.js channelRoomMsat), so this is the rare race, not the rule.
// 0.113.0 (S63, DP 2026-10-26 — his five Push points after his own test, B claiming while A was offline):
//   (1) THE SENDER IS WOKEN when its push is TAKEN (and when it is RETURNED): the holder's LND can settle or fail the
//       sender's HTLC only when the sender's wallet is online; a wallet that stays closed past the HTLC's timelock
//       risks a force close (the holder's LND goes to chain to collect a settled HTLC; the sender's own LDK goes to
//       chain to reclaim an expired one). The wake carries the time by which to open (the HTLC's expiry height less
//       LND's 10-block broadcast delta, at ten minutes a block).
//   (2) THE TIMELOCK MARGIN IS 144 BLOCKS (PUSH_CLTV_MARGIN_BLOCKS; was 40): after a last-minute claim the sender
//       has about a day to come online before the holder must collect on-chain.
//   (3) A HOLD FEE: PUSH_HOLD_FEE_PPM_PER_DAY — per million of the amount, per day of the window (rounded up to whole
//       days), inside the lock's fee; the holder's liquidity sits behind the lock for the window and, after a take,
//       until the sender's wallet settles it. Default 0 until the operator sets it.
//   (4) (the lease: lij-adapter.js leaseCycle skips a channel with HTLCs on it.)
//   (5) A CLAIM IS REFUSED WHEN THE SENDER'S CHANNEL IS GONE: before paying the recipient (direct or by invoice) the
//       holder looks for the lock's HTLC on the sender's open channel (senderHtlc); a lock whose channel is closing or
//       closed is one the holder could only collect on-chain — the claim answers sender_channel_closed, nothing is paid.
// 0.85.0 (DP GO — "sealed"): THE NOTE. The sender's wallet seals its note with a key derived from the preimage and
// hands this provider the ciphertext plus a lookup token derived the same way; this provider keeps a blob it
// cannot read, and GET /push/note/<hash>?token= hands it to whoever holds the Push Key. Kept 7 days past the
// push's end, like the address note. No route token — the recipient may be on another provider; the token is the proof.
//
// A Push Key sets sats aside with one condition: whoever brings the key before the deadline gets
// them; if nobody does, they are the sender's again. The provider's part, true to the byte:
//   LOCK    the sender's wallet asks for a hold invoice on its hash (amount + this provider's delivery
//           fee — DP: the recipient gets the exact amount, the sender pays) and pays it over its own
//           channel; LND holds the HTLC (ACCEPTED) until the key shows up or the window ends.
//   CLAIM   the recipient's wallet (on this provider or another) brings the key's hash and its own
//           payment secret. Same provider: one delivery over the recipient's channel (JIT if it has
//           none — deliverToWallet), the recipient claims with the key, the preimage settles the
//           sender's hold. Another provider: the recipient's provider mints a hold invoice on the
//           hash; the holding provider pays it (fee within the quoted delivery fee), the recipient
//           claims, the preimage travels back, the sender's hold settles. Atomic — nobody holds the
//           money at any point.
//   VOID    the sender cancels the unclaimed hold, signed with its node key (the recover-close
//           pattern); the window's end does the same by itself (and the timelock would anyway).
//   STATUS  public, by hash: the sender's row and the claim page read it.
// Records persist in DATA_DIR/push-registry.json; watchers resume at boot.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VOID_DOMAIN = 'lij-push-void:v1|';
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);

function createPushRail(deps) {
  const {
    dataDir, lndGet, lndPost, deliverToWallet, isPeerConnected, sendWakePush, authOk, buildPublicHints,
    plRecord, leaseTouch, touchWalletActive, localPubkey, log, env = process.env, now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout },
    walletReceivable = async () => ({ ok: true, mode: 'channel', fee_msat: '0' }),   // 0.83.0: the deliverToWallet law, asked first
    senderHtlc = async () => ({ ok: true }),   // 0.113.0 (5): the sender's lock on its open channel — {ok, chan_point, active, expiration_height, height} | {ok:false, reason} | {error}
    proofCheck = null,   // 0.116.0 (F4): (fields, action, clientPk, recordId) → {ok} | {ok:false, code, status} — the node key's proof (lnurlpAuthCheck); null = not required (tests)
    lndDelete = null,    // 0.116.0 (F6): DELETE a canceled invoice (DeleteCanceledInvoice) so a burned claim's hash can be claimed again here
  } = deps;
  const sha256Hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
  const proofOf = (fields, action, clientPk, recordId) => (typeof proofCheck === 'function') ? proofCheck(fields, action, clientPk, recordId) : { ok: true };
  const claimOpenBlock = new Map();   // 0.116.0 (F6): claimant pubkey → until ms — a key whose claim delivery burned after a JIT open waits 24 h before another claim that needs an open
  const CLAIM_OPEN_BLOCK_MS = int(env.PUSH_CLAIM_OPEN_BLOCK_MS, 24 * 3600 * 1000);
  const FEE_BASE_MSAT = int(env.PUSH_DELIVERY_FEE_BASE_MSAT, 1000);
  const FEE_PPM = int(env.PUSH_DELIVERY_FEE_PPM, 2000);
  const CLTV_MARGIN_BLOCKS = int(env.PUSH_CLTV_MARGIN_BLOCKS, 144);   // 0.113.0 (2): was 40 (DP 2026-10-26: "raise … for example to 144 (about a day)")
  const HOLD_FEE_PPM_PER_DAY = int(env.PUSH_HOLD_FEE_PPM_PER_DAY, 0);   // 0.113.0 (3): the hold fee, per million per day of the window; 0 until the operator sets it
  const LND_INCOMING_BROADCAST_DELTA = 10;   // LND goes to chain for a settled incoming HTLC this many blocks before its expiry
  const DEFAULT_WINDOW_S = 72 * 3600;
  const MIN_AMOUNT_SATS = int(env.PUSH_MIN_SATS, 100);
  const MAX_AMOUNT_SATS = int(env.PUSH_MAX_SATS, 5_000_000);
  const WINDOW_MIN_S = 600, WINDOW_MAX_S = 7 * 24 * 3600;
  const LOCK_INVOICE_LIFE_S = 1200;          // the sender pays within seconds; an unpaid lock dies in 20 min
  const CLAIM_HOLD_MS = int(env.PUSH_CLAIM_HOLD_MS, 15 * 60 * 1000);   // the recipient is claiming now
  const DELIVER_TIMEOUT_S = int(env.PUSH_DELIVER_TIMEOUT_S, 90);
  const NOTE_CT_MAX = 2048;                    // 0.85.0: the sealed note's ciphertext, base64url
  const NOTE_KEEP_MS = 7 * 24 * 3600 * 1000;   // 0.85.0: kept this long past the push's end
  const NOTE_HITS_MAX = 60;                    // 0.85.0: note reads per address per minute
  const noteHits = new Map();
  const PATH = path.join(dataDir, 'push-registry.json');

  let reg = { out: {}, in: {} };
  try { const j = JSON.parse(fs.readFileSync(PATH, 'utf8')); if (j && typeof j === 'object') reg = { out: j.out || {}, in: j.in || {} }; } catch (_) {}
  const persist = () => { try { fs.writeFileSync(PATH, JSON.stringify(reg)); } catch (e) { log(`[PUSH-KEY] persist failed: ${e.message}`); } };
  const watchers = new Map();   // hash → timeout id
  const expiryTimers = new Map();

  const holdDays = (windowS) => Math.max(1, Math.ceil(Number(windowS || DEFAULT_WINDOW_S) / 86400));
  const holdFeeMsat = (amountMsat, windowS) => HOLD_FEE_PPM_PER_DAY > 0 ? Math.ceil(Number(amountMsat) * HOLD_FEE_PPM_PER_DAY * holdDays(windowS) / 1_000_000) : 0;   // 0.113.0 (3)
  const feeMsat = (amountMsat, windowS) => Math.max(FEE_BASE_MSAT + Math.ceil(Number(amountMsat) * FEE_PPM / 1_000_000) + holdFeeMsat(amountMsat, windowS), 1000);
  const blocksFor = (windowS) => Math.ceil(windowS / 600) + CLTV_MARGIN_BLOCKS;
  const short = (h) => String(h || '').slice(0, 16);
  const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
  const preHex = (p) => Buffer.isBuffer(p) ? p.toString('hex') : (/^[0-9a-f]{64}$/i.test(String(p)) ? String(p).toLowerCase() : Buffer.from(String(p), 'base64').toString('hex'));
  const sha256 = (hex) => crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
  const stopWatch = (h) => { const t = watchers.get(h); if (t) { timers.clear(t); watchers.delete(h); } };
  // 0.83.0: deliverToWallet's refuse reasons → the codes the wallet puts in words
  const refuseCode = (reason) => /opening fee/i.test(String(reason)) ? 'under_open_fee' : /reserve/i.test(String(reason)) ? 'provider_reserve' : 'refused';
  // 0.83.0: LND's failure_reason on a cross-provider delivery → a code the wallet can act on
  const deliverCode = (fr) => /INCORRECT_PAYMENT_DETAILS/.test(fr) ? 'recipient_refused' : /NO_ROUTE/.test(fr) ? 'no_route' : /TIMEOUT/.test(fr) ? 'timeout' : /INSUFFICIENT_BALANCE/.test(fr) ? 'holder_balance' : 'error';
  const rxFields = (rx) => ({ reason: rx.reason, fee_msat: rx.fee_msat, receivable_msat: rx.receivable_msat, min_msat: rx.min_msat });
  // 0.85.0: the note's end — a record that ended keeps its sealed note NOTE_KEEP_MS, then it is gone
  const noteEnd = (rec) => { if (rec.note_ct) rec.note_prune_at = now() + NOTE_KEEP_MS; };
  function pruneNotes() {
    let n = 0;
    for (const rec of Object.values(reg.out)) if (rec.note_ct && rec.note_prune_at && rec.note_prune_at <= now()) { delete rec.note_ct; delete rec.note_token; delete rec.note_prune_at; n++; }
    if (n) { persist(); log(`[PUSH-KEY] ${n} sealed note(s) past their keep — gone`); }
    return n;
  }
  const noteLimited = (ip) => { const t = now(); const arr = (noteHits.get(ip) || []).filter((x) => t - x < 60000); if (arr.length >= NOTE_HITS_MAX) { noteHits.set(ip, arr); return true; } arr.push(t); noteHits.set(ip, arr); if (noteHits.size > 5000) noteHits.clear(); return false; };
  timers.set(function noteSweep() { pruneNotes(); timers.set(noteSweep, 3600 * 1000); }, 3600 * 1000);   // 0.85.0: the hourly sweep, from creation
  const tokenEq = (a, b) => { const A = Buffer.from(String(a || ''), 'utf8'), B = Buffer.from(String(b || ''), 'utf8'); return A.length === B.length && crypto.timingSafeEqual(A, B); };
  // 0.83.1: LND's REST answers a permission failure as a JSON body {code:2, message:"permission denied"} — lndRequest
  // resolves it like any answer, so every reader must look.
  const msgOf = (r) => r ? String(r.message || (r.error && r.error.message) || '') : '';   // streaming routes wrap errors as {error:{message}}
  const isPermErr = (r) => /permission denied|macaroon|unauthorized/i.test(msgOf(r));
  // 0.83.1: the holder's key, probed at boot with four calls that cannot move money: a bad payreq (DecodePayReq
  // answers "checksum failed"/"invalid" — permitted), an empty verify (VerifyMessage answers an argument error —
  // permitted), one payment listed (ListPayments), an empty router send (SendPaymentV2 answers "payment request
  // or destination required" — permitted). A permission body marks the RPC missing.
  const HOLDER_RPCS = [
    { uri: '/lnrpc.Lightning/DecodePayReq', call: () => lndGet('/v1/payreq/lnbc1probe') },
    { uri: '/lnrpc.Lightning/VerifyMessage', call: () => lndPost('/v1/verifymessage', { msg: '', signature: '' }) },
    { uri: '/lnrpc.Lightning/ListPayments', call: () => lndGet('/v1/payments?max_payments=1') },
    { uri: '/routerrpc.Router/SendPaymentV2', call: () => lndPost('/v2/router/send', { timeout_seconds: 1 }) },
  ];
  const DELETE_RPC = { uri: '/lnrpc.Lightning/DeleteCanceledInvoice', call: () => (typeof lndDelete === 'function' ? lndDelete('/v1/invoices?invoice_hash=' + '00'.repeat(32)) : Promise.resolve({ message: 'no lndDelete' })) };   // 0.116.0 (F6): probed apart — not a holder RPC
  async function probeKey() {
    const missing = [];
    for (const r of HOLDER_RPCS) {
      let a; try { a = await r.call(); } catch (e) { a = { message: String(e.message || e) }; }
      if (isPermErr(a)) missing.push(r.uri);
    }
    capability.cross_provider = missing.length === 0; capability.missing_rpcs = missing;
    try { const a = await DELETE_RPC.call(); capability.delete_canceled = !isPermErr(a); if (!capability.delete_canceled) log('[PUSH-KEY] key probe: the macaroon lacks ' + DELETE_RPC.uri + ' — a burned claim\'s hash stays unclaimable here until the key is re-baked (MACAROON.md, 0.116.0)'); } catch (_) {}   // 0.116.0 (F6)
    if (missing.length) log(`[PUSH-KEY] THIS KEY CANNOT PASS A PUSH KEY TO ANOTHER PROVIDER (nor verify a void): the macaroon lacks ${missing.join(', ')} — re-bake with bake-permissions-nodelegate.json (0.83.1) or the full recipe; same-provider pushes still work`);
    else log('[PUSH-KEY] key probe: this provider can hold, deliver across providers and verify voids');
    return missing;
  }

  // 0.114.0 (S63, Kimi round 2 F3 — DP "Fix this hole"): the settle call's answer is READ. lndRequest hands an LND error
  // body back as data (never a throw), so "invoice already canceled" used to count as settled. Throws on any error body.
  async function settleInvoice(preimageHex) {
    const r = await lndPost('/v2/invoices/settle', { preimage: b64(preimageHex) });
    const m = msgOf(r);
    if (r && (m || r.code !== undefined)) throw new Error(m || ('LND code ' + r.code));
    return r;
  }
  // ── the outer settle, guarded: the preimage must open THIS hash ──
  // 0.114.0 (F3): a settle that fails leaves the record settle_pending with the preimage KEPT and the watcher on — it
  // retries the settle alone (never the inner delivery, which succeeded); the sender's wake waits for the real settle.
  async function settleOuter(rec, preimageHex, how) {
    if (sha256(preimageHex) !== rec.hash) { log(`[PUSH-KEY] ${short(rec.hash)}: a preimage that does not open the hash — refusing to settle (${how})`); return false; }
    try { await settleInvoice(preimageHex); }
    catch (e) {
      rec.status = 'settle_pending'; rec.preimage = preimageHex; rec.settle_error = String(e.message || e).slice(0, 160); rec.settle_tries = (rec.settle_tries || 0) + 1; delete rec.deliver_inflight_at; persist();
      log(`[PUSH-KEY] ${short(rec.hash)}: OUTER SETTLE FAILED after ${how} (${rec.settle_error}) — the recipient is paid; settle_pending, the watcher retries (try ${rec.settle_tries})`);
      watchOut(rec.hash);
      return false;
    }
    markTaken(rec, preimageHex, how);
    return true;
  }
  function markTaken(rec, preimageHex, how) {
    rec.status = 'taken'; rec.taken_at = now(); rec.preimage = preimageHex || rec.preimage || null; delete rec.deliver_inflight_at; delete rec.settle_error; noteEnd(rec);   // 0.85.0
    persist(); stopWatch(rec.hash);
    const t = expiryTimers.get(rec.hash); if (t) { timers.clear(t); expiryTimers.delete(rec.hash); }
    const kept = Math.max(0, Number(rec.fee_msat) - Number(rec.fee_spent_msat || 0));
    try { plRecord('push_fee', { msat: kept, moved_msat: Number(rec.amount_msat), wallet: rec.client_pubkey, hash: rec.hash }); } catch (_) {}
    log(`[PUSH-KEY] ${short(rec.hash)}: TAKEN — ${rec.amount_msat} msat delivered (${how}); fee kept ${kept} msat`);
    wakeSender(rec, 'push_taken').catch(() => {});   // 0.113.0 (1): the sender's wallet settles the HTLC only when it is open
  }

  async function cancelOuter(rec, why, status) {
    try { await lndPost('/v2/invoices/cancel', { payment_hash: b64(rec.hash) }); }
    catch (e) { log(`[PUSH-KEY] ${short(rec.hash)}: cancel failed (${e.message})`); }
    rec.status = status; rec.ended_at = now(); rec.end_reason = why; noteEnd(rec);   // 0.85.0
    persist(); stopWatch(rec.hash);
    const t = expiryTimers.get(rec.hash); if (t) { timers.clear(t); expiryTimers.delete(rec.hash); }
    log(`[PUSH-KEY] ${short(rec.hash)}: ${status.toUpperCase()} — ${why}`);
    if (status === 'returned') wakeSender(rec, 'push_returned').catch(() => {});   // 0.113.0 (1): the fail-back reaches the sender's wallet only when it is open
  }

  // 0.113.0 (1): the sender's wake — the time by which to open is the lock's HTLC expiry less LND's broadcast delta,
  // read from the sender's channel when it can be; without it the wake carries no time.
  async function wakeSender(rec, kind) {
    let untilMs = 0;
    try {
      const lk = await senderHtlc(rec.client_pubkey, rec.hash);
      if (lk && lk.ok && Number.isFinite(Number(lk.expiration_height)) && Number.isFinite(Number(lk.height))) {
        const left = Number(lk.expiration_height) - Number(lk.height) - LND_INCOMING_BROADCAST_DELTA;
        if (left > 0) untilMs = left * 600 * 1000;
      }
    } catch (_) {}
    log(`[PUSH-KEY] ${short(rec.hash)}: waking the sender ${rec.client_pubkey.slice(0, 16)}… (${kind}${untilMs ? ', open within ~' + Math.round(untilMs / 3600000) + ' h' : ''})`);
    try { await sendWakePush(rec.client_pubkey, untilMs > 0 ? untilMs : undefined, kind); } catch (_) {}
  }

  // 0.113.0 (5): the holder pays nobody against a lock it could only collect on-chain — the lock's HTLC must sit on
  // the sender's OPEN channel. Answers null when it does, else the refusal to send.
  async function senderLockRefusal(rec) {
    let lk; try { lk = await senderHtlc(rec.client_pubkey, rec.hash); } catch (e) { lk = { error: String(e.message || e) }; }
    if (!lk || lk.error) { log(`[PUSH-KEY] ${short(rec.hash)}: could not read the sender's channel (${lk && lk.error || 'no answer'}) — not paying`); return { ok: false, error: 'sender_channel_unknown', reason: 'the holder could not check the sender\'s channel — try again in a minute', status: 503 }; }
    if (!lk.ok) { log(`[PUSH-KEY] ${short(rec.hash)}: the sender's channel is closing or closed — REFUSING the claim (${lk.reason || 'no lock on an open channel'})`); return { ok: false, error: 'sender_channel_closed', reason: 'the sender\'s channel that holds this lock is closing or closed — this key can no longer be taken; the sats return to the sender on-chain', status: 409 }; }
    return null;
  }

  function armExpiry(rec) {
    if (expiryTimers.has(rec.hash)) return;
    const left = rec.expiry * 1000 - now();
    const fire = () => {
      expiryTimers.delete(rec.hash); const r = reg.out[rec.hash];
      if (!r || r.status !== 'locked') return;
      // 0.114.0 (S63, Kimi round 2 F2 — DP "Fix this hole"): never cancel the hold while a delivery is in flight — the
      // inner leg could still pay the recipient after the sender was refunded. A minute later, again; the probe meanwhile.
      if (r._delivering || r.deliver_inflight_at) {
        log(`[PUSH-KEY] ${short(rec.hash)}: window over but a delivery is in flight — the hold stays a minute more`);
        if (r.deliver_inflight_at) probeDelivery(r).catch(() => {});
        expiryTimers.set(rec.hash, timers.set(fire, 60000));
        return;
      }
      cancelOuter(r, 'window over — nobody brought the key', 'returned').catch(() => {});
    };
    if (left <= 0) { fire(); return; }
    expiryTimers.set(rec.hash, timers.set(fire, Math.min(left, 2_147_000_000)));
  }

  // ── in-flight truth for a cross-provider delivery that outran the RPC ──
  async function probeDelivery(rec) {
    let r; try { r = await lndGet('/v1/payments?include_incomplete=true&reversed=true&max_payments=100'); } catch (_) { return; }
    const pay = ((r && r.payments) || []).find((x) => String(x.payment_hash || '').toLowerCase() === rec.hash);
    if (!pay) { if (now() - rec.deliver_inflight_at > 120000) { delete rec.deliver_inflight_at; persist(); } return; }
    if (pay.status === 'SUCCEEDED' && /^[0-9a-f]{64}$/i.test(String(pay.payment_preimage || ''))) {
      rec.fee_spent_msat = Number(pay.fee_msat || 0);
      await settleOuter(rec, String(pay.payment_preimage).toLowerCase(), 'late delivery success');
    } else if (pay.status === 'FAILED') {
      delete rec.deliver_inflight_at; rec.last_deliver_error = String(pay.failure_reason || 'FAILED'); rec.last_deliver_code = deliverCode(rec.last_deliver_error); persist();
      log(`[PUSH-KEY] ${short(rec.hash)}: the delivery failed (${rec.last_deliver_error}) — still locked, the recipient may try again`);
    }
  }

  // ── the holder's watcher: the lock invoice's life ──
  function watchOut(hash) {
    if (watchers.has(hash)) return;
    const tick = async () => {
      const rec = reg.out[hash];
      if (!rec) { watchers.delete(hash); return; }
      try {
        const inv = await lndGet('/v1/invoice/' + hash);
        const state = inv && inv.state;
        if (state === 'ACCEPTED' && rec.status === 'minted') {
          rec.status = 'locked'; rec.locked_at = now(); persist();
          log(`[PUSH-KEY] ${short(hash)}: LOCKED — ${rec.total_msat} msat held for ${rec.client_pubkey.slice(0, 16)}… until ${new Date(rec.expiry * 1000).toISOString()}`);
          armExpiry(rec);
        } else if (state === 'ACCEPTED' && rec.status === 'locked') {
          armExpiry(rec);
          if (rec.deliver_inflight_at) await probeDelivery(rec);
        } else if (state === 'ACCEPTED' && rec.status === 'settle_pending') {   // 0.114.0 (F3): the retry — the settle alone, every 15 s
          if (rec.preimage && (!rec.settle_last_try || now() - rec.settle_last_try >= 15000)) { rec.settle_last_try = now(); await settleOuter(rec, rec.preimage, 'settle retry'); }
        } else if (state === 'SETTLED') {
          if (rec.status === 'settle_pending') markTaken(rec, rec.preimage, 'settled on retry');
          else if (rec.status !== 'taken') { rec.status = 'taken'; rec.taken_at = now(); persist(); }
          stopWatch(hash);
        } else if (state === 'CANCELED') {
          if (rec.status === 'minted') { rec.status = 'unpaid'; rec.ended_at = now(); persist(); }
          else if (rec.status === 'locked') { rec.status = 'returned'; rec.ended_at = now(); rec.end_reason = rec.end_reason || 'canceled by LND'; persist(); }
          else if (rec.status === 'settle_pending') { rec.status = 'paid_unsettled'; rec.ended_at = now(); rec.end_reason = 'the recipient was paid but LND cancelled the sender\'s hold before the settle — MANUAL ATTENTION'; persist(); log(`[PUSH-KEY] ${short(hash)}: PAID BUT UNSETTLED — the recipient has the sats, the sender's hold was cancelled (${rec.settle_error || 'settle failed'}) — MANUAL ATTENTION`); }   // 0.114.0 (F3)
          stopWatch(hash);
        } else if (state === 'OPEN' && rec.status === 'minted' && now() - rec.created > (LOCK_INVOICE_LIFE_S + 300) * 1000) {
          rec.status = 'unpaid'; rec.ended_at = now(); persist(); stopWatch(hash);
        }
      } catch (_) { /* transient: keep watching */ }
      if (watchers.has(hash)) watchers.set(hash, timers.set(tick, (rec.status === 'minted' && now() - rec.created < 20000) ? 250 : 4000));
    };
    watchers.set(hash, timers.set(tick, 250));
  }

  // 0.114.0 (F3): the claim's settle, read. The recipient is paid; a settle that fails leaves settle_pending with the
  // preimage kept, and the watcher retries the settle alone. The bookkeeping (PL, the lease touch) follows the real settle.
  async function settleIn(rec, how) {
    try { await settleInvoice(rec.preimage); }
    catch (e) {
      rec.status = 'settle_pending'; rec.settle_error = String(e.message || e).slice(0, 160); rec.settle_tries = (rec.settle_tries || 0) + 1; delete rec.deliver_inflight_at; persist();
      log(`[PUSH-KEY] claim ${short(rec.hash)}: OUTER SETTLE FAILED after ${how} (${rec.settle_error}) — the recipient is paid; settle_pending, the watcher retries (try ${rec.settle_tries})`);
      return false;
    }
    rec.status = 'settled'; rec.settled_at = now(); delete rec.settle_error; delete rec.deliver_inflight_at; persist(); stopWatch(rec.hash);
    const ht = expiryTimers.get('in:' + rec.hash); if (ht) { timers.clear(ht); expiryTimers.delete('in:' + rec.hash); }
    const fee = BigInt(rec.open_fee_msat || 0), inner = BigInt(rec.delivered_msat || rec.amount_msat);
    try { plRecord(fee > 0n ? 'open_fee' : 'hold_fee', { msat: Number(fee), moved_msat: Number(inner), wallet: rec.client_pubkey, hash: rec.hash }); } catch (_) {}
    try { leaseTouch(rec.client_pubkey, 'push:claimed'); } catch (_) {}
    log(`[PUSH-KEY] claim ${short(rec.hash)}: SETTLED — ${inner} msat delivered to ${rec.client_pubkey.slice(0, 16)}… (fee ${fee} msat, ${how})`);
    return true;
  }
  // 0.114.0 (F2, the claim side): a delivery that outran the RPC — LND still owns it; ask LND, never a second send
  async function probeIn(rec) {
    let r; try { r = await lndGet('/v1/payments?include_incomplete=true&reversed=true&max_payments=100'); } catch (_) { return; }
    const pay = ((r && r.payments) || []).find((x) => String(x.payment_hash || '').toLowerCase() === rec.hash);
    if (!pay) { if (now() - rec.deliver_inflight_at > 120000) { delete rec.deliver_inflight_at; persist(); } return; }
    if (pay.status === 'SUCCEEDED' && /^[0-9a-f]{64}$/i.test(String(pay.payment_preimage || ''))) {
      const pre = String(pay.payment_preimage).toLowerCase();
      if (sha256(pre) !== rec.hash) { log(`[PUSH-KEY] claim ${short(rec.hash)}: the late preimage does not open the hash — not settling`); delete rec.deliver_inflight_at; persist(); return; }
      rec.preimage = pre; if (!rec.delivered_msat) rec.delivered_msat = String(pay.value_msat || rec.amount_msat); if (!rec.open_fee_msat) rec.open_fee_msat = '0';
      await settleIn(rec, 'late delivery success');
    } else if (pay.status === 'FAILED') {
      delete rec.deliver_inflight_at; rec.inner_fails = (rec.inner_fails || 0) + 1; persist();
      log(`[PUSH-KEY] claim ${short(rec.hash)}: the in-flight delivery FAILED (${pay.failure_reason || 'FAILED'}) — try ${rec.inner_fails}, the next tick delivers again`);
    }
  }
  // ── the recipient's provider: the claim invoice and its delivery (the LNURLP shape) ──
  async function deliverIn(rec) {
    if (rec.status !== 'accepted' || rec._delivering) return;
    if (rec.deliver_inflight_at) { await probeIn(rec); return; }   // 0.114.0 (F2): LND owns a delivery — probe, never a second send
    if (!(await isPeerConnected(rec.client_pubkey))) return;
    rec._delivering = true;
    try {
      const out = await deliverToWallet({ client: rec.client_pubkey, hashHex: rec.hash, secretHex: rec.secret, amountMsat: BigInt(rec.amount_msat), tag: 'PUSH claim', jitTag: 'push:' + short(rec.hash) });
      if (out.kind === 'refuse') { await cancelIn(rec, out.reason, refuseCode(out.reason)); return; }
      if (out.kind === 'retry' || out.kind === 'rejected') {
        if (out.kind === 'rejected') {
          if (/DEADLINE_EXCEEDED|hard.?timeout|in flight/i.test(String(out.error || ''))) { rec.deliver_inflight_at = now(); persist(); log(`[PUSH-KEY] claim ${short(rec.hash)}: sendToRoute says LND still owns a delivery (${out.error}) — probing`); return; }   // 0.114.0 (F2)
          log(`[PUSH-KEY] claim ${short(rec.hash)}: sendToRoute rejected: ${out.error}`);
        }
        return;
      }
      const a = out.attempt;
      if (a && a.status === 'HARD_TIMEOUT') { rec.deliver_inflight_at = now(); persist(); log(`[PUSH-KEY] claim ${short(rec.hash)}: the delivery hit the hard timeout — LND still owns it; probing, no second send`); return; }   // 0.114.0 (F2): a hard timeout is not a failed try
      if (!a || a.status !== 'SUCCEEDED') {
        const fc = a && a.failure ? a.failure.code : 'unknown';
        if (['INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS', 'INVALID_ONION_VERSION', 'INVALID_ONION_HMAC', 'INVALID_ONION_KEY', 'INVALID_ONION_PAYLOAD'].includes(String(fc))) { await cancelIn(rec, 'recipient refused: ' + fc, 'recipient_refused'); return; }
        const fsrc = a && a.failure ? a.failure.failure_source_index : undefined;   // 0 = our own link, 1 = the wallet
        rec.inner_fails = (rec.inner_fails || 0) + 1; persist();
        if (String(fc) === 'TEMPORARY_CHANNEL_FAILURE' && (fsrc === 0 || fsrc === undefined) && rec.inner_fails >= 3) { await cancelIn(rec, `no room on the wallet's channel — our LND refused the HTLC ${rec.inner_fails} times (${fc})`, 'no_room'); return; }
        if (rec.inner_fails >= 12) { await cancelIn(rec, `the delivery did not succeed after ${rec.inner_fails} tries (${a ? a.status : 'none'} ${fc}, source ${fsrc === undefined ? '?' : fsrc})`, 'delivery_failed'); return; }
        log(`[PUSH-KEY] claim ${short(rec.hash)}: inner leg did not succeed (${a ? a.status : 'none'} ${fc}, source ${fsrc === undefined ? '?' : fsrc}) — try ${rec.inner_fails}, retry next tick`);
        return;
      }
      const pre = preHex(a.preimage);
      if (sha256(pre) !== rec.hash) { log(`[PUSH-KEY] claim ${short(rec.hash)}: inner preimage does not open the hash — not settling`); return; }
      rec.preimage = pre; rec.delivered_msat = String(out.innerMsat); rec.open_fee_msat = String(out.feeMsat); persist();
      await settleIn(rec, 'inner success');   // 0.114.0 (F3)
    } finally { delete rec._delivering; }
  }
  async function cancelIn(rec, why, code) {
    try { await lndPost('/v2/invoices/cancel', { payment_hash: b64(rec.hash) }); } catch (e) { log(`[PUSH-KEY] claim ${short(rec.hash)}: cancel failed (${e.message})`); }
    rec.status = 'burned'; rec.end_reason = why; rec.end_code = code || 'refused'; rec.ended_at = now(); persist(); stopWatch(rec.hash);
    const ht = expiryTimers.get('in:' + rec.hash); if (ht) { timers.clear(ht); expiryTimers.delete('in:' + rec.hash); }
    log(`[PUSH-KEY] claim ${short(rec.hash)}: BURNED — ${why}`);
    // 0.116.0 (F6): a delivery that burned after a channel was opened for the claimant — that key waits 24 h before
    // another claim that needs an open; and the canceled invoice is deleted from LND so the hash can be claimed here
    // again by the real recipient (the squat's residue)
    if (rec.rx_mode === 'open' && code !== 'claim_window_over' && code !== 'no_room') { claimOpenBlock.set(rec.client_pubkey, now() + CLAIM_OPEN_BLOCK_MS); log(`[PUSH-KEY] claim ${short(rec.hash)}: ${rec.client_pubkey.slice(0, 16)}… burned after a channel open — its claims that need an open wait ${Math.round(CLAIM_OPEN_BLOCK_MS / 3600000)} h`); }
    if (typeof lndDelete === 'function') {
      try {
        const d = await lndDelete('/v1/invoices?invoice_hash=' + rec.hash);
        if (isPermErr(d)) { if (capability.delete_canceled !== false) { capability.delete_canceled = false; log('[PUSH-KEY] this key cannot delete a canceled claim invoice (the macaroon lacks /lnrpc.Lightning/DeleteCanceledInvoice) — a burned claim\'s hash stays unclaimable on this provider until the key is re-baked (MACAROON.md, 0.116.0)'); } }
        else if (msgOf(d)) log(`[PUSH-KEY] claim ${short(rec.hash)}: the canceled invoice stays in LND (${msgOf(d)})`);
        else { capability.delete_canceled = true; rec.invoice_deleted = true; persist(); log(`[PUSH-KEY] claim ${short(rec.hash)}: the canceled claim invoice deleted from LND — the real recipient may claim this key here`); }
      } catch (e) { log(`[PUSH-KEY] claim ${short(rec.hash)}: delete of the canceled invoice failed (${e.message})`); }
    }
  }
  function watchIn(hash) {
    if (watchers.has(hash)) return;
    const tick = async () => {
      const rec = reg.in[hash];
      if (!rec) { watchers.delete(hash); return; }
      try {
        const inv = await lndGet('/v1/invoice/' + hash);
        const state = inv && inv.state;
        if (state === 'ACCEPTED' && rec.status === 'reserved') {
          rec.status = 'accepted'; rec.accepted_at = now(); persist();
          log(`[PUSH-KEY] claim ${short(hash)}: the holder's payment ACCEPTED (${inv.amt_paid_msat || rec.amount_msat} msat) — delivering to ${rec.client_pubkey.slice(0, 16)}…`);
          if (!expiryTimers.has('in:' + hash)) { const fireIn = () => { expiryTimers.delete('in:' + hash); const r = reg.in[hash]; if (!r || r.status !== 'accepted') return; if (r._delivering || r.deliver_inflight_at) { log(`[PUSH-KEY] claim ${short(hash)}: claim window over but a delivery is in flight — a minute more`); if (r.deliver_inflight_at) probeIn(r).catch(() => {}); expiryTimers.set('in:' + hash, timers.set(fireIn, 60000)); return; } cancelIn(r, 'claim window over — the wallet did not take it', 'claim_window_over').catch(() => {}); }; expiryTimers.set('in:' + hash, timers.set(fireIn, CLAIM_HOLD_MS)); }   // 0.114.0 (F2): never while a delivery is in flight
          try { Promise.resolve(sendWakePush(rec.client_pubkey, CLAIM_HOLD_MS)).catch(() => {}); } catch (_) {}   // 0.88.1: the wake states the claim window (it was the wallet's dial)
          deliverIn(rec).catch((e) => log(`[PUSH-KEY] claim deliver error: ${e.message}`));
        } else if (state === 'ACCEPTED' && rec.status === 'accepted') {
          deliverIn(rec).catch((e) => log(`[PUSH-KEY] claim deliver error: ${e.message}`));
        } else if (state === 'ACCEPTED' && rec.status === 'settle_pending') {   // 0.114.0 (F3): the settle alone, retried every 15 s
          if (rec.preimage && (!rec.settle_last_try || now() - rec.settle_last_try >= 15000)) { rec.settle_last_try = now(); await settleIn(rec, 'settle retry'); }
        } else if (state === 'SETTLED') {
          if (rec.status !== 'settled') { rec.status = 'settled'; rec.settled_at = now(); delete rec.settle_error; persist(); }
          stopWatch(hash);
        } else if (state === 'CANCELED') {
          if (rec.status === 'settle_pending') { rec.status = 'paid_unsettled'; rec.end_reason = 'the recipient was paid but the holder\'s payment was cancelled before the settle — MANUAL ATTENTION'; persist(); log(`[PUSH-KEY] claim ${short(hash)}: PAID BUT UNSETTLED (${rec.settle_error || 'settle failed'}) — MANUAL ATTENTION`); }   // 0.114.0 (F3)
          else if (rec.status !== 'burned') { rec.status = 'burned'; rec.end_reason = rec.end_reason || 'canceled/expired'; persist(); }
          stopWatch(hash);
        } else if (state === 'OPEN' && rec.status === 'reserved' && now() - (rec.armed_at || rec.created) > (LOCK_INVOICE_LIFE_S + 300) * 1000) {
          rec.idle_at = now(); persist(); stopWatch(hash);   // 0.83.2: idle, not burned — the invoice stays OPEN for a retry, which re-arms the watcher
          log(`[PUSH-KEY] claim ${short(hash)}: the holder has not paid in 25 min — idle; a retry re-arms it`);
        }
      } catch (_) {}
      if (watchers.has(hash)) watchers.set(hash, timers.set(tick, (rec.status === 'reserved' && now() - rec.created < 20000) ? 250 : 4000));
    };
    watchers.set(hash, timers.set(tick, 250));
  }

  async function mintHold({ hashHex, valueMsat, cltvExpiry, memo, hints, expiryS }) {
    const body = { hash: b64(hashHex), value_msat: String(valueMsat), memo, expiry: String(expiryS || LOCK_INVOICE_LIFE_S), cltv_expiry: String(cltvExpiry), private: true };   // 0.83.2: a claim invoice's life is the key's
    if (hints && hints.length) body.route_hints = hints;
    let r = await lndPost('/v2/invoices/hodl', body);
    if ((!r || !r.payment_request) && hints && hints.length) { const b2 = Object.assign({}, body); delete b2.route_hints; r = await lndPost('/v2/invoices/hodl', b2); }
    if (!r || !r.payment_request) throw new Error((r && (r.message || r.error)) || 'hold invoice mint failed');
    return r.payment_request;
  }

  // ── same-provider delivery: the holder pays its own recipient directly and settles the sender's hold ──
  async function deliverDirect(rec, client, secret) {
    if (!(await isPeerConnected(client))) return { ok: false, reason: 'wallet not connected' };
    if (rec._delivering || rec.deliver_inflight_at) { if (rec.deliver_inflight_at) probeDelivery(rec).catch(() => {}); return { ok: false, error: 'in_flight', reason: 'a delivery for this key is already in flight', in_flight: true }; }   // 0.114.0 (F2): one delivery at a time
    rec._delivering = true;   // 0.114.0 (F2): the expiry timer reads this (bootResume clears it)
    let out;
    try { out = await deliverToWallet({ client, hashHex: rec.hash, secretHex: secret, amountMsat: BigInt(rec.amount_msat), tag: 'PUSH direct', jitTag: 'push:' + short(rec.hash) }); }
    finally { delete rec._delivering; }
    if (out.kind === 'refuse') return { ok: false, error: 'cannot_receive', reason: refuseCode(out.reason), detail: out.reason };
    if (out.kind === 'retry') return { ok: false, reason: 'retry: ' + out.reason };
    if (out.kind === 'rejected') {
      if (/DEADLINE_EXCEEDED|hard.?timeout|in flight/i.test(String(out.error || ''))) { rec.deliver_inflight_at = now(); rec.claimant = client; rec.fee_spent_msat = 0; persist(); log(`[PUSH-KEY] ${short(rec.hash)}: direct delivery — LND still owns a send (${out.error}); probing`); return { ok: false, error: 'in_flight', reason: 'in_flight', in_flight: true }; }   // 0.114.0 (F2)
      return { ok: false, reason: 'rejected: ' + out.error };
    }
    const a = out.attempt;
    if (a && a.status === 'HARD_TIMEOUT') { rec.deliver_inflight_at = now(); rec.claimant = client; rec.fee_spent_msat = 0; persist(); log(`[PUSH-KEY] ${short(rec.hash)}: direct delivery hit the hard timeout — LND still owns it; probing`); return { ok: false, error: 'in_flight', reason: 'in_flight', in_flight: true }; }   // 0.114.0 (F2)
    if (!a || a.status !== 'SUCCEEDED') return { ok: false, reason: 'delivery did not succeed: ' + (a && a.failure ? a.failure.code : (a ? a.status : 'none')) };
    const pre = preHex(a.preimage);
    rec.claimant = client; rec.fee_spent_msat = 0; rec.delivered_msat = String(out.innerMsat); rec.open_fee_msat = String(out.feeMsat);
    const ok = await settleOuter(rec, pre, 'direct delivery');
    // 0.114.0 (F3): the recipient HAS the sats either way — ok; settle_pending says the sender's hold settles on retry
    return ok ? { ok: true, status: 'taken', mode: 'direct', delivered_msat: String(out.innerMsat), open_fee_msat: String(out.feeMsat) } : { ok: true, status: 'settle_pending', mode: 'direct', delivered_msat: String(out.innerMsat), open_fee_msat: String(out.feeMsat), note: 'the sats reached the recipient; the sender\'s hold settles on retry' };
  }

  // ── cross-provider delivery: the holder pays the recipient's provider's hold invoice for the hash ──
  async function deliverByInvoice(rec, bolt11, claimant) {
    let pr;
    try { pr = await lndGet('/v1/payreq/' + encodeURIComponent(bolt11)); } catch (e) { pr = { message: String(e.message || e) }; }
    if (isPermErr(pr)) { log(`[PUSH-KEY] ${short(rec.hash)}: cannot read the recipient's invoice — LND: ${msgOf(pr)} (the key lacks /lnrpc.Lightning/DecodePayReq)`); capability.cross_provider = false; return { ok: false, reason: 'this provider\'s LND key cannot read invoices (DecodePayReq) — the operator must re-bake it', code: 'holder_key' }; }
    if (!pr || !pr.payment_hash) { log(`[PUSH-KEY] ${short(rec.hash)}: invoice unreadable — LND: ${msgOf(pr) || 'no payment_hash in the answer'}`); return { ok: false, reason: 'invoice unreadable' + (msgOf(pr) ? ': ' + msgOf(pr).slice(0, 80) : ''), code: 'bad_invoice' }; }
    if (String(pr.payment_hash).toLowerCase() !== rec.hash) return { ok: false, reason: 'the invoice is not for this Push Key' };
    if (String(pr.num_msat || '0') !== String(rec.amount_msat)) return { ok: false, reason: `the invoice asks ${pr.num_msat} msat, the push holds ${rec.amount_msat}` };
    if (String(pr.destination || '').toLowerCase() === String(localPubkey() || '').toLowerCase()) return { ok: false, reason: 'the invoice is this provider\'s own — claim directly' };
    rec.deliver_inflight_at = now(); rec.claimant = claimant; persist();
    let pay;
    try {
      pay = await Promise.race([
        lndPost('/v2/router/send', { payment_request: bolt11, timeout_seconds: DELIVER_TIMEOUT_S, fee_limit_msat: String(rec.fee_msat), no_inflight_updates: true }),
        new Promise((_, rj) => timers.set(() => rj(new Error('client_backstop')), (DELIVER_TIMEOUT_S + 10) * 1000)),
      ]);
      if (pay && pay.result) pay = pay.result;
    } catch (e) { pay = { transport_error: String(e.message || e).slice(0, 160) }; }
    if (isPermErr(pay)) { delete rec.deliver_inflight_at; persist(); log(`[PUSH-KEY] ${short(rec.hash)}: cannot pay the recipient's invoice — LND: ${msgOf(pay)} (the key lacks /routerrpc.Router/SendPaymentV2)`); capability.cross_provider = false; return { ok: false, reason: 'this provider\'s LND key cannot pay invoices (SendPaymentV2) — the operator must re-bake it', code: 'holder_key' }; }
    const paidOk = pay && pay.status === 'SUCCEEDED' && pay.payment_preimage && !/^0+$/.test(String(pay.payment_preimage).replace(/[^0-9a-fA-F]/g, '') || '0');
    if (paidOk) {
      const pre = preHex(pay.payment_preimage);
      rec.fee_spent_msat = Number(pay.fee_msat || (pay.payment_route && pay.payment_route.total_fees_msat) || 0);
      const ok = await settleOuter(rec, pre, `delivery to ${String(pr.destination || '').slice(0, 16)}… (fee ${rec.fee_spent_msat} msat)`);
      return ok ? { ok: true, status: 'taken', mode: 'invoice', fee_spent_msat: rec.fee_spent_msat } : { ok: false, reason: 'outer settle failed — manual attention' };
    }
    if (pay && (pay.status === 'FAILED' || pay.failure_reason)) {
      delete rec.deliver_inflight_at; rec.last_deliver_error = String(pay.failure_reason || 'FAILED'); rec.last_deliver_code = deliverCode(rec.last_deliver_error); persist();
      log(`[PUSH-KEY] ${short(rec.hash)}: delivery FAILED (${rec.last_deliver_error}) — still locked`);
      return { ok: false, reason: 'delivery failed: ' + rec.last_deliver_error, code: rec.last_deliver_code };
    }
    log(`[PUSH-KEY] ${short(rec.hash)}: delivery outran the RPC — LND still owns it; probing`);
    return { ok: false, reason: 'in_flight', in_flight: true };
  }

  // ── the routes ──
  async function handle(req, res, pathname, method, ip, readBody, jsonResponse) {
    if (!pathname.startsWith('/push/')) return false;
    const j = (data, status = 200) => { jsonResponse(res, data, status); return true; };

    if (method === 'GET' && pathname === '/push/quote') {
      // the sender's confirmation reads this before locking: amount + this provider's delivery fee
      const q = new URL(req.url || '', 'http://lsp.local').searchParams;
      const amountSats = Number(q.get('amount_sats'));
      if (!Number.isInteger(amountSats) || amountSats <= 0) return j({ ok: false, error: 'amount_sats required' }, 400);
      const amountMsat = amountSats * 1000; const fee = feeMsat(amountMsat, DEFAULT_WINDOW_S);   // 0.113.0 (3): the default window's hold fee inside
      return j({ ok: true, amount_msat: String(amountMsat), fee_msat: String(fee), total_msat: String(amountMsat + fee), min_sats: MIN_AMOUNT_SATS, max_sats: MAX_AMOUNT_SATS, window_default_s: DEFAULT_WINDOW_S, window_max_s: WINDOW_MAX_S, cltv_expiry: blocksFor(DEFAULT_WINDOW_S), cltv_margin_blocks: CLTV_MARGIN_BLOCKS, hold_fee_ppm_per_day: HOLD_FEE_PPM_PER_DAY, hold_fee_msat: String(holdFeeMsat(amountMsat, DEFAULT_WINDOW_S)), holder: localPubkey(), cross_provider: capability.cross_provider !== false });   // 0.83.1
    }
    if (method === 'GET' && pathname.startsWith('/push/status/')) {
      const hash = pathname.slice('/push/status/'.length).toLowerCase();
      if (!isHex(hash, 64)) return j({ ok: false, error: 'bad hash' }, 400);
      const rec = reg.out[hash];
      if (!rec) return j({ ok: false, error: 'unknown' }, 404);
      return j({ ok: true, status: rec.status, amount_sats: Math.floor(Number(rec.amount_msat) / 1000), fee_sats: Math.ceil(Number(rec.fee_msat) / 1000), expiry: rec.expiry, holder: localPubkey(), locked_at: rec.locked_at || null, taken_at: rec.taken_at || null, ended_at: rec.ended_at || null, end_reason: rec.end_reason || null, last_deliver_code: rec.last_deliver_code || null, last_deliver_error: rec.last_deliver_error || null });
    }
    // 0.85.0: the sealed note — a blob this provider cannot read, handed to whoever holds the key (the token is
    // derived from the preimage; routing nodes know only the hash). Public: the recipient may be on another provider.
    if (method === 'GET' && pathname.startsWith('/push/note/')) {
      if (noteLimited(ip)) return j({ ok: false, error: 'slow down' }, 429);
      const hash = pathname.slice('/push/note/'.length).split('?')[0].toLowerCase();
      if (!isHex(hash, 64)) return j({ ok: false, error: 'bad hash' }, 400);
      const q = new URL(req.url || '', 'http://lsp.local').searchParams;
      const token = String(q.get('token') || '').toLowerCase();
      const rec = reg.out[hash];
      if (!rec || !rec.note_ct) return j({ ok: false, error: 'no note' }, 404);
      if (!isHex(token, 32) || !tokenEq(token, rec.note_token)) return j({ ok: false, error: 'not the key' }, 403);
      return j({ ok: true, note_ct: rec.note_ct });
    }
    // 0.83.0: can this wallet take N sats from this provider right now, and at what fee? The claim sheet
    // asks before the tap; /push/claim asks again before it mints or delivers. The deliverToWallet law.
    if (method === 'GET' && pathname === '/push/receivable') {
      if (!authOk(req)) return j({ ok: false, error: 'auth' }, 401);
      const q = new URL(req.url || '', 'http://lsp.local').searchParams;
      const pk = String(q.get('client_pubkey') || '').toLowerCase();
      const amountSats = Number(q.get('amount_sats'));
      if (!isHex(pk, 66) || !Number.isInteger(amountSats) || amountSats <= 0) return j({ ok: false, error: 'client_pubkey and amount_sats required' }, 400);
      let rx; try { rx = await walletReceivable(pk, amountSats * 1000); } catch (e) { return j({ ok: false, error: 'unavailable' }, 503); }
      return j(Object.assign({ ok: true, can_receive: !!rx.ok, mode: rx.mode || null }, rxFields(rx), { amount_msat: String(amountSats * 1000) }));
    }
    // 0.83.0: the claimant's own provider says what became of its claim — the holder only ever sees LND's one word
    if (method === 'GET' && pathname.startsWith('/push/claim-status/')) {
      if (!authOk(req)) return j({ ok: false, error: 'auth' }, 401);
      const hash = pathname.slice('/push/claim-status/'.length).split('?')[0].toLowerCase();
      if (!isHex(hash, 64)) return j({ ok: false, error: 'bad hash' }, 400);
      const q = new URL(req.url || '', 'http://lsp.local').searchParams;
      const pk = String(q.get('client_pubkey') || '').toLowerCase();
      if (!isHex(pk, 66)) return j({ ok: false, error: 'client_pubkey required' }, 400);
      { const pr = proofOf({ node_pubkey: q.get('node_pubkey') || '', nonce: q.get('nonce') || '', signature: q.get('signature') || '' }, 'push-claim-status', pk, 'claim-status:' + hash + ':' + pk); if (!pr.ok) return j({ ok: false, error: 'auth: ' + pr.code }, pr.status || 401); }   // 0.116.0 (F4)
      const rec = reg.in[hash];
      if (!rec) return j({ ok: false, error: 'unknown' }, 404);
      if (rec.client_pubkey !== pk) return j({ ok: false, error: 'not yours' }, 403);
      return j({ ok: true, status: rec.status, end_reason: rec.end_reason || null, end_code: rec.end_code || null, ended_at: rec.ended_at || null, delivered_msat: rec.delivered_msat || null, open_fee_msat: rec.open_fee_msat || null, expiry: rec.expiry });
    }
    if (method !== 'POST') return j({ ok: false, error: 'method' }, 405);
    let body; try { body = await readBody(req); } catch (e) { return j({ ok: false, error: 'bad json' }, 400); }
    const pk = String(body.client_pubkey || '').toLowerCase();
    const hash = String(body.hash || '').toLowerCase();
    if (!isHex(pk, 66) || !isHex(hash, 64)) return j({ ok: false, error: 'client_pubkey and hash required' }, 400);

    if (pathname === '/push/lock') {
      if (!authOk(req)) return j({ ok: false, error: 'auth' }, 401);
      const amountSats = Number(body.amount_sats);
      const expiry = Number(body.expiry);
      const nowS = Math.floor(now() / 1000);
      if (!Number.isInteger(amountSats) || amountSats < MIN_AMOUNT_SATS || amountSats > MAX_AMOUNT_SATS) return j({ ok: false, error: `amount must be ${MIN_AMOUNT_SATS}–${MAX_AMOUNT_SATS} sats` }, 400);
      if (!Number.isInteger(expiry) || expiry < nowS + WINDOW_MIN_S || expiry > nowS + WINDOW_MAX_S) return j({ ok: false, error: 'the window must end between 10 minutes and 7 days from now' }, 400);
      if (reg.out[hash]) return j({ ok: false, error: 'this hash is already a push here' }, 409);
      // 0.85.0: the sealed note — both fields or neither; the ciphertext is opaque here (base64url, ≤ NOTE_CT_MAX)
      const noteCt = body.note_ct === undefined || body.note_ct === null || body.note_ct === '' ? '' : String(body.note_ct);
      const noteToken = String(body.note_token || '').toLowerCase();
      if (noteCt || noteToken) {
        if (!noteCt || !noteToken) return j({ ok: false, error: 'note_ct and note_token go together' }, 400);
        if (noteCt.length > NOTE_CT_MAX || !/^[A-Za-z0-9_-]+$/.test(noteCt)) return j({ ok: false, error: 'note_ct must be base64url, at most ' + NOTE_CT_MAX + ' chars' }, 400);
        if (!isHex(noteToken, 32)) return j({ ok: false, error: 'note_token must be 32 hex' }, 400);
      }
      const amountMsat = amountSats * 1000;
      const fee = feeMsat(amountMsat, expiry - nowS);   // 0.113.0 (3): the hold fee for this window
      const total = amountMsat + fee;
      const cltv = blocksFor(expiry - nowS);
      let bolt11;
      try { bolt11 = await mintHold({ hashHex: hash, valueMsat: total, cltvExpiry: cltv, memo: 'Lightning in a Jar · Push Key', hints: [] }); }
      catch (e) { log(`[PUSH-KEY] lock mint failed for ${short(hash)}: ${e.message}`); return j({ ok: false, error: 'could not mint the lock' }, 500); }
      reg.out[hash] = { hash, client_pubkey: pk, amount_msat: String(amountMsat), fee_msat: String(fee), total_msat: String(total), expiry, cltv_expiry: cltv, created: now(), status: 'minted' };
      if (noteCt) { reg.out[hash].note_ct = noteCt; reg.out[hash].note_token = noteToken; reg.out[hash].note_at = now(); }   // 0.85.0
      persist(); watchOut(hash); touchWalletActive(pk);
      log(`[PUSH-KEY] ${short(hash)}: lock minted for ${pk.slice(0, 16)}… — ${amountMsat} + fee ${fee} = ${total} msat, cltv ${cltv}, until ${new Date(expiry * 1000).toISOString()}${noteCt ? ', a sealed note (' + noteCt.length + ' chars)' : ''}`);
      return j({ ok: true, bolt11, hash, amount_msat: String(amountMsat), fee_msat: String(fee), total_msat: String(total), expiry, cltv_expiry: cltv, holder: localPubkey(), cross_provider: capability.cross_provider !== false });   // 0.83.1
    }

    if (pathname === '/push/void') {
      const rec = reg.out[hash];
      if (!rec) return j({ ok: false, error: 'unknown' }, 404);
      if (rec.client_pubkey !== pk) return j({ ok: false, error: 'not yours' }, 403);
      const ts = Number(body.ts); const sig = String(body.signature || '').trim();
      if (!Number.isInteger(ts) || Math.abs(Math.floor(now() / 1000) - ts) > 600) return j({ ok: false, error: 'ts out of window' }, 400);
      if (!sig) return j({ ok: false, error: 'signature required' }, 400);
      let recovered = '';
      try {
        const r = await lndPost('/v1/verifymessage', { msg: Buffer.from(VOID_DOMAIN + hash + '|' + ts, 'utf8').toString('base64'), signature: sig });
        if (isPermErr(r)) { log(`[PUSH-KEY] ${short(hash)}: cannot verify the void — LND: ${msgOf(r)} (the key lacks /lnrpc.Lightning/VerifyMessage)`); return j({ ok: false, error: 'holder_key', reason: 'this provider\'s LND key cannot verify signatures (VerifyMessage) — the operator must re-bake it' }, 503); }
        recovered = String((r && r.pubkey) || '').toLowerCase();
        if (!recovered) return j({ ok: false, error: 'verify_unavailable' }, 503);
      } catch (e) { return j({ ok: false, error: 'verify_unavailable' }, 503); }
      if (recovered !== pk) { log(`[PUSH-KEY] ${short(hash)}: BAD void signature from ${ip}`); return j({ ok: false, error: 'bad_signature' }, 401); }
      if (rec.status === 'taken') return j({ ok: false, error: 'already taken', status: rec.status }, 409);
      if (rec.status !== 'locked' && rec.status !== 'minted') return j({ ok: true, status: rec.status });
      if (rec.deliver_inflight_at) return j({ ok: false, error: 'a delivery is in flight — try again in a minute', status: rec.status }, 409);
      await cancelOuter(rec, 'voided by the sender', 'void');
      return j({ ok: true, status: 'void' });
    }

    if (pathname === '/push/claim') {
      if (!authOk(req)) return j({ ok: false, error: 'auth' }, 401);
      const secret = String(body.secret || '').toLowerCase();
      if (!isHex(secret, 64)) return j({ ok: false, error: 'secret required' }, 400);
      // 0.116.0 (S63, Kimi round 2 F4 — DP "Agreed"): the claimant's node key signs the claim — the hash, its own key, the
      // secret's digest and the cross-provider fields; a stranger with the hash cannot claim under a wallet's pubkey
      { const cr = proofOf(body, 'push-claim', pk, 'claim:' + hash + ':' + pk + ':' + sha256Hex(secret) + ':' + (Number.isInteger(Number(body.amount_sats)) && Number(body.amount_sats) > 0 ? String(Number(body.amount_sats)) : '0') + ':' + (Number.isInteger(Number(body.expiry)) && Number(body.expiry) > 0 ? String(Number(body.expiry)) : '0') + ':' + String(body.holder_prefix || '').toLowerCase().slice(0, 16)); if (!cr.ok) { log(`[PUSH-KEY] claim ${short(hash)} by ${pk.slice(0, 16)}… refused: ${cr.code}`); return j({ ok: false, error: 'auth: ' + cr.code }, cr.status || 401); } }
      touchWalletActive(pk);   // proven
      const mine = reg.out[hash];
      if (mine) {
        if (mine.status !== 'locked') return j({ ok: false, error: 'not available', status: mine.status }, 409);
        if (mine.expiry * 1000 <= now()) return j({ ok: false, error: 'expired', status: mine.status }, 409);
        let rx; try { rx = await walletReceivable(pk, Number(mine.amount_msat)); } catch (e) { rx = { ok: true, mode: 'unknown', fee_msat: '0' }; }
        if (!rx.ok) { log(`[PUSH-KEY] ${short(hash)}: claim by ${pk.slice(0, 16)}… on this provider — the wallet cannot take ${mine.amount_msat} msat now (${rx.reason}: fee ${rx.fee_msat}, room ${rx.receivable_msat})`); return j(Object.assign({ ok: false, error: 'cannot_receive' }, rxFields(rx)), 409); }
        const sr = await senderLockRefusal(mine); if (sr) { const st = sr.status; delete sr.status; return j(sr, st); }   // 0.113.0 (5)
        log(`[PUSH-KEY] ${short(hash)}: claim by ${pk.slice(0, 16)}… on this provider — direct delivery (${rx.mode}${rx.mode === 'open' ? ', opening fee ' + rx.fee_msat + ' msat' : ''})`);
        const r = await deliverDirect(mine, pk, secret);
        return j(r, r.ok ? 200 : 409);
      }
      const amountSats = Number(body.amount_sats); const expiry = Number(body.expiry);
      if (!Number.isInteger(amountSats) || amountSats <= 0) return j({ ok: false, error: 'amount_sats required' }, 400);
      if (!Number.isInteger(expiry) || expiry * 1000 <= now()) return j({ ok: false, error: 'expired' }, 409);
      const existing = reg.in[hash];
      if (existing && existing.status === 'settled') return j({ ok: true, mode: 'invoice', status: 'settled' });
      // 0.83.2: what does LND hold for this hash? An invoice minted for an earlier try is reused while it is OPEN or
      // ACCEPTED; an expired/cancelled one means this key can never be claimed on this provider again (LND will not
      // mint the hash twice) — say so, instead of dying at mint.
      let lndInv = null; try { lndInv = await lndGet('/v1/invoice/' + hash); } catch (_) {}
      const lndState = lndInv && lndInv.state && lndInv.payment_request ? lndInv.state : null;
      if (lndState === 'SETTLED') { if (existing) { existing.status = 'settled'; persist(); } return j({ ok: true, mode: 'invoice', status: 'settled' }); }
      if (lndState === 'CANCELED') {
        if (existing && existing.status !== 'burned') { existing.status = 'burned'; existing.end_reason = existing.end_reason || 'claim invoice expired'; existing.end_code = existing.end_code || 'claim_expired'; persist(); }
        log(`[PUSH-KEY] claim ${short(hash)}: ${pk.slice(0, 16)}… asked again but LND holds a CANCELED invoice for the hash — this key cannot be claimed here again`);
        return j({ ok: false, error: 'claim_expired', reason: 'an earlier try of this key on this provider expired; LND will not mint the hash twice — only a new key from the sender can be claimed here' }, 409);
      }
      // 0.116.0 (F6): a second PROVEN claimant replaces an unpaid (reserved, invoice OPEN) claim — a squat holds nothing once
      // the real recipient asks; a claim the holder already paid (ACCEPTED) belongs to its claimant until it ends
      if (existing && lndState === 'OPEN' && existing.bolt11 && existing.client_pubkey !== pk && (existing.status === 'reserved' || existing.status === 'burned')) {
        log(`[PUSH-KEY] claim ${short(hash)}: ${pk.slice(0, 16)}… replaces the unpaid claim of ${existing.client_pubkey.slice(0, 16)}… (the same invoice; the first claimant's record ends)`);
        existing.client_pubkey = pk; existing.secret = secret; existing.holder_prefix = String(body.holder_prefix || '').toLowerCase().slice(0, 16); existing.replaced_at = now(); existing.replaced_from = (existing.replaced_from || 0) + 1;
        delete existing.inner_fails;
      }
      if (existing && lndState === 'ACCEPTED' && existing.client_pubkey !== pk) return j({ ok: false, error: 'claimed', reason: 'another wallet\'s claim of this key is being delivered on this provider', status: existing.status }, 409);
      if (existing && (lndState === 'OPEN' || lndState === 'ACCEPTED') && existing.bolt11 && existing.client_pubkey === pk) {
        if (existing.status === 'burned') { existing.status = lndState === 'ACCEPTED' ? 'accepted' : 'reserved'; delete existing.end_reason; delete existing.end_code; }
        existing.armed_at = now(); delete existing.idle_at; persist(); watchIn(hash);
        log(`[PUSH-KEY] claim ${short(hash)}: ${pk.slice(0, 16)}… asked again — reusing the ${lndState} claim invoice`);
        return j({ ok: true, mode: 'invoice', bolt11: existing.bolt11, holder_prefix: existing.holder_prefix, rx_mode: existing.rx_mode || null, open_fee_msat: existing.open_fee_msat || '0' });
      }
      let rx; try { rx = await walletReceivable(pk, amountSats * 1000); } catch (e) { rx = { ok: true, mode: 'unknown', fee_msat: '0' }; }
      if (rx.ok && rx.mode === 'open' && (claimOpenBlock.get(pk) || 0) > now()) { log(`[PUSH-KEY] claim ${short(hash)}: ${pk.slice(0, 16)}… needs a channel opened but its last claim-open burned — refused for ${Math.ceil((claimOpenBlock.get(pk) - now()) / 3600000)} h more`); return j({ ok: false, error: 'claim_open_blocked', reason: 'this wallet\'s last claim burned after a channel was opened for it — a claim that needs an open waits ' + Math.ceil((claimOpenBlock.get(pk) - now()) / 3600000) + ' h', status: 429 }, 429); }   // 0.116.0 (F6)
      if (!rx.ok) { log(`[PUSH-KEY] claim ${short(hash)}: ${pk.slice(0, 16)}… cannot take ${amountSats} sats now (${rx.reason}: fee ${rx.fee_msat} msat, room ${rx.receivable_msat} msat) — nothing minted`); return j(Object.assign({ ok: false, error: 'cannot_receive' }, rxFields(rx)), 409); }
      let hints = []; try { hints = await buildPublicHints(BigInt(amountSats) * 1000n); } catch (_) {}
      let bolt11;
      const lifeS = Math.min(Math.max(expiry - Math.floor(now() / 1000) + 600, LOCK_INVOICE_LIFE_S), WINDOW_MAX_S + 600);   // 0.83.2: as long as the key
      try { bolt11 = await mintHold({ hashHex: hash, valueMsat: amountSats * 1000, cltvExpiry: 144, memo: 'Lightning in a Jar · Push Key claim', hints, expiryS: lifeS }); }
      catch (e) {
        log(`[PUSH-KEY] claim mint failed for ${short(hash)}: ${e.message}`);
        if (/already exists/i.test(String(e.message))) return j({ ok: false, error: 'claim_expired', reason: 'an earlier try of this key on this provider expired; LND will not mint the hash twice — only a new key from the sender can be claimed here' }, 409);
        return j({ ok: false, error: 'could not mint the claim invoice' }, 500);
      }
      reg.in[hash] = { hash, client_pubkey: pk, secret, amount_msat: String(amountSats * 1000), expiry, holder_prefix: String(body.holder_prefix || '').toLowerCase().slice(0, 16), bolt11, created: now(), armed_at: now(), status: 'reserved', open_fee_msat: String(rx.fee_msat || '0'), rx_mode: rx.mode || null, invoice_life_s: lifeS };
      persist(); watchIn(hash);
      log(`[PUSH-KEY] claim ${short(hash)}: invoice minted for ${pk.slice(0, 16)}… (${amountSats} sats; holder ${String(body.holder_prefix || '?').slice(0, 16)})`);
      return j({ ok: true, mode: 'invoice', bolt11, holder_prefix: reg.in[hash].holder_prefix, rx_mode: rx.mode || null, open_fee_msat: String(rx.fee_msat || '0') });
    }

    if (pathname === '/push/deliver') {
      if (!authOk(req)) return j({ ok: false, error: 'auth' }, 401);
      const rec = reg.out[hash];
      if (!rec) return j({ ok: false, error: 'unknown' }, 404);
      if (rec.status === 'taken') return j({ ok: true, status: 'taken' });
      if (rec.status !== 'locked') return j({ ok: false, error: 'not available', status: rec.status }, 409);
      if (rec.expiry * 1000 <= now()) return j({ ok: false, error: 'expired' }, 409);
      if (rec.deliver_inflight_at) { await probeDelivery(rec); if (rec.status === 'taken') return j({ ok: true, status: 'taken' }); if (rec.deliver_inflight_at) return j({ ok: false, error: 'in_flight' }, 409); }
      const bolt11 = String(body.bolt11 || '').trim();
      if (!bolt11) return j({ ok: false, error: 'bolt11 required' }, 400);
      { const dr = proofOf(body, 'push-deliver', pk, 'deliver:' + hash + ':' + pk + ':' + sha256Hex(bolt11.toLowerCase())); if (!dr.ok) { log(`[PUSH-KEY] ${short(hash)}: delivery ask by ${pk.slice(0, 16)}… refused: ${dr.code}`); return j({ ok: false, error: 'auth: ' + dr.code }, dr.status || 401); } }   // 0.116.0 (F4): the claimant signs the invoice it hands over
      const sr = await senderLockRefusal(rec); if (sr) { const st = sr.status; delete sr.status; return j(sr, st); }   // 0.113.0 (5)
      log(`[PUSH-KEY] ${short(hash)}: delivery asked by ${pk.slice(0, 16)}… — paying the recipient's provider`);
      const r = await deliverByInvoice(rec, bolt11, pk);
      return j(r, r.ok ? 200 : (r.in_flight ? 202 : 409));
    }
    return j({ ok: false, error: 'not found' }, 404);
  }

  function bootResume() {
    probeKey().catch((e) => log(`[PUSH-KEY] key probe failed: ${e.message}`));   // 0.83.1: the holder's key, checked once per boot
    let n = 0;
    for (const rec of Object.values(reg.out)) if (rec.status === 'minted' || rec.status === 'locked' || rec.status === 'settle_pending') { delete rec._delivering; watchOut(rec.hash); if (rec.status === 'locked') armExpiry(rec); n++; }
    for (const rec of Object.values(reg.in)) if (rec.status === 'reserved' || rec.status === 'accepted' || rec.status === 'settle_pending') { delete rec._delivering; watchIn(rec.hash); n++; }   // 0.114.0 (F3)
    if (n) log(`[PUSH-KEY] boot: resumed ${n} watcher(s)`);
    return n;
  }
  function summary() {
    const o = Object.values(reg.out), i = Object.values(reg.in);
    return { locked: o.filter((r) => r.status === 'locked').length, taken: o.filter((r) => r.status === 'taken').length, returned: o.filter((r) => r.status === 'returned' || r.status === 'void').length, claims_open: i.filter((r) => r.status === 'reserved' || r.status === 'accepted').length };
  }
  const settings = () => ({ fee_base_msat: FEE_BASE_MSAT, fee_ppm: FEE_PPM, hold_fee_ppm_per_day: HOLD_FEE_PPM_PER_DAY, cltv_margin_blocks: CLTV_MARGIN_BLOCKS, min_sats: MIN_AMOUNT_SATS, max_sats: MAX_AMOUNT_SATS, window_max_s: WINDOW_MAX_S });
  const capability = { holder: true, claim: true, window_max_s: WINDOW_MAX_S, fee_base_msat: FEE_BASE_MSAT, fee_ppm: FEE_PPM, cross_provider: true, missing_rpcs: [], sealed_note: true };   // 0.83.1: cross_provider set by probeKey at boot; 0.85.0: sealed_note

  return { handle, bootResume, summary, settings, capability, feeMsat, holdFeeMsat, blocksFor, probeKey, pruneNotes, _reg: () => reg, _tickOut: watchOut, _tickIn: watchIn };
}

module.exports = { createPushRail, VOID_DOMAIN };
