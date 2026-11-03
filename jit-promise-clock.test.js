// 0.119.2 (S66, Mon 2026-11-02 — "JIT promise removal clock — write-up v1"): THE PROMISE CLOCK, as written in
// lij-adapter.js. Until 0.119.1 reapExpiredJitBuys() deleted every promise once the 10-minute QUOTE clock had passed, and
// ran only at the start of the next /lsps2/buy from any wallet — so a registered invoice (the page gives it 60 minutes)
// lost its promise the moment another wallet asked 11 minutes later. Now a promise with its invoice secret registered
// lives to the 24-hour RESERVATION clock, an unregistered ask still goes at the quote, the reaper also runs on the
// 10-minute timer, and two caps bound the memory: a wallet over its own cap loses its oldest idle promise (never a busy
// one), the provider's total cap refuses the ask.
//   node jit-promise-clock.test.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

// ── the finding, as the OLD reaper read (reconstructed from 0.119.1's text): every promise died at the quote clock ──
const OLD = `function reapExpiredJitBuys() {
  const now = Date.now();
  let reaped = 0;
  for (const [scid, entry] of pendingJitBuys.entries()) {
    if (now > entry.promise_expires_at) { pendingJitBuys.delete(scid); reaped++; }
  }
  return reaped;
}`;
check(!src.includes("if (now > entry.promise_expires_at) {\n      pendingJitBuys.delete(scid);\n      reaped++;"), 'the 0.119.1 reaper (every promise at the quote clock) is gone from the source');

// ── the block under test, as written ──
const m = src.match(/const JIT_PROMISE_CAPS = [\s\S]*?\/\/ ── end of the promise clock/);
check(!!m, 'the promise clock block is defined (JIT_PROMISE_CAPS, jitPromiseDeadline, reapExpiredJitBuys, jitPromiseBusy, jitPromiseRoom)');

const MIN = 60 * 1000, HOUR = 3600 * 1000;
const T0 = 1_762_100_000_000;   // a fixed "now" — the tests never wait
function world(perWallet, total) {
  const logs = [];
  const env = {
    pendingJitBuys: new Map(), promiseByPaymentHash: new Map(), inFlightOpens: new Set(), pendingHtlcsForOfflineWallets: new Map(),
    console: { log: (l) => logs.push(l), warn: (l) => logs.push(l) },
    process: { env: { LSPS2_MAX_LIVE_PROMISES_PER_WALLET: String(perWallet), LSPS2_MAX_LIVE_PROMISES: String(total) } },
    Date: { now: () => T0 },
    logs,
  };
  const f = new Function('pendingJitBuys', 'promiseByPaymentHash', 'inFlightOpens', 'pendingHtlcsForOfflineWallets', 'console', 'process', 'Date',
    m[0] + '\n; return { reap: reapExpiredJitBuys, room: jitPromiseRoom, busy: jitPromiseBusy, deadline: jitPromiseDeadline, caps: JIT_PROMISE_CAPS };')(
    env.pendingJitBuys, env.promiseByPaymentHash, env.inFlightOpens, env.pendingHtlcsForOfflineWallets, env.console, env.process, env.Date);
  return Object.assign(env, f);
}
// a promise exactly as /lsps2/buy stores it (the fields the clock reads), asked at `askedAt`
function promise(client, askedAt, registered) {
  const e = { mode: 'fixed', payment_size_msat: 100000000, fee_msat: 100000, client_pubkey: client, created_at: askedAt,
    promise_expires_at: askedAt + 10 * MIN, quote_expires_at: askedAt + 10 * MIN, reservation_expires_at: askedAt + 24 * HOUR };
  if (registered) e.payment_secret = Buffer.alloc(32, 1);
  return e;
}
const A = '02' + 'aa'.repeat(32), B = '02' + 'bb'.repeat(32);

