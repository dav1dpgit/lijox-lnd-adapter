'use strict';
// jit-funding.js — 0.124.0 (S67, DP 2026-11-04 22:17 "Go on all. Agreed across the board." — WALLET TRUSTS LSP,
// the wallet repo's docs/design/jit-trust/wallet-trusts-lsp-v0.1.md §5): THE HELD OPEN.
// 0.124.1 (S67, the independent review's findings; design round v0.3): the timeout trap closed, the 'abandoning'
// state, a fail-closed abandon, LND's pending list read, orphan leases kept, publishes ahead of the live skip, the
// pre-fund record, a copy per record, tombstones, a revive backstop.
//
// Today a JIT open publishes the channel's funding transaction BEFORE the wallet has claimed the payment (LND's
// OpenChannelSync builds, signs and publishes in one go); when the wallet then refuses, the provider is out the chain
// fee and the capital (Oct 6). This module opens the channel through LND's PSBT funding flow with `no_publish` and
// `skip_finalize`: LND sets NoFundingTxBit and never stores or publishes the transaction (lnwallet/reservation.go
// 400–403, funding/manager.go 758–773 and 2811, v0.20.1-beta); the adapter funds and signs it from LND's own wallet
// (FundPsbt with its own lock id and a 48-hour lease, FinalizePsbt), keeps the signed bytes ON DISK before LND learns
// the txid, and publishes only once the wallet has claimed. Refused → AbandonChannel (i_know_what_i_am_doing — the
// PSBT shim sets no thaw height), ReleaseOutput for every leased coin, and the peer message JitFundingAbandoned
// (32823) so the wallet drops the channel it owns nothing in (LND itself tells a peer nothing about an abandoned
// channel — peer/brontide.go 2178–2194).
//
// WHO GETS IT: a wallet whose init features carry bit 261 (the engine's LIJ_FUNDING_HOLD_FEATURE_BIT, read from
// LND's ListPeers), while the key holds the six RPCs (the boot probe) and LSPS2_FUNDING_HOLD is not off. Everyone else:
// the publish-first open, unchanged. ONE open function for both rails (the interceptor's and the delivery rail's).
//
// THE RECORD (DATA_DIR/jit-held-funding.json, and a copy per record in DATA_DIR/jit-held-funding.d/): lock_id ·
// pending_chan_id · client · size · rail · txid · vout · funding_tx_hex · inputs · state · times · reason. States:
//   funding   — the lease is about to be taken (written BEFORE FundPsbt, so a crash can never leave a lease nobody knows)
//   funded    — signed, on disk; LND told the txid (`verify_sent_at`) or about to be
//   held      — the channel is open in LND, nothing published
//   paid      — the wallet claimed; written BEFORE the payer is settled
//   published / confirmed
//   abandoning — the refusal is being carried out: the payment paths refuse to route over it (isBlocked)
//   abandoned / cancelled / orphan
//
// THE ONE RULE LND IMPOSES (read in v0.20.1-beta, the review of 11-04): once `psbt_verify` has been sent, LND finishes
// the channel ON ITS OWN — the stream's deadline, a dropped connection or a `shim_cancel` stops nothing
// (psbt_assembler.go 293–303 fires the one-shot signal; Cancel 439–446 shares it; the funding manager's zombie
// sweeper never expires PSBT reservations, manager.go 5233–5252). So after that step the coins are NEVER released on a
// timeout: the record waits, and the sweep frees them only on LND's own proof that the channel can never open — the
// wallet peer disconnected (LND cancels the peer's reservations on disconnect, server.go 4616), seen as the peer absent
// from ListPeers or its last_flap_ns after the verify. A channel that appears in LND against a record this adapter had
// closed is RED and revived.
//
// THE SWEEP (boot + every minute) finishes what a crash interrupted: publishes come first, before any skip — 'held'
// with the wallet's balance → publish ('paid' first); 'paid' → publish; 'published' → republish every 10 min until one
// confirmation. Then: 'funding' older than 10 min → its lease released, cancelled; 'funded' with no channel in LND's
// open or pending list → released only by the proof above (or at once when LND was never told the txid); 'held' empty
// and idle for 10 min with no live flow → abandon; 'abandoning' → finished; a channel gone from LND that we did not
// abandon → 'orphan', RED (its lease is KEPT — the channel can come back); strays released.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const btc = require('./btc-tx');

const STATE_FILE = 'jit-held-funding.json';
const COPY_DIR = 'jit-held-funding.d';
const FEATURE_BIT = '261';   // the engine's LIJ_FUNDING_HOLD_FEATURE_BIT (259 is DnsResolver in LDK 0.2's node context)
const REQUIRED_URIS = [
  '/lnrpc.Lightning/OpenChannel', '/lnrpc.Lightning/FundingStateStep',
  '/walletrpc.WalletKit/FundPsbt', '/walletrpc.WalletKit/FinalizePsbt', '/walletrpc.WalletKit/ReleaseOutput', '/walletrpc.WalletKit/ListLeases',
];
const FUNDING_STALE_MS = 10 * 60 * 1000;      // a 'funding' record (the lease taken, nothing signed) nobody finished
const FUNDED_STALE_MS = 10 * 60 * 1000;       // a 'funded' record whose channel LND never listed, LND NOT yet told the txid
const HELD_IDLE_MS = 10 * 60 * 1000;          // a 'held' record no live flow owns any more
const REPUBLISH_MS = 10 * 60 * 1000;          // a published funding not yet in a block is sent again
const WAIT_NOTE_MS = 10 * 60 * 1000;          // how often the sweep says it is still waiting for LND's proof
const KEEP_MS = 14 * 86400 * 1000;            // ended records kept for the console (tombstones are kept for good)
const ABANDON_GRACE_MS = 2000;                // after 'abandoning' is written: a send that picked the channel a moment ago reaches LND

