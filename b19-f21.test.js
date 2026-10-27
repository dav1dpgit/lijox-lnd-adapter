// 0.117.0 (S63, Kimi round 2 — DP's 19:13 rulings): B-19 (b) — the early-arrival sibling rescue binds only a JIT
// invoice's own shard (the secret gate; the promise named by jit_scid; the B-11 window timer armed), the trampoline
// skips a JIT invoice's hash; F21 — one channel open per wallet at a time on the delivery rail, the reserve counting
// opens in flight, LND's pending list read before a second open, the JIT interceptor path untouched. A source test
// (the paths run inside the monolith); the stand-in boot in build_01170.py drives the registration route.
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/lij-adapter.js', 'utf8');
let passed = 0, failed = 0; const t = (n, ok) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n); } };
const slice = (start, end) => { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i); return j < 0 ? src.slice(i) : src.slice(i, j); };
// ── B-19 (b) ──
const reg = slice("if (body && body.payment_hash && !body.jit_channel_scid) {", "const scid = (body && body.jit_channel_scid || '')");
t('the hash store keeps jit_scid (16 lowercase hex, else 400)', /const jitScid = String\(\(body && body\.jit_scid\) \|\| ''\)\.toLowerCase\(\)\.trim\(\);/.test(reg) && /if \(jitScid && !\/\^\[0-9a-f\]\{16\}\$\/\.test\(jitScid\)\) return errResponse/.test(reg) && /jitScid \? \{ jit_scid: jitScid \} : \{\}/.test(reg));
t('a repeat registration may add the jit_scid to an entry that had none', /if \(jitScid && !prior\.jit_scid\) \{ prior\.jit_scid = jitScid; \}/.test(reg));
const tramp = slice("if (held.kind === 'forward') {", "if (invSec && (!held.entries || held.entries.length === 1)) {");
t('the trampoline skips a hash entry that carries jit_scid (a JIT invoice\'s shard is never paid as a partial)', /const invSec = \(invSec0 && invSec0\.jit_scid\) \? null : invSec0;/.test(tramp));
const b19 = slice("B-19: early-arrival sibling rescue", "if (inFlightOpens.has(_sc)) {");
t('B-19 picks the promise the hash entry names (jit_scid) when it has one, else the peer\'s sole fixed promise', /if \(_reg && _reg\.jit_scid && pendingJitBuys\.has\(_reg\.jit_scid\)\) \{/.test(b19) && /\} else\n\s*for \(const \[_psc, _ppr\] of pendingJitBuys\) \{/.test(b19));
t('THE SECRET GATE: the bind needs the registered secret to equal the promise\'s (a plain invoice can never match)', /const _secretOk = !!\(_reg && _pr\.payment_secret && Buffer\.isBuffer\(_pr\.payment_secret\) && String\(_reg\.payment_secret \|\| ''\)\.toLowerCase\(\) === _pr\.payment_secret\.toString\('hex'\)\);/.test(b19) && /if \(!_secretOk\) \{[\s\S]*?\} else if \(!_plausible\) \{/.test(b19));
t('the secret gate sits before the plausibility gate and both refusals fall through to the offline evaluation', b19.indexOf('if (!_secretOk) {') < b19.indexOf('} else if (!_plausible) {') && /falling through to offline evaluation \(0\.117\.0\)/.test(b19));
t('B-19 arms the B-11 window timer when it creates the aggregate (agg_window_s + 250 ms; FAIL all + reset when short)', /_pr\._agg_deadline = Date\.now\(\) \+ \(CONFIG\.lsps2\.agg_window_s \* 1000\);[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?B-11 window \(armed by B-19\) closed short[\s\S]*?action: 'FAIL', failure_code: 15[\s\S]*?\}, CONFIG\.lsps2\.agg_window_s \* 1000 \+ 250\);/.test(b19));
// ── F21 ──
const dtw = slice("const deliverOpening = new Map();", "// 0.83.0 (S49, DP GO — PUSH KEY, the first field finding)");
t('deliverOpening: a record per wallet with the funding; the reserve helper sums them', /const deliverOpening = new Map\(\);/.test(dtw) && /function deliverReservedFundingSats\(\) \{ let s = 0; for \(const o of deliverOpening\.values\(\)\) s \+= Number\(o\.sizeSats\) \|\| 0; return s; \}/.test(dtw));
t('a second caller while an open is in flight (under 90 s) answers retry — never a second open', /if \(_op && Date\.now\(\) - _op\.at < DELIVER_OPEN_HOLD_MS\) \{[\s\S]*?return \{ kind: 'retry', reason: 'an open to this wallet is in flight' \};/.test(dtw) && /const DELIVER_OPEN_HOLD_MS = 90000;/.test(dtw));
t('after a deadline (and ONLY then) LND\'s pending channels to the wallet are read (jitPendingOpensToPeer) — one there means wait, none means open again', /if \(!_op\.deadline\) \{[\s\S]*?return \{ kind: 'retry', reason: 'an open to this wallet is in flight' \};[\s\S]*?_pendingToPeer = await jitPendingOpensToPeer\(client\);[\s\S]*?if \(_pendingToPeer > 0\) \{[\s\S]*?return \{ kind: 'retry', reason: 'a channel to this wallet is already opening' \};[\s\S]*?opening again[\s\S]*?deliverOpening\.delete\(client\);/.test(dtw) && (dtw.match(/jitPendingOpensToPeer\(client\)/g) || []).length === 1);
t('the reserve check counts the opens in flight', /jitReserveOk\(sizeSats \+ deliverReservedFundingSats\(\), jitTag \|\| T\)/.test(dtw));
t('the record is set before openChannelSync and cleared after the call returns (listed or not); a deadline keeps it', /deliverOpening\.set\(client, \{ at: Date\.now\(\), sizeSats, tag: T, deadline: false \}\);\n\s*try \{\n\s*leaseRememberWalletPeer\(client\);/.test(dtw) && /if \(\/DEADLINE\|deadline\|timed\? \?out\/i\.test\(String\(e\.message \|\| e\)\)\) \{ const o = deliverOpening\.get\(client\); if \(o\) o\.deadline = true; \}[\s\S]*?else deliverOpening\.delete\(client\);/.test(dtw) && /deliverOpening\.delete\(client\);   \/\/ 0\.117\.0 \(F21\): the open call returned/.test(dtw));
t('a listed channel clears a stale record at the top', /if \(chan && deliverOpening\.has\(client\)\) deliverOpening\.delete\(client\);/.test(dtw));
t('the order inside the JIT branch: the fee floor, the guard, the in-flight lock, the pending read, the reserve, the open', (() => { const a = dtw.indexOf("amount under opening fee"), b = dtw.indexOf("jitGuard.walletBlocked(client)"), c = dtw.indexOf("const _op = deliverOpening.get(client);"), d = dtw.indexOf("jitPendingOpensToPeer(client)"), e = dtw.indexOf("jitReserveOk(sizeSats + deliverReservedFundingSats()"), f = dtw.indexOf("await openChannelSync("); return a < b && b < c && c < d && d < e && e < f; })());
// the JIT interceptor path untouched
const ocf = slice("async function openChannelAndForward(req, promise, scidHex, paymentHashHex) {", "async function findChannelScid(");
t('openChannelAndForward (the JIT interceptor path) does not read deliverOpening — untouched, as promised', !/deliverOpening/.test(ocf) && /jitReserveOk\(/.test(ocf));
t('the console snapshot lists the opens in flight', /deliver_opening: \[\.\.\.deliverOpening\.entries\(\)\]/.test(src));
console.log((failed ? 'FAIL' : 'PASS') + ' · b19-f21 · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
