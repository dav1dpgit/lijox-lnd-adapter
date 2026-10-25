// jit-guard.test.js — 0.104.0 (S59): the JIT guard's ladder — 1 funded-but-failed open in 24 h = red, 2 = armed,
// 3 = JIT off until released; the window rolls; a settle never counts; the halt survives a restart; a release
// restarts the clock; an unknown channel point is ignored.
// 0.111.0 (S63): the halt counts DISTINCT WALLETS (g1–g8 use a different wallet per open, so they stand); one wallet's
// repeat failures block that wallet alone (g9–g12).
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
check(!g.halted() && /1 wallet, 1 open in 24 h/.test(logs[logs.length - 1]) && !/ARMED/.test(logs[logs.length - 1]), 'g1 not halted; the log names the count');

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

// g9 — ONE wallet failing three times: blocked itself, the halt untouched (one wallet is one wallet)
const dir9 = fs.mkdtempSync(path.join(os.tmpdir(), 'jitguard-'));
const W1 = '02' + 'aa'.repeat(32), W2 = '02' + 'bb'.repeat(32), W3 = '02' + 'cc'.repeat(32);
const g9 = createJitGuard({ dataDir: dir9, log, now });
g9.recordOpen('w1a:0', W1, 50000, 'lsps2'); g9.fail('w1a:0', 'x');
check(!g9.walletBlocked(W1) && g9.counts().level === 1 && g9.counts().failed_wallets_24h === 1, 'g9 one failure: red, the wallet not yet blocked');
t += 60_000;
g9.recordOpen('w1b:0', W1, 50000, 'lsps2'); g9.fail('w1b:0', 'y');
check(g9.walletBlocked(W1) && /BLOCKED/.test(logs[logs.length - 2]) && g9.counts().blocked_wallets.length === 1 && g9.counts().blocked_wallets[0].wallet === W1 && g9.counts().blocked_wallets[0].failures === 2, 'g9 the second failure blocks that wallet; the Console list names it with its count');
check(!g9.halted() && g9.counts().level === 1 && g9.counts().failed_wallets_24h === 1 && g9.counts().failed_24h === 2, 'g9 two failures from one wallet = ONE wallet: level 1, not armed, not halted');
t += 60_000;
g9.recordOpen('w1c:0', W1, 50000, 'lsps2'); g9.fail('w1c:0', 'z');
check(!g9.halted() && g9.counts().level === 1 && g9.counts().failed_24h === 3, 'g9 a third failure from the same wallet still does not halt JIT for everyone');
check(!g9.walletBlocked(W2) && !g9.walletBlocked('') && !g9.walletBlocked(undefined), 'g9 other wallets (and an unknown key) are not blocked');

// g10 — the halt is three DISTINCT wallets: W2 arms, W3 halts
t += 60_000;
g9.recordOpen('w2:0', W2, 50000, 'lnurlp'); g9.fail('w2:0', 'x');
check(g9.counts().armed && g9.counts().level === 2 && !g9.halted() && /ARMED/.test(logs[logs.length - 1]), 'g10 a second wallet: armed');
g9.recordOpen('w3:0', W3, 50000, 'push'); g9.fail('w3:0', 'x');
check(g9.halted() && g9.counts().halted.wallets === 3 && g9.counts().halted.count === 5 && /3 wallets/.test(logs[logs.length - 1]), 'g10 a third wallet: JIT off; the halt names 3 wallets and 5 opens');

// g11 — the operator releases ONE wallet: its block clears and its count starts afresh; the others stand; it survives a restart
const rw = g9.releaseWallet(W1, 'console 127.0.0.1');
check(rw.ok && !g9.walletBlocked(W1) && g9.counts().blocked_wallets.length === 0 && /RELEASED/.test(logs[logs.length - 1]), 'g11 the wallet released: not blocked, the list empty');
check(g9.releaseWallet(W1, 'x').ok === false && g9.releaseWallet('nonsense', 'x').ok === false, 'g11 releasing an unblocked wallet, or a non-key, is refused');
check(!createJitGuard({ dataDir: dir9, log, now }).walletBlocked(W1), 'g11 the wallet release survives a restart');
t += 60_000;
g9.recordOpen('w1d:0', W1, 50000, 'lsps2'); g9.fail('w1d:0', 'q');
check(!g9.walletBlocked(W1), 'g11 after its release one new failure does not re-block the wallet (the count started afresh)');

// g12 — a block expires 24 h after the wallet's last failure, on its own; the setting 0 switches blocks off
const g12 = createJitGuard({ log, now });
g12.recordOpen('e1:0', W2, 1, 'lsps2'); g12.fail('e1:0', 'x'); t += 1000; g12.recordOpen('e2:0', W2, 1, 'lsps2'); g12.fail('e2:0', 'x');
check(g12.walletBlocked(W2) && g12.counts().blocked_wallets[0].expires_at === t + 24 * 3600_000, 'g12 blocked, with the expiry 24 h after the last failure');
t += 24 * 3600_000 + 1;
check(!g12.walletBlocked(W2) && g12.counts().blocked_wallets.length === 0, 'g12 the block has expired on its own');
const g12b = createJitGuard({ log, now, walletAt: 0 });
g12b.recordOpen('f1:0', W2, 1, 'lsps2'); g12b.fail('f1:0', 'x'); g12b.recordOpen('f2:0', W2, 1, 'lsps2'); g12b.fail('f2:0', 'x'); g12b.recordOpen('f3:0', W2, 1, 'lsps2'); g12b.fail('f3:0', 'x');
check(!g12b.walletBlocked(W2) && !g12b.halted() && g12b.counts().level === 1, 'g12 JIT_GUARD_WALLET_AT=0: never blocks; one wallet never halts');
fs.rmSync(dir9, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? 'FAIL · jit-guard · ' + fails + ' failed' : 'PASS · jit-guard (g1–g12)');
process.exit(fails ? 1 : 0);
