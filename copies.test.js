// 0.93.0 (S57, DP 2026-10-07 "Go with … 3") — one open copy at a time: copies.js, and its wiring in lij-adapter.js.
//   node copies.test.js
const fs = require('fs');
const { CopyWatch } = require('./copies');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (c, m) => { if (!c) { fails++; console.log('FAIL · ' + m); } else ok(m); };
let T = 1_000_000;
const now = () => T;
const PK = '02' + 'aa'.repeat(32), A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);

// c1 — an unregistered session's heartbeat is ignored (nobody without the key can fake a copy)
let w = new CopyWatch({ now });
check(w.beat(PK, A, 1, 5) === null, 'c1 an unregistered heartbeat counts for nothing');
check(w.register('zz', A) === false && w.register(PK, 'short') === false, 'c1 a malformed key or session is not registered');
// c2 — one copy: no others
w.register(PK, A); T += 1000;
let v = w.beat(PK, A, 2, 7);
check(v && v.others.length === 0 && v.me.known === 2 && v.me.bn === 7, 'c2 one copy alone: no others');
// c3 — a second copy opens while the first is alive: both are told
T += 5000; w.register(PK, B);
check(w.lastOtherSeenS(PK, B) === 5, 'c3 the new copy learns another copy was seen 5 s ago (my-channels)');
T += 2000; v = w.beat(PK, B, 1, 5);
check(v.others.length === 0, 'c3 the new copy\'s first beat: the old one has not beaten since — not yet called open');
T += 8000; v = w.beat(PK, A, 2, 7);
check(v.others.length === 1 && v.others[0].known === 1 && v.others[0].bn === 5, 'c3 the old copy hears of the new one (known 1, bn 5)');
T += 3000; v = w.beat(PK, B, 1, 5);
check(v.others.length === 1 && v.others[0].known === 2 && v.others[0].bn === 7 && v.others[0].seen_s === 3, 'c3 the new copy hears of the old one (known 2, bn 7, 3 s ago)');
// c4 — the old copy closes: after the window the new one is alone again
T += 61_000; v = w.beat(PK, B, 1, 5);
check(v.others.length === 0, 'c4 61 s after the other copy\'s last beat: alone again');
// c5 — the app killed and reopened (a new session): never an alarm
w = new CopyWatch({ now }); T = 2_000_000;
w.register(PK, A); T += 1000; w.beat(PK, A, 1, 1);   // last beat, then killed
T += 4000; w.register(PK, C); T += 1000;
v = w.beat(PK, C, 1, 1);
check(v.others.length === 0, 'c5 a copy closed and reopened as a new session is not "another copy"');
// c6 — a reload in the same tab keeps its session: no duplicate
w.register(PK, C); T += 1000; v = w.beat(PK, C, 1, 1);
check(v.others.length === 0, 'c6 the same session registered again is the same copy');
// c7 — sessions forgotten after ten minutes
T += 11 * 60_000;
check(w.lastOtherSeenS(PK, B) === null && w.beat(PK, C, 1, 1) === null, 'c7 sessions are forgotten after ten minutes (a forgotten one re-registers at its next unlock)');
// c8 — another wallet's sessions never mix in
w = new CopyWatch({ now }); w.register(PK, A); w.register('03' + 'bb'.repeat(32), B); T += 1000;
w.beat('03' + 'bb'.repeat(32), B, 1, 1); v = w.beat(PK, A, 1, 1);
check(v.others.length === 0, 'c8 another wallet\'s copy is not this wallet\'s');

// the wiring
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
check(/require\('\.\/copies'\)/.test(src) && /new CopyWatch\(/.test(src), 'w1 the adapter keeps a CopyWatch');
const mc = src.slice(src.indexOf('async function handleMyChannels('), src.indexOf('function leaseForceClose('));
check(/copyWatch\.register\(pk, sid\)/.test(mc) && /other_copy_seen_s/.test(mc) && mc.indexOf('copyWatch.register') > mc.indexOf('registryNonceStore.consume'), 'w2 my-channels registers the session only after the signature and the nonce check');
const hl = src.slice(src.indexOf("if (path === '/health' && method === 'GET')"), src.indexOf("if (path === '/lsps/registry/my-channels'"));
check(/copyWatch\.beat\(/.test(hl) && /base\.copies = /.test(hl), 'w3 the heartbeat feeds the watch and the answer carries copies');
console.log(fails ? 'FAIL · copies · ' + fails + ' failed' : 'PASS · copies (c1–c8, w1–w3)');
process.exit(fails ? 1 : 0);
