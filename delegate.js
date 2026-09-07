// delegate.js — DELEGATE PAYMENT for LiJ/LIJOX (the LSP half). v0.2.4
// PREPAY: the issuer funds the slip before it goes LIVE, so the LSP is
// never owed anything and never has to trust an issuer. Whatever is not
// spent is owed BACK to the issuer at close. This is custody with the
// LSP for the life of the slip — a trusted arrangement, not a
// cryptographic lock, and the wallet tells the user so in plain words.
//
// Fresh implementation from delegate-module-v0.md (the FROZEN slip
// contract: LIJOX-delegate-v1 digest, field order fixed) adapted to this
// adapter's raw-http router. The Session-25 review is applied:
//   - register/void SELF-AUTHENTICATE via the slip's node-key signature
//     (the wallet holds no adapter secret); /delegate/spend requires
//     DELEGATE_SECRET — a Page-scoped key, NEVER the master adapter
//     secret.
//   - routing fees count against the cap: amount + fee-limit is reserved
//     at flight time; the ACTUAL fee is charged at settle.
//   - the balance check reads the ISSUER'S side of her channels (sum of
//     remote_balance where remote_pubkey == issuer) — her sats, not the
//     LSP's pocket.
//   - PILOT SETTLEMENT (DP-ruled): the LSP fronts from its own
//     liquidity; the stake-at-register leg is the designed v1.5.
//   - v1 digest carries NO LSP identity (frozen contract; single-LSP
//     world today). Ledgered gap; a v2 digest adds it.
//
// Isolation contract: the adapter touches this module at exactly one
// router branch (+ one require). Disable = comment the branch.

'use strict';

const fs = require('fs');
const crypto = require('crypto');

// ── config (env, all DELEGATE_* — new keys only) ──────────────────────
const CFG = {
  SLIP_MAX_MSAT: () => Number(process.env.DELEGATE_SLIP_MAX_MSAT || 150000000),
  DAILY_MSAT: () => Number(process.env.DELEGATE_DAILY_MSAT || 1000000000),
  MAX_LIVE: () => Number(process.env.DELEGATE_MAX_LIVE || 100),
  FEE_LIMIT_MSAT: () => Number(process.env.DELEGATE_FEE_LIMIT_MSAT || 50000),
  // 0.64.0 (S42, DP GO): the spend's fee reserve is what the route actually
  // costs (LND QueryRoutes) + FEE_MARGIN, never a flat 50 sats; no quote =>
  // proportional floor max(FEE_FLOOR_MSAT, bill x FEE_FLOOR_PPM). FEE_LIMIT_MSAT
  // stays the refund path's ceiling and the sanity ceiling on the reserve.
  FEE_MARGIN_MSAT: () => Number(process.env.DELEGATE_FEE_MARGIN_MSAT || 2000),
  FEE_FLOOR_MSAT: () => Number(process.env.DELEGATE_FEE_FLOOR_MSAT || 3000),
  FEE_FLOOR_PPM: () => Number(process.env.DELEGATE_FEE_FLOOR_PPM || 10000),
  ENABLED: () => String(process.env.DELEGATE_ENABLED || '1') !== '0',
  SPEND_TIMEOUT_S: () => Number(process.env.DELEGATE_SPEND_TIMEOUT_S || 12),
  MAX_HORIZON_S: () => Number(process.env.DELEGATE_MAX_HORIZON_S || 86400),
  SECRET: () => process.env.DELEGATE_SECRET || '',
  BALANCE_CHECK: () => (process.env.DELEGATE_BALANCE_CHECK || 'on') !== 'off',
  STORE_FILE: () => process.env.DELEGATE_STORE_FILE
    || require('path').join(process.env.LIJ_DATA_DIR || __dirname, 'delegate-slips.json'),  // v0.47 (D1 seed): data-dir root, no operator path
};

// ── store: flat-file nonce ledger, flush on every transition ─────────
let MEM = null;
function storeLoad() {
  if (MEM !== null) return MEM;
  try { MEM = JSON.parse(fs.readFileSync(CFG.STORE_FILE(), 'utf8')); }
  catch (e) { MEM = {}; }
  return MEM;
}
function storeFlush() {
  try { fs.writeFileSync(CFG.STORE_FILE(), JSON.stringify(MEM)); }
  catch (e) { console.log('[delegate] store flush FAILED:', e.message); }
}
function recGet(nonce) {
  const m = storeLoad();
  const r = m[nonce] || null;
  if (r && r.state === 'LIVE' && nowS() >= r.slip.not_after) {
    r.state = 'EXPIRED'; storeFlush(); // lazy janitor
  }
  return r;
}
function recPut(nonce, rec) { storeLoad()[nonce] = rec; storeFlush(); }
function countLive() {
  return Object.values(storeLoad())
    .filter(r => r.state === 'LIVE' || r.state === 'IN_FLIGHT').length;
}
function dailySpentMsat() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let sum = 0;
  for (const r of Object.values(storeLoad())) {
    for (const p of (r.payments || [])) {
      if (p.ts >= cutoff) sum += (p.amount_msat + (p.fee_msat || 0));
    }
  }
  return sum;
}

// ── per-nonce serialization (single-node adapter: in-process lock) ───
const LOCKS = new Map();
function withNonceLock(nonce, fn) {
  const prev = LOCKS.get(nonce) || Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of prior outcome
  LOCKS.set(nonce, next.catch(() => {}));
  return next;
}

// ── the frozen digest (byte-for-byte per lij-make-a-run-spec-v0) ─────
function slipDigest(s) {
  return 'LIJOX-delegate-v1\n'
    + 'v=' + s.v + '\n'
    + 'issuer_pubkey=' + s.issuer_pubkey + '\n'
    + 'cap_msat=' + s.cap_msat + '\n'
    + 'per_pay_cap_msat=' + s.per_pay_cap_msat + '\n'
    + 'count=' + s.count + '\n'
    + 'not_after=' + s.not_after + '\n'
    + 'nonce=' + s.nonce;
}
function voidDigest(nonce) {
  return 'LIJOX-delegate-void-v1\n' + 'nonce=' + nonce;
}

