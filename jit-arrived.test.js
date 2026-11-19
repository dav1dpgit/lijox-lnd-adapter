// 0.130.1 — THE ARRIVED-AMOUNT RULE, as written in lij-adapter.js. An intercepted HTLC says what ARRIVED on it
// (incoming_amount_msat) and what its onion asks this node to send on (outgoing_amount_msat). A JIT open, and every
// delivery the adapter pays with an HTLC of its own, must never pay on more than arrived. The functions are lifted
// out of the adapter's own source and run with stand-ins for what they touch.
//   node jit-arrived.test.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra ? ' — ' + extra : '')); } else ok(m); };
const lift = (re, name) => { const m = src.match(re); if (!m) { fails++; console.log('FAIL · cannot find ' + name + ' in lij-adapter.js'); return ''; } return m[0]; };

const RULE = lift(/\/\/ ── the arrived-amount rule \(0\.130\.1\)[\s\S]*?\/\/ ── end of the arrived-amount rule/, 'the rule block');
const rule = new Function(RULE + '\n; return { htlcArrivedMsat, htlcAskedMsat, htlcArrivedShort, setArrivedShort, shardsArrivedMsat };')();
const sat = (n) => String(BigInt(n) * 1000n);   // sats → msat, as LND sends it (a string)
const ck = (n) => ({ chan_id: '900000', htlc_id: String(n) });

// ── A. the rule itself ──
check(rule.htlcArrivedShort({ incoming_amount_msat: sat(1000), outgoing_amount_msat: sat(1000000) }) === true, 'A1 the payer\'s onion asks for 1,000,000 sats and 1,000 arrived: short');
check(rule.htlcArrivedShort({ incoming_amount_msat: sat(1000000), outgoing_amount_msat: sat(1000000) }) === false, 'A2 as much arrived as is asked on: not short');
check(rule.htlcArrivedShort({ incoming_amount_msat: sat(1000001), outgoing_amount_msat: sat(1000000) }) === false, 'A3 more arrived than is asked on (a fee was left): not short');
check(rule.htlcArrivedShort({ incoming_amount_msat: '999999999', outgoing_amount_msat: '1000000000' }) === true, 'A4 one millisat short is short');
for (const v of [undefined, null, '', '0', 0]) check(rule.htlcArrivedShort({ incoming_amount_msat: v, outgoing_amount_msat: '1' }) === true, 'A5 no arrived amount (' + JSON.stringify(v) + ') is short');
check(rule.htlcArrivedShort({ outgoing_amount_msat: '0' }) === true && rule.htlcArrivedShort(null) === true, 'A6 an HTLC with nothing arrived is short even when nothing is asked');
check(rule.htlcArrivedShort({ incoming_amount_msat: 'abc', outgoing_amount_msat: '5' }) === true, 'A7 an arrived amount that is not a number is short');
check(rule.htlcArrivedShort({ incoming_amount_msat: '18446744073709551615', outgoing_amount_msat: '18446744073709551614' }) === false, 'A8 amounts above 2^53 are compared exactly');
check(rule.setArrivedShort(1000n, 900n, 100n) === false && rule.setArrivedShort(999n, 900n, 100n) === true, 'A9 a set: arrived must cover what is paid on plus the fee, to the millisat');
check(rule.setArrivedShort('1000', '900', '100') === false && rule.setArrivedShort(1000n, '1000', 1) === true, 'A10 … whatever form the amounts come in');
{
  const m = new Map([['a', { msat: 500n, in_msat: 500n }], ['b', { msat: 500n }], ['c', { msat: 1n, in_msat: 7n }]]);
  check(rule.shardsArrivedMsat(m) === 507n && rule.shardsArrivedMsat(null) === 0n, 'A11 a set\'s arrived sum: each part\'s own; a part with none counts as nothing');
}

