'use strict';
// register-quote.js — 0.125.0 (S68 Tue 2026-11-10; the wallet repo's docs/register-mode-plan-v2.md and -v2.1.md, DP's
// rulings of 2026-11-07 and his "Go on all" of 11-10): REGISTER AMOUNT SHARING — the provider's side of the agreed rate.
//
// A shop's Register QR is its static Lightning address with the flag `?register`. To a flagged first call the provider
// answers with the shop's currency and its exchange rate (the "multiplier": msats per smallest unit of the currency,
// three decimals, LNURL PR #251's shape) and a callback address that carries a RATE STAMP in its path. Every wallet
// calls that address back unchanged, so the stamp returns with the invoice request and the provider records "this
// invoice, these msats, at this rate" on the payment. The shop's Register then shows the payment valued at the rate
// both sides used. The stamp holds nothing about the payor.
//
// THE RULES (v2 §4–§5, v2.1 §2–§3):
//   · the stamp is the provider's own: name | currency | multiplier | decimals | expiry | a random id, with an
//     HMAC-SHA256 under a secret kept on disk (DATA_DIR/register-stamp.key); a change to one character is caught;
//   · life: 10 minutes unused; one use;
//   · NEVER A REFUSAL over the stamp: unreadable, changed, used or out of time → the request is a plain one;
//   · one number, one formula, both sides — integer math, round half up:
//        msats = round_half_up(units × multiplier)        units = round_half_up(msats ÷ multiplier)
//
// No I/O but the secret file. Everything here is pure and tested by register-quote.test.js (v2 §5's vectors).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STAMP_LIFE_S = 600;          // DP 2026-11-07: "not long nor short" — 10 minutes
const STAMPED_INVOICE_LIFE_S = 600; // answer 2: a stamped invoice lives 10 minutes (a plain one keeps 20)
const KEY_FILE = 'register-stamp.key';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/// The smallest unit's decimals for a currency code, from the runtime's own table (JPY 0, USD 2, KWD 3 …).
/// null for a code the runtime does not know.
function currencyDecimals(code) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: String(code).toUpperCase() }).resolvedOptions().maximumFractionDigits; }
  catch (_) { return null; }
}
function currencyNames(code) {
  const c = String(code).toUpperCase();
  let name = c, symbol = c;
  try { name = new Intl.DisplayNames(['en'], { type: 'currency' }).of(c) || c; } catch (_) {}
  try { const p = new Intl.NumberFormat('en', { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' }).formatToParts(1).find((x) => x.type === 'currency'); if (p && p.value) symbol = p.value; } catch (_) {}
  return { name, symbol };
}

/// The multiplier in thousandths of a msat per smallest unit ("milli"), as a BigInt, from a rate in currency units per
/// BTC. multiplier = 1e11 msat ÷ (rate × 10^decimals); kept to three decimals, round half up. null when the rate is unusable.
function multiplierMilli(ratePerBtc, decimals) {
  const r = Number(ratePerBtc);
  if (!Number.isFinite(r) || r <= 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 8) return null;
  const rateE8 = BigInt(Math.round(r * 1e8));
  if (rateE8 <= 0n) return null;
  const den = rateE8 * (10n ** BigInt(decimals));
  const num = 10n ** 22n;   // 1e11 msat × 1000 (thousandths) × 1e8 (the rate's scale)
  const milli = (num + den / 2n) / den;
  return milli > 0n ? milli : null;
}
/// "6666.667" from 6666667n — the one decimal string both sides use as written.
function multiplierString(milli) {
  const m = BigInt(milli); const whole = m / 1000n; const frac = String(m % 1000n).padStart(3, '0');
  return whole.toString() + '.' + frac;
}
function milliFromString(s) {
  const m = /^(\d{1,15})(?:\.(\d{1,3}))?$/.exec(String(s || ''));
  if (!m) return null;
  const v = BigInt(m[1]) * 1000n + BigInt(((m[2] || '') + '000').slice(0, 3));
  return v > 0n ? v : null;
}
/// msats = round_half_up(units × multiplier)
function msatsFor(units, milli) { return (BigInt(units) * BigInt(milli) + 500n) / 1000n; }
/// units = round_half_up(msats ÷ multiplier)
function unitsFor(msats, milli) { const m = BigInt(milli); return (BigInt(msats) * 1000n + m / 2n) / m; }

/// The #251 currency entry for a Register answer, or null when there is no usable rate for the code.
function currencyEntry(code, ratePerBtc, expiresS) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return null;
  const decimals = currencyDecimals(c);
  if (decimals === null) return null;
  const milli = multiplierMilli(ratePerBtc, decimals);
  if (milli === null) return null;
  const nm = currencyNames(c);
  const str = multiplierString(milli);
  return { entry: { code: c, name: nm.name, symbol: nm.symbol, decimals, multiplier: Number(str), quote: { expires: Number(expiresS) } }, milli, multiplier: str, decimals, code: c };
}

/// The amount a wallet sent: `<msats>` (LUD-06) or `<units>.<CODE>` (LNURL PR #251). null when it is neither.
function parseAmount(s) {
  const t = String(s == null ? '' : s);
  if (/^\d{1,19}$/.test(t)) return { kind: 'msat', msat: BigInt(t) };
  const m = /^(\d{1,15})\.([A-Za-z]{3})$/.exec(t);
  if (m) return { kind: 'units', units: BigInt(m[1]), code: m[2].toUpperCase() };
  return null;
}

function createRegisterQuote(deps) {
  const { dataDir = null, now = () => Date.now(), log = () => {}, lifeS = STAMP_LIFE_S } = deps || {};
  let secret = null;
  function key() {
    if (secret) return secret;
    const f = dataDir ? path.join(dataDir, KEY_FILE) : null;
    if (f) {
      try { const h = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{64}$/.test(h)) { secret = Buffer.from(h, 'hex'); return secret; } } catch (_) {}
    }
    secret = crypto.randomBytes(32);
    if (f) {
      try { fs.writeFileSync(f, secret.toString('hex') + '\n', { mode: 0o600 }); log(`[REGISTER] a new stamp key was written to ${KEY_FILE} (open stamps from before it, if any, read as plain requests)`); }
      catch (e) { log(`[REGISTER] the stamp key could not be written (${e.message}) — it lives until the next restart only`); }
    }
    return secret;
  }
  const mac = (payload) => crypto.createHmac('sha256', key()).update(payload, 'utf8').digest().subarray(0, 16);
  /// A fresh stamp for one Register answer. { stamp, id, exp_s }
  function make({ name, code, milli, decimals }) {
    const id = crypto.randomBytes(8).toString('hex');
    const exp = Math.floor(now() / 1000) + lifeS;
    const payload = ['1', String(name).toLowerCase(), String(code).toUpperCase(), BigInt(milli).toString(), String(decimals), String(exp), id].join('|');
    return { stamp: b64u(Buffer.from(payload, 'utf8')) + '.' + b64u(mac(payload)), id, exp_s: exp };
  }
  /// Read a stamp. { ok:true, name, code, milli (BigInt), multiplier (string), decimals, exp_s, id } or { ok:false, why }.
  /// `why` is for the journal; the caller never refuses a payment over it.
  function read(stamp) {
    try {
      const m = /^([A-Za-z0-9_-]{8,400})\.([A-Za-z0-9_-]{22})$/.exec(String(stamp || ''));
      if (!m) return { ok: false, why: 'not a stamp' };
      const payload = unb64u(m[1]).toString('utf8');
      const want = mac(payload); const got = unb64u(m[2]);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, why: 'not signed by this provider (or changed)' };
      const p = payload.split('|');
      if (p.length !== 7 || p[0] !== '1') return { ok: false, why: 'unknown stamp form' };
      const milli = /^\d{1,24}$/.test(p[3]) ? BigInt(p[3]) : 0n; const decimals = Number(p[4]); const exp = Number(p[5]);
      if (milli <= 0n || !Number.isInteger(decimals) || !Number.isFinite(exp) || !/^[0-9a-f]{16}$/.test(p[6])) return { ok: false, why: 'unreadable fields' };
      if (Math.floor(now() / 1000) > exp) return { ok: false, why: 'past its ten minutes', id: p[6] };
      return { ok: true, name: p[1], code: p[2], milli, multiplier: multiplierString(milli), decimals, exp_s: exp, id: p[6] };
    } catch (e) { return { ok: false, why: 'unreadable: ' + String(e.message || e).slice(0, 60) }; }
  }
  /// THE CALLBACK'S DECISION. In: the stamp text from the path (null on the plain callback, "-" when the Register answer
  /// had no rate), the name, the raw `amount`, the name's entries (each may carry `register.stamp_id` from an earlier
  /// use — the use is on the entry, so it survives a restart), the time, and a way to get the rate held now for a code.
  /// Out: { amt (BigInt msats; 0n = no usable amount), quote (the agreed rate, or null = a plain request), why (for
  /// the journal when a Register callback ended plain), same (the entry whose unpaid invoice is to be returned again) }.
  function decide({ stampText, name, amountRaw, entries, nowS, liveMilli }) {
    const isRegisterCb = stampText !== null && stampText !== undefined;
    let quote = null, why = '';
    if (isRegisterCb && stampText !== '-') {
      const q = read(stampText);
      if (!q.ok) why = q.why;
      else if (q.name !== String(name).toLowerCase()) why = 'made for another name';
      else quote = q;
    } else if (isRegisterCb) why = 'no currency filed or no rate held';
    const a = parseAmount(amountRaw);
    let amt = 0n;
    if (a && a.kind === 'msat') amt = a.msat;
    else if (a && a.kind === 'units') {
      // LNURL PR #251's form: at the stamped rate when the stamp stands and the code is its code; else at the rate held
      // now for that code, as a plain request; no rate for the code → no usable amount (the range check answers)
      if (quote && quote.code === a.code) amt = msatsFor(a.units, quote.milli);
      else {
        if (quote) { quote = null; why = 'the amount names another currency'; }
        const dec = currencyDecimals(a.code);
        const live = (dec !== null && typeof liveMilli === 'function') ? liveMilli(a.code, dec) : null;
        amt = live ? msatsFor(a.units, live) : 0n;
      }
    }
    // ONE USE. The same stamp with the same msats while its invoice is still unpaid and alive = the payor's wallet
    // asking again after a lost answer: the same invoice goes back. Used any other way — another amount, or an invoice
    // already paid or ended — the stamp is spent and this is a plain request (v2.1 §2).
    if (quote) {
      const used = (entries || []).find((e) => e && e.register && e.register.stamp_id === quote.id) || null;
      if (used) {
        if (used.status === 'reserved' && used.pr && String(used.register.invoice_msat) === amt.toString() && Number(used.register.exp_s || 0) > Number(nowS)) return { amt, quote: null, why: '', same: used };
        quote = null; why = 'already used';
      }
    }
    return { amt, quote, why, same: null };
  }
  return { make, read, decide, lifeS };
}

module.exports = { createRegisterQuote, currencyEntry, currencyDecimals, multiplierMilli, multiplierString, milliFromString, msatsFor, unitsFor, parseAmount, STAMP_LIFE_S, STAMPED_INVOICE_LIFE_S, KEY_FILE };
