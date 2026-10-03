// 0.88.1 (S54, DP 2026-10-02 11:17 "make sure the push alert is accurate to the actual time it will be held"):
// every wake states the window ACTUALLY held, or none.
//   node wake-hold.test.js
// The adapter starts servers on require, so this reads the source (like decide.test.js): it evaluates sendWakePush and
// scheduleHtlcWatchdog as written, with their globals stubbed, and checks every wake site's shape.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const pushSrc = fs.readFileSync(path.join(__dirname, 'push.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

(async () => {
  // ── sendWakePush, as written ──
  const sw = src.match(/async function sendWakePush\(pubkeyHex, holdMsOverride, kind\) \{[\s\S]*?\n\}/);
  check(!!sw, 'sendWakePush is defined');
  const sent = [];
  const mk = (dialMs) => new Function('PUSH_ENABLED', 'walletLiveNow', 'pushSubs', 'webpush', 'clientHoldCapMs', 'persistPushSubs', 'global',
    sw[0] + '; return sendWakePush;')(true, async () => ({ live: false }), { ['02' + 'aa'.repeat(32)]: { endpoint: 'x' } },
    { sendNotification: async (sub, body, opts) => { sent.push({ body: JSON.parse(body), ttl: opts.TTL }); } },
    () => dialMs, () => {}, {});
  const PK = '02' + 'aa'.repeat(32);
  const quiet = console.log; console.log = () => {};
  let f = mk(21600000);
  const t0 = Date.now();
  await f(PK, 4 * 3600 * 1000 + 999);   // a held payment: 4 h (+999 ms) actually held, dial 6 h
  const w1 = sent.pop();
  f = mk(21600000); await f(PK, null);  // the uncertain resume: nothing held
  const w2 = sent.pop();
  f = mk(21600000); await f(PK, undefined, 'nwc');   // an NWC request
  const w3 = sent.pop();
  f = mk(21600000); await f(PK, 0);     // a zero window states nothing
  const w4 = sent.pop();
  f = mk(180000); await f(PK, 15 * 60 * 1000);   // the Push Key claim: 15 min, dial 3 min
  const w5 = sent.pop();
  console.log = quiet;
  check(w1 && w1.body.hold_s === 14400, 'a 4 h hold states 14,400 s — the window held, not the 6 h dial, rounded DOWN (got ' + (w1 && w1.body.hold_s) + ')');
  check(w1 && w1.body.until_ms >= t0 + 14400000 && w1.body.until_ms <= Date.now() + 14401000, 'until_ms is when the hold ends, from the call');
  check(w1 && w1.body.t === 'wake' && w1.ttl >= 14400 && w1.ttl <= 14401, 'kind wake; the push service keeps it for the window');
  check(w2 && !('hold_s' in w2.body) && !('until_ms' in w2.body) && w2.ttl === 21600, 'nothing held → no time stated (the dial is not quoted); TTL as before');
  check(w3 && w3.body.t === 'nwc' && !('hold_s' in w3.body), 'an NWC request states no hold');
  check(w4 && !('hold_s' in w4.body), 'a zero window states nothing');
  check(w5 && w5.body.hold_s === 900, 'a 15-minute claim states 15 minutes, not the 3-minute dial');

  // ── scheduleHtlcWatchdog returns the window it sets ──
  const wd = src.match(/function scheduleHtlcWatchdog\(paymentHashHex, autoFailHeight, capMs\) \{[\s\S]*?\n\}/);
  check(!!wd, 'scheduleHtlcWatchdog is defined');
  const set = [];
  const mkWd = (tip) => new Function('currentBlockHeight', 'CONFIG', 'OFFLINE_HOLD_CAP_MS', 'pendingHtlcsForOfflineWallets', 'resolvedHtlcHashes',
    'htlcInterceptor', 'htlcWatchdogs', 'SM', 'setTimeout', 'offlineHtlcsFailed', 'console',
    wd[0] + '; return scheduleHtlcWatchdog;')(tip, { lsps2: { htlc_safety_blocks: 6 } }, 43200000, new Map(), new Set(), null, new Map(),
    { emit: () => {} }, (fn, ms) => { set.push(ms); return 1; }, 0, { log: () => {}, warn: () => {} });
  const H = 'ab'.repeat(32);
  let r = mkWd(1000)(H, 1000 + 200, 21600000);   // 200 blocks of deadline, 6 h dial → the dial
  check(r === 21600000 && set.pop() === r, 'deadline far: the 6 h dial is held, and the number returned is the timer set');
  r = mkWd(1000)(H, 1000 + 32, 21600000);        // 32 − 6 − 2 = 24 blocks → 4 h
  check(r === 24 * 600000 && set.pop() === r, 'deadline near: the payment\'s own deadline cuts it to 4 h, and 4 h is returned (got ' + r + ')');
  r = mkWd(1000)(H, 1000 + 5, 21600000);
  check(r === 30000 && set.pop() === r, 'deadline past the safety blocks: the 30 s floor, returned as such');

  // ── every wake site ──
  const holds = src.match(/const _holdMs = scheduleHtlcWatchdog\([^;]*;[^\n]*\n\s*sendWakePush\([a-z_.]+, _holdMs\)\.catch/g) || [];
  check(holds.length === 5, 'the five held-payment wakes each state the watchdog\'s own window (found ' + holds.length + ')');
  check(!/sendWakePush\([a-z_.]+\)\.catch/.test(src), 'no wake is sent without a window or an explicit "none"');
  check(/sendWakePush\(c\.remote_pubkey, null\)\.catch\(\(\) => \{\}\);  \/\* v0\.41\.0: notify-on-uncertain-resume/.test(src), 'the uncertain resume (nothing held) states no time');
  check(/sendWakePush: \(pk, ms\) => sendWakePush\(pk, ms\), authOk/.test(src), 'the Push Key hook carries the number through');
  check(/if \(_lh > 0\) sendWakePush\(rec\.client_pubkey, _lh\)/.test(src), 'a Lightning-address payment to a wallet set to Off (returned at once) wakes nobody');
  check(/sendWakePush\(rec\.client_pubkey, CLAIM_HOLD_MS\)/.test(pushSrc), 'the Push Key claim wake states the claim window');
  check(!/sendWakePush\(rec\.client_pubkey\)\./.test(pushSrc), 'push.js has no dial-quoting wake left');
  check(!/: clientHoldCapMs\(key\);\n/.test(sw[0]) && !/hold_s: holdS/.test(sw[0]), 'the dial fallback in the payload is gone');

  if (fails) { console.log('FAIL · ' + fails); process.exit(1); }
  console.log('PASS · wake-hold');
})();
