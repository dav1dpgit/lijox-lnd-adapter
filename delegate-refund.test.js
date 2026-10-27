// delegate-refund.test.js — 0.114.0 (S63, Kimi round 2 F19): the chit refund is ONE refund for the whole remainder, and
// the routing fee it costs counts against the chit. Before: a 1-msat refund invoice was paid with the 50-sat fee
// allowance, uncounted — an issuer could drain the fee allowance remainder-many times. Run: node delegate-refund.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Readable } = require('stream');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-refund-'));
process.env.DELEGATE_STORE_FILE = path.join(tmp, 'slips.json');
process.env.DELEGATE_SECRET = 'test-secret';
process.env.DELEGATE_BALANCE_CHECK = 'off';
process.env.DELEGATE_HOLD_TICK_MS = '3600000';
const D = require('./delegate.js');
const ISSUER = '03' + 'cc'.repeat(32);
const nowS = () => Math.floor(Date.now() / 1000);
const invoices = {};   // bolt11 → { num_msat, destination, hash }
const pays = [];       // what the fake LND was asked to pay
let payAnswer = () => ({ payment_preimage: 'ab'.repeat(32), payment_route: { total_fees_msat: '1200' } });
const lnd = async (method, p, body) => {
  if (p === '/v1/verifymessage') return { valid: true, pubkey: ISSUER };
  if (p.startsWith('/v1/payreq/')) { const b = decodeURIComponent(p.slice('/v1/payreq/'.length)); const inv = invoices[b]; if (!inv) return { code: 2, message: 'checksum failed' }; return { destination: inv.destination, num_msat: String(inv.num_msat), num_satoshis: String(Math.floor(inv.num_msat / 1000)), payment_hash: inv.hash }; }
  if (p === '/v1/channels/transactions') { pays.push(body); return payAnswer(body); }
  throw new Error('no mock for ' + p);
};
function call(pathname, method, body) {
  return new Promise((resolve) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]); req.headers = {};
    const res = { writeHead(code) { this.code = code; }, end(txt) { resolve({ code: this.code, json: JSON.parse(txt) }); } };
    D.handle(req, res, pathname, method, lnd);
  });
}
let pass = 0, fail = 0;
function ok(cond, label, extra) { if (cond) { pass++; console.log('PASS ' + label); } else { fail++; console.log('FAIL ' + label + (extra ? ' — ' + extra : '')); } }
function closedChit(nonce, capMsat, spentMsat) {
  D._test.recPut(nonce, { slip: { v: 1, issuer_pubkey: ISSUER, cap_msat: capMsat, per_pay_cap_msat: capMsat, count: 3, not_after: nowS() - 10, nonce },
    spent_msat: spentMsat, count_used: 1, state: 'EXPIRED', payments: [], claims: [], refunded_msat: 0, refund_state: 'OWED', created_ts: Date.now() - 100000, funded_ts: Date.now() - 90000,
    funding: { bolt11: 'lnbcfund', hash: '11'.repeat(32), amount_msat: capMsat, minted_ts: Date.now() - 100000 } });
}
(async () => {
  // a closed, funded chit: cap 100,000 msat, 40,000 spent → 60,000 owed
  const N1 = 'a1'.repeat(32); closedChit(N1, 100000, 40000);
  invoices['lnbc1part'] = { num_msat: 30000, destination: ISSUER, hash: 'd1'.repeat(32) };
  invoices['lnbc1over'] = { num_msat: 70000, destination: ISSUER, hash: 'd2'.repeat(32) };
  invoices['lnbc1whole'] = { num_msat: 60000, destination: ISSUER, hash: 'd3'.repeat(32) };
  invoices['lnbc1open'] = { num_msat: 0, destination: ISSUER, hash: 'd4'.repeat(32) };
  // (1) a part-refund invoice is refused, nothing paid
  let r = await call('/delegate/refund', 'POST', { nonce: N1, bolt11: 'lnbc1part', sig: 'x' });
  ok(r.code === 400 && r.json.code === 'PARTIAL_REFUND' && r.json.owed_msat === 60000 && pays.length === 0, 'r1 a 30,000-msat invoice against 60,000 owed → 400 PARTIAL_REFUND, nothing paid', JSON.stringify(r));
  // (2) an over-refund stays refused
  r = await call('/delegate/refund', 'POST', { nonce: N1, bolt11: 'lnbc1over', sig: 'x' });
  ok(r.code === 400 && r.json.code === 'OVER_REFUND' && pays.length === 0, 'r2 a 70,000-msat invoice → 400 OVER_REFUND (kept)', JSON.stringify(r));
  // (3) the whole remainder: paid, and the fee counted
  r = await call('/delegate/refund', 'POST', { nonce: N1, bolt11: 'lnbc1whole', sig: 'x' });
  let rec = D._test.storeLoad()[N1];
  ok(r.code === 200 && r.json.ok === true && r.json.refunded_msat === 60000 && r.json.fee_msat === 1200 && r.json.remaining_owed_msat === 0, 'r3 the whole remainder → 200, refunded 60,000, the 1,200-msat routing fee named, nothing left', JSON.stringify(r));
  ok(pays.length === 1 && pays[0].payment_request === 'lnbc1whole' && pays[0].amt_msat === undefined, 'r4 one payment of the invoice as it is (no amt override on an amount invoice)');
  ok(rec.refund_state === 'PAID' && rec.refunded_msat === 61200 && rec.refund_fee_msat === 1200, 'r5 the record: PAID, refunded_msat 61,200 (remainder + fee), refund_fee_msat 1,200', JSON.stringify({ s: rec.refund_state, r: rec.refunded_msat, f: rec.refund_fee_msat }));
  // (4) nothing more can be drawn
  r = await call('/delegate/refund', 'POST', { nonce: N1, bolt11: 'lnbc1open', sig: 'x' });
  ok(r.code === 409 && r.json.code === 'NOTHING_OWED' && pays.length === 1, 'r6 a second refund on the paid chit → 409 NOTHING_OWED');
  // (5) an amountless invoice on another chit pays the remainder with amt_msat; a fee bigger than the remainder's room still closes it
  const N2 = 'b2'.repeat(32); closedChit(N2, 50000, 25000);
  payAnswer = () => ({ payment_preimage: 'cd'.repeat(32), payment_route: { total_fees_msat: '900' } });
  r = await call('/delegate/refund', 'POST', { nonce: N2, bolt11: 'lnbc1open', sig: 'x' });
  rec = D._test.storeLoad()[N2];
  ok(r.code === 200 && r.json.refunded_msat === 25000 && r.json.fee_msat === 900 && pays.length === 2 && pays[1].amt_msat === '25000' && rec.refund_state === 'PAID' && rec.refunded_msat === 25900, 'r7 an amountless invoice: the remainder (25,000) sent as amt_msat, the fee (900) counted, PAID', JSON.stringify(r));
  // (6) a failed payment leaves the chit OWED with nothing counted; the next try pays
  const N3 = 'c3'.repeat(32); closedChit(N3, 80000, 10000);
  invoices['lnbc1whole70'] = { num_msat: 70000, destination: ISSUER, hash: 'd5'.repeat(32) };
  payAnswer = () => ({ payment_error: 'insufficient_balance' });
  r = await call('/delegate/refund', 'POST', { nonce: N3, bolt11: 'lnbc1whole70', sig: 'x' });
  rec = D._test.storeLoad()[N3];
  ok(r.code === 502 && r.json.code === 'REFUND_FAILED' && rec.refund_state === 'OWED' && rec.refunded_msat === 0, 'r8 a failed payment → 502 REFUND_FAILED, still OWED, nothing counted', JSON.stringify(r));
  payAnswer = () => ({ payment_preimage: 'ef'.repeat(32), fee_msat: '300' });
  r = await call('/delegate/refund', 'POST', { nonce: N3, bolt11: 'lnbc1whole70', sig: 'x' });
  rec = D._test.storeLoad()[N3];
  ok(r.code === 200 && r.json.fee_msat === 300 && rec.refund_state === 'PAID' && rec.refunded_msat === 70300, 'r9 the retry pays; a flat fee_msat answer counts too (70,000 + 300)', JSON.stringify(r));
  console.log((fail ? 'FAIL' : 'PASS') + ' · delegate-refund (r1–r9) · ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
