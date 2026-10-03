// delegate-janitor.test.js — 0.88.0 (S54, DP 2026-10-02 "Fix all of these … Go."): the delegate janitor resolves an
// in-flight spend BY ITS OWN HASH and never frees a chit on doubt; in-flight and held spends count toward the daily
// breaker; the cap check reserves whole sats. Run: node delegate-janitor.test.js
//
// Part A drives the janitor through the module's own timer (its first sweep 1.5 s after the first request), so it runs
// against 0.87.0 too: there the chit is freed (the spend is not among LND's last 200 payments) — the attack.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Readable } = require('stream');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-jan-'));
const STORE = path.join(tmp, 'slips.json');
process.env.DELEGATE_STORE_FILE = STORE;
process.env.DELEGATE_SECRET = 'test-secret';
process.env.DELEGATE_BALANCE_CHECK = 'off';
process.env.DELEGATE_FEE_MARGIN_MSAT = '0';
process.env.DELEGATE_HOLD_TICK_MS = '3600000';
const MOD = process.env.DELEGATE_MODULE || './delegate.js';

const ISSUER = '03' + 'cc'.repeat(32), PAYEE = '02' + 'dd'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const hx = (i) => (i.toString(16).padStart(8, '0')).repeat(8);
const SPEND_HASH = 'ab'.repeat(32), PRE = 'ef'.repeat(32);

// ── an LND payment list that pages like LND's (reversed, index_offset, max_payments, creation_date_start) ──
let PAYS = [];             // ascending payment_index
let honourDateFilter = true, lndDown = false, pageCalls = 0;
function addPay(hash, status, createdS, extra) {
  PAYS.push(Object.assign({ payment_index: String(PAYS.length + 1), payment_hash: hash, status, creation_date: String(createdS),
    value_msat: '1000', fee_msat: '0', payment_preimage: status === 'SUCCEEDED' ? PRE : '' }, extra || {}));
}
function listPayments(q) {
  pageCalls++;
  if (lndDown) return { code: 14, message: 'connection refused' };
  const max = Number(q.get('max_payments') || 100), off = Number(q.get('index_offset') || 0);
  const start = honourDateFilter ? Number(q.get('creation_date_start') || 0) : 0;
  let pool = PAYS.filter((p) => Number(p.creation_date) >= start);
  if (off > 0) pool = pool.filter((p) => Number(p.payment_index) < off);
  const page = pool.slice(-max);
  return { payments: page.slice().reverse(), first_index_offset: page.length ? page[0].payment_index : '0',
    last_index_offset: page.length ? page[page.length - 1].payment_index : '0' };
}
let invoiceDecode = null, sendResult = null, routeFee = '0';
const lnd = async (method, p) => {
  if (p.startsWith('/v1/payments')) return listPayments(new URL('http://x' + p).searchParams);
  if (p.startsWith('/v1/payreq/')) return invoiceDecode;
  if (p === '/v1/verifymessage') return { valid: true, pubkey: ISSUER };
  if (p === '/v1/invoices') return { payment_request: 'lnbc1fund', r_hash: Buffer.from('11'.repeat(32), 'hex').toString('base64') };
  if (p.startsWith('/v1/invoice/')) return { settled: true };
  if (p.startsWith('/v1/graph/routes/')) return { routes: [{ total_fees_msat: routeFee }] };
  if (p.startsWith('/v1/graph/node/')) return { node: { alias: 'x' } };
  if (p === '/v2/router/send') { const r = sendResult; if (r instanceof Error) throw r; return r; }
  throw new Error('no mock for ' + p);
};
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('PASS ' + label); } else { fail++; console.log('FAIL ' + label); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Part A: the attack, through the module's own janitor timer (runs on 0.87.0 too) ──
const NONCE_A = 'a1'.repeat(32);
const created = now() - 3600;
fs.writeFileSync(STORE, JSON.stringify({ [NONCE_A]: {
  slip: { v: 1, issuer_pubkey: ISSUER, cap_msat: 100000, per_pay_cap_msat: 100000, count: 1, not_after: now() + 3600, nonce: NONCE_A },
  spent_msat: 0, count_used: 0, state: 'IN_FLIGHT', payments: [], claims: [], refunded_msat: 0, refund_state: 'NONE',
  created_ts: Date.now() - 3600e3, funded_ts: Date.now() - 3500e3,
  inflight: { payment_hash: SPEND_HASH, amount_msat: 90000, payee: 'runner', ts: Date.now() - 1800e3, bolt11: 'lnbc1runner' },   // no since_ms: a 0.87.0 record
} }));
addPay(SPEND_HASH, 'IN_FLIGHT', created + 60);                                   // the runner holds the HTLC
for (let i = 0; i < 250; i++) addPay(hx(i + 1), 'SUCCEEDED', created + 120 + i);  // 250 newer provider payments (Lightning-address deliveries)
const D = require(MOD);
function call(pathname, method, body, headers) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); req.headers = headers || {};
    const res = { writeHead(code) { this.code = code; }, end(txt) { resolve({ code: this.code, json: JSON.parse(txt) }); } };
    D.handle(req, res, pathname, method, lnd);
  });
}

