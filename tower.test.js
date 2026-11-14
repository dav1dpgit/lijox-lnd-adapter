// tower.test.js — the tower's holder (S69). The encryption is checked against The Eye of Satoshi's own test value
// (rust-teos be344ec, teos-common/src/cryptography.rs: HEX_TX, HEX_TXID, ENC_BLOB), so our bytes are its bytes.
//   node tower.test.js
const T = require(require('path').join(__dirname, 'tower.js'));
const schnorr = require('./schnorr.js'); const btc = require('./btc-tx.js');
const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
let pass = 0, fail = 0; const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const TEOS_TX = '010000000001010000000000000000000000000000000000000000000000000000000000000000ffffffff54038e830a1b4d696e656420627920416e74506f6f6c373432c2005b005e7a0ae3fabe6d6d7841cd582ead8ea5dd8e3de1173cae6fcd2a53c7362ebb7fb6f815604fe07cbe0200000000000000ac0e060005f90000ffffffff04d9476026000000001976a91411dbe48cc6b617f9c6adaf4d9ed5f625b1c7cb5988ac0000000000000000266a24aa21a9ed7248c6efddd8d99bfddd7f499f0b915bffa8253003cc934df1ff14a81301e2340000000000000000266a24b9e11b6d7054937e13f39529d6ad7e685e9dd4efa426f247d5f5a5bed58cdddb2d0fa60100000000000000002b6a2952534b424c4f434b3a054a68aa5368740e8b3e3c67bce45619c2cfd07d4d4f0936a5612d2d0034fa0a0120000000000000000000000000000000000000000000000000000000000000000000000000';
const TEOS_TXID = 'd6ac4a5e61657c4c604dcde855a1db74ec6b3e54f32695d72c5e11c7761ea1b4';
const TEOS_ENC = 'f64d730654738fdbcd9e65068be17bc1abb44e74f8977985cce48e77209cf97292c862e4eb7190aedc6c53ceddda6871a3988d1d9608e2d0dd7a1f59769e410618a7029001479ac3b9d699b11a08b0ccb04e56bfee88461d9cd3207623a4a543996dd3805323c93cd62069636305aaf159e9cca1063ad1f097c16fb3c2ebbcf09be96512c5d7c195c684569cbe8b7979870b04cada9806b7610569c66021afcc63f46dd4af75716950c4de094334cdf7d9e532820afe29d2621dd79920c7e0ecc10853517dd84ca9d699f712c229e86954c227cba1d0fc87c8d48ac05e2de8a6bc980afdfafcd7064e411c8d76065c06cc7f233e869eaff5bd8ccb5d8f0090d91a8f017355cc115863356ecf06cdda9b309096ea766d033dbd4f70a789a5b03138cfc7e2900a79bb465abf07a7ac45c41b4b30c008d4b299aad9d001cf45acd07e47cdd63c3b13d4b0788b041735225b5db1a43a2142311f695478168e31deb260702976fd70d0724ded84a7c3f89b';

// ── the Eye of Satoshi's value ──
t('encrypt gives the Eye of Satoshi\'s bytes', T.encrypt(Buffer.from(TEOS_TX, 'hex'), TEOS_TXID).toString('hex') === TEOS_ENC);
t('decrypt gives its transaction back', (T.decrypt(Buffer.from(TEOS_ENC, 'hex'), TEOS_TXID) || Buffer.alloc(0)).toString('hex') === TEOS_TX);
t('another id does not open it', T.decrypt(Buffer.from(TEOS_ENC, 'hex'), 'ab'.repeat(32)) === null);
t('the hint is the first 16 bytes of the id in its own order', T.hintOf(TEOS_TXID) === Buffer.from(TEOS_TXID, 'hex').reverse().subarray(0, 16).toString('hex'));

