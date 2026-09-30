// 0.86.0 (S50, NWC) — nwc.js end to end: the routes (the wallet's signature, the caps), the relay (AUTH, EVENT,
// REQ, CLOSE, every refusal), the wake, persistence across a restart, the sweep, the switch off.
// A real http server + ws client on 127.0.0.1; the wallet and the app are keys made here (schnorr.js signs).
//   node nwc.test.js
'use strict';
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { WebSocket } = require('ws');
const S = require(path.join(__dirname, 'schnorr.js'));
const { createNwc, checkEvent, eventId, KIND_INFO, KIND_REQUEST, KIND_RESPONSE, KIND_AUTH } = require(path.join(__dirname, 'nwc.js'));

async function main() {
let pass = 0, fail = 0; const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// keys: the wallet's node key (66 hex), one connection (service + client), a stranger
const WALLET = '02' + 'ab'.repeat(32);
const sk = (b) => Buffer.alloc(32, b);
const svcSk = sk(0x11), cliSk = sk(0x22), strangerSk = sk(0x33);
const svcPk = S.pubkey(svcSk).toString('hex'), cliPk = S.pubkey(cliSk).toString('hex'), strangerPk = S.pubkey(strangerSk).toString('hex');
let clock = 1_700_000_000_000;
const now = () => clock;
const nowS = () => Math.floor(clock / 1000);
function signEvent(skb, kind, tags, content, created_at = nowS()) {
  const pubkey = S.pubkey(skb).toString('hex');
  const ev = { pubkey, created_at, kind, tags, content };
  ev.id = eventId(ev);
  ev.sig = S.sign(skb, ev.id, crypto.randomBytes(32)).toString('hex');
  return ev;
}

const wakes = [];
const logs = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nwc-'));
function make(env) {
  return createNwc({
    dataDir: dir, log: (m) => logs.push(m), env: Object.assign({ NWC_ENABLED: 'true', NWC_REQUEST_TTL_CEILING_S: '3600' }, env || {}), now,
    sendWakePush: async (w, kind) => { wakes.push([w, kind]); },
    verifyWalletSig: async (msg, sig) => (sig === 'good:' + crypto.createHash('sha256').update(msg).digest('hex').slice(0, 8) ? WALLET : (sig === 'other' ? '03' + 'cd'.repeat(32) : '')),
    authOk: (req) => req.headers['x-adapter-secret'] === 'tok',
    publicHttpsUrl: 'https://lsp.example.test',
  });
}
let N = make();
const goodSig = (msg) => 'good:' + crypto.createHash('sha256').update(msg).digest('hex').slice(0, 8);

// the server, dispatching like lij-adapter.js does
function readBody(req) { return new Promise((res, rej) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); }); }
function jsonResponse(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
let current = () => N;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (await current().handle(req, res, pathname, req.method, '127.0.0.1', readBody, jsonResponse)) return;
  jsonResponse(res, { error: 'nope' }, 404);
});
// the upgrade goes to whichever module is current (a "restart" swaps it)
server.on('upgrade', (req, socket, head) => current()._upgrade(req, socket, head));
N._upgrade = (req, socket, head) => { /* set by attach below */ };
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
// attach hangs its own 'upgrade' listener on the server; route it through `current` instead
function attachTo(mod) {
  const fake = { on: (evName, fn) => { if (evName === 'upgrade') mod._upgrade = fn; } };
  mod.attach(fake);
}
attachTo(N);

async function post(p, body, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers) }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') })); });
    req.end(JSON.stringify(body));
  });
}

