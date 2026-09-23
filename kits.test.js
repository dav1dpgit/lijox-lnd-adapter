// 0.79.0 (S48) — the KIT HOLDER against the engine's own signed fixture (lij-core black_start
// print_fixture: the NIP-06 test-vector key), plus Node-signed cases for every refusal.
//   node kits.test.js
const path = require('path').join(__dirname, 'kits.js');
const { createKitHolder, verifyPut, canonicalEnvelope } = require(path);
const crypto = require('crypto'); const fs = require('fs'); const os = require('os');
const FIXTURE_PUT = JSON.parse("{\"pubkey\":\"0317162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917\",\"seq\":1758600000000,\"kit\":{\"v\":1,\"alg\":\"A256GCM\",\"kdf\":\"hkdf-sha256:lijox-black-start:escape-kit-v1\",\"npub\":\"17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917\",\"seq\":1758600000000,\"nonce\":\"264f89f4edcf37c92fd87dae\",\"ct\":\"0bb1a641138d735ad13cdc69ad9aff0d766f32a2039164afa655370cc6c0311295d1fa7c6a687d7b6de54aa25fb638975501549c8851\"},\"sig\":\"08fdb2022e8ee15843f62010d0cf5f600733ebb313b6b50c531df5531bd1e41c472de4510ec0f6fc511ce94885eda9ea39a6c050a1c0d523401ac95cf15f7ddb\"}");
const FIXTURE_EVENT = JSON.parse("{\"content\":\"{\\\"v\\\":1,\\\"alg\\\":\\\"A256GCM\\\",\\\"kdf\\\":\\\"hkdf-sha256:lijox-black-start:escape-kit-v1\\\",\\\"npub\\\":\\\"17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917\\\",\\\"seq\\\":1758600000000,\\\"nonce\\\":\\\"264f89f4edcf37c92fd87dae\\\",\\\"ct\\\":\\\"0bb1a641138d735ad13cdc69ad9aff0d766f32a2039164afa655370cc6c0311295d1fa7c6a687d7b6de54aa25fb638975501549c8851\\\"}\",\"created_at\":1758600000,\"id\":\"d5f821e54d3eef99afbcc259d1fe4eee22c5ad7f0a1fc3bd7ba8c8a0e3aad4c5\",\"kind\":30078,\"pubkey\":\"17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917\",\"sig\":\"3f5a80e9993e86e8a6eb0fea0cbc39194ce4170c292bf8ad6d4e76a770a9adc37d39b3a7489561ff81184e0a8a448b2d94a0b75d2a6bbd23f67784f90803a92f\",\"tags\":[[\"d\",\"lijox-kit-v1\"]]}");
let pass = 0, fail = 0; const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };
const dir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'kits-'));
const H = createKitHolder({ dataDir: dir, maxRecords: 3, log: () => {} });

// ── the engine's fixture: verifies, stores, reads back, STALE below, newer wins ──
const v = verifyPut(FIXTURE_PUT);
t('engine-signed body verifies with Node crypto', v.ok === true, JSON.stringify(v));
t('npub is the x of the pubkey', v.ok && v.npub === FIXTURE_PUT.pubkey.slice(2));
let r = H.put(FIXTURE_PUT, '1.1.1.1');
t('stored', r.status === 200 && r.body.ok === true && r.body.seq === FIXTURE_PUT.seq, JSON.stringify(r));
r = H.get(FIXTURE_PUT.kit.npub);
t('read back: same seq, same canonical kit', r.status === 200 && r.body.seq === FIXTURE_PUT.seq && canonicalEnvelope(r.body.kit) === canonicalEnvelope(FIXTURE_PUT.kit) && r.body.pubkey === FIXTURE_PUT.pubkey);
r = H.put(FIXTURE_PUT, '1.1.1.1');
t('the same seq again → 409 STALE', r.status === 409 && r.body.code === 'STALE');
r = H.get('00'.repeat(32));
t('unknown npub → 404', r.status === 404);
t('bad npub → 400', H.get('zz').status === 400);

// ── the relay event's shape (verified in the engine's own tests; here the shape the page sends) ──
t('event: kind 30078, d tag, content is the canonical envelope', FIXTURE_EVENT.kind === 30078 && FIXTURE_EVENT.tags[0][0] === 'd' && FIXTURE_EVENT.tags[0][1] === 'lijox-kit-v1' && FIXTURE_EVENT.content === canonicalEnvelope(FIXTURE_PUT.kit) && FIXTURE_EVENT.pubkey === FIXTURE_PUT.kit.npub);

