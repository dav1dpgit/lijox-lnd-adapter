'use strict';
// 0.139.0 (S72 Tue 2026-11-24, F3a-2 — the wallet repo's docs/design/routes/f3a-r1.md §3): THE PAGE'S ASKS INSIDE THE
// LIGHTNING CONNECTION — lijox.lnurl_fetch, lijox.onchain_quote, lijox.onchain_status, lijox.push_quote,
// lijox.push_status, lijox.push_receivable, lijox.push_note.
//   node f3a2-forms.test.js
// n: the seven registrations as the adapter writes them (what each sends to which web route, whose key it names, what
//    it refuses before the route is asked).
// b: BOTH FORMS, THE REAL ROUTES. One handler made of the adapter's own pieces as written (authOk, getClientIp,
//    jsonResponse, errResponse, readBody, lnurlpAuthCheck, the /v1/lnurl/fetch route, the two counting lines) and the
//    real push.js and onchain-pay.js. The same request is sent to it as a web request (a real HTTP server, the route
//    token, the signed proof) and inside the connection (the real lijox-rpc.js → the real registrations → the real
//    lijox-web-form.js). The two answers are compared.
// The on-chain rail's stand-ins (LND's hold invoices, the float wallet's door) are onchain-pay.test.js's own, read from
// that file.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto'); const http = require('http');
const btc = require('./btc-tx');
const lib = require('./lijox-web-form');
const { createLijoxRpc } = require('./lijox-rpc');
const { createPushRail } = require('./push.js');
const { createOnchainPayRail } = require('./onchain-pay');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const tsrc = fs.readFileSync(path.join(__dirname, 'onchain-pay.test.js'), 'utf8');
const osrc = fs.readFileSync(path.join(__dirname, 'onchain-pay.js'), 'utf8');
let fails = 0;
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : '')); } else console.log('  ok · ' + m); };
const liftFrom = (text, head, tail) => { const a = text.indexOf(head); if (a < 0) return null; const b = text.indexOf(tail || '\n}\n', a); return b > a ? text.slice(a, b + (tail || '\n}\n').length) : null; };
const lift = (head, tail) => liftFrom(src, head, tail);
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32), SECRET = 'route-token-of-this-box';
const HASH = 'ab'.repeat(32), TOKEN = 'cd'.repeat(16);
const keep = setInterval(() => {}, 1000);