// ── (A) registration ──
let r = await post('/v1/nwc/register', {});
t('A1 no route token → 401', r.status === 401);
const regMsg = (exp, ttl, ts) => 'lij-nwc-register:v1|' + svcPk + '|' + cliPk + '|' + exp + '|' + ttl + '|' + ts;
const exp = nowS() + 90 * 86400;
r = await post('/v1/nwc/register', { client_pubkey: WALLET, service_pk: svcPk, client_pk: cliPk, expires_at: exp, ttl_s: 600, ts: nowS(), signature: 'bad' }, { 'x-adapter-secret': 'tok' });
t('A2 a signature LND cannot verify → 503', r.status === 503, JSON.stringify(r));
r = await post('/v1/nwc/register', { client_pubkey: WALLET, service_pk: svcPk, client_pk: cliPk, expires_at: exp, ttl_s: 600, ts: nowS(), signature: 'other' }, { 'x-adapter-secret': 'tok' });
t('A3 a signature by another node key → 401', r.status === 401 && r.body.error === 'bad_signature');
r = await post('/v1/nwc/register', { client_pubkey: WALLET, service_pk: svcPk, client_pk: cliPk, expires_at: exp, ttl_s: 600, ts: nowS() - 700, signature: goodSig(regMsg(exp, 600, nowS() - 700)) }, { 'x-adapter-secret': 'tok' });
t('A4 a stale ts → 400', r.status === 400);
r = await post('/v1/nwc/register', { client_pubkey: WALLET, service_pk: svcPk, client_pk: cliPk, expires_at: exp, ttl_s: 600, ts: nowS(), signature: goodSig(regMsg(exp, 600, nowS())) }, { 'x-adapter-secret': 'tok' });
t('A5 registered — the relay URL and the ttl come back', r.status === 200 && r.body.ok === true && r.body.relay === 'wss://lsp.example.test/nwc' && r.body.ttl_s === 600 && r.body.connections === 1, JSON.stringify(r));
r = await post('/v1/nwc/register', { client_pubkey: WALLET, service_pk: svcPk, client_pk: cliPk, expires_at: exp, ttl_s: 7200, ts: nowS(), signature: goodSig(regMsg(exp, 7200, nowS())) }, { 'x-adapter-secret': 'tok' });
t('A6 renewed with a ttl over the ceiling → clamped to the ceiling', r.status === 200 && r.body.ttl_s === 3600 && r.body.connections === 1, JSON.stringify(r));
t('A7 the registry persisted', fs.existsSync(path.join(dir, 'nwc', 'registry.json')));
// the cap: nine more, the eleventh refused
for (let i = 0; i < 9; i++) {
  const spk = S.pubkey(sk(0x40 + i)).toString('hex'), cpk = S.pubkey(sk(0x60 + i)).toString('hex');
  const m = 'lij-nwc-register:v1|' + spk + '|' + cpk + '|' + exp + '|600|' + nowS();
  r = await post('/v1/nwc/register', { client_pubkey: WALLET, service_pk: spk, client_pk: cpk, expires_at: exp, ttl_s: 600, ts: nowS(), signature: goodSig(m) }, { 'x-adapter-secret': 'tok' });
}
t('A8 ten connections registered', r.status === 200 && r.body.connections === 10, JSON.stringify(r));
{
  const spk = S.pubkey(sk(0x70)).toString('hex'), cpk = S.pubkey(sk(0x71)).toString('hex');
  const m = 'lij-nwc-register:v1|' + spk + '|' + cpk + '|' + exp + '|600|' + nowS();
  r = await post('/v1/nwc/register', { client_pubkey: WALLET, service_pk: spk, client_pk: cpk, expires_at: exp, ttl_s: 600, ts: nowS(), signature: goodSig(m) }, { 'x-adapter-secret': 'tok' });
  t('A9 the eleventh → 429 too_many', r.status === 429 && r.body.error === 'too_many', JSON.stringify(r));
}

// ── (B) the relay: connect, the challenge, the info event ──
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/nwc');
    const inbox = []; const waiters = [];
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); inbox.push(m); const w = waiters.shift(); if (w) w(m); });
    ws.on('open', () => resolve({ ws, inbox, next: () => new Promise((res) => { if (inbox.length > waiters.length + 0 && inbox.length) { /* fallthrough */ } waiters.push(res); }), send: (a) => ws.send(JSON.stringify(a)) }));
    ws.on('error', reject);
  });
}
// a simpler inbox reader: wait until a message matching pred arrives
async function until(c, pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = c.inbox.find(pred); if (m) return m; await sleep(10); }
  return null;
}
const wallet = await connect();
const authMsg = await until(wallet, (m) => m[0] === 'AUTH');
t('B1 the relay sends a NIP-42 challenge on connect', !!authMsg && typeof authMsg[1] === 'string' && authMsg[1].length === 32);
const challenge = authMsg[1];
// the info event from the service key
const info = signEvent(svcSk, KIND_INFO, [['encryption', 'nip44_v2']], 'pay_invoice');
wallet.send(['EVENT', info]);
let okm = await until(wallet, (m) => m[0] === 'OK' && m[1] === info.id);
t('B2 the info event from a registered service key is kept', okm && okm[2] === true, JSON.stringify(okm));
const infoStranger = signEvent(strangerSk, KIND_INFO, [['encryption', 'nip44_v2']], 'pay_invoice');
wallet.send(['EVENT', infoStranger]);
okm = await until(wallet, (m) => m[0] === 'OK' && m[1] === infoStranger.id);
t('B3 an info event from an unknown key is refused', okm && okm[2] === false && /unknown service key/.test(okm[3]), JSON.stringify(okm));
const junk = Object.assign({}, info, { content: 'pay_invoice get_balance' });
wallet.send(['EVENT', junk]);
okm = await until(wallet, (m) => m[0] === 'OK' && m[1] === junk.id && /id does not match/.test(m[3]));
t('B4 a tampered event is refused (id re-hashed here)', !!okm, JSON.stringify(wallet.inbox.slice(-1)));

