// 0.126.0 (S68): the channel state file's routes — POST /v1/peer-storage/put | meta | get.
//   node peer-storage-route.test.js
// The adapter is one module that starts servers on require, so this reads the source: handlePeerStorage as written,
// evaluated with stand-ins for LND, the nonce store, the limits and the HTTP helpers; the store is the real peer-storage.js.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createPeerStorage, signedText, sha256hex, FILE_MAX } = require('./peer-storage');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };
const start = src.indexOf('async function handlePeerStorage(');
const end = src.indexOf('\n}\n', start) + 3;
check(start > 0 && end > start, 'handlePeerStorage is in the adapter');
const rIdx = src.indexOf("path.startsWith('/v1/peer-storage/') && method === 'POST'"), aIdx = src.indexOf("if (path.startsWith('/lsps/registry/'))");
check(rIdx > 0 && aIdx > rIdx, 'the routes are dispatched before the registry router and the auth gate (public, signature-gated)');
check(/path === '\/v1\/kit' \|\| path\.startsWith\('\/v1\/peer-storage\/'\)\) kitHolder\.openCors\(res\)/.test(src), 'every wallet origin may call them (the kit holder\'s CORS)');
check(/peer_storage:\s+peerStorage\.capability/.test(src), 'the capability is announced (peer_storage, max_bytes 65531)');

