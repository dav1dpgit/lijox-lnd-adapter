// 0.137.0 (S72 Tue 2026-11-24): THE WALLET'S SETTINGS THROUGH BOTH FORMS — POST /client/prefs and `lijox.prefs_set`
// inside the Lightning connection give the same answer, from one function.
//   node prefs-forms.test.js
// The adapter is one module that starts servers on require, so this reads the source: prefsSet, clientPrefsZaps and the
// method's registration as written, evaluated with stand-ins for the stores; the path is the real lijox-rpc.js.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { createLijoxRpc } = require('./lijox-rpc');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, 'cooperative-chain-bridge.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : '')); } else ok(m); };
const lift = (head) => { const a = src.indexOf(head); const b = src.indexOf('\n}\n', a) + 3; return a > 0 && b > a ? src.slice(a, b) : null; };
const fPrefs = lift('function prefsSet(pk, params) {'), fZaps = lift('function clientPrefsZaps(body, res) {');
const regA = src.indexOf("lijoxRpc.register('lijox.prefs_set', (caller, params) => {"), regB = src.indexOf('\n});\n', regA) + 5;
check(!!fPrefs && !!fZaps && regA > 0, 's1 prefsSet, clientPrefsZaps and the method\'s registration are in the adapter');
check(src.includes("const hr = prefsSet(pk, { hold_ms: body.hold_ms });") && src.includes("const zr = prefsSet(zpk, { zaps: body.zaps });"), 's2 both bodies of POST /client/prefs call the one function');
check(/rpc:\s+chainBridge \? lijoxRpc\.capability : null,/.test(src), 's3 /health says { lsps0: true } while the chain bridge runs, null without it');
check(src.includes("onLsps0: (peerHex, buf) => lijoxRpc.onMessage(peerHex, buf),") && bridge.includes("if (typeId === TYPE_LSPS0) {") && bridge.indexOf("if (typeId === TYPE_LSPS0) {") < bridge.indexOf("// Filter to LiJ-reserved range (32801..=32819)."), 's4 the bridge hands a 37913 message to the path before its own filter, and the adapter gives it the path');
check(bridge.includes("sendCustom: (peerHex, typeId, bytes) => sendToPeer(") && src.includes("chainBridge.sendCustom(peerHex, type, buf)"), 's5 answers leave through the bridge\'s own send');
check(src.includes("formCounts.tunnel(found ? found.peerHex : (local.passKey || null), !!local.passKey)"), 's6 each tunnel whose handshake has passed is counted, with a pass or without');
check(crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'ws-tunnel.js'))).digest('hex') === '9d06a54fe44245a66e2d0f9645f981eba591e0157853ba2b28382321c96edd5d', 's7 ws-tunnel.js is byte for byte the 0.145.0 file (0.137.0 changed nothing at the tunnel; 0.145.0 added the check frame — ws-tunnel.test.js k0–k6)');

const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32);
function make({ zapsOn = true, holdEnabled = true, capMs = 43200000, authOk = true } = {}) {
  const st = { clientPrefs: {}, persisted: 0, touched: [], auth: [], web: [], rpcCount: [], out: [], sent: [] };
  const zaps = { on: zapsOn };
  const env = {
    zaps, clientPrefs: st.clientPrefs, clientPrefsPersist: () => { st.persisted++; }, clientHoldCapMs: (pk) => Math.min((st.clientPrefs[pk] || {}).hold_ms || 0, capMs),
    touchWalletActive: (pk) => st.touched.push(pk), OFFLINE_HOLD_CAP_MS: capMs, OFFLINE_HOLD_ENABLED: holdEnabled, console: { log() {}, warn() {}, error() {} },
    lnurlpAuthCheck: (body, action, pk, text) => { st.auth.push(action + '|' + pk.slice(0, 4) + '|' + text); return authOk ? { ok: true } : { ok: false, code: 'bad_signature', status: 401 }; },
    jsonResponse: (res, j, status) => { st.out.push({ status: status || 200, body: j }); },
    formCounts: { web: (pk, m) => st.web.push(pk.slice(0, 4) + ':' + m), rpc: (pk, m) => st.rpcCount.push(pk.slice(0, 4) + ':' + m) },
  };
  const lijoxRpc = createLijoxRpc({ version: '0.137.0', send: async (peer, type, buf) => { st.sent.push(JSON.parse(buf.toString('utf8'))); }, log() {},
    onServed: (peerHex, method) => { if (method.startsWith('lijox.') && method !== 'lijox.hello' && method !== 'lijox.what_became') env.formCounts.rpc(peerHex, method); } });
  const names = Object.keys(env);
  const made = new Function(...names, 'lijoxRpc', fPrefs + '\n' + fZaps + '\n' + src.slice(regA, regB) + '\nreturn { prefsSet, clientPrefsZaps };')(...names.map((n) => env[n]), lijoxRpc);
  const rpc = async (peer, params) => { st.sent.length = 0; await lijoxRpc.onMessage(peer, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method: 'lijox.prefs_set', params }))); return st.sent[0]; };
  // the web route's two bodies as the adapter runs them: the proof first, then the one function
  const webHold = (pk, ms) => { st.out.length = 0; const pr = env.lnurlpAuthCheck({}, 'client-prefs', pk, 'prefs:' + String(ms)); if (!pr.ok) return { status: pr.status, body: { ok: false, error: 'auth: ' + pr.code } }; env.formCounts.web(pk, 'lijox.prefs_set'); return made.prefsSet(pk, { hold_ms: ms }); };
  const webZaps = (pk, on) => { st.out.length = 0; made.clientPrefsZaps({ client_pubkey: pk, zaps: on }, {}); return st.out[0]; };
  return { st, rpc, webHold, webZaps, lijoxRpc, made };
}