// ── (C) the app: reads the info, sends a request; the wallet is woken ──
const app = await connect();
await until(app, (m) => m[0] === 'AUTH');
app.send(['REQ', 'i', { kinds: [KIND_INFO], authors: [svcPk] }]);
let got = await until(app, (m) => m[0] === 'EVENT' && m[1] === 'i');
t('C1 the app reads the info event by author, no auth needed', got && got[2].id === info.id && got[2].content === 'pay_invoice');
t('C2 then EOSE', !!(await until(app, (m) => m[0] === 'EOSE' && m[1] === 'i')));
app.send(['REQ', 'bad', { kinds: [KIND_INFO] }]);
let closed = await until(app, (m) => m[0] === 'CLOSED' && m[1] === 'bad');
t('C3 a REQ naming no key is closed (no listing)', closed && /restricted/.test(closed[2]), JSON.stringify(closed));
const request = signEvent(cliSk, KIND_REQUEST, [['p', svcPk], ['encryption', 'nip44_v2']], 'AgAAAA…ciphertext…');
app.send(['EVENT', request]);
okm = await until(app, (m) => m[0] === 'OK' && m[1] === request.id);
t('C4 the request is stored', okm && okm[2] === true, JSON.stringify(okm));
await sleep(20);
t('C5 the wallet was woken with a content-free nwc push', wakes.length === 1 && wakes[0][0] === WALLET && wakes[0][1] === 'nwc', JSON.stringify(wakes));
const fromStranger = signEvent(strangerSk, KIND_REQUEST, [['p', svcPk], ['encryption', 'nip44_v2']], 'x');
app.send(['EVENT', fromStranger]);
okm = await until(app, (m) => m[0] === 'OK' && m[1] === fromStranger.id);
t('C6 a request from a key that is not this connection\'s app is refused', okm && okm[2] === false && /not this connection/.test(okm[3]), JSON.stringify(okm));
const toStranger = signEvent(cliSk, KIND_REQUEST, [['p', strangerPk]], 'x');
app.send(['EVENT', toStranger]);
okm = await until(app, (m) => m[0] === 'OK' && m[1] === toStranger.id);
t('C7 a request to an unregistered service key is refused', okm && okm[2] === false && /not a registered/.test(okm[3]), JSON.stringify(okm));
const old = signEvent(cliSk, KIND_REQUEST, [['p', svcPk]], 'x', nowS() - 700);
app.send(['EVENT', old]);
okm = await until(app, (m) => m[0] === 'OK' && m[1] === old.id);
t('C8 a request dated 11 minutes ago is refused', okm && okm[2] === false && /10 minutes/.test(okm[3]), JSON.stringify(okm));
const other = signEvent(cliSk, 1, [['p', svcPk]], 'hello');
app.send(['EVENT', other]);
okm = await until(app, (m) => m[0] === 'OK' && m[1] === other.id);
t('C9 a kind-1 note is refused', okm && okm[2] === false && /not an NWC event kind/.test(okm[3]), JSON.stringify(okm));
app.send(['REQ', 'spy', { kinds: [KIND_REQUEST], '#p': [svcPk] }]);
closed = await until(app, (m) => m[0] === 'CLOSED' && m[1] === 'spy');
t('C10 the app cannot read requests (auth-required as the service key)', closed && /auth-required/.test(closed[2]), JSON.stringify(closed));
t('C11 the request is on disk', JSON.parse(fs.readFileSync(path.join(dir, 'nwc', 'events.json'), 'utf8')).requests.length === 1);

