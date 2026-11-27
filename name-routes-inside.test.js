'use strict';
// 0.146.1 (S73 Thu 2026-11-26 — an operator's journal of that day, for a wallet that switched provider: "[HTTP] POST
// /lnurl/release inside the connection of <the wallet's key>…" / "[LNURLP] release <name> by <the wallet's key>…
// refused: signature required" / "[RPC] lijox.lnurl_release <the wallet's key>… → 401"; the operator's word 23:38
// "Repair: approved. Go."):
// THE THREE NAME ROUTES TAKE THE CONNECTION'S KEY AS PROOF.
//   node name-routes-inside.test.js
// /lnurl/register, /lnurl/display and /lnurl/release read their own body (they do not use readBody()), so the mark of
// the connection never reached the proof check: since 0.142.0 put them in the table, each asked a request inside the
// Lightning connection for a signature — which the table's own rule had just taken off. A wallet that switched
// provider kept its name at the provider it left.
// WHY NO TEST SAW IT: f3c-forms.test.js runs the table on a stand-in for the web form, and its part b runs only the
// two routes whose code 0.142.0 changed. THIS TEST runs the three routes AS WRITTEN (read out of lij-adapter.js), with
// the real proof check and record rules, the real registry.js signatures, the real subs.js name rule, the table's own
// registrations on the real lijox-rpc.js and the real lijox-web-form.js — in BOTH forms.
// s: the source.   a: inside the connection, no signature.   b: whose key — inside the connection.
// c: the web form is as it was (a real signature, or refused).   d: what the journal says.
// STAND-INS: the name's registry (lnurlpNameAt — its calls are recorded), the store (lnurlpPersist), the address host.
const fs = require('fs'); const path = require('path'); const http = require('http'); const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const registry = require('./registry');
const subsLib = require('./subs');
const lib = require('./lijox-web-form');
const { createLijoxRpc } = require('./lijox-rpc');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 900) : '')); } else console.log('  ok · ' + m); };
const lift = (head, tail) => { const a = src.indexOf(head); if (a < 0) return null; const b = src.indexOf(tail || '\n}\n', a); return b > a ? src.slice(a, b + (tail || '\n}\n').length) : null; };
const J = (x) => JSON.stringify(x);
const keep = setInterval(() => {}, 1000);

