// tower-drill.test.js — the joining drill (0.129.0), against a stand-in chain and LND, with the REAL holder (tower.js)
// and the REAL block watch (tower-watch.js) playing the tower that is drilled.
//   node tower-drill.test.js
const D = require(require('path').join(__dirname, 'tower-drill.js'));
const T = require('./tower.js'); const W = require('./tower-watch.js'); const btc = require('./btc-tx.js');
const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
let pass = 0, fail = 0; const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };
const dsha = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();
const vi = (n) => n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 255, n >> 8]);

// ── one chain, one mempool ──
function world() {
  const chain = new Map(); let tip = 500; const mempool = [];
  const mk = (height, hexes) => { const h = Buffer.alloc(80); h.writeUInt32LE(height, 76); h.writeUInt32LE(Math.floor(Math.random() * 1e9), 4); const coinbase = btc.serialize({ version: 2, locktime: 0, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, sequence: 0xffffffff, witness: [] }], outputs: [{ value: 1, script: Buffer.from('51', 'hex') }] }, false); const raw = Buffer.concat([h, vi(hexes.length + 1), coinbase].concat(hexes.map((x) => Buffer.from(x, 'hex')))); return { raw, hash: dsha(h).toString('base64') }; };
  chain.set(tip, mk(tip, []));
  return {
    mempool, chain,
    mine: (only) => { const take = only ? mempool.filter(only) : mempool.slice(); for (const x of take) mempool.splice(mempool.indexOf(x), 1); tip++; chain.set(tip, mk(tip, take)); return tip; },
    reads: { bestBlock: async () => ({ height: tip, hash: chain.get(tip).hash }), blockHash: async (h) => chain.get(h).hash, block: async (hash) => { for (const v of chain.values()) if (v.hash === hash) return v.raw; throw new Error('no such block'); } },
    tip: () => tip,
  };
}
// the drilling box's LND: funds T1 from a coin of its own, with a change output
function lndOf(w, { noChange = false } = {}) {
  const changeScript = Buffer.from('0014' + '77'.repeat(20), 'hex');
  let last = null;
  return {
    changeScript, published: [],
    fundPsbt: async (body) => { const [addr, amt] = Object.entries(body.raw.outputs)[0]; last = { script: btc.addressToScript(addr), sats: Number(amt) }; return { funded_psbt: 'cHNidA==' }; },
    finalizePsbt: async () => { const tx = { version: 2, locktime: 0, inputs: [{ txid: 'c0'.repeat(32), vout: 1, sequence: 0xfffffffd, witness: [Buffer.alloc(71, 1), Buffer.alloc(33, 2)] }], outputs: noChange ? [{ value: last.sats, script: last.script }] : [{ value: 300000 - last.sats - 400, script: changeScript }, { value: last.sats, script: last.script }] }; return { raw_final_tx: btc.serialize(tx, true).toString('base64') }; },
    estimateFeeSatVb: async () => 3,
    publish: async function (hex) { this.published.push(hex); if (!w.mempool.includes(hex)) w.mempool.push(hex); },
  };
}
// the tower that is drilled: the real holder and watch behind the adapter's request check
function towerOf(w, { publishes = true, accepts = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-twr-'));
  const tower = T.createTower({ dataDir: dir, log() {} });
  const published = [];
  const watch = W.createTowerWatch({ tower, dataDir: dir, log() {}, lnd: Object.assign({}, w.reads, { publish: async (hex) => { if (!publishes) throw new Error('broken'); published.push(hex); if (!w.mempool.includes(hex)) w.mempool.push(hex); } }) });
  const post = async (url, body) => {
    const action = url.split('/').pop();
    if (!accepts) return { status: 503, json: { ok: false, code: 'not_watching' } };
    const v = T.verifyRequest(action, body, Math.floor(Date.now() / 1000));
    if (!v.ok) return { status: v.code === 'signature' ? 401 : 400, json: { ok: false, code: v.code } };
    if (action === 'put') return { status: 200, json: tower.put(body.key, body.group, v.items) };
    if (action === 'drop') return { status: 200, json: tower.drop(body.key, body.group) };
    return { status: 200, json: tower.status(body.key) };
  };
  return { tower, watch, post, published };
}
const TWR = { pubkey: '03' + 'b'.repeat(64), name: 'Provider B', endpoint: 'https://lsp-b.test' };
const mkDrill = (w, lnd, tw, lines) => D.createTowerDrill({ lnd, chain: w.reads, post: tw.post, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'drill-')), log: (l) => lines.push(l) });

