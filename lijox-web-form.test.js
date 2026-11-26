// 0.138.0 (S72 Tue 2026-11-24): A REQUEST THAT CAME INSIDE THE LIGHTNING CONNECTION IS CARRIED OUT BY ITS WEB ROUTE'S
// OWN CODE — lijox-web-form.js, and what the adapter does with it.
//   node lijox-web-form.test.js
// The adapter is one module that starts servers on require, so its own functions are read from the source and run
// with stand-ins for their stores: readBody, jsonResponse, errResponse, authOk, getClientIp, lnurlpAuthCheck and the
// three methods' registrations, as written. The path is the real lijox-rpc.js.
const fs = require('fs'); const path = require('path');
const lib = require('./lijox-web-form');
const { createLijoxRpc } = require('./lijox-rpc');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : '')); } else console.log('  ok · ' + m); };
const lift = (head, tail) => { const a = src.indexOf(head); const b = src.indexOf(tail || '\n}\n', a) + (tail || '\n}\n').length; return a > 0 && b > a ? src.slice(a, b) : null; };
const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32), SECRET = 'route-token-of-this-box';

// ── the adapter's own functions, as written ──
const fAuthOk = lift('function authOk(req) {'), fIp = lift('function getClientIp(req) {'), fJson = lift('function jsonResponse(res, data, status = 200) {'),
  fErr = lift('function errResponse(res, msg, status = 400) {'), fRead = lift('function readBody(req, maxBytes) {'), fProof = lift('function lnurlpAuthCheck(body, action, clientPk, recordId) {');
check(!!(fAuthOk && fIp && fJson && fErr && fRead && fProof), 's1 authOk, getClientIp, jsonResponse, errResponse, readBody and lnurlpAuthCheck are in the adapter');
check(fRead.includes('resolve(webFormLib.carry(req, parsed));'), 's2 readBody hands on the connection\'s key with the body it parsed');
check(fProof.indexOf('const viaConn = webFormLib.callerOf(body);') > 0 && fProof.indexOf('const viaConn = webFormLib.callerOf(body);') < fProof.indexOf("if (!nodePk || !nonce || !signature)"), 's3 lnurlpAuthCheck looks at the connection\'s key before it asks for a signature');
check(src.includes("const webForm = webFormLib.createWebForm({ handle: (req, res) => handleHttp(req, res), secret: () => CONFIG.adapter.secret,"), 's4 the adapter hands its own handler and its own route token to the web form');
check(src.includes("console.log(viaConn ? `[HTTP] ${method} ${path} inside the connection of ${viaConn.slice(0, 16)}…`") && src.includes("if (!viaConn && MOVED_WEB_UNNAMED[method + ' ' + path]) { try { formCounts.web(null, MOVED_WEB_UNNAMED[method + ' ' + path]); }"),
  's5 the journal names the connection for such a request, and a moved request that comes as a web request is counted');
check(src.includes("if (!webFormLib.callerOf(body)) { try { formCounts.web(pk, 'lijox.route_report'); }"), 's6 the route report\'s web form is counted with its wallet');

const st = { leaseTouched: [], nonces: [], verified: [], logs: [] };
const env = {
  CONFIG: { adapter: { secret: SECRET, port: 7000 } }, TRUST_XFF: false, READ_BODY_MAX: 256 * 1024, webFormLib: lib,
  leaseTouch: (pk, src2) => st.leaseTouched.push(pk.slice(0, 4) + '|' + src2),
  registryBuildSignedMessage: (action, nonce, pk, rec) => [action, nonce, pk, rec].join('|'),
  registryVerifySignature: (message, signature, pk) => { st.verified.push(message); return { ok: /^a+$/.test(signature) }; },
  registryNonceStore: { consume: (n) => { st.nonces.push(n); return { ok: true }; } },
};
const names = Object.keys(env);
const A = new Function(...names, [fAuthOk, fIp, fJson, fErr, fRead, fProof].join('\n') + '\nreturn { authOk, getClientIp, jsonResponse, errResponse, readBody, lnurlpAuthCheck };')(...names.map((n) => env[n]));