// ── helpers ───────────────────────────────────────────────────────────
function nowS() { return Math.floor(Date.now() / 1000); }
function j(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 65536) { reject(new Error('body too large')); try { req.destroy(); } catch (e) {} } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('invalid_json')); } });
    req.on('error', reject);
  });
}
async function verifySig(lndRequest, message, signature) {
  const r = await lndRequest('POST', '/v1/verifymessage', {
    msg: Buffer.from(message, 'utf8').toString('base64'),
    signature: String(signature || ''),
  });
  // S26 fix (BAD_SIG on DP's first live register): LND's `valid` is
  // GRAPH MEMBERSHIP — rpcserver.go runs RecoverCompact (which both
  // validates the signature AND recovers the pubkey), then sets
  // Valid = graph.HasNode(recovered). Every LiJ wallet is a PRIVATE
  // node (unannounced channels), never in the graph, so `valid` is
  // false for every honest issuer. An invalid signature returns NO
  // pubkey at all — so recovered-pubkey EQUALITY (checked by the
  // callers) is the complete proof. graph bit kept for logs only.
  // v0.1.2 (S26): lndRequest resolves ANY status, so an LND ERROR BODY
  // ({code,message} — permission denied, unavailable, macaroon fault)
  // arrives here carrying no pubkey and would read to the callers as
  // "signature didn't recover" == BAD_SIG. That mask cost two days of
  // debugging. Infrastructure faults THROW (callers -> 503
  // VERIFY_UNAVAILABLE); a merely-invalid signature still returns no
  // pubkey and stays BAD_SIG, which is the honest answer for it.
  const emsg = String((r && (r.message || r.error)) || '');
  if (!r || (!r.pubkey && /permission|macaroon|unauthenticated|unavailable|deadline|connection|EOF|unimplemented/i.test(emsg))) {
    throw new Error('verifymessage unavailable: ' + (emsg || 'no response').slice(0, 120));
  }
  return { pubkey: (r && r.pubkey) || '', graph_valid: !!(r && r.valid) };
}
async function issuerBalanceMsat(lndRequest, issuerPubkey) {
  const r = await lndRequest('GET', '/v1/channels', null);
  let sats = 0;
  for (const ch of ((r && r.channels) || [])) {
    if (String(ch.remote_pubkey).toLowerCase() === issuerPubkey.toLowerCase()
        && ch.active !== false) {
      sats += Number(ch.remote_balance || 0);
    }
  }
  return sats * 1000;
}
async function resolveBill(lndRequest, bill, amountMsatFromBody) {
  const s = String(bill || '').replace(/^lightning:/i, '').trim();
  const low = s.toLowerCase();
  if (!(low.startsWith('lnbc') || low.startsWith('lntb') || low.startsWith('lnbcrt'))) {
    return { error: 'unsupported_bill_v0' }; // LNURL/address: the v1 follow-up
  }
  let decoded;
  try { decoded = await lndRequest('GET', '/v1/payreq/' + encodeURIComponent(low), null); }
  catch (e) { return { error: 'bad_invoice: ' + String(e.message || e).slice(0, 120) }; }
  const invMsat = Number(decoded && (decoded.num_msat || 0)) || (Number(decoded && decoded.num_satoshis || 0) * 1000);
  // S26: carry the payee identity out of the decode so a spend can be
  // named ("Delegated spend · Stout Coffee") instead of anonymous.
  const meta = {
    payment_hash: String((decoded && decoded.payment_hash) || '').toLowerCase(),
    desc: String((decoded && decoded.description) || '').slice(0, 80),
    payee_pubkey: String((decoded && decoded.destination) || '').toLowerCase(),
  };
  if (invMsat > 0) return Object.assign({ bolt11: low, amount_msat: invMsat, from_invoice: true }, meta);
  const bodyMsat = Number(amountMsatFromBody || 0);
  if (bodyMsat > 0) return Object.assign({ bolt11: low, amount_msat: bodyMsat, from_invoice: false }, meta);
  return { error: 'zero_amount_bill_needs_amount_msat' };
}

// ── endpoint: POST /delegate/register (self-authenticating) ──────────
// 0.64.0: ask LND what the route to this payee costs for this amount. Same-LSP
// payees (a wallet on our own channel) quote zero; the reserve is that fee plus
// a small margin, and the same number is the payment's fee ceiling. No quote
// (payee unreachable without hints, LND error) => proportional floor. Bounded
// by max(FEE_LIMIT_MSAT, 5% of the bill) so a pathological route cannot eat a slip.
async function spendFeeReserveMsat(lndRequest, bill) {
  const amt = Number(bill.amount_msat || 0);
  const floor = Math.max(CFG.FEE_FLOOR_MSAT(), Math.ceil(amt * CFG.FEE_FLOOR_PPM() / 1e6));
  const ceiling = Math.max(CFG.FEE_LIMIT_MSAT(), Math.ceil(amt * 0.05));
  try {
    const dest = String(bill.payee_pubkey || '');
    if (!/^0[23][0-9a-f]{64}$/.test(dest)) return Math.min(floor, ceiling);
    const amtSat = Math.max(1, Math.floor(amt / 1000));
    const r = await lndRequest('GET', '/v1/graph/routes/' + dest + '/' + amtSat + '?use_mission_control=true', null);
    const route = r && Array.isArray(r.routes) && r.routes[0];
    if (!route) return Math.min(floor, ceiling);
    const feeMsat = Number(route.total_fees_msat || 0);
    if (!Number.isFinite(feeMsat) || feeMsat < 0) return Math.min(floor, ceiling);
    const reserve = feeMsat + CFG.FEE_MARGIN_MSAT();
    console.log('[delegate] fee reserve quoted: route fee ' + feeMsat + ' msat + margin -> ' + reserve + ' msat for ' + amt + ' msat to ' + dest.slice(0, 12));
    return Math.min(reserve, ceiling);
  } catch (e) {
    return Math.min(floor, ceiling);
  }
}

