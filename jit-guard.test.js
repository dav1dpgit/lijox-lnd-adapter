// jit-guard.test.js — 0.104.0 (S59): the JIT guard's ladder — 1 funded-but-failed open in 24 h = red, 2 = armed,
// 3 = JIT off until released; the window rolls; a settle never counts; the halt survives a restart; a release
// restarts the clock; an unknown channel point is ignored.
const { createJitGuard } = require('./jit-guard');
const fs = require('fs'); const os = require('os'); const path = require('path');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jitguard-'));
let t = 1_000_000_000_000; const now = () => t;
const logs = []; const log = (m) => logs.push(m);
const g = createJitGuard({ dataDir: dir, log, now });

// g1 — a settled open counts nothing; a failed one is level 1
g.recordOpen('aa:0', '02' + '11'.repeat(32), 50000, 'lsps2'); g.settle('aa:0');
check(g.counts().level === 0 && g.counts().settled_24h === 1 && g.counts().failed_24h === 0, 'g1 a settled open: level 0, nothing red');
g.recordOpen('bb:1', '02' + '22'.repeat(32), 35400, 'lsps2');
const c1 = g.fail('bb:1', 'INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS');
check(c1.level === 1 && c1.failed_24h === 1 && !c1.armed && !c1.halted && c1.last_failed.cp === 'bb:1' && c1.last_failed.code === 'INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS', 'g1 one funded-but-failed open: level 1, the last one named');
check(!g.halted() && /1 in 24 h/.test(logs[logs.length - 1]) && !/ARMED/.test(logs[logs.length - 1]), 'g1 not halted; the log names the count');

// g2 — two in 24 h: armed
t += 3600_000;
g.recordOpen('cc:0', '02' + '33'.repeat(32), 40000, 'lnurlp'); g.fail('cc:0', 'FINAL_INCORRECT_CLTV_EXPIRY');
check(g.counts().level === 2 && g.counts().armed && !g.halted() && /ARMED/.test(logs[logs.length - 1]), 'g2 two in 24 h: level 2, armed, still open');

// g3 — three: halted, persisted, every later open refused by the caller (halted() true)
t += 3600_000;
g.recordOpen('dd:0', '02' + '44'.repeat(32), 60000, 'push'); g.fail('dd:0', 'reject:unknown');
check(g.counts().level === 3 && g.halted() && g.counts().halted.count === 3 && g.counts().halted.last_cp === 'dd:0' && /JIT OFF/.test(logs[logs.length - 1]), 'g3 three in 24 h: JIT off, the halt names the count and the last channel');
const g2 = createJitGuard({ dataDir: dir, log, now });
check(g2.halted() && g2.counts().failed_24h === 3 && g2.counts().level === 3, 'g3 the halt survives a restart (the file)');

// g4 — the window rolls: 25 h later the failures are out of the window, but the halt stands until released
t += 25 * 3600_000;
check(g2.counts().failed_24h === 0 && g2.halted() && g2.counts().level === 3, 'g4 the window rolled; the halt stands (an operator releases it, not the clock)');

// g5 — release: JIT opens again; the clock restarts — an old failure still in a new window does not count
const r = g2.release('console 127.0.0.1');
check(r.ok && !g2.halted() && g2.counts().level === 0 && g2.counts().released_count === 1 && /RELEASED/.test(logs[logs.length - 1]), 'g5 released: level 0, logged');
check(!createJitGuard({ dataDir: dir, log, now }).halted(), 'g5 the release survives a restart');
check(g2.release('again').ok === false, 'g5 releasing an open guard is refused');
t += 60_000;
g2.recordOpen('ee:0', '02' + '55'.repeat(32), 50000, 'lsps2'); g2.fail('ee:0', 'x');
check(g2.counts().level === 1 && g2.counts().failed_24h === 1, 'g5 after the release the count starts afresh (one new failure = level 1, not a new halt)');

// g6 — unknown channel points and double outcomes are ignored; settle after fail changes nothing
check(g2.fail('zz:9', 'x') === null && g2.counts().failed_24h === 1, 'g6 a failure for an unknown open is ignored');
g2.settle('ee:0');
check(g2.counts().failed_24h === 1, 'g6 a settle after a fail changes nothing');

// g7 — thresholds are settings: halt off (0) never halts; arm at 1
const g3 = createJitGuard({ log, now, armAt: 1, haltAt: 0 });
g3.recordOpen('a:0', 'w', 1, 'lsps2'); g3.fail('a:0', 'x'); g3.recordOpen('b:0', 'w', 1, 'lsps2'); g3.fail('b:0', 'x'); g3.recordOpen('c:0', 'w', 1, 'lsps2'); g3.fail('c:0', 'x');
check(!g3.halted() && g3.counts().armed && g3.counts().level === 2, 'g7 JIT_GUARD_HALT_AT=0: armed at 1, never halted');

// g8 — old records are pruned at 14 days; the file is written atomically (a .tmp never lingers)
t += 15 * 86400_000;
g2.recordOpen('ff:0', 'w', 1, 'lsps2');
check(g2._state().opens.every((o) => o.ts >= t - 14 * 86400_000) && !fs.existsSync(path.join(dir, 'jit-guard.json.tmp')) && fs.existsSync(path.join(dir, 'jit-guard.json')), 'g8 records older than 14 days are pruned; the file is written whole');

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? 'FAIL · jit-guard · ' + fails + ' failed' : 'PASS · jit-guard (g1–g8)');
process.exit(fails ? 1 : 0);
