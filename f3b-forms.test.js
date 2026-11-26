'use strict';
// 0.141.0 (S72 Wed 2026-11-25, F3b — the wallet repo's docs/design/routes/f3b-r1.md): RECEIVING AND CHANNELS INSIDE THE
// LIGHTNING CONNECTION — lijox.jit_info, lijox.jit_buy, lijox.register_secret, lijox.pending, lijox.openintent,
// lijox.openintent_status, lijox.funding_status, lijox.lease_policy, lijox.wake_schedule.
//   node f3b-forms.test.js
// s: the source — the nine registrations, none marked as moving money, and the counts of their web forms.
// n: the nine registrations as the adapter writes them, on a stand-in for the web form: what each sends to which web
//    route, whose key it names, what it refuses before the route is asked.
// b: BOTH FORMS, THE REAL ROUTES, for five of them: the lease policy, the wake poll, the reminder times, the funding
//    check and the open intent. One handler made of the adapter's own lines as written; the same request is sent to
//    it as a web request (a real HTTP server, the route token, the proof) and inside the connection (the real
//    lijox-rpc.js → the real registrations → the real lijox-web-form.js). The answers are compared.
// NOT COMPARED IN BOTH FORMS HERE: /lsps2/get_info, /lsps2/buy, /lsps2/register_secret. Their route code stands on a
// dozen of the adapter's inner functions (the fee law, the promise store, the floor's daily count); part n shows
// what each registration hands to its route, and the hand-over itself is the one the five above go through.
const fs = require('fs'); const path = require('path'); const http = require('http');
const lib = require('./lijox-web-form');
const subsLib = require('./subs');
const { createLijoxRpc } = require('./lijox-rpc');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : '')); } else console.log('  ok · ' + m); };
const lift = (head, tail) => { const a = src.indexOf(head); if (a < 0) return null; const b = src.indexOf(tail || '\n}\n', a); return b > a ? src.slice(a, b + (tail || '\n}\n').length) : null; };
const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32), SECRET = 'route-token-of-this-box';
const SCID = '00000a0000b0000c', SCID2 = '00000a0000b0000d', HASH = 'ab'.repeat(32), SEC = 'cd'.repeat(32), FUND = 'ef'.repeat(32) + ':1';
const NINE = ['lijox.jit_info', 'lijox.jit_buy', 'lijox.register_secret', 'lijox.pending', 'lijox.openintent', 'lijox.openintent_status', 'lijox.funding_status', 'lijox.lease_policy', 'lijox.wake_schedule'];
const keep = setInterval(() => {}, 1000);