async function epRegister(req, res, lndRequest) {
  let b;
  try { b = await readBody(req); } catch (e) { return j(res, 400, { ok: false, code: 'BAD_BODY', error: String(e.message || e) }); }
  const s = b || {};
  const bad = (f) => j(res, 400, { ok: false, code: 'BAD_FIELDS', field: f });
  if (s.v !== 1) return bad('v');
  if (!/^0[23][0-9a-f]{64}$/.test(String(s.issuer_pubkey || ''))) return bad('issuer_pubkey');
  if (!Number.isInteger(s.cap_msat) || s.cap_msat <= 0) return bad('cap_msat');
  if (!Number.isInteger(s.per_pay_cap_msat) || s.per_pay_cap_msat <= 0
      || s.per_pay_cap_msat > s.cap_msat) return bad('per_pay_cap_msat');
  if (!Number.isInteger(s.count) || s.count < 1) return bad('count');
  if (!Number.isInteger(s.not_after)) return bad('not_after');
  if (!/^[0-9a-f]{64}$/.test(String(s.nonce || ''))) return bad('nonce');
  if (typeof s.sig !== 'string' || s.sig.length < 20) return bad('sig');

  if (s.cap_msat > CFG.SLIP_MAX_MSAT()) return j(res, 400, { ok: false, code: 'OVER_SLIP_MAX', slip_max_msat: CFG.SLIP_MAX_MSAT() });
  const horizon = s.not_after - nowS();
  if (horizon <= 0 || horizon > CFG.MAX_HORIZON_S()) return j(res, 400, { ok: false, code: 'HORIZON_TOO_LONG', max_s: CFG.MAX_HORIZON_S() });
  if (countLive() >= CFG.MAX_LIVE()) return j(res, 429, { ok: false, code: 'MAX_LIVE' });
  if (recGet(s.nonce)) return j(res, 409, { ok: false, code: 'NONCE_EXISTS' });

  let v;
  try { v = await verifySig(lndRequest, slipDigest(s), s.sig); }
  catch (e) { return j(res, 502, { ok: false, code: 'VERIFY_UNAVAILABLE', error: String(e.message || e).slice(0, 120) }); }
  if (!v.pubkey || String(v.pubkey).toLowerCase() !== String(s.issuer_pubkey).toLowerCase()) {
    return j(res, 401, { ok: false, code: 'BAD_SIG' });
  }

  if (CFG.BALANCE_CHECK()) {
    let bal;
    try { bal = await issuerBalanceMsat(lndRequest, s.issuer_pubkey); }
    catch (e) { return j(res, 502, { ok: false, code: 'BALANCE_UNAVAILABLE' }); }
    if (bal < s.cap_msat) return j(res, 400, { ok: false, code: 'INSUFFICIENT_BALANCE', issuer_msat: bal });
  }

  // v0.2.0 PREPAY: the slip is authorization, but it authorizes nothing
  // until it is funded. Mint the funding invoice first — if the mint
  // fails, no record is written and the issuer can simply retry.
  let fund;
  try {
    fund = await lndRequest('POST', '/v1/invoices', {
      value_msat: String(s.cap_msat),
      memo: 'LIJOX allowance ' + s.nonce.slice(0, 8),
      expiry: String(FUNDING_EXPIRY_S),
    });
  } catch (e) { return j(res, 502, { ok: false, code: 'FUNDING_MINT_FAILED', error: String(e.message || e).slice(0, 120) }); }
  if (!fund || !fund.payment_request) return j(res, 502, { ok: false, code: 'FUNDING_MINT_FAILED' });
  recPut(s.nonce, {
    slip: { v: s.v, issuer_pubkey: s.issuer_pubkey.toLowerCase(), cap_msat: s.cap_msat,
      per_pay_cap_msat: s.per_pay_cap_msat, count: s.count, not_after: s.not_after,
      nonce: s.nonce.toLowerCase() },
    spent_msat: 0, count_used: 0, state: 'AWAITING_FUNDING', payments: [], claims: [],
    refunded_msat: 0, refund_state: 'NONE', created_ts: Date.now(),
    funding: { bolt11: String(fund.payment_request),
      hash: Buffer.from(String(fund.r_hash || ''), 'base64').toString('hex'),
      amount_msat: s.cap_msat, minted_ts: Date.now() },
  });
  console.log('[delegate] REGISTER nonce=' + s.nonce.slice(0, 12) + '… cap=' + s.cap_msat + 'msat count=' + s.count + ' → AWAITING_FUNDING');
  return j(res, 200, { ok: true, nonce: s.nonce.toLowerCase(), state: 'AWAITING_FUNDING',
    funding_bolt11: String(fund.payment_request), funding_amount_msat: s.cap_msat });
}

