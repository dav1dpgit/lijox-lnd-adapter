// 0.79.2 / 0.80.0 (S49) — the forward DECIDE: which peers are wallets, "inactive means hold", the hold on by default and
// reported (Settings, get_info, prefs), and the trampoline settling the state machine.
//   node decide.test.js
// The adapter is one module that starts servers on require, so this reads the source: it evaluates
// isClientChannel as written (with a world peer set), and checks the DECIDE block's shape — the public-
// channel RESUME first, the active RESUME second, then straight to the B-1 hold gates; the peers-cache
// RESUME (the 2026-09-24 00:09:48 fail-back) must not exist.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

// ── isClientChannel, as written ──
const m = src.match(/function isClientChannel\(c\) \{[\s\S]*?\n\}/);
check(!!m, 'isClientChannel is defined');
const WORLD = '02ab'.padEnd(66, 'c');
const isClientChannel = new Function('LEASE_WORLD_PEER', m[0] + '; return isClientChannel;')(WORLD);
check(isClientChannel({ private: true, remote_pubkey: '02aa' }) === true, 'a private channel to a wallet → client');
check(isClientChannel({ private: false, remote_pubkey: '02aa' }) === false, 'a public channel → not a client (a routing node or a provider)');
check(isClientChannel({ private: true, remote_pubkey: WORLD.toUpperCase() }) === false, 'the operator\'s world conduit, though private → not a client');
check(isClientChannel(null) === false && isClientChannel({}) === false, 'no channel / no flag → not a client');
const noWorld = new Function('LEASE_WORLD_PEER', m[0] + '; return isClientChannel;')('');
check(noWorld({ private: true, remote_pubkey: WORLD }) === true, 'with no world peer set, every private channel is a client channel');

// ── the DECIDE block's shape ──
const start = src.indexOf("const _dtHash = req.payment_hash ? Buffer.from(req.payment_hash).toString('hex').slice(0, 16) : '????';");
const end = src.indexOf('evaluating B-1 hold gates', start);
check(start > 0 && end > start, 'the DECIDE block is where it was');
const block = src.slice(start, end);
const resumes = block.split('return RESUME;').length - 1;
check(resumes === 2, 'exactly two RESUMEs before the hold gates (public channel; channel active) — got ' + resumes);
check(block.indexOf('if (!isClientChannel(c))') < block.indexOf('if (c.active)'), 'the public-channel RESUME comes before the active check');
check(!/peer LISTED by LND; peers-cache age/.test(src), 'the peers-cache RESUME is gone from the file');
check(/channel INACTIVE by LND \(peer \$\{fwdListed/.test(block), 'the inactive line names the peers list as flavour only');
const holdPart = src.slice(end, end + 1600);
check(/const fwdMargin = fwdAutoFail - fwdTip;/.test(holdPart) && /HOLDING \(cap/.test(holdPart) && /cannot hold \(enabled=/.test(holdPart), 'the B-1 gates follow unchanged (margin, HOLDING, the cannot-hold RESUME)');
// a public channel must not reach the wake push in the DECIDE
const pub = block.slice(block.indexOf('if (!isClientChannel(c))'), block.indexOf('if (c.active)'));
check(!/sendWakePush/.test(pub), 'the public-channel branch sends no wake');

// ── 0.80.0: the hold is on by default; the report, get_info and prefs say so; the trampoline settles the census ──
check(/const OFFLINE_HOLD_ENABLED = process\.env\.LSPS2_OFFLINE_HOLD_ENABLED !== 'false';/.test(src), 'the offline hold is ON unless the operator writes false');
check(/row\('Offline hold', 'hold for offline wallets', 'LSPS2_OFFLINE_HOLD_ENABLED'/.test(src) && /row\('Offline hold', 'ceiling', 'LSPS2_OFFLINE_HOLD_CAP_MS'/.test(src) && /row\('Offline hold', 'CLTV headroom', 'LSPS2_OFFLINE_MIN_HEADROOM_BLOCKS'/.test(src), 'the Settings report lists the three hold dials');
check(/offline_hold:\s+\{ enabled: OFFLINE_HOLD_ENABLED, cap_ms: OFFLINE_HOLD_CAP_MS, headroom_blocks: OFFLINE_MIN_HEADROOM_BLOCKS \}/.test(src), 'get_info carries offline_hold {enabled, cap_ms, headroom_blocks}');
check(/hold_ms_effective: OFFLINE_HOLD_ENABLED \? eff : 0, lsp_cap_ms: OFFLINE_HOLD_CAP_MS, hold_enabled: OFFLINE_HOLD_ENABLED/.test(src), 'the prefs answer says hold_enabled and answers 0 when the provider does not hold');
check(/cannot hold \(enabled=\$\{OFFLINE_HOLD_ENABLED\}, wallet dial=/.test(src), 'the cannot-hold line names the wallet\'s dial');
check((src.match(/SM\.emit\('trampoline'/g) || []).length === 4, 'the trampoline reports start, the two failures and the success to the state machine');
// the state machine, run for real: a hold delivered by the trampoline ends SETTLED, a failed one returns to HOLDING
{
  const SM = require(require('path').join(__dirname, 'lij-sm.js'));
  const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
  SM.emit('hold_created', { hash: H1, cap_ms: 1000 }); SM.emit('watchdog_scheduled', { hash: H1, in_ms: 1000 });
  SM.emit('trampoline', { hash: H1, phase: 'start' });
  check(SM.lookup(H1).state === 'FORWARDING', 'SM: trampoline start → FORWARDING');
  SM.emit('trampoline', { hash: H1, ok: true });
  check(SM.lookup(H1).state === 'SETTLED' && !SM.snapshot().some((i) => i.hash === H1), 'SM: trampoline ok → SETTLED, gone from the census');
  SM.emit('hold_created', { hash: H2, cap_ms: 1000 }); SM.emit('watchdog_scheduled', { hash: H2, in_ms: 1000 });
  SM.emit('trampoline', { hash: H2, phase: 'start' }); SM.emit('trampoline', { hash: H2, ok: false });
  check(SM.lookup(H2).state === 'HOLDING', 'SM: trampoline not ok → back to HOLDING for the replay path');
  SM.emit('resumed', { hash: H2 });
  check(SM.lookup(H2).state === 'RESUMED', 'SM: the replay RESUME ends it');
}

if (fails) { console.log('GATE FAIL · ' + fails); process.exit(1); }
console.log('GATE PASS: DECIDE 0.79.2/0.80.0 — public channel → plain RESUME; active → RESUME; inactive → the B-1 hold gates; the hold on by default and reported; the trampoline settles the census');