// ── Node-signed cases ──
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
function mk(seq, ct) {
  const kit = { v: 1, alg: 'A256GCM', kdf: 'hkdf-sha256:lijox-black-start:escape-kit-v1', npub, seq, nonce: '00'.repeat(12), ct: ct || 'ab'.repeat(40) };
  const b = { pubkey: pub33.toString('hex'), seq, kit, sig: '' }; b.sig = sign(b); return b;
}
r = H.put(mk(10), '2.2.2.2');
t('a Node-signed body (a second implementation of the standard) is accepted', r.status === 200, JSON.stringify(r));
r = H.put(mk(11), '2.2.2.2');
t('a newer seq replaces', r.status === 200 && H.get(npub).body.seq === 11);
r = H.put(mk(5), '2.2.2.2');
t('an older seq → STALE, the stored one untouched', r.status === 409 && H.get(npub).body.seq === 11);
let b = mk(12); b.kit.ct = 'cd'.repeat(40);
t('a changed ciphertext under an old signature → BAD_SIG', H.put(b, '2.2.2.2').body.code === 'BAD_SIG');
b = mk(12); b.seq = 13;
t('seq not matching the envelope → SEQ_MISMATCH', H.put(b, '2.2.2.2').body.code === 'SEQ_MISMATCH');
b = mk(12); b.kit.npub = '11'.repeat(32);
t('npub not the pubkey\'s x → NPUB_MISMATCH', H.put(b, '2.2.2.2').body.code === 'NPUB_MISMATCH');
b = mk(12); b.pubkey = FIXTURE_PUT.pubkey;
t('another key\'s pubkey with this signature → NPUB_MISMATCH or BAD_SIG', ['NPUB_MISMATCH', 'BAD_SIG'].includes(H.put(b, '2.2.2.2').body.code));
b = mk(12); b.kit = { v: 1, alg: 'A256GCM', kdf: 'x', npub, seq: 12, nonce: 'zz', ct: 'ab' };
t('malformed envelope → BAD_KIT', H.put(b, '2.2.2.2').body.code === 'BAD_KIT');
b = mk(12, 'ab'.repeat(40000));
t('over the cap → 413 TOO_LARGE', H.put(b, '2.2.2.2').status === 413);
// key order and whitespace on the wire do not matter: the canonical form is rebuilt
b = mk(14); const reordered = JSON.parse(JSON.stringify({ sig: b.sig, kit: { ct: b.kit.ct, nonce: b.kit.nonce, seq: b.kit.seq, npub: b.kit.npub, kdf: b.kit.kdf, alg: b.kit.alg, v: b.kit.v }, seq: b.seq, pubkey: b.pubkey }));
t('reordered keys on the wire still verify', H.put(reordered, '2.2.2.2').status === 200);
// rate limit
let last; for (let i = 0; i < 125; i++) last = H.put(mk(100 + i), '3.3.3.3');
t('the 121st put from one IP in an hour → 429', last.status === 429);
// eviction: cap 3, the third new identity beyond the cap evicts the oldest untouched (older than 90 days)
const old = require('path').join(dir, 'kits', 'ff'.repeat(32) + '.json');
fs.writeFileSync(old, JSON.stringify({ seq: 1, at: Date.now() - 100 * 24 * 3600 * 1000, pubkey: '02' + 'ff'.repeat(32), kit: {} }));
const kp2 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
t('store count before eviction', H.count() === 3);
const jwk2 = kp2.publicKey.export({ format: 'jwk' }); const x2 = Buffer.from(jwk2.x, 'base64url'), y2 = Buffer.from(jwk2.y, 'base64url');
const pub2 = Buffer.concat([Buffer.from([(y2[31] & 1) ? 0x03 : 0x02]), x2]);
const kit2 = { v: 1, alg: 'A256GCM', kdf: 'k', npub: x2.toString('hex'), seq: 1, nonce: '00'.repeat(12), ct: 'ab'.repeat(40) };
const canon2 = canonicalEnvelope(kit2); const sb = Buffer.alloc(8); sb.writeBigUInt64BE(1n);
const pre2 = Buffer.concat([Buffer.from('lijox-kit-put-v1'), pub2, sb, crypto.createHash('sha256').update(canon2, 'utf8').digest()]);
const body2 = { pubkey: pub2.toString('hex'), seq: 1, kit: kit2, sig: crypto.sign('sha256', pre2, { key: kp2.privateKey, dsaEncoding: 'ieee-p1363' }).toString('hex') };
r = H.put(body2, '4.4.4.4');
t('a new identity at the cap evicts the 100-day-old untouched record and stores', r.status === 200 && !fs.existsSync(old) && H.count() === 3);
// 0.79.1: the routes carry wildcard CORS (any wallet origin may hold or fetch a kit)
{
  const hdr = {}; const res = { setHeader: (k, v) => { hdr[k] = v; }, writeHead: () => {}, end: () => {} };
  let out = null; const jr = (r, body, status) => { out = { body, status }; };
  H.handle({ url: '/v1/kit?npub=' + FIXTURE_PUT.kit.npub }, res, '/v1/kit', 'GET', '5.5.5.5', null, jr).then(() => {
    t('GET carries Access-Control-Allow-Origin: *', hdr['Access-Control-Allow-Origin'] === '*' && out && out.status === 200);
    const res2 = { setHeader: (k, v) => { hdr[k] = v; }, writeHead: (c) => { hdr._code = c; }, end: () => {} };
    return H.handle({ url: '/v1/kit' }, res2, '/v1/kit', 'OPTIONS', '5.5.5.5', null, jr).then(() => {
      t('OPTIONS preflight answers 204 with the wildcard', hdr._code === 204 && hdr['Access-Control-Allow-Methods'].indexOf('POST') !== -1);
      console.log(pass + ' passed, ' + fail + ' failed');
      process.exit(fail ? 1 : 0);
    });
  });
}