// ── (D) the wallet authenticates, reads the request, replies; the app gets the reply live ──
app.send(['REQ', 'r', { kinds: [KIND_RESPONSE], '#p': [cliPk] }]);
await until(app, (m) => m[0] === 'EOSE' && m[1] === 'r');
wallet.send(['REQ', 'q0', { kinds: [KIND_REQUEST], '#p': [svcPk] }]);
closed = await until(wallet, (m) => m[0] === 'CLOSED' && m[1] === 'q0');
t('D1 before AUTH the wallet cannot read requests either', closed && /auth-required/.test(closed[2]), JSON.stringify(closed));
const badAuth = signEvent(svcSk, KIND_AUTH, [['relay', 'wss://lsp.example.test/nwc'], ['challenge', 'wrong']], '');
wallet.send(['AUTH', badAuth]);
okm = await until(wallet, (m) => m[0] === 'OK' && m[1] === badAuth.id);
t('D2 a wrong challenge is refused', okm && okm[2] === false, JSON.stringify(okm));
const auth = signEvent(svcSk, KIND_AUTH, [['relay', 'wss://lsp.example.test/nwc'], ['challenge', challenge]], '');
wallet.send(['AUTH', auth]);
okm = await until(wallet, (m) => m[0] === 'OK' && m[1] === auth.id);
t('D3 the right challenge authenticates the service key', okm && okm[2] === true, JSON.stringify(okm));
wallet.send(['REQ', 'q', { kinds: [KIND_REQUEST], '#p': [svcPk] }]);
got = await until(wallet, (m) => m[0] === 'EVENT' && m[1] === 'q');
t('D4 the waiting request is served, as stored', got && got[2].id === request.id && got[2].content === request.content);
t('D5 then EOSE', !!(await until(wallet, (m) => m[0] === 'EOSE' && m[1] === 'q')));
const reply = signEvent(svcSk, KIND_RESPONSE, [['p', cliPk], ['e', request.id], ['encryption', 'nip44_v2']], 'AgAAAA…reply…');
wallet.send(['EVENT', reply]);
okm = await until(wallet, (m) => m[0] === 'OK' && m[1] === reply.id);
t('D6 the reply is accepted', okm && okm[2] === true, JSON.stringify(okm));
got = await until(app, (m) => m[0] === 'EVENT' && m[1] === 'r');
t('D7 the app receives it live on its subscription', got && got[2].id === reply.id);
t('D8 the answered request is no longer waiting', N.summary().waiting === 0 && N.summary().replies_kept === 1, JSON.stringify(N.summary()));
// a second request arrives while the wallet is subscribed: delivered live, and no second wake within 60 s
const request2 = signEvent(cliSk, KIND_REQUEST, [['p', svcPk], ['encryption', 'nip44_v2']], 'AgAAAA…two…');
app.send(['EVENT', request2]);
got = await until(wallet, (m) => m[0] === 'EVENT' && m[1] === 'q' && m[2].id === request2.id);
t('D9 a new request reaches the authenticated wallet live', !!got);
t('D10 no second wake inside 60 s', wakes.length === 1);
clock += 61_000;
const request3 = signEvent(cliSk, KIND_REQUEST, [['p', svcPk]], 'three');
app.send(['EVENT', request3]);
await until(app, (m) => m[0] === 'OK' && m[1] === request3.id); await sleep(20);
t('D11 after 60 s a wake goes again', wakes.length === 2);
// the reply-read rule: a stranger asking by the client key gets the reply (T4 default), by another key nothing
const snoop = await connect(); await until(snoop, (m) => m[0] === 'AUTH');
snoop.send(['REQ', 's', { kinds: [KIND_RESPONSE], '#p': [strangerPk] }]);
await until(snoop, (m) => m[0] === 'EOSE' && m[1] === 's');
t('D12 a reply is not served under another client key', !snoop.inbox.some((m) => m[0] === 'EVENT'));

// ── (E) the cap on waiting requests ──
for (let i = 0; i < 20; i++) { const e = signEvent(cliSk, KIND_REQUEST, [['p', svcPk]], 'n' + i); app.send(['EVENT', e]); await until(app, (m) => m[0] === 'OK' && m[1] === e.id); }
const over = signEvent(cliSk, KIND_REQUEST, [['p', svcPk]], 'over');
app.send(['EVENT', over]);
okm = await until(app, (m) => m[0] === 'OK' && m[1] === over.id);
t('E1 the 21st waiting request is refused, not stored', okm && okm[2] === false && /rate-limited/.test(okm[3]) && N.summary().waiting === 20, JSON.stringify([okm, N.summary()]));

