// delegate-hold.test.js — 0.78.0: the same-LSP hold rail, every timing scenario, with LND and the
// adapter's delivery mocked. Run: node delegate-hold.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Readable } = require('stream');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-hold-'));
process.env.DELEGATE_STORE_FILE = path.join(tmp, 'slips.json');
process.env.DELEGATE_SECRET = 'test-secret';
process.env.DELEGATE_BALANCE_CHECK = 'off';
process.env.DELEGATE_HOLD_TICK_MS = '3600000';   // the loop never fires on its own here; ticks are explicit
const D = require('./delegate.js');
const { CFG, holdTick } = D._test;

const OUR = '03' + 'aa'.repeat(32), WALLET = '02' + 'bb'.repeat(32), ISSUER = '03' + 'cc'.repeat(32), OTHER = '02' + 'dd'.repeat(32);
const HASH = 'ab'.repeat(32), SECRET = 'cd'.repeat(32), PRE = 'ef'.repeat(32);
let nowS = () => Math.floor(Date.now() / 1000);
const mock = { online: false, chan: null, deliver: null, wakes: [], promise: null, holdMs: 180000 };
D.setHooks({
  ourPubkey: () => OUR,
  isPeerConnected: async () => mock.online,
  walletChannel: async () => mock.chan,
  deliverToWallet: async (a) => mock.deliver(a),
  sendWakePush: async (pk, ms) => { mock.wakes.push([pk, ms]); },
  holdCapMs: () => mock.holdMs,
  promiseForScid: () => mock.promise,
  permanentCodes: () => new Set(['INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS']),
  plRecord: () => {}, leaseTouch: () => {},
});
let invoiceDecode = null;
const lnd = async (method, p, body) => {
  if (p.startsWith('/v1/payreq/')) return invoiceDecode;
  if (p === '/v1/verifymessage') return { valid: true, pubkey: ISSUER };
  if (p === '/v1/invoices') return { payment_request: 'lnbc1fund', r_hash: Buffer.from('11'.repeat(32), 'hex').toString('base64') };
  if (p.startsWith('/v1/invoice/')) return { settled: true };
  if (p.startsWith('/v1/graph/routes/')) return { routes: [{ total_fees_msat: '0' }] };
  if (p === '/v2/router/send') return { result: { status: 'SUCCEEDED', payment_preimage: PRE, fee_msat: '0' } };
  if (p.startsWith('/v1/payments')) return { payments: [] };
  throw new Error('no mock for ' + p);
};
function call(pathname, method, body, headers) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); req.headers = headers || {};
    const res = { writeHead(code) { this.code = code; }, end(txt) { resolve({ code: this.code, json: JSON.parse(txt) }); } };
    D.handle(req, res, pathname, method, lnd);
  });
}
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('PASS ' + label); } else { fail++; console.log('FAIL ' + label); } }
async function newChit(n) {
  const nonce = (n + '').padStart(2, '0').repeat(32);
  const r = await call('/delegate/register', 'POST', { v: 1, issuer_pubkey: ISSUER, cap_msat: 100000, per_pay_cap_msat: 100000, count: 1, not_after: nowS() + 3600, nonce, sig: 'x'.repeat(40) });
  ok(r.json.ok === true && r.json.state === 'AWAITING_FUNDING', 'chit ' + n + ' registers');
  const s = await call('/delegate/slip/' + nonce, 'GET');
  ok(s.json.state === 'LIVE', 'chit ' + n + ' funded → LIVE');
  return nonce;
}
const SPEND_H = { 'x-delegate-secret': 'test-secret' };
function bill(extra) {
  invoiceDecode = Object.assign({ num_msat: '55000', payment_hash: HASH, description: 'Stout Coffee', destination: WALLET,
    payment_addr: Buffer.from(SECRET, 'hex').toString('base64'), cltv_expiry: '144', timestamp: String(nowS()), expiry: '3600',
    route_hints: [{ hop_hints: [{ node_id: OUR, chan_id: '123456789' }] }] }, extra || {});
}
(async () => {
  // (a) a bill for ANOTHER node: the old path, paid at once through LND
  let n = await newChit(1); bill({ destination: OTHER, route_hints: [] });
  let r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1other' }, SPEND_H);
  ok(r.code === 200 && r.json.ok === true && r.json.preimage === PRE, '(a) foreign bill pays now');
  // (b) same-LSP, wallet online with a channel with room: paid now
  n = await newChit(2); bill(); mock.online = true; mock.chan = { scid: '1', chan_id: '1', local_msat: 10000000n, active: true };
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1same' }, SPEND_H);
  ok(r.code === 200 && r.json.ok === true, '(b) same-LSP online with room pays now');
  // (c) same-LSP, wallet offline: HELD, wake sent, chit not charged
  n = await newChit(3); bill(); mock.online = false; mock.chan = { scid: '1', chan_id: '1', local_msat: 10000000n, active: true }; mock.wakes = [];
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1held' }, SPEND_H);
  ok(r.code === 202 && r.json.code === 'HELD' && r.json.held_until_ms > Date.now(), '(c) offline → HELD (202)');
  ok(mock.wakes.length === 1 && mock.wakes[0][0] === WALLET, '(c) one wake sent to the wallet');
  let s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'HELD' && s.json.spent_msat === 0 && s.json.last_bill.state === 'HELD' && s.json.last_bill.bolt11 === 'lnbc550n1held', '(c) slip shows HELD, nothing spent, last_bill matches the bolt11');
  r = await call('/delegate/void', 'POST', { nonce: n, sig: 'x'.repeat(40) });
  ok(r.code === 409 && r.json.code === 'HELD', '(c) void refused while HELD');
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1again' }, SPEND_H);
  ok(r.code === 410 && r.json.code === 'NOT_LIVE', '(c) a second spend while HELD is refused');
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'HELD' && s.json.held.tries === 0, '(c) tick while offline: no attempt');
  // (c') the wallet returns: delivered, settled with the bookkeeping of a spend
  mock.online = true; mock.deliver = async (a) => { ok(a.hashHex === HASH && a.secretHex === SECRET && a.amountMsat === '55000' && a.feeMsat === undefined, '(c\u2019) delivery asked with the bill\u2019s hash, secret, face; no fixed fee'); return { kind: 'attempt', attempt: { status: 'SUCCEEDED', preimage: Buffer.from(PRE, 'hex') }, innerMsat: '55000', feeMsat: 0n, chan: mock.chan }; };
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'SPENT' && s.json.spent_msat === 55000 && s.json.count_used === 1 && s.json.last_bill.state === 'SETTLED' && s.json.last_bill.preimage === PRE, '(c\u2019) wallet back → delivered → SPENT, 55,000 charged, preimage on last_bill');
  // (d) offline and never returns: the window runs out → FAILED, chit back to LIVE, untouched
  n = await newChit(4); bill(); mock.online = false; mock.holdMs = 40000;
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1late' }, SPEND_H);
  ok(r.code === 202, '(d) HELD with a 40 s window');
  mock.deliver = async () => { throw new Error('must not deliver after the window'); };
  await holdTick(Date.now() + 41000); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'LIVE' && s.json.spent_msat === 0 && s.json.count_used === 0 && /did not come online/.test(s.json.last_bill.error), '(d) window over → FAILED, chit LIVE and untouched');
  mock.online = true; await holdTick(Date.now() + 42000); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'LIVE', '(d) a wallet returning after the window gets nothing');
  mock.holdMs = 35000;
  n = await newChit(5); bill({ timestamp: String(nowS() - 3600 + 95), expiry: '3600' });   // the bill expires in 95 s → window = 95 − 60 = 35 s
  mock.online = false;
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1exp' }, SPEND_H);
  ok(r.code === 202 && r.json.held_until_ms - Date.now() <= 36000, '(e) window = min(wallet dial, invoice expiry − margin)');
  bill({ timestamp: String(nowS() - 3600 + 50), expiry: '3600' });   // expires in 50 s → window 0 → refused
  const n6 = await newChit(6);
  r = await call('/delegate/spend', 'POST', { nonce: n6, bill: 'lnbc550n1soon' }, SPEND_H);
  ok(r.code === 502 && r.json.code === 'PAY_FAILED' && /expires too soon/.test(r.json.error), '(e\u2019) a bill expiring too soon is refused, not held');
  s = await call('/delegate/slip/' + n6, 'GET'); ok(s.json.state === 'LIVE' && s.json.last_bill.state === 'FAILED', '(e\u2019) chit stays LIVE with last_bill FAILED');
  // (f) wallet returns but the HTLC fails temporarily: retry stays HELD; a permanent code fails it
  n = await newChit(7); bill(); mock.online = false; mock.holdMs = 180000;
  await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1temp' }, SPEND_H);
  mock.online = true; mock.deliver = async () => ({ kind: 'attempt', attempt: { status: 'FAILED', failure: { code: 'TEMPORARY_CHANNEL_FAILURE' } } });
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'HELD' && s.json.held.tries === 1, '(f) temporary failure: still HELD, one try');
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.held.tries === 1, '(f) no second try inside the retry spacing');
  mock.deliver = async () => ({ kind: 'attempt', attempt: { status: 'FAILED', failure: { code: 'INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS' } } });
  n = await newChit(8); bill(); mock.online = false;
  await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1perm' }, SPEND_H); mock.online = true;
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'LIVE' && s.json.last_bill.state === 'FAILED' && /refused/.test(s.json.last_bill.error), '(f\u2019) permanent refusal → FAILED, chit LIVE');
  // (g) LND owns the attempt: HELD → IN_FLIGHT for the janitor
  n = await newChit(9); bill(); mock.online = false;
  await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1inflight' }, SPEND_H); mock.online = true;
  mock.deliver = async () => ({ kind: 'attempt', attempt: { status: 'HARD_TIMEOUT', failure: { code: 'F3_HARD_TIMEOUT' } } });
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'IN_FLIGHT' && s.json.last_bill.state === 'IN_FLIGHT', '(g) hard timeout → IN_FLIGHT (janitor resolves)');
  // (h) JIT: no channel, a live promise → the promised fee rides as the fixed skim
  n = await newChit(10); bill(); mock.online = true; mock.chan = null; mock.promise = { fee_msat: '1000' };
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1jit' }, SPEND_H);
  ok(r.code === 202, '(h) online but no channel → HELD (JIT)');
  mock.deliver = async (a) => { ok(a.feeMsat === '1000', '(h) the promise\u2019s fee is the fixed skim'); return { kind: 'attempt', attempt: { status: 'SUCCEEDED', preimage: PRE }, innerMsat: '54000', feeMsat: 1000n, chan: { scid: '9' } }; };
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'SPENT' && s.json.spent_msat === 55000, '(h) delivered over the JIT channel; the chit pays the face');
  // (h') no channel and no promise: refused as lapsed
  n = await newChit(11); bill(); mock.online = false; mock.chan = null; mock.promise = null;
  await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1lapsed' }, SPEND_H); mock.online = true;
  mock.deliver = async () => { throw new Error('must not deliver without a promise'); };
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'LIVE' && /lapsed/.test(s.json.last_bill.error), '(h\u2019) no channel + no promise → FAILED (fresh bill needed)');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
