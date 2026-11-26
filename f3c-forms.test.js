'use strict';
// 0.142.0 (S72 Wed 2026-11-25, F3c and the rest of F3; F5 as a setting — the wallet repo's docs/design/routes/f3c-r1.md):
// THE REST OF THE WALLET'S REQUESTS INSIDE THE LIGHTNING CONNECTION, FROM ONE TABLE; THE WEB FORM OF A MOVED REQUEST
// CAN BE REFUSED.
//   node f3c-forms.test.js
// s: the source — the table, the per-wallet limit, the two query-proof routes, the push subscription, the refusal.
// n: the table's registrations as the adapter writes them, on a stand-in for the web form: one of each kind of row.
// m: movedWebForm — which web requests have a form inside the connection, and which never count as one.
// b: BOTH FORMS, THE REAL ROUTES, for the two routes whose code changed (the push subscription; a note read with its
//    proof in the query), and the refusal (LIJOX_WEB_FORMS=refuse) with its CORS headers.
// NOT COMPARED IN BOTH FORMS HERE: the other rows. Their routes are not changed; each is handed its web request's own
// body or query by the one loop part n runs.
const fs = require('fs'); const path = require('path'); const http = require('http');
const lib = require('./lijox-web-form');
const { createLijoxRpc } = require('./lijox-rpc');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : '')); } else console.log('  ok · ' + m); };
const lift = (head, tail) => { const a = src.indexOf(head); if (a < 0) return null; const b = src.indexOf(tail || '\n}\n', a); return b > a ? src.slice(a, b + (tail || '\n}\n').length) : null; };
const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32), SECRET = 'route-token-of-this-box';
const HASH = 'ab'.repeat(32), RID = '0123456789abcdef0123456789abcdef';
const J = (x) => JSON.stringify(x);
const keep = setInterval(() => {}, 1000);