const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psr-'));
const peerStorage = createPeerStorage({ dataDir: dir });
let nonceN = 0; const nonce = () => (++nonceN).toString(16).padStart(64, '0');
function make({ recovered = PK, verifyDown = false, nonceOk = true, ipOk = true, keyOk = true } = {}) {
  const calls = { verify: [], consumed: [] };
  const lndRequest = async (m, p, body) => { calls.verify.push(Buffer.from(body.msg, 'base64').toString('utf8')); return verifyDown ? { message: 'permission denied' } : { pubkey: recovered }; };
  const registryNonceStore = { consume: (n) => { calls.consumed.push(n); return nonceOk ? { ok: true } : { ok: false, code: 'nonce_unknown' }; } };
  const lim = (v) => ({ hit: () => (v ? { ok: true } : { ok: false, reset_s: 60 }) });
  const out = [];
  const jsonResponse = (res, j, status) => { out.push({ status: status || 200, json: j }); };
  const errResponse = (res, m, status) => { out.push({ status: status || 400, json: { error: m } }); };
  let bodyNext = null;
  const readBody = async (req, cap) => { if (JSON.stringify(bodyNext).length > cap) throw new Error('Body too large'); return bodyNext; };
  const fn = new Function('lndRequest', 'registryNonceStore', 'peerStorageIpLimit', 'peerStorageKeyLimit', 'jsonResponse', 'errResponse', 'readBody', 'peerStorage', 'peerStorageSignedText', 'peerStorageSha', 'PEER_STORAGE_FILE_MAX', 'console',
    src.slice(start, end) + '\nreturn handlePeerStorage;')(lndRequest, registryNonceStore, lim(ipOk), lim(keyOk), jsonResponse, errResponse, readBody, peerStorage, signedText, sha256hex, FILE_MAX, { log() {}, warn() {}, error() {} });
  return { calls, call: async (action, body) => { bodyNext = body; out.length = 0; await fn({}, {}, '1.2.3.4', action); return out[0]; } };
}
const F1 = Buffer.alloc(FILE_MAX, 1), F2 = Buffer.alloc(FILE_MAX, 2);
const put = (file, version, fp, n) => ({ node_pubkey: PK, nonce: n || nonce(), signature: 'sig', version, state_fp: fp, file_b64: file.toString('base64') });
(async () => {
  let h = make(), n1 = nonce();
  let r = await h.call('put', put(F1, 1000, '1'.repeat(64), n1));
  check(r.status === 200 && r.json.ok === true && r.json.version === 1000, 'put: a 65,531-byte file is kept');
  check(h.calls.verify[0] === 'lij-peer-storage-v1:put:' + n1 + ':1000:' + sha256hex(F1), 'put: the signature is over the action, the nonce, the number and the file\'s hash');
  check(h.calls.consumed[0] === n1, 'the nonce is used up after the signature is proven');
  r = await h.call('meta', { node_pubkey: PK, nonce: nonce(), signature: 'sig' });
  check(r.json.ok && r.json.found && r.json.version === 1000 && r.json.state_fp === '1'.repeat(64) && !('file_b64' in r.json), 'meta: the number and the fingerprint, no file');
  check(/^lij-peer-storage-v1:meta:[0-9a-f]{64}$/.test(h.calls.verify[1]), 'meta: its own signed text');
  r = await h.call('get', { node_pubkey: PK, nonce: nonce(), signature: 'sig' });
  check(r.json.found && Buffer.from(r.json.file_b64, 'base64').equals(F1) && r.json.version === 1000, 'get: the file back, byte for byte');
  r = await h.call('put', put(F2, 999, '2'.repeat(64)));
  check(r.status === 409 && r.json.reason === 'lower_version' && r.json.held_version === 1000, 'put: a lower number is refused (409) and names the held number');
  r = await h.call('put', put(F2, 2000, '2'.repeat(64)));
  r = await h.call('get', { node_pubkey: PK, nonce: nonce(), signature: 'sig' });
  check(Buffer.from(r.json.file_b64, 'base64').equals(F2), 'put: a higher number replaces the file');
  const before = h.calls.verify.length;
  r = await h.call('put', put(Buffer.alloc(FILE_MAX + 1, 3), 3000, '3'.repeat(64)));
  check(r.status === 413 && r.json.reason === 'too_large' && h.calls.verify.length === before, 'put: 65,532 bytes is refused (413) before LND is asked anything');
  r = await h.call('get', { node_pubkey: OTHER, nonce: nonce(), signature: 'sig' });
  check(r.status === 401 && r.json.reason === 'bad_signature', 'a signature by another key: 401, nothing handed back');
  h = make({ recovered: OTHER });
  r = await h.call('put', Object.assign(put(F1, 5, '5'.repeat(64)), { node_pubkey: OTHER }));
  check(r.json.ok === true, 'a wallet with no channel here is held for too (any key that proves itself)');
  r = await h.call('meta', { node_pubkey: '02' + 'cc'.repeat(32), nonce: nonce(), signature: 'sig' });
  check(r.status === 401, 'and cannot read another wallet\'s line');
  h = make({ verifyDown: true }); r = await h.call('meta', { node_pubkey: PK, nonce: nonce(), signature: 'sig' });
  check(r.status === 503 && r.json.reason === 'verify_unavailable' && h.calls.consumed.length === 0, 'LND cannot verify: 503, the nonce unspent');
  h = make({ nonceOk: false }); r = await h.call('meta', { node_pubkey: PK, nonce: nonce(), signature: 'sig' });
  check(r.status === 400 && r.json.reason === 'nonce_unknown', 'an unknown nonce: 400');
  h = make({ ipOk: false }); r = await h.call('meta', { node_pubkey: PK, nonce: nonce(), signature: 'sig' });
  check(r.status === 429 && h.calls.verify.length === 0, 'the address limit: 429 before LND');
  h = make({ keyOk: false }); r = await h.call('meta', { node_pubkey: PK, nonce: nonce(), signature: 'sig' });
  check(r.status === 429 && h.calls.consumed.length === 0, 'the key limit: 429, the nonce unspent');
  h = make();
  for (const [b, m] of [[{ node_pubkey: 'x', nonce: nonce(), signature: 's' }, 'bad key'], [{ node_pubkey: PK, nonce: 'x', signature: 's' }, 'bad nonce'], [{ node_pubkey: PK, nonce: nonce() }, 'no signature']]) { r = await h.call('meta', b); check(r.status === 400, m + ': 400'); }
  for (const [ch, m] of [[{ version: 0 }, 'version 0'], [{ state_fp: 'zz' }, 'bad fingerprint'], [{ file_b64: '***' }, 'not base64'], [{ file_b64: '' }, 'empty file']]) { r = await h.call('put', Object.assign(put(F1, 9000, '9'.repeat(64)), ch)); check(r.status === 400 && h.calls.verify.length === 0, 'put with ' + m + ': 400 before LND'); }
  r = await h.call('delete', { node_pubkey: PK, nonce: nonce(), signature: 'sig' });
  check(r.status === 404, 'no other action exists (a file is replaced, never deleted by request)');
  fs.rmSync(dir, { recursive: true, force: true });
  if (fails) { console.log('peer-storage-route: ' + fails + ' FAILED'); process.exit(1); } else console.log('peer-storage-route: all checks passed');
})();
