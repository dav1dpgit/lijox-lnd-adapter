// tower-watch.test.js — the tower's block watch (S69), with a stand-in for LND's three block reads.
//   node tower-watch.test.js
const W = require(require('path').join(__dirname, 'tower-watch.js'));
const T = require('./tower.js'); const btc = require('./btc-tx.js');
const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
let pass = 0, fail = 0; const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };
const dsha = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();
const vi = (n) => n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 255, n >> 8]);
const mkTx = (seed, wit) => ({ version: 2, locktime: 0, inputs: [{ txid: crypto.createHash('sha256').update('in' + seed).digest('hex'), vout: 0, sequence: 0xfffffffd, witness: wit ? [Buffer.alloc(71, 1), Buffer.alloc(33, 2)] : [] }], outputs: [{ value: 70000, script: Buffer.from('0020' + '22'.repeat(32), 'hex') }, { value: 29000, script: Buffer.from('0014' + '33'.repeat(20), 'hex') }] });
// a block: an 80-byte header (the nonce makes each one different) ‖ count ‖ transactions with their witnesses
const mkBlock = (nonce, txs) => { const h = Buffer.alloc(80); h.writeUInt32LE(nonce, 76); const raw = Buffer.concat([h, vi(txs.length)].concat(txs.map((x) => btc.serialize(x, true)))); return { raw, hash: dsha(h).toString('base64') }; };

// ── the block reader ──
const a = mkTx('a', true), b = mkTx('b', false), c = mkTx('c', true);
const B1 = mkBlock(1, [a, b, c]);
const p1 = W.parseBlock(B1.raw);
t('a block gives its three transaction ids', p1.txs.length === 3 && p1.txs[0].txid === btc.txid(a) && p1.txs[1].txid === btc.txid(b) && p1.txs[2].txid === btc.txid(c));
t('the id of a transaction with a witness leaves the witness out', p1.txs[0].txid !== dsha(btc.serialize(a, true)).reverse().toString('hex'));
t('the header hash is given the way LND\'s REST gives it', p1.hash === B1.hash);
t('each transaction\'s own bytes are marked', btc.txid(btc.parse(B1.raw.subarray(p1.txs[2].start, p1.txs[2].end).toString('hex'))) === btc.txid(c));
let threw = 0; for (const bad of [B1.raw.subarray(0, B1.raw.length - 3), Buffer.concat([B1.raw, Buffer.from([0])]), Buffer.alloc(40), 'text']) { try { W.parseBlock(bad); } catch (e) { threw++; } }
t('a block cut short, with bytes after it, or not a block at all is refused', threw === 4);
const many = []; for (let i = 0; i < 300; i++) many.push(mkTx('m' + i, i % 2 === 0));
t('300 transactions (a three-byte count) are read', W.parseBlock(mkBlock(9, many).raw).txs.length === 300);

// ── a chain, a holder, a watch ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'towerwatch-'));
let clock = 1794550000000; const lines = [];
const tower = T.createTower({ dataDir: tmp, log: (l) => lines.push(l), now: () => clock });
const oldState = mkTx('old', true); const OLD = btc.txid(oldState);
const penalty = (fee) => btc.serialize({ version: 2, locktime: 0, inputs: [{ txid: OLD, vout: 0, sequence: 0xffffffff, witness: [Buffer.alloc(71, 1), Buffer.from([1]), Buffer.alloc(77, 2)] }], outputs: [{ value: 70000 - fee, script: Buffer.from('0014' + '44'.repeat(20), 'hex') }] });
const pLow = penalty(600), pHigh = penalty(1500);
const key = 'a7'.repeat(32), group = 'c1'.repeat(16);
tower.put(key, group, [{ hint: T.hintOf(OLD), blob: T.encrypt(pLow, OLD) }, { hint: T.hintOf(OLD), blob: T.encrypt(pHigh, OLD) }]);
// an item under the same hint that is NOT a penalty for that transaction (it spends something else)
const stray = btc.serialize({ version: 2, locktime: 0, inputs: [{ txid: 'ee'.repeat(32), vout: 0, sequence: 0xffffffff, witness: [] }], outputs: [{ value: 1000, script: Buffer.from('0014' + '55'.repeat(20), 'hex') }] });
tower.put('b8'.repeat(32), group, [{ hint: T.hintOf(OLD), blob: T.encrypt(stray, OLD) }]);

