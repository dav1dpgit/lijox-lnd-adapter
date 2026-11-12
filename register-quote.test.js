'use strict';
// register-quote.test.js — 0.125.0: the agreed rate's arithmetic and the stamp (the wallet repo's register-mode-plan-v2 §4–§5,
// v2.1 §2–§5). Run: node register-quote.test.js
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const RQ = require('./register-quote');
let pass = 0, failed = 0;
const t = (name, f) => { try { f(); pass++; console.log('  ok · ' + name); } catch (e) { failed++; console.log('  FAIL · ' + name + ' — ' + (e.message || e)); } };

t('m1 the multiplier from a rate: three decimals, round half up (the plan\'s table)', () => {
  const m = (rate, dec) => RQ.multiplierString(RQ.multiplierMilli(rate, dec));
  assert.strictEqual(m(15000000, 0), '6666.667');     // JPY
  assert.strictEqual(m(66000, 2), '15151.515');       // USD
  assert.strictEqual(m(60000, 2), '16666.667');       // EUR
  assert.strictEqual(m(90000000, 0), '1111.111');     // KRW
  assert.strictEqual(m(1200000, 2), '833.333');       // ZAR
  assert.strictEqual(m(5500000, 2), '181.818');       // INR
  assert.strictEqual(RQ.multiplierMilli(0, 2), null); assert.strictEqual(RQ.multiplierMilli(NaN, 2), null); assert.strictEqual(RQ.multiplierMilli(100, 9), null);
  assert.strictEqual(RQ.milliFromString('6666.667'), 6666667n); assert.strictEqual(RQ.milliFromString('833.3'), 833300n); assert.strictEqual(RQ.milliFromString('x'), null);
});

t('v1 the test vectors of v2 §5: units → msats → the same units back', () => {
  const V = [['6666.667', 1280n, 8533334n], ['6666.667', 1n, 6667n], ['6666.667', 99999n, 666660033n], ['15151.515', 6499n, 98469696n], ['15151.515', 1n, 15152n], ['15151.515', 999999n, 15151499848n],
    ['1111.111', 1280n, 1422222n], ['833.333', 6499n, 5415831n], ['833.333', 1n, 833n], ['181.818', 6499n, 1181635n], ['181.818', 1n, 182n]];
  for (const [mult, units, msats] of V) {
    const milli = RQ.milliFromString(mult);
    assert.strictEqual(RQ.msatsFor(units, milli), msats, mult + ' × ' + units);
    assert.strictEqual(RQ.unitsFor(msats, milli), units, mult + ' back from ' + msats);
  }
});

t('v2 the round trip holds for every amount 1 … 200,000 smallest units at the six example rates', () => {
  for (const mult of ['6666.667', '15151.515', '16666.667', '1111.111', '833.333', '181.818']) {
    const milli = RQ.milliFromString(mult);
    for (let u = 1n; u <= 200000n; u++) { if (RQ.unitsFor(RQ.msatsFor(u, milli), milli) !== u) throw new Error(mult + ' misses at ' + u); }
  }
});

t('c1 the currency entry in LNURL PR #251\'s shape, with the quote\'s expiry', () => {
  const j = RQ.currencyEntry('jpy', 15000000, 1762560000);
  assert.deepStrictEqual(j.entry, { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0, multiplier: 6666.667, quote: { expires: 1762560000 } });
  assert.strictEqual(j.multiplier, '6666.667'); assert.strictEqual(j.milli, 6666667n);
  const u = RQ.currencyEntry('USD', 66000, 1); assert.strictEqual(u.entry.decimals, 2); assert.strictEqual(u.entry.symbol, '$'); assert.strictEqual(u.entry.multiplier, 15151.515);
  assert.strictEqual(RQ.currencyEntry('JPY', 0, 1), null); assert.strictEqual(RQ.currencyEntry('??', 1, 1), null); assert.strictEqual(RQ.currencyEntry('JP', 1, 1), null);
});

t('a1 the amount a wallet sends: msats (LUD-06) or units.CODE (PR #251); anything else is neither', () => {
  assert.deepStrictEqual(RQ.parseAmount('8533334'), { kind: 'msat', msat: 8533334n });
  assert.deepStrictEqual(RQ.parseAmount('1280.JPY'), { kind: 'units', units: 1280n, code: 'JPY' });
  assert.deepStrictEqual(RQ.parseAmount('6499.usd'), { kind: 'units', units: 6499n, code: 'USD' });
  for (const bad of ['', null, '-1', '1.5', '12.5.JPY', '1280.JPYY', 'abc', '1e9']) assert.strictEqual(RQ.parseAmount(bad), null, String(bad));
});

