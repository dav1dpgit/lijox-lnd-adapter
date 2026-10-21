// 0.106.0 (S59 Thu — Phase 2b, the provider as host of a public room; the 2b security pass folded in): tatara-host.js
// on a fake relay with real keys, real ownership proofs and a fake coin check.
//   node tatara-host.test.js
'use strict';
const crypto = require('crypto');
const { createList } = require('./tatara-list');
const { createHost, proofOk, outputsOf, ROOM_GAP_S } = require('./tatara-host');
const nip04 = require('./nip04');
const schnorr = require('./schnorr.js');
const { checkEvent } = require('./nwc.js');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const S = { sizes: [50000, 100000], min_people: 3, max_people: 6, countdown_s: 600, wake_window_s: 180, max_retries: 2, strikes: 4, max_pools_per_size: 3, max_pools_total: 10, max_list_per_size: 60, max_fee_rate: 20, channel_pools: false, channel_sizes: [], public_rooms: true, room_window_s: 1200 };
const RELAY = 'wss://relay.test';

function fakeRelay() {
  const published = [], subs = new Map();
  const c = {
    publish: (ev) => published.push(ev),
    subscribe: (id, filter, onEvent) => subs.set(id, { filter, onEvent }),
    unsubscribe: (id) => subs.delete(id),
    since: (id, at) => { const s = subs.get(id); if (s) s.filter.since = at; },
    close: () => {}, connected: () => true, stats: () => ({}),
    published, subs,
    deliver: (ev) => { for (const s of subs.values()) if ((s.filter['#p'] || []).includes((ev.tags.find((t) => t[0] === 'p') || [])[1])) s.onEvent(ev); },
    take: (f) => { const i = published.findIndex(f); return i < 0 ? null : published.splice(i, 1)[0]; },
  };
  return c;
}
// a coin world: outpoint → { value, spk, confirmations, unspent }; the coin check answers with a raw tx holding the output
const coins = new Map();
const rawTx = (outs) => {
  const parts = [Buffer.from('02000000', 'hex'), Buffer.from([1]), Buffer.alloc(36, 1), Buffer.from([0]), Buffer.from('ffffffff', 'hex'), Buffer.from([outs.length])];
  for (const o of outs) { const v = Buffer.alloc(8); v.writeBigUInt64LE(BigInt(o.value)); const s = Buffer.from(o.spk, 'hex'); parts.push(v, Buffer.from([s.length]), s); }
  parts.push(Buffer.alloc(4));
  return Buffer.concat(parts).toString('hex');
};
const coinCheck = async ({ txid, vout }) => {
  const c = coins.get(txid + ':' + vout);
  if (!c) return { ok: true, txid, vout, unspent: false, confirmations: 0 };
  const outs = []; for (let i = 0; i <= vout; i++) outs.push(i === vout ? { value: c.value, spk: c.spk } : { value: 1, spk: '0014' + '00'.repeat(20) });
  return { ok: true, txid, vout, unspent: c.unspent !== false, confirmations: c.confirmations === undefined ? 3 : c.confirmations, tx: rawTx(outs) };
};

