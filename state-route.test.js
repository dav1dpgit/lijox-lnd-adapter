// 0.136.0 (S71 Fri 2026-11-20): a wallet's statement and its pass — POST /v1/state.
//   node state-route.test.js
// The adapter is one module that starts servers on require, so this reads the source: handleState as written,
// evaluated with stand-ins for LND, the limits and the HTTP helpers; the marks and the passes are the real state-marks.js.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createStateMarks, signedText, cleanChannels } = require('./state-marks');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); } else ok(m); };
const start = src.indexOf('async function handleState(');
const end = src.indexOf('\n}\n', start) + 3;
check(start > 0 && end > start, 'handleState is in the adapter');
const rIdx = src.indexOf("path === '/v1/state' && method === 'POST'"), aIdx = src.indexOf("if (path.startsWith('/lsps/registry/'))");
check(rIdx > 0 && aIdx > rIdx, 'the route is dispatched before the registry router and the auth gate (public, the node key\'s proof)');
check(src.includes("if (path === '/v1/state') kitHolder.openCors(res);"), 'every wallet origin may call it (the kit holder\'s CORS)');
check(/state_pass:\s+stateMarks\.capability/.test(src), 'the capability is announced (state_pass)');
check(src.includes("gate: { take: (h) => stateMarks.takePass(h), required: () => stateMarks.required(), check: () => {"), 'the tunnel is given the gate: a presented pass is taken before anything is opened to LND');
check(/const STATE_PASS_REQUIRED = \/\^\(1\|true\|yes\|on\)\$\/i\.test\(String\(process\.env\.STATE_PASS_REQUIRED \|\| ''\)\.trim\(\)\);/.test(src), 'passes are required only when the operator sets STATE_PASS_REQUIRED');