t('s1 the stamp: made, read back whole; one changed character is caught; it sits in a URL path as written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-')); let now = 1_800_000_000_000;
  const q = RQ.createRegisterQuote({ dataDir: dir, now: () => now });
  const s = q.make({ name: 'Shop', code: 'jpy', milli: 6666667n, decimals: 0 });
  assert.ok(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(s.stamp), 'path-safe: letters, digits, - _ and one dot'); assert.ok(s.stamp.length < 140);
  const r = q.read(s.stamp);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.name, 'shop'); assert.strictEqual(r.code, 'JPY'); assert.strictEqual(r.multiplier, '6666.667'); assert.strictEqual(r.milli, 6666667n); assert.strictEqual(r.decimals, 0); assert.strictEqual(r.id, s.id); assert.strictEqual(r.exp_s, 1_800_000_000 + 600);
  for (let i = 0; i < s.stamp.length; i += 7) {
    const c = s.stamp[i]; if (c === '.') continue;
    const bad = s.stamp.slice(0, i) + (c === 'A' ? 'B' : 'A') + s.stamp.slice(i + 1);
    if (bad === s.stamp) continue;
    assert.strictEqual(q.read(bad).ok, false, 'a change at ' + i + ' is caught');
  }
  assert.strictEqual(q.read('').ok, false); assert.strictEqual(q.read('-').ok, false); assert.strictEqual(q.read('abc.def').ok, false);
  const s2 = q.make({ name: 'shop', code: 'JPY', milli: 6666667n, decimals: 0 }); assert.notStrictEqual(s2.stamp, s.stamp, 'every answer gets a different stamp');
});

t('s2 the stamp\'s life is ten minutes; the key survives a restart; a lost key reads old stamps as "not ours" (a plain request, never a refusal)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-')); let now = 1_800_000_000_000;
  const q = RQ.createRegisterQuote({ dataDir: dir, now: () => now });
  const s = q.make({ name: 'shop', code: 'USD', milli: 15151515n, decimals: 2 });
  now += 600_000; assert.strictEqual(q.read(s.stamp).ok, true, 'at ten minutes exactly');
  now += 1000; { const r = q.read(s.stamp); assert.strictEqual(r.ok, false); assert.match(r.why, /ten minutes/); }
  now -= 300_000;
  const q2 = RQ.createRegisterQuote({ dataDir: dir, now: () => now });   // the restart
  assert.strictEqual(q2.read(s.stamp).ok, true, 'the key was on disk');
  assert.strictEqual((fs.statSync(path.join(dir, RQ.KEY_FILE)).mode & 0o777), 0o600, 'the key file is the owner\'s alone');
  fs.unlinkSync(path.join(dir, RQ.KEY_FILE));
  const q3 = RQ.createRegisterQuote({ dataDir: dir, now: () => now });   // the key lost
  { const r = q3.read(s.stamp); assert.strictEqual(r.ok, false); assert.match(r.why, /not signed by this provider/); }
});

t('d1 the callback\'s decision: a good stamp agrees the rate; the same stamp and msats while unpaid returns the same invoice; after it is paid, or with another amount, the stamp is spent — a plain request, never a refusal (v2.1 §2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-')); let now = 1_800_000_000_000;
  const q = RQ.createRegisterQuote({ dataDir: dir, now: () => now });
  const nowS = () => Math.floor(now / 1000);
  const s = q.make({ name: 'shop', code: 'JPY', milli: 6666667n, decimals: 0 });
  const entries = [{ hash: 'aa'.repeat(32), status: 'free' }];
  const d1 = q.decide({ stampText: s.stamp, name: 'shop', amountRaw: '8533334', entries, nowS: nowS() });
  assert.strictEqual(d1.amt, 8533334n); assert.ok(d1.quote); assert.strictEqual(d1.quote.multiplier, '6666.667'); assert.strictEqual(d1.same, null);
  assert.strictEqual(RQ.unitsFor(d1.amt, d1.quote.milli), 1280n, 'the Register will read ¥1,280');
  // the adapter writes the use on the entry
  entries[0] = { hash: 'aa'.repeat(32), status: 'reserved', pr: 'lnbc1first', register: { stamp_id: d1.quote.id, invoice_msat: '8533334', exp_s: nowS() + 600 } };
  const d2 = q.decide({ stampText: s.stamp, name: 'shop', amountRaw: '8533334', entries, nowS: nowS() });
  assert.strictEqual(d2.same, entries[0], 'the retry gets the same invoice'); assert.strictEqual(d2.quote, null);
  const d3 = q.decide({ stampText: s.stamp, name: 'shop', amountRaw: '9000000', entries, nowS: nowS() });
  assert.strictEqual(d3.same, null); assert.strictEqual(d3.quote, null); assert.strictEqual(d3.why, 'already used'); assert.strictEqual(d3.amt, 9000000n, 'another amount: a plain request for that amount');
  entries[0].status = 'settled';
  const d4 = q.decide({ stampText: s.stamp, name: 'shop', amountRaw: '8533334', entries, nowS: nowS() });
  assert.strictEqual(d4.same, null, 'a PAID invoice is never handed out again (the v2 gap)'); assert.strictEqual(d4.quote, null); assert.strictEqual(d4.why, 'already used'); assert.strictEqual(d4.amt, 8533334n);
  entries[0].status = 'reserved'; now += 601_000;
  const d5 = q.decide({ stampText: s.stamp, name: 'shop', amountRaw: '8533334', entries, nowS: nowS() });
  assert.strictEqual(d5.same, null, 'an invoice past its ten minutes is not handed out again'); assert.strictEqual(d5.quote, null);
});