const chain = new Map();   // height → block
let tip = 100; chain.set(100, mkBlock(100, [mkTx('h100', false)]));
const sent = []; let refuse = () => null; let calls = { best: 0, hash: 0, block: 0 };
const lnd = {
  bestBlock: async () => { calls.best++; return { height: tip, hash: chain.get(tip).hash }; },
  blockHash: async (h) => { calls.hash++; return chain.get(h).hash; },
  block: async (hash) => { calls.block++; for (const v of chain.values()) if (v.hash === hash) return v.raw; throw new Error('no such block'); },
  publish: async (hex) => { const why = refuse(hex); if (why) throw new Error(why); sent.push(hex); },
};
const mk = () => W.createTowerWatch({ tower, lnd, dataDir: tmp, log: (l) => lines.push(l), now: () => clock });
(async () => {
  let w = mk();
  const pr = await w.probe();
  t('the probe does the three reads end to end', pr.ok === true && pr.height === 100 && pr.txs === 1 && calls.best === 1 && calls.hash === 1 && calls.block === 1);
  const real = lnd.block; lnd.block = async () => { throw new Error('permission denied'); };
  const pr2 = await w.probe(); lnd.block = real;
  t('a key that cannot read a block fails the probe in words', pr2.ok === false && /permission denied/.test(pr2.why));
  lnd.block = async () => chain.get(100).raw.subarray(0, 60); const pr3 = await w.probe(); lnd.block = real;
  t('a block that is not whole fails the probe', pr3.ok === false);

  let r = await w.poll();
  t('the first look reads the best block only', r.ok && r.new_blocks === 1 && w.summary().last_height === 100);
  r = await w.poll();
  t('a second look at the same block reads nothing', r.ok && r.new_blocks === 0);

  tip = 101; chain.set(101, mkBlock(101, [mkTx('h101', true)]));
  tip = 102; chain.set(102, mkBlock(102, [mkTx('h102', false), oldState, mkTx('h102b', true)]));
  r = await w.poll();
  t('two new blocks are both read', r.ok && r.new_blocks === 2 && w.summary().last_height === 102);
  t('the old state is seen and the penalty paying the HIGHER fee is published first', sent.length === 1 && sent[0] === pHigh.toString('hex'), JSON.stringify(sent.map((s) => s.length)));
  t('the item that spends something else is never published', !sent.includes(stray.toString('hex')));
  t('the journal says it', lines.some((l) => /AN OLD STATE WAS PUBLISHED/.test(l) && l.includes(OLD)) && lines.some((l) => /published \(/.test(l) && /fee 1500 sats/.test(l)));
  const rec = fs.readFileSync(path.join(tmp, 'tower', 'published.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  t('a record is written: the old state, the block, both penalties, the one accepted', rec.length === 1 && rec[0].old_txid === OLD && rec[0].height === 102 && rec[0].penalties.length === 2 && rec[0].first_accepted === btc.txid(btc.parse(pHigh.toString('hex'))));

  sent.length = 0; tip = 103; chain.set(103, mkBlock(103, [mkTx('h103', false)]));
  r = await w.poll();
  t('on the next block the penalty goes out again', r.new_blocks === 1 && sent.length === 1 && sent[0] === pHigh.toString('hex'));

  // a stop and a start: the height is on disk; the blocks missed are read; the penalty is still live
  w = mk(); sent.length = 0;
  for (let h = 104; h <= 108; h++) chain.set(h, mkBlock(h, [mkTx('h' + h, false)])); tip = 108;
  r = await w.poll();
  t('after a stop the five blocks missed are read', r.ok && r.new_blocks === 5 && w.summary().last_height === 108);
  t('…and the penalty is published again after the start', sent.length === 1);

  // a reorganisation: heights 107 and 108 change, 109 arrives
  const before = calls.block; lines.length = 0;
  chain.set(107, mkBlock(1107, [mkTx('r107', false)])); chain.set(108, mkBlock(1108, [mkTx('r108', false)])); chain.set(109, mkBlock(1109, [mkTx('r109', false)])); tip = 109;
  r = await w.poll();
  t('a reorganisation: the two changed heights and the new one are read again', r.ok && r.new_blocks === 3 && calls.block - before === 3 && lines.filter((l) => /changed \(a reorganisation\)/.test(l)).length === 2);

  // the higher-fee penalty is refused: the other one goes
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'towerwatch-'));
  const tower2 = T.createTower({ dataDir: tmp2, log: () => {}, now: () => clock });
  tower2.put(key, group, [{ hint: T.hintOf(OLD), blob: T.encrypt(pLow, OLD) }, { hint: T.hintOf(OLD), blob: T.encrypt(pHigh, OLD) }]);
  const w2 = W.createTowerWatch({ tower: tower2, lnd, dataDir: tmp2, log: (l) => lines.push(l), now: () => clock });
  chain.set(110, mkBlock(110, [oldState])); tip = 110; sent.length = 0; lines.length = 0;
  refuse = (hex) => hex === pHigh.toString('hex') ? 'min relay fee not met' : null;
  r = await w2.poll(); refuse = () => null;
  t('when the first penalty is refused the other one is published', r.ok && sent.length === 1 && sent[0] === pLow.toString('hex') && lines.some((l) => /was refused: min relay fee not met/.test(l)));

  // nothing accepted: said, and tried again on the next block
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'towerwatch-'));
  const tower3 = T.createTower({ dataDir: tmp3, log: () => {}, now: () => clock });
  tower3.put(key, group, [{ hint: T.hintOf(OLD), blob: T.encrypt(pLow, OLD) }]);
  const w3 = W.createTowerWatch({ tower: tower3, lnd, dataDir: tmp3, log: (l) => lines.push(l), now: () => clock, republishBlocks: 2 });
  sent.length = 0; lines.length = 0; refuse = () => 'no connection';
  r = await w3.poll();
  t('no penalty accepted is said in the journal', r.ok && sent.length === 0 && lines.some((l) => /NO penalty for/.test(l)));
  refuse = () => null; chain.set(111, mkBlock(111, [mkTx('h111', false)])); tip = 111;
  r = await w3.poll();
  t('…and it is tried again on the next block', sent.length === 1 && sent[0] === pLow.toString('hex'));
  sent.length = 0; for (let h = 112; h <= 114; h++) chain.set(h, mkBlock(h, [mkTx('h' + h, false)])); tip = 114;
  await w3.poll(); const n1 = sent.length; sent.length = 0; chain.set(115, mkBlock(115, [mkTx('h115', false)])); tip = 115; await w3.poll();
  t('after its time (here 2 blocks) the publishing again stops', n1 === 0 && sent.length === 0 && w3.summary().penalties_live === 0);

  // away longer than the ceiling
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'towerwatch-'));
  const w4 = W.createTowerWatch({ tower: T.createTower({ dataDir: tmp4, log: () => {} }), lnd, dataDir: tmp4, log: (l) => lines.push(l), catchUpMax: 3, recentKeep: 2 });
  tip = 100; await w4.poll(); tip = 115; lines.length = 0; const b4 = calls.block;
  r = await w4.poll();
  t('away for more than the ceiling: said, and only the ceiling is read', r.ok && calls.block - b4 === 3 && lines.some((l) => /are NOT read/.test(l)));

  // LND down: an answer in words, nothing thrown, the height not moved
  const lh = w.summary().last_height; lnd.bestBlock = async () => { throw new Error('ECONNREFUSED'); };
  r = await w.poll();
  t('LND not answering: no throw, the reason kept, the height not moved', r.ok === false && /ECONNREFUSED/.test(r.why) && w.summary().last_height === lh && /ECONNREFUSED/.test(w.summary().last_error));

  console.log(`${fail ? 'FAIL' : 'PASS'} · tower-watch · ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