// 1. a promise with a registered secret survives a new ask 11 minutes later (the finding's own case)
{
  const w = world(10, 2000);
  w.pendingJitBuys.set('a'.repeat(16), promise(A, T0 - 11 * MIN, true));
  const r = w.reap(T0);
  check(w.pendingJitBuys.has('a'.repeat(16)) && r.quotes === 0 && r.reservations === 0, 'a registered promise asked 11 minutes ago survives the reaper (0.119.1 deleted it)');
  // and the same promise in the OLD reaper's hands, to show the finding
  const oldReap = new Function('pendingJitBuys', 'Date', OLD + '\n; return reapExpiredJitBuys;')(w.pendingJitBuys, { now: () => T0 });
  check(oldReap() === 1 && !w.pendingJitBuys.has('a'.repeat(16)), '… and the 0.119.1 reaper, run on the same map, deletes it — the finding');
}
// 2. an ask with no secret is deleted after 10 minutes
{
  const w = world(10, 2000);
  w.pendingJitBuys.set('b'.repeat(16), promise(A, T0 - 11 * MIN, false));
  w.pendingJitBuys.set('c'.repeat(16), promise(A, T0 - 9 * MIN, false));
  const r = w.reap(T0);
  check(!w.pendingJitBuys.has('b'.repeat(16)) && w.pendingJitBuys.has('c'.repeat(16)) && r.quotes === 1, 'an unregistered ask goes at the quote clock: 11 min gone, 9 min kept');
}
// 3. a registered promise is deleted after 24 hours, and its hash index with it
{
  const w = world(10, 2000);
  const e = promise(A, T0 - 24 * HOUR - MIN, true); e._b16_hash = 'ff'.repeat(32);
  w.pendingJitBuys.set('d'.repeat(16), e); w.promiseByPaymentHash.set(e._b16_hash, { promise: e, scidHex: 'd'.repeat(16) });
  w.pendingJitBuys.set('e'.repeat(16), promise(A, T0 - 23 * HOUR, true));
  const r = w.reap(T0);
  check(!w.pendingJitBuys.has('d'.repeat(16)) && w.pendingJitBuys.has('e'.repeat(16)) && r.reservations === 1 && !w.promiseByPaymentHash.has('ff'.repeat(32)), 'a registered promise goes at the reservation clock (24 h + 1 min gone, 23 h kept), its hash index cleared');
  check(w.logs.some((l) => /Reaped 1 expired JIT promise\(s\): 0 unregistered past the quote clock, 1 registered past the reservation clock/.test(l)), 'the Reaped line says which clock');
  check(w.deadline(promise(A, T0, true)) === T0 + 24 * HOUR && w.deadline(promise(A, T0, false)) === T0 + 10 * MIN, 'jitPromiseDeadline: the reservation once registered, the quote until then');
}
// 4. the timer: the reaper runs on the 10-minute sweep, not only on the next ask
check(/reapExpiredJitBuys\(\);\s*\/\/ 0\.119\.2: the promise clock runs on the timer too/.test(src) && /walletCheckIpLimit\.sweep\(\); myChannelsKeyLimit\.sweep\(\); recoverCloseKeyLimit\.sweep\(\);[\s\S]{0,160}reapExpiredJitBuys\(\);[\s\S]{0,200}\}, 600000\);/.test(src), 'the 10-minute sweep calls the reaper');
check((src.match(/reapExpiredJitBuys\(\)/g) || []).length === 2, 'two calls: the sweep and /lsps2/buy');
check(/reapExpiredJitBuys\(\);\n\s*\/\/ 0\.119\.2: the caps[^\n]*\n\s*const room = jitPromiseRoom\(clientPubkey\);\n\s*if \(!room\.ok\) return errResponse\(res, room\.error, room\.code \|\| 429\);/.test(src), '/lsps2/buy reaps, then asks for room, and refuses with the plain message and code');
// 5. the caps
{
  const w = world(3, 2000);
  for (let i = 0; i < 3; i++) w.pendingJitBuys.set(String(i).repeat(16), promise(A, T0 - (30 - i) * MIN, true));   // oldest first: 30, 29, 28 min ago
  w.pendingJitBuys.set('9'.repeat(16), promise(B, T0 - MIN, true));
  check(w.room(B).ok === true && w.pendingJitBuys.size === 4, 'a wallet under its cap: room, nothing dropped');
  const r = w.room(A);
  check(r.ok === true && r.evicted === '0'.repeat(16) && !w.pendingJitBuys.has('0'.repeat(16)) && w.pendingJitBuys.has('1'.repeat(16)) && w.pendingJitBuys.has('9'.repeat(16)), 'a wallet at its cap: its OLDEST idle promise is dropped for the new ask; the other wallet\'s untouched');
  check(w.logs.some((l) => /promise cap: wallet 02aaaaaaaaaaaaaa… at 3 live promises \(LSPS2_MAX_LIVE_PROMISES_PER_WALLET 3\) — its oldest idle promise scid=0000000000000000 \(asked 30 min ago\) dropped/.test(l)), 'the journal names the drop');
}
{
  const w = world(2, 2000);
  const held = promise(A, T0 - 20 * MIN, true); const shards = promise(A, T0 - 15 * MIN, true); shards._shards = new Set(['x']);
  w.pendingJitBuys.set('h'.repeat(16), held); w.pendingJitBuys.set('s'.repeat(16), shards);
  w.pendingHtlcsForOfflineWallets.set('ph', { promise_ref: 'h'.repeat(16) });
  check(w.busy('h'.repeat(16), held) && w.busy('s'.repeat(16), shards), 'a promise a held payment names, or one with shards, is busy');
  const r = w.room(A);
  check(r.ok === false && r.code === 429 && /each one is in use/.test(r.error) && w.pendingJitBuys.size === 2, 'every promise busy: the ask is refused, nothing dropped');
  w.inFlightOpens.add('h'.repeat(16)); w.pendingHtlcsForOfflineWallets.clear();
  check(w.busy('h'.repeat(16), held), 'an open in flight is busy too');
  w.inFlightOpens.clear(); delete shards._shards;
  check(w.room(A).ok === true && !w.pendingJitBuys.has('h'.repeat(16)), 'once idle, the older one goes');
}
{
  const w = world(10, 3);
  for (let i = 0; i < 3; i++) w.pendingJitBuys.set(String(i).repeat(16), promise(i ? B : A, T0 - MIN, true));
  const r = w.room(A);
  check(r.ok === false && r.code === 429 && /too many open payment requests/.test(r.error) && w.pendingJitBuys.size === 3, 'the provider\'s total cap refuses the ask with the plain message');
  check(w.logs.some((l) => /promise cap: 3 live promises on this provider \(LSPS2_MAX_LIVE_PROMISES 3\)/.test(l)), 'the journal says so');
}
{
  const w = world(0, 0);
  for (let i = 0; i < 50; i++) w.pendingJitBuys.set(String(i).padStart(16, '0'), promise(A, T0 - MIN, true));
  check(w.room(A).ok === true && w.pendingJitBuys.size === 50, 'a cap set to 0 means no cap');
}
// 6. the defaults, the settings report, the boot line, the console column
check(/LSPS2_MAX_LIVE_PROMISES_PER_WALLET \|\| '10'/.test(src) && /LSPS2_MAX_LIVE_PROMISES \|\| '2000'/.test(src), 'defaults 10 per wallet, 2,000 in total');
check(/row\('Guardrails', 'promise reservation', 'LSPS2_RESERVATION_HOURS'/.test(src) && /row\('Guardrails', 'live promises per wallet', 'LSPS2_MAX_LIVE_PROMISES_PER_WALLET'/.test(src) && /row\('Guardrails', 'live promises in total', 'LSPS2_MAX_LIVE_PROMISES'/.test(src), 'the Settings report lists the reservation and both caps');
check(/\[JIT\] promise clock: quote \$\{CONFIG\.lsps2\.promise_validity_secs\} s/.test(src), 'the boot line states the clock and the caps (the ride receipt)');
check(/asked_s: Math\.round\(\(nowMs - \(pr\.created_at \|\| nowMs\)\) \/ 1000\)/.test(src), 'jitNowMemory carries asked_s');
const con = fs.readFileSync(require('path').join(__dirname, 'console.js'), 'utf8');
check(con.includes('<th>asked</th><th>reservation ends</th>') && !con.includes('<th>secret</th><th>expires</th>'), 'the console\'s JIT · now table: "asked" added, "expires" renamed "reservation ends"');
check(/var a=Number\(x\.asked_s\|\|0\);var at=ago\(Date\.now\(\)-a\*1000\);/.test(con) && con.includes('data-sort="\'+a+\'"') && con.includes('a>3600?\'<span class="dim" title="a LiJ invoice lasts 60 minutes'), 'the asked cell sorts by seconds and dims past 60 minutes');
if (fails) { console.log('FAIL · ' + fails); process.exit(1); } else console.log('PASS · jit-promise-clock.test.js');