// ── endpoint: POST /delegate/spend (DELEGATE_SECRET gated) ───────────
async function epSpend(req, res, lndRequest) {
  const secret = CFG.SECRET();
  if (!secret) return j(res, 503, { ok: false, code: 'SPEND_DISABLED', error: 'DELEGATE_SECRET unset' });
  if (String(req.headers['x-delegate-secret'] || '') !== secret) {
    return j(res, 401, { ok: false, code: 'UNAUTHORIZED' });
  }
  let b;
  try { b = await readBody(req); } catch (e) { return j(res, 400, { ok: false, code: 'BAD_BODY', error: String(e.message || e) }); }
  const nonce = String((b && b.nonce) || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nonce)) return j(res, 400, { ok: false, code: 'BAD_FIELDS', field: 'nonce' });

  console.log('[delegate] SPEND request nonce=' + nonce.slice(0, 12) + '…');
  return withNonceLock(nonce, async () => {
    const rec = recGet(nonce);
    if (!rec) { console.log('[delegate] SPEND refused UNKNOWN_NONCE ' + nonce.slice(0, 12) + '…'); return j(res, 404, { ok: false, code: 'UNKNOWN_NONCE' }); }
    if (rec.state !== 'LIVE') { console.log('[delegate] SPEND refused NOT_LIVE(' + rec.state + ') ' + nonce.slice(0, 12) + '…'); return j(res, 410, { ok: false, code: 'NOT_LIVE', state: rec.state }); }

    const bill = await resolveBill(lndRequest, b.bill, b.amount_msat);
    if (bill.error) return j(res, 400, { ok: false, code: 'BAD_BILL', error: bill.error });

    // 0.64.0: reserve what the route will actually cost (DP field 2026-09-01:
    // a flat 50-sat reserve refused an 80-sat bill on a 100-sat slip).
    const feeLimit = await spendFeeReserveMsat(lndRequest, bill);
    if (bill.amount_msat > rec.slip.per_pay_cap_msat) {
      return j(res, 400, { ok: false, code: 'OVER_PER_PAY', per_pay_cap_msat: rec.slip.per_pay_cap_msat });
    }
    if (rec.spent_msat + bill.amount_msat + feeLimit > rec.slip.cap_msat) {
      return j(res, 400, { ok: false, code: 'OVER_CAP', remaining_msat: Math.max(0, rec.slip.cap_msat - rec.spent_msat), fee_reserve_msat: feeLimit });
    }
    if (rec.count_used >= rec.slip.count) return j(res, 410, { ok: false, code: 'COUNT_EXHAUSTED' });
    if (dailySpentMsat() + bill.amount_msat > CFG.DAILY_MSAT()) {
      console.log('[delegate] DAILY BREAKER tripped');
      return j(res, 429, { ok: false, code: 'DAILY_BREAKER' });
    }

    // S26: name the payee while we still hold the decode. Description is
    // the merchant's own words; alias is a best-effort graph read. Both
    // are advisory and never block a spend.
    let payeeName = bill.desc || '';
    if (!payeeName && bill.payee_pubkey) {
      try {
        const nd = await lndRequest('GET', '/v1/graph/node/' + bill.payee_pubkey, null);
        payeeName = String((nd && nd.node && nd.node.alias) || '').slice(0, 80);
      } catch (e) { payeeName = ''; }
    }
    // janitor precondition: the hash must be durable BEFORE the RPC, or a
    // crash mid-payment leaves a wedge nothing can reconcile.
    rec.inflight = { payment_hash: bill.payment_hash || '', amount_msat: bill.amount_msat,
      payee: payeeName, ts: Date.now() };
    rec.state = 'IN_FLIGHT'; recPut(nonce, rec); // persist BEFORE pay
    let pay;
    try {
      // v0.2.3 (register budget): ROUTER v2 with an LND-side verdict clock.
      // timeout_seconds makes LND itself answer terminally inside the
      // budget; no_inflight_updates collapses the stream to ONE terminal
      // JSON message, which the single-shot lndRequest parses as-is.
      const payBody = {
        payment_request: bill.bolt11,
        timeout_seconds: CFG.SPEND_TIMEOUT_S(),
        fee_limit_msat: String(feeLimit),
        no_inflight_updates: true,
      };
      if (!bill.from_invoice) payBody.amt_msat = String(bill.amount_msat);
      pay = await Promise.race([
        lndRequest('POST', '/v2/router/send', payBody),
        new Promise((_, rj) => setTimeout(() => rj(new Error('client_backstop_30s')), 30000)),
      ]);
      // v2 REST wraps each stream message as {result:{…}}; unwrap either shape.
      if (pay && pay.result) pay = pay.result;
    } catch (e) { pay = { transport_error: String(e.message || e).slice(0, 160) }; }

    const paidOk = pay && pay.status === 'SUCCEEDED' && pay.payment_preimage
      && !/^0+$/.test(String(pay.payment_preimage).replace(/[^0-9a-fA-F]/g, '') || '0');
    if (paidOk) {
      const pre = /^[0-9a-f]+$/i.test(pay.payment_preimage) ? pay.payment_preimage
        : Buffer.from(pay.payment_preimage, 'base64').toString('hex');
      const feeMsat = Number(pay.fee_msat || (pay.payment_route && pay.payment_route.total_fees_msat) || 0);
      // v0.2.4: sat-quantized ledger — ceil the delta to a whole sat so
      // the remainder is always integral and the wallet's whole-sat
      // refund never floors away dust (the field's 5,000−4,014−985).
      rec.spent_msat += Math.ceil((bill.amount_msat + feeMsat) / 1000) * 1000; // fees count against the cap
      rec.count_used += 1;
      rec.payments.push({ ts: Date.now(), amount_msat: bill.amount_msat, fee_msat: feeMsat, preimage: pre,
        payee: payeeName, payment_hash: bill.payment_hash || '' });
      // v1.5: the LSP fronted this. Record what the issuer now owes —
      // principal + the routing fee actually paid.
      rec.claims = rec.claims || [];
      rec.claims.push({ claim_id: claimId(), amount_msat: bill.amount_msat + feeMsat,
        payee: payeeName, spend_preimage: pre, bolt11: null, invoice_hash: null,
        status: 'OWED', ts: Date.now() });
      delete rec.inflight;
      rec.state = (rec.count_used >= rec.slip.count) ? 'SPENT' : 'LIVE';
      recPut(nonce, rec);
      console.log('[delegate] SPEND ok nonce=' + nonce.slice(0, 12) + '… amt=' + bill.amount_msat + ' fee=' + feeMsat + ' → ' + rec.state);
      return j(res, 200, { ok: true, preimage: pre, spent_msat: rec.spent_msat, state: rec.state });
    }
    // v0.2.2: forensics — on any non-success, the raw result shape once.
    try { console.log('[delegate] SPEND pay-result ' + JSON.stringify(pay).slice(0, 220)); } catch (e) {}
    const verdict = (pay && pay.status === 'FAILED')
      ? String(pay.failure_reason || 'FAILURE_REASON_NONE')
      : (pay && pay.payment_error) ? String(pay.payment_error) : null;
    if (verdict) {
      // DEFINITIVE verdict from LND's own JSON: terminal. Revert.
      rec.state = 'LIVE'; delete rec.inflight; recPut(nonce, rec); // close-on-preimage
      console.log('[delegate] SPEND FAILED nonce=' + nonce.slice(0, 12) + '…: ' + verdict);
      return j(res, 502, { ok: false, code: 'PAY_FAILED', error: verdict.slice(0, 160) });
    }
    // TRANSPORT/UNKNOWN: the outcome is not known — the janitor's
    // resolver (listpayments byHash) decides within ~60 s. State stays
    // IN_FLIGHT, rec.inflight PRESERVED (its precondition), and the
    // caller is told the truth: not settled, not free to assume failed.
    const terr = (pay && pay.transport_error) || 'no_preimage';
    console.log('[delegate] SPEND PENDING nonce=' + nonce.slice(0, 12) + '… (' + terr + ') \u2014 janitor will resolve');
    return j(res, 503, { ok: false, code: 'PAY_PENDING', error: 'outcome not yet known \u2014 do not retry; ask again in a minute' });
  });
}