// a handler written the way the adapter's routes are written, from the adapter's own pieces
const seen = [];
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost:7000'); const p = u.pathname;
  const ip = A.getClientIp(req);
  if (p === '/throws') throw new Error('boom');
  if (p === '/never') return;
  if (p === '/text') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('not json'); }
  if (p === '/bare') { res.statusCode = 202; return res.end(JSON.stringify({ bare: true })); }
  if (!A.authOk(req)) return A.errResponse(res, 'Unauthorized', 401);
  if (p === '/v1/outcome' && req.method === 'GET') { seen.push({ p, ip, hash: u.searchParams.get('hash'), caller: lib.callerOf(req) }); return A.jsonResponse(res, { ok: true, hash: u.searchParams.get('hash'), outcome: 'unknown' }); }
  let body; try { body = await A.readBody(req); } catch (e) { return A.errResponse(res, 'Invalid JSON body', 400); }
  seen.push({ p, ip, body, caller: lib.callerOf(req), bodyCaller: lib.callerOf(body) });
  if (p === '/signed') {
    const pk = String(body.client_pubkey || '').toLowerCase();
    const auth = A.lnurlpAuthCheck(body, 'route-report', pk, 'record-1');
    if (!auth.ok) return A.errResponse(res, 'refused: ' + auth.code, auth.status);
    return A.jsonResponse(res, { ok: true, for: pk, via: auth.via || 'signature' });
  }
  if (p === '/echo') return A.jsonResponse(res, { ok: true, got: body, keys: Object.keys(body) }, body.status || 200);
  return A.errResponse(res, 'not found', 404);
}
const wf = lib.createWebForm({ handle, secret: () => SECRET, log: (m) => st.logs.push(m), waitMs: 150 });

