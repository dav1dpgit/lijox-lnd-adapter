// delegate-register-race.test.js — 0.113.1 (S63, Kimi round 2 F11): two concurrent /delegate/register with one nonce.
// Before: both passed the recGet check, both minted a funding invoice, the later recPut won — the first invoice, if
// paid, was orphaned. Now the register runs under withNonceLock: one mint; the second answers the stored invoice
// (repeat:true) when its digest is the same, 409 NONCE_EXISTS when it differs. Run: node delegate-register-race.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Readable } = require('stream');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-race-'));
process.env.DELEGATE_STORE_FILE = path.join(tmp, 'slips.json');
process.env.DELEGATE_SECRET = 'test-secret';
process.env.DELEGATE_BALANCE_CHECK = 'off';
process.env.DELEGATE_HOLD_TICK_MS = '3600000';
const D = require('./delegate.js');
const ISSUER = '03' + 'cc'.repeat(32);
const nowS = () => Math.floor(Date.now() / 1000);
let mints = 0;
const lnd = async (method, p, body) => {
  if (p === '/v1/verifymessage') return { valid: true, pubkey: ISSUER };
  if (p === '/v1/invoices') { mints += 1; await new Promise((r) => setTimeout(r, 60)); return { payment_request: 'lnbc1fund' + mints, r_hash: Buffer.from((mints + '').padStart(2, '0').repeat(32), 'hex').toString('base64') }; }
  if (p.startsWith('/v1/invoice/')) return { settled: false };
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
function ok(cond, label, extra) { if (cond) { pass++; console.log('PASS ' + label); } else { fail++; console.log('FAIL ' + label + (extra ? ' — ' + extra : '')); } }
(async () => {
  const nonce = '11'.repeat(32);
  const slip = { v: 1, issuer_pubkey: ISSUER, cap_msat: 100000, per_pay_cap_msat: 100000, count: 1, not_after: nowS() + 3600, nonce, sig: 'x'.repeat(40) };
  // (1) two at once, the same slip
  const [a, b] = await Promise.all([call('/delegate/register', 'POST', slip), call('/delegate/register', 'POST', slip)]);
  ok(a.code === 200 && a.json.ok === true && a.json.state === 'AWAITING_FUNDING', 'r1 the first register answers a funding invoice', JSON.stringify(a));
  ok(b.code === 200 && b.json.ok === true && b.json.repeat === true && b.json.funding_bolt11 === a.json.funding_bolt11, 'r2 the concurrent twin answers the SAME invoice, marked repeat', JSON.stringify(b));
  ok(mints === 1, 'r3 one funding invoice minted, not two (' + mints + ')');
  // (2) a later repeat, the same slip again
  const c = await call('/delegate/register', 'POST', slip);
  ok(c.code === 200 && c.json.repeat === true && c.json.funding_bolt11 === a.json.funding_bolt11 && mints === 1, 'r4 a later repeat with the same digest: the stored invoice, no new mint');
  // (3) the same nonce, a different slip
  const d = await call('/delegate/register', 'POST', Object.assign({}, slip, { cap_msat: 200000 }));
  ok(d.code === 409 && d.json.code === 'NONCE_EXISTS', 'r5 a different digest on a known nonce → 409 NONCE_EXISTS', JSON.stringify(d));
  // (4) another nonce still registers
  const e = await call('/delegate/register', 'POST', Object.assign({}, slip, { nonce: '22'.repeat(32) }));
  ok(e.code === 200 && e.json.ok === true && mints === 2, 'r6 another nonce registers and mints its own invoice');
  console.log((fail ? 'FAIL' : 'PASS') + ' · delegate-register-race (r1–r6) · ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
