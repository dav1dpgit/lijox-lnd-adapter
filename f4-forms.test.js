'use strict';
// 0.144.0 (S72 Wed 2026-11-25, the rest of F that needs no ruling — the wallet repo's docs/design/routes/f4-r1.md):
// THE ENGINE'S CHANNEL RECORD AND A MIX SEAT TAKEN IN THE WALLET'S OWN NAME, INSIDE THE LIGHTNING CONNECTION; AND THE
// PROVIDER'S SIGNED WORD ON ITS REGISTRY RECORD THAT IT TAKES REQUESTS THERE (`rpc`, lijox-register:v7).
//   node f4-forms.test.js
// s: the source — the two rows, the registry router's mark, the list on the record, the fall-back for older registries.
// n: the two registrations as the adapter writes them, on a stand-in for the web form.
// m: movedWebForm — the channel record's web form counts as moved; a Mix seat's never does.
// b: BOTH FORMS, THE REAL ROUTE, for the channel record (registry.js): the same record stored, the same answer; the
//    connection's key and no other; nothing on the web can stand in for a connection.
// r: THE REGISTRATION, RUN: the signed message with the list (v7), and the loop that posts it — a registry that knows
//    the list, one that does not (given v6), and one that knows none of the blocks (given the record without them).
// NOT RUN HERE: POST /tatara/seat itself (tatara.js is not changed; tatara-doors.test.js and tatara-routes.test.js are
// its tests), and the registration against LND's own signer (the stand-in boot of build_01440.py registers with the
// chain bridge off, so the record there carries no list).
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const lib = require('./lijox-web-form');
const { createLijoxRpc } = require('./lijox-rpc');
const reg = require('./registry');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const rsrc = fs.readFileSync(path.join(__dirname, 'registry.js'), 'utf8');
let fails = 0;
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : '')); } else console.log('  ok · ' + m); };
const lift = (head, tail) => { const a = src.indexOf(head); if (a < 0) return null; const b = src.indexOf(tail || '\n}\n', a); return b > a ? src.slice(a, b + (tail || '\n}\n').length) : null; };
const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32);
const J = (x) => JSON.stringify(x);
const REC = { channel_id: 'a'.repeat(64), funding_txid: 'b'.repeat(64), funding_vout: 0, channel_value_sat: 100000, commit_type: 'ANCHORS', channel_keys_id_hex: 'c'.repeat(64) };