// ── endpoint: POST /delegate/void (self-authenticating) ──────────────
async function epVoid(req, res, lndRequest) {
  let b;
  try { b = await readBody(req); } catch (e) { return j(res, 400, { ok: false, code: 'BAD_BODY' }); }
  const nonce = String((b && b.nonce) || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nonce)) return j(res, 400, { ok: false, code: 'BAD_FIELDS', field: 'nonce' });
  return withNonceLock(nonce, async () => {
    const rec = recGet(nonce);
    if (!rec) return j(res, 404, { ok: false, code: 'UNKNOWN_NONCE' });
    let v;
    try { v = await verifySig(lndRequest, voidDigest(nonce), b.sig); }
    catch (e) { return j(res, 502, { ok: false, code: 'VERIFY_UNAVAILABLE' }); }
    if (!v.pubkey || String(v.pubkey).toLowerCase() !== rec.slip.issuer_pubkey) {
      return j(res, 401, { ok: false, code: 'BAD_SIG' });
    }
    if (rec.state === 'LIVE' || rec.state === 'EXPIRED') { rec.state = 'VOID'; recPut(nonce, rec); }
    else if (rec.state === 'IN_FLIGHT') return j(res, 409, { ok: false, code: 'IN_FLIGHT' });
    console.log('[delegate] VOID nonce=' + nonce.slice(0, 12) + '… → ' + rec.state);
    return j(res, 200, { ok: true, state: rec.state }); // idempotent for VOID/SPENT
  });
}

// ── endpoint: GET /delegate/slip/<nonce> (bearer-safe terms) ─────────
async function epSlip(res, nonce, lndRequest) {
  const n = String(nonce || '').toLowerCase();
  let rec = /^[0-9a-f]{64}$/.test(n) ? recGet(n) : null;
  if (!rec) return j(res, 404, { ok: false, code: 'UNKNOWN_NONCE' });
  // v0.2.0: the wallet polls this endpoint immediately after paying the
  // funding invoice, so resolve funding HERE rather than making it wait
  // for the 60s janitor. Only unfunded records pay the lookup cost.
  if (rec.state === 'AWAITING_FUNDING' && lndRequest) {
    const moved = await resolveFunding(n, rec, lndRequest);
    if (moved) rec = recGet(n) || rec;
  }
  if (rec.state === 'LIVE' && rec.slip.not_after <= nowS()) {
    rec.state = 'EXPIRED'; recPut(n, rec);
    console.log('[delegate] EXPIRED nonce=' + n.slice(0, 12) + '…');
  }
  return j(res, 200, {
    ok: true,
    cap_msat: rec.slip.cap_msat, spent_msat: rec.spent_msat,
    per_pay_cap_msat: rec.slip.per_pay_cap_msat,
    count: rec.slip.count, count_used: rec.count_used,
    not_after: rec.slip.not_after, state: rec.state,
    funding_bolt11: (rec.state === 'AWAITING_FUNDING' && rec.funding) ? rec.funding.bolt11 : undefined,
    refund_owed_msat: refundOwedMsat(rec),
  });
}

// ── v0.2.0 PREPAY: funding, expiry, and the refund rail ──────────────
const FUNDING_EXPIRY_S = parseInt(process.env.DELEGATE_FUNDING_EXPIRY_S || '900', 10);
const FUNDING_ABANDON_MS = (FUNDING_EXPIRY_S + 300) * 1000;

function refundDigest(nonce, bolt11) {
  return 'LIJOX-delegate-refund-v1\nnonce=' + nonce + '\nbolt11=' + bolt11;
}
function refundsDigest(pk, ts) {
  return 'LIJOX-delegate-refunds-v1\nissuer_pubkey=' + pk + '\nts=' + ts;
}
function isClosed(state) {
  return state === 'SPENT' || state === 'VOID' || state === 'EXPIRED';
}
// What the LSP owes back. Only meaningful once the slip is closed: while it
// is LIVE the unspent remainder is still spendable by the errand-runner.
function refundOwedMsat(rec) {
  if (!rec || !rec.slip || !isClosed(rec.state)) return 0;
  if (!rec.funded_ts) return 0; // never funded: nothing to give back
  const owed = rec.slip.cap_msat - (rec.spent_msat || 0) - (rec.refunded_msat || 0);
  return owed > 0 ? owed : 0;
}