const hexOf = (b) => Buffer.from(b).toString('hex');
const b64 = (b) => Buffer.from(b).toString('base64');
const fromB64 = (s) => Buffer.from(String(s || ''), 'base64');
const short = (s) => String(s || '').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The unsigned transaction inside a PSBT (BIP-174 global key 0x00), as btc-tx's parse gives it. */
function psbtUnsignedTx(psbtBytes) {
  const b = Buffer.from(psbtBytes);
  if (b.length < 6 || b.readUInt32BE(0) !== 0x70736274 || b[4] !== 0xff) throw new Error('not a PSBT');
  let p = 5;
  const rdVar = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } if (f === 0xfe) { const v = b.readUInt32LE(p); p += 4; return v; } const v = Number(b.readBigUInt64LE(p)); p += 8; return v; };
  while (p < b.length) {
    const kl = rdVar(); if (kl === 0) break;   // the global map's separator
    const key = b.slice(p, p + kl); p += kl;
    const vl = rdVar(); const val = b.slice(p, p + vl); p += vl;
    if (key[0] === 0x00) return btc.parse(hexOf(val), { allowWitness: false });   // BIP-174: stored without witness — a 0-input template's "00 01" is not the segwit marker
  }
  throw new Error('PSBT has no unsigned transaction');
}

/** The funding output a PSBT or a final transaction must carry: the P2WSH script of the funding address, the amount. */
function hasFundingOutput(tx, fundingScript, amountSats) {
  return tx.outputs.some((o) => Number(o.value) === Number(amountSats) && Buffer.from(o.script).equals(fundingScript));
}

/** The channel point of an LND pending-open entry (REST /v1/channels/pending: pending_open_channels[].channel.channel_point). */
function pendingPoints(pending) {
  const out = new Set();
  const p = pending || {};
  for (const e of (p.pending_open_channels || [])) { const c = e && e.channel; if (c && c.channel_point) out.add(String(c.channel_point)); }
  return out;
}

/**
 * LND's own proof that a PSBT reservation can never complete: the wallet peer is gone from ListPeers, or it flapped
 * (disconnected and came back) after the verify was sent — LND cancels a peer's reservations when it disconnects
 * (server.go 4616 → funding/manager.go CancelPeerReservations). `peers` is ListPeers' list; `verifySentMs` ms.
 */
function reservationDead(peers, clientHex, verifySentMs) {
  const want = String(clientHex || '').toLowerCase();
  const peer = (peers || []).find((p) => String(p.pub_key || '').toLowerCase() === want);
  if (!peer) return 'the wallet peer is not connected — LND cancelled its reservations at the disconnect';
  const flapNs = Number(peer.last_flap_ns || 0);
  if (flapNs > 0 && Math.floor(flapNs / 1e6) > Number(verifySentMs || 0)) return 'the wallet peer disconnected and came back after the verify — LND cancelled its reservations at the disconnect';
  return null;
}

