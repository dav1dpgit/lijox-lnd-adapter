// 0.90.0 (S54, DP 2026-10-04 10:19 "Let's make the JIT fee ladder be 100, 400, 1000, 2000, 3000, 5000, 10,000 and
// 15,000 for each after that") — THE OPEN FEE LADDER, as written in lij-adapter.js: a wallet's n-th JIT open inside the
// window pays step n (the last step after that); the fee = the larger of the step, the open-fee floor and the % of the
// payment, × the scarcity multiplier — on every rail (channelOpenFeeMsat), in the quote and in the LNURL minimum.
//   node jit-fee-ladder.test.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };
const lad = src.match(/const JIT_FEE_LADDER_DEFAULT = [\s\S]*?\/\/ ── end of the ladder/);
const fee = src.match(/function channelOpenFeeMsat\(amountMsat, clientPubkey, scarcityPct\) \{[\s\S]*?\n\}/);
const quote = src.match(/function openFeeBaselineSats\(\) \{[^\n]*\}\nfunction openFeeQuote\(clientPubkey\) \{[\s\S]*?\n\}/);
const lmin = src.match(/function lnurlpMinMsat\(chan, clientPubkey\) \{[\s\S]*?\n\}/);
check(!!(lad && fee && quote && lmin), 'the ladder, the fee, the quote and the LNURL minimum are defined');
// the whole fee path, evaluated as written, with the window count and the scarcity stubbed
const mk = (env, opensInWindow, scarcityPct, floorSats, ppm) => new Function('process', 'jitInWindow', 'scarcityMultPct', 'CONFIG', 'JIT_WINDOW_MS',
  lad[0] + '\n' + fee[0] + '\n' + quote[0] + '\n' + lmin[0] + '; return { L: JIT_FEE_LADDER, bad: JIT_FEE_LADDER_BAD, step: jitLadderStepSats, next: jitNextOpenNumber, fee: channelOpenFeeMsat, quote: openFeeQuote, min: lnurlpMinMsat };')(
  { env }, () => opensInWindow, () => scarcityPct, { lsps2: { open_fee_min_msat: floorSats * 1000, open_fee_ppm: ppm } }, 90 * 86400000);
const sats = (msat) => Number(msat) / 1000;
const PK = '02' + 'ab'.repeat(32);
// DP's ladder, by default
const LADDER = [100, 400, 1000, 2000, 3000, 5000, 10000, 15000];
let f = mk({}, 0, 100, 100, 100);
check(JSON.stringify(f.L) === JSON.stringify(LADDER) && f.bad === false, 'the default ladder is 100 · 400 · 1,000 · 2,000 · 3,000 · 5,000 · 10,000 · 15,000');
// each open's fee on a calm box (floor 100, 0.01 %), a 50,000-sat JIT
const want = [100, 400, 1000, 2000, 3000, 5000, 10000, 15000, 15000, 15000, 15000];
want.forEach((w, i) => {
  const g = mk({}, i, 100, 100, 100);
  check(sats(g.fee(String(50000 * 1000), PK)) === w && g.next(PK) === i + 1, `open ${i + 1} in the window pays ${w.toLocaleString('en-US')} (got ${sats(g.fee(String(50000 * 1000), PK))})`);
});
// the quote and the LNURL minimum say the same number
f = mk({}, 2, 100, 100, 100);
let q = f.quote(PK);
check(q.next_open_fee_sats === 1000 && q.open_number === 3 && JSON.stringify(q.ladder_sats) === JSON.stringify(LADDER) && q.window_days === 90, 'the quote for the 3rd open: 1,000, open 3, the ladder, 90 days');
check(f.min(null, PK) === 1000 * 1000 + 1000000, 'the LNURL minimum for the 3rd open = its fee + 1,000 sats');
check(f.min({ room_msat: 5000000n }, PK) === 1000, 'a wallet with room: the minimum is 1 sat (no open)');
check(mk({}, 0, 100, 100, 100).quote(null).next_open_fee_sats === 100 && mk({}, 0, 100, 100, 100).quote(null).baseline_sats === 100, 'no wallet named: the first step, the baseline 100');
// scarcity multiplies the step
f = mk({}, 7, 300, 100, 100);
check(sats(f.fee(String(50000 * 1000), PK)) === 45000 && f.quote(PK).next_open_fee_sats === 45000, 'the 8th open at the ×3 scarcity: 45,000, quote and charge agree');
f = mk({}, 1, 150, 100, 100);
check(sats(f.fee(String(50000 * 1000), PK, 100)) === 400, 'a promise\'s snapshotted scarcity (100) wins over the live one (150)');
// the floor and the % of the payment still apply — an expensive provider keeps its price
f = mk({}, 0, 100, 20000, 40000);   // LSP-2's shape: floor 20,000, 4 %
check(sats(f.fee(String(100000 * 1000), PK)) === 20000, 'floor 20,000 above the 1st step: 20,000');
check(sats(f.fee(String(1000000 * 1000), PK)) === 40000, '4 % of 1,000,000 above both: 40,000');
f = mk({}, 7, 100, 20000, 40000);
check(sats(f.fee(String(100000 * 1000), PK)) === 20000, 'the 8th step (15,000) below that floor: the floor');
f = mk({}, 0, 100, 100, 100);
check(sats(f.fee(String(5000000 * 1000), PK)) === 500, 'a 5,000,000 open at 0.01 % (500) is above the 1st step');
// a ladder from the box
f = mk({ JIT_FEE_LADDER_SATS: '200, 800 ,3_000' }, 5, 100, 100, 100);
check(JSON.stringify(f.L) === '[200,800,3000]' && f.bad === false && sats(f.fee('1000000', PK)) === 3000, 'a box ladder (spaces, underscores) — past its end, its last step');
for (const bad of ['100,abc', '100,-5', '1.5', ',', Array(52).fill(1).join(',')]) {
  f = mk({ JIT_FEE_LADDER_SATS: bad }, 0, 100, 100, 100);
  check(f.bad === true && JSON.stringify(f.L) === JSON.stringify(LADDER), `an unreadable ladder "${bad.slice(0, 12)}…" → the default, flagged`);
}
// nothing left of the percent escalator; retired settings are named
check(!/jitFeeMultPct/.test(src) && !/JIT_FEE_FREE_OPENS\s+\|\|/.test(src) && !/JIT_FEE_STEP_PCT\s+\|\|/.test(src), 'the free-opens + percent-step escalator is gone');
check(/JIT_FEE_FREE_OPENS: '[^']*LADDER/.test(src) && /JIT_FEE_STEP_PCT: '[^']*LADDER/.test(src), 'JIT_FEE_FREE_OPENS / JIT_FEE_STEP_PCT are named at boot when still set');
check(/ladder\(per wallet, \$\{Math\.round\(JIT_WINDOW_MS \/ 86400000\)\}d\)=\$\{JIT_FEE_LADDER\.join\('\/'\)\} sats/.test(src), 'the [JIT] boot line states the ladder (the ride receipt)');
check((src.match(/channelOpenFeeMsat\(/g) || []).length >= 5, 'every rail charges through channelOpenFeeMsat');
if (fails) { console.log('FAIL · ' + fails); process.exit(1); } else console.log('PASS · jit-fee-ladder.test.js');