(async () => {
  // ── s: the source ──
  const regA = src.indexOf('const plainParams = (p) =>'), regB = src.indexOf('// a moved request whose WEB form names no wallet');
  const block = src.slice(regA, regB);
  const SEVEN = ['lijox.lnurl_fetch', 'lijox.onchain_quote', 'lijox.onchain_status', 'lijox.push_quote', 'lijox.push_status', 'lijox.push_receivable', 'lijox.push_note'];
  check(regA > 0 && regB > regA && SEVEN.every((m) => block.includes("lijoxRpc.register('" + m + "'")), 's1 the seven registrations are in the adapter, beside the three of 0.138.0');
  check(osrc.includes("const pr = proofOf(carry(req, { node_pubkey: q.get('node_pubkey'), nonce: q.get('nonce'), signature: q.get('signature') }), 'onchain-pay', client, 'status:' + client);")
    && src.includes('  carry: (req, fields) => webFormLib.carry(req, fields),'), 's2 the on-chain status read puts the connection\'s mark on the proof fields it takes from the query string');
  check(src.includes("if (path.startsWith('/push/')) {\n    if (await pushRail.handle(req, res, path, method, ip, readBody, jsonResponse)) return;")
    && src.includes("if (path.startsWith('/v1/onchain-pay/')) {\n    if (await onchainPay.handle(req, res, path, method, ip, readBody, jsonResponse)) return;"), 's3 the adapter hands /push/ and /v1/onchain-pay/ to their modules as this test does');
  const tables = liftFrom(src, 'const MOVED_WEB_UNNAMED = {', '\n') + liftFrom(src, 'const MOVED_WEB_QUERY_KEY = {', '\n');
  const topA = "  if (!viaConn && MOVED_WEB_UNNAMED[method + ' ' + path]) { try { formCounts.web(null, MOVED_WEB_UNNAMED[method + ' ' + path]); } catch (_) {} }\n";
  const topB = liftFrom(src, "  if (!viaConn && MOVED_WEB_QUERY_KEY[method + ' ' + path]) {", '\n');
  check(src.includes(topA) && !!topB && /'GET \/push\/quote': 'lijox\.push_quote'/.test(tables) && /'GET \/v1\/onchain-pay\/status': 'lijox\.onchain_status', 'GET \/push\/receivable': 'lijox\.push_receivable'/.test(tables)
    && !/push\/status|push\/note/.test(tables), 's4 web forms counted: the Push quote (no wallet named), the on-chain status and the Push receivable (the key in the query); NOT the Push status and note, which another provider\'s wallet asks here by design');

  // ── n: the registrations, with a stand-in for the web form ──
  {
    const calls = []; const sent = [];
    const stubForm = { call: async (pk, m, p, body, query) => { calls.push({ pk, m, p, body: body === undefined ? null : body, query: query || null }); return { status: 200, body: { ok: true, echoed: p } }; } };
    const rpc = createLijoxRpc({ version: '0.139.0', send: async (peer, type, buf) => { sent.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
    new Function('lijoxRpc', 'webForm', block)(rpc, stubForm);
    const ask = async (method, params) => { sent.length = 0; await rpc.onMessage(PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); return sent[0]; };
    const last = () => calls[calls.length - 1];
    let a = await ask('lijox.lnurl_fetch', { url: 'https://pay.example/.well-known/lnurlp/x', client_pubkey: OTHER, extra: 1 });
    check(a.result && last().m === 'POST' && last().p === '/v1/lnurl/fetch' && last().pk === PK && JSON.stringify(last().body) === JSON.stringify({ url: 'https://pay.example/.well-known/lnurlp/x', client_pubkey: PK }),
      'n1 lijox.lnurl_fetch is POST /v1/lnurl/fetch with the url and the connection\'s key — nothing else that was sent', last());
    let n0 = calls.length;
    a = await ask('lijox.lnurl_fetch', { url: '' }); const a2 = await ask('lijox.lnurl_fetch', { url: 'x'.repeat(2049) }); const a3 = await ask('lijox.lnurl_fetch', [1]);
    check(a.error && a.error.code === 400 && a2.error && a2.error.code === 400 && a3.error && (a3.error.code === 400 || a3.error.code === -32602) && calls.length === n0, 'n2 no url, a url over 2,048 characters, or params that are not an object: refused before the route is asked', [a.error, a2.error, a3.error]);
    a = await ask('lijox.onchain_quote', { client_pubkey: OTHER, node_pubkey: OTHER, nonce: 'n', signature: 's', payment_hash: HASH, amount_sats: 100000, release_fee_sats: 850, reserve_sats: 850, release_pubkey: PK, recipient_address: 'bc1q…' });
    check(last().m === 'POST' && last().p === '/v1/onchain-pay/quote' && last().body.client_pubkey === PK && !('node_pubkey' in last().body) && !('nonce' in last().body) && !('signature' in last().body) && last().body.payment_hash === HASH && last().body.amount_sats === 100000 && last().body.recipient_address === 'bc1q…',
      'n3 lijox.onchain_quote is POST /v1/onchain-pay/quote: the body as sent, client_pubkey the connection\'s key whatever was sent, the proof fields taken off', last());
    a = await ask('lijox.onchain_status', { client_pubkey: OTHER });
    check(last().m === 'GET' && last().p === '/v1/onchain-pay/status' && last().body === null && JSON.stringify(last().query) === JSON.stringify({ client_pubkey: PK }), 'n4 lijox.onchain_status is GET /v1/onchain-pay/status for the connection\'s key, whatever was sent', last());
    a = await ask('lijox.push_quote', { amount_sats: 2100 });
    check(last().m === 'GET' && last().p === '/push/quote' && JSON.stringify(last().query) === JSON.stringify({ amount_sats: 2100 }), 'n5 lijox.push_quote is GET /push/quote?amount_sats=', last());
    a = await ask('lijox.push_status', { hash: HASH.toUpperCase() });
    check(last().m === 'GET' && last().p === '/push/status/' + HASH && last().query === null, 'n6 lijox.push_status is GET /push/status/<hash>', last());
    a = await ask('lijox.push_receivable', { amount_sats: 5000, client_pubkey: OTHER });
    check(last().m === 'GET' && last().p === '/push/receivable' && JSON.stringify(last().query) === JSON.stringify({ client_pubkey: PK, amount_sats: 5000 }), 'n7 lijox.push_receivable is GET /push/receivable for the connection\'s key, whatever was sent', last());
    a = await ask('lijox.push_note', { hash: HASH, token: TOKEN.toUpperCase() });
    check(last().m === 'GET' && last().p === '/push/note/' + HASH && JSON.stringify(last().query) === JSON.stringify({ token: TOKEN }), 'n8 lijox.push_note is GET /push/note/<hash>?token=', last());
    n0 = calls.length;
    const bad = [await ask('lijox.push_quote', { amount_sats: 0 }), await ask('lijox.push_quote', { amount_sats: '2100' }), await ask('lijox.push_quote', { amount_sats: 1.5 }), await ask('lijox.push_status', { hash: 'zz' }), await ask('lijox.push_status', { hash: HASH + '/../x' }),
      await ask('lijox.push_receivable', {}), await ask('lijox.push_note', { hash: HASH, token: 'short' }), await ask('lijox.push_note', { hash: 'x', token: TOKEN })];
    check(bad.every((x) => x.error && x.error.code === 400) && calls.length === n0, 'n9 an amount that is not a whole number of sats above 0, a hash that is not 64 hex characters, a token that is not 32: refused before the route is asked', bad.map((x) => x.error && x.error.code));
    a = await ask('lijox.hello', {});
    check(a.result && SEVEN.concat(['lijox.route_build', 'lijox.route_report', 'lijox.outcome', 'lijox.prefs_set'].filter((m) => m !== 'lijox.prefs_set')).every((m) => a.result.methods.includes(m)), 'n10 lijox.hello names the seven and the three before them', a.result && a.result.methods);
    rpc.stop();
  }

  // ── b: both forms, the real routes ──
  const fAuthOk = lift('function authOk(req) {'), fIp = lift('function getClientIp(req) {'), fJson = lift('function jsonResponse(res, data, status = 200) {'),
    fErr = lift('function errResponse(res, msg, status = 400) {'), fRead = lift('function readBody(req, maxBytes) {'), fProof = lift('function lnurlpAuthCheck(body, action, clientPk, recordId) {');
  const fLnurl = lift("  if (method === 'POST' && path === '/v1/lnurl/fetch') {", '\n  }\n');
  check(!!(fAuthOk && fIp && fJson && fErr && fRead && fProof && fLnurl), 'b0 the adapter\'s own pieces are there to be read');
  check(fLnurl.includes("if (!webFormLib.callerOf(fbody)) { try { formCounts.web(String((fbody && fbody.client_pubkey) || '').toLowerCase(), 'lijox.lnurl_fetch'); }"), 'b0 the fetch route counts its web form with its wallet');
  const st = { verified: [], nonces: [], counted: [], fetchIps: [], fetched: [], lease: [], rx: [], webSeen: [] };
  const BIG = JSON.stringify({ tag: 'payRequest', callback: 'https://pay.example/cb', minSendable: 1000, maxSendable: 100000000, metadata: JSON.stringify([['text/plain', 'x'.repeat(61000)]]) });   // an answer longer than one message
  let fetchAnswer = { ok: true, status: 200, body: '{"tag":"payRequest"}' };
  const formCounts = { web: (k, m) => st.counted.push((k ? String(k).slice(0, 4) : 'none') + '|' + m) };
  const env = {
    CONFIG: { adapter: { secret: SECRET, port: 7000 } }, TRUST_XFF: false, READ_BODY_MAX: 256 * 1024, webFormLib: lib, formCounts,
    leaseTouch: (pk, s) => st.lease.push(pk.slice(0, 4) + '|' + s),
    registryBuildSignedMessage: (action, nonce, pk, rec) => [action, nonce, pk, rec].join('|'),
    registryVerifySignature: (message, signature) => { st.verified.push(message); return { ok: /^a+$/.test(signature) }; },
    registryNonceStore: { consume: (n) => { st.nonces.push(n); return { ok: true }; } },
    lnurlFetchIpLimit: { hit: (ip) => { st.fetchIps.push(ip); return { ok: true }; } }, lnurlFetchCounts: { asked: 0, served: 0, refused: 0 },
    lnurlFetch: { fetchForWallet: async (u) => { st.fetched.push(u); return fetchAnswer; } },
  };
  const names = Object.keys(env);
  const A = new Function(...names, [fAuthOk, fIp, fJson, fErr, fRead, fProof].join('\n')
    + '\nconst lnurlRoute = async function (req, res, method, path, ip) {\n' + fLnurl + '\n  return false;\n};'
    + '\n' + tables + '\nconst top = function (req, parsed, method, path) { const viaConn = webFormLib.callerOf(req);\n' + topA + topB + '\n};'
    + '\nreturn { authOk, getClientIp, jsonResponse, errResponse, readBody, lnurlpAuthCheck, lnurlRoute, top };')(...names.map((n) => env[n]));

  // the Push rail, real, on stand-ins it does not reach in these reads
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lij-f3a2-'));
  const logs = []; const log = (m) => logs.push(String(m));
  const pushRail = createPushRail({ dataDir: dir, lndGet: async () => ({}), lndPost: async () => ({}), deliverToWallet: async () => ({ ok: false }), isPeerConnected: async () => true, sendWakePush: async () => {},
    authOk: (req) => A.authOk(req), buildPublicHints: async () => [], plRecord() {}, leaseTouch() {}, touchWalletActive() {}, localPubkey: () => '02' + 'cc'.repeat(32), log, env: {},
    walletReceivable: async (pk, msat) => { st.rx.push(pk.slice(0, 4) + '|' + msat); return { ok: true, mode: 'channel', fee_msat: '0', receivable_msat: '900000000' }; },
    proofCheck: (f, a, c, r) => A.lnurlpAuthCheck(f, a, c, r) });
  // the on-chain rail, real, on onchain-pay.test.js's own stand-ins
  const fLnd = liftFrom(tsrc, 'function makeLnd() {'), fCore = liftFrom(tsrc, 'function makeCore() {'), fNt = liftFrom(tsrc, 'function makeNotifiers() {'), fTm = liftFrom(tsrc, 'const manualTimers = () =>', '\n');
  check(!!(fLnd && fCore && fNt && fTm), 'b0 the on-chain rail\'s stand-ins are read from onchain-pay.test.js');
  const S2 = new Function('btc', 'crypto', 'sha256Hex', [fLnd, fCore, fNt, fTm].join('\n') + '\nreturn { makeLnd, makeCore, makeNotifiers, manualTimers };')(btc, crypto, sha256Hex);
  const lnd = S2.makeLnd(), core = S2.makeCore(), nt = S2.makeNotifiers(), tm = S2.manualTimers();
  const onchainPay = createOnchainPayRail({ dataDir: dir, env: { ONCHAIN_PAY_ENABLED: 'true', ONCHAIN_PAY_TAKEBACK_SEED: 'ab'.repeat(32), ONCHAIN_PAY_FEE_SATS: '1000', ONCHAIN_PAY_FEE_PPM: '0', ONCHAIN_PAY_MIN_SATS: '10000', ONCHAIN_PAY_MAX_SATS: '2000000', ONCHAIN_PAY_DAILY_SATS: '2000000', ONCHAIN_PAY_MAX_OPEN: '10' },
    log, now: () => 1_700_000_000_000, timers: tm, lndGet: lnd.lndGet, lndPost: lnd.lndPost, watchConf: nt.watchConf, watchSpend: nt.watchSpend, coreRpc: core.rpc, sendWakePush: async () => {},
    proofCheck: (f, a, c, r) => A.lnurlpAuthCheck(f, a, c, r), carry: (req, fields) => lib.carry(req, fields),
    webSeen: (body, pk, m) => { if (!lib.callerOf(body)) formCounts.web(pk, m); },
    plRecord() {}, leaseTouch() {}, localPubkey: () => '02' + 'cc'.repeat(32) });
  await onchainPay.boot();

  // the handler: the adapter's own lines, in the adapter's order
  const seen = [];
  async function handle(req, res) {
    const parsed = new URL(req.url, 'http://localhost:7000'); const p = parsed.pathname; const method = req.method; const ip = A.getClientIp(req);
    seen.push({ method, p, ip, via: lib.callerOf(req) });
    A.top(req, parsed, method, p);
    if (p.startsWith('/push/')) { if (await pushRail.handle(req, res, p, method, ip, A.readBody, A.jsonResponse)) return; }
    if (p.startsWith('/v1/onchain-pay/')) { if (await onchainPay.handle(req, res, p, method, ip, A.readBody, A.jsonResponse)) return; }
    if ((await A.lnurlRoute(req, res, method, p, ip)) !== false) return;
    return A.errResponse(res, 'Not found', 404);
  }
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { res.writeHead(500); res.end('{"ok":false,"error":"threw: ' + String(e.message).replace(/"/g, '') + '"}'); } catch (_) {} }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const web = async (method, p, body, token) => {
    const r = await fetch(BASE + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token === null ? {} : { 'x-adapter-secret': token || SECRET }), body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };
  // inside the connection: the real path, the real registrations, the real web form
  const out = [];
  const rpc = createLijoxRpc({ version: '0.139.0', send: async (peer, type, buf) => { out.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
  const wf = lib.createWebForm({ handle, secret: () => SECRET, log() {} });
  new Function('lijoxRpc', 'webForm', block)(rpc, wf);
  let qn = 0;
  const inside = async (method, params, peer) => {
    out.length = 0; const id = 'b' + (++qn);
    await rpc.onMessage(peer || PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    let m = out.find((x) => x.id === id);
    const parts = out.filter((x) => x.method === 'lijox.part' && x.params && x.params.of === id).sort((x, y) => x.params.n - y.params.n);
    if (!m && parts.length) m = JSON.parse(Buffer.concat(parts.map((x) => Buffer.from(x.params.data, 'base64'))).toString('utf8'));
    if (!m) return { status: 0, body: null, parts: 0 };
    return m.error ? { status: m.error.code, body: m.error.data, parts: parts.length } : { status: 200, body: m.result, parts: parts.length };
  };
  const same = (x, y) => x.status === y.status && JSON.stringify(x.body) === JSON.stringify(y.body);
  const proof = (pk) => ({ node_pubkey: pk, nonce: 'cd'.repeat(32), signature: 'a'.repeat(128) });
  const proofQ = (pk) => '&node_pubkey=' + pk + '&nonce=' + 'cd'.repeat(32) + '&signature=' + 'a'.repeat(128);

  // b1 the Push quote
  let w = await web('GET', '/push/quote?amount_sats=2100'), i = await inside('lijox.push_quote', { amount_sats: 2100 });
  check(w.status === 200 && w.body.ok && w.body.amount_msat === '2100000' && same(w, i), 'b1 the Push quote: the same answer in both forms', { w, i });
  check(st.counted.join(',') === 'none|lijox.push_quote', 'b1 its web form is counted once (it names no wallet); the request inside the connection is not counted as a web request', st.counted);
  check(seen[seen.length - 1].ip === 'ln:' + PK.slice(0, 16) && seen[seen.length - 1].via === PK && seen[seen.length - 2].via === null, 'b1 inside the connection the route sees the wallet\'s key as the caller, and an address made from it', seen.slice(-2));
  // b2 the Push status
  w = await web('GET', '/push/status/' + HASH); i = await inside('lijox.push_status', { hash: HASH });
  check(w.status === 404 && w.body.error === 'unknown' && same(w, i), 'b2 the Push status of a hash this provider does not hold: 404 in both forms', { w, i });
  // b3 the Push receivable
  st.counted.length = 0;
  w = await web('GET', '/push/receivable?client_pubkey=' + PK + '&amount_sats=5000'); i = await inside('lijox.push_receivable', { amount_sats: 5000 });
  check(w.status === 200 && w.body.can_receive === true && w.body.amount_msat === '5000000' && same(w, i) && st.rx.join(',') === '02aa|5000000,02aa|5000000', 'b3 the Push receivable: the same answer in both forms, asked for the same wallet', { w, i, rx: st.rx });
  check(st.counted.join(',') === '02aa|lijox.push_receivable', 'b3 its web form is counted with its wallet', st.counted);
  w = await web('GET', '/push/receivable?client_pubkey=' + PK + '&amount_sats=5000', undefined, null);
  check(w.status === 401, 'b3 as a web request without the route token it is refused, as before', w);
  i = await inside('lijox.push_receivable', { amount_sats: 5000, client_pubkey: OTHER }, PK);
  check(i.status === 200 && st.rx[st.rx.length - 1] === '02aa|5000000', 'b3 inside the connection a request that names another wallet is answered for the connection\'s own wallet', st.rx);
  // b4 the Push note
  w = await web('GET', '/push/note/' + HASH + '?token=' + TOKEN); i = await inside('lijox.push_note', { hash: HASH, token: TOKEN });
  check(w.status === 404 && w.body.error === 'no note' && same(w, i), 'b4 the Push note of a hash without one: 404 in both forms', { w, i });
  // b5 the on-chain quote
  st.counted.length = 0;
  const Wkey = btc.pubkeyOf(crypto.createHash('sha256').update('wallet release key').digest()).toString('hex');
  const H1 = sha256Hex(Buffer.from('one')), H2 = sha256Hex(Buffer.from('two'));
  const qbody = (h, amt) => ({ payment_hash: h, amount_sats: amt, release_fee_sats: 850, reserve_sats: 850, release_pubkey: Wkey, recipient_address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3' });
  w = await web('POST', '/v1/onchain-pay/quote', Object.assign({ client_pubkey: PK }, qbody(H1, 5000), proof(PK))); i = await inside('lijox.onchain_quote', qbody(H1, 5000));
  check(w.status === 400 && /between 10000 and 2000000/.test(w.body.error) && same(w, i), 'b5 an on-chain quote below the floor: the same refusal in both forms', { w, i });
  w = await web('POST', '/v1/onchain-pay/quote', Object.assign({ client_pubkey: PK }, qbody(H1, 100000), proof(PK))); i = await inside('lijox.onchain_quote', qbody(H2, 100000));
  const shape = (x) => x.body && Object.keys(x.body).sort().join(',');
  check(w.status === 200 && i.status === 200 && w.body.payment_hash === H1 && i.body.payment_hash === H2 && shape(w) === shape(i) && w.body.provider_fee_sats === i.body.provider_fee_sats && w.body.lock_fee_sats === i.body.lock_fee_sats && w.body.lock_sats === i.body.lock_sats && w.body.b.amount_sats === i.body.b.amount_sats,
    'b5 an on-chain quote: quoted in both forms with the same fields and the same fees (two hashes — a hash can be quoted once)', { w: shape(w), i: shape(i) });
  check(st.counted.join(',') === '02aa|lijox.onchain_quote,02aa|lijox.onchain_quote', 'b5 the two web quotes are counted with their wallet; the two inside the connection are not', st.counted);
  const v0 = st.verified.length;
  i = await inside('lijox.onchain_quote', Object.assign({ client_pubkey: OTHER }, qbody(sha256Hex(Buffer.from('three')), 100000)));
  check(i.status === 200 && st.verified.length === v0, 'b5 inside the connection no signature is asked for or checked: the connection\'s key is the wallet', i.status);
  w = await web('POST', '/v1/onchain-pay/quote', Object.assign({ client_pubkey: PK }, qbody(sha256Hex(Buffer.from('four')), 100000)));
  check(w.status === 401 && /signature required/.test(w.body.error), 'b5 as a web request without the signed proof it is refused, as before', w);
  // b6 the on-chain status
  st.counted.length = 0;
  w = await web('GET', '/v1/onchain-pay/status?client_pubkey=' + PK + proofQ(PK)); i = await inside('lijox.onchain_status', {});
  check(w.status === 200 && w.body.payments.length === 3 && same(w, i), 'b6 the on-chain status: the same three payments of this wallet in both forms', { w: w.body.payments && w.body.payments.length, i: i.body && i.body.payments && i.body.payments.length });
  check(st.counted.join(',') === '02aa|lijox.onchain_status', 'b6 its web form is counted with its wallet', st.counted);
  i = await inside('lijox.onchain_status', {}, OTHER);
  check(i.status === 200 && i.body.payments.length === 0, 'b6 another wallet\'s connection sees none of them', i.body && i.body.payments);
  w = await web('GET', '/v1/onchain-pay/status?client_pubkey=' + PK);
  check(w.status === 401, 'b6 as a web request without the signed proof it is refused, as before', w);
  let r = await wf.call(OTHER, 'GET', '/v1/onchain-pay/status', null, { client_pubkey: PK });
  check(r.status === 403 && /the connection's key is not the record's key/.test(r.body.error), 'b6 a connection that names ANOTHER wallet\'s key on this route is refused (the registration never does; the route itself refuses too)', r);
  // b7 the fetch for a payee
  st.counted.length = 0; st.fetchIps.length = 0;
  w = await web('POST', '/v1/lnurl/fetch', { url: 'https://pay.example/a', client_pubkey: PK }); i = await inside('lijox.lnurl_fetch', { url: 'https://pay.example/a' });
  check(w.status === 200 && w.body.body === '{"tag":"payRequest"}' && same(w, i) && st.fetched.slice(-2).join(',') === 'https://pay.example/a,https://pay.example/a', 'b7 the fetch for a payee: the same answer in both forms, the same URL fetched', { w, i });
  check(st.counted.join(',') === '02aa|lijox.lnurl_fetch' && st.fetchIps[1] === 'ln:' + PK.slice(0, 16) && st.fetchIps[0] !== st.fetchIps[1], 'b7 its web form is counted with its wallet; inside the connection the limit per address is a limit per wallet', { c: st.counted, ips: st.fetchIps });
  fetchAnswer = { ok: true, status: 200, body: BIG };
  w = await web('POST', '/v1/lnurl/fetch', { url: 'https://pay.example/big', client_pubkey: PK }); i = await inside('lijox.lnurl_fetch', { url: 'https://pay.example/big' });
  check(w.status === 200 && w.body.body.length > 61000 && i.parts >= 2 && same(w, i), 'b7 an answer longer than one message comes back in parts and is the same text as the web answer (' + i.parts + ' parts, ' + (w.body.body || '').length + ' characters)');
  fetchAnswer = { ok: false, error: 'unreachable' };
  w = await web('POST', '/v1/lnurl/fetch', { url: 'https://pay.example/down', client_pubkey: PK }); i = await inside('lijox.lnurl_fetch', { url: 'https://pay.example/down' });
  check(w.status === 502 && w.body.error === 'unreachable' && same(w, i), 'b7 a payee that cannot be reached: 502 with the same body in both forms', { w, i });
  w = await web('POST', '/v1/lnurl/fetch', { url: 'https://pay.example/a', client_pubkey: PK }, 'a wrong token');
  check(w.status === 401, 'b7 as a web request with a wrong route token it is refused, as before', w);

  server.close(); rpc.stop(); clearInterval(keep);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fails ? `FAIL · f3a2-forms.test.js · ${fails} failed` : 'PASS · f3a2-forms.test.js (s1–s4, n1–n10, b0–b7)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · f3a2-forms.test.js threw: ' + (e && e.stack || e)); process.exit(1); });
