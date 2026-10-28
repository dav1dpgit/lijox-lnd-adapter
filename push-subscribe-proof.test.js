// 0.119.0 (S64, Kimi K3.1 Pro round 2 F13 — engine v358): the push subscription's proof binds the subscription
// (pushSubscriptionRecordId: endpoint, p256dh, auth); a subscription swapped on the path under the wallet's signature
// is refused; the old form (nothing bound, engines before v358) is still taken this one release and logged.
// handlePushSubscribe is read out of lij-adapter.js and run in a sandbox with the real registry.js and a fresh nonce
// store. Run: node push-subscribe-proof.test.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const secp256k1 = require('secp256k1');
const registry = require('./registry');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const a = src.indexOf('async function handlePushSubscribe(req, res) {'); const b = src.indexOf('// ── Rate Limiter', a);
if (a < 0 || b < 0) { console.log('FAIL · handlePushSubscribe block not found'); process.exit(1); }
let passed = 0, failed = 0;
const t = (n, ok, extra) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n + (extra ? ' — ' + extra : '')); } };
const registryNonceStore = new registry.NonceStore();
const pushSubs = {}; const log = [];
const ctx = {
  Object, String, JSON, console: { log: (m) => log.push(String(m)) },
  readBody: async (req) => req.body,
  jsonResponse: (res, obj, code) => { res.code = code || 200; res.body = obj; },
  registryBuildSignedMessage: registry.buildSignedMessage, registryVerifySignature: registry.verifySignature, registryNonceStore,
  pushSubscriptionRecordId: registry.pushSubscriptionRecordId,
  pushSubs, PUSH_SUBS_MAX: 10, persistPushSubs: () => {},
};
vm.createContext(ctx);
vm.runInContext(src.slice(a, b) + '\nthis.handlePushSubscribe = handlePushSubscribe;', ctx);
const { handlePushSubscribe } = ctx;
const priv = crypto.randomBytes(32); const pub = Buffer.from(secp256k1.publicKeyCreate(priv, true)).toString('hex');
const sub = { endpoint: 'https://push.example/v1/abc', expirationTime: null, keys: { p256dh: 'BAbC', auth: 'dEf' } };
function proof(recordId) {
  const { nonce } = registryNonceStore.issue();
  const digest = registry.buildSignedMessage('push-subscribe', nonce, pub, recordId);
  return { node_pubkey: pub, nonce, signature: Buffer.from(secp256k1.ecdsaSign(digest, priv).signature).toString('hex') };
}
async function post(body) { const res = {}; await handlePushSubscribe({ body }, res); return res; }

(async () => {
  let r = await post(Object.assign({ subscription: sub }, proof(registry.pushSubscriptionRecordId(sub))));
  t('a subscription signed over its own record is stored (200)', r.code === 200 && r.body.ok === true && pushSubs[pub] && pushSubs[pub].endpoint === sub.endpoint, JSON.stringify(r));
  const swapped = Object.assign({}, sub, { endpoint: 'https://attacker.example/v1/abc' });
  r = await post(Object.assign({ subscription: swapped }, proof(registry.pushSubscriptionRecordId(sub))));
  t('a subscription swapped after signing is refused (401) and the stored one stands', r.code === 401 && pushSubs[pub].endpoint === sub.endpoint, JSON.stringify(r));
  r = await post(Object.assign({ subscription: swapped }, proof('')));
  t('the old form (nothing bound) is still taken this release and logged', r.code === 200 && pushSubs[pub].endpoint === swapped.endpoint && log.some((l) => /signed in the OLD form/.test(l)), JSON.stringify(r));
  const p = proof(registry.pushSubscriptionRecordId(sub));
  r = await post(Object.assign({ subscription: sub }, p)); const r2 = await post(Object.assign({ subscription: sub }, p));
  t('the same proof twice: the nonce is spent', r.code === 200 && r2.code === 401, JSON.stringify(r2));
  console.log((failed ? 'FAIL' : 'PASS') + ' · push-subscribe-proof · ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
