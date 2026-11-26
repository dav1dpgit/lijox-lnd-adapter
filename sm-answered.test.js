'use strict';
// 0.140.0 (S72, the operator's word of 2026-11-25 "Proceed with in flight repairs"): THE WATCH-ONLY LIST LEARNS OF EVERY
// ANSWER THE ADAPTER WRITES TO LND — lij-sm.js `answered`, `hold_refused`, and a new entry for a further try of a hash.
//   node sm-answered.test.js
// Field, 2026-11-24: `[SM-STATE] 1 in flight · 45988f7b800f8aed:INTERCEPTED@62s` a minute after LND had settled that
// Lightning payment. The adapter had handed it straight back to LND and told the list nothing.
const fs = require('fs'); const path = require('path');
let fails = 0;
const check = (c, m, extra) => { if (!c) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 500) : '')); } else console.log('  ok · ' + m); };
const lines = []; const realLog = console.log;
const fresh = () => { delete require.cache[require.resolve('./lij-sm.js')]; lines.length = 0; return require('./lij-sm.js'); };
const quiet = (fn) => { console.log = (m) => { lines.push(String(m)); }; try { return fn(); } finally { console.log = realLog; } };
const H = (c) => c.repeat(64);
const has = (re) => lines.some((l) => re.test(l));

// s: the source
const A = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8'); const G = fs.readFileSync(path.join(__dirname, 'lnd-grpc.js'), 'utf8'); const S = fs.readFileSync(path.join(__dirname, 'lij-sm.js'), 'utf8');
check(A.includes("try { SM.emit('answered', { ck: String((ck && ck.chan_id) || '0') + ':' + String((ck && ck.htlc_id) || '0'), action: String(action || '') }); } catch (_) {}") && A.includes('sentWatch.noteResolution(ck, action);'),
  's1 the adapter passes every answer written to LND on to the list, beside the note it already kept');