// what the lifted functions may touch
const world = () => {
  const w = { writes: [], emits: [], reached: [], sent: [], logs: [] };
  w.SM = { emit: (n, o) => w.emits.push([n, o]) };
  w.console = { log: (...a) => w.logs.push(a.join(' ')), warn: (...a) => w.logs.push(a.join(' ')), error: (...a) => w.logs.push(a.join(' ')) };
  w.htlcInterceptor = { getCounters: () => ({ _lastWrite: (r) => w.writes.push(r) }) };
  w.promiseByPaymentHash = new Map(); w.resolvedHtlcHashes = new Set(); w.inFlightOpens = new Set();
  return w;
};

// ── B. THE DOOR of the interceptor's handler ──
{
  const HANDLER = lift(/async function handleInterceptedHtlc\(req\) \{[\s\S]*?\n\}\n/, 'handleInterceptedHtlc');
  const mk = (w) => new Function('SM', 'console', 'jitInflight', RULE + '\n' + HANDLER + '\n; return handleInterceptedHtlc;')(w.SM, w.console, { get: () => { w.reached.push('past the door'); throw new Error('stop here'); } });
  let w = world();
  const hash = Buffer.from('ab'.repeat(32), 'hex');
  mk(w)({ incoming_circuit_key: ck(1), payment_hash: hash, incoming_amount_msat: sat(1000), outgoing_amount_msat: sat(1000000), outgoing_requested_chan_id: '123' }).then((r) => {
    check(r && r.action === 'FAIL' && r.failure_code === 15 && r.incoming_circuit_key.htlc_id === '1', 'B1 the door fails back an HTLC whose onion asks for more than arrived (FAIL, code 15)', JSON.stringify(r));
    check(w.reached.length === 0, 'B2 … before any path of the handler is entered');
    check(w.emits.some((e) => e[0] === 'hold_refused' && e[1].why === 'arrived short') && w.logs.some((l) => /SHORT: an HTLC arrived with 1000000 msat and its onion asks 1000000000 msat/.test(l)), 'B3 … and says so in the journal');
    w = world();
    return mk(w)({ incoming_circuit_key: ck(2), payment_hash: hash, incoming_amount_msat: sat(1000000), outgoing_amount_msat: sat(1000000), outgoing_requested_chan_id: '123' });
  }).then((r) => {
    check(w.reached.length === 1 && !(r && r.action === 'FAIL' && w.emits.some((e) => e[0] === 'hold_refused')), 'B4 an HTLC that arrived whole goes past the door');
  }).catch((e) => { fails++; console.log('FAIL · B threw: ' + e.message); }).then(partC);
}

// ── C. the variable path, per part ──
function partC() {
  const VAR = lift(/function handleVariableShard\(req, promise, outgoingScidHex, paymentHashHex\) \{[\s\S]*?\n\}\n/, 'handleVariableShard');
  const mk = (w) => new Function('SM', 'console', 'CONFIG', 'currentBlockHeight', 'promiseByPaymentHash', 'resolvedHtlcHashes', 'flushVariable', 'htlcInterceptor', 'setTimeout', 'clearTimeout',
    RULE + '\n' + VAR + '\n; return handleVariableShard;')(w.SM, w.console, { lsps2: { min_shard_msat: '1000', htlc_safety_blocks: 6, variable_quiesce_ms: 1000 } }, 0, w.promiseByPaymentHash, w.resolvedHtlcHashes,
    async () => {}, w.htlcInterceptor, () => 1, () => {});
  let w = world(); let promise = { mode: 'variable' };
  let r = mk(w)({ incoming_circuit_key: ck(1), incoming_amount_msat: sat(1000), outgoing_amount_msat: sat(1000000), outgoing_expiry: '900100', auto_fail_height: '900090' }, promise, 'aabb', 'cd'.repeat(32));
  check(r && r.action === 'FAIL' && r.failure_code === 15 && !promise._shards, 'C1 the variable path fails back a short part and records nothing', JSON.stringify(r));
  w = world(); promise = { mode: 'variable' };
  r = mk(w)({ incoming_circuit_key: ck(2), incoming_amount_msat: sat(1000010), outgoing_amount_msat: sat(1000000), outgoing_expiry: '900100', auto_fail_height: '900090' }, promise, 'aabb', 'cd'.repeat(32));
  const sh = promise._shards && promise._shards.get('900000:2');
  check(r === null && sh && sh.msat === 1000000000n && sh.in_msat === 1000010000n && promise._shard_sum_msat === 1000000000n, 'C2 an honest part is held, and its record keeps what arrived beside what is asked');
  partE();
}

