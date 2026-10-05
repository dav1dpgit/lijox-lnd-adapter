// delegate-own-lnurl.test.js — 0.91.0 (S55, DP 2026-10-04 "Go", item 1): a chit paying THIS LSP's own Lightning-address
// invoice (the address rail's hold invoice — payee = this node, no hint naming it). Before 0.91.0 the rail sent it to
// LND as a self-payment, which LND refuses; the chit sat "outcome not yet known" for the janitor. Now the pay code is
// taken (LND's invoice cancelled, the watcher let go) and the hold rail's one delivery pays the wallet that owns it.
// LND and the adapter's delivery are mocked. Run: node delegate-own-lnurl.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Readable } = require('stream');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-own-'));
process.env.DELEGATE_STORE_FILE = path.join(tmp, 'slips.json');
process.env.DELEGATE_SECRET = 'test-secret';
process.env.DELEGATE_BALANCE_CHECK = 'off';
process.env.DELEGATE_HOLD_TICK_MS = '3600000';   // ticks are explicit here
const D = require('./delegate.js');
const { holdTick } = D._test;

const OUR = '03' + 'aa'.repeat(32), WALLET = '02' + 'bb'.repeat(32), ISSUER = '03' + 'cc'.repeat(32);
const HASH = 'ab'.repeat(32), ENTRY_SECRET = 'cd'.repeat(32), INVOICE_SECRET = '99'.repeat(32), PRE = 'ef'.repeat(32);
const nowS = () => Math.floor(Date.now() / 1000);
const mock = { online: true, chan: null, deliver: null, wakes: [], holdMs: 180000, entry: null, takes: [], done: [], takeOk: true, sends: 0 };
D.setHooks({
  ourPubkey: () => OUR,
  isPeerConnected: async () => mock.online,
  walletChannel: async () => mock.chan,
  deliverToWallet: async (a) => mock.deliver(a),
  sendWakePush: async (pk, ms) => { mock.wakes.push([pk, ms]); },
  holdCapMs: () => mock.holdMs,
  promiseForScid: () => null,
  permanentCodes: () => new Set(['INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS']),
  plRecord: () => {}, leaseTouch: () => {},
  lnurlpOwnEntry: (h) => (mock.entry && h === HASH ? { name: 'shop', client: WALLET, secret: ENTRY_SECRET, status: mock.entry, amount_msat: '55000' } : null),
  lnurlpTakeForChit: async (h, tag) => { mock.takes.push([h, tag]); if (!mock.takeOk) return false; mock.entry = 'chit'; return true; },
  lnurlpChitDone: (h, ok, why) => { mock.done.push([h, ok, why]); },
});
let invoiceDecode = null;
const lnd = async (method, p) => {
  if (p.startsWith('/v1/payreq/')) return invoiceDecode;
  if (p === '/v1/verifymessage') return { valid: true, pubkey: ISSUER };
  if (p === '/v1/invoices') return { payment_request: 'lnbc1fund', r_hash: Buffer.from('11'.repeat(32), 'hex').toString('base64') };
  if (p.startsWith('/v1/invoice/')) return { settled: true };
  if (p.startsWith('/v1/graph/routes/')) return { routes: [{ total_fees_msat: '0' }] };
  if (p.startsWith('/v1/graph/node/')) return { node: { alias: '' } };
  if (p === '/v2/router/send') { mock.sends += 1; return { error: { code: 2, message: 'no self-payments allowed' } }; }   // LND's answer to paying itself
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
  await call('/delegate/register', 'POST', { v: 1, issuer_pubkey: ISSUER, cap_msat: 100000, per_pay_cap_msat: 100000, count: 1, not_after: nowS() + 3600, nonce, sig: 'x'.repeat(40) });
  const s = await call('/delegate/slip/' + nonce, 'GET');
  if (s.json.state !== 'LIVE') throw new Error('chit ' + n + ' did not fund');
  return nonce;
}
const SPEND_H = { 'x-delegate-secret': 'test-secret' };
// The address rail's own invoice, as LND mints it: payee = this node, a description hash, hints through a public peer.
function ownInvoice(extra) {
  invoiceDecode = Object.assign({ num_msat: '55000', payment_hash: HASH, description: '', description_hash: 'aa', destination: OUR,
    payment_addr: Buffer.from(INVOICE_SECRET, 'hex').toString('base64'), cltv_expiry: '144', timestamp: String(nowS()), expiry: '1200',
    route_hints: [{ hop_hints: [{ node_id: '02' + 'ee'.repeat(32), chan_id: '777' }] }] }, extra || {});
}
function reset() { mock.wakes = []; mock.takes = []; mock.done = []; mock.takeOk = true; mock.sends = 0; mock.entry = 'reserved'; mock.holdMs = 180000; }
const delivered = (seen) => async (a) => { seen.push(a); return { kind: 'attempt', attempt: { status: 'SUCCEEDED', preimage: Buffer.from(PRE, 'hex') }, innerMsat: a.amountMsat, feeMsat: 0n, chan: mock.chan }; };