(async () => {
  // ── s: the source ──
  const rA = src.indexOf('// (the end of the 0.141.0 registrations)\n'), rB = src.indexOf('// (the end of the 0.142.0 registrations)');
  const block = src.slice(rA, rB);
  const rows = (block.match(/^  \['lijox\.[a-z_]+',/gm) || []).map((x) => x.slice(4, -2));
  check(rows.length >= 24 && new Set(rows).size === rows.length && rows.indexOf('lijox.channel_record') === 22 && rows.indexOf('lijox.mix_seat') === 23, 's1 the table had 24 rows in 0.144.0; the two new ones were its last (rows 23 and 24)', rows.slice(21, 25));
  check(block.includes("  ['lijox.channel_record',      'POST', '/lsps/registry/channels', { key: ['node_pubkey'] }],") && block.includes("  ['lijox.mix_seat',            'POST', '/tatara/seat',          { same: 'node_pubkey', open: true }],"), 's2 the channel record is written with the connection\'s key; a Mix seat must name it, and its web form is never refused');
  check((block.match(/lijoxRpc\.register\(/g) || []).length === 1, 's3 one loop still registers the whole table');
  check(src.includes('  callerOf: webFormLib.callerOf,') && rsrc.includes('function makeRegistryRouter({ nonceStore, channelStore, jsonResponse, errResponse, readBody, callerOf }) {') && rsrc.includes("const conn = (typeof callerOf === 'function') ? callerOf(body) : null;"), 's4 the registry router is handed the reader of the connection\'s mark');
  const regFn = lift('async function registerWithRegistry() {', '\n}\n') || '';
  check(regFn.includes("if (chainBridge && lijoxRpc.capability && lijoxRpc.capability.lsps0 === true) body.rpc = ['lsps0'];") && regFn.indexOf("body.rpc = ['lsps0'];") < regFn.indexOf('body.signature = await signWith(canonicalRegisterMsg(body));'), 's5 the list goes on the record before it is signed, and only while the path is up');
  check(/rpc:\s+chainBridge \? lijoxRpc\.capability : null,/.test(src), 's6 /health says the same under the same condition');
  check(regFn.indexOf('if (!v6)') > 0 && regFn.indexOf('if (!v6)') < regFn.indexOf('if (!v5)') && regFn.indexOf('if (!v5)') < regFn.indexOf('if (!v4)') && regFn.indexOf('if (!v4)') < regFn.indexOf('if (!v3)') && ['v6', 'v5', 'v4', 'v3'].every((v) => regFn.includes('delete ' + v + '.rpc;')) && !/delete body\.rpc/.test(regFn), 's7 an older registry is given the record without the list (v6), then without each older block in turn; the full record is kept for the others');
  check(src.indexOf('if (f.rpc && f.rpc.length) {') > 0 && src.indexOf('if (f.rpc && f.rpc.length) {') < src.indexOf('if (f.chan_confs) {'), 's8 the v7 branch of the signed message comes before v6');

  // ── n: the registrations, with a stand-in for the web form ──
  const calls = []; const sent = [];
  const stubForm = { call: async (pk, m, p, body, query) => { calls.push({ pk, m, p, body: body === undefined ? null : body, query: query || null }); return { status: 200, body: { ok: true, n: calls.length } }; } };
  const rpc = createLijoxRpc({ version: '0.144.0', send: async (peer, type, buf) => { sent.push(JSON.parse(buf.toString('utf8'))); }, log() {} });
  const plainParams = (p) => (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; const BAD = (why) => ({ status: 400, body: { ok: false, error: why } });
  const moneyCall = async () => ({ status: 500, body: { ok: false } });
  new Function('lijoxRpc', 'webForm', 'plainParams', 'BAD', 'nowS', 'moneyCall', 'pendingJitBuys', block)(rpc, stubForm, plainParams, BAD, () => 1800000000, moneyCall, new Map());
  const ask = async (method, params, from) => { sent.length = 0; await rpc.onMessage(from || PK, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); return sent[0]; };
  const last = () => calls[calls.length - 1];
  const st = (a) => !a ? null : (a.result !== undefined ? 200 : (a.error ? a.error.code : null));
  let a = await ask('lijox.channel_record', { record: REC, node_pubkey: OTHER, nonce: 'n', signature: 's' });
  check(st(a) === 200 && last().pk === PK && last().m === 'POST' && last().p === '/lsps/registry/channels' && J(last().body) === J({ record: REC, node_pubkey: PK }), 'n1 the channel record goes to its web route\'s code with the connection\'s key; a named key, a nonce and a signature are dropped', last());
  const SEAT = { route: 'chain', size: 100000, seat_pk: 'd'.repeat(64), node_pubkey: PK, ts: 1800000000, signature: 'signed-by-the-node-key' };
  a = await ask('lijox.mix_seat', SEAT);
  check(st(a) === 200 && last().p === '/tatara/seat' && J(last().body) === J(SEAT), 'n2 a Mix seat in the wallet\'s own name goes as sent, signature and all', last());
  let n0 = calls.length; a = await ask('lijox.mix_seat', Object.assign({}, SEAT, { node_pubkey: OTHER }));
  check(st(a) === 403 && calls.length === n0, 'n3 a seat that names another wallet\'s key is refused before the route is asked', a);
  n0 = calls.length; a = await ask('lijox.mix_seat', { route: 'chain', size: 100000, seat_pk: 'd'.repeat(64), ts: 1800000000, wake_json: '{}', ring_hash: 'e'.repeat(64), ring_sig: { c0: 'x', s: [] } });
  check(st(a) === 403 && calls.length === n0, 'n4 A RING-SIGNED SEAT IS NEVER TAKEN INSIDE THE CONNECTION — it names no wallet, and the connection would name one', a);
  const hello = await ask('lijox.hello', {});
  check(hello.result && hello.result.methods.includes('lijox.channel_record') && hello.result.methods.includes('lijox.mix_seat'), 'n5 lijox.hello names both', hello.result && hello.result.methods.length);

  // ── m: movedWebForm ──
  const mvSrc = lift('const MOVED_WEB_BODY = {', "const REFUSE_WEB_FORMS = String(process.env.LIJOX_WEB_FORMS || '').trim().toLowerCase() === 'refuse';\n");
  const tblSrc = src.slice(src.indexOf('const REST142 = ['), src.indexOf('];\n', src.indexOf('const REST142 = [')) + 3);
  const before = src.slice(0, src.indexOf('const MOVED_WEB_BODY = {'));
  const maps = ['MOVED_WEB_UNNAMED', 'MOVED_WEB_QUERY_KEY', 'MOVED_WEB_QUERY_CLIENT'].map((nm) => { const i = before.lastIndexOf('const ' + nm + ' = '); return i < 0 ? 'const ' + nm + ' = {};' : before.slice(i, before.indexOf('\n', i) + 1); }).join('\n');
  let movedWebForm = null;
  try { movedWebForm = new Function(tblSrc + '\n' + maps + '\n' + mvSrc + '\nreturn movedWebForm;')(); } catch (e) { check(false, 'm0 movedWebForm could be lifted from the source', String(e.message)); }
  if (movedWebForm) {
    const sp = new URLSearchParams('');
    check(movedWebForm('POST', '/lsps/registry/channels', sp) === 'lijox.channel_record', 'm1 the channel record\'s web form is a moved request (counted; refused when the operator says so)');
    check(movedWebForm('GET', '/lsps/registry/channels', sp) === null && movedWebForm('GET', '/lsps/registry/challenge', sp) === null && movedWebForm('POST', '/lsps/registry/my-channels', sp) === null && movedWebForm('POST', '/lsps/registry/recover-close', sp) === null, 'm2 the checks a wallet makes before it connects, and the challenge, are never refused');
    check(movedWebForm('POST', '/tatara/seat', sp) === null && movedWebForm('POST', '/tatara/checkin', sp) === null && movedWebForm('GET', '/tatara/info', sp) === null, 'm3 no Mix request\'s web form is ever refused');
  }

  // ── b: both forms, the real route (registry.js) ──
  const mkRouter = () => {
    const nonceStore = new reg.NonceStore(), channelStore = new reg.MemoryChannelStore();
    const jsonResponse = (res, data, status = 200) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    const readBody = (req) => Promise.resolve(lib.carry(req, JSON.parse(JSON.stringify(req._body || {}))));
    const router = reg.makeRegistryRouter({ nonceStore, channelStore, jsonResponse, errResponse: (res, m, s = 400) => jsonResponse(res, { error: m }, s), readBody, callerOf: lib.callerOf });
    const call = async (method, p, body, conn) => {
      const url = new URL('http://localhost' + p); const req = { method, url: p, headers: {}, _body: body };
      if (conn) Object.defineProperty(req, lib.CALLER, { value: conn, enumerable: false });
      const cap = { status: 200, body: null }; const res = { writeHead(s) { cap.status = s; }, end(b) { cap.body = JSON.parse(b); }, setHeader() {} };
      const handled = await router.tryHandle(req, res, url); return { handled, status: cap.status, body: cap.body };
    };
    return { call, channelStore };
  };
  let priv; do { priv = crypto.randomBytes(32); } while (!secp256k1.privateKeyVerify(priv));
  const WPK = Buffer.from(secp256k1.publicKeyCreate(priv)).toString('hex');
  const sign = (msg) => Buffer.from(secp256k1.ecdsaSign(msg, priv).signature).toString('hex');
  {
    const W = mkRouter(), C = mkRouter();
    const nonce = (await W.call('GET', '/lsps/registry/challenge')).body.nonce;
    const sig = sign(reg.buildSignedMessage(reg.ACTION_POST_CHANNEL, nonce, WPK, reg.channelRecordId(reg.canonicalizeRecord(REC))));
    const web = await W.call('POST', '/lsps/registry/channels', { node_pubkey: WPK, nonce, signature: sig, record: REC });
    const inside = await C.call('POST', '/lsps/registry/channels', { node_pubkey: WPK, record: REC }, WPK);
    const strip = (b) => { const o = Object.assign({}, b); delete o.stored_at; return o; };
    check(web.status === 200 && inside.status === 200 && J(strip(web.body)) === J(strip(inside.body)) && web.body.ok === true && J(inside.body.record) === J(reg.canonicalizeRecord(REC)) && typeof inside.body.stored_at === 'number', 'b1 the same record through both forms: the same answer (the record as stored, replaced false)', { web: web.body, inside: inside.body });
    check(J(await W.channelStore.getChannels(WPK)) === J(await C.channelStore.getChannels(WPK)) && (await C.channelStore.getChannels(WPK)).length === 1, 'b2 and the same record in the store, under the wallet\'s key');
    const again = await C.call('POST', '/lsps/registry/channels', { node_pubkey: WPK, record: Object.assign({}, REC, { close_height: 900000, closing_txid: 'f'.repeat(64) }) }, WPK);
    check(again.status === 200 && again.body.replaced === true && again.body.record.close_height === 900000, 'b3 a later form of the record replaces it, as on the web', again.body);
    const other = await C.call('POST', '/lsps/registry/channels', { node_pubkey: OTHER, record: REC }, WPK);
    check(other.status === 403 && other.body.error === 'not_the_connections_key' && (await C.channelStore.getChannels(OTHER)).length === 0, 'b4 inside a connection a record is stored under that connection\'s key and no other', other.body);
    const bad = await C.call('POST', '/lsps/registry/channels', { node_pubkey: WPK, record: Object.assign({}, REC, { channel_id: 'zz' }) }, WPK);
    const badWeb = await W.call('POST', '/lsps/registry/channels', { node_pubkey: WPK, nonce: (await W.call('GET', '/lsps/registry/challenge')).body.nonce, signature: sig, record: Object.assign({}, REC, { channel_id: 'zz' }) });
    check(bad.status === 400 && J(bad.body) === J(badWeb.body), 'b5 a record that does not fit is refused with the web form\'s own words', { inside: bad.body, web: badWeb.body });
    const none = await C.call('POST', '/lsps/registry/channels', { node_pubkey: WPK }, WPK);
    check(none.status === 400 && none.body.error === 'missing_field', 'b6 no record: refused', none.body);
    const fake = await mkRouter().call('POST', '/lsps/registry/channels', { node_pubkey: WPK, record: REC, 'lijox.caller': WPK, CALLER: WPK, caller: WPK });
    check(fake.status === 400 && fake.body.error === 'missing_field', 'b7 A WEB REQUEST CANNOT STAND IN FOR A CONNECTION: without the mark the nonce and the signature are asked for, whatever the body says', fake.body);
    const wrongSig = await W.call('POST', '/lsps/registry/channels', { node_pubkey: WPK, nonce: (await W.call('GET', '/lsps/registry/challenge')).body.nonce, signature: '11'.repeat(64), record: REC });
    check(wrongSig.status === 401, 'b8 the web form still checks its signature', wrongSig.body);
  }

  // ── r: the registration ──
  const TF = lift('const TATARA_FIELDS = [', '];\n') || (() => { const t = fs.readFileSync(path.join(__dirname, 'tatara.js'), 'utf8'); const i = t.indexOf('const TATARA_FIELDS = ['); return i < 0 ? '' : t.slice(i, t.indexOf('];\n', i) + 3); })();
  const canonSrc = lift('function canonicalRegisterMsg(f) {', '\n}\n');
  let canon = null;
  try { canon = new Function((/const TATARA_FIELDS/.test(TF) ? TF : 'const TATARA_FIELDS = [];') + '\n' + canonSrc + '\nreturn canonicalRegisterMsg;')(); } catch (e) { check(false, 'r0 the signed message\'s function could be lifted', String(e.message)); }
  if (canon) {
    const base = { pubkey: PK, ts: 1800000000, name: 'Box', endpoint: 'https://a.example', wss_url: 'wss://a.example/ws', fee_ppm: 100, supports_jit: true, routes: [{ reach: 'direct', endpoint: 'https://a.example', wss_url: 'wss://a.example/ws', filter_url: null }], chan_confs: { min: 3, max: 6 } };
    const m6 = canon(base), m7 = canon(Object.assign({}, base, { rpc: ['lsps0'] }));
    check(m6.startsWith('lijox-register:v6:') && m7.startsWith('lijox-register:v7:') && m7.slice(18) === m6.slice(18) + ':lsps0', 'r1 the signed message with the list is every v6 field in place, then the list', m7.slice(-30));
    check(canon(Object.assign({}, base, { rpc: [] })) === m6 && canon(Object.assign({}, base, { rpc: null })) === m6, 'r2 no list, or an empty one: the message is v6, byte for byte');
    // the loop that posts the record, as the adapter writes it
    const a0 = regFn.indexOf('    body.signature = await signWith(canonicalRegisterMsg(body));'), a1 = regFn.indexOf("    if (errors.length < CONFIG.registries.length) registryStatus.last_ok = Date.now();");
    const loopSrc = regFn.slice(a0, a1);
    const knows = { 'https://new': 7, 'https://mid': 6, 'https://old': 3 };
    const posts = []; const signed = [];
    const httpsPost = async (url, b) => {
      const door = url.replace('/lsps/register', ''); const lvl = knows[door];
      const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
      const needs = has('rpc') ? 7 : has('chan_confs') ? 6 : has('tower') ? 5 : has('routes') ? 4 : 3;
      const good = needs <= lvl && b.signature === 'sig:' + canon(Object.assign({}, b, { signature: undefined })).split(':')[1];
      posts.push({ door, needs, ok: good });
      return good ? { ok: true } : { ok: false, error: 'signature does not verify for this pubkey over the registered fields' };
    };
    const signWith = async (c) => { signed.push(c.split(':')[1]); return 'sig:' + c.split(':')[1]; };
    const registryStatus = { doors: {}, last_ok: 0, last_error: '' };
    const body = Object.assign({}, base, { tower: { offered: true, quota_bytes: 1, keep_days_silent: 2, form: 'teos-v1' }, rpc: ['lsps0'] });
    const lines = [];
    try {
      await new Function('body', 'signWith', 'canonicalRegisterMsg', 'CONFIG', 'httpsPost', 'registryStatus', 'console', 'return (async () => {' + loopSrc + '\n})();')(body, signWith, canon, { registries: Object.keys(knows) }, httpsPost, registryStatus, { log: (...x) => lines.push(x.map(String).join(' ')), error() {} });
    } catch (e) { check(false, 'r3 the posting loop ran', String(e.message)); }
    const by = (d) => posts.filter((p) => p.door === d);
    check(by('https://new').length === 1 && by('https://new')[0].needs === 7 && by('https://new')[0].ok, 'r3 a registry that knows the list is given the full record once', by('https://new'));
    check(J(by('https://mid').map((p) => p.needs + ':' + p.ok)) === J(['7:false', '6:true']), 'r4 a registry that does not know the list is given the record without it, signed as v6', by('https://mid'));
    check(J(by('https://old').map((p) => p.needs + ':' + p.ok)) === J(['7:false', '6:false', '5:false', '4:false', '3:true']), 'r5 a registry that knows none of the blocks is walked down to the record without any of them', by('https://old'));
    check(J(signed) === J(['v7', 'v6', 'v5', 'v4', 'v1']) && J(body.rpc) === J(['lsps0']) && !!body.tower && !!body.routes, 'r6 each older form is signed once (the last one is v1 here: this record offers no filter server and no Mix); the full record itself is not changed', signed);
    check(Object.keys(registryStatus.doors).length === 3 && Object.values(registryStatus.doors).every((d) => d.last_ok > 0 && d.last_error === '') && lines.some((l) => /https:\/\/mid does not know the rpc list/.test(l)), 'r7 every door ends registered, and the journal says which door was given less', lines.filter((l) => /does not know/.test(l)).length);
  }

  console.log(fails ? ('FAIL · f4-forms · ' + fails) : 'PASS · f4-forms (the channel record and a Mix seat inside the connection; the list on the registry record)');
  process.exit(fails ? 1 : 0);
})();