// ── a wallet's tower key, an old state, its penalty at two fee rates ──
const sk = sha(Buffer.from('tower test key 1')); const key = schnorr.pubkey(sk).toString('hex');
const sk2 = sha(Buffer.from('tower test key 2')); const key2 = schnorr.pubkey(sk2).toString('hex');
const oldState = { version: 2, locktime: 0, inputs: [{ txid: '11'.repeat(32), vout: 0, sequence: 0x80000001, witness: [] }], outputs: [{ value: 70000, script: Buffer.from('0020' + '22'.repeat(32), 'hex') }, { value: 29000, script: Buffer.from('0014' + '33'.repeat(20), 'hex') }] };
const OLD = btc.txid(oldState);
const penalty = (fee) => btc.serialize({ version: 2, locktime: 0, inputs: [{ txid: OLD, vout: 0, sequence: 0xffffffff, witness: [Buffer.alloc(71, 1), Buffer.from([1]), Buffer.alloc(77, 2)] }], outputs: [{ value: 70000 - fee, script: Buffer.from('0014' + '44'.repeat(20), 'hex') }] });
const pA = penalty(600), pB = penalty(1500);
const group = 'c1'.repeat(16); const nowS = 1794550000;
const body = (action, k, s, g, items, ts) => {
  const b = { key: k, ts: ts == null ? nowS : ts }; if (action !== 'status') b.group = g;
  let ish = '';
  if (action === 'put') { b.items = items.map((i) => ({ hint: i.hint, blob: i.blob.toString('base64') })); ish = T.itemsSha(items); }
  b.signature = schnorr.sign(s, sha(Buffer.from(T.signedText(action, k, action === 'status' ? '' : g, b.ts, ish), 'utf8')), Buffer.alloc(32)).toString('hex');
  return b;
};
const items = [{ hint: T.hintOf(OLD), blob: T.encrypt(pA, OLD) }, { hint: T.hintOf(OLD), blob: T.encrypt(pB, OLD) }];

// ── the request checks ──
let v = T.verifyRequest('put', body('put', key, sk, group, items), nowS);
t('a signed put verifies and returns the items', v.ok === true && v.items.length === 2 && Buffer.isBuffer(v.items[0].blob), JSON.stringify(v));
t('signed by another key → refused', T.verifyRequest('put', Object.assign(body('put', key, sk2, group, items)), nowS).code === 'signature');
const tam = body('put', key, sk, group, items); tam.items[1].blob = T.encrypt(penalty(900), OLD).toString('base64');
t('an item changed after signing → refused', T.verifyRequest('put', tam, nowS).code === 'signature');
t('a clock 11 minutes off → refused', T.verifyRequest('put', body('put', key, sk, group, items, nowS - 660), nowS).code === 'bad_ts');
t('a put signature does not pass as a drop', T.verifyRequest('drop', body('put', key, sk, group, items), nowS).code === 'signature');
t('a node key (33 bytes) is not a tower key', T.verifyRequest('status', { key: '02' + 'a'.repeat(64), ts: nowS, signature: '0'.repeat(128) }, nowS).code === 'bad_key');
const big = body('put', key, sk, group, [{ hint: T.hintOf(OLD), blob: Buffer.alloc(T.BLOB_MAX + 1, 7) }]);
t('an item over the size limit → refused', T.verifyRequest('put', big, nowS).code === 'bad_blob');
t('status and drop verify', T.verifyRequest('status', body('status', key, sk), nowS).ok && T.verifyRequest('drop', body('drop', key, sk, group), nowS).ok);

