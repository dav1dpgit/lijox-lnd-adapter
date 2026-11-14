'use strict';
// tower-drill.js — 0.129.0 (S69 Sat 2026-11-14, DP "I like this, do it": one drill per provider, once, at joining).
// THE ONLY CHECK THAT PROVES A TOWER PUBLISHES. A tower that says it is watching and that accepts and holds items has
// shown nothing about what it does when an old state appears in a block. The drill makes that happen, with the
// drilling operator's own coins and no channel involved:
//   1. this box's LND funds and signs — and does NOT publish — a small transaction T1 that pays `sats` to a script
//      only this module can spend (a one-time key made for the drill);
//   2. this module signs T2, which spends T1's output back to this box's own wallet (to T1's change script);
//   3. T2 is encrypted under T1's id and put at the tower under T1's hint, with a one-time sign-in key — exactly what
//      a wallet uploads for a replaced channel state;
//   4. T1 is published. To the tower, T1 in a block is "an old state it holds an answer for";
//   5. a tower that works publishes T2 by itself. Nobody else has T2: this module publishes it only AFTER the
//      deadline, to take the coins back, and by then the drill has already failed.
// PASS: T2 is in a block at most DEADLINE_BLOCKS above T1's block and this module had not published it.
// FAIL: the deadline passed without T2; this module publishes T2 itself and says so.
// The cost is the two transactions' fees. The coins return to this box's wallet either way.
// Everything outside (LND, the chain reads, the HTTP post) is handed in, so this file runs against stand-ins.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const btc = require('./btc-tx.js');
const schnorr = require('./schnorr.js');
const T = require('./tower.js');
const { parseBlock } = require('./tower-watch.js');

const DEADLINE_BLOCKS = 6;        // T2 must be in a block at most this many above T1's
const STUCK_BLOCKS = 144;         // T1 not in a block after a day: said, and left for the operator
const SCAN_PER_TICK = 12;
const SATS_MIN = 5000, SATS_MAX = 100000;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/// T2: spends T1's output `vout` (value `value`, a P2WSH of `script`) to `destScript`, signed with `key`.
function buildAnswer({ t1Txid, vout, value, script, key, destScript, feeSats }) {
  const tx = { version: 2, locktime: 0, inputs: [{ txid: t1Txid, vout, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: value - feeSats, script: destScript }] };
  if (tx.outputs[0].value < 546) throw new Error('the drill amount is too small for its return fee');
  const sig = btc.signDer(btc.sighashBip143(tx, 0, script, value, btc.SIGHASH_ALL), key, btc.SIGHASH_ALL);
  tx.inputs[0].witness = [sig, script];
  return { hex: btc.serialize(tx, true).toString('hex'), txid: btc.txid(tx), vsize: btc.vsize(tx) };
}