(async () => {
  // ── s: the source ──
  const rA = src.indexOf('// (the end of the 0.140.0 registrations)\n'), rB = src.indexOf('// (the end of the 0.141.0 registrations)');
  const block = src.slice(rA, rB);
  check(rA > 0 && rB > rA && NINE.every((m) => block.includes("lijoxRpc.register('" + m + "'")), 's1 the nine registrations are in the adapter, after those of 0.140.0');
  check(!/money: true/.test(block), 's2 none of the nine is marked as moving money (no request id: a buy is a promise, a secret is stored under a key, an intent is a status record)');
  const unnamed = lift('const MOVED_WEB_UNNAMED = {', '};'), qkey = lift('const MOVED_WEB_QUERY_KEY = {', '\n'), qclient = lift('const MOVED_WEB_QUERY_CLIENT = {', '\n');
  check(/'POST \/lsps2\/register_secret': 'lijox\.register_secret'/.test(unnamed) && /'GET \/lease\/policy': 'lijox\.lease_policy'/.test(unnamed) && /'GET \/v1\/jit-funding\/status': 'lijox\.funding_status'/.test(qkey)
    && /'GET \/lsps2\/get_info': 'lijox\.jit_info', 'GET \/lsps2\/pending': 'lijox\.pending'/.test(qclient || ''), 's3 web forms counted by route: the secret and the lease policy (no wallet named), the funding check (client_pubkey), the terms and the old poll (client)');
  const topC = lift("  if (!viaConn && MOVED_WEB_QUERY_CLIENT[method + ' ' + path]) {", '\n'), topD = lift("  if (!viaConn && method === 'GET' && path.startsWith('/openintent/')) {", '\n');
  check(!!topC && /if \(\/\^\[0-9a-f\]\{66\}\$\/\.test\(_c\)\) formCounts\.web\(_c,/.test(topC), 's4 GET /lsps2/get_info is counted ONLY when it names a wallet (without one it is the public read of a provider\'s card, which stays)');
  check(["formCounts.web(pubkey, 'lijox.pending')", "formCounts.web(clientPubkey, 'lijox.jit_buy')", "formCounts.web(wpk, 'lijox.wake_schedule')", "formCounts.web(pk, 'lijox.openintent')"].every((x) => src.includes('if (!viaConn) { try { ' + x)), 's5 the four web forms that name their wallet in the body are counted with it, and only as web requests');
  check(src.includes("viaConn ? 'peer:' + viaConn : String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '?'), viaConn);"), 's6 an open intent inside the connection is limited per wallet (the web form\'s limit is per address; inside, every wallet would share one)');

  // ── n: the registrations, with a stand-in for the web form ──
  {
    const calls = []; const sent = [];
    const stubForm = { call: async (pk, m, p, body, query) => { calls.push({ pk, m, p, body: body === undefined ? null : body, query: query || null }); return { status: 200, body: { ok: true } }; } };
    const pendingJitBuys = new Map([[SCID, { client_pubkey: PK }], [SCID2, { client_pubkey: OTHER }]]);
    const rpc = createLijoxRpc({ version: '0.141.0', send: async (peer, type, buf) => { sent.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
    const plainParams = (p) => (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; const BAD = (why) => ({ status: 400, body: { ok: false, error: why } });
    new Function('lijoxRpc', 'webForm', 'plainParams', 'BAD', 'pendingJitBuys', block)(rpc, stubForm, plainParams, BAD, pendingJitBuys);
    const ask = async (method, params) => { sent.length = 0; await rpc.onMessage(PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); return sent[0]; };
    const last = () => calls[calls.length - 1]; const J = (x) => JSON.stringify(x);
    // the path's answer: `result` is the route's body (a 2xx), `error` carries the route's status as its code and the body as its data
    const st = (a) => !a ? null : (a.result !== undefined ? 200 : (a.error ? a.error.code : null));
    let a = await ask('lijox.jit_info', { client: OTHER });
    check(st(a) === 200 && last().m === 'GET' && last().p === '/lsps2/get_info' && J(last().query) === J({ client: PK }), 'n1 lijox.jit_info is GET /lsps2/get_info for the connection\'s key, whatever was sent', last());
    a = await ask('lijox.jit_buy', { version: 1, payment_size_msat: '5000000', client_pubkey: OTHER, extra: 1 });
    check(st(a) === 200 && last().p === '/lsps2/buy' && J(last().body) === J({ version: 1, client_pubkey: PK, payment_size_msat: '5000000' }), 'n2 lijox.jit_buy is POST /lsps2/buy with the version, the size and the connection\'s key — nothing else that was sent', last());
    a = await ask('lijox.jit_buy', { version: 1 });
    check(J(last().body) === J({ version: 1, client_pubkey: PK }), 'n3 a buy without a size (an open amount) sends none', last());
    let n0 = calls.length; a = await ask('lijox.jit_buy', [1]);
    check(st(a) === -32602 && calls.length === n0, 'n4 a buy whose params are not an object is refused by the path, and the route is not asked', a);
    a = await ask('lijox.register_secret', { jit_channel_scid: SCID, payment_secret: SEC, total_msat: 5000000, signature: 'x' });
    check(st(a) === 200 && last().p === '/lsps2/register_secret' && J(last().body) === J({ jit_channel_scid: SCID, payment_secret: SEC, total_msat: 5000000 }), 'n5 the secret of a promise THIS wallet bought goes to POST /lsps2/register_secret as sent', last());
    n0 = calls.length; a = await ask('lijox.register_secret', { jit_channel_scid: SCID2, payment_secret: SEC, total_msat: 5000000 });
    check(st(a) === 403 && calls.length === n0 && /another wallet/.test(J(a.error.data)), 'n6 the secret for a promise ANOTHER wallet bought is refused, and the route is not asked (the web form cannot tell who sends it)', a);
    a = await ask('lijox.register_secret', { jit_channel_scid: 'ffffffffffffffff', payment_secret: SEC, total_msat: 1 });
    check(calls.length === n0 + 1 && last().p === '/lsps2/register_secret', 'n7 a promise this box does not have: the route answers for itself (404 there)');
    a = await ask('lijox.register_secret', { payment_hash: HASH, payment_secret: SEC, total_msat: 21000, jit_scid: SCID });
    check(st(a) === 200 && J(last().body) === J({ payment_hash: HASH, payment_secret: SEC, total_msat: 21000, jit_scid: SCID }), 'n8 the plain form (an invoice\'s hash and secret) goes through as sent', last());
    const t0 = Math.floor(Date.now() / 1000); a = await ask('lijox.pending', { client_pubkey: OTHER });
    check(st(a) === 200 && last().p === '/lsps2/pending' && last().m === 'POST' && last().body.client_pubkey === PK && last().body.node_pubkey === PK && Math.abs(last().body.ts - t0) <= 2 && Object.keys(last().body).length === 3, 'n9 lijox.pending is the POST poll for the connection\'s key, with the time and no signature', last());
    const intent = { v: 1, intent_id: '11111111-2222-3333-4444-555555555555', client_pubkey: PK, amount_sats: 50000, fee_rate_sat_vb: 2, created_ms: 1, expiry_ms: 2, sig: 'sig' };
    a = await ask('lijox.openintent', intent);
    check(st(a) === 200 && last().p === '/openintent' && J(last().body) === J(intent), 'n10 lijox.openintent is POST /openintent with the intent as the wallet signed it', last());
    n0 = calls.length; a = await ask('lijox.openintent', Object.assign({}, intent, { client_pubkey: OTHER }));
    check(st(a) === 403 && calls.length === n0, 'n11 an intent that names another wallet\'s key is refused, and the route is not asked', a);
    a = await ask('lijox.openintent_status', { intent_id: intent.intent_id });
    check(st(a) === 200 && last().m === 'GET' && last().p === '/openintent/' + intent.intent_id, 'n12 lijox.openintent_status is GET /openintent/<id>', last());
    n0 = calls.length; a = await ask('lijox.openintent_status', { intent_id: '../v1/state' });
    check(st(a) === 400 && calls.length === n0, 'n13 an id that is not an id is refused before any route is asked', a);
    a = await ask('lijox.funding_status', { funding: FUND.toUpperCase(), client_pubkey: OTHER });
    check(st(a) === 200 && last().p === '/v1/jit-funding/status' && J(last().query) === J({ client_pubkey: PK, funding: FUND }), 'n14 lijox.funding_status is the funding check for the connection\'s key', last());
    n0 = calls.length; a = await ask('lijox.funding_status', { funding: 'nope' });
    check(st(a) === 400 && calls.length === n0, 'n15 a funding that is not txid:vout is refused', a);
    a = await ask('lijox.lease_policy', {});
    check(st(a) === 200 && last().m === 'GET' && last().p === '/lease/policy' && last().body === null, 'n16 lijox.lease_policy is GET /lease/policy', last());
    a = await ask('lijox.wake_schedule', { times: [1800000000, 1800003600], node_pubkey: OTHER, signature: 'x' });
    check(st(a) === 200 && last().p === '/v1/wake/schedule' && J(Object.keys(last().body).sort()) === J(['node_pubkey', 'times', 'ts', 'v']) && last().body.node_pubkey === PK && J(last().body.times) === J([1800000000, 1800003600]), 'n17 lijox.wake_schedule is POST /v1/wake/schedule with the times, the time now and the connection\'s key — no signature', last());
    n0 = calls.length; a = await ask('lijox.wake_schedule', { times: 'x' });
    check(st(a) === 400 && calls.length === n0, 'n18 reminder times that are not a list are refused', a);
    const hello = await ask('lijox.hello', {});
    check(hello.result && Array.isArray(hello.result.methods) && NINE.every((m) => hello.result.methods.includes(m)), 'n19 lijox.hello names all nine', hello.result);
    a = await ask('lijox.jit_buy', { version: 1, rid: 'x'.repeat(8) });
    check(st(a) === 200, 'n20 none of the nine asks for a request id');
  }

  // ── b: both forms, the real routes ──
  const fAuthOk = lift('function authOk(req) {'), fJson = lift('function jsonResponse(res, data, status = 200) {'), fErr = lift('function errResponse(res, msg, status = 400) {');
  const fRead = lift('function readBody(req, maxBytes) {'), fProof = lift('function lnurlpAuthCheck(body, action, clientPk, recordId) {'), fTs = lift('function proofTsOk(ts) {', '\n');
  const fOi = lift('async function handleOpenIntent(req, res, path, method, ip, viaConn) {'), fOiRate = lift('function oiRateLimited(ip) {');
  const hLease = lift("  if (path === '/lease/policy' && req.method === 'GET') {", '\n  }\n'), hPend = lift("  if (path === '/lsps2/pending' && method === 'POST') {", "    return jsonResponse(res, { pending });\n  }\n");
  const hWake = lift("  if (method === 'POST' && path === '/v1/wake/schedule') {", '\n  }\n'), hFund = lift("  if (method === 'GET' && path === '/v1/jit-funding/status') {", '\n  }\n');
  const hOi = lift("  if (path === '/openintent' || path.startsWith('/openintent/')) {", '\n  }\n');
  const topA = lift("  if (!viaConn && MOVED_WEB_UNNAMED[method + ' ' + path]) {", '\n'), topB = lift("  if (!viaConn && MOVED_WEB_QUERY_KEY[method + ' ' + path]) {", '\n');
  check([fAuthOk, fJson, fErr, fRead, fProof, fTs, fOi, fOiRate, hLease, hPend, hWake, hFund, hOi, topA, topB, topC, topD, unnamed, qkey, qclient].every(Boolean), 'b0 the routes and their helpers are read from the adapter as written');
  const GOODSIG = 'a1'.repeat(64), NONCE = 'b2'.repeat(32);
  const S = { counts: [], awake: [], lease: [], wake: {}, saved: 0, connected: new Set([PK]) };
  const formCounts = { web: (pk, m) => { S.counts.push((pk ? pk.slice(0, 4) : 'null') + '|' + m); } };
  const env = {
    CONFIG: { adapter: { secret: SECRET, port: 7000 }, lease: { enabled: true, days: 90 } }, READ_BODY_MAX: 65536, webFormLib: lib, formCounts, subsLib, console: { log() {}, warn() {}, error() {} },
    registryBuildSignedMessage: (action, nonce, pk, rec) => action + '|' + nonce + '|' + pk + '|' + rec, registryVerifySignature: (m, sig) => ({ ok: sig === GOODSIG }), registryNonceStore: { consume: () => ({ ok: true }) },
    touchWalletActive: (pk) => { S.awake.push(pk.slice(0, 4)); }, leaseTouch: (pk, why) => { S.lease.push(pk.slice(0, 4) + '|' + why); },
    pendingHtlcsForOfflineWallets: new Map([[HASH, { client_pubkey: PK, outgoing_scid_hex: SCID, outgoing_amount_msat: 21000, incoming_amount_msat: 21100, outgoing_expiry: 900100, auto_fail_height: 900050, htlc_received_at: 1700000000 }], ['ff'.repeat(32), { client_pubkey: OTHER, outgoing_scid_hex: SCID2, outgoing_amount_msat: 1, incoming_amount_msat: 2, outgoing_expiry: 3, auto_fail_height: 4, htlc_received_at: 5 }]]),
    subs: { wake: { set: (pk, kept) => { S.wake[pk.slice(0, 4)] = kept; return kept.length; } } }, pushSubs: {},
    jitFunding: { status: (client, funding) => (client === PK && funding === FUND) ? { state: 'held', funding } : null },
    openIntents: {}, openIntentsSave: () => { S.saved++; }, openIntentObserve: async (rec) => ({ state: rec.last_state, funding_txid: rec.funding_txid }), peersConnectedSet: async () => S.connected,
  };
  const names = Object.keys(env);
  const A = new Function(...names, [fAuthOk, fJson, fErr, fRead, fProof, fTs, 'const _oiRate = new Map();', fOiRate, fOi, unnamed, qkey, qclient].join('\n')
    + '\nasync function handleHttp(req, res) {\n  const parsed = new URL(req.url, "http://localhost:7000"); const path = parsed.pathname; const method = req.method;\n  const viaConn = webFormLib.callerOf(req);\n'
    + topA + topB + topC + topD + hPend + hFund + hLease + hOi + hWake + '\n  return errResponse(res, "Not found", 404);\n}\nreturn { handleHttp };')(...names.map((n) => env[n]));
  const server = http.createServer((req, res) => { A.handleHttp(req, res).catch((e) => { try { res.writeHead(500); res.end('{"ok":false,"error":"threw: ' + String(e.message).replace(/"/g, '') + '"}'); } catch (_) {} }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const web = async (method, p, body, token) => {
    const r = await fetch(BASE + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token === null ? {} : { 'x-adapter-secret': token || SECRET }), body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };
  const out = [];
  const rpc = createLijoxRpc({ version: '0.141.0', send: async (peer, type, buf) => { out.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
  const webForm = lib.createWebForm({ handle: (req, res) => A.handleHttp(req, res), secret: () => SECRET, log() {} });
  {
    const plainParams = (p) => (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; const BAD = (why) => ({ status: 400, body: { ok: false, error: why } });
    new Function('lijoxRpc', 'webForm', 'plainParams', 'BAD', 'pendingJitBuys', block)(rpc, webForm, plainParams, BAD, new Map());
  }
  const inside = async (from, method, params) => { out.length = 0; await rpc.onMessage(from, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); const t = Date.now(); while (!out.length && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 10)); const a = out[0]; return !a ? { status: 0, body: null } : (a.result !== undefined ? { status: 200, body: a.result } : { status: a.error ? a.error.code : 0, body: a.error ? a.error.data : null }); };
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const proof = () => ({ node_pubkey: PK, nonce: NONCE, signature: GOODSIG });
  const now = () => Math.floor(Date.now() / 1000);

  // the lease policy
  let w = await web('GET', '/lease/policy', undefined, null), i = await inside(PK, 'lijox.lease_policy', {});
  check(w.status === 200 && same(w, i) && w.body.lease_ttl_days === 90, 'b1 the lease policy: the same answer in both forms', { w, i });
  check(S.counts.join() === 'null|lijox.lease_policy', 'b2 only the web request was counted as a web form', S.counts);

  // the wake poll
  S.counts.length = 0; S.awake.length = 0;
  w = await web('POST', '/lsps2/pending', Object.assign({ client_pubkey: PK, ts: now() }, proof()));
  i = await inside(PK, 'lijox.pending', {});
  check(w.status === 200 && same(w, i) && w.body.pending.length === 1 && w.body.pending[0].payment_hash === HASH, 'b3 the wake poll: the same answer in both forms — this wallet\'s one held payment, not the other wallet\'s', { w, i });
  check(S.awake.join() === '02aa,02aa' && S.counts.join() === '02aa|lijox.pending', 'b4 both forms prove the wallet awake (the web form by its signature, the connection by its key); only the web one is counted', { awake: S.awake, counts: S.counts });
  S.awake.length = 0; w = await web('POST', '/lsps2/pending', { client_pubkey: PK });
  check(w.status === 200 && S.awake.length === 0, 'b5 a web poll without a signature answers and proves nothing, as before');
  w = await web('POST', '/lsps2/pending', Object.assign({ client_pubkey: PK, ts: now() }, proof(), { signature: 'c3'.repeat(64) }));
  check(w.status === 401 && S.awake.length === 0, 'b6 a web poll with a bad signature is refused', w);
  i = await inside(OTHER, 'lijox.pending', { client_pubkey: PK });
  check(i.status === 200 && i.body.pending.length === 1 && i.body.pending[0].scid === SCID2 && S.awake.join() === '03bb', 'b7 inside another wallet\'s connection the poll is that wallet\'s — a key named in the request changes nothing', { i, awake: S.awake });

  // the reminder times
  S.counts.length = 0; const times = [now() + 3600, now() + 7200];
  const wt = subsLib.wakeTimes(times, now());
  w = await web('POST', '/v1/wake/schedule', Object.assign({ v: 1, times, ts: now() }, proof()));
  i = await inside(PK, 'lijox.wake_schedule', { times });
  check(wt.ok && w.status === 200 && same(w, i) && w.body.kept === wt.kept.length && S.wake['02aa'].length === wt.kept.length, 'b8 the reminder times: the same answer in both forms, kept under the wallet\'s key', { w, i });
  check(S.counts.join() === '02aa|lijox.wake_schedule', 'b9 only the web request was counted', S.counts);
  w = await web('POST', '/v1/wake/schedule', { v: 1, times, ts: now(), node_pubkey: PK });
  check(w.status === 401, 'b10 the web form without a signature is refused, as before', w);
  w = await web('POST', '/v1/wake/schedule', Object.assign({ v: 1, times, ts: now() }, proof()), null);
  check(w.status === 401, 'b11 the web form without the route token is refused, as before', w);

  // the funding check
  S.counts.length = 0; S.lease.length = 0;
  w = await web('GET', '/v1/jit-funding/status?client_pubkey=' + PK + '&funding=' + FUND); i = await inside(PK, 'lijox.funding_status', { funding: FUND });
  check(w.status === 200 && same(w, i) && w.body.state === 'held', 'b12 the funding check: the same answer in both forms', { w, i });
  i = await inside(OTHER, 'lijox.funding_status', { funding: FUND, client_pubkey: PK });
  check(i.status === 404, 'b13 inside another wallet\'s connection the same funding is "not found" — the key is the connection\'s', i);
  check(S.counts.join() === '02aa|lijox.funding_status', 'b14 only the web request was counted', S.counts);

  // the open intent
  S.counts.length = 0;
  const it = { v: 1, intent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', client_pubkey: PK, amount_sats: 50000, fee_rate_sat_vb: 2, created_ms: Date.now(), expiry_ms: Date.now() + 3600000, sig: 'sig-of-the-wallet' };
  const it2 = Object.assign({}, it, { intent_id: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff' });
  w = await web('POST', '/openintent', it); i = await inside(PK, 'lijox.openintent', it2);
  check(w.status === 200 && same(w, i) && w.body.state === 'RECEIVED' && Object.keys(env.openIntents).length === 2, 'b15 the open intent: the same answer in both forms, both kept', { w, i });
  w = await web('GET', '/openintent/' + it.intent_id); i = await inside(PK, 'lijox.openintent_status', { intent_id: it.intent_id });
  check(w.status === 200 && same(w, i) && w.body.state === 'RECEIVED', 'b16 the intent\'s status: the same answer in both forms', { w, i });
  i = await inside(PK, 'lijox.openintent', it2);
  check(i.status === 200 && Object.keys(env.openIntents).length === 2, 'b17 the same intent sent again is the same record (its id is the key)', i);
  check(S.counts.join() === '02aa|lijox.openintent,null|lijox.openintent_status', 'b18 only the web requests were counted', S.counts);
  // the limit: ten a minute per address on the web; per wallet inside
  let r429 = 0; for (let k = 0; k < 12; k++) { const x = await inside(PK, 'lijox.openintent', Object.assign({}, it, { intent_id: 'bbbbbbbb-0000-0000-0000-' + String(k).padStart(12, '0') })); if (x.status === 429) r429++; }
  S.connected.add(OTHER);
  const o = await inside(OTHER, 'lijox.openintent', Object.assign({}, it, { client_pubkey: OTHER, intent_id: 'cccccccc-0000-0000-0000-000000000001' }));
  check(r429 >= 2 && o.status === 200, 'b19 one wallet over the limit inside its connection is refused; another wallet is not held back by it', { r429, o });

  server.close(); clearInterval(keep);
  console.log(fails ? '\n' + fails + ' FAILED' : '\nf3b-forms: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · the test threw: ' + (e && e.stack || e)); process.exit(1); });