// ── E. the open: the whole set, before anything opens ──
function partE() {
  const OPEN = lift(/async function openChannelAndForward\(req, promise, scidHex, paymentHashHex\) \{[\s\S]*?\n\}\n/, 'openChannelAndForward');
  const SIB = lift(/function jitFailSiblings\(promise, req, why\) \{[\s\S]*?\n\}\n/, 'jitFailSiblings');
  const mk = (w) => new Function('SM', 'console', 'jitGuard', 'isPeerConnected', 'htlcInterceptor', 'promiseByPaymentHash', 'resolvedHtlcHashes',
    'let trampolineForwardsAttempted = 0, trampolineForwardsFailed = 0;\n' + RULE + '\n' + SIB + '\n' + OPEN + '\n; return openChannelAndForward;')(
    w.SM, w.console, { halted: () => false, walletBlocked: () => false, fail: () => {} }, async () => { w.reached.push('the peer check'); return false; }, w.htlcInterceptor, w.promiseByPaymentHash, w.resolvedHtlcHashes);
  const H = 'ef'.repeat(32);
  const run = async (req, promise) => { const w = world(); const r = await mk(w)(req, promise, 'aabb', H); return { w, r, promise }; };
  (async () => {
    // one HTLC, the payer's onion asks for more than arrived
    let t = await run({ incoming_circuit_key: ck(1), incoming_amount_msat: sat(1000), outgoing_amount_msat: sat(1000000) }, { client_pubkey: '02' + 'aa'.repeat(32), fee_msat: sat(2000) });
    check(t.r && t.r.action === 'FAIL' && t.w.reached.length === 0, 'E1 one HTLC asking 1,000,000 sats on with 1,000 arrived: FAIL, and nothing after the check runs (no channel is opened)', JSON.stringify(t.r));
    check(t.w.logs.some((l) => /SHORT set for scid=aabb: 1000000 msat arrived, 998000000 msat to pay on \+ 2000000 msat fee/.test(l)), 'E2 … the journal names what arrived, what would be paid on and the fee');
    // one honest HTLC goes on to the next step
    t = await run({ incoming_circuit_key: ck(1), incoming_amount_msat: sat(1000000), outgoing_amount_msat: sat(1000000) }, { client_pubkey: '02' + 'aa'.repeat(32), fee_msat: sat(2000) });
    check(t.w.reached.length === 1, 'E3 one HTLC that arrived whole goes on to the open\'s next step');
    // a set: one part honest, one whose onion asks for 500,000 with 1,000 arrived
    const set = (parts) => { const m = new Map(); let sum = 0n; parts.forEach((p, i) => { m.set('900000:' + (i + 1), { incoming_circuit_key: ck(i + 1), msat: p.out, in_msat: p.in }); sum += p.out; }); return { client_pubkey: '02' + 'aa'.repeat(32), fee_msat: sat(2000), _shards: m, _shard_sum_msat: sum, _b16_hash: H }; };
    t = await run({ incoming_circuit_key: ck(2), incoming_amount_msat: sat(1000), outgoing_amount_msat: sat(500000) }, set([{ out: 500000000n, in: 500000000n }, { out: 500000000n, in: 1000000n }]));
    check(t.r && t.r.action === 'FAIL' && t.w.reached.length === 0, 'E4 a set whose parts ask 1,000,000 sats on with 501,000 arrived: FAIL, nothing opens');
    check(t.w.writes.length === 1 && t.w.writes[0].action === 'FAIL' && t.w.writes[0].incoming_circuit_key.htlc_id === '1' && t.promise._shards === null, 'E5 … the other part is failed back too and the set is cleared');
    // a set with a part that has no arrived amount on record counts that part as nothing
    t = await run({ incoming_circuit_key: ck(2), incoming_amount_msat: sat(500000), outgoing_amount_msat: sat(500000) }, set([{ out: 500000000n, in: undefined }, { out: 500000000n, in: 500000000n }]));
    check(t.r && t.r.action === 'FAIL' && t.w.reached.length === 0, 'E6 a part with no arrived amount on its record counts as nothing: the set is refused');
    // an honest set
    t = await run({ incoming_circuit_key: ck(2), incoming_amount_msat: sat(500000), outgoing_amount_msat: sat(500000) }, set([{ out: 500000000n, in: 500000000n }, { out: 500000000n, in: 500001000n }]));
    check(t.w.reached.length === 1 && !t.w.logs.some((l) => /SHORT/.test(l)), 'E7 a set that arrived whole goes on to the open\'s next step (the stand-in\'s peer check then ends it, by its own rule)');
  })().catch((e) => { fails++; console.log('FAIL · E threw: ' + e.message); }).then(partF);
}

