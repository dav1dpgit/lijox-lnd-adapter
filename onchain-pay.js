'use strict';
// onchain-pay.js — 0.120.0 (S66 Mon 2026-11-02, DP 23:12 "Go on Phase 1"): LIGHTNING PAYS ON-CHAIN — the provider's
// half of the LiJ wallet paying an on-chain address from its Lightning balance. The design, every ruling and the
// words: docs/design/onchain-pay/lightning-paying-onchain-v0.6.md in the wallet repo (v0.6 = settled). In one
// paragraph: the wallet pays this box two Lightning hold payments — A (the provider's flat fee + the lock's miner fee,
// kept once the lock is sent) and B (the recipient's amount + the release's fee + a speed-up reserve, locked to the
// wallet's own payment hash H). This box's FLOAT WALLET (a Bitcoin Core wallet behind a whitelisted RPC user,
// core-rpc.js) sends THE LOCK to a HAND-OVER ADDRESS made for this one payment (btc-tx.js handoverScript: the secret
// behind H and the wallet's key W release it; this box's key L takes it back from block T). The wallet releases to the
// recipient once the lock has one confirmation, publishing the secret; this box collects B when the release is IN A
// BLOCK (never at the mempool — v0.6 §4: the user never loses more than A, whatever the provider does). A wallet that
// never releases: at T the take-back (btc-tx.js buildTakeBack, signed here under the eight controls of §9.1) returns
// the coins to the float and B is cancelled.
//
// What this module never does: it never settles B before the release is confirmed; it never signs anything but a
// take-back; it never lets one wallet see another's record (every route is signed by the wallet's node key and the
// record's client_pubkey must match); it never trusts a record on disk without its HMAC; it never builds a take-back
// from the record alone (the lock's output is re-read from Bitcoin Core first); it never sends a take-back to an
// address the float does not own; it never reaches the box or LND's own wallet (the float's RPC user may call twelve
// commands, core-rpc.js). Off (ONCHAIN_PAY_ENABLED=false) stops new quotes only — everything open runs to its end.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const btc = require('./btc-tx');

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/i.test(s);
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const OPEN_STATES = ['quoted', 'opening', 'locked', 'lock_confirmed', 'released', 'taking_back'];
const END_STATES = ['done', 'taken_back', 'cancelled', 'expired'];

