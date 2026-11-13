// 0.127.3 — the Console's JIT guard line (console.js jitGuardLine), run as written in the page's script.
// DP 2026-11-12: the pane said "none in the last 24 h" and "1 wallet blocked from JIT" at once.
//   node console-guard-line.test.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'console.js'), 'utf8');
let fails = 0; const check = (c, m) => { if (!c) { fails++; console.log('FAIL · ' + m); } else console.log('  ok · ' + m); };
const m = src.match(/function jitGuardLine\(j\)\{[\s\S]*?\n/);
check(!!m, 'jitGuardLine is in the page script');
// the function sits inside a template literal: undo the one level of escaping the server's own string applies
const body = eval('`' + m[0].replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`');
const f = new Function('idc', 'ago', 'esc', body + '; return jitGuardLine;')((x) => String(x), () => '12 h ago', (x) => String(x));
const base = { level: 0, failed_24h: 0, failed_wallets_24h: 0, abandoned_24h: 0, blocked_wallets: [], arm_at: 2, halt_at: 3, wallet_at: 2 };
let h = f(base);
check(/<span class="ok">no failed JIT open in the last 24 h<\/span>/.test(h), 'nothing failed, nobody blocked: one plain line');
h = f(Object.assign({}, base, { abandoned_24h: 2, blocked_wallets: [{ wallet: '02ab', failures: 2, last_at: 1, last_code: '15' }] }));
check(!/none in the last 24 h/.test(h) && !/class="ok"/.test(h), 'DP\'s case: the line no longer says "none", and is not shown as all clear');
check(/no JIT open with published funding failed in the last 24 h · 2 held-funding opens failed · 1 wallet blocked/.test(h), 'it says what it counts, and names the held-funding failures and the block beside it');
check(/release this wallet/.test(h), 'the blocked wallet and its release button are still listed');
h = f(Object.assign({}, base, { abandoned_24h: 1 }));
check(/1 held-funding open failed<\/span>/.test(h) && !/blocked<\/span>/.test(h), 'a held-funding failure alone is named, with no block');
h = f(Object.assign({}, base, { level: 1, failed_24h: 1, failed_wallets_24h: 1 }));
check(/1 wallet with a funded-but-failed JIT open in the last 24 h \(1 open\)/.test(h), 'a published-funding failure reads as before');
console.log(fails ? `\n${fails} FAILED` : '\nall guard-line checks pass'); process.exit(fails ? 1 : 0);
