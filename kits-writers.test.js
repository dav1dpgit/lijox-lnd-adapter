// 0.94.0 (S57, DP 2026-10-07 17:55 "where anything is different … Go") — the kit holder keeps the newest kit of each of
// the last two OTHER writers beside the newest; another writer's validly signed STALE kit is kept there too.
//   node kits-writers.test.js
const path = require('path').join(__dirname, 'kits.js');
const { createKitHolder, canonicalEnvelope } = require(path);
const crypto = require('crypto'); const fs = require('fs'); const os = require('os');
let pass = 0, fail = 0; const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };
const dir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'kitsw-'));
const H = createKitHolder({ dataDir: dir, log: () => {} });
const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
const jwk = kp.publicKey.export({ format: 'jwk' });
const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
const pub33 = Buffer.concat([Buffer.from([(y[31] & 1) ? 0x03 : 0x02]), x]);
const npub = x.toString('hex');
function sign(body) {
  const canon = canonicalEnvelope(body.kit);
  const seqb = Buffer.alloc(8); seqb.writeBigUInt64BE(BigInt(body.seq));
  const pre = Buffer.concat([Buffer.from('lijox-kit-put-v1'), pub33, seqb, crypto.createHash('sha256').update(canon, 'utf8').digest()]);
  return crypto.sign('sha256', pre, { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('hex');
}
const W = { A: 'aa'.repeat(8), B: 'bb'.repeat(8), C: 'cc'.repeat(8), D: 'dd'.repeat(8), E: 'ee'.repeat(8) };
function mk(seq, w, ct) {
  const kit = { v: 1, alg: 'A256GCM', kdf: 'hkdf-sha256:lijox-black-start:escape-kit-v1', npub, seq, nonce: '00'.repeat(12), ct: ct || (seq.toString(16).padStart(2, '0').repeat(20)) };
  const b = { pubkey: pub33.toString('hex'), seq, kit, sig: '' }; b.sig = sign(b); if (w !== undefined) b.w = w; return b;
}
const g = () => H.get(npub).body;
const ow = () => (g().others || []).map((o) => [o.w, o.seq]);

let r = H.put(mk(10, W.A), '9.9.9.1');
t('k1 a writer’s first kit: newest, no others', r.status === 200 && g().w === W.A && g().seq === 10 && ow().length === 0, JSON.stringify(g()));
r = H.put(mk(20, W.B), '9.9.9.1');
t('k2 another writer’s newer kit: newest B, A kept in others', r.status === 200 && g().w === W.B && JSON.stringify(ow()) === JSON.stringify([[W.A, 10]]), JSON.stringify(ow()));
t('k2 the kept kit is A’s own, unchanged', canonicalEnvelope(g().others[0].kit) === canonicalEnvelope(mk(10, W.A).kit));
r = H.put(mk(21, W.B), '9.9.9.1');
t('k3 B again: newest B 21, A untouched', r.status === 200 && g().seq === 21 && JSON.stringify(ow()) === JSON.stringify([[W.A, 10]]), JSON.stringify(ow()));
r = H.put(mk(30, W.C), '9.9.9.1');
t('k4 C: others B (its newest) then A', g().w === W.C && JSON.stringify(ow()) === JSON.stringify([[W.B, 21], [W.A, 10]]), JSON.stringify(ow()));
r = H.put(mk(40, W.D), '9.9.9.1');
t('k5 D: only the last two other writers (C, B)', g().w === W.D && JSON.stringify(ow()) === JSON.stringify([[W.C, 30], [W.B, 21]]), JSON.stringify(ow()));
r = H.put(mk(50), '9.9.9.1');
t('k6 a legacy push (no w) is its own writer: newest "", others D, C', g().w === '' && g().seq === 50 && JSON.stringify(ow()) === JSON.stringify([[W.D, 40], [W.C, 30]]), JSON.stringify(ow()));
r = H.put(mk(45, W.E), '9.9.9.1');
t('k7 another writer’s signed STALE kit: 409, and kept beside (E 45, D 40)', r.status === 409 && r.body.code === 'STALE' && g().seq === 50 && JSON.stringify(ow()) === JSON.stringify([[W.E, 45], [W.D, 40]]), JSON.stringify([r.status, ow()]));
const before = JSON.stringify(ow());
r = H.put(mk(44), '9.9.9.1');
t('k8 a STALE kit from the newest’s own writer: 409, nothing kept', r.status === 409 && JSON.stringify(ow()) === before, JSON.stringify(ow()));
let bad = mk(46, W.A); bad.kit.ct = 'ab'.repeat(30);
r = H.put(bad, '9.9.9.1');
t('k9 a STALE kit with a bad signature: refused, others unchanged', r.status === 400 && r.body.code === 'BAD_SIG' && JSON.stringify(ow()) === before, JSON.stringify([r.status, r.body]));
r = H.put(mk(60, 'not-hex!'), '9.9.9.1');
t('k10 a malformed w counts as the legacy writer (replaces "", others unchanged)', r.status === 200 && g().w === '' && g().seq === 60 && JSON.stringify(ow()) === before, JSON.stringify(ow()));
const gg = g();
t('k11 GET keeps its 0.79 fields (ok, seq, at, pubkey, kit) and adds w, others', gg.ok === true && typeof gg.at === 'number' && gg.pubkey === pub33.toString('hex') && gg.kit && gg.kit.seq === 60 && 'w' in gg && Array.isArray(gg.others));
console.log(fail ? 'FAIL · ' + fail + ' failed, ' + pass + ' passed' : 'PASS · kits-writers k1–k11 (' + pass + ')');
process.exit(fail ? 1 : 0);