(async () => {
  // ── s: the source ──
  const r0 = src.indexOf("  if (method === 'POST' && path === '/lnurl/register') {"), r1 = src.indexOf('  // ── PENDING INTENTS GET');
  const routes = (r0 > 0 && r1 > r0) ? src.slice(r0, r1) : '';
  check(!!routes && routes.includes("path === '/lnurl/display'") && routes.includes("path === '/lnurl/release'"), 's1 the three routes are read from the adapter as written');
  check(routes.includes('try { body = webFormLib.carry(req, JSON.parse(bodyStr)); } catch (e) {}') && routes.includes('try { dsp = webFormLib.carry(req, JSON.parse(dspStr)); } catch (e) {}') && routes.includes('try { rel = webFormLib.carry(req, JSON.parse(relStr)); } catch (e) {}'),
    's2 each of the three puts the connection\'s mark on the body it parsed');
  check(!/try \{ \w+ = JSON\.parse\(/.test(routes), 's3 none of the three parses a body without it');
  // every place lij-adapter.js reads a request's body by itself: readBody, the three above, and /client/prefs — whose
  // request inside the connection never reaches that route (lijox.prefs_set calls the one function both forms use)
  check((src.match(/req\.on\('data'/g) || []).length === 5, 's4 lij-adapter.js reads a body by itself in five places (readBody, the three name routes, /client/prefs)', (src.match(/req\.on\('data'/g) || []).length);
  check(src.includes("lijoxRpc.register('lijox.prefs_set', (caller, params) => {") && src.includes('  return prefsSet(caller.pubkey, params);\n});') && !/webForm\.call\([^)]*'\/client\/prefs'/.test(src),
    's5 the settings request inside the connection does not pass through the /client/prefs route');
  const rA = src.indexOf('// (the end of the 0.141.0 registrations)\n'), rB = src.indexOf('// (the end of the 0.142.0 registrations)');
  const block = src.slice(rA, rB);
  check(rA > 0 && rB > rA && ["['lijox.lnurl_register',      'POST', '/lnurl/register',       { key: ['client_pubkey'] }]", "['lijox.lnurl_release',       'POST', '/lnurl/release',        { key: ['client_pubkey'] }]", "['lijox.lnurl_display',       'POST', '/lnurl/display',        { key: ['client_pubkey'] }]"].every((x) => block.includes(x)),
    's6 the table has the three rows, each with the rule "client_pubkey is the connection\'s key"');

  // ── the rig: the routes and their helpers as written ──
  const parts = [
    lift('function authOk(req) {'), lift('function jsonResponse(res, data, status = 200) {'),
    lift('const lnurlpNameSafe = ', '\n'), lift('const LNURLP_LEGACY_LIFE_S = ', '\n'), lift('function lnurlpNowS() {', '\n'),
    lift('function lnurlpEntryLive(e, nowS) {'), lift('function lnurlpLiveFree(rec) {'), lift('function lnurlpNextIndex(rec) {'),
    lift('function lnurlpRegisterRecordId(name, hashes) {'), lift('function lnurlpRegisterRecordIdV1(name, hashes) {'), lift('function lnurlpAuthCheck(body, action, clientPk, recordId) {'),
    lift('function lnurlpDisplayClean(t) {'), lift('function lnurlpDisplayClean40(t) {', '\n'), lift('function lnurlpDisplayRecordId(name, display) {'),
  ];
  check(parts.every(Boolean), 's7 the helpers the routes call are read from the adapter as written', parts.map((p) => !!p));
  const SECRET = 'route-token-of-this-box', BOX = '02' + 'ee'.repeat(32), NEWBOX = '03' + 'cc'.repeat(32);
  const priv = crypto.randomBytes(32), PK = Buffer.from(secp256k1.publicKeyCreate(priv, true)).toString('hex');
  const privO = crypto.randomBytes(32), OTHER = Buffer.from(secp256k1.publicKeyCreate(privO, true)).toString('hex');
  const S = { nameAt: [], saved: 0, awake: [], journal: [] };
  const nonces = new registry.NonceStore();
  const env = {
    crypto, Buffer, webFormLib: lib, subsLib,
    CONFIG: { adapter: { secret: SECRET, port: 7000 }, lnurlp: { address_host: 'names.example' }, node: { pubkey: BOX } },
    console: { log: (m) => S.journal.push(String(m)), warn: (m) => S.journal.push(String(m)), error: (m) => S.journal.push(String(m)) },
    registryBuildSignedMessage: registry.buildSignedMessage, registryVerifySignature: registry.verifySignature, registryNonceStore: nonces,
    subs: { sellerOffered: false, oneUseHost: '' }, subsOneUseNamesOf: () => [], subsWalletNextIndex: () => 0,
    lnurlpRegistry: {}, LNURLP_MAX_LIVE_PER_NAME: 500,
    lnurlpNameAt: async (kind, name, to) => { S.nameAt.push(kind + ':' + name + (to ? ':' + String(to).slice(0, 4) : '')); return 'ok'; },
    lnurlpPersist: () => { S.saved++; }, lnurlpAddrHost: () => 'names.example', touchWalletActive: (pk) => { S.awake.push(String(pk).slice(0, 4)); },
    registerQuote: { currencyDecimals: (c) => (c === 'USD' ? 2 : null) },
  };
  const names = Object.keys(env);
  const A = new Function(...names, parts.join('\n')
    + '\nasync function handleHttp(req, res) {\n  const parsed = new URL(req.url, "http://localhost:7000"); const path = parsed.pathname; const method = req.method;\n'
    + routes + '\n  return jsonResponse(res, { ok: false, error: "Not found" }, 404);\n}\nreturn { handleHttp };')(...names.map((n) => env[n]));
  const reg = env.lnurlpRegistry;
  const server = http.createServer((req, res) => { A.handleHttp(req, res).catch((e) => { try { res.writeHead(500); res.end('{"ok":false,"error":"threw: ' + String(e.message).replace(/"/g, '') + '"}'); } catch (_) {} }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const web = async (p, body, token) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token === null ? {} : { 'x-adapter-secret': token || SECRET }), body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };
  const out = [];
  const rpc = createLijoxRpc({ version: '0.146.1', send: async (peer, type, buf) => { out.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
  const webForm = lib.createWebForm({ handle: (req, res) => A.handleHttp(req, res), secret: () => SECRET, log() {} });
  {
    const plainParams = (p) => (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; const BAD = (why) => ({ status: 400, body: { ok: false, error: why } });
    new Function('lijoxRpc', 'webForm', 'plainParams', 'BAD', 'nowS', 'moneyCall', 'pendingJitBuys', block)(rpc, webForm, plainParams, BAD, () => Math.floor(Date.now() / 1000), async () => ({ status: 500, body: {} }), new Map());
  }
  const inside = async (from, method, params) => { out.length = 0; await rpc.onMessage(from, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); const t = Date.now(); while (!out.length && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 10)); const a = out[0]; return !a ? { status: 0, body: null } : (a.result !== undefined ? { status: 200, body: a.result } : { status: (a.error && a.error.code) || 0, body: (a.error && a.error.data !== undefined) ? a.error.data : a.error }); };
  // a real proof, as the engine makes it: the provider's own nonce, the node key's signature over the record
  const proof = (key, pk, action, recordId) => { const { nonce } = nonces.issue(); const digest = registry.buildSignedMessage(action, nonce, pk, recordId); return { node_pubkey: pk, nonce, signature: Buffer.from(secp256k1.ecdsaSign(digest, key).signature).toString('hex') }; };
  const rid = new Function('crypto', 'Buffer', lift('function lnurlpRegisterRecordId(name, hashes) {') + lift('function lnurlpDisplayRecordId(name, display) {') + 'return { reg: lnurlpRegisterRecordId, dsp: lnurlpDisplayRecordId };')(crypto, Buffer);
  const far = Math.floor(Date.now() / 1000) + 86400 * 365;
  const H = (i) => ({ hash: crypto.createHash('sha256').update('h' + i).digest('hex'), secret: crypto.createHash('sha256').update('s' + i).digest('hex'), expires: far, index: i });
  const refused = () => S.journal.filter((l) => /refused: /.test(l));

  // ── a: inside the connection, no signature — the body the wallet page sends (its key, no nonce, no signature) ──
  let i = await inside(PK, 'lijox.lnurl_register', { name: 'shop', client_pubkey: PK, hashes: [], node_pubkey: PK });
  check(i.status === 200 && i.body && i.body.ok === true && i.body.pool_size === 0 && i.body.address === 'shop@names.example' && reg.shop && reg.shop.client_pubkey === PK && S.nameAt.join() === 'claim:shop',
    'a1 a name asked for inside the connection is given: the record is the connection\'s key\'s, the name is claimed at the shared host', { i, nameAt: S.nameAt });
  i = await inside(PK, 'lijox.lnurl_register', { name: 'shop', client_pubkey: PK, hashes: [H(0), H(1)], node_pubkey: PK });
  check(i.status === 200 && i.body.ok === true && i.body.added === 2 && i.body.pool_size === 2 && i.body.next_index === 2 && reg.shop.entries.length === 2,
    'a2 the name\'s payment hashes are refilled inside the connection (two offered, two kept)', i);
  i = await inside(PK, 'lijox.lnurl_display', { name: 'shop', client_pubkey: PK, display: 'Corner Shop', currency: 'USD', node_pubkey: PK });
  check(i.status === 200 && i.body.ok === true && reg.shop.display === 'Corner Shop' && reg.shop.currency === 'USD', 'a3 the display name and the Register currency are filed inside the connection', i);
  reg.shop.neutral = true; S.nameAt.length = 0;
  i = await inside(PK, 'lijox.lnurl_release', { name: 'shop', client_pubkey: PK, transfer_to: NEWBOX, node_pubkey: PK });
  check(i.status === 200 && i.body.ok === true && i.body.released === true && i.body.transferred === true && !reg.shop && S.nameAt.join() === 'transfer:shop:03cc',
    'a4 A WALLET THAT SWITCHES PROVIDER: the name is released inside the connection and transferred at the shared host to the provider it moves to', { i, nameAt: S.nameAt });
  check(refused().length === 0, 'a5 the journal has no refusal for any of the four', refused());
  // a real proof sent inside the connection all the same (a wallet page older than the one that leaves it out): the
  // table takes the nonce and the signature off, and the connection's key is the proof
  i = await inside(PK, 'lijox.lnurl_register', Object.assign({ name: 'shop', client_pubkey: PK, hashes: [] }, proof(priv, PK, 'lnurl-register', rid.reg('shop', []))));
  check(i.status === 200 && i.body.ok === true && reg.shop && reg.shop.client_pubkey === PK, 'a6 a request inside the connection that carries a proof anyway is served the same', i);

  // ── b: whose key — inside the connection ──
  reg.theirs = { client_pubkey: OTHER, entries: [], created: 1, neutral: true }; S.nameAt.length = 0;
  i = await inside(PK, 'lijox.lnurl_release', { name: 'theirs', client_pubkey: OTHER, node_pubkey: OTHER });
  check(i.status === 403 && reg.theirs && S.nameAt.length === 0, 'b1 another wallet\'s name is not released from this connection, whatever key the request names (403; the name stays; nothing asked of the shared host)', { i, nameAt: S.nameAt });
  i = await inside(PK, 'lijox.lnurl_register', { name: 'theirs', client_pubkey: OTHER, hashes: [H(7)], node_pubkey: OTHER });
  check(i.status === 409 && i.body && /name taken/.test(J(i.body)) && reg.theirs.entries.length === 0 && reg.theirs.client_pubkey === OTHER, 'b2 another wallet\'s name takes no hashes from this connection (409 name taken)', i);
  i = await inside(PK, 'lijox.lnurl_display', { name: 'theirs', client_pubkey: OTHER, display: 'mine now', node_pubkey: OTHER });
  check(i.status === 403 && reg.theirs.display === undefined, 'b3 another wallet\'s display name is not changed from this connection (403)', i);
  // past the table's rule: the route itself, handed a body that names a key that is not its connection's
  let f = await webForm.call(PK, 'POST', '/lnurl/release', { name: 'theirs', client_pubkey: OTHER });
  check(f.status === 403 && /the connection's key is not the record's key/.test(J(f.body)) && reg.theirs, 'b4 the route itself refuses a body that names another key than its connection\'s (the proof check, 403)', f);
  f = await webForm.call(PK, 'POST', '/lnurl/register', { name: 'fresh', client_pubkey: OTHER, hashes: [] });
  check(f.status === 403 && !reg.fresh, 'b5 and gives no new name to a key that is not its connection\'s', f);

  // ── c: the web form is as it was ──
  S.journal.length = 0;
  let w = await web('/lnurl/register', { name: 'webname', client_pubkey: PK, hashes: [], node_pubkey: PK });
  const w2 = await web('/lnurl/display', { name: 'shop', client_pubkey: PK, display: 'x', node_pubkey: PK });
  const w3 = await web('/lnurl/release', { name: 'shop', client_pubkey: PK, node_pubkey: PK });
  check(w.status === 401 && w2.status === 401 && w3.status === 401 && [w, w2, w3].every((x) => x.body.error === 'auth: signature required') && !reg.webname && reg.shop && reg.shop.display !== 'x',
    'c1 AS A WEB REQUEST each of the three still needs its signature (401 signature required; nothing changed)', { w, w2, w3 });
  check(refused().length === 3 && refused().every((l) => /refused: signature required$/.test(l)), 'c2 and the journal says so, three times', refused());
  w = await web('/lnurl/release', { name: 'shop', client_pubkey: PK, node_pubkey: PK, via: 'connection', caller: PK, 'lijox.caller': PK });
  check(w.status === 401 && reg.shop, 'c3 a web request cannot say it came inside a connection (the mark is not a field of the body)', w);
  w = await web('/lnurl/register', Object.assign({ name: 'webname', client_pubkey: PK, hashes: [H(20)] }, proof(priv, PK, 'lnurl-register', rid.reg('webname', [H(20)]))));
  check(w.status === 200 && w.body.ok === true && w.body.added === 1 && reg.webname && reg.webname.client_pubkey === PK, 'c4 with the node key\'s real signature over the record the web register is served, as before', w);
  w = await web('/lnurl/register', Object.assign({ name: 'webname', client_pubkey: PK, hashes: [H(21)] }, proof(priv, PK, 'lnurl-register', rid.reg('webname', [H(22)]))));
  check(w.status === 401 && reg.webname.entries.length === 1, 'c5 a signature over other hashes than the ones sent is refused, as before', w);
  w = await web('/lnurl/display', Object.assign({ name: 'webname', client_pubkey: PK, display: 'Web Shop' }, proof(priv, PK, 'lnurl-display', rid.dsp('webname', 'Web Shop'))));
  check(w.status === 200 && reg.webname.display === 'Web Shop', 'c6 the web display filing with its real signature is served, as before', w);
  w = await web('/lnurl/release', Object.assign({ name: 'webname', client_pubkey: PK }, proof(privO, OTHER, 'lnurl-release', 'webname')));
  check(w.status === 403 && reg.webname, 'c7 the web release signed by another key is refused, as before', w);
  w = await web('/lnurl/release', Object.assign({ name: 'webname', client_pubkey: PK }, proof(priv, PK, 'lnurl-release', 'webname')));
  check(w.status === 200 && w.body.released === true && !reg.webname, 'c8 the web release with its real signature is served, as before', w);
  w = await web('/lnurl/release', { name: 'shop', client_pubkey: PK, node_pubkey: PK }, null);
  check(w.status === 401 && w.body.error === 'auth', 'c9 without the route token a web request does not reach the route', w);

  // ── d: both forms give the same answer ──
  reg.same1 = { client_pubkey: PK, entries: [], created: 1 }; reg.same2 = { client_pubkey: PK, entries: [], created: 1 };
  w = await web('/lnurl/release', Object.assign({ name: 'same1', client_pubkey: PK }, proof(priv, PK, 'lnurl-release', 'same1')));
  i = await inside(PK, 'lijox.lnurl_release', { name: 'same2', client_pubkey: PK });
  check(w.status === 200 && i.status === 200 && J(w.body) === J(i.body) && !reg.same1 && !reg.same2, 'd1 a release: the same answer in both forms', { w, i });
  w = await web('/lnurl/release', Object.assign({ name: 'gone', client_pubkey: PK }, proof(priv, PK, 'lnurl-release', 'gone')));
  i = await inside(PK, 'lijox.lnurl_release', { name: 'gone', client_pubkey: PK });
  check(w.status === 404 && i.status === 404 && J(w.body) === J(i.body), 'd2 a name this provider does not hold: 404 in both forms', { w, i });

  server.close(); clearInterval(keep);
  console.log(fails ? 'FAIL · name-routes-inside (' + fails + ')' : 'PASS · name-routes-inside (s1–s7, a1–a6, b1–b5, c1–c9, d1–d2)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · threw: ' + (e && e.stack || e)); process.exit(1); });