function createTowerDrill(opts) {
  const lnd = opts.lnd, chain = opts.chain, post = opts.post;
  const log = opts.log || function () {};
  const now = opts.now || (() => Date.now());
  const rand = opts.rand || ((n) => crypto.randomBytes(n));
  const hrp = opts.hrp || 'bc';
  const dir = path.join(opts.dataDir, 'tower');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const file = path.join(dir, 'drills.json');
  let recs = [];
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j)) recs = j; } catch (e) {}
  const save = () => { const t = file + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(recs), { mode: 0o600 }); fs.renameSync(t, file); };
  let busy = false;

  const signed = (action, sk, key, group, items) => {
    const b = { key, ts: Math.floor(now() / 1000) }; let ish = '';
    if (action !== 'status') b.group = group;
    if (action === 'put') { b.items = items.map((i) => ({ hint: i.hint, blob: i.blob.toString('base64') })); ish = T.itemsSha(items); }
    b.signature = schnorr.sign(sk, sha256(Buffer.from(T.signedText(action, key, action === 'status' ? '' : group, b.ts, ish), 'utf8')), Buffer.alloc(32)).toString('hex');
    return b;
  };

  /// Start a drill of `tower` ({ pubkey, name, endpoint }). → the record. Throws in words when it cannot start;
  /// nothing is published unless the tower has accepted the item.
  async function start(tower, sats) {
    sats = Math.floor(Number(sats) || 20000);
    if (sats < SATS_MIN || sats > SATS_MAX) throw new Error(`the drill amount must be between ${SATS_MIN} and ${SATS_MAX} sats`);
    if (!tower || !/^0[23][0-9a-f]{64}$/.test(String(tower.pubkey || '')) || !/^https:\/\//.test(String(tower.endpoint || ''))) throw new Error('the tower must be a listed provider with an https address');
    if (recs.some((r) => r.tower === tower.pubkey && ['waiting_t1', 'watching', 'recovering'].includes(r.state))) throw new Error('a drill of that tower is already running');
    const best = await chain.bestBlock();
    if (!best || !Number.isSafeInteger(best.height)) throw new Error('this box cannot read the chain (the drill needs the three block reads)');
    // the one-time key and the script only it can spend: <pubkey> OP_CHECKSIG, as P2WSH
    const key = rand(32);
    const script = Buffer.concat([btc.pushData(btc.pubkeyOf(key)), Buffer.from([0xac])]);
    const address = btc.p2wshAddress(script, hrp);
    // T1: funded and signed by LND, not published
    const funded = await lnd.fundPsbt({ raw: { outputs: { [address]: String(sats) } }, target_conf: 3, min_confs: 1 });
    if (!funded || !funded.funded_psbt) throw new Error('FundPsbt answered no transaction: ' + JSON.stringify(funded).slice(0, 160));
    const fin = await lnd.finalizePsbt({ funded_psbt: funded.funded_psbt });
    if (!fin || !fin.raw_final_tx) throw new Error('FinalizePsbt answered no transaction: ' + JSON.stringify(fin).slice(0, 160));
    const t1Hex = Buffer.from(fin.raw_final_tx, 'base64').toString('hex');
    const t1 = btc.parse(t1Hex), t1Txid = btc.txid(t1);
    const want = btc.p2wshScriptPubKey(script);
    const vout = t1.outputs.findIndex((o) => o.script.equals(want) && o.value === sats);
    if (vout < 0) throw new Error('the funded transaction does not pay the drill script');
    const change = t1.outputs.find((o, i) => i !== vout);
    if (!change) throw new Error('the funded transaction has no change output to return the coins to — try another amount');
    // T2: back to this box's own wallet (T1's change script), at twice the rate LND estimates for two blocks
    const rate = Math.max(2, Math.ceil(2 * (Number(await lnd.estimateFeeSatVb(2)) || 1)));
    const probe = buildAnswer({ t1Txid, vout, value: sats, script, key, destScript: change.script, feeSats: 0 });
    const t2 = buildAnswer({ t1Txid, vout, value: sats, script, key, destScript: change.script, feeSats: probe.vsize * rate });
    // the item, put at the tower with a one-time sign-in key
    const sk = rand(32), pk = schnorr.pubkey(sk).toString('hex'), group = rand(16).toString('hex');
    const items = [{ hint: T.hintOf(t1Txid), blob: T.encrypt(Buffer.from(t2.hex, 'hex'), t1Txid) }];
    const base = String(tower.endpoint).replace(/\/+$/, '');
    const put = await post(base + '/v1/tower/put', signed('put', sk, pk, group, items));
    if (!(put && put.status === 200 && put.json && put.json.ok && put.json.kept === 1)) {
      // nothing was published: the funded coins are only leased by LND and come free on their own
      throw new Error(`the tower did not accept the item (${put ? put.status + (put.json && put.json.code ? ' ' + put.json.code : '') : 'no answer'}) — nothing was published`);
    }
    const rec = { id: rand(8).toString('hex'), tower: tower.pubkey, name: String(tower.name || ''), endpoint: base, sats, started_ms: now(), start_height: best.height, scanned: best.height - 1,
      t1_txid: t1Txid, t1_hex: t1Hex, t2_txid: t2.txid, t2_hex: t2.hex, t2_fee_sats: probe.vsize * rate, key: key.toString('hex'), sk: sk.toString('hex'), group,
      state: 'waiting_t1', t1_height: null, t2_height: null, published_t2_ourselves: false, note: '' };
    recs.push(rec); save();   // on disk BEFORE T1 goes out: T2 and its key must survive a stop
    await lnd.publish(t1Hex);
    log(`[TOWER-DRILL] ${rec.id}: drill of ${rec.name || rec.tower.slice(0, 12)} started — ${sats} sats; T1 ${t1Txid} published; the tower holds the answer ${t2.txid} and must publish it within ${DEADLINE_BLOCKS} blocks of T1's block`);
    return view(rec);
  }

  async function finish(rec, state, note) {
    rec.state = state; rec.note = note; rec.ended_ms = now(); save();
    log(`[TOWER-DRILL] ${rec.id}: ${state === 'passed' ? 'PASSED' : state === 'failed' ? 'FAILED' : state.toUpperCase()} — ${rec.name || rec.tower.slice(0, 12)}: ${note}`);
    try { const sk = Buffer.from(rec.sk, 'hex'); await post(rec.endpoint + '/v1/tower/drop', signed('drop', sk, schnorr.pubkey(sk).toString('hex'), rec.group, null)); } catch (e) {}
  }

  /// One look at the chain for every running drill. Safe on a timer.
  async function tick() {
    if (busy) return;
    const live = recs.filter((r) => ['waiting_t1', 'watching', 'recovering'].includes(r.state));
    if (!live.length) return;
    busy = true;
    try {
      const best = await chain.bestBlock();
      if (!best || !Number.isSafeInteger(best.height)) return;
      for (const rec of live) {
        let n = 0;
        for (let h = rec.scanned + 1; h <= best.height && n < SCAN_PER_TICK; h++, n++) {
          const hash = h === best.height ? best.hash : await chain.blockHash(h);
          const ids = parseBlock(await chain.block(hash)).txs.map((t) => t.txid);
          if (rec.t1_height === null && ids.includes(rec.t1_txid)) { rec.t1_height = h; if (rec.state === 'waiting_t1') rec.state = 'watching'; log(`[TOWER-DRILL] ${rec.id}: T1 is in block ${h}; the tower has until block ${h + DEADLINE_BLOCKS}`); }
          if (rec.t2_height === null && ids.includes(rec.t2_txid)) rec.t2_height = h;
          rec.scanned = h;
        }
        save();
        if (rec.t2_height !== null) {
          if (rec.state === 'recovering') { await finish(rec, 'failed', `the tower did not publish the answer within ${DEADLINE_BLOCKS} blocks; this box published it itself and it is in block ${rec.t2_height} — the coins are back`); continue; }
          if (!rec.published_t2_ourselves) { await finish(rec, 'passed', `the tower published the answer by itself — T1 in block ${rec.t1_height}, the answer in block ${rec.t2_height}`); continue; }
        }
        if (rec.state === 'watching' && rec.scanned >= rec.t1_height + DEADLINE_BLOCKS && rec.t2_height === null) {
          rec.published_t2_ourselves = true; rec.state = 'recovering'; save();   // written BEFORE the publish: from here a T2 in a block is ours
          log(`[TOWER-DRILL] ${rec.id}: no answer from the tower by block ${rec.scanned} — FAILING; this box publishes the answer itself to take the coins back`);
          try { await lnd.publish(rec.t2_hex); } catch (e) { rec.note = 'publishing the answer was refused: ' + String(e.message || e).slice(0, 120); save(); }
          continue;
        }
        if (rec.state === 'recovering') { try { await lnd.publish(rec.t2_hex); } catch (e) {} }   // again on each look until it is in a block
        if (rec.state === 'waiting_t1' && rec.scanned >= rec.start_height + STUCK_BLOCKS) await finish(rec, 'stuck', `T1 ${rec.t1_txid} is not in a block after ${STUCK_BLOCKS} blocks — look at this box's wallet; the answer (${rec.t2_txid}) is kept in the drill record`);
      }
    } catch (e) { log(`[TOWER-DRILL] a look at the chain failed: ${String(e.message || e).slice(0, 160)}`); }
    finally { busy = false; }
  }

  const view = (r) => ({ id: r.id, tower: r.tower, name: r.name, sats: r.sats, state: r.state, note: r.note, started_ms: r.started_ms, ended_ms: r.ended_ms || null, t1_txid: r.t1_txid, t2_txid: r.t2_txid, t1_height: r.t1_height, t2_height: r.t2_height, t2_fee_sats: r.t2_fee_sats, published_t2_ourselves: r.published_t2_ourselves });
  const list = () => recs.map(view);
  /// The latest finished drill of a tower, for the record ("drilled: passed on <date>").
  const lastOf = (pubkey) => { const a = recs.filter((r) => r.tower === pubkey && (r.state === 'passed' || r.state === 'failed')); return a.length ? view(a[a.length - 1]) : null; };
  return { start, tick, list, lastOf };
}

module.exports = { createTowerDrill, buildAnswer, DEADLINE_BLOCKS, SATS_MIN, SATS_MAX };