// 0.127.1: the changed character is the FIRST of the signature — the last of its 22 carries only 2 of its 6 bits, so changing it
// could leave the same 16 bytes (the check then failed about one run in three)
t('d2 the callback\'s decision never refuses over the stamp: changed, another name\'s, out of time, the placeholder, the plain callback — each is a plain request for the msats sent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-')); let now = 1_800_000_000_000;
  const q = RQ.createRegisterQuote({ dataDir: dir, now: () => now });
  const s = q.make({ name: 'shop', code: 'JPY', milli: 6666667n, decimals: 0 });
  const D = (stampText, name) => q.decide({ stampText, name: name || 'shop', amountRaw: '5000000', entries: [], nowS: Math.floor(now / 1000) });
  for (const [st, nm, why] of [[s.stamp.replace(/\.(.)/, (_m, c) => '.' + (c === 'A' ? 'B' : 'A')), 'shop', /not signed/], [s.stamp, 'other', /another name/], ['-', 'shop', /no currency filed or no rate held/], ['garbage', 'shop', /not a stamp/]]) {
    const d = D(st, nm); assert.strictEqual(d.quote, null); assert.strictEqual(d.amt, 5000000n); assert.match(d.why, why); assert.strictEqual(d.same, null);
  }
  { const d = D(null); assert.strictEqual(d.quote, null); assert.strictEqual(d.amt, 5000000n); assert.strictEqual(d.why, '', 'the plain callback has nothing to say'); }
  now += 601_000; { const d = D(s.stamp); assert.strictEqual(d.quote, null); assert.match(d.why, /ten minutes/); assert.strictEqual(d.amt, 5000000n); }
});

t('d3 LNURL PR #251\'s amount form: units.CODE at the stamped rate; another currency or no stamp → at the rate held now, plain; no rate → no usable amount', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-')); const now = 1_800_000_000_000;
  const q = RQ.createRegisterQuote({ dataDir: dir, now: () => now });
  const s = q.make({ name: 'shop', code: 'JPY', milli: 6666667n, decimals: 0 });
  const live = (code, dec) => (code === 'USD' ? RQ.multiplierMilli(66000, dec) : code === 'JPY' ? RQ.multiplierMilli(15100000, dec) : null);
  const base = { name: 'shop', entries: [], nowS: Math.floor(now / 1000), liveMilli: live };
  { const d = q.decide(Object.assign({ stampText: s.stamp, amountRaw: '1280.JPY' }, base)); assert.strictEqual(d.amt, 8533334n, 'the stamped rate, not the live one'); assert.ok(d.quote); }
  { const d = q.decide(Object.assign({ stampText: s.stamp, amountRaw: '6499.USD' }, base)); assert.strictEqual(d.amt, 98469696n); assert.strictEqual(d.quote, null); assert.match(d.why, /another currency/); }
  { const d = q.decide(Object.assign({ stampText: null, amountRaw: '1280.JPY' }, base)); assert.strictEqual(d.amt, RQ.msatsFor(1280n, RQ.multiplierMilli(15100000, 0))); assert.strictEqual(d.quote, null); }
  { const d = q.decide(Object.assign({ stampText: s.stamp, amountRaw: '100.XAU' }, base)); assert.strictEqual(d.amt, 0n); assert.strictEqual(d.quote, null); }
  { const d = q.decide(Object.assign({ stampText: s.stamp, amountRaw: 'nonsense' }, base)); assert.strictEqual(d.amt, 0n, 'no amount → the range check answers, as today'); }
});

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