// ── (F) a restart keeps everything ──
const N2 = make(); attachTo(N2); current = () => N2;
t('F1 after a restart the connections and the waiting requests are still there', N2.summary().connections === 10 && N2.summary().waiting === 20 && N2.summary().replies_kept === 1, JSON.stringify(N2.summary()));
// the sweep: past the ttl the requests go; past the expiry the connection goes
clock += 3601 * 1000;
N2.sweep();
t('F2 requests past their ttl are gone', N2.summary().waiting === 0, JSON.stringify(N2.summary()));
clock += 91 * 86400 * 1000;
t('F3 a connection past its expiry is dropped by the provider itself', N2.sweep() === 10 && N2.summary().connections === 0, JSON.stringify(N2.summary()));

// ── (G) unregister ──
clock = 1_700_000_000_000;
const N3 = make(); attachTo(N3); current = () => N3;
r = await post('/v1/nwc/register', { client_pubkey: WALLET, service_pk: svcPk, client_pk: cliPk, expires_at: nowS() + 86400, ttl_s: 600, ts: nowS(), signature: goodSig('lij-nwc-register:v1|' + svcPk + '|' + cliPk + '|' + (nowS() + 86400) + '|600|' + nowS()) }, { 'x-adapter-secret': 'tok' });
t('G1 registered again', r.status === 200);
r = await post('/v1/nwc/unregister', { client_pubkey: WALLET, service_pk: svcPk, ts: nowS(), signature: 'other' }, { 'x-adapter-secret': 'tok' });
t('G2 unregister by another key → 401', r.status === 401);
r = await post('/v1/nwc/unregister', { client_pubkey: WALLET, service_pk: svcPk, ts: nowS(), signature: goodSig('lij-nwc-unregister:v1|' + svcPk + '|' + nowS()) }, { 'x-adapter-secret': 'tok' });
t('G3 unregistered — gone with everything stored for it', r.status === 200 && r.body.gone === true && N3.summary().connections === 0);
const late = signEvent(cliSk, KIND_REQUEST, [['p', svcPk]], 'late');
const app2 = await connect(); await until(app2, (m) => m[0] === 'AUTH');
app2.send(['EVENT', late]);
okm = await until(app2, (m) => m[0] === 'OK' && m[1] === late.id);
t('G4 a request after the revoke stores nothing and wakes nobody', okm && okm[2] === false && wakes.length === 2, JSON.stringify(okm));

// ── (H) the switch off ──
const OFF = make({ NWC_ENABLED: 'false' }); attachTo(OFF); current = () => OFF;
r = await post('/v1/nwc/register', {}, { 'x-adapter-secret': 'tok' });
t('H1 off: the routes answer 404 nwc_off', r.status === 404 && r.body.error === 'nwc_off');
const refused = await new Promise((resolve) => { const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/nwc'); ws.on('error', () => resolve(true)); ws.on('open', () => resolve(false)); });
t('H2 off: the relay refuses the upgrade', refused === true);
t('H3 capability says so', OFF.capability.enabled === false && OFF.capability.relay === null && N.capability.relay === 'wss://lsp.example.test/nwc');
t('H4 no key, invoice, amount or address in the log', !logs.some((l) => /lnbc|sats|127\.0\.0\.1|ciphertext/.test(l)) && logs.every((l) => !/[0-9a-f]{16}/.test(l.replace(/until [^ ]+/g, ''))), logs.filter((l) => /[0-9a-f]{16}/.test(l.replace(/until [^ ]+/g, ''))).slice(0, 2).join(' | '));

// a bad-path shape check on checkEvent
t('I1 checkEvent: missing fields', checkEvent({}) !== '' && checkEvent(null) !== '');
t('I2 checkEvent: a good event passes', checkEvent(info) === '');

// ── (J) 0.86.1: the adapter's dispatcher reaches nwc.handle on the NWC prefix (DP's field test, step 2: 0.86.0 had
//      the line inside the /push/ block, so /v1/nwc/register fell to the generic 404 "Not found") ──
const asrc = require('fs').readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
const pushBlock = asrc.match(/if \(path\.startsWith\('\/push\/'\)\) \{[\s\S]*?\n  \}/);
t('J1 the /push/ block no longer carries the NWC dispatch', !!pushBlock && !/nwc\.handle/.test(pushBlock[0]));
t('J2 the NWC routes dispatch on their own prefix', /if \(path\.startsWith\('\/v1\/nwc\/'\)\) \{\n    if \(await nwc\.handle\(req, res, path, method, ip, readBody, jsonResponse\)\) return;/.test(asrc));

for (const c of [wallet, app, snoop, app2]) try { c.ws.close(); } catch (_) {}
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FAIL harness: ' + (e && e.stack || e)); process.exit(1); });
