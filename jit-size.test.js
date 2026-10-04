// 0.90.0 (S54, DP 2026-10-04 09:53) — THE JIT GRANT, as written in lij-adapter.js: channel = payment + granted;
// granted = base + bonus % (rounded down) of the payment above the bonus start, at most the ceiling, never below base.
// (0.89.0's payment + max(fixed, share × payment) is gone — it had no ceiling.)
//   node jit-size.test.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };
const m = src.match(/const JIT_GRANT_DEFAULTS = [\s\S]*?\/\/ ── end of the grant/);
check(!!m, 'the grant block is defined (jitGrantTerms, jitGrantedSats, computeChannelSizeSats)');
const mk = (base, pct, from, ceiling) => new Function('CONFIG', m[0] + '\n; return { size: computeChannelSizeSats, granted: jitGrantedSats, terms: jitGrantTerms };')(
  { lsps2: { jit_grant_base_sats: base, jit_grant_bonus_pct: pct, jit_grant_bonus_from_sats: from, jit_grant_ceiling_sats: ceiling } });
const k = (sats) => String(sats * 1000);   // msat
// DP's table (2026-10-04 09:53): base 25,000; 50 % above 25,000; ceiling 62,500
let f = mk(25000, 50, 25000, 62500);
const want = [[5000, 25000], [25000, 25000], [40000, 32500], [50000, 37500], [75000, 50000], [100000, 62500], [500000, 62500], [1000000, 62500]];
for (const [pay, g] of want) {
  check(f.granted(pay) === g && f.size(k(pay)) === pay + g, `JIT ${pay.toLocaleString('en-US')} → granted ${g.toLocaleString('en-US')}, channel ${(pay + g).toLocaleString('en-US')} (got ${f.granted(pay)}, ${f.size(k(pay))})`);
}
check(f.granted(25001) === 25000, 'the bonus rounds down (50 % of 1 sat = 0)');
check(f.granted(25003) === 25001, '50 % of 3 sats = 1 (rounded down)');
check(f.granted(99999) === 62499 && f.granted(100001) === 62500, 'the ceiling is reached at a JIT of 100,000, not before');
check(f.size('5000500') === 5001 + 25000, 'a part-sat payment rounds up first');
// the channel always carries the payment, whatever the settings
for (const s of [[0, 0, 0, 0], [0, 100, 0, 0], [25000, 50, 25000, 0], [1, 1, 1, 1]]) {
  f = mk(...s);
  check([1, 999, 5000, 1000000].every((pay) => f.size(k(pay)) >= pay), `settings ${s.join('/')}: the channel is never smaller than the payment`);
}
f = mk(30000, 50, 25000, 20000); check(f.granted(5000) === 30000 && f.granted(500000) === 30000, 'a ceiling set below the base: the base wins');
// an unreadable setting → its default, flagged
f = mk(NaN, 50, 25000, 62500); check(f.granted(5000) === 25000 && f.terms().bad === true, 'a base that is not a number → 25,000, flagged');
f = mk(25000, -5, 25000, 62500); check(f.granted(50000) === 37500 && f.terms().bad === true, 'a negative bonus → 50 %, flagged');
f = mk(25000, 50, 25000, 62500.5); check(f.granted(500000) === 62500 && f.terms().bad === true, 'a ceiling that is not whole → 62,500, flagged');
f = mk(25000, 50, 25000, 62500); check(f.terms().bad === false, 'good settings are not flagged');
// the defaults, the call sites, the receipts
check(/JIT_GRANT_BASE_SATS\s+\|\| '25000'/.test(src) && /JIT_GRANT_BONUS_PCT\s+\|\| '50'/.test(src) && /JIT_GRANT_BONUS_FROM_SATS\s+\|\| '25000'/.test(src) && /JIT_GRANT_CEILING_SATS\s+\|\| '62500'/.test(src), 'defaults 25,000 / 50 / 25,000 / 62,500');
check((src.match(/computeChannelSizeSats\(/g) || []).length === 4, 'one definition, three openers (LNURL JIT, receivability, LSPS2)');
check(/grant=base \$\{_g\.base\} \+ \$\{_g\.pct\}% of the payment above \$\{_g\.from\}, ceiling \$\{_g\.ceiling\}/.test(src), 'the [JIT] boot line states the grant (the ride receipt)');
check(!/LSPS2_CHANNEL_BUFFER_SATS\s+\|\|/.test(src) && !/LSPS2_CHANNEL_ROOM_PCT\s+\|\|/.test(src), 'the 0.89.0 settings are no longer read');
check(/LSPS2_CHANNEL_BUFFER_SATS: '[^']*JIT_GRANT/.test(src) && /LSPS2_CHANNEL_ROOM_PCT: '[^']*JIT_GRANT/.test(src), '… and are named at boot when still set');
if (fails) { console.log('FAIL · ' + fails); process.exit(1); } else console.log('PASS · jit-size.test.js');
