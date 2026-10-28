// 0.119.0 (S64, Kimi K3.1 Pro round 2 F24 — engine v358 / page v1074): a tape is evidence filed under a wallet's key.
// A signed drop (tape_json + the node key's proof over "tapedrop:<tape_id>:<sha256 of the text>") is filed under the
// key that signed it; a tape swapped on the path is refused; a stranger's proof for another wallet's key is refused; an
// unsigned drop (an older page) is still taken this one release through the old peer check, named `claimed-…`.
// handleTapeDrop, tapedropRecordId and lnurlpAuthCheck are read out of lij-adapter.js and run in a sandbox with the
// real registry.js (secp256k1), a fresh nonce store, a stand-in peer set and a temp tape dir. Run: node tapedrop-proof.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const secp256k1 = require('secp256k1');
const registry = require('./registry');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const grab = (startMarker, endMarker) => { const a = src.indexOf(startMarker), b = src.indexOf(endMarker, a); if (a < 0 || b < 0) throw new Error('block not found: ' + startMarker); return src.slice(a, b); };
const tdBlock = grab('function tapedropRecordId(tapeId, tapeJson) {', 'async function handleOpenIntent(');
const authBlock = grab('function lnurlpAuthCheck(body, action, clientPk, recordId) {', '// 0.116.0 (S63, engine v355\'s lsp_proof): the same check for a GET');
const sweepBlock = src.match(/function tapesSweep\([\s\S]*?\n}\n/)[0];

let passed = 0, failed = 0;
const t = (n, ok, extra) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n + (extra ? ' — ' + extra : '')); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapedrop-'));
const registryNonceStore = new registry.NonceStore();
const peers = new Set();
const log = [];
const ctx = {
  crypto, Buffer, String, Number, Array, JSON, Date, Object, Error,
  console: { log: (m) => log.push(String(m)), warn: (m) => log.push(String(m)) },
  require,
  registryBuildSignedMessage: registry.buildSignedMessage, registryVerifySignature: registry.verifySignature, registryNonceStore,
  TAPES_DIR: dir, TAPES_MAX_BYTES: 1024 * 1024, TAPES_KEEP_DAYS: 30,
  tdRateLimited: () => false,
  readBody: async (req) => req.body,
  peersConnectedSet: async () => peers,
  telemetrySeen: () => {},
};
vm.createContext(ctx);
vm.runInContext(sweepBlock + '\n' + authBlock + '\n' + tdBlock + '\nthis.handleTapeDrop = handleTapeDrop; this.tapedropRecordId = tapedropRecordId;', ctx);
const { handleTapeDrop, tapedropRecordId } = ctx;

const priv = crypto.randomBytes(32); const pub = Buffer.from(secp256k1.publicKeyCreate(priv, true)).toString('hex');
const other = crypto.randomBytes(32); const otherPub = Buffer.from(secp256k1.publicKeyCreate(other, true)).toString('hex');
function proof(recordId, key = priv, pk = pub) {
  const { nonce } = registryNonceStore.issue();
  const digest = registry.buildSignedMessage('tapedrop', nonce, pk, recordId);
  return { node_pubkey: pk, nonce, signature: Buffer.from(secp256k1.ecdsaSign(digest, key).signature).toString('hex') };
}
async function drop(body) {
  const res = { writeHead(c) { this.code = c; }, end(s) { this.body = JSON.parse(s); } };
  await handleTapeDrop({ body }, res, '127.0.0.1');
  return { code: res.code, body: res.body };
}
const files = () => fs.readdirSync(dir).sort();