// Flip AWAITING_FUNDING -> LIVE the moment the funding invoice settles.
// Returns true if the record changed.
async function resolveFunding(nonce, rec, lndRequest) {
  if (!rec || rec.state !== 'AWAITING_FUNDING' || !rec.funding || !rec.funding.hash) return false;
  let inv = null;
  try { inv = await lndRequest('GET', '/v1/invoice/' + rec.funding.hash, null); }
  catch (e) { return false; } // LND away: leave it, the janitor retries
  if (inv && (inv.settled === true || inv.state === 'SETTLED')) {
    rec.state = 'LIVE';
    rec.funded_ts = Date.now();
    rec.funded_msat = Number(inv.amt_paid_msat || rec.funding.amount_msat || 0);
    recPut(nonce, rec);
    console.log('[delegate] FUNDED nonce=' + nonce.slice(0, 12) + '… ' + rec.funded_msat + 'msat → LIVE');
    return true;
  }
  // Abandoned: the invoice window closed unpaid. No money moved, so this is
  // a clean void — it must not linger as a slip that could suddenly fund.
  if (Date.now() - Number(rec.funding.minted_ts || 0) > FUNDING_ABANDON_MS) {
    rec.state = 'VOID';
    recPut(nonce, rec);
    console.log('[delegate] UNFUNDED nonce=' + nonce.slice(0, 12) + '… → VOID (funding window closed)');
    return true;
  }
  return false;
}

// ── endpoint: GET /delegate/refunds (issuer-signed) ──────────────────
// What the LSP owes this issuer back: closed slips with an unspent remainder.
async function epRefunds(req, res, lndRequest) {
  let q;
  try { q = new URL(req.url, 'http://lsp.local').searchParams; }
  catch (e) { return j(res, 400, { ok: false, code: 'BAD_QUERY' }); }
  const pk = String(q.get('issuer') || '').toLowerCase();
  const ts = parseInt(q.get('ts') || '0', 10);
  const sig = String(q.get('sig') || '');
  if (!/^0[23][0-9a-f]{64}$/.test(pk)) return j(res, 400, { ok: false, code: 'BAD_FIELDS', field: 'issuer' });
  if (!ts || Math.abs(nowS() - ts) > 300) return j(res, 400, { ok: false, code: 'STALE_TS' });
  let v;
  try { v = await verifySig(lndRequest, refundsDigest(pk, ts), sig); }
  catch (e) { return j(res, 502, { ok: false, code: 'VERIFY_UNAVAILABLE', error: String(e.message || e).slice(0, 120) }); }
  if (!v.pubkey || String(v.pubkey).toLowerCase() !== pk) return j(res, 401, { ok: false, code: 'BAD_SIG' });

  const store = storeLoad();
  const out = [];
  for (const n of Object.keys(store)) {
    const rec = store[n];
    if (!rec || !rec.slip || String(rec.slip.issuer_pubkey).toLowerCase() !== pk) continue;
    // a LIVE slip past its horizon is closed in fact; say so here too
    if (rec.state === 'LIVE' && rec.slip.not_after <= nowS()) { rec.state = 'EXPIRED'; recPut(n, rec); }
    const owed = refundOwedMsat(rec);
    if (owed > 0 && rec.refund_state !== 'PAYING') {
      out.push({ nonce: n, amount_msat: owed, state: rec.state,
        cap_msat: rec.slip.cap_msat, spent_msat: rec.spent_msat || 0 });
    }
  }
  return j(res, 200, { ok: true, refunds: out });
}

// ── endpoint: POST /delegate/refund (issuer-signed, invoice-bound) ───
// The issuer presents an invoice for what it is owed. The signature covers
// the invoice itself, so a captured signature cannot be redirected, and the
// payee must be the issuer's own node besides.
async function epRefund(req, res, lndRequest) {
  let b;
  try { b = await readBody(req); } catch (e) { return j(res, 400, { ok: false, code: 'BAD_BODY' }); }
  const nonce = String((b && b.nonce) || '').toLowerCase();
  const bolt11 = String((b && b.bolt11) || '').replace(/^lightning:/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nonce)) return j(res, 400, { ok: false, code: 'BAD_FIELDS', field: 'nonce' });
  if (!bolt11) return j(res, 400, { ok: false, code: 'BAD_FIELDS', field: 'bolt11' });

  return withNonceLock(nonce, async () => {
    const rec = recGet(nonce);
    if (!rec) return j(res, 404, { ok: false, code: 'UNKNOWN_NONCE' });
    if (rec.state === 'LIVE' && rec.slip.not_after <= nowS()) { rec.state = 'EXPIRED'; recPut(nonce, rec); }

    let v;
    try { v = await verifySig(lndRequest, refundDigest(nonce, bolt11), b.sig); }
    catch (e) { return j(res, 502, { ok: false, code: 'VERIFY_UNAVAILABLE' }); }
    if (!v.pubkey || String(v.pubkey).toLowerCase() !== rec.slip.issuer_pubkey) {
      return j(res, 401, { ok: false, code: 'BAD_SIG' });
    }

    const owed = refundOwedMsat(rec);
    if (owed <= 0) return j(res, 409, { ok: false, code: 'NOTHING_OWED', state: rec.state });
    if (rec.refund_state === 'PAYING') return j(res, 409, { ok: false, code: 'REFUND_IN_FLIGHT' });

    let dec;
    try { dec = await lndRequest('GET', '/v1/payreq/' + encodeURIComponent(bolt11), null); }
    catch (e) { return j(res, 400, { ok: false, code: 'BAD_INVOICE' }); }
    const dest = String((dec && dec.destination) || '').toLowerCase();
    if (dest !== rec.slip.issuer_pubkey) return j(res, 400, { ok: false, code: 'PAYEE_NOT_ISSUER' });
    const invMsat = Number((dec && dec.num_msat) || 0) || (Number((dec && dec.num_satoshis) || 0) * 1000);
    if (invMsat > owed) return j(res, 400, { ok: false, code: 'OVER_REFUND', owed_msat: owed });
    const payMsat = invMsat > 0 ? invMsat : owed;

    rec.refund_state = 'PAYING';
    rec.refund_inflight = { payment_hash: String((dec && dec.payment_hash) || '').toLowerCase(),
      amount_msat: payMsat, ts: Date.now() };
    recPut(nonce, rec); // persist BEFORE pay, same discipline as spend

    let pay;
    try {
      const body = { payment_request: bolt11, fee_limit: { fixed_msat: String(CFG.FEE_LIMIT_MSAT()) } };
      if (invMsat <= 0) body.amt_msat = String(payMsat);
      pay = await lndRequest('POST', '/v1/channels/transactions', body);
    } catch (e) { pay = { payment_error: String(e.message || e).slice(0, 160) }; }

    if (pay && !pay.payment_error && pay.payment_preimage) {
      rec.refunded_msat = (rec.refunded_msat || 0) + payMsat;
      rec.refund_state = (refundOwedMsat(rec) > 0) ? 'OWED' : 'PAID';
      delete rec.refund_inflight;
      recPut(nonce, rec);
      console.log('[delegate] REFUND paid nonce=' + nonce.slice(0, 12) + '… ' + payMsat + 'msat → ' + rec.refund_state);
      return j(res, 200, { ok: true, refunded_msat: payMsat, remaining_owed_msat: refundOwedMsat(rec) });
    }
    rec.refund_state = 'OWED'; delete rec.refund_inflight; recPut(nonce, rec);
    const err = (pay && pay.payment_error) || 'no_preimage';
    console.log('[delegate] REFUND FAILED nonce=' + nonce.slice(0, 12) + '…: ' + err);
    return j(res, 502, { ok: false, code: 'REFUND_FAILED', error: String(err).slice(0, 160) });
  });
}