const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32);
const A = 'a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4:0', B = 'b6'.repeat(32) + ':1';
let t = 1795000000000;
function make({ recovered = PK, verifyDown = false, ipOk = true, keyOk = true, required = false, open = [A, B], lndDown = false } = {}) {
  const calls = { verify: [], lnd: [] };
  // LND's list of this wallet's open channels (asked only when a statement is below a mark)
  const lndGet = async (p) => { calls.lnd.push(p); if (lndDown) return { message: 'server is still in the process of starting' }; if (p === '/v1/channels') return { channels: open.map((cp) => ({ remote_pubkey: PK, channel_point: cp })).concat([{ remote_pubkey: OTHER, channel_point: 'dd'.repeat(32) + ':0' }]) }; return { pending_open_channels: [] }; };
  const stateMarks = createStateMarks({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sr-')), now: () => t, required });
  const lndRequest = async (m, p, body) => { calls.verify.push(Buffer.from(body.msg, 'base64').toString('utf8')); return verifyDown ? { message: 'permission denied' } : { pubkey: recovered }; };
  const lim = (v) => ({ hit: () => (v ? { ok: true } : { ok: false, reset_s: 60 }) });
  const out = [];
  const jsonResponse = (res, j, status) => { out.push({ status: status || 200, json: j }); };
  const errResponse = (res, m, status) => { out.push({ status: status || 400, json: { error: m } }); };
  let bodyNext = null;
  const readBody = async (req, cap) => { if (JSON.stringify(bodyNext).length > cap) throw new Error('Body too large'); return bodyNext; };
  const fn = new Function('lndRequest', 'lndGet', 'stateIpLimit', 'stateKeyLimit', 'jsonResponse', 'errResponse', 'readBody', 'stateMarks', 'stateSignedText', 'stateCleanChannels', 'console',
    src.slice(start, end) + '\nreturn handleState;')(lndRequest, lndGet, lim(ipOk), lim(keyOk), jsonResponse, errResponse, readBody, stateMarks, signedText, cleanChannels, { log() {}, warn() {}, error() {} });
  return { calls, stateMarks, call: async (body) => { bodyNext = body; out.length = 0; await fn({}, {}, '1.2.3.4'); return out[0]; } };
}
const st = (channels, want, at) => { t += 1000; return { node_pubkey: PK, at: at === undefined ? t : at, signature: 'sig', channels, want_pass: want }; };
(async () => {
  // s1 — a statement that is not behind: the marks rise, a pass comes when asked for, in ONE request
  let h = make();
  let r = await h.call(st({ [A]: 1788, [B]: 707 }, true));
  check(r.status === 200 && r.json.ok === true && r.json.behind.length === 0 && /^[0-9a-f]{64}$/.test(r.json.pass) && r.json.pass_ttl_s === 90 && r.json.pass_required === false, 's1 not behind: a pass in the same answer, and whether passes are required', r);
  check(h.calls.verify.length === 1 && h.calls.verify[0] === signedText(PK, t, { [A]: 1788, [B]: 707 }), 's1 LND is asked to check the node key\'s signature over the key, the time and the statement\'s hash');
  check(h.stateMarks.takePass(r.json.pass).pubkey === PK, 's1 the pass is one the tunnel will take, made for this wallet key');
  r = await h.call(st({ [A]: 1788, [B]: 707 }, false));
  check(r.status === 200 && r.json.ok && r.json.pass === undefined, 's1 a statement that asks for no pass gets none');

  // s2 — 2026-11-20: the wallet states an older state than its own high mark
  r = await h.call(st({ [A]: 1785, [B]: 699 }, true));
  check(r.status === 200 && r.json.ok === true && r.json.pass === undefined && r.json.behind.length === 2 && r.json.behind[0].stated === 1785 && r.json.behind[0].mark === 1788 && r.json.behind[1].stated === 699 && r.json.behind[1].mark === 707, 's2 behind its own high mark: the answer names each channel with both numbers, and carries NO pass', r);
  check(h.calls.lnd.includes('/v1/channels'), 's2 LND was asked whether those channels are still open here (it is asked only when a statement is below a mark)');

  // s3 — the proof
  h = make({ recovered: OTHER });
  r = await h.call(st({ [A]: 5 }, true));
  check(r.status === 401 && r.json.reason === 'bad_signature' && Object.keys(h.stateMarks.marksOf(PK)).length === 0, 's3 a signature by another key: refused, nothing kept', r);
  h = make({ verifyDown: true });
  r = await h.call(st({ [A]: 5 }, true));
  check(r.status === 503 && r.json.reason === 'verify_unavailable', 's3 LND cannot check the signature: 503, nothing kept', r);

  // s4 — the shape
  h = make();
  r = await h.call(Object.assign(st({ [A]: 5 }, true), { node_pubkey: 'zz' })); check(r.status === 400, 's4 a key of the wrong shape: 400');
  r = await h.call(Object.assign(st({ [A]: 5 }, true), { at: 'now' })); check(r.status === 400, 's4 a time that is not a whole number: 400');
  r = await h.call(Object.assign(st({ [A]: 5 }, true), { signature: '' })); check(r.status === 400, 's4 no signature: 400');
  r = await h.call(st({ 'not-a-channel': 5 }, true)); check(r.status === 400 && h.calls.verify.length === 0, 's4 a statement of the wrong shape: 400, and LND is not asked');
  r = await h.call(st(undefined, true)); check(r.status === 400, 's4 no statement: 400');

  // s5 — the time: off, or used — answered with a time to sign instead
  r = await h.call(st({ [A]: 5 }, true, t - 10 * 60 * 1000));
  check(r.status === 409 && r.json.ok === false && r.json.reason === 'clock' && Number.isSafeInteger(r.json.now_ms), 's5 a phone whose clock is 10 minutes off: 409 "clock" with this box\'s time', r);
  r = await h.call(st({ [A]: 5 }, true, r.json.now_ms));
  check(r.status === 200 && !!r.json.pass, 's5 stated again with that time: taken, a pass');

  // s6 — the limits
  h = make({ ipOk: false }); r = await h.call(st({ [A]: 5 }, true)); check(r.status === 429 && h.calls.verify.length === 0, 's6 the address limit: 429 before LND is asked');
  h = make({ keyOk: false }); r = await h.call(st({ [A]: 5 }, true)); check(r.status === 429 && Object.keys(h.stateMarks.marksOf(PK)).length === 0, 's6 the key\'s limit (after the proof): 429, nothing kept');

  // s7 — the operator's setting is said in every answer
  h = make({ required: true });
  r = await h.call(st({ [A]: 5 }, false));
  check(r.status === 200 && r.json.pass_required === true, 's7 with passes required the answer says so (the wallet then asks for a pass before every connection)');

  // s8 — a channel LND no longer holds open (closed or closing) does not refuse the pass; LND not answering changes nothing
  h = make({ open: [B] });   // LND holds B open; A is closed there
  r = await h.call(st({ [A]: 1788, [B]: 707 }, false));
  check(h.calls.lnd.length === 0, 's8 a statement that is not below any mark asks LND nothing');
  r = await h.call(st({ [A]: 1785, [B]: 707 }, true));
  check(r.status === 200 && r.json.behind.length === 0 && !!r.json.pass && h.stateMarks.marksOf(PK)[A] === 1788, 's8 below its mark only on a channel that is closed here: not behind, a pass (a reconnect cannot close a closed channel)', r);
  r = await h.call(st({ [A]: 1785, [B]: 699 }, true));
  check(r.status === 200 && r.json.behind.length === 1 && r.json.behind[0].chan_point === B && !r.json.pass, 's8 below its mark on a channel that IS open here: behind, no pass', r);
  h = make({ lndDown: true });
  await h.call(st({ [A]: 1788, [B]: 707 }, false));
  r = await h.call(st({ [A]: 1785, [B]: 699 }, true));
  check(r.status === 200 && r.json.behind.length === 2 && !r.json.pass, 's8 LND cannot say which channels are open: nothing is left out — behind stays behind', r);

  console.log(fails ? 'FAIL · state-route · ' + fails + ' failed' : 'PASS · state-route (s1–s8)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · state-route threw: ' + (e && e.stack || e)); process.exit(1); });