check(G.includes("if (hooks && typeof hooks.onResolve === 'function') hooks.onResolve(resp.incoming_circuit_key, resp.action);") && (G.match(/noteAnswer\(/g) || []).length >= 3,
  's2 the interceptor wrapper tells its caller of an answer wherever one is written (the handler\'s return and the later writes)');
check(S.includes("&& Date.now() - it.entered_at > 90000") && S.includes("transition(it, 'PASSTHROUGH', 'aged out"), 's3 the 90-s rule is still there as the backstop');
check(!/lndPost|lndGet|require\('http|fetch\(/.test(S), 's4 the list still only watches: no LND call, no network');

// t1 a forward handed straight back
let SM = fresh();
quiet(() => { SM.emit('htlc_intercepted', { hash: H('a'), scid: '1', in_msat: '102204', ck: '900:1' }); });
check(SM.snapshot().length === 1 && SM.lookup(H('a')).state === 'INTERCEPTED', 't1 a payment LND shows the adapter is on the list');
quiet(() => { SM.emit('answered', { ck: '900:1', action: 'RESUME' }); });
check(SM.snapshot().length === 0 && SM.lookup(H('a')).state === 'PASSTHROUGH' && has(/\[SM-TRANS\] a{16} · → PASSTHROUGH \(handed back to LND\)/), 't1 handed back to LND, it leaves the list AT ONCE — no minute of "in flight"', lines);
check(!has(/VIOLATION|NOTE/), 't1 and nothing is flagged', lines.filter((l) => /VIOLATION|NOTE/.test(l)));

// t2 a further try of the same hash is a new entry
lines.length = 0;
quiet(() => { SM.emit('htlc_intercepted', { hash: H('a'), scid: '1', in_msat: '102204', ck: '900:2' }); SM.emit('hold_created', { hash: H('a'), cap_ms: 60000 }); SM.emit('watchdog_scheduled', { hash: H('a'), in_ms: 60000 }); });
check(SM.lookup(H('a')).state === 'HOLDING' && SM.snapshot().length === 1 && !has(/VIOLATION/), 't2 a further try of that hash (a new circuit) starts a new entry and can be held — it is not an event on the finished one', lines.filter((l) => /VIOLATION/.test(l)));
quiet(() => { SM.emit('answered', { ck: '900:2', action: 'RESUME' }); });
check(SM.lookup(H('a')).state === 'HOLDING', 't2 a held entry is not ended by an answer: its own events end it');
quiet(() => { SM.emit('resumed', { hash: H('a') }); });
check(SM.lookup(H('a')).state === 'RESUMED' && SM.snapshot().length === 0, 't2 (the replay\'s own event ends it, as before)');

// t3 two parts
SM = fresh();
quiet(() => { SM.emit('htlc_intercepted', { hash: H('b'), in_msat: '5', ck: '7:1' }); SM.emit('htlc_intercepted', { hash: H('b'), in_msat: '5', ck: '7:2' }); SM.emit('answered', { ck: '7:1', action: 'RESUME' }); });
check(SM.lookup(H('b')).state === 'AGGREGATING' && SM.snapshot().length === 1, 't3 two parts, one handed back: the other is still with the adapter and the entry stays');
quiet(() => { SM.emit('answered', { ck: '7:2', action: 'RESUME' }); });
check(SM.lookup(H('b')).state === 'PASSTHROUGH' && !has(/VIOLATION/), 't3 the second handed back: the entry ends');

// t4 refused at the door
SM = fresh();
quiet(() => { SM.emit('htlc_intercepted', { hash: H('c'), in_msat: '5', ck: '8:1' }); SM.emit('hold_refused', { hash: H('c'), why: 'arrived short' }); SM.emit('answered', { ck: '8:1', action: 'FAIL' }); });
check(SM.lookup(H('c')).state === 'FAILED' && has(/→ FAILING \(refused at the door: arrived short\)/) && !has(/unknown event/), 't4 a part refused at the door and failed back: FAILED with its reason — and `hold_refused` is no longer an unknown event', lines);
SM = fresh();
quiet(() => { SM.emit('htlc_intercepted', { hash: H('d'), in_msat: '5', ck: '8:2' }); SM.emit('answered', { ck: '8:2', action: 'FAIL' }); });
check(SM.lookup(H('d')).state === 'FAILED' && has(/failed back by the adapter/), 't4 a part failed back without a named reason: FAILED too');

// t5 a promise is ended by its own events
SM = fresh();
quiet(() => { SM.emit('htlc_intercepted', { hash: H('e'), in_msat: '5', ck: '9:1' }); SM.emit('shard_registered', { hash: H('e') }); SM.emit('answered', { ck: '9:1', action: 'RESUME' }); });
check(SM.lookup(H('e')).state === 'AGGREGATING', 't5 an entry tied to a channel-open promise is not ended by a hand-back');
quiet(() => { SM.emit('htlc_intercepted', { hash: H('f'), in_msat: '5', ck: '9:2' }); SM.emit('htlc_intercepted', { hash: H('f'), in_msat: '5', ck: '9:3' }); SM.emit('shard_registered', { hash: H('f') }); SM.emit('hold_refused', { hash: H('f'), why: 'arrived short' }); SM.emit('answered', { ck: '9:2', action: 'FAIL' }); });
check(SM.lookup(H('f')).state === 'AGGREGATING', 't5 a set refused, one part failed back so far: not ended yet');
quiet(() => { SM.emit('answered', { ck: '9:3', action: 'FAIL' }); });
check(SM.lookup(H('f')).state === 'FAILED', 't5 every part of the refused set failed back: FAILED (it used to stay on the list for good)');

// t6 settled parts are left to the settle events
SM = fresh();
quiet(() => { SM.emit('htlc_intercepted', { hash: H('1'), in_msat: '5', ck: '10:1' }); SM.emit('answered', { ck: '10:1', action: 'SETTLE' }); });
check(SM.lookup(H('1')).state === 'INTERCEPTED', 't6 a SETTLE answer does not end an entry here');
quiet(() => { SM.emit('settle', { hash: H('1') }); });
check(SM.lookup(H('1')).state === 'SETTLED', 't6 the settle event does, as before');

// t7 strangers
SM = fresh();
let threw = false;
try { quiet(() => { SM.emit('answered', { ck: '77:7', action: 'RESUME' }); SM.emit('answered', {}); SM.emit('hold_refused', { hash: H('9'), why: 'x' }); SM.emit('hold_refused', {}); }); } catch (e) { threw = true; }
check(!threw && SM.snapshot().length === 0 && !has(/VIOLATION|unknown event|handler error/), 't7 an answer for a circuit the list never saw, or a refusal for a hash it never saw: nothing happens', lines);

console.log(fails ? `FAIL · sm-answered.test.js · ${fails} failed` : 'PASS · sm-answered.test.js (s1–s4, t1–t7)');
process.exit(fails ? 1 : 0);