(async () => {
  // (a) the wallet is here with room: paid inside the request — never a self-payment
  reset(); let n = await newChit(1); ownInvoice(); mock.online = true; mock.chan = { scid: '1', chan_id: '1', room_msat: 10000000n, active: true };
  let seen = []; mock.deliver = delivered(seen);
  let r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1own' }, SPEND_H);
  ok(r.code === 200 && r.json.ok === true && r.json.preimage === PRE && r.json.state === 'SPENT', '(a) own invoice, wallet here: 200 settled in the same request');
  ok(mock.sends === 0, '(a) LND was never asked to pay its own invoice');
  ok(seen.length === 1 && seen[0].client === WALLET && seen[0].hashHex === HASH && seen[0].secretHex === ENTRY_SECRET && seen[0].amountMsat === '55000' && seen[0].feeMsat === undefined,
    '(a) delivered to the pay code’s owner with the ENTRY’s secret (not the invoice’s), the face, no fixed fee');
  ok(seen[0] && Number(seen[0].finalCltvDelta) <= 80, '(a) the address rail’s final CLTV (80), not the hold invoice’s 144 + 3');
  ok(mock.takes.length === 1 && mock.takes[0][0] === HASH, '(a) the pay code was taken (LND’s invoice cancelled) once');
  ok(mock.done.length === 1 && mock.done[0][1] === true, '(a) the entry is told: settled');
  ok(mock.wakes.length === 0, '(a) no wake to a wallet that is here');
  let s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.spent_msat === 55000 && s.json.count_used === 1 && s.json.last_bill.state === 'SETTLED' && s.json.last_bill.bolt11 === 'lnbc550n1own', '(a) the chit pays the face; last_bill names the bill the page sent');

  // (b) the wallet is asleep: held and woken (after the take), delivered when it returns
  reset(); n = await newChit(2); ownInvoice(); mock.online = false; mock.chan = { scid: '1', chan_id: '1', room_msat: 10000000n, active: true };
  mock.deliver = async () => { throw new Error('must not deliver while asleep'); };
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1asleep' }, SPEND_H);
  ok(r.code === 202 && r.json.code === 'HELD', '(b) asleep: HELD (202)');
  ok(mock.takes.length === 1 && mock.wakes.length === 1 && mock.wakes[0][0] === WALLET, '(b) taken, then ONE wake to the owner');
  ok(mock.wakes[0][1] > 170000 && mock.wakes[0][1] <= 180000, '(b) the wake states the wallet’s own window (no invoice clock: LND’s invoice is cancelled)');
  seen = []; mock.online = true; mock.deliver = delivered(seen);
  await holdTick(); s = await call('/delegate/slip/' + n, 'GET');
  ok(s.json.state === 'SPENT' && seen.length === 1 && seen[0].secretHex === ENTRY_SECRET, '(b) the wallet returns: delivered, SPENT');
  ok(mock.done.length === 1 && mock.done[0][1] === true && mock.sends === 0, '(b) entry settled; no self-payment');

  // (c) no channel: not "lapsed" — the address rail's own JIT decides (the delivery opens by the fee law)
  reset(); n = await newChit(3); ownInvoice(); mock.online = true; mock.chan = null;
  seen = []; mock.deliver = async (a) => { seen.push(a); return { kind: 'attempt', attempt: { status: 'SUCCEEDED', preimage: PRE }, innerMsat: '45000', feeMsat: 10000n, chan: { scid: '9' } }; };
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1jit' }, SPEND_H);
  ok(r.code === 200 && r.json.state === 'SPENT', '(c) no channel: delivered over a JIT open, settled');
  ok(seen.length === 1 && seen[0].feeMsat === undefined, '(c) no fixed fee handed over — the delivery charges the open by its law');
  s = await call('/delegate/slip/' + n, 'GET'); ok(s.json.spent_msat === 55000, '(c) the chit pays the face; the open fee comes out of what the wallet gets');

  // (d) the wallet's hold dial is Off, but it is here: paid now (Off refuses WAITING, not paying)
  reset(); n = await newChit(4); ownInvoice(); mock.online = true; mock.chan = { scid: '1', chan_id: '1', room_msat: 10000000n, active: true }; mock.holdMs = 0;
  seen = []; mock.deliver = delivered(seen);
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1off' }, SPEND_H);
  ok(r.code === 200 && r.json.ok === true, '(d) dial Off, wallet here: paid');

  // (e) dial Off and asleep: refused BEFORE the take — the shop's code is left intact
  reset(); n = await newChit(5); ownInvoice(); mock.online = false; mock.holdMs = 0;
  mock.deliver = async () => { throw new Error('must not deliver'); };
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1offasleep' }, SPEND_H);
  ok(r.code === 502 && /no waiting window/.test(r.json.error), '(e) dial Off and asleep: refused');
  ok(mock.takes.length === 0 && mock.wakes.length === 0, '(e) nothing taken, no wake — the pay code still works for another payer');
  s = await call('/delegate/slip/' + n, 'GET'); ok(s.json.state === 'LIVE' && s.json.spent_msat === 0, '(e) the chit untouched');

  // (f) the code was paid by someone else between the decode and the take: refused, chit LIVE
  reset(); n = await newChit(6); ownInvoice(); mock.online = true; mock.takeOk = false;
  mock.deliver = async () => { throw new Error('must not deliver'); };
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1race' }, SPEND_H);
  ok(r.code === 502 && /paid or withdrawn meanwhile/.test(r.json.error), '(f) the take failed: refused in words');
  s = await call('/delegate/slip/' + n, 'GET'); ok(s.json.state === 'LIVE' && s.json.spent_msat === 0 && s.json.last_bill.state === 'FAILED', '(f) the chit LIVE, last_bill FAILED');

  // (g) an own entry already paid ('accepted'): the bill is refused at the decode — nothing taken, nothing sent
  reset(); n = await newChit(7); ownInvoice(); mock.entry = 'accepted';
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1paid' }, SPEND_H);
  ok(r.code === 400 && r.json.code === 'BAD_BILL' && /already paid or withdrawn/.test(r.json.error) && mock.takes.length === 0 && mock.sends === 0, '(g) an already-paid code: BAD_BILL, nothing taken');

  // (h) any other invoice this node issued (not a pay code): refused plainly, never a self-payment
  reset(); n = await newChit(8); ownInvoice({ payment_hash: '12'.repeat(32) });
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1ownother' }, SPEND_H);
  ok(r.code === 400 && r.json.code === 'BAD_BILL' && /cannot pay an invoice it issued itself/.test(r.json.error) && mock.sends === 0, '(h) another own invoice: BAD_BILL, LND not asked');

  // (i) the wallet refuses the payment (permanent): chit LIVE, the entry told to burn
  reset(); n = await newChit(9); ownInvoice(); mock.online = true; mock.chan = { scid: '1', chan_id: '1', room_msat: 10000000n, active: true };
  mock.deliver = async () => ({ kind: 'attempt', attempt: { status: 'FAILED', failure: { code: 'INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS' } } });
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1refused' }, SPEND_H);
  ok(r.code === 502 && r.json.code === 'PAY_FAILED' && /refused/.test(r.json.error), '(i) the wallet refused: PAY_FAILED in the same request');
  s = await call('/delegate/slip/' + n, 'GET'); ok(s.json.state === 'LIVE' && s.json.spent_msat === 0, '(i) the chit untouched');
  ok(mock.done.length === 1 && mock.done[0][1] === false, '(i) the entry is told: burned');

  // (j) a temporary miss while here: stays HELD, the tick retries (no answer pretends it is settled)
  reset(); n = await newChit(10); ownInvoice(); mock.online = true; mock.chan = { scid: '1', chan_id: '1', room_msat: 10000000n, active: true };
  mock.deliver = async () => ({ kind: 'attempt', attempt: { status: 'FAILED', failure: { code: 'TEMPORARY_CHANNEL_FAILURE' } } });
  r = await call('/delegate/spend', 'POST', { nonce: n, bill: 'lnbc550n1temp' }, SPEND_H);
  ok(r.code === 202 && r.json.code === 'HELD', '(j) a temporary miss: HELD (202), retried by the tick');
  s = await call('/delegate/slip/' + n, 'GET'); ok(s.json.state === 'HELD' && s.json.held.tries === 1, '(j) one try counted');

  // (k) a wallet-signed bill on this LSP (0.78.0's case) is unchanged: online with room → LND pays it
  reset(); n = await newChit(11); mock.entry = null; mock.online = true;
  invoiceDecode = Object.assign({}, invoiceDecode, { destination: WALLET, payment_hash: '34'.repeat(32), route_hints: [{ hop_hints: [{ node_id: OUR, chan_id: '123' }] }] });
  const lndOk = async (m, p, b) => (p === '/v2/router/send' ? (mock.sends += 1, { result: { status: 'SUCCEEDED', payment_preimage: PRE, fee_msat: '0' } }) : lnd(m, p, b));
  r = await new Promise((resolve) => { const req = Readable.from([JSON.stringify({ nonce: n, bill: 'lnbc550n1wallet' })]); req.headers = SPEND_H;
    D.handle(req, { writeHead(c) { this.code = c; }, end(t) { resolve({ code: this.code, json: JSON.parse(t) }); } }, '/delegate/spend', 'POST', lndOk); });
  ok(r.code === 200 && mock.sends === 1 && mock.takes.length === 0, '(k) a wallet-signed same-LSP bill still pays through LND (0.78.0 unchanged)');

  // (l) lij-adapter.js's half, read from the source: the take and the end of a pay code's entry
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
  const fn = (name) => { const i = src.indexOf((src.includes('async function ' + name + '(') ? 'async function ' : 'function ') + name + '(');
    let d = 0, k = src.indexOf('{', i); for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) break; } return src.slice(i, k + 1); };
  const ctx = { console: { log() {}, warn() {} }, Buffer, Date, String, Object, Number, cancels: [], stops: [], persists: 0, order: [] };
  ctx.lnurlpRegistry = { shop: { client_pubkey: WALLET, entries: [{ hash: HASH, secret: ENTRY_SECRET, status: 'reserved', amount_msat: '55000' }, { hash: '56'.repeat(32), secret: ENTRY_SECRET, status: 'accepted' }] } };
  ctx.lnurlpStopWatch = (h) => { ctx.stops.push(h); ctx.order.push('stop'); };
  ctx.lnurlpPersist = () => { ctx.persists++; ctx.order.push('persist:' + ctx.lnurlpRegistry.shop.entries[0].status); };
  ctx.lndPost = async (p, b) => { ctx.cancels.push([p, b]); ctx.order.push('cancel'); return {}; };
  vm.createContext(ctx);
  vm.runInContext(['lnurlpEntryByHash', 'lnurlpOwnEntry', 'lnurlpTakeForChit', 'lnurlpChitDone'].map(fn).join('\n') + '\nthis.F = { lnurlpOwnEntry, lnurlpTakeForChit, lnurlpChitDone };', ctx);
  const F = ctx.F, E = ctx.lnurlpRegistry.shop.entries;
  const own = F.lnurlpOwnEntry(HASH.toUpperCase());
  ok(own && own.client === WALLET && own.secret === ENTRY_SECRET && own.status === 'reserved' && own.name === 'shop', '(l) the pay code\u2019s entry by hash (any case): owner, secret, status');
  ok(F.lnurlpOwnEntry('78'.repeat(32)) === null && F.lnurlpOwnEntry('nothex') === null, '(l) an unknown hash is no pay code');
  ok((await F.lnurlpTakeForChit('56'.repeat(32), 't')) === false && ctx.cancels.length === 0, '(l) a paid (accepted) entry cannot be taken');
  ok((await F.lnurlpTakeForChit(HASH, 'delegate 01010101')) === true && E[0].status === 'chit' && E[0].chit === 'delegate 01010101', '(l) a reserved entry is taken: status chit');
  ok(ctx.order.join(',') === 'stop,persist:chit,cancel', '(l) order: the watcher stops and \u2018chit\u2019 is written BEFORE LND\u2019s invoice is cancelled');
  ok(ctx.cancels[0][0] === '/v2/invoices/cancel' && ctx.cancels[0][1].payment_hash === Buffer.from(HASH, 'hex').toString('base64'), '(l) LND cancels that invoice (base64 hash)');
  ok((await F.lnurlpTakeForChit(HASH, 'again')) === false, '(l) taken once only');
  F.lnurlpChitDone(HASH, true); ok(E[0].status === 'settled' && E[0].settled_by === 'chit', '(l) delivered: settled by the chit');
  F.lnurlpChitDone(HASH, false, 'x'); ok(E[0].status === 'settled', '(l) an end is written once (a settled entry is not burned after)');
  E[0].status = 'chit'; F.lnurlpChitDone(HASH, false, 'the shop\u2019s wallet refused'); ok(E[0].status === 'burned' && /^chit: /.test(E[0].burn_reason), '(l) not delivered: burned, with the reason');
  ok(/entry\.status !== 'burned' && entry\.status !== 'chit'/.test(src), '(l) the address watcher never turns a chit\u2019s cancel into a burn');
  ok(/\(e\.status === 'accepted' \|\| e\.status === 'chit'\) \? 'pending'/.test(src), '(l) /v1/outcome reports a chit-taken hash as pending');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
