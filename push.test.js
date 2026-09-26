// 0.82.0 (S49) — the Push Key rail against a fake LND: lock → locked, status, the same-provider claim
// (direct delivery, the sender's hold settled by the recipient's preimage), void (node-key signature),
// the window's end (returned), the cross-provider claim (the recipient's provider mints and delivers)
// and delivery (the holder pays the far invoice, keeps fee − spent), the guards, boot resume.
//   0.83.0: receivability first — /push/receivable, a claim refused before anything is minted or paid
//   (cannot_receive + reason), a delivery-time burn's end_code at /push/claim-status, the holder's codes.
//   node push.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPushRail, VOID_DOMAIN } = require('./push.js');

let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const check = (cond, m) => { if (cond) ok(m); else { failed++; console.log('  ✗ ' + m); } };

// ── a fake clock and timers ──
let clock = 1_790_000_000_000;
const pending = [];
const timers = { set: (fn, ms) => { const t = { fn, at: clock + ms, id: pending.length + 1 }; pending.push(t); return t; }, clear: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); } };
async function advance(ms) {
  const until = clock + ms;
  for (;;) {
    const due = pending.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    clock = Math.max(clock, due.at);
    pending.splice(pending.indexOf(due), 1);
    await due.fn();
  }
  clock = until;
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));   // let the async deliveries the ticks started finish
}