function createJitFunding(deps) {
  const {
    dataDir = null, log = () => {}, now = () => Date.now(),
    lnd,                     // { openChannelHeld, fundPsbt, finalizePsbt, fundingStep, releaseOutput, listLeases, publishTx, abandonChannel, listChannels, pendingChannels, listPeers, peerFeatures, txConfirmations, probe }
    tellWallet = async () => false,   // (client, txidDisplayHex, vout) → true when the peer message went out
    onOpenUndone = () => {},          // 0.124.2: (rec) a held open ended abandoned/cancelled — the caller takes it off the wallet's fee ladder
    onOpenRestored = () => {},        // 0.124.2: (rec) such a record was revived to a real channel — the caller counts it again
    settings = {},
    hrp = 'bc',
  } = deps || {};
  const enabled = settings.enabled !== false;
  const lockSeconds = Math.max(3600, Number(settings.lock_seconds) || 172800);
  // the fee (DP 2026-11-05 00:01 "Go with polling the correct current fee rate, floored at 1 sat/vB … the dials as
  // variables"): LND's estimate for `target_conf` blocks, floored at `min_sat_per_vb`, capped at `max_sat_per_vb` when
  // that is set; the estimate failing → the floor. One rate for both opens (lij-adapter's publish-first open asks here)
  const feeDials = Object.assign({ target_conf: 144, min_sat_per_vb: 1, max_sat_per_vb: 0 }, settings.fee || {});
  feeDials.target_conf = Math.min(1008, Math.max(1, Math.floor(Number(feeDials.target_conf) || 144)));
  feeDials.min_sat_per_vb = Math.max(1, Math.floor(Number(feeDials.min_sat_per_vb) || 1));
  feeDials.max_sat_per_vb = Math.max(0, Math.floor(Number(feeDials.max_sat_per_vb) || 0));
  // 0.124.2 (DP 2026-11-10, the 11-05 finding seen in every journal — LND's floor estimate of 253 sat/kw, 1.0 sat/vB,
  // went out as 2 sat/vB): THE RATE IS KEPT IN SAT/KW, LND's own unit, with no rounding. 1 sat/vB = 250 sat/kw. The held
  // open hands `kw` to FundPsbt as sat_per_kw (field 11 of FundPsbtRequest at v0.20.1-beta — exact). The publish-first
  // open can only take whole sat/vB (OpenChannelRequest sat_per_vbyte, field 1), so it takes `rate`: the same number
  // rounded to the NEAREST whole sat/vB, never below the floor dial, never above the cap dial.
  // LND refuses anything under its own relay floor, FeePerKwFloor = 253 sat/kw, so `kw` is never below 253.
  const LND_FEE_PER_KW_FLOOR = 253;
  async function feeRate() {
    let estKw = null;
    try {
      if (typeof lnd.estimateFeeSatKw === 'function') estKw = await lnd.estimateFeeSatKw(feeDials.target_conf);
      else if (typeof lnd.estimateFeeSatVb === 'function') { const vb = await lnd.estimateFeeSatVb(feeDials.target_conf); estKw = Number(vb) > 0 ? Number(vb) * 250 : null; }
    } catch (_) { estKw = null; }
    const have = Number.isFinite(Number(estKw)) && Number(estKw) > 0;
    const floorKw = Math.max(LND_FEE_PER_KW_FLOOR, feeDials.min_sat_per_vb * 250);
    const capKw = feeDials.max_sat_per_vb > 0 ? Math.max(floorKw, feeDials.max_sat_per_vb * 250) : 0;
    let kw = have ? Math.ceil(Number(estKw)) : floorKw;   // a whole sat/kw; an estimate with a fraction of one sat/kw goes up by that fraction only
    if (kw < floorKw) kw = floorKw;
    if (capKw > 0 && kw > capKw) kw = capKw;
    let rate = Math.round(kw * 4 / 1000);   // the nearest whole sat/vB — for the publish-first open and nothing else
    if (rate < feeDials.min_sat_per_vb) rate = feeDials.min_sat_per_vb;
    if (feeDials.max_sat_per_vb > 0 && rate > feeDials.max_sat_per_vb) rate = feeDials.max_sat_per_vb;
    const vb = kw * 4 / 1000;
    return { kw, vb, rate, source: have ? `LND's ${feeDials.target_conf}-block estimate ${Math.round(Number(estKw))} sat/kw = ${(Number(estKw) * 4 / 1000).toFixed(2)} sat/vB` : 'no estimate from LND — the floor', estimate: have ? Number(estKw) * 4 / 1000 : null, estimate_kw: have ? Number(estKw) : null };
  }
  const openTimeoutMs = Math.max(5000, Number(settings.open_timeout_ms) || 25000);
  const abandonGraceMs = settings.abandon_grace_ms == null ? ABANDON_GRACE_MS : Math.max(0, Number(settings.abandon_grace_ms) || 0);
  const FILE = dataDir ? path.join(dataDir, STATE_FILE) : null;
  const COPIES = dataDir ? path.join(dataDir, COPY_DIR) : null;
  let st = { records: {}, tombstones: {} };   // cp → record (cp = "txid:vout", display hex; a 'funding' record is keyed "pre:<lock_id>")
  const capability = { enabled, key_ok: false, missing_rpcs: [], probed_at: 0 };
  const live = new Set();     // channel points a flow is working on right now (the sweep leaves them alone — ten minutes at most)
  let lastSweep = 0;
  let loadFailed = '';

  const copyPath = (rec) => (COPIES && rec && rec.txid != null ? path.join(COPIES, `${rec.txid}-${rec.vout}.json`) : null);
  function writeCopy(rec) {
    const p = copyPath(rec); if (!p) return;
    try { fs.mkdirSync(COPIES, { recursive: true }); const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, p); }
    catch (e) { log(`[JIT-HOLD] record copy ${path.basename(p)} not written: ${e.message}`); }
  }
  function load() {
    if (!FILE) return;
    try {
      if (fs.existsSync(FILE)) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && j.records) st = Object.assign({ records: {}, tombstones: {} }, j); }
    } catch (e) {
      loadFailed = String(e.message || e);
      log(`[JIT-HOLD] MANUAL ATTENTION: the state file ${FILE} is unreadable (${loadFailed}) — rebuilding the records from the copies in ${COPY_DIR}/; the sweep reads LND for each`);
    }
    // the copies: anything the main file lost (a corrupt file, a restore from an older backup) comes back from here
    if (COPIES && fs.existsSync(COPIES)) {
      let recovered = 0;
      for (const f of fs.readdirSync(COPIES)) {
        if (!f.endsWith('.json')) continue;
        try {
          const r = JSON.parse(fs.readFileSync(path.join(COPIES, f), 'utf8'));
          if (r && r.cp && !st.records[r.cp]) { st.records[r.cp] = r; recovered++; }
        } catch (_) {}
      }
      if (recovered) log(`[JIT-HOLD] ${recovered} record(s) recovered from ${COPY_DIR}/ that the state file did not carry`);
    }
    if (!st.tombstones) st.tombstones = {};
  }
  function persist() {
    if (!FILE) return;
    try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, FILE); }
    catch (e) { log(`[JIT-HOLD] state write failed: ${e.message}`); }
  }
  load();

  const recOf = (cp) => st.records[String(cp || '')] || null;
  function setState(rec, state, extra) {
    const was = rec.state;
    rec.state = state; rec.updated = now();
    if (extra) Object.assign(rec, extra);
    // 0.124.2 (DP 2026-11-10 "keep refused opens off the fee ladder"): an open that ended with its funding never
    // published was not an open the wallet got — the adapter takes its stamp off that wallet's fee ladder, once
    // (ladder_off, on the record); a record revived to a real channel puts it back, once. Only an open the caller
    // said it counted (noteLadder → ladder_ts, the exact stamp) is ever taken off — never another open's stamp.
    try {
      if ((state === 'abandoned' || state === 'cancelled') && rec.client && rec.ladder_ts && !rec.ladder_off) { rec.ladder_off = true; onOpenUndone(rec); }
      else if (rec.ladder_off && (was === 'abandoned' || was === 'cancelled') && !(state === 'abandoned' || state === 'cancelled')) { rec.ladder_off = false; onOpenRestored(rec); }
    } catch (_) {}
    if (state === 'abandoned' && rec.cp && rec.txid) st.tombstones[rec.cp] = { client: rec.client, abandoned_at: rec.abandoned_at || now(), reason: rec.reason || '' };
    persist();
    if (rec.funding_tx_hex) writeCopy(rec);
  }
  const ENDED = new Set(['confirmed', 'abandoned', 'cancelled']);
  const LIVE_STATES = new Set(['funding', 'funded', 'held', 'paid', 'published', 'abandoning', 'orphan']);   // a lease these hold is OURS
  function prune() {
    const cut = now() - KEEP_MS;
    let removed = 0;
    for (const [cp, r] of Object.entries(st.records)) {
      if (!ENDED.has(r.state) || (r.updated || r.at) >= cut) continue;
      delete st.records[cp]; removed++;
      const p = copyPath(r); if (p) { try { fs.unlinkSync(p); } catch (_) {} }
    }
    if (removed) persist();
  }

  // ── the key probe (boot) ────────────────────────────────────────────────────────────────────────────────────────
  async function boot() {
    if (!enabled) { log('[JIT-HOLD] funding hold OFF (LSPS2_FUNDING_HOLD=false) — every JIT open publishes first, as before'); return capability; }
    let missing = [];
    try { missing = await lnd.probe(); } catch (e) { missing = ['probe failed: ' + e.message]; }
    capability.key_ok = missing.length === 0; capability.missing_rpcs = missing; capability.probed_at = now();
    if (missing.length) log(`[JIT-HOLD] key probe: this provider CANNOT hold funding — the macaroon lacks ${missing.join(', ')}; every JIT open publishes first until the key is re-baked (MACAROON.md, 0.124.0)`);
    else log(`[JIT-HOLD] key probe: this provider can hold a JIT channel's funding until the wallet has claimed (wallets with feature bit ${FEATURE_BIT}); lease ${Math.round(lockSeconds / 3600)} h; the funding fee is LND's ${feeDials.target_conf}-block estimate, floor ${feeDials.min_sat_per_vb} sat/vB${feeDials.max_sat_per_vb ? ', cap ' + feeDials.max_sat_per_vb : ''}`);
    const n = Object.values(st.records).filter((r) => !ENDED.has(r.state)).length;
    if (n) log(`[JIT-HOLD] ${n} open record(s) from before the restart — the sweep reads LND for each`);
    return capability;
  }

  /** Does this wallet get the held open right now? (enabled, the key, and the wallet's bit) */
  async function canHold(client) {
    if (!enabled || !capability.key_ok) return false;
    try {
      const feats = await lnd.peerFeatures(client);
      return !!(feats && (feats.has ? feats.has(FEATURE_BIT) : Array.isArray(feats) && feats.includes(FEATURE_BIT)));
    } catch (_) { return false; }
  }

  /** The payment paths ask before routing over a channel: a channel being abandoned takes nothing. */
  function isBlocked(cp) { const r = recOf(cp); return !!(r && r.state === 'abandoning'); }

  // ── the held open ───────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * Open a zero-conf channel whose funding stays unpublished. `params` are LND's OpenChannelRequest fields minus the
   * fee (node_pubkey bytes, local_funding_amount, private, zero_conf, scid_alias, commitment_type,
   * remote_chan_reserve_sat, the fee-policy fields). Resolves { channel_point: { funding_txid_bytes, output_index },
   * cp, rec } once LND reports chan_pending; the channel is open (zero-conf) a moment later. Throws after cleaning up
   * (the shim cancelled, the coins released) when the open did not reach the verify step — and WITHOUT releasing when
   * it did (LND may still finish the channel; the sweep decides on LND's proof).
   */
  async function open({ client, sizeSats, params, rail, tag }) {
    const pendingChanId = crypto.randomBytes(32);
    const lockId = crypto.randomBytes(32);
    const T = tag || 'JIT-HOLD';
    const clientHex = String(client).toLowerCase();
    // the pre-fund record: the lease about to be taken is on disk before FundPsbt runs — a crash right after it leaves
    // a lease the sweep knows and releases (10 min); nothing is signed yet
    const preKey = 'pre:' + hexOf(lockId);
    st.records[preKey] = { cp: preKey, lock_id: hexOf(lockId), pending_chan_id: hexOf(pendingChanId), client: clientHex, size_sats: Number(sizeSats), rail: String(rail || ''), state: 'funding', at: now(), updated: now(), reason: '' };
    persist();
    let rec = null;            // written at step 5, before LND learns the txid
    let fundedInputs = [];     // released on any failure before the verify
    let fundedOnce = false;
    let verifySent = false;    // from here LND finishes the channel by itself — nothing is released on a timeout
    const dropPre = () => { if (st.records[preKey]) { delete st.records[preKey]; persist(); } };
    const releaseAll = async (why) => {
      for (const i of fundedInputs) {
        try { await lnd.releaseOutput({ id: b64(lockId), outpoint: { txid_str: i.txid, output_index: i.vout } }); }
        catch (e) { log(`[${T}] release of ${short(i.txid)}:${i.vout} failed (${e.message}) — the lease ends by itself in ${Math.round(lockSeconds / 3600)} h`); }
      }
      if (fundedInputs.length) log(`[${T}] ${fundedInputs.length} coin(s) released (${why})`);
    };
    const onPsbtFund = async (upd) => {
      // 3. the funding output LND wants: check the amount and that the PSBT's one output is it
      const amount = Number(upd.funding_amount);
      if (amount !== Number(sizeSats)) throw new Error(`LND asks ${amount} sats for the funding, the open was for ${sizeSats}`);
      const fundingScript = btc.addressToScript(String(upd.funding_address), hrp);
      const template = Buffer.isBuffer(upd.psbt) ? upd.psbt : Buffer.from(upd.psbt || [], 'base64');
      const tpl = psbtUnsignedTx(template);
      if (tpl.outputs.length !== 1 || !hasFundingOutput(tpl, fundingScript, amount)) throw new Error('the PSBT LND handed does not carry exactly the funding output');
      // 4. fund it from LND's wallet — the coins leased under OUR id for the hold's whole life; the fee polled now
      const fee = await feeRate();
      log(`[${T}] funding fee ${fee.kw} sat/kw = ${fee.vb.toFixed(2)} sat/vB, given to LND in sat/kw (${fee.source})`);
      const funded = await lnd.fundPsbt({ psbt: b64(template), sat_per_kw: String(fee.kw), min_confs: 1, custom_lock_id: b64(lockId), lock_expiration_seconds: String(lockSeconds) });
      if (!funded || !funded.funded_psbt) throw new Error('FundPsbt answered no PSBT: ' + JSON.stringify(funded).slice(0, 200));
      fundedOnce = true;
      fundedInputs = (funded.locked_utxos || []).map((u) => ({ txid: String((u.outpoint && (u.outpoint.txid_str || (u.outpoint.txid_bytes && hexOf(fromB64(u.outpoint.txid_bytes).reverse())))) || ''), vout: Number(u.outpoint && u.outpoint.output_index) || 0 }));
      if (st.records[preKey]) { st.records[preKey].inputs = fundedInputs.map((i) => ({ txid: i.txid, vout: i.vout })); st.records[preKey].updated = now(); persist(); }
      const fundedTx = psbtUnsignedTx(fromB64(funded.funded_psbt));
      if (!hasFundingOutput(fundedTx, fundingScript, amount)) throw new Error('the funded PSBT lost the funding output');
      if (fundedTx.inputs.length === 0) throw new Error('the funded PSBT has no inputs');
      // 5. sign it — nothing is published by this; the txid is fixed from here (every input SegWit)
      const fin = await lnd.finalizePsbt({ funded_psbt: funded.funded_psbt });
      if (!fin || !fin.raw_final_tx) throw new Error('FinalizePsbt answered no transaction: ' + JSON.stringify(fin).slice(0, 200));
      const finalHex = hexOf(fromB64(fin.raw_final_tx));
      const finalTx = btc.parse(finalHex);
      const txid = btc.txid(finalTx);
      if (txid !== btc.txid(fundedTx)) throw new Error(`the signed transaction's txid ${txid} differs from the funded PSBT's ${btc.txid(fundedTx)}`);
      if (!finalTx.inputs.every((i) => i.witness && i.witness.length)) throw new Error('the signed transaction has an unsigned input');
      const vout = finalTx.outputs.findIndex((o) => Number(o.value) === amount && Buffer.from(o.script).equals(fundingScript));
      // THE RECORD, before LND learns the txid: a crash from here on finds it on disk (and its copy)
      rec = { cp: `${txid}:${vout}`, lock_id: hexOf(lockId), pending_chan_id: hexOf(pendingChanId), client: clientHex, size_sats: amount, rail: String(rail || ''),
              txid, vout, funding_tx_hex: finalHex, inputs: fundedInputs.map((i) => ({ txid: i.txid, vout: i.vout })), fee_sat_per_vb: fee.vb, fee_sat_per_kw: fee.kw, fee_source: fee.source,
              state: 'funded', at: now(), updated: now(), reason: '', verify_sent_at: 0 };
      delete st.records[preKey];
      st.records[rec.cp] = rec; live.add(rec.cp); persist(); writeCopy(rec);
      log(`[${T}] funding ${short(txid)}:${vout} for ${sizeSats} sats to ${short(client)}… signed and kept on disk (${fundedInputs.length} coin(s) leased ${Math.round(lockSeconds / 3600)} h) — LND is told the txid now; nothing is published`);
      // 6. LND goes on with funding_created on the unsigned PSBT's txid — the same txid. From this line LND finishes
      //    the channel on its own; the stamp is written BEFORE the call (a crash during it counts as sent)
      rec.verify_sent_at = now(); verifySent = true; persist(); writeCopy(rec);
      await lnd.fundingStep({ psbt_verify: { funded_psbt: funded.funded_psbt, pending_chan_id: b64(pendingChanId), skip_finalize: true } });
      return { txid, vout };
    };
    let channelPoint;
    try {
      channelPoint = await lnd.openChannelHeld(Object.assign({}, params, { funding_shim: { psbt_shim: { pending_chan_id: pendingChanId, no_publish: true } } }), { onPsbtFund, timeoutMs: openTimeoutMs });
    } catch (e) {
      if (verifySent && rec) {
        // LND may still finish this channel (the wallet answering late, our connection gone): the coins stay leased, the
        // record stays 'funded', and the sweep frees them only on LND's proof — or lists the channel and carries on
        live.delete(rec.cp);
        rec.open_error = String(e.message || e).slice(0, 160); rec.updated = now(); persist(); writeCopy(rec);
        log(`[${T}] the open did not report chan_pending (${e.message}) AFTER LND was told the txid — LND may still open channel ${short(rec.txid)}:${rec.vout}; nothing released, the sweep decides on LND's proof`);
        throw e;
      }
      // the open did not reach the verify: cancel the shim (LND's funding flow fails on it), release the coins
      try { await lnd.fundingStep({ shim_cancel: { pending_chan_id: b64(pendingChanId) } }); } catch (_) {}
      if (fundedOnce) await releaseAll('open failed: ' + e.message);
      if (rec) { setState(rec, 'cancelled', { reason: 'open failed: ' + String(e.message || e).slice(0, 160) }); live.delete(rec.cp); }
      dropPre();
      throw e;
    }
    // 7. chan_pending: the channel exists in LND (zero-conf: open a moment later), its funding unpublished
    const txidHex = hexOf(Buffer.from(channelPoint.funding_txid_bytes).reverse());
    const cp = `${txidHex}:${channelPoint.output_index}`;
    if (!rec || rec.cp !== cp) {
      // LND named a different outpoint than the transaction we signed — nothing we hold can fund that channel. The coins
      // are released only once LND has let the channel go (the abandon succeeded); otherwise they stay leased, RED
      log(`[${T}] MANUAL ATTENTION: LND reports channel point ${cp} but the signed funding is ${rec ? rec.cp : 'none'} — ABANDONING the channel`);
      let gone = false;
      try { const r = await lnd.abandonChannel(txidHex, Number(channelPoint.output_index)); gone = !!(r && r.ok !== false); } catch (_) {}
      if (gone) await releaseAll('channel point mismatch'); else log(`[${T}] MANUAL ATTENTION: AbandonChannel ${cp} failed — the coins stay leased; a channel this adapter cannot fund is in LND`);
      if (rec) { setState(rec, gone ? 'cancelled' : 'orphan', { reason: 'channel point mismatch: LND ' + cp }); live.delete(rec.cp); }
      dropPre();
      throw new Error('funding outpoint mismatch');
    }
    setState(rec, 'held');
    log(`[${T}] channel ${short(txidHex)}:${channelPoint.output_index} is open with its funding HELD — published only when the wallet has claimed`);
    return { channel_point: channelPoint, cp, rec };
  }

  // ── the outcomes ────────────────────────────────────────────────────────────────────────────────────────────────
  /**
   * The wallet claimed: written before the payer is settled — a crash after this line publishes at the next start.
   * Returns the record when it moved to 'paid' (from any unpublished state — an ended record is RED, the claim rules);
   * null when there is nothing to move (no record, or already paid/published/confirmed).
   */
  function markPaid(cp, extra) {
    const rec = recOf(cp); if (!rec || !rec.funding_tx_hex) return null;
    if (rec.state === 'paid' || rec.state === 'published' || rec.state === 'confirmed') return null;
    if (ENDED.has(rec.state) || rec.state === 'orphan') log(`[JIT-HOLD] MANUAL ATTENTION: the wallet claimed over channel ${short(rec.txid)}:${rec.vout} whose record was ${rec.state} — publishing the kept funding anyway (its coins may have been released; if the publish fails the provider owes the wallet ${rec.size_sats} sats of channel)`);
    const from = rec.state;
    setState(rec, 'paid', Object.assign({ paid_at: now(), paid_from: from }, extra || {}));
    // 0.124.2 (DP 2026-11-10): the order is in the journal — 'paid' is on disk BEFORE the payer is settled; the publish follows
    log(`[JIT-HOLD] PAID written for ${short(rec.txid)}:${rec.vout} (was ${from}) — on disk before the payer is settled; the publish follows`);
    return rec;
  }
  /** 0.124.2: the caller counted this open on the wallet's fee ladder with this stamp (ms) — kept on the record. */
  function noteLadder(cp, ts) {
    const rec = recOf(cp); if (!rec || !Number.isFinite(Number(ts)) || Number(ts) <= 0) return false;
    rec.ladder_ts = Number(ts); rec.ladder_off = false; persist(); return true;
  }
  /** Publish the kept funding transaction (idempotent: a transaction LND already knows answers OK). */
  async function publish(cp, why) {
    const rec = recOf(cp); if (!rec) return { ok: false, error: 'no record' };
    if (!rec.funding_tx_hex) return { ok: false, error: 'no signed transaction kept' };
    if (rec.state === 'confirmed') return { ok: false, error: 'record is confirmed' };
    if (rec.state !== 'paid' && rec.state !== 'published') {
      // only a claim publishes — the callers go through markPaid; a stray call on an unclaimed record is refused
      return { ok: false, error: 'record is ' + rec.state + ' — not claimed' };
    }
    try {
      const r = await lnd.publishTx(rec.funding_tx_hex);
      const err = r && (r.publish_error || (r.message && !/already|exists|duplicate/i.test(r.message) ? r.message : ''));
      if (err && !/already|exists|duplicate/i.test(String(err))) throw new Error(String(err));
      const first = rec.state !== 'published';
      setState(rec, 'published', { published_at: rec.published_at || now(), republished: first ? 0 : (rec.republished || 0) + 1, last_publish_at: now(), publish_error: '' });
      log(`[JIT-HOLD] funding ${short(rec.txid)}:${rec.vout} PUBLISHED${first ? '' : ' again (' + rec.republished + ')'} for ${short(rec.client)}… (${why || 'the wallet claimed'})`);
      live.delete(cp);
      return { ok: true, rec };
    } catch (e) {
      log(`[JIT-HOLD] MANUAL ATTENTION: funding ${short(rec.txid)}:${rec.vout} publish FAILED: ${e.message} — the sweep tries again every minute; the wallet was paid (${rec.size_sats} sats of channel owed if this never goes through)`);
      rec.publish_error = String(e.message || e).slice(0, 200); rec.updated = now(); persist();
      return { ok: false, error: e.message };
    }
  }
  /** Release every coin of a record's lease (each failure logged; the lease ends by itself otherwise). */
  async function releaseInputs(rec) {
    for (const i of rec.inputs || []) {
      try { await lnd.releaseOutput({ id: b64(Buffer.from(rec.lock_id, 'hex')), outpoint: { txid_str: i.txid, output_index: i.vout } }); }
      catch (e) { log(`[JIT-HOLD] release of ${short(i.txid)}:${i.vout} failed (${e.message}) — the lease ends by itself`); }
    }
  }
  /** The last steps of an abandon once LND has let the channel go: the coins back, the wallet told, 'abandoned'. */
  async function finishAbandon(rec, reason) {
    await releaseInputs(rec);
    let told = false;
    try { told = await tellWallet(rec.client, rec.txid, rec.vout); } catch (e) { log(`[JIT-HOLD] could not tell ${short(rec.client)}… (${e.message}) — its own audit asks this provider later`); }
    setState(rec, 'abandoned', { reason: String(reason || rec.reason || '').slice(0, 160), abandoned_at: now(), wallet_told: told });
    live.delete(rec.cp);
    log(`[JIT-HOLD] channel ${short(rec.txid)}:${rec.vout} ABANDONED (${reason || rec.reason || 'the payment failed'}) — nothing was published, ${(rec.inputs || []).length} coin(s) released, the wallet ${told ? 'told' : 'NOT told (it asks later)'}`);
  }
  /**
   * The payment was refused: abandon the channel in LND, release the coins, tell the wallet. FAIL-CLOSED: the record
   * goes to 'abandoning' first (the payment paths refuse the channel from that moment), a grace lets a send that picked
   * it a moment ago reach LND, then LND is read — sats on the wallet's side → paid and published instead; an HTLC
   * pending → back to 'held', the sweep decides; LND unreadable → back to 'held', the sweep retries. Only a channel
   * just read EMPTY is abandoned.
   */
  async function abandon(cp, reason) {
    const rec = recOf(cp); if (!rec) return { ok: false, error: 'no record' };
    if (rec.state === 'paid' || rec.state === 'published' || rec.state === 'confirmed') return { ok: false, error: 'the wallet was paid — never abandoned' };
    if (rec.state !== 'held' && rec.state !== 'abandoning') return { ok: false, error: 'record is ' + rec.state + ' — only a held channel is abandoned' };
    const why = String(reason || rec.reason || '').slice(0, 160);
    setState(rec, 'abandoning', { reason: why });
    if (abandonGraceMs) await sleep(abandonGraceMs);
    let c = null;
    try { c = (await lnd.listChannels()).find((x) => String(x.channel_point || '') === rec.cp) || null; }
    catch (e) {
      setState(rec, 'held', { abandon_error: 'LND not read: ' + String(e.message || e).slice(0, 160) });
      log(`[JIT-HOLD] channel ${short(rec.txid)}:${rec.vout}: LND not read before the abandon (${e.message}) — NOT abandoned; the sweep retries`);
      return { ok: false, error: 'LND not read — the sweep retries' };
    }
    if (!c) {
      // the channel is not in LND's open list: pending still, or gone by someone else's hand — never ours to abandon here
      let pend = null;
      try { pend = pendingPoints(await lnd.pendingChannels()); } catch (_) {}
      if (pend && pend.has(rec.cp)) { setState(rec, 'held', { abandon_error: 'the channel is still pending in LND' }); return { ok: false, error: 'the channel is pending in LND — the sweep retries' }; }
      setState(rec, 'orphan', { reason: 'the channel left LND without this adapter abandoning it' });
      log(`[JIT-HOLD] MANUAL ATTENTION: ORPHAN — channel ${rec.cp} is gone from LND and this adapter did not abandon it (if the wallet had claimed, the provider owes it ${rec.size_sats} sats of channel); its lease is kept`);
      return { ok: false, error: 'the channel is gone from LND — orphan' };
    }
    const remote = Number(c.remote_balance || 0), htlcs = Array.isArray(c.pending_htlcs) ? c.pending_htlcs.length : 0;
    if (remote > 0) {
      setState(rec, 'held');
      markPaid(cp, { paid_seen: 'abandon refused: remote balance ' + remote });
      await publish(cp, 'the wallet holds ' + remote + ' sats — the verdict said failed, LND says claimed');
      return { ok: false, error: 'the wallet holds sats in the channel — published instead' };
    }
    if (htlcs > 0) {
      setState(rec, 'held');
      log(`[JIT-HOLD] channel ${short(rec.txid)}:${rec.vout}: ${htlcs} HTLC(s) still pending — not abandoned yet (${why}); the sweep decides once they resolve`);
      return { ok: false, error: 'an HTLC is still pending' };
    }
    try { const r = await lnd.abandonChannel(rec.txid, rec.vout); if (!(r && r.ok !== false)) throw new Error((r && r.error) || 'abandon refused'); }
    catch (e) {
      setState(rec, 'held', { abandon_error: String(e.message || e).slice(0, 200) });
      log(`[JIT-HOLD] AbandonChannel ${short(rec.txid)}:${rec.vout} failed: ${e.message} — the sweep tries again`);
      return { ok: false, error: e.message };
    }
    await finishAbandon(rec, why);
    return { ok: true, rec };
  }

  // ── the sweep ───────────────────────────────────────────────────────────────────────────────────────────────────
  async function sweep(force) {
    if (!force && now() - lastSweep < 60000) return null;
    lastSweep = now();
    prune();
    const all = Object.values(st.records);
    const openRecs = all.filter((r) => !ENDED.has(r.state));
    let chans = null;
    try { chans = await lnd.listChannels(); } catch (e) { log(`[JIT-HOLD] sweep: LND's channel list not read (${e.message}) — nothing decided this round`); return { swept: 0 }; }
    const byCp = new Map((chans || []).map((c) => [String(c.channel_point || ''), c]));
    let pending = null;   // read only when a record needs it
    const pendingSet = async () => { if (pending) return pending; try { pending = pendingPoints(await lnd.pendingChannels()); } catch (_) { pending = new Set(); pending.unreadable = true; } return pending; };
    let acted = 0;
    // (0) the revive backstop: a channel LND lists against a record this adapter had closed — the record was wrong,
    //     the channel is real; RED, back to 'held' (its coins may have been released: a publish then tells)
    for (const rec of all) {
      if (!rec.txid || !byCp.has(rec.cp)) continue;
      if (rec.state === 'cancelled' || rec.state === 'abandoned') {
        log(`[JIT-HOLD] MANUAL ATTENTION: LND lists channel ${rec.cp} whose record was ${rec.state} — revived to held (if its coins were released the publish may fail; the wallet ${rec.state === 'abandoned' ? 'was told it is gone — it keeps nothing of it' : 'was never told anything'})`);
        delete st.tombstones[rec.cp];
        setState(rec, 'held', { revived_from: rec.state, reason: 'revived: LND lists the channel' }); acted++;
      }
    }
    for (const rec of openRecs) {
      const c = byCp.get(rec.cp);
      const age = now() - (rec.updated || rec.at);
      // (1) publishes first — a claim is never made to wait on the live skip
      if (rec.state === 'paid') { await publish(rec.cp, 'paid before a restart'); acted++; continue; }
      if (rec.state === 'published') {
        let confs = 0;
        try { confs = await lnd.txConfirmations(rec.txid); } catch (_) { confs = 0; }
        if (confs >= 1) { setState(rec, 'confirmed', { confirmed_at: now(), confirmations: confs }); acted++; log(`[JIT-HOLD] funding ${short(rec.txid)}:${rec.vout} is in a block (${confs} conf) — done`); continue; }
        if (now() - (rec.last_publish_at || rec.published_at || 0) >= REPUBLISH_MS) { await publish(rec.cp, 'not yet in a block'); acted++; }
        continue;
      }
      if ((rec.state === 'held' || rec.state === 'abandoning' || rec.state === 'orphan' || rec.state === 'funded') && c) {
        const remote = Number(c.remote_balance || 0);
        if (remote > 0) { markPaid(rec.cp, { paid_seen: 'sweep: remote balance ' + remote }); await publish(rec.cp, 'the wallet holds ' + remote + ' sats in it'); acted++; continue; }
      }
      // (2) the pre-fund record: a lease taken and never carried on — released after 10 min (the stray scan below
      //     releases by id; this closes the record)
      if (rec.state === 'funding') {
        if (age >= FUNDING_STALE_MS) { await releaseInputs(rec); setState(rec, 'cancelled', { reason: 'the lease was taken and nothing followed' }); acted++; log(`[JIT-HOLD] sweep: a lease taken ${Math.round(age / 60000)} min ago for ${short(rec.client)}… was never carried on — released, record closed`); }
        continue;
      }
      if (live.has(rec.cp) && age < HELD_IDLE_MS) continue;   // a flow owns it — for ten minutes at most
      if (rec.state === 'funded') {
        if (c) { setState(rec, 'held'); acted++; log(`[JIT-HOLD] sweep: channel ${rec.cp} is listed — the open landed after the flow lost it; held`); continue; }
        const pend = await pendingSet();
        if (pend.has(rec.cp)) { continue; }   // in LND's pending list — it is coming
        if (!rec.verify_sent_at) {
          // LND was never told the txid: the shim cancel fails LND's flow for good; the coins come back
          if (age >= FUNDED_STALE_MS) {
            try { await lnd.fundingStep({ shim_cancel: { pending_chan_id: b64(Buffer.from(rec.pending_chan_id, 'hex')) } }); } catch (_) {}
            await releaseInputs(rec);
            setState(rec, 'cancelled', { reason: 'no channel in LND 10 min after signing; LND was never told the txid' }); acted++;
            log(`[JIT-HOLD] sweep: funding ${short(rec.txid)}:${rec.vout} signed but LND was never told and never listed the channel — coins released, record closed`);
          }
          continue;
        }
        // LND WAS told: only LND's proof frees the coins
        if (pend.unreadable) continue;
        let peers = null;
        try { peers = await lnd.listPeers(); } catch (_) { continue; }
        const proof = reservationDead(peers, rec.client, rec.verify_sent_at);
        if (proof) {
          await releaseInputs(rec);
          setState(rec, 'cancelled', { reason: 'no channel in LND; ' + proof }); acted++;
          log(`[JIT-HOLD] sweep: funding ${short(rec.txid)}:${rec.vout} — LND was told the txid but never listed the channel, and ${proof}; coins released, record closed`);
        } else if (now() - (rec.wait_noted_at || 0) >= WAIT_NOTE_MS) {
          rec.wait_noted_at = now(); persist();
          log(`[JIT-HOLD] sweep: funding ${short(rec.txid)}:${rec.vout} — LND was told the txid ${Math.round((now() - rec.verify_sent_at) / 60000)} min ago and lists no channel; the wallet peer has stayed connected, so LND may still finish it — coins stay leased until LND's proof (a disconnect) or the lease ends`);
        }
        continue;
      }
      if (rec.state === 'abandoning') {
        // a crash inside abandon(): LND still has the channel → it is 'held' again (idle → abandoned below); gone → finish
        if (c) { setState(rec, 'held'); acted++; }
        else { const pend = await pendingSet(); if (pend.has(rec.cp)) { setState(rec, 'held'); continue; } await finishAbandon(rec, rec.reason || 'finished after a restart'); acted++; continue; }
      }
      if (rec.state === 'held') {
        if (!c) {
          const pend = await pendingSet();
          if (pend.has(rec.cp) || pend.unreadable) continue;
          setState(rec, 'orphan', { reason: 'the channel left LND without this adapter abandoning it' }); acted++;
          log(`[JIT-HOLD] MANUAL ATTENTION: ORPHAN — channel ${rec.cp} is gone from LND and this adapter did not abandon it (if the wallet had claimed, the provider owes it ${rec.size_sats} sats of channel); its lease is kept`);
          continue;
        }
        const htlcs = Array.isArray(c.pending_htlcs) ? c.pending_htlcs.length : 0;
        if (htlcs > 0) continue;   // in flight — the probe's domain
        if (age >= HELD_IDLE_MS) { await abandon(rec.cp, 'sweep: empty and idle 10 min'); acted++; }
        continue;
      }
      if (rec.state === 'orphan' && c) { setState(rec, 'held', { reason: '' }); acted++; }   // it came back (LND restarted mid-list)
    }
    // strays: leases under one of our ids whose record is not live any more (an orphan's lease is KEPT — it can come back)
    try {
      const leases = await lnd.listLeases();
      const byLock = new Map(Object.values(st.records).map((r) => [r.lock_id, r]));
      for (const l of leases || []) {
        const id = hexOf(fromB64(l.id));
        const r = byLock.get(id);
        if (!r || LIVE_STATES.has(r.state)) continue;   // not ours, or a live record's
        const op = l.outpoint || {};
        const txid = op.txid_str || (op.txid_bytes ? hexOf(fromB64(op.txid_bytes).reverse()) : '');
        try { await lnd.releaseOutput({ id: l.id, outpoint: { txid_str: txid, output_index: Number(op.output_index) || 0 } }); acted++; log(`[JIT-HOLD] sweep: stray lease on ${short(txid)}:${op.output_index} released (its record is ${r.state})`); } catch (_) {}
      }
    } catch (_) {}
    if (acted) persist();
    return { swept: openRecs.length, acted };
  }

  // ── reports ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** The wallet's question (GET /v1/jit-funding/status): the record's state, the wallet's own records only; an abandoned channel answers from its tombstone for good. */
  function status(client, fundingKey) {
    const who = String(client || '').toLowerCase();
    const rec = recOf(fundingKey);
    if (rec && rec.txid != null) {
      if (rec.client !== who) return null;
      return { state: rec.state === 'abandoning' ? 'held' : rec.state, txid: rec.txid, output_index: rec.vout, size_sats: rec.size_sats, at: rec.at, updated: rec.updated, published_at: rec.published_at || 0, abandoned_at: rec.abandoned_at || 0, reason: rec.reason || '' };
    }
    const t = st.tombstones[String(fundingKey || '')];
    if (t && t.client === who) { const [txid, vout] = String(fundingKey).split(':'); return { state: 'abandoned', txid, output_index: Number(vout) || 0, size_sats: 0, at: t.abandoned_at, updated: t.abandoned_at, published_at: 0, abandoned_at: t.abandoned_at, reason: t.reason || '' }; }
    return null;
  }
  function snapshot() {
    const recs = Object.values(st.records).filter((r) => r.txid != null);
    const day = now() - 86400000;
    const count = (s, since) => recs.filter((r) => r.state === s && (since == null || (r.updated || r.at) >= since)).length;
    return {
      enabled, key_ok: capability.key_ok, missing_rpcs: capability.missing_rpcs.slice(), feature_bit: FEATURE_BIT, lock_hours: Math.round(lockSeconds / 3600), fee: Object.assign({}, feeDials),
      held_now: count('held') + count('funded') + count('paid') + count('abandoning'), published_24h: count('published', day) + count('confirmed', day), abandoned_24h: count('abandoned', day), confirmed_24h: count('confirmed', day), orphans: count('orphan'),
      waiting_on_lnd: recs.filter((r) => r.state === 'funded' && r.verify_sent_at && (now() - r.at) >= FUNDED_STALE_MS).length, state_file_error: loadFailed, tombstones: Object.keys(st.tombstones).length,
      records: recs.sort((a, b) => (b.updated || b.at) - (a.updated || a.at)).slice(0, 60).map((r) => ({ cp: r.cp, client: r.client, size_sats: r.size_sats, rail: r.rail, state: r.state, at: r.at, updated: r.updated, fee_sat_per_vb: r.fee_sat_per_vb || 0, reason: r.reason || r.publish_error || r.abandon_error || r.open_error || '', republished: r.republished || 0, wallet_told: r.wallet_told })),
    };
  }
  function capabilityReport() { return { enabled, key_ok: capability.key_ok, missing_rpcs: capability.missing_rpcs.slice(), feature_bit: Number(FEATURE_BIT) }; }

  return { boot, canHold, open, markPaid, noteLadder, publish, abandon, sweep, status, snapshot, isBlocked, feeRate, feeDials, capability: capabilityReport, FEATURE_BIT, REQUIRED_URIS, _state: () => st, _live: () => live };
}

module.exports = { createJitFunding, psbtUnsignedTx, hasFundingOutput, pendingPoints, reservationDead, FEATURE_BIT, REQUIRED_URIS, STATE_FILE, COPY_DIR };