(async () => {
  const keep = setInterval(() => {}, 1000);   // the form's own wait does not keep a process alive (in the adapter the servers do); here this does
  // ── t: the form itself ──
  let r = await wf.call(PK, 'POST', '/echo', { a: 1, deep: { b: [1, 2] } });
  let s0 = seen[seen.length - 1];
  check(r.status === 200 && r.body.ok === true && r.body.got.a === 1 && r.body.got.deep.b[1] === 2, 't1 a POST goes through the handler and its answer comes back with its status', r);
  check(s0.caller === PK && s0.bodyCaller === PK && s0.ip === 'ln:' + PK.slice(0, 16), 't2 the handler sees the connection\'s key on the request and on the body readBody parsed; the address is "ln:" + the key\'s first 16 characters', { caller: s0.caller, ip: s0.ip });
  check(!r.body.keys.includes('lijox.caller') && JSON.stringify(s0.body) === '{"a":1,"deep":{"b":[1,2]}}', 't3 the mark is not a field of the body: it is not listed and not written out');
  r = await wf.call(PK, 'POST', '/echo', { status: 409, ok: false });
  check(r.status === 409, 't4 a refusal keeps the route\'s own status', r);
  r = await wf.call(PK, 'GET', '/v1/outcome', null, { hash: 'ab'.repeat(32) });
  s0 = seen[seen.length - 1];
  check(r.status === 200 && r.body.hash === 'ab'.repeat(32) && s0.caller === PK, 't5 a GET with its query string', r);
  r = await wf.call(PK, 'POST', '/throws', {});
  check(r.status === 500 && r.body.error === 'internal' && st.logs.some((l) => /threw: boom/.test(l)), 't6 a handler that throws: 500, and a line in the journal', r);
  r = await wf.call(PK, 'POST', '/never', {});
  check(r.status === 504 && r.body.error === 'no answer', 't7 a handler that never answers: 504 after the wait', r);
  r = await wf.call(PK, 'GET', '/text');
  check(r.status === 502 && r.body.error === 'the answer is not JSON', 't8 an answer that is not JSON is not passed on as one', r);
  r = await wf.call(PK, 'GET', '/bare');
  check(r.status === 202 && r.body.bare === true, 't9 a route that sets statusCode and ends without writeHead', r);
  const n0 = seen.length;
  r = await wf.call('nobody', 'POST', '/echo', {}); const r2 = await wf.call(PK, 'POST', 'http://elsewhere/echo', {});
  check(r.status === 500 && r2.status === 500 && seen.length === n0, 't10 a key that is not a node key, or a path that is not a plain path, never reaches the handler');

  // ── a: nobody on the web can claim to have come inside a connection ──
  const fakeReq = (bodyObj, headers) => { const { Readable } = require('stream'); const q = Readable.from([Buffer.from(JSON.stringify(bodyObj))]); q.method = 'POST'; q.url = '/signed'; q.headers = Object.assign({ 'x-adapter-secret': SECRET }, headers || {}); q.socket = { remoteAddress: '198.51.100.7' }; return q; };
  const webCall = (bodyObj, headers) => new Promise((resolve) => { let status = 200; const res = { setHeader() {}, writeHead(s) { status = s; }, end(d) { resolve({ status, body: JSON.parse(d) }); } }; handle(fakeReq(bodyObj, headers), res); });
  r = await webCall({ client_pubkey: PK, 'lijox.caller': PK, 'Symbol(lijox.caller)': PK, __proto__: { caller: PK } }, { 'lijox.caller': PK, 'x-lijox-caller': PK });
  check(r.status === 401 && /signature required/.test(r.body.error), 'a1 a WEB request that names the mark in its body and its headers is asked for a signature like any other', r);
  r = await webCall({ client_pubkey: PK, node_pubkey: PK, nonce: 'cd'.repeat(32), signature: 'a'.repeat(128) });
  check(r.status === 200 && r.body.via === 'signature' && st.verified.length === 1, 'a2 a WEB request with a good signature passes as before', r);
  r = await wf.call(PK, 'POST', '/signed', { client_pubkey: PK });
  check(r.status === 200 && r.body.via === 'connection' && r.body.for === PK && st.verified.length === 1 && st.nonces.length === 1, 'a3 inside the connection the key named IS the connection\'s key: passed with no signature, no nonce spent', r);
  r = await wf.call(PK, 'POST', '/signed', { client_pubkey: OTHER });
  check(r.status === 403 && /the connection's key is not the record's key/.test(r.body.error), 'a4 inside the connection a request that names ANOTHER wallet\'s key is refused', r);
  r = await wf.call(PK, 'POST', '/signed', { client_pubkey: OTHER, node_pubkey: OTHER, nonce: 'cd'.repeat(32), signature: 'a'.repeat(128) });
  check(r.status === 403 && st.verified.length === 1, 'a5 and a signature sent along does not change that: the connection\'s key decides', r);
  const wf2 = lib.createWebForm({ handle, secret: () => 'a wrong token', log() {} });
  r = await wf2.call(PK, 'POST', '/echo', {});
  check(r.status === 401, 'a6 the route token is the adapter\'s own: with another one the route refuses as it does on the web', r);

  // ── m: the three methods as the adapter registers them, through the real path ──
  const regA = src.indexOf("const plainParams = (p) =>"), regB = src.indexOf("// a moved request whose WEB form names no wallet");
  check(regA > 0 && regB > regA, 'm0 the three registrations are in the adapter');
  const calls = []; const sent = [];
  const stubForm = { call: async (pk, m, p, body, query) => { calls.push({ pk, m, p, body, query }); return { status: 200, body: { ok: true, echoed: p } }; } };
  const rpc = createLijoxRpc({ version: '0.138.0', send: async (peer, type, buf) => { sent.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
  new Function('lijoxRpc', 'webForm', src.slice(regA, regB))(rpc, stubForm);
  const ask = async (method, params) => { sent.length = 0; await rpc.onMessage(PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); return sent[0]; };
  let a = await ask('lijox.route_build', { destination: OTHER, amount_sat: 100, route_hints: [] });
  let c = calls[calls.length - 1];
  check(a.result && a.result.echoed === '/v1/route/build' && c.pk === PK && c.m === 'POST' && c.body.destination === OTHER && c.body.amount_sat === 100, 'm1 lijox.route_build is POST /v1/route/build with the body as sent, for the connection\'s key', { a, c });
  a = await ask('lijox.route_report', { client_pubkey: OTHER, node_pubkey: OTHER, nonce: 'n', signature: 's', payment_hash: 'ab'.repeat(32), failures: [] });
  c = calls[calls.length - 1];
  check(c.p === '/v1/route/report' && c.body.client_pubkey === PK && !('node_pubkey' in c.body) && !('nonce' in c.body) && !('signature' in c.body) && c.body.payment_hash === 'ab'.repeat(32), 'm2 lijox.route_report: client_pubkey is the connection\'s key whatever was sent, and the proof fields are taken off', c);
  a = await ask('lijox.outcome', { hash: 'AB'.repeat(32) });
  c = calls[calls.length - 1];
  check(c.m === 'GET' && c.p === '/v1/outcome' && c.query.hash === 'ab'.repeat(32) && c.body === null, 'm3 lijox.outcome is GET /v1/outcome?hash=', c);
  const n1 = calls.length;
  a = await ask('lijox.outcome', { hash: 'zz' });
  check(a.error && a.error.code === 400 && calls.length === n1, 'm4 a hash that is not 64 hex characters is refused before the route is asked', a);
  a = await ask('lijox.hello', {});
  check(a.result && ['lijox.route_build', 'lijox.route_report', 'lijox.outcome', 'lijox.hello', 'lijox.what_became'].every((m) => a.result.methods.includes(m)), 'm5 lijox.hello names the three', a.result && a.result.methods);
  rpc.stop(); clearInterval(keep);
  console.log(fails ? `FAIL · lijox-web-form.test.js · ${fails} failed` : 'PASS · lijox-web-form.test.js (s1–s6, t1–t10, a1–a6, m0–m5)');
  process.exit(fails ? 1 : 0);
})();