// ── F. the variable flush: the whole set, before the channel is sized ──
function partF() {
  const FLUSH = lift(/async function flushVariable\(promise, scidHex, paymentHashHex\) \{[\s\S]*?\n\}\n/, 'flushVariable');
  const mk = (w) => new Function('SM', 'console', 'CONFIG', 'inFlightOpens', 'channelOpenFeeMsat', 'htlcInterceptor', 'promiseByPaymentHash', 'isPeerConnected', 'lndGet', 'OFFLINE_HOLD_ENABLED', 'OFFLINE_MIN_HEADROOM_BLOCKS',
    RULE + '\n' + FLUSH + '\n; return flushVariable;')(w.SM, w.console, { lsps2: { variable_ceiling_msat: sat(5000000) } }, w.inFlightOpens, () => 2000000n, w.htlcInterceptor, w.promiseByPaymentHash,
    async () => { w.reached.push('the peer check'); return false; }, async () => ({ block_height: 900000 }), false, 6);
  const set = (parts) => { const m = new Map(); let sum = 0n; parts.forEach((p, i) => { m.set('900000:' + (i + 1), { incoming_circuit_key: ck(i + 1), msat: p.out, in_msat: p.in }); sum += p.out; }); return { mode: 'variable', client_pubkey: '02' + 'aa'.repeat(32), _shards: m, _shard_sum_msat: sum, _var_min_expiry: 900100, _var_min_autofail: 900090 }; };
  (async () => {
    let w = world(); let promise = set([{ out: 500000000n, in: 500000000n }, { out: 500000000n, in: 1000000n }]);
    await mk(w)(promise, 'aabb', 'ef'.repeat(32));
    check(w.writes.length === 2 && w.writes.every((x) => x.action === 'FAIL' && x.failure_code === 15) && w.reached.length === 0, 'F1 the variable flush fails back every part of a set that arrived short, before anything else');
    check(promise.payment_size_msat === undefined && promise._shards === null && w.emits.some((e) => e[0] === 'var_flush_failed' && e[1].why === 'arrived short'), 'F2 … no channel is sized from it, and the journal says why');
    w = world(); promise = set([{ out: 500000000n, in: 500000000n }, { out: 500000000n, in: 500000000n }]);
    await mk(w)(promise, 'aabb', 'ef'.repeat(32));
    check(w.reached.length === 1 && promise.payment_size_msat === '1000000000', 'F3 a set that arrived whole is sized and goes on');
  })().catch((e) => { fails++; console.log('FAIL · F threw: ' + e.message); }).then(partG);
}