// ── S26: claim ids, the janitor, and the issuer-signed claim list ────
function claimId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function claimsDigest(pk, ts) {
  return 'LIJOX-delegate-claims-v1\nissuer_pubkey=' + pk + '\nts=' + ts;
}

// janitor v1.1 — the restart survivor. A crash between "persist IN_FLIGHT"
// and "payment resolved" leaves a slip wedged: void refuses (409) and the
// cap stays consumed while LND alone knows what really happened. The sweep
// asks LND and settles the truth. It also flips OWED claims to PAID when
// their invoices settle, which is how a wallet's claim payment is ack'd.
let _janTimer = null, _janBusy = false;
async function janitorSweep(lndRequest) {
  if (_janBusy) return;
  _janBusy = true;
  try {
    const store = storeLoad();
    const nonces = Object.keys(store);

    // v0.2.0: unfunded slips resolve or lapse; LIVE slips past their
    // horizon close, which is what makes their remainder refundable.
    for (const n of nonces) {
      const r = store[n];
      if (!r) continue;
      if (r.state === 'AWAITING_FUNDING') { await resolveFunding(n, r, lndRequest); }
      else if (r.state === 'LIVE' && r.slip && r.slip.not_after <= nowS()) {
        r.state = 'EXPIRED'; recPut(n, r);
        console.log('[delegate] JANITOR expired nonce=' + n.slice(0, 12) + '…');
      }
    }

    const wedged = nonces.filter((n) => store[n] && store[n].state === 'IN_FLIGHT');
    if (wedged.length) {
      let byHash = null;
      try {
        const list = await lndRequest('GET', '/v1/payments?include_incomplete=true&reversed=true&max_payments=200', null);
        byHash = {};
        for (const p of ((list && list.payments) || [])) {
          byHash[String(p.payment_hash || '').toLowerCase()] = p;
        }
      } catch (e) { byHash = null; } // LND unreachable: leave every wedge alone
      if (byHash) {
        for (const n of wedged) {
          const rec = store[n];
          const f = rec.inflight || null;
          const h = f ? String(f.payment_hash || '').toLowerCase() : '';
          const p = h ? byHash[h] : null;
          if (p && p.status === 'SUCCEEDED') {
            const feeMsat = Number(p.fee_msat || 0);
            const amt = Number((f && f.amount_msat) || p.value_msat || 0);
            const pre = String(p.payment_preimage || '');
            rec.spent_msat += Math.ceil((amt + feeMsat) / 1000) * 1000; // v0.2.4: sat-quantized, same rule as the live path
            rec.count_used += 1;
            rec.payments.push({ ts: Date.now(), amount_msat: amt, fee_msat: feeMsat, preimage: pre,
              payee: (f && f.payee) || '', payment_hash: h, reconciled: true });
            rec.claims = rec.claims || [];
            rec.claims.push({ claim_id: claimId(), amount_msat: amt + feeMsat, payee: (f && f.payee) || '',
              spend_preimage: pre, bolt11: null, invoice_hash: null, status: 'OWED', ts: Date.now() });
            rec.state = (rec.count_used >= rec.slip.count) ? 'SPENT' : 'LIVE';
            delete rec.inflight;
            recPut(n, rec);
            console.log('[delegate] JANITOR reconciled SUCCEEDED nonce=' + n.slice(0, 12) + '… → ' + rec.state);
          } else if (p && p.status === 'FAILED') {
            rec.state = 'LIVE'; delete rec.inflight; recPut(n, rec);
            console.log('[delegate] JANITOR reconciled FAILED nonce=' + n.slice(0, 12) + '… → LIVE');
          } else if (!p) {
            // LND has no record: the pay RPC never landed (crash before the
            // call). Nothing was spent — free the slip.
            rec.state = 'LIVE'; delete rec.inflight; recPut(n, rec);
            console.log('[delegate] JANITOR unwedged (no LND record) nonce=' + n.slice(0, 12) + '… → LIVE');
          } // still IN_FLIGHT at LND: leave it, next sweep decides
        }
      }
    }

    // OWED → PAID: the issuer paying the claim invoice IS the acknowledgement.
    for (const n of nonces) {
      const rec = store[n];
      if (!rec || !Array.isArray(rec.claims)) continue;
      let touched = false;
      for (const c of rec.claims) {
        if (c.status !== 'OWED' || !c.invoice_hash) continue;
        try {
          const inv = await lndRequest('GET', '/v1/invoice/' + c.invoice_hash, null);
          if (inv && (inv.settled === true || inv.state === 'SETTLED')) {
            c.status = 'PAID'; c.paid_ts = Date.now(); touched = true;
            console.log('[delegate] CLAIM paid ' + c.claim_id + ' (' + c.amount_msat + ' msat)');
          }
        } catch (e) {}
      }
      if (touched) recPut(n, rec);
    }
  } catch (e) {
    console.log('[delegate] JANITOR error:', (e && e.message) || e);
  } finally {
    _janBusy = false;
  }
}
function janitorArm(lndRequest) {
  if (_janTimer) return;
  // Self-arming: delegate.js receives lndRequest per request, so the first
  // request after a restart starts the clock and triggers one immediate sweep.
  _janTimer = setInterval(() => { janitorSweep(lndRequest); }, 60000);
  setTimeout(() => { janitorSweep(lndRequest); }, 1500);
  console.log('[delegate] janitor v1.1 armed (60s sweep)');
}

