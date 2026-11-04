'use strict';
// onchain-pay.test.js — 0.120.0: the rail end to end against stand-ins — LND's hold invoices and notifiers, the float
// wallet's door (a fake Bitcoin Core that builds real transaction bytes), manual timers. The happy path (quote → open →
// both payments → the lock → confirmed → the release handed over → the release in a block → B settled), the walk-away
// path (T reached → the take-back under its controls → in a block → B cancelled), every refusal, the fence, Off,
// the restart, and the keeping-apart of wallets.
//   node onchain-pay.test.js
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const btc = require('./btc-tx');
const { createOnchainPayRail } = require('./onchain-pay');
let n = 0, bad = 0;
const check = (c, m) => { n++; if (c) console.log('  ok · ' + m); else { bad++; console.log('  FAIL · ' + m); } };
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the stand-ins ──
function makeLnd() {
  const invoices = new Map(); const settled = []; const cancelled = [];
  const lndPost = async (p, body) => {
    if (p === '/v2/invoices/hodl') { const h = Buffer.from(body.hash, 'base64').toString('hex'); invoices.set(h, { state: 'OPEN', value_msat: body.value_msat, cltv: body.cltv_expiry, memo: body.memo }); return { payment_request: 'lnbc1stub' + h.slice(0, 8), add_index: '1' }; }
    if (p === '/v2/invoices/settle') { const pre = Buffer.from(body.preimage, 'base64'); const h = sha256Hex(pre); if (!invoices.has(h)) return { message: 'invoice not found' }; invoices.get(h).state = 'SETTLED'; settled.push(h); return {}; }
    if (p === '/v2/invoices/cancel') { const h = Buffer.from(body.payment_hash, 'base64').toString('hex'); if (invoices.has(h)) invoices.get(h).state = 'CANCELED'; cancelled.push(h); return {}; }
    return {};
  };
  const lndGet = async (p) => { const m = p.match(/^\/v1\/invoice\/([0-9a-f]{64})$/); if (m) return invoices.get(m[1]) || { state: 'OPEN' }; return {}; };
  return { invoices, settled, cancelled, lndPost, lndGet, accept: (h) => { invoices.get(h).state = 'ACCEPTED'; } };
}
function makeCore() {
  const st = { tip: 975000, fence: 'ok', balance: 0.05, sent: [], raw: [], bumps: [], txs: new Map(), feerate: 0.00005, mempoolOk: true, ismine: true, seq: 0 };
  const floatAddr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const call = async (method, params) => {
    st.calls = st.calls || []; st.calls.push({ method, params });
    switch (method) {
      case 'getblockcount': return st.tip;
      case 'getbalances': return { mine: { trusted: st.balance, untrusted_pending: 0 } };
      case 'estimatesmartfee': return { feerate: st.feerate, blocks: 1 };
      case 'getnewaddress': return floatAddr;
      case 'getaddressinfo': return { address: params[0], ismine: st.ismine };
      case 'sendtoaddress': {
        const sats = Math.round(params.amount * 1e8);
        const tx = { version: 2, locktime: 0, inputs: [{ txid: crypto.randomBytes(32).toString('hex'), vout: 0, sequence: 0xfffffffd, witness: [Buffer.alloc(72, 0x30), Buffer.alloc(33, 2)] }],
          outputs: [{ value: 123456, script: btc.addressToScript(floatAddr) }, { value: sats, script: btc.addressToScript(params.address) }] };
        const hex = btc.serialize(tx, true).toString('hex'); const id = btc.txid(tx);
        st.txs.set(id, { hex, confirmations: 0, fee: -0.00000765 }); st.sent.push({ txid: id, params }); return { txid: id, fee_reason: 'Fallback fee' };
      }
      case 'gettransaction': { const t = st.txs.get(params[0]); if (!t) throw Object.assign(new Error('Invalid or non-wallet transaction id'), { code: -5 }); return { hex: t.hex, confirmations: t.confirmations, fee: t.fee }; }
      case 'bumpfee': { const old = st.txs.get(params[0]); const p = btc.parse(old.hex); p.inputs[0].sequence = 0xfffffffc; p.outputs[0].value -= 500; const hex = btc.serialize(p, true).toString('hex'); const id = btc.txid(p); st.txs.set(id, { hex, confirmations: 0, fee: -0.00001265 }); st.bumps.push(id); return { txid: id }; }
      case 'testmempoolaccept': return [{ txid: btc.txid(btc.parse(params[0][0])), allowed: st.mempoolOk, 'reject-reason': st.mempoolOk ? undefined : 'non-final' }];
      case 'sendrawtransaction': { st.raw.push(params[0]); return btc.txid(btc.parse(params[0])); }
      case 'getwalletinfo': return { walletname: 'lij-onchain-pay' };
      default: throw Object.assign(new Error('forbidden'), { code: 'forbidden', http: 403 });
    }
  };
  return { st, floatAddr, rpc: { call, probeFence: async () => st.fence, walletPath: '/wallet/lij-onchain-pay' } };
}
function makeNotifiers() {
  const scripts = new Map();   // 0.120.2: the output script each watch was registered with
  const hints = new Map();     // 0.120.3: the height hint each watch was registered with (LND requires > 0)
  const confs = new Map(), spends = new Map();
  return { confs, spends, scripts, hints,
    watchConf: ({ txid, numConfs, script, heightHint }, cb) => { confs.set(txid, cb); scripts.set('conf:' + txid, script); hints.set('conf:' + txid, heightHint); return { close() { confs.delete(txid); } }; },
    watchSpend: ({ txid, vout, script, heightHint }, cb) => { spends.set(txid + ':' + vout, cb); scripts.set('spend:' + txid + ':' + vout, script); hints.set('spend:' + txid + ':' + vout, heightHint); return { close() { spends.delete(txid + ':' + vout); } }; } };
}
const manualTimers = () => { const q = []; return { set: (fn, ms) => { const id = { fn, ms }; q.push(id); return id; }, clear: (id) => { const i = q.indexOf(id); if (i >= 0) q.splice(i, 1); }, run: async (pred) => { const due = q.splice(0, q.length).filter((x) => !pred || pred(x)); for (const x of due) await x.fn(); } }; };
const req = (url) => ({ url, headers: {} });
const route = async (rail, method, p, body, query = '') => { let out = null; const res = {}; const ok = await rail.handle(req(p + query), res, p, method, '127.0.0.1', async () => body, (r, data, status) => { out = { status: status || 200, data }; }); return ok ? out : { status: 'unhandled' }; };
const CLIENT = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32);
const proofs = [];
const proofCheck = (fields, action, clientPk, recordId) => { proofs.push({ action, clientPk, recordId, node: fields && fields.node_pubkey }); if (action !== 'onchain-pay') return { ok: false, code: 'action', status: 400 }; if (String(fields.node_pubkey || '').toLowerCase() !== clientPk) return { ok: false, code: 'signer is not the record\'s key', status: 403 }; return { ok: true }; };
const SEED = 'ab'.repeat(32);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lij-onchain-pay-'));
  const logs = []; const log = (m) => logs.push(String(m));
  const wake = [];
  const lnd = makeLnd(); const core = makeCore(); const nt = makeNotifiers(); const tm = manualTimers();
  let clock = 1_700_000_000_000; const now = () => clock;
  const pl = [];
  const mk = (env, over = {}) => createOnchainPayRail(Object.assign({ dataDir: dir, env, log, now, timers: tm, lndGet: lnd.lndGet, lndPost: lnd.lndPost, watchConf: nt.watchConf, watchSpend: nt.watchSpend, coreRpc: core.rpc,
    sendWakePush: async (pk, ms, kind) => { wake.push({ pk, kind }); }, proofCheck, plRecord: (k, f) => pl.push({ k, f }), leaseTouch: () => {}, localPubkey: () => '02' + 'cc'.repeat(32) }, over));
  const ENV = { ONCHAIN_PAY_ENABLED: 'true', ONCHAIN_PAY_TAKEBACK_SEED: SEED, ONCHAIN_PAY_FEE_SATS: '1000', ONCHAIN_PAY_FEE_PPM: '0', ONCHAIN_PAY_MIN_SATS: '10000', ONCHAIN_PAY_MAX_SATS: '2000000', ONCHAIN_PAY_DAILY_SATS: '2000000', ONCHAIN_PAY_MAX_OPEN: '10' };

  // ── off: no float wallet ──
  { const off = mk({ ONCHAIN_PAY_ENABLED: 'true' }, { coreRpc: null }); await off.boot(); check(/off — no float wallet/.test(logs[logs.length - 1]), 'no float wallet: the boot line says off'); check(off.capability().enabled === false, 'capability: not enabled'); }
  // ── ready ──
  const rail = mk(ENV); await rail.boot();
  const bootLine = logs.find((l) => /\[ONCHAIN-PAY\] float: /.test(l));
  check(!!bootLine && /5000000 sats/.test(bootLine) && /fence OK/.test(bootLine) && /ceiling 2000000\/day/.test(bootLine), 'the boot line: the float\'s balance, the ceiling, fence OK: ' + bootLine);
  check(rail.L && /^0[23][0-9a-f]{64}$/.test(rail.L), 'the take-back key L from the seed');
  // 0.120.5: the defaults — 1,000 sats + 0.2% (2000 ppm), the floor 10,000; the top-up address on a tap, kept for the pane
  { const d = mk({ ONCHAIN_PAY_ENABLED: 'true', ONCHAIN_PAY_TAKEBACK_SEED: SEED });
    check(d.settings().fee_ppm === 2000 && d.settings().fee_sats === 1000 && d.settings().min_sats === 10000, '0.120.5: the defaults are 1,000 sats + 0.2% and a 10,000-sat floor: ' + d.settings().fee_ppm + ' ppm');
    check(d.summary().topup === null, 'no top-up address until the operator asks');
    const t = await d.topupAddress();
    check(/^bc1q[0-9a-z]{20,}$/.test(t.address) && core.st.sent.length === 0 && d.summary().topup.address === t.address, '0.120.5: the top-up address comes from getnewaddress and sits on the pane: ' + t.address);
    const d2 = mk({ ONCHAIN_PAY_ENABLED: 'true', ONCHAIN_PAY_TAKEBACK_SEED: SEED });
    check(d2.summary().topup && d2.summary().topup.address === t.address, 'the top-up address survives a restart (float.json)'); }
  check(rail.capability().enabled === true && rail.capability().fee_sats === 1000 && rail.capability().refund_blocks === 144, 'capability as the settings say');

  // ── quote refusals ──
  const W = btc.pubkeyOf(crypto.createHash('sha256').update('wallet release key').digest()).toString('hex');
  const secret = crypto.createHash('sha256').update('the payment secret').digest(); const H = sha256Hex(secret);
  const base = { client_pubkey: CLIENT, node_pubkey: CLIENT, nonce: '00'.repeat(32), signature: '00'.repeat(64), payment_hash: H, amount_sats: 100000, release_fee_sats: 850, reserve_sats: 850, release_pubkey: W, recipient_address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3' };
  let r = await route(rail, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { amount_sats: 5000 })); check(r.status === 400 && /between 10000 and 2000000/.test(r.data.error), 'a quote below the floor is refused (0.120.4: the floor is 10,000)');
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { release_pubkey: '04' + 'aa'.repeat(32) })); check(r.status === 400, 'a bad release key is refused');
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { payment_hash: '66'.repeat(32), amount_sats: 1999000 })); check(r.status === 429 && /daily ceiling/.test(r.data.error), 'a lock over the daily ceiling is refused (' + r.status + ')');
  core.st.balance = 0.0005;   // NOT re-probed here: the quote must read the wallet itself (DP S66 23:39 — the actual remaining balance)
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { payment_hash: '66'.repeat(32) })); check(r.status === 503 && /float cannot cover/.test(r.data.error), 'a lock the float cannot cover is refused — read live, not from the last probe');
  core.st.balance = 0.0025;   // 250,000 sats: room for two locks of 101,700 but not three
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { payment_hash: '67'.repeat(32) })); check(r.status === 200, 'the first quote on a 250,000-sat float');
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { payment_hash: '68'.repeat(32) })); check(r.status === 200, 'the second (203,400 reserved)');
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { payment_hash: '69'.repeat(32) })); check(r.status === 503 && /float cannot cover/.test(r.data.error), 'the third is refused: the standing quotes already reserve the float, though the wallet still shows 250,000');
  check(rail.summary().reserved_sats === 203400 && rail.summary().remaining_sats === 250000 - 203400, 'the summary says what is reserved and what remains: ' + rail.summary().reserved_sats + ' / ' + rail.summary().remaining_sats);
  for (const h of ['67', '68']) { const x = rail.records().get(h.repeat(32)); x.state = 'expired'; x.ended_at = Date.now(); }   // the two quotes die
  core.st.balance = 0.05;
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { node_pubkey: OTHER })); check(r.status === 403, 'a quote signed by another key is refused');
  // ── the quote ──
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', base);
  check(r.status === 200 && r.data.ok, 'the quote answers: ' + JSON.stringify(r.data).slice(0, 120));
  const Q = r.data;
  check(Q.provider_fee_sats === 1000 && Q.lock_rate_sat_vb === 5 && Q.lock_fee_sats === 153 * 5 && Q.lock_sats === 101700, 'the money: provider 1,000; lock 153 vB × 5 = 765; lock 101,700');
  check(Q.a.amount_sats === 1765 && Q.a.hash !== H && Q.b.amount_sats === 101700 && Q.b.hash === H, 'A = fee + lock fee under the provider\'s hash; B = the lock amount under the wallet\'s hash');
  check(lnd.invoices.get(H).cltv === '200' && lnd.invoices.get(Q.a.hash).cltv === '40', 'B\'s expiry 200 blocks, A\'s 40');
  check(Q.L === rail.L && Q.refund_blocks === 144 && Q.stop_release_blocks === 12 && Q.min_conf === 1, 'L, the window, the stop margin, one confirmation');
  check(proofs[proofs.length - 1].recordId === 'quote:' + H, 'the proof is over quote:<hash>');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'onchain-pay', H + '.json'), 'utf8'));
  check(onDisk.state === 'quoted' && /^[0-9a-f]{64}$/.test(onDisk.hmac) && onDisk.client_pubkey === CLIENT, 'the record on disk, HMAC\'d, keyed by hash and client');
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', base); check(r.status === 409, 'the same hash again while open: 409');
  // ── another wallet cannot see or touch it ──
  r = await route(rail, 'POST', '/v1/onchain-pay/open', Object.assign({}, base, { client_pubkey: OTHER, node_pubkey: OTHER })); check(r.status === 404, 'another wallet\'s open on this hash: not found, never described');
  r = await route(rail, 'GET', '/v1/onchain-pay/status', null, '?client_pubkey=' + OTHER + '&node_pubkey=' + OTHER + '&nonce=00&signature=00'); check(r.status === 200 && r.data.payments.length === 0, 'another wallet\'s status lists nothing');
  // ── open, the two payments, the lock ──
  r = await route(rail, 'POST', '/v1/onchain-pay/open', base); check(r.status === 200 && r.data.state === 'opening', 'open: the state');
  check(proofs[proofs.length - 1].recordId === 'open:' + H, 'the proof is over open:<hash>');
  await tm.run(); check(rail.records().get(H).state === 'opening', 'one payment in: still opening');
  lnd.accept(Q.a.hash); await tm.run(); check(rail.records().get(H).state === 'opening', 'A alone: still opening');
  lnd.accept(H); await tm.run();
  const rec = rail.records().get(H);
  check(rec.state === 'locked', 'both in: LOCKED');
  { const spk = btc.p2wshScriptPubKey(Buffer.from(rec.script, 'hex')); const c = nt.scripts.get('conf:' + rec.lock_txids[0]), sp = nt.scripts.get('spend:' + rec.lock_txids[0] + ':' + rec.lock_vout);
    check(Buffer.isBuffer(c) && c.equals(spk) && Buffer.isBuffer(sp) && sp.equals(spk), '0.120.2: both watches registered with the hand-over output\'s script (LND requires it)');
    const hc = nt.hints.get('conf:' + rec.lock_txids[0]), hs = nt.hints.get('spend:' + rec.lock_txids[0] + ':' + rec.lock_vout);
    check(hc === rec.lock_block && hs === rec.lock_block && hc > 0, '0.120.3: both watches registered with the lock\'s block as the height hint (LND requires > 0; the backward scan\'s bound): ' + hc); }
  check(core.st.sent.length === 1 && core.st.sent[0].params.replaceable === true && core.st.sent[0].params.fee_rate === 5 && Math.round(core.st.sent[0].params.amount * 1e8) === 101700, 'the lock: sendtoaddress of 101,700 sats, replaceable, at the live rate');
  check(rec.T === 975000 + 144 && rec.lock_block === 975000, 'T = the block at the lock + 144');
  const script = btc.handoverScript(H, W, rail.L, rec.T);
  check(core.st.sent[0].params.address === btc.p2wshAddress(script) && rec.handover_address === core.st.sent[0].params.address, 'the hand-over address is the script of H, W, L, T');
  check(rec.lock_vout === 1 && rec.lock_txids.length === 1, 'the output index found from the transaction (the change sits at 0)');
  check(lnd.settled.length === 1 && lnd.settled[0] === Q.a.hash, 'A settled the moment the lock went; B not');
  check(nt.confs.has(rec.lock_txids[0]) && nt.spends.has(rec.lock_txids[0] + ':1'), 'the lock\'s confirmation and the hand-over output\'s spend are watched');
  check(pl.some((x) => x.k === 'onchain_pay_lock'), 'PL: the lock');
  // ── the lock confirms → the wake push ──
  await nt.confs.get(rec.lock_txids[0])({ height: 975001 });
  check(rec.state === 'lock_confirmed' && rec.lock_confirmed_block === 975001 && wake.length === 1 && wake[0].kind === 'onchain-pay' && wake[0].pk === CLIENT, 'lock confirmed: the state, the block, the wake push');
  // ── the release handed over ──
  const relSk = crypto.createHash('sha256').update('wallet release key').digest();
  const buildRelease = (sec) => {
    const tx = { version: 2, locktime: 0, inputs: [{ txid: rec.lock_txids[0], vout: 1, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: 100000, script: btc.addressToScript(base.recipient_address) }, { value: 850, script: btc.addressToScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4') }] };
    const h = btc.sighashBip143(tx, 0, script, 101700); tx.inputs[0].witness = [btc.signDer(h, relSk), sec, script]; return tx;
  };
  const bogus = buildRelease(Buffer.alloc(32, 1));
  r = await route(rail, 'POST', '/v1/onchain-pay/release', Object.assign({}, base, { tx_hex: btc.serialize(bogus, true).toString('hex') }));
  check(r.status === 400 && /not a release of this payment/.test(r.data.error), 'a transaction whose secret does not hash to H is refused');
  const rel = buildRelease(secret); const relHex = btc.serialize(rel, true).toString('hex');
  r = await route(rail, 'POST', '/v1/onchain-pay/release', Object.assign({}, base, { tx_hex: relHex }));
  check(r.status === 200 && r.data.rebroadcast === true && r.data.release_txid === btc.txid(rel), 'the release is taken, checked and rebroadcast');
  check(proofs[proofs.length - 1].recordId === 'release:' + H + ':' + sha256Hex(Buffer.from(relHex, 'hex')), 'the proof binds the transaction\'s bytes');
  check(core.st.raw[core.st.raw.length - 1] === relHex, 'sendrawtransaction got the release');
  check(lnd.settled.length === 1 && rec.secret === secret.toString('hex'), 'B is NOT settled at the hand-over; the secret is kept');
  // ── the release in a block → B settled ──
  await nt.spends.get(rec.lock_txids[0] + ':1')({ spending_txid: btc.txid(rel), height: 975010, raw_hex: relHex });
  check(rec.state === 'done' && lnd.settled.length === 2 && lnd.settled[1] === H && rec.release_block === 975010, 'the release in a block: B settled with the secret, done');
  check(pl.some((x) => x.k === 'onchain_pay_fee' && x.f.msat === 1000000), 'PL: the provider\'s fee');
  r = await route(rail, 'GET', '/v1/onchain-pay/status', null, '?client_pubkey=' + CLIENT + '&node_pubkey=' + CLIENT + '&nonce=00&signature=00');
  const mineDone = (r.data.payments || []).find((p) => p.hash === H);
  check(r.status === 200 && r.data.payments.length === 3 && mineDone && mineDone.state === 'done' && mineDone.release_txid === btc.txid(rel) && mineDone.stop_release_block === rec.T - 12 && r.data.payments.filter((p) => p.state === 'expired').length === 2, 'status: the wallet\'s own payments — the done one with its facts, the two expired quotes');
  check(!('secret' in r.data.payments[0]) && !('a_preimage' in r.data.payments[0]), 'status never carries the secrets');

  // ── the walk-away: a second payment, T reached, the take-back ──
  const secret2 = crypto.createHash('sha256').update('secret two').digest(); const H2 = sha256Hex(secret2);
  const base2 = Object.assign({}, base, { payment_hash: H2 });
  r = await route(rail, 'POST', '/v1/onchain-pay/quote', base2); check(r.status === 200, 'a second quote');
  const Q2 = r.data;
  r = await route(rail, 'POST', '/v1/onchain-pay/open', base2); lnd.accept(Q2.a.hash); lnd.accept(H2); await tm.run();
  const rec2 = rail.records().get(H2); check(rec2.state === 'locked', 'the second lock');
  core.st.txs.get(rec2.lock_txids[0]).confirmations = 1;
  await nt.confs.get(rec2.lock_txids[0])({ height: 975002 });
  core.st.tip = rec2.T - 1; await rail.tick(); check(rec2.state === 'lock_confirmed' && core.st.raw.length === 1, 'one block before T: nothing sent');
  core.st.tip = rec2.T; await rail.tick();
  check(rec2.state === 'taking_back' && rec2.takeback_txids.length === 1, 'at T: the take-back sent');
  const tb = btc.parse(core.st.raw[core.st.raw.length - 1]);
  check(tb.locktime === rec2.T && tb.inputs[0].txid === rec2.lock_txids[0] && tb.inputs[0].vout === rec2.lock_vout && tb.inputs[0].sequence === 0xfffffffd, 'the take-back spends the lock at T, replaceable');
  check(tb.outputs.length === 1 && tb.outputs[0].script.equals(btc.addressToScript(core.floatAddr)) && tb.outputs[0].value + rec2.takeback_fee_sats === 101700, 'to the float\'s own address, value less fee');
  check(core.st.calls.some((c) => c.method === 'getaddressinfo') && core.st.calls.some((c) => c.method === 'testmempoolaccept') && core.st.calls.filter((c) => c.method === 'gettransaction' && c.params[0] === rec2.lock_txids[0]).length >= 1, 'controls: the destination checked, the mempool asked first, the lock re-read');
  const w = tb.inputs[0].witness; const sh = btc.sighashBip143(tb, 0, btc.handoverScript(H2, W, rail.L, rec2.T), 101700);
  check(w.length === 3 && w[1].length === 0 && btc.verifyDer(sh, w[0], Buffer.from(rail.L, 'hex')), 'signed by L over the rebuilt script');
  await nt.spends.get(rec2.lock_txids[0] + ':' + rec2.lock_vout)({ spending_txid: rec2.takeback_txids[0], height: rec2.T + 1, raw_hex: core.st.raw[core.st.raw.length - 1] });
  check(rec2.state === 'taken_back' && lnd.cancelled.includes(H2) && !lnd.settled.includes(H2), 'the take-back in a block: B cancelled, never settled');
  check(pl.some((x) => x.k === 'onchain_pay_takeback'), 'PL: the take-back\'s chain cost');
  // ── the controls refuse: a tampered record; a destination not ours; a lock that does not match ──
  {
    const secret3 = crypto.createHash('sha256').update('secret three').digest(); const H3 = sha256Hex(secret3);
    const base3 = Object.assign({}, base, { payment_hash: H3 });
    await route(rail, 'POST', '/v1/onchain-pay/quote', base3); const Q3 = (await route(rail, 'GET', '/v1/onchain-pay/status', null, '?client_pubkey=' + CLIENT + '&node_pubkey=' + CLIENT + '&nonce=00&signature=00')).data.payments.find((p) => p.hash === H3);
    void Q3; await route(rail, 'POST', '/v1/onchain-pay/open', base3); lnd.accept(rail.records().get(H3).a_hash); lnd.accept(H3); await tm.run();
    const rec3 = rail.records().get(H3); core.st.txs.get(rec3.lock_txids[0]).confirmations = 1; core.st.tip = rec3.T;
    const before = core.st.raw.length;
    rec3.lock_sats = 1; await rail._takeBack(rec3, core.st.tip); check(core.st.raw.length === before && /record HMAC mismatch/.test(logs[logs.length - 1]), 'control 1: an edited record (the amount) is refused');
    rec3.lock_sats = 101700;
    core.st.ismine = false; await rail._takeBack(rec3, core.st.tip); check(core.st.raw.length === before && /not the float/.test(logs[logs.length - 1]), 'control 3: a destination the float does not own is refused'); core.st.ismine = true;
    core.st.mempoolOk = false; await rail._takeBack(rec3, core.st.tip); check(core.st.raw.length === before && rec3.takeback_error && /non-final/.test(rec3.takeback_error), 'control 5: a mempool refusal stops the send'); core.st.mempoolOk = true;
    const realHex = core.st.txs.get(rec3.lock_txids[0]).hex; core.st.txs.get(rec3.lock_txids[0]).hex = core.st.txs.get(rec2.lock_txids[0]).hex;
    await rail._takeBack(rec3, core.st.tip); check(core.st.raw.length === before && /does not match the record/.test(logs[logs.length - 1]), 'control 2: the lock on the chain must match the rebuilt script and amount'); core.st.txs.get(rec3.lock_txids[0]).hex = realHex;
    await rail._takeBack(rec3, core.st.tip - 1); check(core.st.raw.length === before, 'control 4: never before T');
    await rail._takeBack(rec3, core.st.tip); check(core.st.raw.length === before + 1 && rec3.state === 'taking_back', 'with every control passed, the take-back goes');
  }
  // ── Off: new quotes refused, the open ones run ──
  {
    const off = mk(Object.assign({}, ENV, { ONCHAIN_PAY_ENABLED: 'false' })); await off.boot();
    const secret4 = crypto.createHash('sha256').update('secret four').digest(); const H4 = sha256Hex(secret4);
    r = await route(off, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { payment_hash: H4 })); check(r.status === 503 && /does not offer/.test(r.data.error), 'Off: a new quote is refused');
    const r3 = off.records().get(rail.records().keys().next().value); check(off.records().size >= 3 && off.capability().enabled === false, 'Off: the records are still loaded (' + off.records().size + '), the capability says not enabled');
    void r3;
    check(/new payments OFF \(open ones run to their end\)/.test(logs.find((l) => /float: / .test(l) && /OFF/.test(l)) || ''), 'the boot line says so');
  }
  // ── the fence open: quotes refused ──
  { core.st.fence = 'open'; const f = mk(ENV); await f.boot(); r = await route(f, 'POST', '/v1/onchain-pay/quote', Object.assign({}, base, { payment_hash: '77'.repeat(32) })); check(r.status === 503 && /NOT fenced/.test(r.data.error), 'an open fence refuses quotes: ' + r.data.error); core.st.fence = 'ok'; }
  // ── the restart: records survive, watches re-armed; an edited file is ignored ──
  {
    const p = path.join(dir, 'onchain-pay', H + '.json'); const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.amount_sats = 999; fs.writeFileSync(p, JSON.stringify(j));
    nt.confs.clear(); nt.spends.clear();
    const again = mk(ENV); await again.boot();
    check(!again.records().has(H) && again.summary().boot_refused.includes(H), 'an edited record on disk fails its HMAC and is ignored at boot');
    check(again.records().has(H2) && again.records().get(H2).state === 'taken_back', 'the others load');
    const open3 = Array.from(again.records().values()).find((x) => x.state === 'taking_back');
    check(open3 && nt.spends.has(open3.lock_txids[0] + ':' + open3.lock_vout), 'an open payment\'s spend watch is re-armed after the restart');
  }
  // ── the summary (the Float pane) ──
  const sm = rail.summary();
  check(sm.float.ok === true && sm.take_back_key === rail.L && sm.provider_fees_sats >= 1000 && Array.isArray(sm.ended) && sm.ended.some((e) => e.state === 'done') && sm.ended.some((e) => e.state === 'taken_back'), 'the Float pane\'s summary: the float, L, fees earned, the ended rows');
  console.log((bad ? 'FAIL' : 'PASS') + ' · onchain-pay.test.js · ' + (n - bad) + ' passed, ' + bad + ' failed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL · threw: ' + (e.stack || e)); process.exit(1); });
