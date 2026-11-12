// 0.127.0 — a delivery in parts over the wallet's channels (deliver-parts.js; deliverInParts in lij-adapter.js).
//   node deliver-parts.test.js
const fs = require('fs');
const path = require('path');
const dp = require('./deliver-parts');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else console.log('  ok · ' + m); };
const ch = (scid, roomSats, active = true) => ({ scid: String(scid), chan_id: String(scid), room_msat: BigInt(roomSats) * 1000n, local_msat: BigInt(roomSats) * 1000n, active, channel_point: 'cp' + scid });
const sum = (p) => p.reduce((s, x) => s + x.msat, 0n);
(async () => {
  // p1 — DP's case: two channels, 250,000 + 260,000 of room, 420,000 to deliver
  let p = dp.plan([ch(1, 250000), ch(2, 260000)], 420000000n);
  check(p && p.length === 2 && p[0].chan.scid === '2' && p[0].msat === 260000000n && p[1].msat === 160000000n && sum(p) === 420000000n, 'p1 420,000 over rooms 250,000 + 260,000 → 260,000 on the larger, 160,000 on the other; the sum is exact');
  // p2 — the total is short → no plan (the caller opens a channel)
  check(dp.plan([ch(1, 200000), ch(2, 210000)], 420000000n) === null, 'p2 rooms 200,000 + 210,000 cannot carry 420,000 → no plan');
  // p3 — one channel is enough → one part (the caller keeps the single path)
  p = dp.plan([ch(1, 500000), ch(2, 10000)], 420000000n);
  check(p && p.length === 1 && p[0].msat === 420000000n, 'p3 one channel with the room → one part');
  // p4 — a last part under the floor is lifted to it from the part before
  p = dp.plan([ch(1, 300000), ch(2, 300000)], 300500000n);
  check(p && p.length === 2 && p[1].msat === 1000000n && p[0].msat === 299500000n && sum(p) === 300500000n, 'p4 a 500-sat last part becomes 1,000 sats, taken from the part before');
  // p5 — more channels than the cap → no plan
  check(dp.plan([ch(1, 100000), ch(2, 100000), ch(3, 100000), ch(4, 100000), ch(5, 100000)], 450000000n) === null, 'p5 five parts needed, four allowed → no plan');
  check(dp.plan([ch(1, 100000), ch(2, 100000), ch(3, 100000), ch(4, 100000), ch(5, 100000)], 450000000n, { maxParts: 5 }) !== null, 'p5b the cap is a setting');
  // p6 — a channel with less room than the floor is left out; millisat amounts stay exact
  p = dp.plan([ch(1, 500), ch(2, 200000), ch(3, 150000)], 300000001n);
  check(p && p.length === 2 && sum(p) === 300000001n && !p.some((x) => x.chan.scid === '1'), 'p6 a 500-sat channel takes no part; 300,000,001 msat sums exactly');
  check(dp.totalRoomMsat([ch(1, 250000), ch(2, 260000)]) === 510000000n, 'p7 the total room is the sum');
  // c — the reading of the result
  const pre = Buffer.alloc(32, 7);
  const ful = (v) => ({ status: 'fulfilled', value: v }); const rej = (m) => ({ status: 'rejected', reason: new Error(m) });
  let c = dp.combine([ful({ status: 'SUCCEEDED', preimage: pre }), ful({ status: 'SUCCEEDED', preimage: pre })]);
  check(c.kind === 'attempt' && c.attempt.status === 'SUCCEEDED' && c.attempt.preimage === pre && c.attempt.parts_paid === 2, 'c1 every part paid → SUCCEEDED with the preimage');
  c = dp.combine([ful({ status: 'FAILED', failure: { code: 'TEMPORARY_CHANNEL_FAILURE', failure_source_index: 0 } }), ful({ status: 'FAILED', failure: { code: 'MPP_TIMEOUT' } })]);
  check(c.kind === 'attempt' && c.attempt.status === 'FAILED' && c.attempt.failure.code === 'TEMPORARY_CHANNEL_FAILURE' && !c.attempt.preimage.length, 'c2 no part paid → FAILED with the first failure, no preimage');
  c = dp.combine([ful({ status: 'FAILED', failure: { code: 'MPP_TIMEOUT' } }), ful({ status: 'HARD_TIMEOUT', failure: { code: 'F3_HARD_TIMEOUT' } })]);
  check(c.attempt.status === 'HARD_TIMEOUT', 'c3 LND still owns a part → HARD_TIMEOUT (the caller probes, never re-sends)');
  c = dp.combine([rej('14 UNAVAILABLE'), rej('14 UNAVAILABLE')]);
  check(c.kind === 'rejected' && /UNAVAILABLE/.test(c.error), 'c4 no attempt at all → rejected with the error');
  c = dp.combine([ful({ status: 'FAILED', failure: { code: 'MPP_TIMEOUT' } }), rej('payment in flight')]);
  check(c.kind === 'rejected' && /in flight/.test(c.error), 'c5 a part LND says is in flight → rejected with that text (the caller marks it in flight)');
  c = dp.combine([ful({ status: 'SUCCEEDED', preimage: pre }), ful({ status: 'HARD_TIMEOUT', failure: {} })]);
  check(c.attempt.status === 'SUCCEEDED', 'c6 a preimage on any part wins — the wallet claims only when all parts arrived');
  // d — deliverInParts as written in lij-adapter.js, run against stand-ins
  const m = src.match(/async function deliverInParts\(\{[\s\S]*?\n\}\n/);
  check(!!m, 'd0 deliverInParts is defined');
  const mk = (sendImpl, tip = 900000) => {
    const sent = [];
    const fn = new Function('deliverParts', 'lndGet', 'sendToRouteV2Hard', 'routerClient', 'CONFIG', 'console', m[0] + '; return deliverInParts;')(
      dp, async () => ({ block_height: tip }), async (_c, hash, route) => { sent.push({ hash, route, at: Date.now() }); return sendImpl(route, sent.length); }, {}, { lsps2: { sendtoroute_timeout_ms: 25000 } }, { log() {}, warn() {}, error() {} });
    return { fn, sent };
  };
  const plan2 = dp.plan([ch(11, 250000), ch(22, 260000)], 420000000n);
  const args = { client: '02' + 'ab'.repeat(32), hashHex: 'cd'.repeat(32), secretHex: 'ef'.repeat(32), amt: 420000000n, finalCltvDelta: 0, T: 'test', plan: plan2 };
  let h = mk(() => ({ status: 'SUCCEEDED', preimage: pre }));
  let out = await h.fn(args);
  check(out.kind === 'attempt' && out.attempt.status === 'SUCCEEDED' && out.innerMsat === '420000000' && out.feeMsat === 0n && out.parts === 2, 'd1 two parts paid → one attempt, the whole amount delivered, fee 0');
  check(h.sent.length === 2 && h.sent[0].route.hops[0].chan_id === '22' && h.sent[1].route.hops[0].chan_id === '11', 'd2 one SendToRoute per channel, the larger first');
  check(h.sent.every((s) => s.hash.toString('hex') === 'cd'.repeat(32) && s.route.hops[0].mpp_record.total_amt_msat === '420000000' && s.route.hops[0].mpp_record.payment_addr === Buffer.from('ef'.repeat(32), 'hex').toString('base64')), 'd3 every part: the same hash and secret, the WHOLE amount in its mpp_record');
  check(h.sent[0].route.hops[0].amt_to_forward_msat === '260000000' && h.sent[1].route.total_amt_msat === '160000000' && h.sent.every((s) => s.route.hops[0].fee_msat === '0' && s.route.hops[0].expiry === 900080 && s.route.total_time_lock === 900080), 'd4 each part carries its own amount, no fee, the tip + 80');
  check(h.sent[1].at - h.sent[0].at >= 150, 'd5 the first part goes out a moment ahead of the others');
  h = mk(() => ({ status: 'SUCCEEDED', preimage: pre }));
  out = await h.fn(Object.assign({}, args, { plan: dp.plan([ch(11, 250000, false), ch(22, 260000)], 420000000n) }));
  check(out.kind === 'retry' && h.sent.length === 0, 'd6 a part\'s channel not active yet → retry, nothing sent');
  h = mk(() => ({ status: 'SUCCEEDED', preimage: pre }), 0);
  out = await h.fn(args);
  check(out.kind === 'retry' && h.sent.length === 0, 'd7 no chain tip → retry, nothing sent');
  h = mk((_r, n) => (n === 1 ? { status: 'FAILED', failure: { code: 'TEMPORARY_CHANNEL_FAILURE' } } : { status: 'FAILED', failure: { code: 'MPP_TIMEOUT' } }));
  out = await h.fn(args);
  check(out.kind === 'attempt' && out.attempt.status === 'FAILED' && out.attempt.failure.code === 'TEMPORARY_CHANNEL_FAILURE', 'd8 a failed part → a failed attempt the callers already handle');
  // s — the wiring
  check(src.includes("if (plan && plan.length > 1) return deliverInParts({ client, hashHex, secretHex, amt, finalCltvDelta, T, plan });"), 's1 deliverToWallet takes the parts path before any open');
  const iBranch = src.indexOf('if (plan && plan.length > 1) return deliverInParts('), iOpen = src.indexOf('if (!chan || chan.room_msat < amt) {   // 0.84.0');
  check(iBranch > 0 && iOpen > iBranch, 's2 the parts path stands ahead of the open');
  check(src.includes("const parts = (chan && chan.room_msat < amt) ? deliverParts.plan(chans, amt, DELIVER_PARTS) : null;"), 's3 the receivable answer counts the channels together (no opening fee quoted when the parts fit)');
  // 0.127.1 — the channel an open delivers over, and the part sizes in the route answer
  check(src.includes("chan = (openedCp ? _all.find((c) => c.channel_point === openedCp) : _all.find((c) => c.room_msat >= amt - feeMsat)) || null;"), 's4 after an open the delivery goes over the channel THAT call opened (by its funding point)');
  const iNull = src.indexOf("    chan = null;\n    for (let i = 0; i < 24 && !chan; i++) {");
  check(iNull > 0 && !src.includes("      chan = await lnurlpClientChannel(client);\n    }\n    deliverOpening.delete(client);"), 's5 the wait starts empty — a channel the wallet already had is not kept');
  check(src.includes("_rp.lijox_parts_sats = partsHint;") && src.includes("parts_sats: Array.isArray(lndResp.lijox_parts_sats) ? lndResp.lijox_parts_sats : undefined"), 's6 a route request no one channel can carry is answered with the part sizes that fit (parts_sats)');
  const hint = dp.plan([{ scid: '1', room_msat: 269029000n }, { scid: '2', room_msat: 268000000n }], 420002000n).map((p) => Number(p.msat / 1000n));
  check(hint.length === 2 && hint[0] === 269029 && hint[1] === 150973 && hint[0] + hint[1] === 420002, 's7 DP\'s 420,002 over rooms 269,029 + 268,000 → 269,029 + 150,973 whole sats');
  console.log(fails ? `\n${fails} FAILED` : '\nall deliver-parts checks pass');
  process.exit(fails ? 1 : 0);
})();