// ── G. a held forward the adapter pays itself ──
function partG() {
  const HELD = lift(/async function trampolineForwardHeld\(held, paymentHashHex, invSec\) \{[\s\S]*?\n\}\n/, 'trampolineForwardHeld');
  const mk = (w) => new Function('SM', 'console', 'CONFIG', 'lndGet', 'sendToRouteV2Hard', 'routerClient', 'jitInflightPark', 'resolvedHtlcHashes',
    RULE + '\n' + HELD + '\n; return trampolineForwardHeld;')(w.SM, w.console, { lsps2: { sendtoroute_timeout_ms: 1000 } }, async () => ({ block_height: 900000 }),
    async (c, h, route) => { w.sent.push(route.total_amt_msat); return { status: 'FAILED', failure: { code: 'TEMPORARY_CHANNEL_FAILURE' } }; }, {}, () => {}, w.resolvedHtlcHashes);
  const sec = { payment_secret: '11'.repeat(32) };
  (async () => {
    let w = world();
    let r = await mk(w)({ outgoing_scid_hex: 'aabb', client_pubkey: '02' + 'aa'.repeat(32), incoming_amount_msat: sat(1000), outgoing_amount_msat: sat(1000000) }, 'ef'.repeat(32), sec);
    check(r === false && w.sent.length === 0, 'G1 a held forward that arrived short is not paid on by the adapter');
    w = world();
    r = await mk(w)({ outgoing_scid_hex: 'aabb', client_pubkey: '02' + 'aa'.repeat(32), incoming_amount_msat: sat(1000000), outgoing_amount_msat: sat(1000000) }, 'ef'.repeat(32), sec);
    check(w.sent.length === 1 && w.sent[0] === sat(1000000), 'G2 one that arrived whole is paid on as before');
  })().catch((e) => { fails++; console.log('FAIL · G threw: ' + e.message); }).then(partH);
}

// ── H. the source: every place a part is recorded, and where the checks sit ──
function partH() {
  const sets = src.match(/_shards\.set\([^\n]*/g) || [];
  check(sets.length === 5 && sets.every((l) => /in_msat: htlcArrivedMsat\((req|_en)\)/.test(l)), 'H1 all five places that record a part keep what arrived on it', sets.length + ' found');
  const at = (t) => src.indexOf(t);
  check(at('if (htlcArrivedShort(req)) {\n    const _shHash') > 0 && at('if (htlcArrivedShort(req)) {\n    const _shHash') < at("a re-delivered (the interceptor stream came back) or sibling HTLC of a parked hash joins the park"), 'H2 the door stands before the handler\'s first path');
  check(at('SHORT part for scid=${outgoingScidHex}: arrived') > 0 && at('SHORT part for scid=${outgoingScidHex}: arrived') < at('OVERSHOOT: HTLC ${outAmtMsat} msat'), 'H3 the fixed path refuses a short part before it looks at the promise\'s size');
  check(at('SHORT set for scid=${scidHex}') > 0 && at('SHORT set for scid=${scidHex}') < at('D-1 2b: fresh peer-liveness gate'), 'H4 the open checks the whole set before its first step');
  check(at('SHORT at the forward for scid=${scidHex}') > at('const forwardAmountMsat = (_inGross - BigInt(promise.fee_msat)).toString();') && at('SHORT at the forward for scid=${scidHex}') < at('const route = {\n    total_time_lock: parseInt(req.outgoing_expiry, 10),'), 'H5 the forward is checked again on the amount it fixes, before the route is built');
  check(/incoming_amount_msat: arrived\.toString\(\)/.test(src) && !/incoming_amount_msat: sum\.toString\(\)/.test(src) && !/incoming_amount_msat: sh\.msat\.toString\(\)/.test(src), 'H6 the variable flush no longer writes the asked amount where the arrived amount belongs');
  console.log(fails ? ('FAIL · jit-arrived: ' + fails + ' failed') : 'PASS · jit-arrived (the arrived-amount rule)');
  process.exit(fails ? 1 : 0);
}