// ── endpoint: GET /delegate/claims (issuer-signed) ───────────────────
// What this issuer owes the LSP for spends it already fronted. Each claim
// carries an LSP-minted bolt11, minted lazily on first read and stable
// thereafter. Paying it settles the debt (the janitor observes and marks it).
async function epClaims(req, res, lndRequest) {
  let q;
  try { q = new URL(req.url, 'http://lsp.local').searchParams; }
  catch (e) { return j(res, 400, { ok: false, code: 'BAD_QUERY' }); }
  const pk = String(q.get('issuer') || '').toLowerCase();
  const ts = parseInt(q.get('ts') || '0', 10);
  const sig = String(q.get('sig') || '');
  if (!/^0[23][0-9a-f]{64}$/.test(pk)) return j(res, 400, { ok: false, code: 'BAD_FIELDS', field: 'issuer' });
  if (!ts || Math.abs(nowS() - ts) > 300) return j(res, 400, { ok: false, code: 'STALE_TS' });
  let v;
  try { v = await verifySig(lndRequest, claimsDigest(pk, ts), sig); }
  catch (e) { return j(res, 502, { ok: false, code: 'VERIFY_UNAVAILABLE', error: String(e.message || e).slice(0, 120) }); }
  if (!v.pubkey || String(v.pubkey).toLowerCase() !== pk) return j(res, 401, { ok: false, code: 'BAD_SIG' });

  const store = storeLoad();
  const out = [];
  for (const n of Object.keys(store)) {
    const rec = store[n];
    if (!rec || !rec.slip || String(rec.slip.issuer_pubkey).toLowerCase() !== pk) continue;
    if (!Array.isArray(rec.claims)) continue;
    let touched = false;
    // v0.2.1: a PREPAID slip's claims are a spend ledger, not a debt. Reading
    // it must not mint invoices nobody will ever pay. Legacy fronted records
    // (never funded) keep the original mint-on-read behavior.
    const prepaid = !!rec.funded_ts;
    for (const c of rec.claims) {
      if (c.status !== 'OWED') continue;
      if (!prepaid && !c.bolt11) {
        try {
          const inv = await lndRequest('POST', '/v1/invoices', {
            value_msat: String(c.amount_msat),
            memo: 'LIJOX claim ' + c.claim_id,
            expiry: '86400',
          });
          if (inv && inv.payment_request) {
            c.bolt11 = String(inv.payment_request);
            c.invoice_hash = Buffer.from(String(inv.r_hash || ''), 'base64').toString('hex');
            touched = true;
          }
        } catch (e) { continue; } // mint failed: skip, next poll retries
      }
      if (prepaid || c.bolt11) {
        out.push({ claim_id: c.claim_id, nonce: n, amount_msat: c.amount_msat,
          payee: c.payee || '', bolt11: c.bolt11 || null, ts: c.ts, prepaid });
      }
    }
    if (touched) recPut(n, rec);
  }
  return j(res, 200, { ok: true, claims: out });
}

// ── the router entry (the adapter's single touchpoint) ───────────────
async function handle(req, res, path, method, lndRequest) {
  try {
    // 0.64.0 (DP): an LSP that does not offer delegate payments says so plainly
    // (DELEGATE_ENABLED=0) instead of failing later on a missing permission.
    if (!CFG.ENABLED()) return j(res, 404, { ok: false, code: 'DELEGATE_NOT_OFFERED', error: 'This LSP does not offer delegate payments' });
    janitorArm(lndRequest); // S26: self-arming on the first request after a restart
    if (path === '/delegate/claims' && method === 'GET') return await epClaims(req, res, lndRequest);
    if (path === '/delegate/register' && method === 'POST') return await epRegister(req, res, lndRequest);
    if (path === '/delegate/spend' && method === 'POST') return await epSpend(req, res, lndRequest);
    if (path === '/delegate/void' && method === 'POST') return await epVoid(req, res, lndRequest);
    if (path === '/delegate/refunds' && method === 'GET') return await epRefunds(req, res, lndRequest);
    if (path === '/delegate/refund' && method === 'POST') return await epRefund(req, res, lndRequest);
    if (path.startsWith('/delegate/slip/') && method === 'GET') return await epSlip(res, path.slice('/delegate/slip/'.length), lndRequest);
    return j(res, 404, { ok: false, code: 'UNKNOWN_ROUTE' });
  } catch (e) {
    console.log('[delegate] UNHANDLED:', e && e.stack || e);
    try { return j(res, 500, { ok: false, code: 'INTERNAL' }); } catch (e2) {}
  }
}

module.exports = { handle, _test: { slipDigest, voidDigest, CFG } };