function mk(over = {}, fee = 2.5) {
  let t = 1_000_000_000_000; let n = 0;
  const clock = { at: () => t, go: (s) => { t += s * 1000; } };
  const logs = [];
  const settings = Object.assign({}, S, over);
  const L = createList({ settings, now: clock.at, newId: () => (++n).toString(16).padStart(32, '0'), log: (m) => logs.push(m) });
  const relay = fakeRelay();
  const H = createHost({ settings: () => settings, now: clock.at, log: (m) => logs.push(m), list: L, publicRelayUrl: RELAY, connect: () => relay, feeRateSatVb: async () => fee, coinCheck, network: 'mainnet', newId: () => (++n).toString(16).padStart(32, '0') });
  const tick = async () => { const a = L.tick(); const b = await H.tick(); await new Promise((r) => setImmediate(r)); return { wakes: a.wakes.concat((b && b.wakes) || []) }; };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { L, H, relay, clock, logs, tick, settle, settings };
}
const key = () => { const sk = crypto.randomBytes(32).toString('hex'); return { sk, pk: schnorr.pubkey(Buffer.from(sk, 'hex')).toString('hex') }; };
const joinFrom = (who, poolPk, at) => nip04.seal(who.sk, poolPk, JSON.stringify({ version: '2', type: 'join_pool' }), at);
const msgFrom = (who, poolPk, msg, at) => nip04.seal(who.sk, poolPk, JSON.stringify(Object.assign({ version: '2' }, msg)), at);
const openAnswer = (who, poolPk, ev) => JSON.parse(nip04.decrypt(nip04.sharedX(who.sk, poolPk), ev.content));
const seatOf = (L, i, size = 50000, publicOk = true, feeCapMilli = 15000) => L.seat({ owner: 'w' + i, size, seatPk: 'p' + i, wake: { kind: 'node', pk: 'w' + i }, publicOk, feeCap: feeCapMilli }).seat_id;
const nowS = (clock) => Math.floor(clock.at() / 1000);
/// A stranger's registration of a real (fake-world) P2TR coin, with a true ownership proof.
const coinKeys = new Map();
function registration(session, poolId, amount, opts = {}) {
  const coin = opts.coin ? opts.coin.key : key(); const txid = opts.coin ? opts.coin.txid : crypto.randomBytes(32).toString('hex'), vout = 1;
  const spk = '5120' + coin.pk;
  if (!opts.coin) coins.set(txid + ':' + vout, Object.assign({ value: amount, spk }, opts.world || {}));
  coinKeys.set(txid + ':' + vout, { key: coin, txid });
  const op = Buffer.concat([Buffer.from(txid, 'hex').reverse(), Buffer.alloc(4)]); op.writeUInt32LE(vout, 32);
  const t = crypto.createHash('sha256').update('joinstr/v2/ownership').digest();
  const msg = crypto.createHash('sha256').update(t).update(t).update(Buffer.from(poolId, 'utf8')).update(Buffer.from(session.pk, 'hex')).update(op).digest();
  const sig = schnorr.sign(Buffer.from((opts.wrongKey ? key() : coin).sk, 'hex'), msg, crypto.randomBytes(32)).toString('hex');
  return { type: 'inputs', musig_pubkey: '02' + '11'.repeat(32), ring_pubkey: '02' + '22'.repeat(32), inputs: [{ txid, vout, amount: opts.claim || amount, script_pubkey: spk, proof: { sig } }], change: null, height: 1 };
}
const announced = (relay) => relay.published.filter((e) => e.kind === 2022);

