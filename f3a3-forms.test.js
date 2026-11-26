'use strict';
// 0.140.0 (S72 Wed 2026-11-25, F3a-3 — the wallet repo's docs/design/routes/f3a3-r1.md): THE REQUESTS THAT MOVE MONEY,
// INSIDE THE LIGHTNING CONNECTION — lijox.onchain_open, lijox.onchain_release, lijox.push_lock, lijox.push_void,
// lijox.push_claim (each with `rid`), and the read lijox.push_claim_status.
//   node f3a3-forms.test.js
// s: the source.  w: the web form's limit per call.
// r: THE RID RULE through the real path (lijox-rpc.js) and the adapter's registrations as written, with a stand-in
//    for the web form: no rid → refused; a rid runs its route once; the same rid gets the first answer; what_became
//    in its three states; a route that gave no answer in time is never kept as an answer.
// b: BOTH FORMS ON THE REAL ROUTES (push.js, onchain-pay.js, the adapter's own readBody / authOk / lnurlpAuthCheck),
//    as in f3a2-forms.test.js: the same request as a web request and inside the connection, the answers compared;
//    what `rid` adds on a route that refuses a second request; another wallet's key; the counts.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto'); const http = require('http');
const btc = require('./btc-tx');
const lib = require('./lijox-web-form');
const { createLijoxRpc } = require('./lijox-rpc');
const { createPushRail } = require('./push.js');
const { createOnchainPayRail } = require('./onchain-pay');
const rd = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const src = rd('lij-adapter.js'), tsrc = rd('onchain-pay.test.js'), psrc = rd('push.js'), wsrc = rd('lijox-web-form.js');
let fails = 0;
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : '')); } else console.log('  ok · ' + m); };
const liftFrom = (text, head, tail) => { const a = text.indexOf(head); if (a < 0) return null; const b = text.indexOf(tail || '\n}\n', a); return b > a ? text.slice(a, b + (tail || '\n}\n').length) : null; };
const lift = (head, tail) => liftFrom(src, head, tail);
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32), SECRET = 'route-token-of-this-box';
const rid = (n) => String(n).padStart(32, '0');
const keep = setInterval(() => {}, 1000);