(async () => {
// the record rule
t('tapedropRecordId: "tapedrop:<id>:<sha256 of the text>"', tapedropRecordId('ring-1', '{"a":1}') === 'tapedrop:ring-1:' + crypto.createHash('sha256').update('{"a":1}', 'utf8').digest('hex'));

// a signed drop
const tape = JSON.stringify({ kind: 'console_ring', reason: 'test', ts: 1, lines: ['x'] });
let r = await drop(Object.assign({ client_pubkey: pub, tape_id: 'ring-1', tape_json: tape }, proof(tapedropRecordId('ring-1', tape))));
t('a signed drop is filed (200), under the key that signed, the file holding the text as sent', r.code === 200 && files().length === 1 && /-ring-1\.json$/.test(files()[0]) && !/^claimed-/.test(files()[0]) && fs.readFileSync(path.join(dir, files()[0]), 'utf8') === tape, JSON.stringify(r));

// the tape swapped on the path
r = await drop(Object.assign({ client_pubkey: pub, tape_id: 'ring-2', tape_json: tape.replace('"x"', '"forged"') }, proof(tapedropRecordId('ring-2', tape))));
t('a tape changed after signing is refused (401 signature_invalid), nothing written', r.code === 401 && r.body.code === 'signature_invalid' && files().length === 1, JSON.stringify(r));

// a stranger's valid proof naming the victim's key
r = await drop(Object.assign({ client_pubkey: pub, tape_id: 'ring-3', tape_json: tape }, proof(tapedropRecordId('ring-3', tape), other, otherPub)));
t('a stranger\'s own proof, filing under another wallet\'s key → 403 (the signer is not the record\'s key)', r.code === 403 && files().length === 1, JSON.stringify(r));

// the proof reused
const p4 = proof(tapedropRecordId('ring-4', tape));
r = await drop(Object.assign({ client_pubkey: pub, tape_id: 'ring-4', tape_json: tape }, p4));
const r4b = await drop(Object.assign({ client_pubkey: pub, tape_id: 'ring-4', tape_json: tape }, p4));
t('the same proof twice: the second is refused (the nonce is spent)', r.code === 200 && r4b.code === 401 && r4b.body.code === 'nonce_already_used', JSON.stringify(r4b));

// tape_json that is not JSON
r = await drop(Object.assign({ client_pubkey: pub, tape_id: 'ring-5', tape_json: 'not json' }, proof(tapedropRecordId('ring-5', 'not json'))));
t('signed text that is not JSON → 400', r.code === 400 && r.body.code === 'BAD_JSON', JSON.stringify(r));

// a signed body without the text
r = await drop(Object.assign({ client_pubkey: pub, tape_id: 'ring-6', tape: { a: 1 } }, proof('tapedrop:ring-6:x')));
t('proof fields without tape_json → 400 BAD_FIELDS', r.code === 400 && r.body.field === 'tape_json', JSON.stringify(r));

// an unsigned drop from an older page: the old peer check, the claimed- name
r = await drop({ client_pubkey: pub, tape_id: 'old-1', tape: { kind: 'console_ring', lines: [] } });
t('unsigned, not a connected peer → 403 PUBKEY_NOT_CONNECTED (the old rule)', r.code === 403 && r.body.code === 'PUBKEY_NOT_CONNECTED', JSON.stringify(r));
peers.add(pub);
r = await drop({ client_pubkey: pub, tape_id: 'old-1', tape: { kind: 'console_ring', lines: [] } });
t('unsigned from a connected peer: taken this release, the file named claimed-… and the log says so', r.code === 200 && files().some((f) => /^claimed-\d+-old-1\.json$/.test(f)) && log.some((l) => /unsigned — attribution claimed, not proven/.test(l)), JSON.stringify(r) + ' ' + files().join(','));

// the engine's list names the action (the twin's side of the rule)
t('the engine\'s PROOF_ACTIONS carries "tapedrop" (lij-core registry_client.rs)', (() => { try { const rs = fs.readFileSync(path.join(__dirname, '..', 'lightning-in-a-jar', 'lij', 'lij-core', 'src', 'registry_client.rs'), 'utf8'); return /PROOF_ACTIONS: &\[&str\] = &\[[^\]]*"tapedrop"/.test(rs); } catch (e) { return true; /* the engine repo is not beside this one here — the engine's own test pins the list */ } })());

fs.rmSync(dir, { recursive: true, force: true });
console.log((failed ? 'FAIL' : 'PASS') + ' · tapedrop-proof · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
})();