// ── the holder ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-')); let clock = 1794550000000; const logs = [];
const mk = (o) => T.createTower(Object.assign({ dataDir: dir, log: (m) => logs.push(m), now: () => clock }, o || {}));
let H = mk({ quotaBytes: 1000 });
let r = H.put(key, group, v.items);
t('kept: two items under one hint', r.ok && r.kept === 2 && r.items === 2, JSON.stringify(r));
t('the same items again are kept once', H.put(key, group, v.items).kept === 0 && H.status(key).items === 2);
t('nothing in a block of other ids', H.match(['ab'.repeat(32), 'cd'.repeat(32)]).length === 0);
let m = H.match(['ab'.repeat(32), OLD]);
t('the old state in a block: both items found', m.length === 1 && m[0].txid === OLD && m[0].held.length === 2);
const opened = m[0].held.map((h) => H.open(OLD, h.blob));
t('both open into transactions that spend the old state', opened.every((o) => o.ok) && opened.some((o) => o.tx_hex === pA.toString('hex')) && opened.some((o) => o.tx_hex === pB.toString('hex')), JSON.stringify(opened).slice(0, 200));
// an id that shares the hint but is not the id: found by hint, not opened
const twin = Buffer.concat([Buffer.from(OLD, 'hex').reverse().subarray(0, 16), Buffer.alloc(16, 9)]).reverse().toString('hex');
m = H.match([twin]);
t('an id sharing the 16 bytes is found by hint and does NOT open', m.length === 1 && H.open(twin, m[0].held[0].blob).code === 'key_does_not_fit');
// a blob that opens but spends something else is never handed back as publishable
const other = btc.serialize({ version: 2, locktime: 0, inputs: [{ txid: '77'.repeat(32), vout: 1, sequence: 0xffffffff, witness: [Buffer.alloc(71, 1)] }], outputs: [{ value: 1000, script: Buffer.from('0014' + '44'.repeat(20), 'hex') }] });
t('an item that spends something else is refused', H.open(OLD, T.encrypt(other, OLD)).code === 'spends_something_else');
t('an item that is not a transaction is refused', H.open(OLD, T.encrypt(Buffer.from('not a transaction at all'), OLD)).code === 'not_a_transaction');
// the quota
const fill = []; for (let i = 0; i < 4; i++) fill.push({ hint: (i.toString(16).padStart(2, '0')).repeat(16), blob: Buffer.alloc(300, i) });
r = H.put(key, group, fill);
t('over the wallet\'s quota → refused whole, nothing kept', r.ok === false && r.code === 'quota' && H.status(key).items === 2, JSON.stringify(r));
// a second wallet, a second group; a restart; a drop
H.put(key2, 'd2'.repeat(16), [{ hint: T.hintOf(OLD), blob: T.encrypt(pA, OLD) }]);
H.put(key, 'e3'.repeat(16), [{ hint: 'ee'.repeat(16), blob: Buffer.alloc(100, 5) }]);
H = mk({ quotaBytes: 1000 });
t('after a restart everything is still held', H.summary().wallets === 2 && H.summary().items === 4 && H.match([OLD])[0].held.length === 3, JSON.stringify(H.summary()));
r = H.drop(key, group);
t('drop removes that channel\'s items only', r.dropped === 2 && H.status(key).items === 1 && H.match([OLD])[0].held.length === 1 && H.match([OLD])[0].held[0].key === key2);
t('a drop of an unknown group removes nothing', H.drop(key, 'ff'.repeat(16)).dropped === 0);
// the silent sweep
clock += 401 * 86400000;
H.put(key2, 'd2'.repeat(16), [{ hint: 'aa'.repeat(16), blob: Buffer.alloc(50, 1) }]);   // key2 is heard from; key is not
t('a wallet silent for more than the declared days is cleared, a live one kept', H.sweep() === 1 && H.status(key).items === 0 && H.status(key2).items === 2);
t('the wallet limit', (() => { const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-')); const h = T.createTower({ dataDir: d2, maxWallets: 1 }); h.put(key, group, [{ hint: 'aa'.repeat(16), blob: Buffer.alloc(40, 1) }]); return h.put(key2, group, [{ hint: 'bb'.repeat(16), blob: Buffer.alloc(40, 1) }]).code === 'full'; })());
t('the journal names 8 characters of the tower key and no more', logs.length > 0 && logs.every((l) => !l.includes(key) && !l.includes(key2)));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