(async () => {
  // ── s ──
  const aA = src.indexOf('const plainParams = (p) =>'), aB = src.indexOf('// a moved request whose WEB form names no wallet');
  const bA = src.indexOf('const CLAIM_WAIT_MS = 65000;'), bB = src.indexOf('// (the end of the 0.140.0 registrations)');
  const blockA = src.slice(aA, aB), blockB = src.slice(bA, bB);
  const MONEY = ['lijox.onchain_open', 'lijox.onchain_release', 'lijox.push_lock', 'lijox.push_void', 'lijox.push_claim'];
  check(aA > 0 && aB > aA && bA > aB && bB > bA && MONEY.every((m) => new RegExp("lijoxRpc\\.register\\('" + m.replace('.', '\\.') + "', \\(caller, params\\) => \\{[\\s\\S]*?\\n\\}, \\{ money: true \\}\\);").test(blockB)),
    's1 the five requests that move money are registered as such (the path then asks for rid)');
  check(blockB.includes("lijoxRpc.register('lijox.push_claim_status', (caller, params) => {") && !/lijox\.push_claim_status'[\s\S]*?money: true/.test(blockB.slice(blockB.indexOf("'lijox.push_claim_status'"))) && !/push\/deliver|push_deliver/.test(blockB) && !/money: true/.test(blockA),
    's2 the claim-status read carries no rid; /push/deliver is registered nowhere; none of the ten earlier requests is a money request');
  check(psrc.includes("{ const pr = proofOf(carry(req, { node_pubkey: q.get('node_pubkey') || '', nonce: q.get('nonce') || '', signature: q.get('signature') || '' }), 'push-claim-status', pk,") && src.includes("  carry: (req, fields) => webFormLib.carry(req, fields),   // 0.140.0"),
    's3 the claim-status read puts the connection\'s mark on the proof fields it takes from the query string');
  check(wsrc.includes('function call(pk, httpMethod, path, body, query, o) {') && wsrc.includes("const waitThis = (o && Number(o.waitMs) > 0) ? Math.min(Number(o.waitMs), 300000) : wait;") && blockB.includes('}, CLAIM_WAIT_MS);'),
    's4 the web form takes a limit per call, and the claim states 65 s');
  check(blockB.includes("if (r && r.status === 504) throw new Error('the route gave no answer in time');"), 's5 a route that gave no answer in time is not kept as an answer');

  // ── w: the limit per call ──
  {
    const slow = (ms) => (req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, ms); };
    const wf1 = lib.createWebForm({ handle: slow(250), secret: () => SECRET, log() {}, waitMs: 100 });
    let t = Date.now(); let r = await wf1.call(PK, 'POST', '/slow', {});
    check(r.status === 504 && Date.now() - t < 240, 'w1 a route slower than the default limit: 504 at the default limit', { r, ms: Date.now() - t });
    t = Date.now(); r = await wf1.call(PK, 'POST', '/slow', {}, null, { waitMs: 600 });
    check(r.status === 200 && r.body.ok === true && Date.now() - t >= 240, 'w2 the same route with a limit of its own for this call: answered', { r, ms: Date.now() - t });
    await sleep(200);
  }

  // ── r: the rid rule, the registrations as written, a stand-in for the web form ──
  {
    const calls = []; const sent = []; let next = null;
    const stubForm = { call: async (pk, m, p, body, query, o) => { calls.push({ pk, m, p, body: body === undefined ? null : body, query: query || null, waitMs: o && o.waitMs }); return next || { status: 200, body: { ok: true, n: calls.length } }; } };
    const rpc = createLijoxRpc({ version: '0.140.0', send: async (peer, type, buf) => { sent.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
    new Function('lijoxRpc', 'webForm', blockA + '\n' + blockB)(rpc, stubForm);
    const ask = async (method, params) => { sent.length = 0; await rpc.onMessage(PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); return sent[0]; };
    const last = () => calls[calls.length - 1];
    const H = 'ab'.repeat(32);
    let a = await ask('lijox.push_lock', { hash: H, amount_sats: 2100, expiry: 1800000000 });
    check(a.error && a.error.code === 400 && /needs rid/.test(a.error.message) && calls.length === 0, 'r1 a request that moves money without rid is refused before its route is asked', a);
    a = await ask('lijox.push_lock', { rid: rid(1), hash: H.toUpperCase(), amount_sats: 2100, expiry: 1800000000, client_pubkey: OTHER, extra: 1, note_ct: 'abc', note_token: 'cd'.repeat(16) });
    check(a.result && a.result.n === 1 && last().m === 'POST' && last().p === '/push/lock' && JSON.stringify(last().body) === JSON.stringify({ client_pubkey: PK, hash: H, amount_sats: 2100, expiry: 1800000000, note_ct: 'abc', note_token: 'cd'.repeat(16) }),
      'r2 lijox.push_lock is POST /push/lock with the lock\'s own fields and the connection\'s key — no rid, nothing else that was sent', last());
    const again = await ask('lijox.push_lock', { rid: rid(1), hash: H, amount_sats: 9999, expiry: 1 });
    check(calls.length === 1 && JSON.stringify(again.result) === JSON.stringify(a.result), 'r3 THE SAME RID AGAIN: the route is not asked a second time and the first answer comes back', { calls: calls.length, again });
    let wb = await ask('lijox.what_became', { rid: rid(1) });
    const wb0 = await ask('lijox.what_became', { rid: rid(77) });
    check(wb.result && wb.result.known === true && wb.result.state === 'done' && wb.result.status === 200 && wb.result.body.n === 1 && wb0.result && wb0.result.known === false, 'r4 lijox.what_became: done with the answer for a rid that ran; not known for one never seen', { wb: wb.result, wb0: wb0.result });
    next = { status: 409, body: { ok: false, error: 'this hash is already a push here' } };
    a = await ask('lijox.push_lock', { rid: rid(2), hash: H, amount_sats: 2100, expiry: 1800000000 });
    const n2 = calls.length; const a2 = await ask('lijox.push_lock', { rid: rid(2), hash: H, amount_sats: 2100, expiry: 1800000000 });
    check(a.error && a.error.code === 409 && a2.error && a2.error.code === 409 && calls.length === n2, 'r5 a refusal is an answer too: kept, and given again to the same rid without asking the route', { a: a.error, n2, now: calls.length });
    next = { status: 504, body: { ok: false, error: 'no answer' } };
    a = await ask('lijox.push_claim', { rid: rid(3), hash: H, secret: 'ee'.repeat(32), amount_sats: 2100, expiry: 1800000000, holder_prefix: '02cc' });
    wb = await ask('lijox.what_became', { rid: rid(3) });
    const n3 = calls.length; next = null; const a3 = await ask('lijox.push_claim', { rid: rid(3), hash: H, secret: 'ee'.repeat(32) });
    check(a.error && a.error.code === -32603 && wb.result.known === true && wb.result.state === 'started' && a3.error && a3.error.code === 409 && a3.error.data.error === 'in_progress' && calls.length === n3,
      'r6 a route that gave no answer in time: the wallet is told the request could not be carried out, what_became says "started", and the same rid is NOT run a second time', { a: a.error, wb: wb.result, a3: a3.error });
    check(calls[n3 - 1].p === '/push/claim' && calls[n3 - 1].waitMs === 65000 && JSON.stringify(calls[n3 - 1].body) === JSON.stringify({ client_pubkey: PK, hash: H, secret: 'ee'.repeat(32), amount_sats: 2100, expiry: 1800000000, holder_prefix: '02cc' }) && calls[0].waitMs === undefined,
      'r7 lijox.push_claim is POST /push/claim with the claim\'s own fields and a limit of 65 s; the lock has the default limit', calls[n3 - 1]);
    a = await ask('lijox.push_void', { rid: rid(4), hash: H, ts: 1790000000, signature: 'sig-by-the-sender', client_pubkey: OTHER });
    check(JSON.stringify(last().body) === JSON.stringify({ client_pubkey: PK, hash: H, ts: 1790000000, signature: 'sig-by-the-sender' }) && last().p === '/push/void', 'r8 lijox.push_void keeps the sender\'s own signature and time (the route checks them through LND)', last());
    a = await ask('lijox.onchain_open', { rid: rid(5), payment_hash: H, client_pubkey: OTHER, node_pubkey: OTHER, signature: 's' });
    const o1 = last();
    a = await ask('lijox.onchain_release', { rid: rid(6), payment_hash: H, tx_hex: 'AB'.repeat(60) });
    check(o1.p === '/v1/onchain-pay/open' && JSON.stringify(o1.body) === JSON.stringify({ client_pubkey: PK, payment_hash: H }) && last().p === '/v1/onchain-pay/release' && JSON.stringify(last().body) === JSON.stringify({ client_pubkey: PK, payment_hash: H, tx_hex: 'ab'.repeat(60) }),
      'r9 lijox.onchain_open and lijox.onchain_release: the payment hash (and the transaction) for the connection\'s key, no proof fields', { o1, rel: last() });
    const n9 = calls.length;
    const bad = [await ask('lijox.onchain_open', { rid: rid(7), payment_hash: 'zz' }), await ask('lijox.onchain_release', { rid: rid(8), payment_hash: H, tx_hex: 'short' }), await ask('lijox.push_lock', { rid: rid(9) }), await ask('lijox.push_claim_status', { hash: 'x' })];
    check(bad.every((x) => x.error && x.error.code === 400) && calls.length === n9, 'r10 a bad hash or transaction is refused before the route is asked', bad.map((x) => x.error && x.error.code));
    a = await ask('lijox.push_claim_status', { hash: H, client_pubkey: OTHER });
    check(last().m === 'GET' && last().p === '/push/claim-status/' + H && JSON.stringify(last().query) === JSON.stringify({ client_pubkey: PK }), 'r11 lijox.push_claim_status is GET /push/claim-status/<hash> for the connection\'s key, and needs no rid', last());
    a = await ask('lijox.hello', {});
    check(a.result && MONEY.concat(['lijox.push_claim_status', 'lijox.what_became', 'lijox.push_quote']).every((m) => a.result.methods.includes(m)) && !a.result.methods.some((m) => /deliver/.test(m)), 'r12 lijox.hello names the six new methods; no deliver', a.result && a.result.methods.length);
    rpc.stop();
  }

  // ── b: both forms, the real routes ──
  const fAuthOk = lift('function authOk(req) {'), fIp = lift('function getClientIp(req) {'), fJson = lift('function jsonResponse(res, data, status = 200) {'),
    fErr = lift('function errResponse(res, msg, status = 400) {'), fRead = lift('function readBody(req, maxBytes) {'), fProof = lift('function lnurlpAuthCheck(body, action, clientPk, recordId) {');
  check(!!(fAuthOk && fIp && fJson && fErr && fRead && fProof), 'b0 the adapter\'s own pieces are there to be read');
  const st = { verified: [], counted: [], mints: 0, cancels: 0, verifyAs: PK };
  const formCounts = { web: (k, m) => st.counted.push((k ? String(k).slice(0, 4) : 'none') + '|' + m) };
  const env = {
    CONFIG: { adapter: { secret: SECRET, port: 7000 } }, TRUST_XFF: false, READ_BODY_MAX: 256 * 1024, webFormLib: lib, leaseTouch() {},
    registryBuildSignedMessage: (action, nonce, pk, rec) => [action, nonce, pk, rec].join('|'),
    registryVerifySignature: (message, signature) => { st.verified.push(message); return { ok: /^a+$/.test(signature) }; },
    registryNonceStore: { consume: () => ({ ok: true }) },
  };
  const names = Object.keys(env);
  const A = new Function(...names, [fAuthOk, fIp, fJson, fErr, fRead, fProof].join('\n') + '\nreturn { authOk, getClientIp, jsonResponse, errResponse, readBody, lnurlpAuthCheck };')(...names.map((n) => env[n]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lij-f3a3-'));
  const logs = []; const log = (m) => logs.push(String(m));
  const webSeen = (x, pk, m) => { if (!lib.callerOf(x)) formCounts.web(pk, m); };
  const lndPost = async (p, body) => {
    if (p === '/v2/invoices/hodl') { st.mints++; return { payment_request: 'lnbc1stub' + st.mints, add_index: String(st.mints) }; }
    if (p === '/v1/verifymessage') return { valid: true, pubkey: st.verifyAs };
    if (p === '/v2/invoices/cancel') { st.cancels++; return {}; }
    return {};
  };
  const pushRail = createPushRail({ dataDir: dir, lndGet: async () => ({ state: 'OPEN' }), lndPost, deliverToWallet: async () => ({ ok: false }), isPeerConnected: async () => true, sendWakePush: async () => {},
    authOk: (req) => A.authOk(req), buildPublicHints: async () => [], plRecord() {}, leaseTouch() {}, touchWalletActive() {}, localPubkey: () => '02' + 'cc'.repeat(32), log, env: {}, timers: { set: () => ({}), clear() {} },
    proofCheck: (f, a, c, r) => A.lnurlpAuthCheck(f, a, c, r), carry: (req, fields) => lib.carry(req, fields), webSeen });
  const fLnd = liftFrom(tsrc, 'function makeLnd() {'), fCore = liftFrom(tsrc, 'function makeCore() {'), fNt = liftFrom(tsrc, 'function makeNotifiers() {'), fTm = liftFrom(tsrc, 'const manualTimers = () =>', '\n');
  const S2 = new Function('btc', 'crypto', 'sha256Hex', [fLnd, fCore, fNt, fTm].join('\n') + '\nreturn { makeLnd, makeCore, makeNotifiers, manualTimers };')(btc, crypto, sha256Hex);
  const lnd = S2.makeLnd(), core = S2.makeCore(), nt = S2.makeNotifiers(), tm = S2.manualTimers();
  const onchainPay = createOnchainPayRail({ dataDir: dir, env: { ONCHAIN_PAY_ENABLED: 'true', ONCHAIN_PAY_TAKEBACK_SEED: 'ab'.repeat(32), ONCHAIN_PAY_FEE_SATS: '1000', ONCHAIN_PAY_FEE_PPM: '0', ONCHAIN_PAY_MIN_SATS: '10000', ONCHAIN_PAY_MAX_SATS: '2000000', ONCHAIN_PAY_DAILY_SATS: '2000000', ONCHAIN_PAY_MAX_OPEN: '10' },
    log, now: () => 1_700_000_000_000, timers: tm, lndGet: lnd.lndGet, lndPost: lnd.lndPost, watchConf: nt.watchConf, watchSpend: nt.watchSpend, coreRpc: core.rpc, sendWakePush: async () => {},
    proofCheck: (f, a, c, r) => A.lnurlpAuthCheck(f, a, c, r), carry: (req, fields) => lib.carry(req, fields), webSeen, plRecord() {}, leaseTouch() {}, localPubkey: () => '02' + 'cc'.repeat(32) });
  await onchainPay.boot();
  async function handle(req, res) {
    const parsed = new URL(req.url, 'http://localhost:7000'); const p = parsed.pathname; const method = req.method; const ip = A.getClientIp(req);
    if (p.startsWith('/push/')) { if (await pushRail.handle(req, res, p, method, ip, A.readBody, A.jsonResponse)) return; }
    if (p.startsWith('/v1/onchain-pay/')) { if (await onchainPay.handle(req, res, p, method, ip, A.readBody, A.jsonResponse)) return; }
    return A.errResponse(res, 'Not found', 404);
  }
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { res.writeHead(500); res.end('{"ok":false,"error":"threw"}'); } catch (_) {} }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const web = async (method, p, body, token) => {
    const r = await fetch(BASE + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token === null ? {} : { 'x-adapter-secret': token || SECRET }), body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };
  const out = [];
  const rpc = createLijoxRpc({ version: '0.140.0', send: async (peer, type, buf) => { out.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
  const wf = lib.createWebForm({ handle, secret: () => SECRET, log() {} });
  new Function('lijoxRpc', 'webForm', blockA + '\n' + blockB)(rpc, wf);
  let qn = 0;
  const inside = async (method, params, peer) => {
    out.length = 0; const id = 'b' + (++qn);
    await rpc.onMessage(peer || PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params })));
    const m = out.find((x) => x.id === id); if (!m) return { status: 0, body: null };
    return m.error ? { status: m.error.code, body: m.error.data } : { status: 200, body: m.result };
  };
  const same = (x, y) => x.status === y.status && JSON.stringify(x.body) === JSON.stringify(y.body);
  const shape = (x) => x.body && Object.keys(x.body).sort().join(',');
  const proof = (pk) => ({ node_pubkey: pk, nonce: 'cd'.repeat(32), signature: 'a'.repeat(128) });
  const nowS = Math.floor(Date.now() / 1000);
  const H1 = sha256Hex(Buffer.from('one')), H2 = sha256Hex(Buffer.from('two'));

  // b1 the Push lock
  let w = await web('POST', '/push/lock', { client_pubkey: PK, hash: H1, amount_sats: 2100, expiry: nowS + 3600 });
  let i = await inside('lijox.push_lock', { rid: rid(101), hash: H2, amount_sats: 2100, expiry: nowS + 3600 });
  check(w.status === 200 && i.status === 200 && w.body.hash === H1 && i.body.hash === H2 && shape(w) === shape(i) && w.body.fee_msat === i.body.fee_msat && w.body.total_msat === i.body.total_msat && st.mints === 2, 'b1 a Push lock: made in both forms with the same fields and the same fee (two hashes)', { w: shape(w), i: shape(i), mints: st.mints });
  const i2 = await inside('lijox.push_lock', { rid: rid(101), hash: H2, amount_sats: 2100, expiry: nowS + 3600 });
  check(same(i, i2) && st.mints === 2, 'b1 THE SAME RID AGAIN: the same answer with the same invoice, and no second invoice was made', { mints: st.mints });
  const i3 = await inside('lijox.push_lock', { rid: rid(102), hash: H2, amount_sats: 2100, expiry: nowS + 3600 });
  w = await web('POST', '/push/lock', { client_pubkey: PK, hash: H1, amount_sats: 2100, expiry: nowS + 3600 });
  check(i3.status === 409 && /already a push here/.test(i3.body.error) && same(w, i3) && st.mints === 2, 'b1 without it — a NEW rid, or the web form asked twice — the route refuses the second lock of a hash (409): that is what rid is for', { i3, w });
  // b2 the Push claim
  const SEC = 'ee'.repeat(32); const cb = (h) => ({ hash: h, secret: SEC, amount_sats: 2100, expiry: nowS + 3600, holder_prefix: '02cc' });
  w = await web('POST', '/push/claim', Object.assign({ client_pubkey: PK }, cb(H1), proof(PK))); i = await inside('lijox.push_claim', Object.assign({ rid: rid(103) }, cb(H1)));
  check(w.status === 409 && w.body.error === 'not available' && w.body.status === 'minted' && same(w, i), 'b2 a claim of a key whose lock is not paid yet: the same refusal in both forms (the proof is met by the connection)', { w, i });
  w = await web('POST', '/push/claim', Object.assign({ client_pubkey: PK }, cb(H1)));
  check(w.status === 401 && /^auth: /.test(w.body.error), 'b2 as a web request without the signed proof it is refused, as before', w);
  // b3 the claim-status read
  w = await web('GET', '/push/claim-status/' + H1 + '?client_pubkey=' + PK + '&node_pubkey=' + PK + '&nonce=' + 'cd'.repeat(32) + '&signature=' + 'a'.repeat(128)); i = await inside('lijox.push_claim_status', { hash: H1 });
  check(w.status === 404 && w.body.error === 'unknown' && same(w, i), 'b3 the claim-status read of a hash never claimed here: 404 in both forms', { w, i });
  w = await web('GET', '/push/claim-status/' + H1 + '?client_pubkey=' + PK);
  let r = await wf.call(OTHER, 'GET', '/push/claim-status/' + H1, null, { client_pubkey: PK });
  check(w.status === 401 && r.status === 403 && /the connection's key is not the record's key/.test(r.body.error), 'b3 without the proof on the web: 401; a connection that names another wallet\'s key: 403', { w, r });
  // b4 the Push cancel
  st.verifyAs = OTHER;
  w = await web('POST', '/push/void', { client_pubkey: PK, hash: H1, ts: nowS, signature: 'sig' }, null); i = await inside('lijox.push_void', { rid: rid(104), hash: H2, ts: nowS, signature: 'sig' });
  check(w.status === 401 && w.body.error === 'bad_signature' && same(w, i), 'b4 a cancel whose signature is another key\'s: refused in both forms — inside the connection the sender\'s own signature is still checked', { w, i });
  st.verifyAs = PK;
  w = await web('POST', '/push/void', { client_pubkey: PK, hash: H1, ts: nowS, signature: 'sig' }, null); i = await inside('lijox.push_void', { rid: rid(105), hash: H2, ts: nowS, signature: 'sig' });
  check(w.status === 200 && w.body.status === 'void' && same(w, i) && st.cancels === 2, 'b4 a cancel: void in both forms', { w, i, cancels: st.cancels });
  // b5 on-chain: open and release
  const Wkey = btc.pubkeyOf(crypto.createHash('sha256').update('wallet release key').digest()).toString('hex');
  const H3 = sha256Hex(Buffer.from('three')), H4 = sha256Hex(Buffer.from('four'));
  const qbody = (h) => ({ payment_hash: h, amount_sats: 100000, release_fee_sats: 850, reserve_sats: 850, release_pubkey: Wkey, recipient_address: 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3' });
  await inside('lijox.onchain_quote', qbody(H3)); await inside('lijox.onchain_quote', qbody(H4));
  i = await inside('lijox.onchain_open', { rid: rid(106), payment_hash: H3 });
  w = await web('POST', '/v1/onchain-pay/open', Object.assign({ client_pubkey: PK, payment_hash: H4 }, proof(PK)));
  check(i.status === 200 && i.body.state === 'opening' && w.status === 200 && shape(w) === shape(i), 'b5 an on-chain payment opened: in both forms with the same fields (two hashes)', { w, i });
  const io2 = await inside('lijox.onchain_open', { rid: rid(106), payment_hash: H3 }); const io3 = await inside('lijox.onchain_open', { rid: rid(107), payment_hash: H3 });
  check(same(i, io2) && io3.status === 409 && /not open for paying \(opening\)/.test(io3.body.error), 'b5 THE SAME RID AGAIN: the first answer — the wallet goes on to pay; a new rid: the route\'s own refusal (409), which made the wallet give the payment up', { io2, io3 });
  const TX = '02' + '00'.repeat(60);
  w = await web('POST', '/v1/onchain-pay/release', Object.assign({ client_pubkey: PK, payment_hash: H4, tx_hex: TX }, { node_pubkey: PK, nonce: 'cd'.repeat(32), signature: 'a'.repeat(128) })); i = await inside('lijox.onchain_release', { rid: rid(108), payment_hash: H3, tx_hex: TX });
  check(w.status === 409 && /no lock to release \(opening\)/.test(w.body.error) && same(w, i), 'b5 a release handed over before there is a lock: the same refusal in both forms', { w, i });
  i = await inside('lijox.onchain_open', { rid: rid(109), payment_hash: H3 }, OTHER);
  check(i.status === 404, 'b5 another wallet\'s connection asking to open this wallet\'s payment: not found, never described', i);
  // b6 the counts
  const want = ['02aa|lijox.push_lock', '02aa|lijox.push_claim', '02aa|lijox.push_claim_status', '02aa|lijox.push_void', '02aa|lijox.onchain_open', '02aa|lijox.onchain_release'];
  check(want.every((x) => st.counted.includes(x)) && st.counted.filter((x) => x === '02aa|lijox.push_lock').length === 2 && st.counted.filter((x) => x === '02aa|lijox.onchain_open').length === 1,
    'b6 the web forms of the six are counted with their wallet; the requests inside the connection are not', st.counted);

  server.close(); rpc.stop(); clearInterval(keep);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fails ? `FAIL · f3a3-forms.test.js · ${fails} failed` : 'PASS · f3a3-forms.test.js (s1–s5, w1–w2, r1–r12, b0–b6)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · f3a3-forms.test.js threw: ' + (e && e.stack || e)); process.exit(1); });
