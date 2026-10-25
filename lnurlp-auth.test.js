// 0.112.0 (S63, the external review's F7) — the signed Lightning address: the record a registration binds
// (lnurlpRegisterRecordId, the twin of lij-core registry_client::lnurlp_register_record_id, pinned with the engine's own
// test vectors) and the check both routes make (lnurlpAuthCheck: fields, the signer is the record's key, the signature
// over the rebuilt record, the nonce spent only after it held). The two functions are read out of lij-adapter.js and run
// in a sandbox with the real registry.js (secp256k1) and a fresh nonce store — nothing listens.
//   node lnurlp-auth.test.js
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const registry = require('./registry');

const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const from = src.indexOf('function lnurlpRegisterRecordId(name, hashes) {');
const to = src.indexOf('// 0.68.0: one boot sweep');
if (from < 0 || to < 0 || to < from) { console.log('FAIL cannot find the lnurlp auth block in lij-adapter.js'); process.exit(1); }
const block = src.slice(from, to);

let pass = 0, fail = 0;
const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };

const registryNonceStore = new registry.NonceStore();
const ctx = { crypto, Buffer, registryBuildSignedMessage: registry.buildSignedMessage, registryVerifySignature: registry.verifySignature, registryNonceStore, String, Array, console };
vm.createContext(ctx);
vm.runInContext(block + '\nthis.lnurlpRegisterRecordId = lnurlpRegisterRecordId; this.lnurlpAuthCheck = lnurlpAuthCheck;', ctx);
const { lnurlpRegisterRecordId, lnurlpAuthCheck } = ctx;

// ── a1 the record rule — the engine's vectors (lij-core registry_client::tests::lnurlp_register_record_id_rule)
const EMPTY = 'alice:0:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
t('a1 an empty probe: name lowercased, count 0, the sha256 of nothing', lnurlpRegisterRecordId('Alice', []) === EMPTY, lnurlpRegisterRecordId('Alice', []));
t('a1 not an array → as an empty list (the route already refused it with 400)', lnurlpRegisterRecordId('alice', null) === EMPTY && lnurlpRegisterRecordId('alice', undefined) === EMPTY);
const two = [{ hash: 'BB', secret: 'x', index: 2 }, { hash: 'aa', secret: 'y' }];
const want2 = 'alice:2:' + crypto.createHash('sha256').update('aa').update('bb').digest('hex');
t('a1 two hashes: lowercased, sorted, joined; secrets and indexes never enter', lnurlpRegisterRecordId('alice', two) === want2, lnurlpRegisterRecordId('alice', two));
t('a1 order and case do not change the record', lnurlpRegisterRecordId('ALICE', [{ hash: 'aa' }, { hash: 'bb' }]) === want2);
t('a1 an entry without a string hash is skipped, as the engine skips it', lnurlpRegisterRecordId('alice', [{ hash: 'aa' }, { secret: 'zz' }, null, 'aa', 7, [{ hash: 'cc' }], { hash: 5 }]) === 'alice:1:' + crypto.createHash('sha256').update('aa').digest('hex'));
t('a1 ASCII lowercase only (Rust to_ascii_lowercase): a non-ASCII capital stays', lnurlpRegisterRecordId('alice', [{ hash: 'É' }]) === 'alice:1:' + crypto.createHash('sha256').update('É', 'utf8').digest('hex'));
t('a1 sorted bytewise (Rust String sort), not by UTF-16 unit', (() => { const r = lnurlpRegisterRecordId('alice', [{ hash: 'Ａ' }, { hash: '😀' }]); const bytewise = ['Ａ', '😀'].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); return r === 'alice:2:' + crypto.createHash('sha256').update(bytewise.join(''), 'utf8').digest('hex'); })());
t('a1 a real pool: fifty 64-hex hashes, the count 50', (() => { const hs = Array.from({ length: 50 }, (_, i) => ({ hash: crypto.createHash('sha256').update('h' + i).digest('hex'), secret: 's'.repeat(64), index: i, expires: 4e9 })); const r = lnurlpRegisterRecordId('bob', hs); const sorted = hs.map((e) => e.hash).sort(); return r === 'bob:50:' + crypto.createHash('sha256').update(sorted.join('')).digest('hex'); })());