// ── a fake LND: invoices by hash, a far invoice table, payments ──
const invoices = {};   // hash → { state, amt_paid_msat, cltv, value_msat }
const farInvoices = {}; // bolt11 → { payment_hash, num_msat, destination, preimage, fee_msat, fail }
const payments = [];
let keyDenies = new Set();   // 0.83.1: RPCs the fake key lacks → LND's permission body
const PERM = { code: 2, message: 'permission denied', details: [] };
const LOCAL = '03' + '11'.repeat(32);
const FAR = '02' + '22'.repeat(32);
const lnd = {
  async get(p) {
    if (p.startsWith('/v1/payreq/') && keyDenies.has('DecodePayReq')) return PERM;
    if (p.startsWith('/v1/payments') && keyDenies.has('ListPayments')) return PERM;
    if (p.startsWith('/v1/payreq/lnbc1probe')) return { code: 2, message: 'checksum failed. Expected 3z2fua, got 1probe' };
    if (p.startsWith('/v1/invoice/')) { const h = p.slice('/v1/invoice/'.length); return invoices[h] ? { state: invoices[h].state, amt_paid_msat: invoices[h].amt_paid_msat, payment_request: 'lnbc-hold-' + h.slice(0, 8), expiry: invoices[h].expiry } : { code: 5, message: 'unable to locate invoice' }; }
    if (p.startsWith('/v1/payreq/')) { const b = decodeURIComponent(p.slice('/v1/payreq/'.length)); const f = farInvoices[b]; return f ? { payment_hash: f.payment_hash, num_msat: String(f.num_msat), destination: f.destination } : { code: 2, message: 'checksum failed' }; }
    if (p.startsWith('/v1/payments')) return { payments };
    throw new Error('unexpected GET ' + p);
  },
  async post(p, body) {
    if (p === '/v2/invoices/hodl') { const h = Buffer.from(body.hash, 'base64').toString('hex'); if (invoices[h]) return { code: 6, message: 'invoice with payment hash already exists' }; invoices[h] = { state: 'OPEN', value_msat: body.value_msat, cltv: Number(body.cltv_expiry), hints: (body.route_hints || []).length, expiry: Number(body.expiry) }; return { payment_request: 'lnbc-hold-' + h.slice(0, 8) + (body.route_hints ? '-h' : '') }; }
    if (p === '/v2/invoices/settle') { const pre = Buffer.from(body.preimage, 'base64').toString('hex'); const h = crypto.createHash('sha256').update(Buffer.from(pre, 'hex')).digest('hex'); if (!invoices[h] || invoices[h].state !== 'ACCEPTED') return { code: 5, message: 'invoice not accepted' }; invoices[h].state = 'SETTLED'; return {}; }
    if (p === '/v2/invoices/cancel') { const h = Buffer.from(body.payment_hash, 'base64').toString('hex'); if (invoices[h]) invoices[h].state = 'CANCELED'; return {}; }
    if (p === '/v1/verifymessage' && keyDenies.has('VerifyMessage')) return PERM;
    if (p === '/v2/router/send' && keyDenies.has('SendPaymentV2')) return { error: { grpc_code: 7, http_code: 403, message: 'permission denied' } };   // a streaming route wraps it
    if (p === '/v1/verifymessage' && body.msg === '' && body.signature === '') return { code: 2, message: 'signature required' };
    if (p === '/v2/router/send' && !body.payment_request) return { error: { grpc_code: 3, message: 'payment request or destination required' } };
    if (p === '/v1/verifymessage') { const s = String(body.signature); return s.startsWith('sig:') ? { valid: true, pubkey: s.slice(4) } : { valid: false, pubkey: '' }; }
    if (p === '/v2/router/send') {
      const f = farInvoices[body.payment_request]; if (!f) return { result: { status: 'FAILED', failure_reason: 'FAILURE_REASON_NO_ROUTE' } };
      if (f.fail) return { result: { status: 'FAILED', failure_reason: f.fail } };
      if (f.hang) return new Promise(() => {});
      if (Number(f.fee_msat) > Number(body.fee_limit_msat)) return { result: { status: 'FAILED', failure_reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE' } };
      payments.push({ payment_hash: f.payment_hash, status: 'SUCCEEDED', payment_preimage: f.preimage, fee_msat: String(f.fee_msat) });
      return { result: { status: 'SUCCEEDED', payment_preimage: f.preimage, fee_msat: String(f.fee_msat) } };
    }
    throw new Error('unexpected POST ' + p);
  },
};
const delivered = [];   // deliverToWallet calls
const walletPreimage = {};   // hash → preimage the wallet would claim with
const pl = [];
const connected = new Set();
let rxAnswer = { ok: true, mode: 'channel', fee_msat: '0', receivable_msat: '50000000', min_msat: '1000' };   // 0.83.0: the fake deliverToWallet law
const rxAsked = [];
let refuseNext = null;   // 0.83.0: make the fake deliverToWallet refuse once (a delivery-time change)
const innerFail = {};   // 0.84.0: hash → { tries, answer } — the fake deliverToWallet's attempt answer for that hash
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
const deps = {
  dataDir: dir, lndGet: lnd.get, lndPost: lnd.post,
  deliverToWallet: async ({ client, hashHex, secretHex, amountMsat }) => {
    if (refuseNext) { const why = refuseNext; refuseNext = null; return { kind: 'refuse', reason: why }; }
    if (innerFail[hashHex]) { innerFail[hashHex].tries++; return innerFail[hashHex].answer; }
    delivered.push({ client, hashHex, secretHex, amountMsat: String(amountMsat) });
    const pre = walletPreimage[hashHex];
    if (!pre) return { kind: 'attempt', attempt: { status: 'FAILED', failure: { code: 'INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS' } } };
    return { kind: 'attempt', attempt: { status: 'SUCCEEDED', preimage: pre }, innerMsat: String(amountMsat), feeMsat: 0n, chan: {} };
  },
  isPeerConnected: async (pk) => connected.has(pk),
  sendWakePush: async () => {}, authOk: (req) => req.headers['x-adapter-secret'] === 'tok',
  buildPublicHints: async () => [{ hop_hints: [{ node_id: FAR }] }],
  plRecord: (kind, f) => pl.push({ kind, ...f }), leaseTouch: () => {}, touchWalletActive: () => {},
  localPubkey: () => LOCAL, log: () => {}, env: {}, now: () => clock, timers,
  walletReceivable: async (pk, msat) => { rxAsked.push({ pk, msat: String(msat) }); return rxAnswer; },
};
const rail = createPushRail(deps);
const call = async (method, pathname, body, auth = true) => {
  let out = null;
  const res = {}; const req = { headers: auth ? { 'x-adapter-secret': 'tok' } : {}, url: pathname };   // 0.83.0: the query rides req.url, the path is bare (as the adapter hands it)
  await rail.handle(req, res, pathname.split('?')[0], method, '1.2.3.4', async () => body, (r, data, status) => { out = { data, status: status || 200 }; });
  return out;
};
const pair = (seed) => { const pre = crypto.createHash('sha256').update('pre:' + seed).digest('hex'); return { pre, hash: crypto.createHash('sha256').update(Buffer.from(pre, 'hex')).digest('hex') }; };
const SENDER = '02' + 'aa'.repeat(32), RECIP = '02' + 'bb'.repeat(32), SECRET = 'cd'.repeat(32);
const nowS = () => Math.floor(clock / 1000);

(async () => {
  // ── fee and blocks ──
  check(rail.feeMsat(20_000_000) === 41_000, 'fee: 1 sat base + 0.2% of 20,000 sats = 41 sats');
  check(rail.feeMsat(1000) === 1000 + 2, 'fee floor: base + ceil(ppm) for a tiny amount');
  check(rail.blocksFor(72 * 3600) === 472, '72 h = 432 blocks + 40 margin = 472');

  // ── 0. the quote ──
  {
    let out = null; const res = {}; const req = { headers: {}, url: '/push/quote?amount_sats=20000' };
    await rail.handle(req, res, '/push/quote', 'GET', '1.2.3.4', async () => ({}), (r, data, status) => { out = { data, status: status || 200 }; });
    check(out.status === 200 && out.data.ok && out.data.fee_msat === '41000' && out.data.total_msat === '20041000' && out.data.cltv_expiry === 472, 'quote: 20,000 sats → fee 41 sats, total 20,041, cltv 472');
  }

  // ── 1. LOCK → locked ──
  const A = pair('A');
  let r = await call('POST', '/push/lock', { client_pubkey: SENDER, hash: A.hash, amount_sats: 20000, expiry: nowS() + 72 * 3600 });
  check(r.status === 200 && r.data.ok && r.data.bolt11 && r.data.total_msat === '20041000' && r.data.cltv_expiry === 472 && r.data.holder === LOCAL, 'lock: a hold invoice for amount + fee, cltv 472, the holder named');
  check(invoices[A.hash] && invoices[A.hash].cltv === 472 && invoices[A.hash].value_msat === '20041000', 'the hold invoice minted on the hash with the right value and timelock');
  await advance(300);
  check(rail._reg().out[A.hash].status === 'minted', 'unpaid: still minted');
  invoices[A.hash].state = 'ACCEPTED'; invoices[A.hash].amt_paid_msat = '20041000';
  await advance(4000);
  check(rail._reg().out[A.hash].status === 'locked', 'the sender paid → LOCKED');
  r = await call('GET', '/push/status/' + A.hash, null, false);
  check(r.status === 200 && r.data.status === 'locked' && r.data.amount_sats === 20000 && r.data.fee_sats === 41 && r.data.holder === LOCAL, 'status (public): locked, 20,000 sats, fee 41');
  r = await call('POST', '/push/lock', { client_pubkey: SENDER, hash: A.hash, amount_sats: 20000, expiry: nowS() + 3600 });
  check(r.status === 409, 'the same hash cannot be locked twice');
  r = await call('POST', '/push/lock', { client_pubkey: SENDER, hash: pair('X').hash, amount_sats: 20000, expiry: nowS() + 72 * 3600 }, false);
  check(r.status === 401, 'lock needs the route token');
  r = await call('POST', '/push/lock', { client_pubkey: SENDER, hash: pair('Y').hash, amount_sats: 20000, expiry: nowS() + 8 * 24 * 3600 });
  check(r.status === 400, 'a window past a week is refused');
  r = await call('POST', '/push/lock', { client_pubkey: SENDER, hash: pair('Z').hash, amount_sats: 10, expiry: nowS() + 3600 });
  check(r.status === 400, 'an amount under the floor is refused');

  // ── 2. same-provider CLAIM → direct delivery → taken ──
  walletPreimage[A.hash] = A.pre; connected.add(RECIP);
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: A.hash, secret: SECRET });
  check(r.status === 200 && r.data.ok && r.data.mode === 'direct' && r.data.status === 'taken', 'claim on the holding provider: delivered directly, TAKEN');
  check(delivered.length === 1 && delivered[0].client === RECIP && delivered[0].hashHex === A.hash && delivered[0].secretHex === SECRET && delivered[0].amountMsat === '20000000', 'one delivery of exactly the amount (the fee stays with the provider)');
  check(invoices[A.hash].state === 'SETTLED', 'the sender\'s hold settled with the recipient\'s preimage');
  check(pl.some((e) => e.kind === 'push_fee' && e.msat === 41000 && e.moved_msat === 20000000), 'PL: the fee kept (41 sats), 20,000 moved');
  r = await call('GET', '/push/status/' + A.hash, null, false);
  check(r.data.status === 'taken' && r.data.taken_at, 'status: taken');
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: A.hash, secret: SECRET });
  check(r.status === 409 && r.data.status === 'taken', 'a second claim of a taken push is refused');

  // ── 3. VOID ──
  const B = pair('B');
  await call('POST', '/push/lock', { client_pubkey: SENDER, hash: B.hash, amount_sats: 5000, expiry: nowS() + 72 * 3600 });
  invoices[B.hash].state = 'ACCEPTED'; await advance(4000);
  check(rail._reg().out[B.hash].status === 'locked', 'B locked');
  r = await call('POST', '/push/void', { client_pubkey: SENDER, hash: B.hash, ts: nowS(), signature: 'sig:' + RECIP }, false);
  check(r.status === 401, 'void: a signature by another key is refused');
  r = await call('POST', '/push/void', { client_pubkey: SENDER, hash: B.hash, ts: nowS() - 5000, signature: 'sig:' + SENDER }, false);
  check(r.status === 400, 'void: a stale ts is refused');
  r = await call('POST', '/push/void', { client_pubkey: SENDER, hash: B.hash, ts: nowS(), signature: 'sig:' + SENDER }, false);
  check(r.status === 200 && r.data.status === 'void' && invoices[B.hash].state === 'CANCELED', 'void: the sender\'s own signature cancels the hold — VOID');
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: B.hash, secret: SECRET });
  check(r.status === 409 && r.data.status === 'void', 'a voided push cannot be claimed');
  r = await call('POST', '/push/void', { client_pubkey: SENDER, hash: A.hash, ts: nowS(), signature: 'sig:' + SENDER }, false);
  check(r.status === 409, 'a taken push cannot be voided');

  // ── 4. the window's end → returned ──
  const C = pair('C');
  await call('POST', '/push/lock', { client_pubkey: SENDER, hash: C.hash, amount_sats: 3000, expiry: nowS() + 3600 });
  invoices[C.hash].state = 'ACCEPTED'; await advance(4000);
  check(rail._reg().out[C.hash].status === 'locked', 'C locked');
  await advance(3600 * 1000 + 5000);
  check(rail._reg().out[C.hash].status === 'returned' && invoices[C.hash].state === 'CANCELED', 'the window over: the hold cancelled — RETURNED to the sender');
  r = await call('GET', '/push/status/' + C.hash, null, false);
  check(r.data.status === 'returned' && /nobody brought the key/.test(r.data.end_reason), 'status says why');

  // ── 5. an unpaid lock dies ──
  const D = pair('D');
  await call('POST', '/push/lock', { client_pubkey: SENDER, hash: D.hash, amount_sats: 3000, expiry: nowS() + 3600 });
  await advance(26 * 60 * 1000);
  check(rail._reg().out[D.hash].status === 'unpaid', 'a lock nobody paid within 25 minutes → unpaid');

  // ── 6. cross-provider: this box as the RECIPIENT's provider ──
  const E = pair('E');
  walletPreimage[E.hash] = E.pre;
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: E.hash, secret: SECRET, amount_sats: 7000, expiry: nowS() + 3600, holder_prefix: FAR.slice(0, 16) });
  check(r.status === 200 && r.data.ok && r.data.mode === 'invoice' && /^lnbc-hold-/.test(r.data.bolt11) && r.data.holder_prefix === FAR.slice(0, 16), 'claim from another provider: a hold invoice on the hash for the exact amount');
  check(invoices[E.hash] && invoices[E.hash].value_msat === '7000000' && invoices[E.hash].cltv === 144 && invoices[E.hash].hints === 1, 'the claim invoice: the amount, cltv 144, a public hint');
  const again = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: E.hash, secret: SECRET, amount_sats: 7000, expiry: nowS() + 3600, holder_prefix: FAR.slice(0, 16) });
  check(again.data.bolt11 === r.data.bolt11, 'asked twice: the same invoice');
  invoices[E.hash].state = 'ACCEPTED'; invoices[E.hash].amt_paid_msat = '7000000';
  await advance(4000);
  check(rail._reg().in[E.hash].status === 'settled' && invoices[E.hash].state === 'SETTLED', 'the holder paid → delivered to the wallet → the claim invoice settled with the wallet\'s preimage');
  check(delivered.some((d) => d.hashHex === E.hash && d.amountMsat === '7000000'), 'the delivery carried the exact amount');

  // ── 7. cross-provider: this box as the HOLDER ──
  const F = pair('F');
  await call('POST', '/push/lock', { client_pubkey: SENDER, hash: F.hash, amount_sats: 9000, expiry: nowS() + 72 * 3600 });
  invoices[F.hash].state = 'ACCEPTED'; await advance(4000);
  farInvoices['lnfar-F'] = { payment_hash: F.hash, num_msat: 9_000_000, destination: FAR, preimage: F.pre, fee_msat: 9000 };
  farInvoices['lnfar-F-wrongamt'] = { payment_hash: F.hash, num_msat: 8_000_000, destination: FAR, preimage: F.pre, fee_msat: 9000 };
  farInvoices['lnfar-other'] = { payment_hash: pair('G').hash, num_msat: 9_000_000, destination: FAR, preimage: pair('G').pre, fee_msat: 1 };
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: F.hash, bolt11: 'lnfar-other' });
  check(r.status === 409 && /not for this Push Key/.test(r.data.reason), 'deliver: an invoice for another hash is refused');
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: F.hash, bolt11: 'lnfar-F-wrongamt' });
  check(r.status === 409 && /asks 8000000/.test(r.data.reason), 'deliver: an invoice for the wrong amount is refused');
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: F.hash, bolt11: 'lnfar-F' });
  check(r.status === 200 && r.data.ok && r.data.status === 'taken' && r.data.fee_spent_msat === 9000, 'deliver: the far invoice paid within the fee, the hold settled — TAKEN');
  check(invoices[F.hash].state === 'SETTLED' && rail._reg().out[F.hash].fee_spent_msat === 9000, 'the sender\'s hold settled with the preimage that came back; fee spent recorded');
  const feeKept = pl.find((e) => e.kind === 'push_fee' && e.hash === F.hash);
  check(feeKept && feeKept.msat === rail.feeMsat(9_000_000) - 9000, 'PL: fee kept = quoted − spent');

  // a delivery that fails leaves the push locked for another try
  const H = pair('H');
  await call('POST', '/push/lock', { client_pubkey: SENDER, hash: H.hash, amount_sats: 9000, expiry: nowS() + 72 * 3600 });
  invoices[H.hash].state = 'ACCEPTED'; await advance(4000);
  farInvoices['lnfar-H-fail'] = { payment_hash: H.hash, num_msat: 9_000_000, destination: FAR, preimage: H.pre, fee_msat: 1, fail: 'FAILURE_REASON_NO_ROUTE' };
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: H.hash, bolt11: 'lnfar-H-fail' });
  check(r.status === 409 && /delivery failed/.test(r.data.reason) && rail._reg().out[H.hash].status === 'locked', 'a failed delivery: still locked, the recipient may try again');
  farInvoices['lnfar-H-dear'] = { payment_hash: H.hash, num_msat: 9_000_000, destination: FAR, preimage: H.pre, fee_msat: 999_999 };
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: H.hash, bolt11: 'lnfar-H-dear' });
  check(r.status === 409 && rail._reg().out[H.hash].status === 'locked', 'a route dearer than the quoted fee is refused by LND; still locked');
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: H.hash, bolt11: 'lnfar-H-fail' }, false);
  check(r.status === 401, 'deliver needs the route token');

  // ── 7b. 0.83.0: receivability first ──
  r = await call('GET', '/push/receivable?client_pubkey=' + RECIP + '&amount_sats=7000');
  check(r.status === 200 && r.data.ok && r.data.can_receive === true && r.data.mode === 'channel' && r.data.fee_msat === '0' && r.data.amount_msat === '7000000', 'receivable: the wallet can take 7,000 sats in full');
  r = await call('GET', '/push/receivable?client_pubkey=' + RECIP + '&amount_sats=7000', null, false);
  check(r.status === 401, 'receivable needs the route token');
  rxAnswer = { ok: false, reason: 'under_open_fee', fee_msat: '2100000', receivable_msat: '300000', min_msat: '3100000' };
  const J = pair('J');
  const before = rxAsked.length;
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: J.hash, secret: SECRET, amount_sats: 1000, expiry: nowS() + 3600, holder_prefix: FAR.slice(0, 16) });
  check(r.status === 409 && r.data.error === 'cannot_receive' && r.data.reason === 'under_open_fee' && r.data.fee_msat === '2100000' && r.data.receivable_msat === '300000' && r.data.min_msat === '3100000', 'a claim the wallet cannot take: refused with the reason, the fee, the room and the floor');
  check(!invoices[J.hash] && !rail._reg().in[J.hash] && rxAsked.length === before + 1 && rxAsked[before].msat === '1000000', 'NOTHING minted and no record — the holder is never asked to pay');
  r = await call('GET', '/push/receivable?client_pubkey=' + RECIP + '&amount_sats=1000');
  check(r.status === 200 && r.data.can_receive === false && r.data.reason === 'under_open_fee', 'receivable says the same before the tap');
  // the same-provider claim asks first too
  const K = pair('K');
  await call('POST', '/push/lock', { client_pubkey: SENDER, hash: K.hash, amount_sats: 1000, expiry: nowS() + 72 * 3600 });
  invoices[K.hash].state = 'ACCEPTED'; await advance(4000);
  walletPreimage[K.hash] = K.pre; const dBefore = delivered.length;
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: K.hash, secret: SECRET });
  check(r.status === 409 && r.data.error === 'cannot_receive' && r.data.reason === 'under_open_fee' && delivered.length === dBefore && rail._reg().out[K.hash].status === 'locked', 'direct claim the wallet cannot take: refused before any delivery; the push stays locked for a bigger wallet');
  rxAnswer = { ok: true, mode: 'open', fee_msat: '2100000', receivable_msat: '0', min_msat: '3100000', delivered_msat: '4900000' };
  r = await call('GET', '/push/receivable?client_pubkey=' + RECIP + '&amount_sats=7000');
  check(r.status === 200 && r.data.can_receive === true && r.data.mode === 'open' && r.data.fee_msat === '2100000', 'receivable: no room → a channel opens, the fee named');
  // a delivery-time change of heart: the claim was minted, the holder paid, then deliverToWallet refuses → BURNED with a code
  rxAnswer = { ok: true, mode: 'channel', fee_msat: '0', receivable_msat: '50000000', min_msat: '1000' };
  const L = pair('L'); walletPreimage[L.hash] = L.pre;
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: L.hash, secret: SECRET, amount_sats: 7000, expiry: nowS() + 3600, holder_prefix: FAR.slice(0, 16) });
  check(r.status === 200 && r.data.ok && r.data.rx_mode === 'channel' && r.data.open_fee_msat === '0', 'claim minted; the answer names the mode and the fee');
  refuseNext = 'amount under opening fee';
  invoices[L.hash].state = 'ACCEPTED'; invoices[L.hash].amt_paid_msat = '7000000';
  await advance(4000);
  check(rail._reg().in[L.hash].status === 'burned' && rail._reg().in[L.hash].end_code === 'under_open_fee' && invoices[L.hash].state === 'CANCELED', 'refused at delivery time: BURNED with end_code under_open_fee, the claim invoice cancelled');
  r = await call('GET', '/push/claim-status/' + L.hash + '?client_pubkey=' + RECIP);
  check(r.status === 200 && r.data.ok && r.data.status === 'burned' && r.data.end_code === 'under_open_fee' && /opening fee/.test(r.data.end_reason), 'claim-status: the claimant reads its own provider\'s reason');
  r = await call('GET', '/push/claim-status/' + L.hash + '?client_pubkey=' + SENDER);
  check(r.status === 403, 'claim-status: another wallet is refused');
  r = await call('GET', '/push/claim-status/' + L.hash + '?client_pubkey=' + RECIP, null, false);
  check(r.status === 401, 'claim-status needs the route token');
  // the holder's codes
  const M = pair('M');
  await call('POST', '/push/lock', { client_pubkey: SENDER, hash: M.hash, amount_sats: 9000, expiry: nowS() + 72 * 3600 });
  invoices[M.hash].state = 'ACCEPTED'; await advance(4000);
  farInvoices['lnfar-M-refused'] = { payment_hash: M.hash, num_msat: 9_000_000, destination: FAR, preimage: M.pre, fee_msat: 1, fail: 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS' };
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: M.hash, bolt11: 'lnfar-M-refused' });
  check(r.status === 409 && r.data.code === 'recipient_refused' && /INCORRECT_PAYMENT_DETAILS/.test(r.data.reason), 'deliver: the far provider stopped accepting → code recipient_refused beside LND\'s reason');
  r = await call('GET', '/push/status/' + M.hash);
  check(r.status === 200 && r.data.status === 'locked' && r.data.last_deliver_code === 'recipient_refused', 'status: the last delivery code rides for the sender');
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: M.hash, bolt11: 'lnfar-H-fail' });
  check(r.status === 409 && /not for this Push Key/.test(r.data.reason), '(guard still first: another hash\'s invoice refused)');

  // ── 7c. 0.83.1: the holder's key ──
  let miss = await rail.probeKey();
  check(miss.length === 0 && rail.capability.cross_provider === true, 'key probe: a full key → cross_provider true');
  r = await call('GET', '/push/quote?amount_sats=5000');
  check(r.data.cross_provider === true, 'the quote says cross_provider true');
  keyDenies = new Set(['DecodePayReq', 'SendPaymentV2', 'ListPayments', 'VerifyMessage']);
  miss = await rail.probeKey();
  check(miss.length === 4 && rail.capability.cross_provider === false && rail.capability.missing_rpcs.includes('/routerrpc.Router/SendPaymentV2'), 'key probe: the delegate-free key → cross_provider false, the four URIs named — got ' + JSON.stringify(miss));
  r = await call('GET', '/push/quote?amount_sats=5000');
  check(r.data.cross_provider === false, 'the quote says cross_provider false');
  const N = pair('N');
  r = await call('POST', '/push/lock', { client_pubkey: SENDER, hash: N.hash, amount_sats: 9000, expiry: nowS() + 72 * 3600 });
  check(r.status === 200 && r.data.cross_provider === false, 'a lock on such a key still works (same-provider) and says cross_provider false');
  invoices[N.hash].state = 'ACCEPTED'; await advance(4000);
  farInvoices['lnfar-N'] = { payment_hash: N.hash, num_msat: 9_000_000, destination: FAR, preimage: N.pre, fee_msat: 1 };
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: N.hash, bolt11: 'lnfar-N' });
  check(r.status === 409 && r.data.code === 'holder_key' && /DecodePayReq/.test(r.data.reason) && rail._reg().out[N.hash].status === 'locked', 'deliver on such a key: holder_key with the RPC named (was "invoice unreadable"); still locked');
  r = await call('POST', '/push/void', { client_pubkey: SENDER, hash: N.hash, ts: nowS(), signature: 'sig:' + SENDER });
  check(r.status === 503 && r.data.error === 'holder_key' && /VerifyMessage/.test(r.data.reason), 'void on such a key: holder_key with the RPC named');
  keyDenies = new Set(['SendPaymentV2']);
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: N.hash, bolt11: 'lnfar-N' });
  check(r.status === 409 && r.data.code === 'holder_key' && /SendPaymentV2/.test(r.data.reason) && rail._reg().out[N.hash].status === 'locked' && !rail._reg().out[N.hash].deliver_inflight_at, 'a key that reads but cannot pay: holder_key naming SendPaymentV2; not left in flight');
  keyDenies = new Set();
  await rail.probeKey();
  r = await call('POST', '/push/deliver', { client_pubkey: RECIP, hash: N.hash, bolt11: 'lnfar-N' });
  check(r.status === 200 && r.data.ok && r.data.status === 'taken' && rail.capability.cross_provider === true, 'after the re-bake: the same push delivers — TAKEN');

  // ── 7d. 0.83.2: a claim invoice lives as long as the key; a retry reuses it; an expired one says so ──
  const Q = pair('Q'); walletPreimage[Q.hash] = Q.pre;
  const qExp = nowS() + 36 * 3600;
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: Q.hash, secret: SECRET, amount_sats: 7000, expiry: qExp, holder_prefix: FAR.slice(0, 16) });
  check(r.status === 200 && r.data.ok && invoices[Q.hash].expiry === 36 * 3600 + 600, 'the claim invoice\'s expiry = the key\'s remaining window + 10 min (was 20 min)');
  await advance(26 * 60 * 1000);
  check(rail._reg().in[Q.hash].status === 'reserved' && rail._reg().in[Q.hash].idle_at && invoices[Q.hash].state === 'OPEN', 'the holder did not pay in 25 min: idle, still reserved, the invoice still OPEN (was burned)');
  const q2 = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: Q.hash, secret: SECRET, amount_sats: 7000, expiry: qExp, holder_prefix: FAR.slice(0, 16) });
  check(q2.status === 200 && q2.data.bolt11 === r.data.bolt11 && !rail._reg().in[Q.hash].idle_at, 'a retry re-arms the claim and reuses the OPEN invoice');
  invoices[Q.hash].state = 'ACCEPTED'; invoices[Q.hash].amt_paid_msat = '7000000'; await advance(4000);
  check(rail._reg().in[Q.hash].status === 'settled' && invoices[Q.hash].state === 'SETTLED', 'then the holder pays → delivered and settled');
  const S = pair('S'); walletPreimage[S.hash] = S.pre;
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: S.hash, secret: SECRET, amount_sats: 7000, expiry: nowS() + 3600, holder_prefix: FAR.slice(0, 16) });
  invoices[S.hash].state = 'CANCELED';   // LND expired it
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: S.hash, secret: SECRET, amount_sats: 7000, expiry: nowS() + 3600, holder_prefix: FAR.slice(0, 16) });
  check(r.status === 409 && r.data.error === 'claim_expired' && /new key/.test(r.data.reason) && rail._reg().in[S.hash].status === 'burned' && rail._reg().in[S.hash].end_code === 'claim_expired', 'an expired claim invoice: claim_expired with the plain reason (was a 500 at mint)');
  const T = pair('T'); invoices[T.hash] = { state: 'CANCELED', expiry: 1200 };   // a hash LND holds from before the record existed
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: T.hash, secret: SECRET, amount_sats: 7000, expiry: nowS() + 3600, holder_prefix: FAR.slice(0, 16) });
  check(r.status === 409 && r.data.error === 'claim_expired', 'a hash LND already holds cancelled, with no record: claim_expired, nothing minted');

  // ── 7e. 0.84.0: our own link refuses the HTLC (no room after all) → three tries, then no_room ──
  const U = pair('U');   // no walletPreimage → the fake deliverToWallet fails; make it a TEMPORARY_CHANNEL_FAILURE from our link
  innerFail[U.hash] = { tries: 0, answer: { kind: 'attempt', attempt: { status: 'FAILED', failure: { code: 'TEMPORARY_CHANNEL_FAILURE', failure_source_index: 0 } } } };
  r = await call('POST', '/push/claim', { client_pubkey: RECIP, hash: U.hash, secret: SECRET, amount_sats: 1000, expiry: nowS() + 3600, holder_prefix: FAR.slice(0, 16) });
  invoices[U.hash].state = 'ACCEPTED'; invoices[U.hash].amt_paid_msat = '1000000';
  await advance(30000);
  check(innerFail[U.hash].tries === 3 && rail._reg().in[U.hash].status === 'burned' && rail._reg().in[U.hash].end_code === 'no_room' && invoices[U.hash].state === 'CANCELED', 'our link refused three times → BURNED no_room, the claim invoice cancelled (the holder\'s payment fails back) — tries ' + innerFail[U.hash].tries);
  r = await call('GET', '/push/claim-status/' + U.hash + '?client_pubkey=' + RECIP);
  check(r.data.end_code === 'no_room' && /refused the HTLC 3 times/.test(r.data.end_reason), 'claim-status carries no_room');

  // ── 8. boot resume ──
  const I = pair('I');
  await call('POST', '/push/lock', { client_pubkey: SENDER, hash: I.hash, amount_sats: 4000, expiry: nowS() + 72 * 3600 });
  invoices[I.hash].state = 'ACCEPTED'; await advance(4000);
  const rail2 = createPushRail(deps);
  const n = rail2.bootResume();
  check(n === 4 && rail2._reg().out[I.hash].status === 'locked' && rail2._reg().out[H.hash].status === 'locked' && rail2._reg().out[K.hash].status === 'locked' && rail2._reg().out[M.hash].status === 'locked', 'a fresh process resumes the four open locks, H, I, K and M (settled, void, returned, unpaid, burned, taken ones stay put) — got ' + n);
  const s = rail.summary();
  check(s.locked === 4 && s.taken === 3 && s.returned === 2 && s.claims_open === 0, 'summary: 4 locked (H, I, K, M), 3 taken (A, F, N), 2 returned/void (B, C), no open claims — got ' + JSON.stringify(s));
  check(rail.capability.holder === true && rail.settings().fee_ppm === 2000, 'capability and settings exposed');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