(async () => {
  // ── s: the source ──
  const rA = src.indexOf('// (the end of the 0.141.0 registrations)\n'), rB = src.indexOf('// (the end of the 0.142.0 registrations)');
  const block = src.slice(rA, rB);
  const rows = (block.match(/^  \['lijox\.[a-z_]+',/gm) || []).map((x) => x.slice(4, -2));
  check(rA > 0 && rB > rA && rows.length === 29 && new Set(rows).size === 29, 's1 the table has 29 rows, each method once (22 of 0.142.0; two more since 0.144.0 — f4-forms.test.js; five more since 0.145.0 — f2b-forms.test.js)', rows.length);
  check((block.match(/money: true \}\],/g) || []).length === 3 && ['delegate_register', 'delegate_void', 'delegate_refund'].every((m) => new RegExp("'lijox\\." + m + "',[^\\n]*money: true").test(block)), 's2 three rows move money (a chit registered, cancelled, refunded): they carry rid');
  check(src.includes("  const ip      = viaCheck ? viaCheck.ip : viaConn ? 'peer:' + viaConn : getClientIp(req);") && !src.includes('  const ip     = getClientIp(req);'), 's3 a request inside the connection is limited per wallet (it was limited as the one address "unknown", shared by all)');
  check((src.match(/lnurlpAuthCheck\(webFormLib\.carry\(req, proofFromQuery\(parsed\.searchParams\)\), 'lnurl-note'/g) || []).length === 2 && !src.includes("lnurlpAuthCheck(proofFromQuery("), 's4 the two GET routes whose proof rides the query put the connection\'s mark on those fields');
  check(src.includes("let sig = viaConnPs ? { ok: true } : registryVerifySignature(") && src.includes("const nres = viaConnPs ? { ok: true } : registryNonceStore.consume(nonce);") && src.includes("const node_pubkey = viaConnPs || (body || {}).node_pubkey;"), 's5 the push subscription takes the connection\'s key as the proof, and that key as the wallet\'s');
  check(src.includes("const REFUSE_WEB_FORMS = String(process.env.LIJOX_WEB_FORMS || '').trim().toLowerCase() === 'refuse';") && src.indexOf('if (moved142 && REFUSE_WEB_FORMS) {') > src.indexOf("  setCorsHeaders(req, res);\n"), 's6 the refusal is a setting, off unless LIJOX_WEB_FORMS=refuse, and it answers after the CORS headers');

  // ── n: the registrations, with a stand-in for the web form ──
  const mk = () => {
    const calls = []; const sent = [];
    const stubForm = { call: async (pk, m, p, body, query) => { calls.push({ pk, m, p, body: body === undefined ? null : body, query: query || null }); return { status: 200, body: { ok: true, n: calls.length } }; } };
    const rpc = createLijoxRpc({ version: '0.142.0', send: async (peer, type, buf) => { sent.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
    const plainParams = (p) => (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; const BAD = (why) => ({ status: 400, body: { ok: false, error: why } });
    const moneyCall = async (pk, m, p, body) => { calls.push({ pk, m, p, body, money: true }); return { status: 200, body: { ok: true, n: calls.length } }; };
    new Function('lijoxRpc', 'webForm', 'plainParams', 'BAD', 'nowS', 'moneyCall', 'pendingJitBuys', block)(rpc, stubForm, plainParams, BAD, () => 1800000000, moneyCall, new Map());
    const ask = async (method, params, from) => { sent.length = 0; await rpc.onMessage(from || PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); return sent[0]; };
    return { calls, ask, last: () => calls[calls.length - 1], rpc };
  };
  {
    const { calls, ask, last } = mk();
    const st = (a) => !a ? null : (a.result !== undefined ? 200 : (a.error ? a.error.code : null));
    let a = await ask('lijox.lnurl_register', { name: 'shop', client_pubkey: OTHER, hashes: [HASH], node_pubkey: OTHER, nonce: 'n', signature: 's' });
    check(st(a) === 200 && last().m === 'POST' && last().p === '/lnurl/register' && J(last().body) === J({ name: 'shop', client_pubkey: PK, hashes: [HASH], node_pubkey: OTHER }), 'n1 key: the body as sent, the wallet\'s key written with the connection\'s, nonce and signature dropped', last());
    a = await ask('lijox.lnurl_note', { id: HASH.toUpperCase(), client_pubkey: OTHER });
    check(st(a) === 200 && last().m === 'GET' && last().p === '/lnurl/note/' + HASH && J(last().query) === J({ client_pubkey: PK }), 'n2 tail and qkey: GET /lnurl/note/<hash> for the connection\'s key', last());
    let n0 = calls.length; a = await ask('lijox.lnurl_note', { id: '../v1/state' });
    check(st(a) === 400 && calls.length === n0, 'n3 an id that does not fit is refused before any route is asked', a);
    a = await ask('lijox.lnurl_register_open', { name: 'shop', client_pubkey: OTHER, other: 1 });
    check(J(last().query) === J({ name: 'shop', client_pubkey: PK }) && last().p === '/lnurl/register/open', 'n4 q and qkey: only the named query fields, the key the connection\'s', last());
    a = await ask('lijox.heartbeat', { client_pubkey: OTHER, ts: 5, signature: 'x', nonce: 'y' });
    check(J(last().body) === J({ client_pubkey: PK, ts: 1800000000, node_pubkey: PK }) && last().p === '/v1/heartbeat', 'n5 ts: the heartbeat carries the connection\'s key twice and this box\'s time; no proof', last());
    a = await ask('lijox.nwc_register', { client_pubkey: PK, service_pk: 'a', client_pk: 'b', ts: 7, signature: 'sig-by-the-wallet' });
    check(st(a) === 200 && J(last().body) === J({ client_pubkey: PK, service_pk: 'a', client_pk: 'b', ts: 7, signature: 'sig-by-the-wallet' }), 'n6 same: a request the wallet signs by itself goes as sent, signature and all', last());
    n0 = calls.length; a = await ask('lijox.nwc_register', { client_pubkey: OTHER, service_pk: 'a', ts: 7, signature: 's' });
    check(st(a) === 403 && calls.length === n0, 'n7 same: naming another wallet\'s key is refused before the route is asked', a);
    a = await ask('lijox.tower_put', { v: 1, items: [1, 2], sig: 'x' });
    check(st(a) === 200 && last().p === '/v1/tower/put' && J(last().body) === J({ v: 1, items: [1, 2], sig: 'x' }), 'n8 a row with no key rule hands the body on as sent (the tower checks the wallet\'s own signature)', last());
    a = await ask('lijox.delegate_claims', { issuer: PK, ts: 9, sig: 'S', extra: 1 });
    check(last().m === 'GET' && last().p === '/delegate/claims' && J(last().query) === J({ issuer: PK, ts: '9', sig: 'S' }), 'n9 a chit read: its three query fields', last());
    n0 = calls.length; a = await ask('lijox.delegate_void', { nonce: HASH, sig: 'S' });
    check(st(a) !== 200 && calls.length === n0, 'n10 money: without rid a chit is not cancelled', a);
    a = await ask('lijox.delegate_void', { nonce: HASH, sig: 'S', rid: RID });
    check(st(a) === 200 && last().money === true && last().p === '/delegate/void' && J(last().body) === J({ nonce: HASH, sig: 'S' }), 'n11 money: with rid it goes through the money call, the rid not in the body', last());
    n0 = calls.length; const again = await ask('lijox.delegate_void', { nonce: HASH, sig: 'S', rid: RID });
    check(calls.length === n0 && J(again.result) === J(a.result), 'n12 money: the same rid again is the same answer, and the route is not asked twice', again);
    const hello = await ask('lijox.hello', {});
    check(hello.result && rows.every((m) => hello.result.methods.includes(m)), 'n13 lijox.hello names every row of the table', hello.result && hello.result.methods.length);
  }

  // ── m: which web requests have a form inside the connection ──
  {
    const fUn = lift('const MOVED_WEB_UNNAMED = {', '\n'), fQk = lift('const MOVED_WEB_QUERY_KEY = {', '\n'), fQc = lift('const MOVED_WEB_QUERY_CLIENT = {', '\n'), fBody = lift('const MOVED_WEB_BODY = {', '\n'), fMoved = lift('const movedWebForm = (method, path, sp) => {', '\n};\n');
    const table = block.slice(block.indexOf('const REST142 = ['), block.indexOf('];\n', block.indexOf('const REST142 = [')) + 3);
    check([fUn, fQk, fQc, fBody, fMoved].every(Boolean) && table.length > 500, 'm0 the tables and movedWebForm are read from the adapter');
    const moved = new Function([fUn, fQk, fQc, fBody, table, fMoved, 'return movedWebForm;'].join('\n'))();
    const q = (s) => new URLSearchParams(s || '');
    const yes = [['POST', '/client/prefs', '', 'lijox.prefs_set'], ['POST', '/v1/route/build', '', 'lijox.route_build'], ['GET', '/v1/outcome', 'hash=x', 'lijox.outcome'], ['POST', '/push/lock', '', 'lijox.push_lock'], ['POST', '/push/claim', '', 'lijox.push_claim'], ['GET', '/push/claim-status/' + HASH, '', 'lijox.push_claim_status'],
      ['GET', '/lsps2/get_info', 'client=' + PK, 'lijox.jit_info'], ['POST', '/lsps2/pending', '', 'lijox.pending'], ['POST', '/lsps2/buy', '', 'lijox.jit_buy'], ['POST', '/lsps2/register_secret', '', 'lijox.register_secret'], ['GET', '/openintent/abc', '', 'lijox.openintent_status'],
      ['POST', '/lnurl/register', '', 'lijox.lnurl_register'], ['GET', '/lnurl/note/' + HASH, '', 'lijox.lnurl_note'], ['POST', '/v1/heartbeat', '', 'lijox.heartbeat'], ['POST', '/lsps2/push-subscribe', '', 'lijox.push_subscribe'], ['POST', '/delegate/void', '', 'lijox.delegate_void'], ['GET', '/delegate/claims', '', 'lijox.delegate_claims'], ['POST', '/v1/subs/seller', '', 'lijox.subs_seller'], ['POST', '/v1/nwc/register', '', 'lijox.nwc_register']];
    const no = [['GET', '/push/status/' + HASH], ['GET', '/push/note/' + HASH], ['POST', '/push/void'], ['POST', '/push/deliver'], ['GET', '/lsps2/get_info', ''], ['POST', '/v1/kit'], ['GET', '/v1/kit'], ['POST', '/v1/tower/put'], ['POST', '/v1/tower/voucher'], ['POST', '/tapedrop'], ['GET', '/delegate/slip/' + HASH], ['POST', '/delegate/spend'], ['GET', '/health'], ['GET', '/rates'], ['POST', '/v1/state'], ['POST', '/v1/peer-storage/get'], ['POST', '/lsps/registry/my-channels'], ['GET', '/lnurl/note/'], ['GET', '/.well-known/lnurlp/shop']];
    const badYes = yes.filter(([m, p, s, want]) => moved(m, p, q(s)) !== want).map((x) => x[1]);
    const badNo = no.filter(([m, p, s]) => moved(m, p, q(s)) !== null).map((x) => x[1]);
    check(badYes.length === 0, 'm1 nineteen web requests of this provider\'s own wallets are named with their method inside the connection', badYes);
    check(badNo.length === 0, 'm2 never named (so never refused): what a wallet of another provider asks here (a Push Key\'s status, note, cancel and delivery, a chit\'s record and its spending, the kit holder, the tower), a diagnostic tape (sent when the connection itself has failed), the public reads, the terms without a wallet\'s key, and the checks made before connecting', badNo);
  }

  // ── b: both forms on the real routes whose code changed; the refusal ──
  const fAuthOk = lift('function authOk(req) {'), fJson = lift('function jsonResponse(res, data, status = 200) {'), fErr = lift('function errResponse(res, msg, status = 400) {'), fRead = lift('function readBody(req, maxBytes) {');
  const fProof = lift('function lnurlpAuthCheck(body, action, clientPk, recordId) {'), fPq = lift('function proofFromQuery(sp) {'), fPush = lift('async function handlePushSubscribe(req, res) {');
  const hNote = lift("  if (method === 'GET' && path.startsWith('/lnurl/note/')) {", '\n  }\n');
  const hRefuse = lift('  if (moved142 && REFUSE_WEB_FORMS) {', '\n  }\n');
  const fUn = lift('const MOVED_WEB_UNNAMED = {', '\n'), fQk = lift('const MOVED_WEB_QUERY_KEY = {', '\n'), fQc = lift('const MOVED_WEB_QUERY_CLIENT = {', '\n'), fBody = lift('const MOVED_WEB_BODY = {', '\n'), fMoved = lift('const movedWebForm = (method, path, sp) => {', '\n};\n');
  const table = block.slice(block.indexOf('const REST142 = ['), block.indexOf('];\n', block.indexOf('const REST142 = [')) + 3);
  check([fAuthOk, fJson, fErr, fRead, fProof, fPq, fPush, hNote, hRefuse].every(Boolean), 'b0 the routes and their helpers are read from the adapter as written');
  const GOODSIG = 'a1'.repeat(64), NONCE = 'b2'.repeat(32);
  const S = { counts: [], awake: [], saved: 0, refuse: false };
  const env = {
    CONFIG: { adapter: { secret: SECRET, port: 7000 } }, READ_BODY_MAX: 65536, webFormLib: lib, console: { log() {}, warn() {}, error() {} },
    formCounts: { web: (pk, m) => { S.counts.push((pk ? pk.slice(0, 4) : 'null') + '|' + m); } },
    registryBuildSignedMessage: (action, nonce, pk, rec) => [action, nonce, pk, rec].join('|'), registryVerifySignature: (m, sig) => ({ ok: sig === GOODSIG }), registryNonceStore: { consume: () => ({ ok: true }) },
    pushSubscriptionRecordId: (s) => 'sub:' + s.endpoint, pushSubs: {}, persistPushSubs: () => { S.saved++; }, PUSH_SUBS_MAX: 1000,
    lnurlpRegistry: { shop: { client_pubkey: PK, entries: [{ hash: HASH, note: 'thanks', note_ts: 5, status: 'settled' }] } }, lnurlpRegisterView: () => null, touchWalletActive: (pk) => { S.awake.push(pk.slice(0, 4)); },
    setCorsHeaders: (req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); }, refuseOn: () => S.refuse,
  };
  const names = Object.keys(env);
  const A = new Function(...names, [fAuthOk, fJson, fErr, fRead, fProof, fPq, fPush, fUn, fQk, fQc, fBody, table, fMoved].join('\n')
    + '\nasync function handleHttp(req, res) {\n  const parsed = new URL(req.url, "http://localhost:7000"); const path = parsed.pathname; const method = req.method;\n  const viaConn = webFormLib.callerOf(req);\n  const REFUSE_WEB_FORMS = refuseOn();\n'
    + '  const moved142 = viaConn ? null : movedWebForm(method, path, parsed.searchParams);\n  setCorsHeaders(req, res);\n' + hRefuse
    + '  if (path === "/lsps2/push-subscribe" && method === "POST") return handlePushSubscribe(req, res);\n' + hNote + '\n  return errResponse(res, "Not found", 404);\n}\nreturn { handleHttp };')(...names.map((n) => env[n]));
  let lastHeaders = null;
  const server = http.createServer((req, res) => { A.handleHttp(req, res).catch((e) => { try { res.writeHead(500); res.end('{"ok":false,"error":"threw: ' + String(e.message).replace(/"/g, '') + '"}'); } catch (_) {} }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const web = async (method, p, body, token) => {
    const r = await fetch(BASE + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token === null ? {} : { 'x-adapter-secret': token || SECRET }), body: body === undefined ? undefined : JSON.stringify(body) });
    lastHeaders = r.headers; let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };
  const out = [];
  const rpc = createLijoxRpc({ version: '0.142.0', send: async (peer, type, buf) => { out.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
  const webForm = lib.createWebForm({ handle: (req, res) => A.handleHttp(req, res), secret: () => SECRET, log() {} });
  {
    const plainParams = (p) => (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; const BAD = (why) => ({ status: 400, body: { ok: false, error: why } });
    new Function('lijoxRpc', 'webForm', 'plainParams', 'BAD', 'nowS', 'moneyCall', 'pendingJitBuys', block)(rpc, webForm, plainParams, BAD, () => Math.floor(Date.now() / 1000), async () => ({ status: 500, body: {} }), new Map());
  }
  const inside = async (from, method, params) => { out.length = 0; await rpc.onMessage(from, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); const t = Date.now(); while (!out.length && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 10)); const a = out[0]; return !a ? { status: 0, body: null } : (a.result !== undefined ? { status: 200, body: a.result } : { status: a.error ? a.error.code : 0, body: a.error ? a.error.data : null }); };
  const same = (x, y) => J(x) === J(y);
  const SUB = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k1', auth: 'k2' } };

  // the push subscription
  let w = await web('POST', '/lsps2/push-subscribe', { node_pubkey: PK, nonce: NONCE, signature: GOODSIG, subscription: SUB }, null);
  let i = await inside(OTHER, 'lijox.push_subscribe', { node_pubkey: PK, subscription: SUB });
  check(w.status === 200 && same(w, i) && same(env.pushSubs[PK], SUB) && same(env.pushSubs[OTHER], SUB), 'b1 the push subscription: the same answer in both forms; inside the connection it is kept under the CONNECTION\'s key, whatever key was named', { w, i, keys: Object.keys(env.pushSubs).map((k) => k.slice(0, 4)) });
  check(S.counts.join() === '02aa|lijox.push_subscribe', 'b2 only the web request was counted as a web form', S.counts);
  w = await web('POST', '/lsps2/push-subscribe', { node_pubkey: PK, nonce: NONCE, signature: 'c3'.repeat(64), subscription: SUB }, null);
  const w2 = await web('POST', '/lsps2/push-subscribe', { node_pubkey: PK, subscription: SUB }, null);
  check(w.status === 401 && w2.status === 400, 'b3 as a web request it still needs its signature (bad → 401, none → 400)', { w, w2 });
  i = await inside(PK, 'lijox.push_subscribe', { subscription: { endpoint: 'x' } });
  check(i.status === 400, 'b4 inside the connection a subscription that is not one is still refused', i);

  // a note read, its proof in the query
  const proofQ = '&node_pubkey=' + PK + '&nonce=' + NONCE + '&signature=' + GOODSIG;
  w = await web('GET', '/lnurl/note/' + HASH + '?client_pubkey=' + PK + proofQ); i = await inside(PK, 'lijox.lnurl_note', { id: HASH });
  check(w.status === 200 && same(w, i) && w.body.note === 'thanks', 'b5 a note read: the same answer in both forms — inside the connection without a proof', { w, i });
  w = await web('GET', '/lnurl/note/' + HASH + '?client_pubkey=' + PK);
  check(w.status === 401, 'b6 as a web request without its proof it is refused, as before', w);
  i = await inside(OTHER, 'lijox.lnurl_note', { id: HASH, client_pubkey: PK });
  check(i.status === 403, 'b7 inside another wallet\'s connection the note is "not yours" — the key is the connection\'s', i);

  // the refusal
  S.refuse = true; const before = Object.keys(env.pushSubs).length;
  w = await web('POST', '/lsps2/push-subscribe', { node_pubkey: '02' + 'cc'.repeat(32), nonce: NONCE, signature: GOODSIG, subscription: SUB }, null);
  check(w.status === 426 && w.body.code === 'INSIDE_ONLY' && w.body.method === 'lijox.push_subscribe' && lastHeaders.get('access-control-allow-origin') === '*' && Object.keys(env.pushSubs).length === before, 'b8 LIJOX_WEB_FORMS=refuse: the web form is answered 426 with the method\'s name, readable by a wallet\'s page, and is not carried out', w);
  i = await inside(PK, 'lijox.lnurl_note', { id: HASH });
  check(i.status === 200, 'b9 … and the same request inside the connection is served', i);
  S.refuse = false;

  server.close(); clearInterval(keep);
  console.log(fails ? '\n' + fails + ' FAILED' : '\nf3c-forms: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · the test threw: ' + (e && e.stack || e)); process.exit(1); });