(async () => {
// H1 — one seat waiting: a room opens; the announcement is a signed public pool event with nothing LIJOX in it
{
  const { L, H, relay, clock, logs, tick } = mk();
  seatOf(L, 1, 50000, true, 3000);   // the seat's cap 3 sat/vB (its 2 at Join × 1.5), in thousandths
  await tick();
  const ann = announced(relay)[0];
  check(!!ann && checkEvent(ann) === '' && ann.tags.length === 0, 'H1 a room opens: a signed kind-2022 announcement with no tags');
  const pe = JSON.parse(ann.content);
  check(pe.type === 'new_pool' && pe.versions[0] === '2' && pe.peers === 3 && pe.denomination === 50000 && pe.relays[0] === RELAY && pe.public_key === ann.pubkey && pe.timeout >= nowS(clock) + 1080 && pe.timeout <= nowS(clock) + 1320 && pe.network === 'mainnet' && pe.payout_type === undefined, 'H1 the announcement: N = the minimum (3), the public relay, the room key as its author, the window ±10 %');
  check(pe.fee_rate === 2.5, 'H1 the fee rate is the node\'s estimate (2.5) under the seat\'s cap (3)');
  check(JSON.stringify(ann).toLowerCase().indexOf('lij') < 0, 'H1 nothing in the announcement says LIJOX');
  check(relay.subs.size === 1 && Array.from(relay.subs.values())[0].filter['#p'][0] === ann.pubkey, 'H1 the host reads the room (kind 4 to the room key)');
  check(logs.some((m) => /a public room opens · 50000 sats · 3 people · 1 seat\(s\) waiting · 2 stranger\(s\) wanted · 2.5 sat\/vB/.test(m)), 'H1 the log line');
  const r2 = mk({}, 9);
  seatOf(r2.L, 1, 50000, true, 3000);
  await r2.tick();
  check(announced(r2.relay).length === 0 && r2.H.summary().length === 0, 'H1 an estimate above the seat\'s cap: that seat is not eligible — no room (the phone would refuse the rate)');
  seatOf(r2.L, 2, 50000, true, 15000);
  await r2.tick();
  check(announced(r2.relay).length === 1 && JSON.parse(announced(r2.relay)[0].content).fee_rate === 9 && /1 seat\(s\) waiting/.test(r2.logs.join('\n')), 'H1 a seat whose cap allows the rate opens a room at the estimate; the capped seat is left out');
  check(H.summary().length === 1 && H.summary()[0].phase === 'filling' && H.summary()[0].strangers === 0 && H.summary()[0].registered === 0, 'H1 summary: one room filling');
}
// H2 — the LIJOX rule: the list reaches 3 with no stranger registered → the room is withdrawn, the LIJOX countdown runs; a key handed out alone changes nothing
{
  const { L, H, relay, clock, tick } = mk();
  seatOf(L, 1); await tick();
  const ann = announced(relay)[0];
  const a = key(); relay.deliver(joinFrom(a, ann.pubkey, nowS(clock)));
  check(openAnswer(a, ann.pubkey, relay.take((e) => e.kind === 4 && e.tags[0][1] === a.pk)).type === 'credentials', 'H2 a stranger takes the key…');
  seatOf(L, 2); seatOf(L, 3);
  await tick();
  const del = relay.published.find((e) => e.kind === 5);
  check(!!del && del.tags[0][1] === ann.id && del.pubkey === ann.pubkey && H.summary().length === 0, 'H2 …but three LiJ seats with no stranger REGISTERED: the room is withdrawn (a deletion event by the room key)');
  check(L.checkin(L.state().queues['chain:50000'][0]).count.starts_in_s === 600, 'H2 the LIJOX countdown runs for the three');
}
// H3 — strangers: credentials while the quota lasts, "pool is full" after, a replay gets the same answer; the room is honoured on a CHECKED registration
{
  const { L, H, relay, clock, tick, settle, logs } = mk();
  seatOf(L, 1); await tick();
  const ann = announced(relay)[0]; const poolPk = ann.pubkey; const id = JSON.parse(ann.content).id;
  const a = key(), b = key(), c = key();
  relay.deliver(joinFrom(a, poolPk, nowS(clock)));
  let ans = relay.take((e) => e.kind === 4 && e.tags[0][1] === a.pk);
  check(!!ans && ans.pubkey === poolPk && checkEvent(ans) === '', 'H3 the answer is sealed from the room key to the asker');
  const m = openAnswer(a, poolPk, ans);
  check(m.type === 'credentials' && m.credentials.id === id && schnorr.pubkey(Buffer.from(m.credentials.key, 'hex')).toString('hex') === poolPk, 'H3 the first stranger gets the room\'s key and id');
  relay.deliver(joinFrom(b, poolPk, nowS(clock)));
  check(openAnswer(b, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === b.pk)).type === 'credentials', 'H3 the second stranger too (quota 2 with one seat waiting)');
  relay.deliver(joinFrom(c, poolPk, nowS(clock)));
  const full = openAnswer(c, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === c.pk));
  check(full.type === 'reject' && full.reason === 'pool is full', 'H3 the third: "pool is full"');
  relay.deliver(joinFrom(a, poolPk, nowS(clock) + 1));
  check(openAnswer(a, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === a.pk)).type === 'credentials', 'H3 a replayed join gets the same answer');
  // registrations: a forged proof, a coin the chain does not know, a spent coin, a wrong amount — none count; a real one does
  const s1 = key(), s2 = key(), s3 = key(), s4 = key(), s5 = key();
  relay.deliver(msgFrom(s1, poolPk, registration(s1, id, 50000, { wrongKey: true }), nowS(clock))); await settle();
  relay.deliver(msgFrom(s2, poolPk, Object.assign(registration(s2, id, 50000), { inputs: [{ txid: 'ab'.repeat(32), vout: 0, amount: 50000, script_pubkey: '5120' + '11'.repeat(32), proof: { sig: 'cd'.repeat(64) } }] }), nowS(clock))); await settle();
  relay.deliver(msgFrom(s3, poolPk, registration(s3, id, 50000, { world: { unspent: false } }), nowS(clock))); await settle();
  relay.deliver(msgFrom(s4, poolPk, registration(s4, id, 50000, { claim: 60000 }), nowS(clock))); await settle();
  await tick();
  check(H.summary()[0].registered === 0 && H.summary()[0].phase === 'filling', 'H3 a bad proof, an unknown coin, a spent coin and a wrong amount count for nothing');
  const ro0 = H.roomOf('chain', 50000);
  check(ro0 && ro0.strangers === 0 && ro0.peers === 3 && ro0.phase === 'filling' && ro0.closes_in_s > 1000 && ro0.closes_in_s <= 1200 && H.roomOf('chain', 100000) === null && H.roomOf('channel', 50000) === null, 'H3 (0.107.0) roomOf: the queue\'s room — no strangers yet, N = 3, the seconds left; no room for another queue');
  relay.deliver(msgFrom(s5, poolPk, registration(s5, id, 50000), nowS(clock))); await settle();
  await tick();
  check(H.summary()[0].registered === 1 && logs.some((x) => /a stranger registered a checked coin \(1 of 2 wanted\)/.test(x)), 'H3 a real coin with a true proof: registered (1 of 2 wanted)');
  check(H.roomOf('chain', 50000).strangers === 1 && JSON.stringify(H.roomOf('chain', 50000)).indexOf(s5.pk) < 0, 'H3 (0.107.0) roomOf counts the checked stranger and carries no key or coin');
  // the room is honoured now: two more LiJ seats arrive — no LIJOX pool starts, no deletion; with three seats waiting the
  // room wants only one stranger, which it has: it wakes two seats (N = 3) and the third waits on its own
  seatOf(L, 2); seatOf(L, 3);
  const { wakes } = await tick();
  check(H.summary().length === 1 && !relay.published.some((e) => e.kind === 5), 'H3 an honoured room stays when the list fills (no withdrawal)');
  check(H.summary()[0].phase === 'woken' && wakes.length === 2 && H.summary()[0].promised === 2, 'H3 three seats waiting + one checked stranger = the quota met: two seats woken (the room takes 2 seats + 1 stranger)');
  const r = L.checkin(L.state().queues['chain:50000'][2]);
  check(r.count.joined === 1 && r.count.starts_in_s === null, 'H3 the third seat waits on its own: the head group has one seat, no countdown');
}
// H4 — the wake notice, the seat opens naming its join key, joins without a token; the seats report; the room closes on the list's verdict
{
  const { L, H, relay, clock, tick, settle } = mk();
  const s1 = seatOf(L, 1), s2 = seatOf(L, 2); await tick();
  const ann = announced(relay)[0]; const poolPk = ann.pubkey; const id = JSON.parse(ann.content).id;
  const a = key(); relay.deliver(joinFrom(a, poolPk, nowS(clock)));
  check(openAnswer(a, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === a.pk)).type === 'credentials', 'H4 two seats waiting: quota 1 — one stranger');
  relay.deliver(msgFrom(a, poolPk, registration(a, id, 50000), nowS(clock))); await settle();
  const { wakes } = await tick();
  check(wakes.length === 2 && H.summary()[0].phase === 'woken', 'H4 the stranger registers: both seats woken');
  const n1 = L.checkin(s1).notices.find((x) => x.type === 'room');
  check(n1 && n1.event === JSON.stringify(ann) && n1.relay === RELAY && n1.room_token === undefined && n1.peers === 3 && n1.open_within_s === 180 && n1.attempt_id, 'H4 the room notice: the announcement, the public relay, 180 s to open — and no token');
  const n2 = L.checkin(s2).notices.find((x) => x.type === 'room');
  const j1 = key(), j2 = key();
  check(L.open(s1, n1.attempt_id).reason === 'join_pk_needed' && L.open(s1, n1.attempt_id, j1.pk).ok && L.open(s2, n2.attempt_id, j2.pk).ok, 'H4 a room\'s open names the phone\'s join key');
  await tick();
  const att = L.attemptOf(n1.attempt_id);
  check(att && att.room && att.phase === 'running' && H.summary()[0].phase === 'running', 'H4 both opened: the room attempt runs');
  relay.deliver(joinFrom(j1, poolPk, nowS(clock)));
  check(openAnswer(j1, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === j1.pk)).type === 'credentials', 'H4 a seat\'s join (the public code\'s bytes, from the key it named): credentials, past the strangers\' quota');
  const late = key(); relay.deliver(joinFrom(late, poolPk, nowS(clock)));
  check(openAnswer(late, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === late.pk)).type === 'reject', 'H4 a stranger now: full — an unnamed key gets nothing even with the room\'s key in hand');
  relay.deliver(joinFrom(j2, poolPk, nowS(clock)));
  check(openAnswer(j2, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === j2.pk)).type === 'credentials', 'H4 the second seat\'s join: credentials');
  // the relay never decides: forged registrations, witnesses and an abort from throwaway keys change nothing in the list
  const sess = [key(), key(), key()];
  for (const x of sess) relay.deliver(msgFrom(x, poolPk, { type: 'inputs', musig_pubkey: '02' + '11'.repeat(32), ring_pubkey: '02' + '22'.repeat(32), inputs: [{ txid: 'ab'.repeat(32), vout: 0, amount: 50000, script_pubkey: '5120' + '11'.repeat(32), proof: { sig: 'cd'.repeat(64) } }], change: null, height: 1 }, nowS(clock)));
  for (const x of sess) relay.deliver(msgFrom(x, poolPk, { type: 'funding_sigs', witnesses: [] }, nowS(clock)));
  relay.deliver(msgFrom(sess[0], poolPk, { type: 'abort', reason: 'x' }, nowS(clock)));
  await tick();
  check(L.attemptOf(n1.attempt_id).phase === 'running' && H.summary()[0].phase === 'running', 'H4 forged registrations, funding signatures and an abort off the relay decide nothing (review 2b #1)');
  check(L.report(s1, n1.attempt_id, 'funding_signed').phase === 'signed' && L.checkin(s2).state === 'removed', 'H4 a seat\'s signed report: funding signed — every seat done');
  await tick();
  check(H.summary().length === 0 && !relay.published.some((e) => e.kind === 5), 'H4 the host closes the room on the list\'s verdict; an honoured room is never withdrawn');
}
// H5 — a missed wake: no strike, no re-seating; the seat holds back until it checks in; the next room waits the gap
{
  const { L, H, relay, clock, tick, settle } = mk();
  const s1 = seatOf(L, 1); await tick();
  const ann = announced(relay)[0]; const poolPk = ann.pubkey; const id = JSON.parse(ann.content).id;
  const a = key(), b = key();
  relay.deliver(joinFrom(a, poolPk, nowS(clock))); relay.deliver(joinFrom(b, poolPk, nowS(clock)));
  relay.deliver(msgFrom(a, poolPk, registration(a, id, 50000), nowS(clock))); relay.deliver(msgFrom(b, poolPk, registration(b, id, 50000), nowS(clock))); await settle();
  await tick();
  check(H.summary()[0].phase === 'woken', 'H5 two checked registrations: woken');
  clock.go(181); await tick();
  const seat = L.seatOf(s1);
  check(seat.state === 'waiting' && seat.missed === 0 && seat.room_hold === true && H.summary().length === 0, 'H5 the seat did not open: back to waiting, no missed start counted, holding back; the room closed');
  clock.go(ROOM_GAP_S + 1); await tick();
  check(H.summary().length === 0, 'H5 no new room while the seat holds back');
  const r = L.checkin(s1);
  check(r.notices.some((x) => x.type === 'missed_room') && seat.room_hold === false, 'H5 the check-in tells the miss and clears the hold');
  await tick();
  check(H.summary().length === 1 && announced(relay).length === 2 && announced(relay)[1].pubkey !== poolPk, 'H5 the app opened: a fresh room (a new key) opens');
}
// H6 — nobody registers: the room closes WAKE_WINDOW before its deadline (withdrawn), the next waits the pause (doubling); late strangers are refused
{
  const { L, H, relay, clock, tick, logs } = mk();
  seatOf(L, 1); await tick();
  const first = announced(relay)[0];
  const w = JSON.parse(first.content).timeout - nowS(clock);
  clock.go(w - 180 - 1); await tick();
  check(H.summary().length === 1 && H.summary()[0].ends_in_s === 181, 'H6 one second before the cut-off: the room stands');
  clock.go(1); await tick();
  check(relay.published.some((e) => e.kind === 5 && e.tags[0][1] === first.id) && announced(relay).length === 1 && /next room for this size in 60 s/.test(logs.join('\n')), 'H6 at the cut-off with nobody in: withdrawn; the next room waits 60 s');
  const a = key(); relay.deliver(joinFrom(a, first.pubkey, nowS(clock)));
  check(!relay.published.some((e) => e.kind === 4 && e.tags[0][1] === a.pk), 'H6 a join to the closed room gets no answer');
  clock.go(61); await tick();
  const second = announced(relay)[1];
  check(!!second && second.pubkey !== first.pubkey, 'H6 after the pause a fresh room opens');
  const w2 = JSON.parse(second.content).timeout - nowS(clock);
  clock.go(w2 - 180); await tick();
  check(announced(relay).length === 2 && /next room for this size in 120 s/.test(logs.join('\n')), 'H6 empty again: the pause doubles (120 s)');
  const b = key(); relay.deliver(joinFrom(b, second.pubkey, nowS(clock)));
  check(!relay.published.some((e) => e.kind === 4 && e.tags[0][1] === b.pk), 'H6 the second room is closed too: no answer');
}
// H7 — no room without the seat's switch, without a fee estimate, with public rooms off; a stranger's abort decides nothing; the seat's report does
{
  const { L, H, tick } = mk();
  seatOf(L, 1, 50000, false); await tick();
  check(H.summary().length === 0, 'H7 a seat with Public pools off opens no room');
  const r2 = mk({}, null); seatOf(r2.L, 1); await r2.tick();
  check(r2.H.summary().length === 0 && r2.logs.some((m) => /no fee estimate/.test(m)), 'H7 no fee estimate: no room, said once');
  const r3 = mk({ public_rooms: false }); seatOf(r3.L, 1); await r3.tick();
  check(r3.H.summary().length === 0, 'H7 TATARA_PUBLIC_ROOMS=false: no room');
  const r5 = mk(); const t1 = seatOf(r5.L, 1), t2 = seatOf(r5.L, 2); await r5.tick();
  const ann5 = announced(r5.relay)[0]; const id5 = JSON.parse(ann5.content).id;
  const a = key(); r5.relay.deliver(joinFrom(a, ann5.pubkey, nowS(r5.clock))); r5.relay.deliver(msgFrom(a, ann5.pubkey, registration(a, id5, 50000), nowS(r5.clock))); await r5.settle(); await r5.tick();
  const n5 = r5.L.checkin(t1).notices.find((x) => x.type === 'room'); r5.L.open(t1, n5.attempt_id, key().pk); r5.L.open(t2, n5.attempt_id, key().pk); await r5.tick();
  r5.relay.deliver(msgFrom(a, ann5.pubkey, { type: 'abort', reason: 'x' }, nowS(r5.clock))); await r5.tick();
  check(r5.L.attemptOf(n5.attempt_id).phase === 'running', 'H7 a registered stranger\'s abort is noted, never acted on');
  const c1 = r5.L.report(t1, n5.attempt_id, 'stopped');
  const k1 = r5.L.checkin(t1);
  check(c1.phase === 'stopped' && k1.state === 'waiting' && k1.notices.some((x) => x.type === 'stopped' && x.reason === 'room_stopped'), 'H7 a seat reports stopped: the seats back to waiting');
  await r5.tick();
  check(r5.H.summary().length === 0 && /next room for this size in 60 s/.test(r5.logs.join('\n')), 'H7 the host closes the room on the list\'s verdict; the next waits the pause');
}
// H8 — the budget: a flood of events to a room is verified only up to the budget; a flood of keys is answered up to the cap
{
  const { L, relay, clock, tick, logs } = mk();
  seatOf(L, 1); await tick();
  const ann = announced(relay)[0]; const poolPk = ann.pubkey;
  let answered = 0;
  for (let i = 0; i < 80; i++) { const k = key(); relay.deliver(joinFrom(k, poolPk, nowS(clock) + i)); if (relay.take((e) => e.kind === 4 && e.tags[0][1] === k.pk)) answered++; }
  check(answered <= 10 && logs.some((m) => /more relay events than the host verifies/.test(m)), 'H8 80 joins in one second: at most the per-room budget (10) verified and answered, the rest dropped and said once');
  check(typeof outputsOf(rawTx([{ value: 7, spk: '0014' + '00'.repeat(20) }]))[0].value === 'number' && outputsOf(rawTx([{ value: 7, spk: '0014' + '00'.repeat(20) }]))[0].value === 7, 'H8 outputsOf reads a raw transaction');
  check(proofOk('x', 'ab'.repeat(32), 'cd'.repeat(32), 0, '5120' + '11'.repeat(32), { sig: 'zz' }) === false, 'H8 proofOk refuses junk');
}
// H9 — the engine's own registrations (lij-core phone.rs, a P2WPKH coin and a P2TR coin) carry ownership proofs this host verifies
{
  const FX = [["13869467e70836af5b027e5995d8c598", "f35c7f67240fd4e53c7a53cef771508a87e9fd983d3f0913b2b224c88b4c0139", "{\"version\":\"2\",\"type\":\"inputs\",\"musig_pubkey\":\"0375eb1f3e214f9e8dec5df7e536be4d52fe5234b4aaec0ca97fabdd4906e98af4\",\"ring_pubkey\":\"02de577e07824ca8bdc457a61bc9183738089067841116e6be4bac99ce81a2f32a\",\"inputs\":[{\"txid\":\"1f0539686f73ca125b6db5b6cda0261a013c316b51a27765eaf2842b3bf384bb\",\"vout\":6,\"amount\":120000,\"script_pubkey\":\"0014903980c8c0d30ec28a6252af04682265ef64d649\",\"proof\":{\"sig\":\"304402207b6409bcc667db623392ad971ed486c80dd376e1c741bb56a9584d90ccf0dda702205efb98fa5fa6f35afd7cc2ef226dd2eba2a3a9632b58da0ce33c8ac04a0b8305\",\"pubkey\":\"02dcc7f37f424f326e5c1add2aa056a03818c7b883d11d4cf22a94c829c96c41f2\"}}],\"change\":{\"address\":\"bc1qn8hp0cc7r2fha8jqflu4qs492pq2ejp3lhkre7\",\"amount\":19560},\"height\":970000,\"denomination\":100000}"], ["d9de4d82736be5792e8c0a122e83628d", "207b7b4d3fa19ee496a02f8a563469962b1ed920e8dd3c4c5abc9c580e879892", "{\"version\":\"2\",\"type\":\"inputs\",\"musig_pubkey\":\"03cb70b35915405fb2d63807abda73739aa65661c4314251f23bca1308470bbe65\",\"ring_pubkey\":\"02113eb4511e31e6456a2a4777b5f16c218006254fd73fb4f435979696c1992ea5\",\"inputs\":[{\"txid\":\"203549a8515704c70b230bb89a27a69ff4e641229e3cd7d87bb090e8d8efc2fc\",\"vout\":7,\"amount\":120000,\"script_pubkey\":\"5120d604bd7f659a1b4c18117543d2b479ca6bd69aedb3312ee1fd8991a2b8f6ae10\",\"proof\":{\"sig\":\"60fce9d5bc94fbb003e32f9d6eb26b9aacec96751062ce97973927d34645273cbdb2ccb09dc706ff74f4e2ce252ddb65504528768e8bb26f7bd6f84e6ff79a6a\"}}],\"change\":{\"address\":\"bc1qr0zv0ela0fmuaavm6pszmtsqc9w8ew6n83tklz\",\"amount\":19581},\"height\":970000,\"denomination\":100000}"]];
  for (const [pid, sess, js] of FX) {
    const m = JSON.parse(js);
    for (const i of m.inputs) check(proofOk(pid, sess, i.txid, i.vout, i.script_pubkey, i.proof) === true && proofOk(pid, 'ab'.repeat(32), i.txid, i.vout, i.script_pubkey, i.proof) === false, 'H9 the engine\'s ' + (i.script_pubkey.startsWith('5120') ? 'P2TR' : 'P2WPKH') + ' ownership proof verifies here, and not under another session key');
  }
}
// H10 — the re-check's holes: a flood never starves a known key; a seat's join that lands before the host read its key is
// upgraded from the cached "full"; failed checks free their slot; a room's checks are budgeted; a future-dated event is unread;
// a coin from a stopped room is refused for a day
{
  const { L, H, relay, clock, tick, settle, logs } = mk();
  const s1 = seatOf(L, 1), s2 = seatOf(L, 2); await tick();
  const ann = announced(relay)[0]; const poolPk = ann.pubkey; const id = JSON.parse(ann.content).id;
  // 15 registrations with true proofs for coins the chain does not know: the slots free again, only 12 checks spent
  const strangers = [];
  for (let i = 0; i < 15; i++) { const k = key(); strangers.push(k); const reg = registration(k, id, 50000); coins.delete(reg.inputs[0].txid + ':' + reg.inputs[0].vout); relay.deliver(msgFrom(k, poolPk, reg, nowS(clock) + i)); }
  await settle(); await tick();
  check(H.summary()[0].registered === 0 && /more relay events than the host verifies/.test(logs.join('\n')) === true, 'H10 fifteen bad registrations in one second: nothing registered (the budget dropped some, the checks failed the rest)');
  clock.go(1);
  const real = key(); relay.deliver(msgFrom(real, poolPk, registration(real, id, 50000), nowS(clock))); await settle(); await tick();
  check(H.summary()[0].registered === 1, 'H10 a real registration after the bad ones still counts (failed checks freed their slots)');
  // woken; the seat opens and its join lands BEFORE the host's next tick
  const n1 = L.checkin(s1).notices.find((x) => x.type === 'room'); const n2 = L.checkin(s2).notices.find((x) => x.type === 'room');
  const j1 = key(), j2 = key();
  L.open(s1, n1.attempt_id, j1.pk);
  relay.deliver(joinFrom(j1, poolPk, nowS(clock)));
  const first = openAnswer(j1, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === j1.pk));
  check(first.type === 'reject', 'H10 a join landing before the tick that reads the key is answered "full"…');
  await tick();
  relay.deliver(joinFrom(j1, poolPk, nowS(clock) + 1));
  check(openAnswer(j1, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === j1.pk)).type === 'credentials', 'H10 …and the next join from that key is upgraded to credentials once the key is known');
  // the host hook: a key noted at open is known at once
  L.open(s2, n2.attempt_id, j2.pk); H.noteJoinKey(n2.attempt_id, j2.pk);
  relay.deliver(joinFrom(j2, poolPk, nowS(clock)));
  check(openAnswer(j2, poolPk, relay.take((e) => e.kind === 4 && e.tags[0][1] === j2.pk)).type === 'credentials', 'H10 a key noted at open (tatara.js) is answered at once');
  // a flood of strangers' joins does not starve a known key's messages
  await tick(); clock.go(1);
  for (let i = 0; i < 30; i++) relay.deliver(joinFrom(key(), poolPk, nowS(clock)));
  relay.deliver(joinFrom(j1, poolPk, nowS(clock) + 2));
  check(!!relay.take((e) => e.kind === 4 && e.tags[0][1] === j1.pk), 'H10 thirty strangers\' joins in the same second: the seat\'s own join is still answered (its own lane)');
  // a future-dated event is unread
  const fut = key(); relay.deliver(joinFrom(fut, poolPk, nowS(clock) + 3600));
  check(!relay.published.some((e) => e.kind === 4 && e.tags[0][1] === fut.pk), 'H10 an event dated an hour ahead gets no answer');
  // the room stops; the stranger's coin is refused in the next room for a day
  const realCoin = coinKeys.get(Array.from(coinKeys.keys()).pop());
  L.report(s1, n1.attempt_id, 'stopped'); await tick();
  clock.go(61); await tick();
  const ann2 = announced(relay)[1]; check(!!ann2, 'H10 after the pause a new room');
  const id2 = JSON.parse(ann2.content).id;
  const again = key();
  relay.deliver(msgFrom(again, ann2.pubkey, registration(again, id2, 50000, { coin: realCoin }), nowS(clock))); await settle(); await tick();
  check(H.summary()[0].registered === 0, 'H10 the same coin, re-proved for the new room by its owner: refused for a day (the bad-coins memory)');
  const other = key();
  relay.deliver(msgFrom(other, ann2.pubkey, registration(other, id2, 50000), nowS(clock))); await settle(); await tick();
  check(H.summary()[0].registered === 1, 'H10 a fresh coin registers');
}
// H11 (0.110.0, DP 2026-10-20 14:06) — the wait after empty rooms clears when the queue has no seats left; through a wait
// roomOf answers the next room's earliest moment; a fresh seat gets its first room within ROOM_GAP_S
{
  const { L, H, relay, clock, tick, logs } = mk();
  const s1 = seatOf(L, 1); await tick();
  const first = announced(relay)[0]; let w = JSON.parse(first.content).timeout - nowS(clock);
  clock.go(w - 180); await tick();   // empty → closed, the wait 60 s
  clock.go(61); await tick();         // the second room
  const second = announced(relay)[1]; w = JSON.parse(second.content).timeout - nowS(clock);
  clock.go(w - 180); await tick();   // empty again → the wait 120 s
  check(announced(relay).length === 2 && /next room for this size in 120 s/.test(logs.join('\n')), 'H11 two empty rooms: the wait is 120 s');
  const g = H.roomOf('chain', 50000);
  check(!!g && g.next_in_s === 120 && g.strangers === undefined && g.closes_in_s === undefined, 'H11 through the wait, roomOf answers the next room\'s earliest moment (120 s) and nothing of a room');
  clock.go(30); check(H.roomOf('chain', 50000).next_in_s === 90, 'H11 the moment counts down (90 s)');
  clock.go(31); await tick();
  check(announced(relay).length === 2 && H.roomOf('chain', 50000).next_in_s === 59, 'H11 the seat still waits: no room at 61 s, the wait holds (59 s left)');
  L.leave(s1); await tick();
  check(/the 50000 queue is empty — the wait after its empty rooms clears \(was 120 s\)/.test(logs.join('\n')) && H.roomOf('chain', 50000) === null, 'H11 the seat leaves: the queue is empty — the wait clears, roomOf answers nothing');
  const s2 = seatOf(L, 2); await tick();
  check(announced(relay).length === 3 && announced(relay)[2].pubkey !== second.pubkey, 'H11 a fresh seat: its room opens at once (ROOM_GAP_S long passed) — not after the old wait');
  const third = announced(relay)[2]; w = JSON.parse(third.content).timeout - nowS(clock);
  clock.go(w - 180); await tick();
  check(/next room for this size in 60 s at the earliest/.test(logs.join('\n').split('queue is empty')[1] || ''), 'H11 its empty close starts the doubling afresh (60 s), not from 240 s');
  const r = L.checkin(s2);
  check(r.ok && (H.roomOf('chain', 50000) || {}).next_in_s === 60, 'H11 the check-in\'s room field would carry next_in_s 60 through this wait');
}
console.log(fails ? `FAIL ×${fails}` : 'PASS · tatara-host (H1–H11)');
process.exit(fails ? 1 : 0);
})();