(async () => {
  await call('/delegate/slip/' + NONCE_A, 'GET');   // the first request arms the janitor; its first sweep is 1.5 s later
  await sleep(2200);
  const sa = await call('/delegate/slip/' + NONCE_A, 'GET');
  ok(sa.json.state === 'IN_FLIGHT', 'A1 a spend still in flight but 250 payments back stays IN_FLIGHT — the chit is not freed (0.87.0 freed it: ' + sa.json.state + ')');
  const second = await call('/delegate/spend', 'POST', { nonce: NONCE_A, bill: 'lnbc1second' }, { 'x-delegate-secret': 'test-secret' });
  ok(second.json.code === 'NOT_LIVE', 'A2 a second bill on that chit is refused while the first is in flight');

  const T = D._test;
  if (!T || typeof T.janitorSweep !== 'function') { console.log('(Part B needs the 0.88.0 exports)'); console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }
  const store = T.storeLoad();

  // B1 the runner releases the first HTLC: the walk finds it SUCCEEDED and the chit is charged
  PAYS.find((p) => p.payment_hash === SPEND_HASH).status = 'SUCCEEDED';
  await T.janitorSweep(lnd);
  ok(store[NONCE_A].state === 'SPENT' && store[NONCE_A].spent_msat === 90000 && store[NONCE_A].count_used === 1, 'B1 the held spend settles 250 payments back: reconciled, charged 90,000 msat, SPENT');

  // a fresh in-flight record with since_ms (0.88.0 shape)
  function wedge(nonce, extra) {
    store[nonce] = Object.assign({
      slip: { v: 1, issuer_pubkey: ISSUER, cap_msat: 100000, per_pay_cap_msat: 100000, count: 2, not_after: now() + 3600, nonce },
      spent_msat: 0, count_used: 0, state: 'IN_FLIGHT', payments: [], claims: [], refunded_msat: 0, refund_state: 'NONE',
      created_ts: Date.now(), funded_ts: Date.now(),
    }, extra);
    T.recPut(nonce, store[nonce]);
  }
  // B2 absent — the complete walk since the spend began finds nothing: the pay call never reached LND → LIVE
  const NB2 = 'b2'.repeat(32);
  wedge(NB2, { inflight: { payment_hash: 'cd'.repeat(32), amount_msat: 1000, ts: Date.now() - 60e3, since_ms: Date.now() - 60e3, bolt11: 'lnbc1b2' } });
  pageCalls = 0;
  await T.janitorSweep(lnd);
  ok(store[NB2].state === 'LIVE' && !store[NB2].inflight, 'B2 no payment with that hash since the spend began → freed (the crash-before-the-call case)');
  ok(pageCalls <= 2, 'B2 the walk stopped at the spend\'s own start (' + pageCalls + ' page read(s)), not the whole history');

  // B3 the same, with an LND that ignores creation_date_start: the walk still stops on the entries' own dates
  honourDateFilter = false;
  const NB3 = 'b3'.repeat(32);
  for (let i = 0; i < 30; i++) addPay(hx(1000 + i), 'SUCCEEDED', now() - 30 + i);
  wedge(NB3, { inflight: { payment_hash: 'ce'.repeat(32), amount_msat: 1000, ts: Date.now() - 60e3, since_ms: Date.now() - 60e3, bolt11: 'lnbc1b3' } });
  await T.janitorSweep(lnd);
  ok(store[NB3].state === 'LIVE', 'B3 an LND without the date filter: still a definite answer (absent) → freed');
  honourDateFilter = true;

  // B4 LND unreachable: nothing decided
  const NB4 = 'b4'.repeat(32);
  wedge(NB4, { inflight: { payment_hash: 'cf'.repeat(32), amount_msat: 1000, ts: Date.now() - 60e3, since_ms: Date.now() - 60e3, bolt11: 'lnbc1b4' } });
  lndDown = true; await T.janitorSweep(lnd); lndDown = false;
  ok(store[NB4].state === 'IN_FLIGHT', 'B4 LND answers an error: the wedge stays (never freed on doubt)');

  // B5 a young wedge belongs to its own pay call: not touched
  const NB5 = 'b5'.repeat(32);
  wedge(NB5, { inflight: { payment_hash: 'd0'.repeat(32), amount_msat: 1000, ts: Date.now() - 5e3, since_ms: Date.now() - 5e3, bolt11: 'lnbc1b5' } });
  await T.janitorSweep(lnd);
  ok(store[NB5].state === 'IN_FLIGHT', 'B5 a wedge younger than 45 s is left to its own pay call');

  // B6 FAILED at LND → LIVE; B7 a record without its hash reads it from the stored bill
  const NB6 = 'b6'.repeat(32), H6 = 'd1'.repeat(32);
  addPay(H6, 'FAILED', now() - 10);
  wedge(NB6, { inflight: { payment_hash: '', amount_msat: 1000, ts: Date.now() - 60e3, since_ms: Date.now() - 60e3, bolt11: 'lnbc1b6' } });
  invoiceDecode = { payment_hash: H6 };
  await T.janitorSweep(lnd);
  ok(store[NB6].state === 'LIVE' && store[NB6].last_bill && store[NB6].last_bill.state === 'FAILED', 'B6/B7 a spend recorded without its hash: read from the bill, found FAILED → LIVE');

  // B8 a held delivery handed to the janitor: its LND payment is older than the hand-over (since_ms = when the hold began)
  const NB8 = 'b8'.repeat(32), H8 = 'd2'.repeat(32);
  addPay(H8, 'IN_FLIGHT', now() - 1200);
  for (let i = 0; i < 600; i++) addPay(hx(5000 + i), 'SUCCEEDED', now() - 1100 + i);
  wedge(NB8, { inflight: { payment_hash: H8, amount_msat: 1000, ts: Date.now() - 60e3, since_ms: Date.now() - 1300e3, bolt11: 'lnbc1b8' } });
  await T.janitorSweep(lnd);
  ok(store[NB8].state === 'IN_FLIGHT', 'B8 a held delivery 600 payments back, begun before the hand-over: found in flight, left');

  // B9 the lookup's own answers
  ok((await T.lookupPaymentByHash(lnd, 'zz', 0)).unknown !== undefined, 'B9 no valid hash → unknown');
  ok((await T.lookupPaymentByHash(lnd, H8, 0)).found.status === 'IN_FLIGHT', 'B9 since 0 walks the whole list and finds it');

  // C1 the daily breaker counts in-flight and held spends
  process.env.DELEGATE_DAILY_MSAT = String(T.dailySpentMsat() + 50000);
  const before = T.dailySpentMsat();
  store[NB8].inflight.amount_msat = 40000; T.recPut(NB8, store[NB8]);
  ok(T.dailySpentMsat() === before + 39000, 'C1 an in-flight spend counts toward the daily breaker (' + (T.dailySpentMsat() - before) + ' msat more)');
  delete process.env.DELEGATE_DAILY_MSAT;

  // C2 whole-sat rounding cannot pass a cap that is not whole sats
  const NC = 'c2'.repeat(32);
  const reg = await call('/delegate/register', 'POST', { v: 1, issuer_pubkey: ISSUER, cap_msat: 100500, per_pay_cap_msat: 100500, count: 1, not_after: now() + 3600, nonce: NC, sig: 'x'.repeat(40) });
  await call('/delegate/slip/' + NC, 'GET');
  invoiceDecode = { num_msat: '99000', payment_hash: 'd3'.repeat(32), description: 'shop', destination: PAYEE };
  routeFee = '1500';   // reserve = 1,500 msat (margin 0): 99,000 + 1,500 = 100,500 — fits unrounded, 101,000 rounded
  sendResult = { result: { status: 'SUCCEEDED', payment_preimage: PRE, fee_msat: '1500' } };
  const sp = await call('/delegate/spend', 'POST', { nonce: NC, bill: 'lnbc1c2' }, { 'x-delegate-secret': 'test-secret' });
  ok(reg.json.ok && sp.json.code === 'OVER_CAP', 'C2 a spend whose whole-sat charge would pass the cap is refused (0.87.0 paid it and charged 101,000 on a 100,500 cap)');
  ok(T.ceilSat(1) === 1000 && T.ceilSat(1000) === 1000 && T.ceilSat(1001) === 2000, 'C3 ceilSat');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