function createOnchainPayRail(deps) {
  const {
    dataDir, env = process.env, log = console.log, now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout },
    lndGet, lndPost,                 // LND REST: hold invoices (mint / settle / cancel / state)
    watchSpend = null,               // ({txid, vout}, cb({spending_txid, height, raw_hex})) → sub | null — LND's spend notifier (fires on confirmation)
    watchConf = null,                // ({txid, numConfs}, cb({height})) → sub | null — LND's confirmation notifier
    coreRpc = null,                  // core-rpc.js createCoreRpc(...) — the float wallet's door, or null when the service is off
    sendWakePush = async () => {},   // (client_pubkey, holdMs, kind)
    proofCheck = null,               // (fields, action, clientPk, recordId) → {ok} | {ok:false, code, status}
    plRecord = () => {}, leaseTouch = () => {}, localPubkey = () => '',
    network = 'bc',                  // the address hrp this box pays on
  } = deps;

  // ── settings (v0.6 §8) ──
  const S = {
    enabled: String(env.ONCHAIN_PAY_ENABLED || 'false').toLowerCase() === 'true',
    fee_sats: int(env.ONCHAIN_PAY_FEE_SATS, 1000),
    fee_ppm: int(env.ONCHAIN_PAY_FEE_PPM, 2000),   // 0.120.5 (DP 11-03 13:12): 0.2% of the amount on top of the flat fee (was 0)
    min_sats: int(env.ONCHAIN_PAY_MIN_SATS, 10000),   // 0.120.4 (DP 11-03 13:02): 10,000 (was 20,000)
    max_sats: int(env.ONCHAIN_PAY_MAX_SATS, 2000000),
    refund_blocks: int(env.ONCHAIN_PAY_REFUND_BLOCKS, 144),
    daily_sats: int(env.ONCHAIN_PAY_DAILY_SATS, 2000000),
    max_open: int(env.ONCHAIN_PAY_MAX_OPEN, 10),
    lock_deadline_blocks: 3, lock_bump_after_blocks: 6, stop_release_blocks: 12, b_margin_blocks: 40,
    b_expiry_blocks: 200, a_expiry_blocks: 40, quote_valid_ms: 60000, open_window_ms: 10 * 60 * 1000,
    walkaway_max: 3, walkaway_window_ms: 30 * 24 * 3600 * 1000, keep_ended_ms: 30 * 24 * 3600 * 1000,
    lock_vbytes: 153,   // one P2WPKH input, the P2WSH hand-over output, a P2WPKH change — an estimate, re-measured at the first field lock
  };
  const seedHex = String(env.ONCHAIN_PAY_TAKEBACK_SEED || '');
  const seed = isHex(seedHex, 64) ? Buffer.from(seedHex, 'hex') : null;
  const takebackKey = seed ? crypto.createHmac('sha256', seed).update('lij-onchain-pay-takeback-v1').digest() : null;
  const recordKey = seed ? crypto.createHmac('sha256', seed).update('lij-onchain-pay-records-v1').digest() : null;
  const L = takebackKey ? btc.pubkeyOf(takebackKey).toString('hex') : null;
  const ready = () => !!(coreRpc && seed);

  // ── records: DATA_DIR/onchain-pay/<H>.json, each with an HMAC under a key only this box's seed makes (control 1) ──
  const DIR = path.join(dataDir, 'onchain-pay');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
  const recs = new Map();   // H → record
  const canon = (r) => { const o = {}; for (const k of Object.keys(r).sort()) if (k !== 'hmac') o[k] = r[k]; return JSON.stringify(o); };
  const sign = (r) => recordKey ? crypto.createHmac('sha256', recordKey).update(canon(r)).digest('hex') : '';
  const verified = (r) => { if (!recordKey) return false; const want = sign(r); const a = Buffer.from(String(r.hmac || ''), 'utf8'), b = Buffer.from(want, 'utf8'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const persist = (r) => { try { r.hmac = sign(r); fs.writeFileSync(path.join(DIR, r.hash + '.json'), JSON.stringify(r)); } catch (e) { log(`[ONCHAIN-PAY] persist ${short(r.hash)} failed: ${e.message}`); } };
  const short = (h) => String(h || '').slice(0, 12);
  let bootRefused = [];
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
        if (!r || r.hash !== f.slice(0, 64)) continue;
        if (!verified(r)) { bootRefused.push(r.hash); continue; }   // an edited record is never acted on
        recs.set(r.hash, r);
      } catch (e) {}
    }
  } catch (e) {}
  const open = () => Array.from(recs.values()).filter((r) => OPEN_STATES.includes(r.state));
  const b64 = (hexs) => Buffer.from(hexs, 'hex').toString('base64');
  const msgOf = (r) => r ? String(r.message || (r.error && r.error.message) || '') : '';
  const satsToBtc = (sats) => Number((sats / 1e8).toFixed(8));
  const btcToSats = (b) => Math.round(Number(b) * 1e8);

  // ── the float wallet (v0.6 §9.1) ──
  let floatState = { ok: false, fence: 'unknown', balance_sats: 0, unconfirmed_sats: 0, probed_at: 0, note: '' };
  // 0.120.5 (DP 11-03 13:12): the float's TOP-UP ADDRESS for the Console — made by getnewaddress on the operator's tap (Core has
  // no way to show the next unused address without handing it out), kept in DIR/float.json until the next tap
  const FLOAT_FILE = path.join(DIR, 'float.json');
  let topup = null;   // { address, made_at }
  try { const j = JSON.parse(fs.readFileSync(FLOAT_FILE, 'utf8')); if (j && typeof j.address === 'string') topup = { address: j.address, made_at: Number(j.made_at) || 0 }; } catch (e) {}
  async function topupAddress() {
    if (!ready()) throw new Error('no float wallet');
    const address = String(await coreRpc.call('getnewaddress', ['LiJ float top-up', 'bech32']) || '').trim();
    if (!/^(bc1|tb1|bcrt1)[0-9a-z]{20,90}$/.test(address)) throw new Error('getnewaddress gave no address');
    topup = { address, made_at: now() };
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FLOAT_FILE, JSON.stringify(topup)); } catch (e) {}
    log(`[ONCHAIN-PAY] top-up address made for the Console: ${address}`);
    return topup;
  }
  async function probeFloat() {
    if (!ready()) { floatState = { ok: false, fence: 'unknown', balance_sats: 0, unconfirmed_sats: 0, probed_at: now(), note: coreRpc ? 'no take-back seed' : 'no float wallet' }; return floatState; }
    try {
      const fence = await coreRpc.probeFence();
      const bal = await coreRpc.call('getbalances');
      const mine = (bal && bal.mine) || {};
      floatState = { ok: fence === 'ok', fence, balance_sats: btcToSats(mine.trusted || 0), unconfirmed_sats: btcToSats(mine.untrusted_pending || 0), probed_at: now(), note: fence === 'ok' ? '' : (fence === 'open' ? 'the RPC user is NOT fenced — a command outside the list was answered; quotes refused until rpcwhitelist is in force' : 'the float wallet could not be asked') };
    } catch (e) { floatState = { ok: false, fence: 'down', balance_sats: 0, unconfirmed_sats: 0, probed_at: now(), note: 'the float wallet could not be asked: ' + e.message }; }
    return floatState;
  }
  // 0.122.0 (S66, Phase 2 — design v0.7 §3 B): the rates are Bitcoin Core's own, DECIMAL sat/vB (Core already floors its
  // estimates at its relay fee — 1 sat/vB on Core 29, 0.1 on 30 and later), kept to three decimals; the lock at the
  // next-block estimate, the release's suggestion at the six-block one (the rule: never a release below the rate expected
  // to confirm within 6 blocks). The floor of 1 and the rounding up are gone; a hard floor of 0.1 stays as a guard.
  async function liveRate(blocks) {
    const r = await coreRpc.call('estimatesmartfee', [blocks, 'conservative']);
    const btcPerKvb = Number(r && r.feerate);
    if (!(btcPerKvb > 0)) throw new Error('no fee estimate yet (' + ((r && r.errors && r.errors.join('; ')) || 'empty') + ')');
    return Math.max(0.1, Math.round(btcPerKvb * 1e8) / 1000);   // BTC/kvB → sat/vB with three decimals
  }
  async function liveLockRate() { return liveRate(1); }
  async function liveReleaseRate() { return liveRate(6); }
  const kvb = (rateSatVb) => Math.round(rateSatVb * 1000);   // sat per kilo-vbyte, a whole number — what the engine takes
  async function tipHeight() { return Number(await coreRpc.call('getblockcount')) || 0; }

  // ── bounds ──
  const lockedLast24h = () => { const t = now() - 24 * 3600 * 1000; let s = 0; for (const r of recs.values()) if (r.lock_at && r.lock_at >= t) s += Number(r.lock_sats || 0); return s; };
  const reservedSats = () => { let s = 0; for (const r of recs.values()) if (r.state === 'quoted' || r.state === 'opening') s += Number(r.lock_sats || 0); return s; };   // locks not yet sent
  const floatRemaining = () => floatState.balance_sats - reservedSats();   // what a new lock could still draw on
  const walkaways = (client) => { const t = now() - S.walkaway_window_ms; let c = 0; for (const r of recs.values()) if (r.client_pubkey === client && r.state === 'taken_back' && r.ended_at >= t) c++; return c; };
  function quoteRefusal(client, amount) {
    if (!S.enabled) return { error: 'this provider does not offer paying on-chain from Lightning right now', code: 503 };
    if (!ready() || !floatState.ok) return { error: 'this provider cannot pay on-chain right now (' + (floatState.note || 'float wallet not ready') + ')', code: 503 };
    if (!Number.isInteger(amount) || amount < S.min_sats || amount > S.max_sats) return { error: `amount must be between ${S.min_sats} and ${S.max_sats} sats`, code: 400 };
    if (open().length >= S.max_open) return { error: 'this provider has too many on-chain payments open right now — try again in a while', code: 429 };
    if (walkaways(client) >= S.walkaway_max) return { error: 'this wallet left too many on-chain payments unfinished recently — try again later', code: 429 };
    return null;
  }

  // ── hold invoices ──
  async function mintHold({ hashHex, valueMsat, cltvExpiry, memo, expiryS }) {
    const r = await lndPost('/v2/invoices/hodl', { hash: b64(hashHex), value_msat: String(valueMsat), memo, expiry: String(expiryS), cltv_expiry: String(cltvExpiry), private: true });
    if (!r || !r.payment_request) throw new Error(msgOf(r) || 'hold invoice mint failed');
    return r.payment_request;
  }
  const invoiceState = async (hashHex) => { try { const inv = await lndGet('/v1/invoice/' + hashHex); return inv && inv.state; } catch (e) { return null; } };
  const settle = async (preimageHex) => { const r = await lndPost('/v2/invoices/settle', { preimage: b64(preimageHex) }); if (r && /permission|error/i.test(msgOf(r)) && !/already/i.test(msgOf(r))) throw new Error(msgOf(r)); };
  const cancel = async (hashHex) => { try { await lndPost('/v2/invoices/cancel', { payment_hash: b64(hashHex) }); } catch (e) {} };

  // ── the record's public shape (the wallet's status; the console's pane) ──
  function publicRec(r) {
    return { hash: r.hash, state: r.state, amount_sats: r.amount_sats, release_fee_sats: r.release_fee_sats, reserve_sats: r.reserve_sats, provider_fee_sats: r.provider_fee_sats, lock_fee_sats: r.lock_fee_sats,
      lock_sats: r.lock_sats, lock_rate_sat_vb: r.lock_rate_sat_vb, recipient: r.recipient, handover_address: r.handover_address || null, L: r.L, W: r.W, T: r.T || null, lock_txids: r.lock_txids || [], lock_vout: r.lock_vout == null ? null : r.lock_vout,
      lock_block: r.lock_block || null, lock_confirmed_block: r.lock_confirmed_block || null, release_txid: r.release_txid || null, release_block: r.release_block || null, takeback_txids: r.takeback_txids || [],
      quoted_at: r.quoted_at, opened_at: r.opened_at || null, lock_at: r.lock_at || null, ended_at: r.ended_at || null, end_reason: r.end_reason || null, stop_release_block: r.T ? r.T - S.stop_release_blocks : null };
  }

  // ── the watches ──
  const subs = new Map();   // key → subscription
  const stopSub = (k) => { const s = subs.get(k); if (s) { try { if (typeof s.close === 'function') s.close(); else if (typeof s.cancel === 'function') s.cancel(); } catch (e) {} subs.delete(k); } };
  const invoiceTimers = new Map();
  function watchInvoices(r) {   // opening: both A and B must be ACCEPTED within the open window
    if (invoiceTimers.has(r.hash)) return;
    const tick = async () => {
      const rec = recs.get(r.hash);
      if (!rec || rec.state !== 'opening') { invoiceTimers.delete(r.hash); return; }
      try {
        const [sa, sb] = await Promise.all([invoiceState(rec.a_hash), invoiceState(rec.hash)]);
        if (sa === 'CANCELED' || sb === 'CANCELED' || now() - rec.opened_at > S.open_window_ms) {
          rec.state = 'cancelled'; rec.ended_at = now(); rec.end_reason = (sa === 'CANCELED' || sb === 'CANCELED') ? 'a payment was cancelled before the lock' : 'the payments did not both arrive within 10 minutes';
          await cancel(rec.a_hash); await cancel(rec.hash); persist(rec); invoiceTimers.delete(r.hash);
          log(`[ONCHAIN-PAY] ${short(rec.hash)}: ended before the lock — ${rec.end_reason}`); return;
        }
        if (sa === 'ACCEPTED' && sb === 'ACCEPTED') { invoiceTimers.delete(r.hash); await sendLock(rec); return; }
      } catch (e) {}
      if (invoiceTimers.has(r.hash)) invoiceTimers.set(r.hash, timers.set(tick, 3000));
    };
    invoiceTimers.set(r.hash, timers.set(tick, 500));
  }
  // 0.120.2 (DP's first ride, 11-03 12:17 — FOUND IN THE JOURNAL: "gRPC error (code=2): an output script must be provided",
  // every second, for both watches): LND's chain notifier REQUIRES the output's script with a confirmation or spend
  // registration (chainrpc: RegisterConfirmationsNtfn / RegisterSpendNtfn refuse an empty script); 0.120.0 sent none,
  // so no lock was ever seen confirmed and no release ever seen spent — the wallet would have been paid on-chain and B
  // never collected. The hand-over output's script is the P2WSH of the record's script, rebuilt here for every watch.
  // 0.120.3 (12:4x, READ IN LND'S OWN SOURCE — chainntnfs/txnotifier.go newConfNtfn / newSpendNtfn: "A height hint must be
  // provided to prevent scanning from the genesis block"; ErrNoHeightHint "a height hint greater than 0 must be
  // provided"): the hint is REQUIRED too, and it is the lower bound of LND's backward scan when a watch is registered
  // after the fact (bitcoindnotify: from the current block down to the hint) — the lock's block, kept on the record
  // since 0.120.0, is that bound for both the lock's confirmation and the hand-over output's spend.
  const lockSpk = (rec) => btc.p2wshScriptPubKey(Buffer.from(String(rec.script || ''), 'hex'));
  const lockHint = (rec) => Math.max(1, Number(rec.lock_block) || 0);
  function watchLock(rec) {
    const txid = rec.lock_txids[rec.lock_txids.length - 1];
    if (!txid || !rec.script || typeof watchConf !== 'function') return;
    const key = 'conf:' + rec.hash;
    stopSub(key);
    const sub = watchConf({ txid, numConfs: 1, script: lockSpk(rec), heightHint: lockHint(rec) }, async (ev) => {
      const r2 = recs.get(rec.hash); if (!r2 || r2.lock_txids[r2.lock_txids.length - 1] !== txid) return;
      if (r2.state === 'locked') {
        r2.state = 'lock_confirmed'; r2.lock_confirmed_block = Number(ev && ev.height) || 0; persist(r2);
        log(`[ONCHAIN-PAY] ${short(r2.hash)}: the lock ${short(txid)} confirmed at block ${r2.lock_confirmed_block} — the wallet may release until block ${r2.T - S.stop_release_blocks}`);
        try { await sendWakePush(r2.client_pubkey, undefined, 'onchain-pay'); } catch (e) {}
      }
    });
    if (sub) subs.set(key, sub);
  }
  function watchHandover(rec) {   // LND's spend notifier fires when the spend is IN A BLOCK (v0.6 §3 step 8)
    const txid = rec.lock_txids[rec.lock_txids.length - 1];
    if (!txid || rec.lock_vout == null || !rec.script || typeof watchSpend !== 'function') return;
    const key = 'spend:' + rec.hash;
    stopSub(key);
    const sub = watchSpend({ txid, vout: rec.lock_vout, script: lockSpk(rec), heightHint: lockHint(rec) }, async (ev) => { try { await onHandoverSpent(rec.hash, ev); } catch (e) { log(`[ONCHAIN-PAY] ${short(rec.hash)}: spend handling failed: ${e.message}`); } });
    if (sub) subs.set(key, sub);
  }
  async function onHandoverSpent(hash, ev) {
    const r = recs.get(hash); if (!r) return;
    const spendTxid = String(ev.spending_txid || ''); const height = Number(ev.height) || 0;
    let secret = null, ours = false;
    try {
      const tx = ev.raw_hex ? btc.parse(ev.raw_hex) : null;
      if (tx) { const w = tx.inputs.find((i) => i.txid === r.lock_txids[r.lock_txids.length - 1] && i.vout === r.lock_vout) || tx.inputs[0]; const items = w.witness || []; if (items.length === 3 && items[1].length === 32 && sha256Hex(items[1]) === r.hash) secret = items[1].toString('hex'); else if (items.length === 3 && items[1].length === 0) ours = true; }
    } catch (e) {}
    if (!secret && r.secret) secret = r.secret;   // the release handed over earlier carried it
    if (!secret && (r.takeback_txids || []).includes(spendTxid)) ours = true;
    if (secret) {
      r.release_txid = spendTxid; r.release_block = height; r.secret = secret;
      try { await settle(secret); r.state = 'done'; r.ended_at = now(); r.end_reason = 'the recipient was paid; B collected'; persist(r);
        plRecord('onchain_pay_fee', { msat: r.provider_fee_sats * 1000, moved_msat: r.amount_sats * 1000, wallet: r.client_pubkey, hash: r.hash });
        log(`[ONCHAIN-PAY] ${short(r.hash)}: the release ${short(spendTxid)} is in block ${height} — B settled (${r.amount_sats} sats to the recipient)`);
      } catch (e) { r.state = 'released'; r.settle_error = e.message; persist(r); log(`[ONCHAIN-PAY] ${short(r.hash)}: the release confirmed but B could not be settled yet (${e.message}) — retrying`); }
      stopSub('spend:' + hash); stopSub('conf:' + hash);
    } else if (ours) {
      r.state = 'taken_back'; r.ended_at = now(); r.takeback_block = height; r.end_reason = 'the wallet never released; the coins came back to the float'; persist(r);
      await cancel(r.hash);
      plRecord('onchain_pay_takeback', { msat: 0, wallet: r.client_pubkey, hash: r.hash, chain_fee_sats: r.takeback_fee_sats || 0 });
      log(`[ONCHAIN-PAY] ${short(r.hash)}: the take-back ${short(spendTxid)} is in block ${height} — B cancelled and returned to the wallet`);
      stopSub('spend:' + hash); stopSub('conf:' + hash);
    } else {
      log(`[ONCHAIN-PAY] ${short(r.hash)}: the hand-over output was spent by ${short(spendTxid)} with neither the secret nor our key — read the chain`);
      r.state = 'spent_unknown'; r.ended_at = now(); r.end_reason = 'spent by an unknown transaction ' + spendTxid; persist(r);
    }
  }

  // ── the lock (v0.6 §3 step 4) ──
  async function sendLock(rec) {
    const r = recs.get(rec.hash); if (!r || r.state !== 'opening') return;
    try {
      const tip = await tipHeight();
      const T = tip + S.refund_blocks;
      const script = btc.handoverScript(r.hash, r.W, r.L, T);
      const address = btc.p2wshAddress(script, network);
      const rate = await liveLockRate();
      const res = await coreRpc.call('sendtoaddress', { address, amount: satsToBtc(r.lock_sats), replaceable: true, fee_rate: rate, verbose: true });
      const txid = String((res && res.txid) || res || '');
      if (!isHex(txid, 64)) throw new Error('sendtoaddress gave no txid');
      // which output pays the hand-over address — from the transaction itself, never assumed
      const gt = await coreRpc.call('gettransaction', [txid, true, false]);
      const parsed = btc.parse(gt.hex); const spk = btc.p2wshScriptPubKey(script);
      const vout = parsed.outputs.findIndex((o) => o.script.equals(spk) && o.value === r.lock_sats);
      if (vout < 0) throw new Error('the lock does not pay the hand-over address with the amount');
      r.T = T; r.lock_block = tip; r.script = script.toString('hex'); r.handover_address = address; r.lock_txids = [txid]; r.lock_vout = vout; r.lock_at = now(); r.lock_rate_sent_sat_vb = rate; r.lock_fee_paid_sats = Math.abs(btcToSats(gt.fee || 0));
      r.state = 'locked'; persist(r);
      await settle(r.a_preimage);   // A is the provider's now (v0.6 §5)
      r.a_settled_at = now(); persist(r);
      plRecord('onchain_pay_lock', { msat: r.lock_fee_sats * 1000, wallet: r.client_pubkey, hash: r.hash, chain_fee_sats: r.lock_fee_paid_sats });
      log(`[ONCHAIN-PAY] ${short(r.hash)}: LOCKED ${r.lock_sats} sats at ${address} by ${short(txid)}:${vout} (${rate} sat/vB), T = ${T}; A settled (${r.provider_fee_sats} + ${r.lock_fee_sats} sats)`);
      watchLock(r); watchHandover(r);
    } catch (e) {
      log(`[ONCHAIN-PAY] ${short(r.hash)}: the lock could not be sent (${e.message}) — both payments cancelled and returned`);
      r.state = 'cancelled'; r.ended_at = now(); r.end_reason = 'the lock could not be sent: ' + e.message; persist(r);
      await cancel(r.a_hash); await cancel(r.hash);
    }
  }

  // ── the take-back (v0.6 §9.1, the eight controls) ──
  async function takeBack(r, tip) {
    if (!verified(r)) { log(`[ONCHAIN-PAY] ${short(r.hash)}: record HMAC mismatch — take-back REFUSED`); return; }   // 1 — and the record is left untouched: re-signing it would launder it
    if (tip < r.T) return;                                                                                                             // 4
    const lockTxid = r.lock_txids[r.lock_txids.length - 1];
    const script = btc.handoverScript(r.hash, r.W, r.L, r.T);                                                                          // 2: rebuilt, not read
    const spk = btc.p2wshScriptPubKey(script);
    const gt = await coreRpc.call('gettransaction', [lockTxid, true, false]);
    const parsed = btc.parse(gt.hex);
    const out = parsed.outputs[r.lock_vout];
    if (!out || !out.script.equals(spk) || out.value !== r.lock_sats) { log(`[ONCHAIN-PAY] ${short(r.hash)}: the lock on the chain does not match the record — take-back REFUSED`); r.takeback_error = 'lock mismatch'; persist(r); return; }
    if (Number(gt.confirmations) < 1) { log(`[ONCHAIN-PAY] ${short(r.hash)}: the lock is not confirmed at T — bumping instead`); await bumpLock(r, tip); return; }
    const dest = await coreRpc.call('getnewaddress', ['lij-onchain-pay take-back', 'bech32']);
    const info = await coreRpc.call('getaddressinfo', [dest]);
    if (!info || info.ismine !== true) { log(`[ONCHAIN-PAY] ${short(r.hash)}: the take-back address is not the float's — REFUSED`); r.takeback_error = 'dest not ours'; persist(r); return; }   // 3
    const rate = Math.max(1, await liveLockRate().catch(() => 1)) + (r.takeback_txids || []).length * 2;   // a replacement pays at least 2 sat/vB more
    const built = btc.buildTakeBack({ lockTxid, lockVout: r.lock_vout, lockValue: r.lock_sats, script, T: r.T, destScript: btc.addressToScript(dest, network), feeRateSatVb: rate, privkey: takebackKey });
    const acc = await coreRpc.call('testmempoolaccept', [[built.hex]]);                                                                   // 5
    const a0 = Array.isArray(acc) ? acc[0] : null;
    if (!a0 || a0.allowed !== true) { r.takeback_error = 'testmempoolaccept: ' + ((a0 && a0['reject-reason']) || 'refused'); persist(r); log(`[ONCHAIN-PAY] ${short(r.hash)}: the take-back was refused by the mempool check (${r.takeback_error}) — next block`); return; }
    await coreRpc.call('sendrawtransaction', [built.hex]);
    r.takeback_txids = (r.takeback_txids || []).concat([built.txid]); r.takeback_fee_sats = built.fee; r.takeback_dest = dest; r.takeback_rate_sat_vb = rate; r.takeback_at = now(); r.takeback_block = tip; r.state = 'taking_back'; delete r.takeback_error; persist(r);
    log(`[ONCHAIN-PAY] ${short(r.hash)}: TAKE-BACK ${short(built.txid)} sent at block ${tip} — ${r.lock_sats} sats from ${r.handover_address} to ${dest}, fee ${built.fee} sats (${rate} sat/vB)`);   // 6
  }
  async function bumpLock(r, tip) {
    const txid = r.lock_txids[r.lock_txids.length - 1];
    try {
      const res = await coreRpc.call('bumpfee', [txid]);
      const nt = String((res && res.txid) || '');
      if (!isHex(nt, 64)) throw new Error('bumpfee gave no txid');
      const gt = await coreRpc.call('gettransaction', [nt, true, false]);
      const parsed = btc.parse(gt.hex); const spk = btc.p2wshScriptPubKey(Buffer.from(r.script, 'hex'));
      const vout = parsed.outputs.findIndex((o) => o.script.equals(spk) && o.value === r.lock_sats);
      if (vout < 0) throw new Error('the bumped lock does not pay the hand-over address');
      r.lock_txids.push(nt); r.lock_vout = vout; r.lock_bumped_at = now(); r.lock_bump_block = tip; r.lock_fee_paid_sats = Math.abs(btcToSats(gt.fee || 0)); persist(r);
      plRecord('onchain_pay_bump', { msat: 0, wallet: r.client_pubkey, hash: r.hash, chain_fee_sats: r.lock_fee_paid_sats });
      log(`[ONCHAIN-PAY] ${short(r.hash)}: the lock bumped — ${short(txid)} → ${short(nt)}:${vout}`);
      watchLock(r); watchHandover(r);
    } catch (e) { log(`[ONCHAIN-PAY] ${short(r.hash)}: bump failed (${e.message})`); }
  }

  // ── the minute tick: due take-backs, slow locks, the settle retry, pruning ──
  let tickTimer = null;
  async function tick() {
    try {
      if (!ready()) return;
      const opens = open(); if (!opens.length) { pruneEnded(); return; }
      const tip = await tipHeight();
      for (const r of opens) {
        try {
          if ((r.state === 'locked' || r.state === 'lock_confirmed' || r.state === 'taking_back') && tip >= r.T) {
            if (r.state !== 'taking_back' || (r.takeback_block && tip - r.takeback_block >= S.lock_bump_after_blocks)) await takeBack(r, tip);
          } else if (r.state === 'locked' && r.lock_block && tip - (r.lock_bump_block || r.lock_block) >= S.lock_bump_after_blocks) {
            const gt = await coreRpc.call('gettransaction', [r.lock_txids[r.lock_txids.length - 1], true, false]).catch(() => null);
            if (gt && Number(gt.confirmations) < 1) await bumpLock(r, tip);
          } else if (r.state === 'released' && r.secret && (!r.settle_last_try || now() - r.settle_last_try > 15000)) {
            r.settle_last_try = now(); try { await settle(r.secret); r.state = 'done'; r.ended_at = now(); r.end_reason = 'the recipient was paid; B collected (on retry)'; persist(r); } catch (e) { persist(r); }
          } else if (r.state === 'quoted' && now() - r.quoted_at > S.quote_valid_ms + S.open_window_ms) {
            r.state = 'expired'; r.ended_at = now(); r.end_reason = 'the quote was never opened'; persist(r); await cancel(r.a_hash); await cancel(r.hash);
          }
        } catch (e) { log(`[ONCHAIN-PAY] ${short(r.hash)}: tick failed: ${e.message}`); }
      }
      pruneEnded();
    } catch (e) { log(`[ONCHAIN-PAY] tick failed: ${e.message}`); }
  }
  function pruneEnded() { const t = now() - S.keep_ended_ms; for (const [h, r] of recs) if (END_STATES.includes(r.state) && r.ended_at && r.ended_at < t) { recs.delete(h); try { fs.unlinkSync(path.join(DIR, h + '.json')); } catch (e) {} } }
  function startTick() { if (tickTimer) return; const loop = async () => { await tick(); tickTimer = timers.set(loop, 60000); }; tickTimer = timers.set(loop, 60000); }

  // ── boot ──
  async function boot() {
    await probeFloat();
    const opens = open();
    if (bootRefused.length) log(`[ONCHAIN-PAY] ${bootRefused.length} record(s) on disk failed their HMAC and are IGNORED: ${bootRefused.map(short).join(', ')}`);
    if (!ready()) {
      if (opens.length) log(`[ONCHAIN-PAY] REFUSED: ${coreRpc ? 'ONCHAIN_PAY_TAKEBACK_SEED' : 'the float wallet (ONCHAIN_PAY_RPC_URL/_USER/_PASS)'} is missing while ${opens.length} payment(s) are open: ${opens.map((r) => short(r.hash)).join(', ')} — restore the setting; nothing will be taken back until then`);
      else log('[ONCHAIN-PAY] off — no float wallet');
      return;
    }
    log(`[ONCHAIN-PAY] float: ${floatState.balance_sats} sats (${floatState.unconfirmed_sats} unconfirmed), ${opens.length} open, ceiling ${S.daily_sats}/day, fence ${floatState.fence === 'ok' ? 'OK' : floatState.fence.toUpperCase()}${S.enabled ? '' : ' — new payments OFF (open ones run to their end)'}; take-back key ${L.slice(0, 16)}…`);
    if (floatState.ok && floatState.balance_sats < S.min_sats) log(`[ONCHAIN-PAY] the float holds less than the smallest payment (${S.min_sats} sats) — quotes refused until it is topped up`);
    for (const r of opens) {
      if (r.state === 'opening') watchInvoices(r);
      else if (r.state === 'locked' || r.state === 'lock_confirmed' || r.state === 'taking_back') { watchLock(r); watchHandover(r); }
    }
    startTick();
    timers.set(() => { probeFloat().catch(() => {}); }, 10 * 60 * 1000);
  }

  // ── the routes (every one signed by the wallet's node key; a record answers only its own wallet) ──
  const proofOf = (fields, action, clientPk, recordId) => (typeof proofCheck === 'function') ? proofCheck(fields, action, clientPk, recordId) : { ok: true };
  async function handle(req, res, pathname, method, ip, readBody, jsonResponse) {
    if (!pathname.startsWith('/v1/onchain-pay/')) return false;
    const j = (data, status = 200) => { jsonResponse(res, data, status); return true; };
    const sub = pathname.slice('/v1/onchain-pay/'.length).split('?')[0];
    if (method === 'GET' && sub === 'status') {
      const q = new URL(req.url || '', 'http://lsp.local').searchParams;
      const client = String(q.get('client_pubkey') || '').toLowerCase();
      if (!isHex(client, 66)) return j({ ok: false, error: 'client_pubkey required' }, 400);
      const pr = proofOf({ node_pubkey: q.get('node_pubkey'), nonce: q.get('nonce'), signature: q.get('signature') }, 'onchain-pay', client, 'status:' + client);
      if (!pr.ok) return j({ ok: false, error: pr.code }, pr.status || 401);
      leaseTouch(client, 'onchain-pay');
      const mine = Array.from(recs.values()).filter((r) => r.client_pubkey === client).sort((a, b) => b.quoted_at - a.quoted_at).slice(0, 50).map(publicRec);
      return j({ ok: true, payments: mine, settings: capability(), block_height: ready() ? await tipHeight().catch(() => 0) : 0 });
    }
    if (method !== 'POST') return j({ ok: false, error: 'method' }, 405);
    let body = null; try { body = await readBody(req); } catch (e) { return j({ ok: false, error: 'bad body' }, 400); }
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return j({ ok: false, error: 'bad json' }, 400); } }
    body = body || {};
    const client = String(body.client_pubkey || '').toLowerCase();
    if (!isHex(client, 66)) return j({ ok: false, error: 'client_pubkey required' }, 400);
    const hash = String(body.payment_hash || '').toLowerCase();
    if (!isHex(hash, 64)) return j({ ok: false, error: 'payment_hash required (32 bytes hex)' }, 400);
    if (!['quote', 'open', 'release'].includes(sub)) return j({ ok: false, error: 'not found' }, 404);   // the same answer as a stranger's hash gets — no existence oracle

    if (sub === 'quote') {
      const amount = Number(body.amount_sats), releaseFee = Number(body.release_fee_sats), reserve = Number(body.reserve_sats);
      const W = String(body.release_pubkey || '').toLowerCase(); const recipient = String(body.recipient_address || '').trim();
      const pr = proofOf(body, 'onchain-pay', client, 'quote:' + hash);
      if (!pr.ok) return j({ ok: false, error: pr.code }, pr.status || 401);
      const refuse = quoteRefusal(client, amount); if (refuse) return j({ ok: false, error: refuse.error }, refuse.code);
      if (!isHex(W, 66) || !/^0[23]/.test(W)) return j({ ok: false, error: 'release_pubkey must be a 33-byte compressed key' }, 400);
      if (!Number.isInteger(releaseFee) || releaseFee < 0 || releaseFee > 200000 || !Number.isInteger(reserve) || reserve < 0 || reserve > 200000) return j({ ok: false, error: 'release_fee_sats and reserve_sats must be whole sats under 200,000' }, 400);
      if (!recipient || recipient.length > 120) return j({ ok: false, error: 'recipient_address required' }, 400);
      if (recs.has(hash) && OPEN_STATES.includes(recs.get(hash).state)) return j({ ok: false, error: 'a payment with this hash is already open' }, 409);
      const lockSats = amount + releaseFee + reserve;
      if (lockedLast24h() + lockSats > S.daily_sats) return j({ ok: false, error: 'this provider\'s daily ceiling for on-chain payments is reached — try tomorrow' }, 429);
      // DP (S66 23:39): the limiter is the float's ACTUAL remaining balance — read from the wallet NOW, not the last
      // ten-minute probe — less what the quotes and openings already standing will take when their locks go out
      const live = await probeFloat();
      if (!live.ok) return j({ ok: false, error: 'this provider cannot pay on-chain right now (' + (live.note || 'float wallet not ready') + ')' }, 503);
      if (floatRemaining() < lockSats) return j({ ok: false, error: 'this provider\'s float cannot cover this payment right now' }, 503);
      let rate, releaseRate; try { rate = await liveLockRate(); releaseRate = await liveReleaseRate(); } catch (e) { return j({ ok: false, error: 'no fee estimate right now (' + e.message + ')' }, 503); }
      const lockFee = Math.ceil(S.lock_vbytes * rate);   // 0.122.0: the decimal rate, the fee rounded up once
      const providerFee = S.fee_sats + Math.ceil(amount * S.fee_ppm / 1e6);
      const aPreimage = crypto.randomBytes(32).toString('hex'); const aHash = sha256Hex(Buffer.from(aPreimage, 'hex'));
      let aBolt11, bBolt11;
      try {
        aBolt11 = await mintHold({ hashHex: aHash, valueMsat: (providerFee + lockFee) * 1000, cltvExpiry: S.a_expiry_blocks, memo: 'Lightning in a Jar · pays on-chain · fee', expiryS: 900 });
        bBolt11 = await mintHold({ hashHex: hash, valueMsat: lockSats * 1000, cltvExpiry: S.b_expiry_blocks, memo: 'Lightning in a Jar · pays on-chain', expiryS: 900 });
      } catch (e) { await cancel(aHash); return j({ ok: false, error: 'could not mint the invoices: ' + e.message }, 502); }
      const r = { hash, client_pubkey: client, W, L, recipient, amount_sats: amount, release_fee_sats: releaseFee, reserve_sats: reserve, lock_sats: lockSats, provider_fee_sats: providerFee, lock_fee_sats: lockFee, lock_rate_sat_vb: rate, release_rate_sat_vb: releaseRate,
        a_hash: aHash, a_preimage: aPreimage, a_bolt11: aBolt11, b_bolt11: bBolt11, state: 'quoted', quoted_at: now(), lock_txids: [], takeback_txids: [] };
      recs.set(hash, r); persist(r); leaseTouch(client, 'onchain-pay');
      log(`[ONCHAIN-PAY] ${short(hash)}: quoted for ${client.slice(0, 16)}… — ${amount} sats to the recipient, lock ${lockSats}, A ${providerFee + lockFee} (${rate} sat/vB)`);
      // 0.122.0: lock_rate_sat_vb is the decimal (no engine reads it as an integer — the v1082 page only prints it); the exact
      // rates also ride in sat per kilo-vbyte, whole numbers for the engine — the lock's, and Core's six-block estimate as the
      // suggestion for the release
      return j({ ok: true, payment_hash: hash, provider_fee_sats: providerFee, lock_fee_sats: lockFee, lock_rate_sat_vb: rate, lock_rate_sat_kvb: kvb(rate), release_rate_sat_kvb: kvb(releaseRate), lock_sats: lockSats, a: { bolt11: aBolt11, amount_sats: providerFee + lockFee, hash: aHash }, b: { bolt11: bBolt11, amount_sats: lockSats, hash },
        L, refund_blocks: S.refund_blocks, t_min_offset: S.refund_blocks - 4, t_max_margin: S.b_margin_blocks, b_expiry_blocks: S.b_expiry_blocks, stop_release_blocks: S.stop_release_blocks, min_conf: 1, valid_for_ms: S.quote_valid_ms, provider: localPubkey() });
    }
    const r = recs.get(hash);
    if (!r || r.client_pubkey !== client) return j({ ok: false, error: 'not found' }, 404);   // never described to another wallet
    if (sub === 'open') {
      const pr = proofOf(body, 'onchain-pay', client, 'open:' + hash);
      if (!pr.ok) return j({ ok: false, error: pr.code }, pr.status || 401);
      if (r.state !== 'quoted') return j({ ok: false, error: 'not open for paying (' + r.state + ')' }, 409);
      if (now() - r.quoted_at > S.quote_valid_ms) { r.state = 'expired'; r.ended_at = now(); r.end_reason = 'the quote expired before Send'; persist(r); await cancel(r.a_hash); await cancel(r.hash); return j({ ok: false, error: 'the quote expired — ask again' }, 410); }
      r.state = 'opening'; r.opened_at = now(); persist(r); watchInvoices(r); leaseTouch(client, 'onchain-pay');
      return j({ ok: true, payment_hash: hash, state: r.state });
    }
    if (sub === 'release') {
      const txHex = String(body.tx_hex || '').toLowerCase();
      if (!/^[0-9a-f]{100,20000}$/.test(txHex)) return j({ ok: false, error: 'tx_hex required' }, 400);
      const pr = proofOf(body, 'onchain-pay', client, 'release:' + hash + ':' + sha256Hex(Buffer.from(txHex, 'hex')));
      if (!pr.ok) return j({ ok: false, error: pr.code }, pr.status || 401);
      if (!(r.state === 'locked' || r.state === 'lock_confirmed' || r.state === 'released')) return j({ ok: false, error: 'no lock to release (' + r.state + ')' }, 409);
      let tx; try { tx = btc.parse(txHex); } catch (e) { return j({ ok: false, error: 'tx_hex does not parse' }, 400); }
      const lockTxid = r.lock_txids[r.lock_txids.length - 1];
      const inp = tx.inputs.find((i) => i.txid === lockTxid && i.vout === r.lock_vout);
      if (!inp) return j({ ok: false, error: 'the transaction does not spend the lock' }, 400);
      const items = inp.witness || [];
      if (!(items.length === 3 && items[1].length === 32 && sha256Hex(items[1]) === hash && items[2].toString('hex') === r.script)) return j({ ok: false, error: 'the transaction is not a release of this payment' }, 400);
      r.secret = items[1].toString('hex'); r.release_hex = txHex; r.release_handed_txid = btc.txid(tx); r.release_handed_at = now(); persist(r);
      let accepted = null;
      try { const acc = await coreRpc.call('testmempoolaccept', [[txHex]]); accepted = Array.isArray(acc) && acc[0] ? acc[0] : null; if (accepted && accepted.allowed) await coreRpc.call('sendrawtransaction', [txHex]); } catch (e) { accepted = { allowed: false, 'reject-reason': e.message }; }
      leaseTouch(client, 'onchain-pay');
      log(`[ONCHAIN-PAY] ${short(hash)}: the release ${short(r.release_handed_txid)} handed over — ${accepted && accepted.allowed ? 'rebroadcast' : 'not rebroadcast (' + ((accepted && accepted['reject-reason']) || 'unknown') + ')'}; B settles when it is in a block`);
      return j({ ok: true, payment_hash: hash, release_txid: r.release_handed_txid, rebroadcast: !!(accepted && accepted.allowed), note: accepted && !accepted.allowed ? String(accepted['reject-reason'] || '') : '' });
    }
    return j({ ok: false, error: 'not found' }, 404);
  }

  function capability() {
    return { v: 1, enabled: S.enabled && ready() && floatState.ok, fee_sats: S.fee_sats, fee_ppm: S.fee_ppm, min_sats: S.min_sats, max_sats: S.max_sats, refund_blocks: S.refund_blocks, stop_release_blocks: S.stop_release_blocks, b_expiry_blocks: S.b_expiry_blocks, min_conf: 1, daily_sats: S.daily_sats, float_ok: floatState.ok };
  }
  function summary() {   // the console's Float pane (v0.6 §9.4)
    const all = Array.from(recs.values());
    const opens = all.filter((r) => OPEN_STATES.includes(r.state));
    const ended = all.filter((r) => END_STATES.includes(r.state) || r.state === 'spent_unknown');
    const fees = all.filter((r) => r.a_settled_at).reduce((s, r) => s + r.provider_fee_sats, 0);
    const chain = all.reduce((s, r) => s + (r.takeback_fee_sats || 0) + Math.max(0, (r.lock_fee_paid_sats || 0) - (r.lock_fee_sats || 0)), 0);
    return { float: floatState, topup: topup, settings: S, take_back_key: L, enabled: S.enabled, ready: ready(), open: opens.map(publicRec), ended: ended.sort((a, b) => (b.ended_at || 0) - (a.ended_at || 0)).slice(0, 50).map(publicRec),
      locked_24h_sats: lockedLast24h(), reserved_sats: reservedSats(), remaining_sats: floatRemaining(), due_soon: opens.filter((r) => r.T).map((r) => ({ hash: r.hash, T: r.T })), provider_fees_sats: fees, chain_costs_sats: chain, boot_refused: bootRefused.slice() };
  }

  return { handle, boot, tick, capability, summary, probeFloat, topupAddress, settings: () => S, records: () => recs, _takeBack: takeBack, _onHandoverSpent: onHandoverSpent, _sendLock: sendLock, L };
}

module.exports = { createOnchainPayRail, OPEN_STATES, END_STATES };
