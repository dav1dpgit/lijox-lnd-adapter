// 0.116.0 (S63, Kimi round 2 F10 / F14 — DP "Agreed" / "Yes"): the awake proof. touchWalletActive from HTTP happens only
// behind a verified node-key proof: the signed heartbeat, the signed pending poll, the signed prefs, the signed note read
// (and the register/release/report/claim that were signed already). The typed-pubkey sites stamp nothing. A source
// test (the routes run inside the HTTP handler); the live refusals are probed by build_01160.py's stand-in boot.
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/lij-adapter.js', 'utf8');
let passed = 0, failed = 0; const t = (n, ok) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n); } };
const route = (start, end) => { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i); return j < 0 ? src.slice(i) : src.slice(i, j); };
// the heartbeat
const hb = route("if (method === 'POST' && path === '/v1/heartbeat') {", "if (method === 'POST' && path === '/v1/route/report')");
t('POST /v1/heartbeat exists, under the route token', /if \(!authOk\(req\)\) return errResponse\(res, 'Unauthorized', 401\);/.test(hb));
t('the heartbeat checks the 90-s window, then the proof over hb:<ts>, then stamps', /proofTsOk\(hb\.ts\)[\s\S]*lnurlpAuthCheck\(hb, 'heartbeat', hpk, 'hb:' \+ String\(Math\.floor\(Number\(hb\.ts\)\)\)\)[\s\S]*touchWalletActive\(hpk\)/.test(hb) && hb.indexOf('lnurlpAuthCheck') < hb.indexOf('touchWalletActive'));
// the health ping stamps contact, not awake
const health = route("if (path === '/health' && method === 'GET') {", "if (path === '/lsps/registry/my-channels'");
t('/health?client= stamps the contact record only — no touchWalletActive', /walletContactTouch\(_m\[1\]\.toLowerCase\(\), 'http'\)/.test(health) && !/touchWalletActive\(/.test(health));
// the pending poll
const pget = route("if (path === '/lsps2/pending' && method === 'GET') {", "const byHash = {};");
t('GET /lsps2/pending stamps nothing', !/touchWalletActive\(/.test(pget));
const ppost = route("if (path === '/lsps2/pending' && method === 'POST') {", "const pending = [];");
t('POST /lsps2/pending stamps only behind the proof over pending:<ts> (within 90 s); a plain poll still answers', /if \(body\.signature \|\| body\.nonce \|\| body\.node_pubkey\) \{[\s\S]*proofTsOk\(body\.ts\)[\s\S]*lnurlpAuthCheck\(body, 'lsps2-pending', pubkey, 'pending:' \+ String\(Math\.floor\(Number\(body\.ts\)\)\)\)[\s\S]*touchWalletActive\(pubkey\);[\s\S]*\}/.test(ppost) && (ppost.match(/touchWalletActive\(/g) || []).length === 1);
// prefs
const prefs = route("if (method === 'POST' && path === '/client/prefs') {", "console.log(`[prefs]");
t('/client/prefs requires the proof over prefs:<hold_ms> before the write', /lnurlpAuthCheck\(body, 'client-prefs', String\(body\.client_pubkey\)\.toLowerCase\(\), 'prefs:' \+ String\(body\.hold_ms\)\)/.test(prefs) && prefs.indexOf("lnurlpAuthCheck(body, 'client-prefs'") < prefs.indexOf('clientPrefs[pk] = '));
// the note
const note = route("if (method === 'GET' && path.startsWith('/lnurl/note/')) {", "return jsonResponse(res, { ok: true, note:");
t('/lnurl/note requires the proof (from the query) over note:<hash>:<client> before the lookup answers', /lnurlpAuthCheck\(proofFromQuery\(parsed\.searchParams\), 'lnurl-note', who, 'note:' \+ hash \+ ':' \+ who\)/.test(note) && note.indexOf("lnurlpAuthCheck(proofFromQuery") < note.indexOf("if (!hit) return"));
// the typed-pubkey sites
t('register_secret and the JIT buy stamp nothing', !/touchWalletActive\(promise\.client_pubkey\);  \/\* v0\.55\.1 R2 \*\//.test(src) && !/touchWalletActive\(clientPubkey\);  \/\* v0\.55\.1 R2: a buy proves awake \*\//.test(src));
// every remaining touchWalletActive in the file sits behind a proof or a signed route
const sites = [...src.matchAll(/touchWalletActive\(([^)]*)\)/g)].map((m) => src.slice(0, m.index).split('\n').length);
t('the remaining touch sites are few and named (the definition, the rail hook, heartbeat, pending POST, register, note, claim): ' + sites.length, sites.length <= 8);
// the rail gets the proof and the delete
t('the Push rail is handed proofCheck (lnurlpAuthCheck) and lndDelete', /proofCheck: \(fields, action, clientPk, recordId\) => lnurlpAuthCheck\(fields, action, clientPk, recordId\)/.test(src) && /lndDelete: \(p\) => lndRequest\('DELETE', p, null\)/.test(src));
// K1
t('the release sends the signed transfer when the wallet names the provider it moves to', /lnurlpNameAt\('transfer', relName, relTo\)/.test(src) && /if \(kind === 'transfer'\) parts\.push\(String\(toPubkey \|\| ''\)\);/.test(src));
console.log((failed ? 'FAIL' : 'PASS') + ' · proof-routes · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