(async () => {
  // ── a tower that works ──
  {
    const w = world(), lnd = lndOf(w), tw = towerOf(w), lines = [];
    await tw.watch.poll();   // the tower is watching from the tip
    const drill = mkDrill(w, lnd, tw, lines);
    const rec = await drill.start(TWR, 20000);
    t('the drill starts: T1 is published, the tower holds one item, the record waits for T1', rec.state === 'waiting_t1' && lnd.published.length === 1 && tw.tower.summary().items === 1 && w.mempool.length === 1);
    const t1 = btc.parse(lnd.published[0]), t2raw = (() => { const m = tw.tower.match([rec.t1_txid]); return tw.tower.open(rec.t1_txid, m[0].held[0].blob); })();
    t('what the tower holds opens, under T1\'s id, into a transaction that spends T1 and nothing else', t2raw.ok === true && t2raw.penalty_txid === rec.t2_txid);
    const t2 = btc.parse(t2raw.tx_hex), vout = t2.inputs[0].vout, script = t2.inputs[0].witness[1];
    t('T1 pays the drill amount to the one-time script (P2WSH)', t1.outputs[vout].value === 20000 && t1.outputs[vout].script.equals(btc.p2wshScriptPubKey(script)));
    const sig = t2.inputs[0].witness[0];
    t('T2\'s signature is valid for that script and amount', btc.verifyDer(btc.sighashBip143(t2, 0, script, 20000, btc.SIGHASH_ALL), sig, script.subarray(1, 34)) && !btc.verifyDer(btc.sighashBip143(t2, 0, script, 20001, btc.SIGHASH_ALL), sig, script.subarray(1, 34)));
    t('T2 returns the coins to this box\'s own wallet, less a fee at twice the estimate', t2.outputs.length === 1 && t2.outputs[0].script.equals(lnd.changeScript) && 20000 - t2.outputs[0].value === rec.t2_fee_sats && rec.t2_fee_sats === btc.vsize(t2) * 6);
    await drill.tick();
    t('before T1 is in a block nothing moves', drill.list()[0].state === 'waiting_t1' && tw.published.length === 0);
    w.mine(); await tw.watch.poll();   // T1 in a block: the tower sees it and publishes the answer
    t('the tower, seeing T1 in a block, publishes the answer by itself', tw.published.length === 1 && tw.published[0] === t2raw.tx_hex && lnd.published.length === 1);
    await drill.tick();
    t('the drill sees T1\'s block and watches', drill.list()[0].state === 'watching' && drill.list()[0].t1_height === 501);
    w.mine(); await drill.tick();
    const done = drill.list()[0];
    t('the answer is in the next block: PASSED, and this box never published it', done.state === 'passed' && done.t2_height === 502 && done.published_t2_ourselves === false && lnd.published.length === 1, JSON.stringify(done));
    t('the journal says it', lines.some((l) => /PASSED/.test(l) && /published the answer by itself/.test(l)));
    t('the tower is told the drill is over (the item is dropped)', tw.tower.summary().items === 0);
    t('the record for the Console names the pass', drill.lastOf(TWR.pubkey).state === 'passed');
  }
  // ── a tower that accepts and holds but does not publish ──
  {
    const w = world(), lnd = lndOf(w), tw = towerOf(w, { publishes: false }), lines = [];
    await tw.watch.poll();
    const drill = mkDrill(w, lnd, tw, lines);
    await drill.start(TWR, 20000);
    w.mine(); await tw.watch.poll(); await drill.tick();
    for (let i = 0; i < 5; i++) { w.mine(); await tw.watch.poll(); await drill.tick(); }
    t('five blocks above T1: still watching, this box has published nothing more', drill.list()[0].state === 'watching' && lnd.published.length === 1);
    w.mine(); await tw.watch.poll(); await drill.tick();
    t('the sixth block without the answer: this box publishes it itself to take the coins back', drill.list()[0].state === 'recovering' && lnd.published.length === 2 && drill.list()[0].published_t2_ourselves === true);
    w.mine(); await drill.tick();
    const done = drill.list()[0];
    t('…and the drill is FAILED, in words', done.state === 'failed' && /did not publish the answer within 6 blocks/.test(done.note) && lines.some((l) => /FAILED/.test(l)));
  }
  // ── a tower that refuses the item ──
  {
    const w = world(), lnd = lndOf(w), tw = towerOf(w, { accepts: false }), lines = [];
    const drill = mkDrill(w, lnd, tw, lines);
    let err = ''; try { await drill.start(TWR, 20000); } catch (e) { err = e.message; }
    t('the tower refuses the item: the drill does not start and NOTHING is published', /did not accept the item \(503 not_watching\)/.test(err) && lnd.published.length === 0 && drill.list().length === 0, err);
  }
  // ── the guards ──
  {
    const w = world(), lines = [];
    const drill = mkDrill(w, lndOf(w, { noChange: true }), towerOf(w), lines);
    let e1 = '', e2 = '', e3 = '';
    try { await drill.start(TWR, 20000); } catch (e) { e1 = e.message; }
    try { await drill.start(TWR, 100); } catch (e) { e2 = e.message; }
    try { await drill.start({ pubkey: 'xx', endpoint: 'https://x.test' }, 20000); } catch (e) { e3 = e.message; }
    t('no change output to return to, an amount out of bounds, a tower that is not a provider: refused in words', /no change output/.test(e1) && /between 5000 and 100000/.test(e2) && /listed provider/.test(e3));
    const w2 = world(), lnd2 = lndOf(w2), tw2 = towerOf(w2), d2 = mkDrill(w2, lnd2, tw2, lines);
    await d2.start(TWR, 20000); let e4 = ''; try { await d2.start(TWR, 20000); } catch (e) { e4 = e.message; }
    t('one drill of a tower at a time', /already running/.test(e4));
  }
  // ── a stop and a start in the middle ──
  {
    const w = world(), lnd = lndOf(w), tw = towerOf(w), lines = [];
    await tw.watch.poll();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-'));
    let drill = D.createTowerDrill({ lnd, chain: w.reads, post: tw.post, dataDir: dir, log: (l) => lines.push(l) });
    await drill.start(TWR, 20000);
    t('the record on disk is readable only by its owner', (fs.statSync(path.join(dir, 'tower', 'drills.json')).mode & 0o077) === 0);
    drill = D.createTowerDrill({ lnd, chain: w.reads, post: tw.post, dataDir: dir, log: (l) => lines.push(l) });   // the box restarted
    w.mine(); await tw.watch.poll(); w.mine(); await drill.tick();
    t('after a restart the drill is picked up from disk and finishes', drill.list()[0].state === 'passed');
  }
  console.log(`${fail ? 'FAIL' : 'PASS'} · tower-drill · ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