// ── a2 the check — a wallet that signs properly
const priv = crypto.randomBytes(32); const pub = Buffer.from(secp256k1.publicKeyCreate(priv, true)).toString('hex');
const other = crypto.randomBytes(32); const otherPub = Buffer.from(secp256k1.publicKeyCreate(other, true)).toString('hex');
function proof(action, recordId, key = priv, pk = pub) {
  const { nonce } = registryNonceStore.issue();
  const digest = registry.buildSignedMessage(action, nonce, pk, recordId);
  const signature = Buffer.from(secp256k1.ecdsaSign(digest, key).signature).toString('hex');
  return { node_pubkey: pk, nonce, signature };
}
const hashes = [{ hash: 'ab'.repeat(32), secret: 'cd'.repeat(32), index: 0, expires: 4e9 }];
const rid = lnurlpRegisterRecordId('alice', hashes);
let body = Object.assign({ name: 'alice', client_pubkey: pub, hashes }, proof('lnurl-register', rid));
t('a2 a proper registration passes', lnurlpAuthCheck(body, 'lnurl-register', pub, rid).ok === true);
const again = lnurlpAuthCheck(body, 'lnurl-register', pub, rid);
t('a2 the same proof again: the nonce is spent (401 nonce_already_used)', again.ok === false && again.code === 'nonce_already_used' && again.status === 401, JSON.stringify(again));
body = Object.assign({ name: 'alice', client_pubkey: pub, hashes }, proof('lnurl-register', rid));
const swapped = lnurlpAuthCheck(body, 'lnurl-register', pub, lnurlpRegisterRecordId('alice', [{ hash: 'ff'.repeat(32), secret: 'cd'.repeat(32) }]));
t('a2 the proof over one hash list is no proof for another (signature_invalid, the nonce NOT spent)', swapped.ok === false && swapped.code === 'signature_invalid' && swapped.status === 401 && registryNonceStore.consume(body.nonce).ok === true, JSON.stringify(swapped));
body = Object.assign({ name: 'alice', client_pubkey: pub, hashes }, proof('lnurl-register', rid));
const asRelease = lnurlpAuthCheck(body, 'lnurl-release', pub, 'alice');
t('a2 a register proof does not release', asRelease.ok === false && asRelease.code === 'signature_invalid');
body = Object.assign({ name: 'alice', client_pubkey: pub, hashes }, proof('lnurl-register', lnurlpRegisterRecordId('alice', [])));
t('a2 a probe\'s proof (over []) does not register hashes', lnurlpAuthCheck(body, 'lnurl-register', pub, rid).ok === false);
const unsigned = lnurlpAuthCheck({ name: 'alice', client_pubkey: pub, hashes }, 'lnurl-register', pub, rid);
t('a2 unsigned → 401 "signature required" (no grace period)', unsigned.ok === false && unsigned.status === 401 && unsigned.code === 'signature required', JSON.stringify(unsigned));
const stranger = Object.assign({ name: 'alice', client_pubkey: pub, hashes }, proof('lnurl-register', rid, other, otherPub));
const st = lnurlpAuthCheck(stranger, 'lnurl-register', pub, rid);
t('a2 a stranger\'s own valid signature, claiming another wallet\'s record → 403 (the signer is not the record\'s key)', st.ok === false && st.status === 403, JSON.stringify(st));
const forged = Object.assign({ name: 'alice', client_pubkey: pub, hashes }, proof('lnurl-register', rid, other, pub));
const fg = lnurlpAuthCheck(forged, 'lnurl-register', pub, rid);
t('a2 a stranger signing with his key but naming the victim\'s pubkey → signature_invalid', fg.ok === false && fg.code === 'signature_invalid');
const malformed = lnurlpAuthCheck({ node_pubkey: pub, nonce: 'zz', signature: 'q' }, 'lnurl-register', pub, rid);
t('a2 malformed fields → 400', malformed.ok === false && malformed.status === 400);
const unknownNonce = lnurlpAuthCheck(Object.assign(proof('lnurl-register', rid), { nonce: 'ab'.repeat(32) }), 'lnurl-register', pub, rid);
t('a2 a nonce this LSP never issued: the signature fails first (it was made over another nonce)', unknownNonce.ok === false && unknownNonce.code === 'signature_invalid');
const selfNonce = (() => { const nonce = 'ab'.repeat(32); const digest = registry.buildSignedMessage('lnurl-register', nonce, pub, rid); const signature = Buffer.from(secp256k1.ecdsaSign(digest, priv).signature).toString('hex'); return lnurlpAuthCheck({ node_pubkey: pub, nonce, signature }, 'lnurl-register', pub, rid); })();
t('a2 a nonce the wallet made up itself, properly signed → nonce_unknown (replay needs the LSP\'s own challenge)', selfNonce.ok === false && selfNonce.code === 'nonce_unknown' && selfNonce.status === 401, JSON.stringify(selfNonce));
const rel = lnurlpAuthCheck(Object.assign({ name: 'alice', client_pubkey: pub }, proof('lnurl-release', 'alice')), 'lnurl-release', pub, 'alice');
t('a2 a proper release passes', rel.ok === true);
const relOther = lnurlpAuthCheck(Object.assign({ name: 'bob', client_pubkey: pub }, proof('lnurl-release', 'alice')), 'lnurl-release', pub, 'bob');
t('a2 a release proof for one name frees no other', relOther.ok === false && relOther.code === 'signature_invalid');
const upper = lnurlpAuthCheck(Object.assign({}, proof('lnurl-release', 'alice'), { node_pubkey: pub.toUpperCase() }), 'lnurl-release', pub, 'alice');
t('a2 an upper-case pubkey in the body is the same key', upper.ok === true);

console.log(`\n${fail ? 'FAIL' : 'PASS'} · lnurlp-auth (a1–a2) · ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