(async () => {
  // the hold
  let k = make();
  const w = k.webHold(PK, 21600000);
  let k2 = make();
  const r = await k2.rpc(PK, { hold_ms: 21600000 });
  check(w.status === 200 && r.result && JSON.stringify(r.result) === JSON.stringify(w.body), 'p1 the hold: inside the connection the result is byte for byte the web route\'s body', [w.body, r.result]);
  check(k2.st.clientPrefs[PK].hold_ms === 21600000 && k2.st.persisted === 1 && k2.st.touched[0] === PK, 'p2 it is kept under the CONNECTION\'s key, written, and counts as the wallet being awake');
  check(k2.st.auth.length === 0 && k.st.auth[0] === 'client-prefs|02aa|prefs:21600000', 'p3 inside the connection no signed proof is asked; the web route still asks the same proof as before', [k2.st.auth, k.st.auth]);
  check(k.st.web[0] === '02aa:lijox.prefs_set' && k2.st.rpcCount[0] === '02aa:lijox.prefs_set' && k2.st.web.length === 0, 'p4 each form is counted as what it is');
  // the zap choice
  k = make({ zapsOn: false }); k2 = make({ zapsOn: false });
  const wz = k.webZaps(PK, true), rz = await k2.rpc(PK, { zaps: true });
  check(wz.status === 409 && rz.error && rz.error.code === 409 && rz.error.message === 'not_offered' && JSON.stringify(rz.error.data) === JSON.stringify(wz.body) && !k2.st.clientPrefs[PK], 'p5 zaps on at a provider that does not offer them: 409 not_offered both ways, the same body, nothing written', [wz, rz.error]);
  const wo = k.webZaps(PK, false), ro = await k2.rpc(PK, { zaps: false });
  check(wo.status === 200 && JSON.stringify(ro.result) === JSON.stringify(wo.body) && k2.st.clientPrefs[PK].zaps === false, 'p6 zaps off is always taken, the same body both ways', [wo.body, ro.result]);
  k = make(); k2 = make();
  check(JSON.stringify((await k2.rpc(PK, { zaps: true })).result) === JSON.stringify(k.webZaps(PK, true).body) && k.st.auth[0] === 'client-prefs|02aa|prefs-zaps:1', 'p7 zaps on where offered: the same body; the web route\'s proof text is unchanged');
  // the caller's key is the wallet
  k2 = make();
  let a = await k2.rpc(PK, { hold_ms: 60000, client_pubkey: OTHER });
  check(a.error && a.error.code === 400 && !k2.st.clientPrefs[OTHER] && !k2.st.clientPrefs[PK], 'p8 a request that names a key in its params is refused: no wallet can set another wallet\'s settings', a);
  a = await k2.rpc(PK, { hold_ms: -1 }); const b = await k2.rpc(PK, { hold_ms: 86400001 }); const c = await k2.rpc(PK, { hold_ms: '60000' }); const d = await k2.rpc(PK, {});
  check([a, b, c, d].every((x) => x.error && x.error.code === 400 && x.error.message === 'bad request') && k2.st.persisted === 0, 'p9 a hold outside 0 to 24 hours, a hold that is not a number, or nothing: 400 bad request, as the web route answers');
  // a provider that does not hold
  k = make({ holdEnabled: false }); k2 = make({ holdEnabled: false });
  const r2 = await k2.rpc(PK, { hold_ms: 3600000 });
  check(r2.result.hold_enabled === false && r2.result.hold_ms_effective === 0 && JSON.stringify(r2.result) === JSON.stringify(k.webHold(PK, 3600000).body), 'p10 a provider that does not hold says so both ways');
  // a web request whose proof fails writes nothing and is not counted
  k = make({ authOk: false });
  const bad = k.webZaps(PK, false);
  check(bad.status === 401 && k.st.web.length === 0 && !k.st.clientPrefs[PK], 'p11 a web request whose proof fails: refused, not counted, nothing written', bad);
  // hello names it
  k2 = make(); k2.st.sent.length = 0;
  await k2.lijoxRpc.onMessage(PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'h', method: 'lijox.hello', params: {} })));
  check(k2.st.sent[0].result.methods.includes('lijox.prefs_set') && k2.st.rpcCount.length === 0, 'p12 lijox.hello names lijox.prefs_set, and asking it is not counted as a moved request');
  console.log(fails ? 'FAIL · prefs-forms · ' + fails + ' failed' : 'PASS · prefs-forms (s1–s7, p1–p12)');
  process.exit(fails ? 1 : 0);
})();
