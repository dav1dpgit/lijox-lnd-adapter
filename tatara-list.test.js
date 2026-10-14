// 0.98.0 (S58 — LIJOX's Tatara step 5, slice 2): THE WAITING LIST (tatara-list.js), on a clock of its own.
//   node tatara-list.test.js
'use strict';
const { createList, MISSED_STARTS_MAX } = require('./tatara-list');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const S = { sizes: [50000, 100000], min_people: 3, max_people: 6, countdown_s: 600, wake_window_s: 180, max_retries: 2, strikes: 4, max_pools_per_size: 3, max_pools_total: 10, max_list_per_size: 60 };

function mk(over = {}, disk = { saved: null }) {
  let t = 1_000_000;
  let n = 0;
  const clock = { at: () => t, go: (s) => { t += s * 1000; } };
  const L = createList({ settings: Object.assign({}, S, over), now: clock.at, newId: () => (++n).toString(16).padStart(32, '0'), save: (st) => { disk.saved = JSON.parse(JSON.stringify(st)); }, load: () => disk.saved });
  return { L, clock, disk };
}
const seats = (L, k, size = 50000, wake = true, ownerBase = 'w') => Array.from({ length: k }, (_, i) => L.seat({ owner: ownerBase + i, size, seatPk: ownerBase + 'pk' + i + ':' + size, wake: wake ? { endpoint: 'https://push/' + ownerBase + i } : null }).seat_id);
const types = (r) => (r.notices || []).map((x) => x.type);
const everyone = (L, ids) => ids.map((id) => L.checkin(id));

// L1 — seat rules
{
  const { L } = mk({ max_list_per_size: 3 });
  check(L.seat({ owner: 'a', size: 70000, seatPk: 'k1' }).reason === 'size_not_offered', 'L1 a size not offered: refused');
  check(L.seat({ owner: 'a', size: 50000, seatPk: 'k1' }).ok && L.seat({ owner: 'a', size: 50000, seatPk: 'k2' }).reason === 'already_seated', 'L1 one seat per wallet per size');
  check(L.seat({ owner: 'b', size: 50000, seatPk: 'k1' }).reason === 'seat_key_used', 'L1 a seat key used twice: refused');
  L.seat({ owner: 'b', size: 50000, seatPk: 'k3' }); L.seat({ owner: 'c', size: 50000, seatPk: 'k4' });
  check(L.seat({ owner: 'd', size: 50000, seatPk: 'k5' }).reason === 'list_full', 'L1 the list length cap holds');
  check(L.seat({ owner: 'a', size: 100000, seatPk: 'k6' }).ok, 'L1 the same wallet may wait in another size');
}
// L2 — the count and the countdown's start and clearing
{
  const { L, clock } = mk();
  const ids = seats(L, 2);
  L.tick();
  let r = L.checkin(ids[0]);
  check(r.count.joined === 2 && r.count.online === 2 && r.count.starts_in_s === null && r.count.needed === 3, 'L2 two joined: "2 joined · 2 online · starts when 3 have joined", no countdown');
  const third = L.seat({ owner: 'x', size: 50000, seatPk: 'xk', wake: { endpoint: 'p' } }).seat_id;
  L.tick();
  r = L.checkin(ids[0]);
  check(r.count.joined === 3 && r.count.starts_in_s === 600, 'L2 the third joins: the countdown starts at 600 s');
  clock.go(100); L.tick();
  check(L.checkin(ids[1]).count.starts_in_s === 500, 'L2 100 s later: 500 s left');
  clock.go(31);
  check(L.checkin(ids[0]).count.online === 1, 'L2 seats silent over 30 s are not "online now" (1 of 3 just checked in)');
  L.leave(third); L.tick();
  check(L.checkin(ids[0]).count.starts_in_s === null, 'L2 the count falls below 3: the countdown stops and clears');
}
// L3/L4 — the start at zero; the wake; the 3 minutes; the first to open creates
{
  const { L, clock } = mk();
  const ids = seats(L, 4);
  ids.forEach((id) => L.checkin(id));
  L.tick(); clock.go(600);
  const w = L.tick().wakes;
  check(w.length === 4 && w.every((x) => x.attempt_id === w[0].attempt_id && x.wake && x.wake.endpoint), 'L3 at zero: every seat of the group is woken, one attempt id');
  const aid = w[0].attempt_id;
  const r0 = L.checkin(ids[0]);
  check(r0.state === 'starting' && types(r0).includes('start') && r0.notices.find((x) => x.type === 'start').open_within_s === 180, 'L3 a seat sees "start" with 3 minutes to open');
  check(L.open(ids[2], aid).ok && L.open(ids[0], aid).ok && L.open(ids[1], aid).ok, 'L4 three open (the third first)');
  check(L.open(ids[0], 'f'.repeat(32)).reason === 'not_in_this_start', 'L4 an open for another attempt: refused');
  clock.go(181);
  check(L.open(ids[3], aid).reason === 'too_late', 'L4 after the 3 minutes: too late');
  L.tick();
  const a = L.attemptOf(aid);
  check(a && a.creator === ids[2] && a.seats.length === 3, 'L4 the attempt: 3 opened; the first to open creates');
  check(types(L.checkin(ids[2])).includes('create') && types(L.checkin(ids[0])).includes('wait_for_announcement'), 'L4 the creator is told "create", the others "wait for the announcement"');
  const m = L.checkin(ids[3]);
  check(m.state === 'waiting' && m.notices.some((x) => x.type === 'missed_start' && x.missed === 1), 'L4 the seat that did not open: back to waiting, "missed a start (1 of 2)"');
  // L6 — the announcement goes to the others only, and only from the creator
  check(L.announce(ids[0], aid, 'ann').reason === 'not_the_creator', 'L6 only the creator hands over the announcement');
  check(L.announce(ids[2], aid, '{"type":"new_pool"}').ok, 'L6 the creator\'s announcement taken');
  const o1 = L.checkin(ids[1]);
  check(o1.notices.some((x) => x.type === 'announcement' && x.announcement === '{"type":"new_pool"}') && !types(L.checkin(ids[2])).includes('announcement'), 'L6 passed to the other opened seats, not back to the creator');
  check(!types(L.checkin(ids[3])).includes('announcement'), 'L6 never to a seat outside the attempt');
  // L7 — funding signed: done, off the list, strikes cleared
  check(L.report(ids[1], aid, 'funding_signed').phase === 'signed', 'L7 a member reports "funding signed"');
  const d = L.checkin(ids[0]);
  check(d.state === 'removed' && types(d).includes('done') && L.checkin(ids[0]).reason === 'no_such_seat', 'L7 its seats are told "done" once and leave the list');
  check(L.state().strikes[ 'w0' ] === 0, 'L7 a funding signed clears the strike count');
}
// L4b — a second missed start removes the seat
{
  const { L, clock } = mk();
  const ids = seats(L, 3);
  for (let round = 1; round <= MISSED_STARTS_MAX; round++) {
    ids.forEach((id) => L.checkin(id));
    L.tick(); clock.go(600); L.tick(); clock.go(181); L.tick();
  }
  const r = L.checkin(ids[0]);
  check(r.state === 'removed' && r.notices.some((x) => x.type === 'removed' && x.reason === 'missed_two_starts'), 'L4b a seat that misses two starts is removed and told why');
}
// L5 — fewer than 3 open: no pool, the opened go to the front
{
  const { L, clock } = mk();
  const ids = seats(L, 4);
  const late = L.seat({ owner: 'late', size: 50000, seatPk: 'latek' }).seat_id;
  L.tick(); clock.go(600);
  const aid = L.tick().wakes[0].attempt_id;
  L.open(ids[2], aid); L.open(ids[3], aid);
  clock.go(181); L.tick();
  const q = L.state().queues['chain:50000'];
  check(q[0] === ids[2] && q[1] === ids[3], 'L5 two opened of five: no pool; the two opened are now at the front');
  check(L.checkin(ids[2]).notices.some((x) => x.type === 'no_pool' && x.opened === 2), 'L5 they are told "no pool — 2 opened, 3 needed"');
  check(q.includes(late), 'L5 nobody lost their seat');
}
// L8 — a stop: a retry with the phones still open; at most 2; then back to the front
{
  const { L, clock } = mk();
  const ids = seats(L, 3);
  L.tick(); clock.go(600);
  let aid = L.tick().wakes[0].attempt_id;
  ids.forEach((id) => L.open(id, aid)); L.tick();
  L.announce(L.attemptOf(aid).creator, aid, 'ann');
  for (let tr = 2; tr <= 3; tr++) {
    ids.forEach((id) => L.checkin(id));
    L.report(ids[0], aid, 'stopped');
    const r = L.checkin(ids[1]);
    const rn = r.notices.find((x) => x.type === 'retry');
    check(r.state === 'starting' && rn && rn.try === tr && rn.of === 3, `L8 a stop → retry ${tr - 1} (try ${tr} of 3), no wake needed`);
    aid = rn.attempt_id;
    ids.forEach((id) => L.open(id, aid)); L.tick();
    check(L.attemptOf(aid) && L.attemptOf(aid).try === tr, `L8 the retry's attempt runs (try ${tr})`);
  }
  ids.forEach((id) => L.checkin(id));
  L.report(ids[2], aid, 'stopped');
  const last = L.checkin(ids[1]);
  check(last.state === 'waiting' && last.notices.some((x) => x.type === 'stopped' && x.reason === 'retries_used'), 'L8 after 2 retries: stopped, "retries used", back on the list');
  check(L.state().queues['chain:50000'].slice(0, 3).sort().join() === ids.slice().sort().join(), 'L8 at the front');
  check(L.report(ids[0], aid, 'stopped').reason === 'not_in_this_attempt', 'L8 a late report for an ended attempt changes nothing');
}
// L8b — a retry takes only the phones still open
{
  const { L, clock } = mk();
  const ids = seats(L, 4);
  L.tick(); clock.go(600);
  const aid = L.tick().wakes[0].attempt_id;
  ids.forEach((id) => L.open(id, aid)); L.tick();
  clock.go(40); [ids[0], ids[1], ids[2]].forEach((id) => L.checkin(id));
  L.report(ids[0], aid, 'stopped');
  const gone = L.checkin(ids[3]);
  check(gone.state === 'waiting' && gone.notices.some((x) => x.type === 'stopped' && x.reason === 'retry_without_you'), 'L8b a phone silent for 40 s is not taken into the retry, and is told');
}
// L9 — four pools in a row stopped at the payout step → off the list
{
  const { L, clock } = mk({ max_retries: 0 });
  const ids = seats(L, 3);
  for (let k = 1; k <= 4; k++) {
    ids.forEach((id) => L.checkin(id));
    L.tick(); clock.go(600);
    const aid = L.tick().wakes[0].attempt_id;
    ids.forEach((id) => L.open(id, aid)); L.tick();
    ids.forEach((id) => L.checkin(id));
    L.report(ids[0], aid, 'stopped_at_payouts');
    if (k < 4) check(L.state().strikes.w0 === k && L.seatOf(ids[0]).state === 'waiting', `L9 pool ${k} stopped at the payout step: strike ${k}`);
  }
  const r = L.checkin(ids[1]);
  check(r.state === 'removed' && r.notices.some((x) => x.type === 'removed' && x.reason === 'strikes'), 'L9 the fourth in a row: off the list, told why');
}
// L10 — busy: the pool limits hold a start
{
  const { L, clock } = mk({ max_pools_per_size: 1, max_pools_total: 1 });
  const a = seats(L, 6, 50000, true, 'a');
  const first = L.tick().wakes;
  check(first.length === 6, 'L10 six joined: the pool starts at once (no countdown)');
  const aid = first[0].attempt_id;
  a.forEach((id) => L.open(id, aid)); L.tick();
  const b = seats(L, 6, 50000, true, 'b');
  check(L.tick().wakes.length === 0 && L.checkin(b[0]).count.busy === true, 'L10 a second full group waits: "busy" while the first pool runs');
  L.announce(L.attemptOf(aid).creator, aid, 'ann');
  L.report(a[0], aid, 'funding_signed');
  check(L.tick().wakes.length === 6, 'L10 the first pool signed: its slot is free and the second starts');
}
// L11 — a wallet in one pool at a time; L12 — paused seats are not counted
{
  const { L } = mk();
  L.seat({ owner: 'z', size: 100000, seatPk: 'z1' });
  seats(L, 5, 50000, true, 'p');
  const zs = L.seat({ owner: 'z', size: 50000, seatPk: 'z2', wake: { endpoint: 'pz' } }).seat_id;
  const w = L.tick().wakes;
  check(w.length === 6 && w.some((x) => x.seat_id === zs), 'L11 six in the 50,000 queue start, the wallet "z" among them');
  ['y0', 'y1'].forEach((o, i) => L.seat({ owner: o, size: 100000, seatPk: 'y' + i }));
  L.tick();
  check(L.checkin(L.state().queues['chain:100000'][0]).count.joined === 2, 'L11 while "z" is starting, its 100,000 seat is not counted');
  const { L: L2 } = mk();
  const ids = seats(L2, 3);
  L2.pause(ids[0]); L2.tick();
  check(L2.checkin(ids[1]).count.joined === 2 && L2.checkin(ids[1]).count.starts_in_s === null, 'L12 a paused seat is not counted (place kept)');
  L2.resume(ids[0]); L2.tick();
  check(L2.checkin(ids[1]).count.starts_in_s === 600, 'L12 resumed: counted again');
}
// L13 — a restart ends what was in progress; seats keep their places
{
  const disk = { saved: null };
  const { L, clock } = mk({}, disk);
  const ids = seats(L, 4);
  L.tick(); clock.go(600);
  const aid = L.tick().wakes[0].attempt_id;
  ids.slice(0, 3).forEach((id) => L.open(id, aid)); clock.go(181); L.tick();
  check(L.attemptOf(aid) !== null, 'L13 an attempt in progress before the restart');
  const { L: R } = mk({}, disk);
  const r = R.checkin(ids[0]);
  check(R.attemptOf(aid) === null && r.state === 'waiting' && r.notices.some((x) => x.type === 'stopped' && x.reason === 'provider_restarted'), 'L13 after the restart: the attempt is over (never continued); its seats told why');
  check(R.state().queues['chain:50000'].join() === ids.join(), 'L13 every seat keeps its place');
}
// L14 — timeouts
{
  const { L, clock } = mk();
  const ids = seats(L, 3);
  L.tick(); clock.go(600);
  const aid = L.tick().wakes[0].attempt_id;
  ids.forEach((id) => L.open(id, aid)); L.tick();
  clock.go(301); ids.forEach((id) => L.checkin(id)); L.tick();
  check(L.attemptOf(aid) === null && L.checkin(ids[1]).notices.some((x) => x.type === 'retry'), 'L14 no announcement in 5 minutes: the attempt stops and a retry starts');
  const { L: L2, clock: c2 } = mk();
  const id2 = seats(L2, 1)[0];
  c2.go(7 * 86400 + 1); L2.tick();
  check(L2.checkin(id2).notices.some((x) => x.type === 'removed' && x.reason === 'idle_a_week'), 'L14 a seat with no check-in for a week is removed and told');
}
// L15 — seven in a queue: a group of six starts, the seventh begins the next group
{
  const { L } = mk();
  const ids = seats(L, 7);
  const w = L.tick().wakes;
  check(w.length === 6 && !w.some((x) => x.seat_id === ids[6]), 'L15 six start at once; the seventh waits for the next group');
  check(L.checkin(ids[6]).count.joined === 1, 'L15 the seventh sees "1 joined"');
}
// L16 (0.102.0) — the creator is told the other opened seats' keys (to seal the pool's key to each); no one else is
{
  const { L, clock } = mk();
  const ids = seats(L, 3, 50000, true, 'k');
  ids.forEach((id) => L.checkin(id));
  L.tick(); clock.go(600);
  const w = L.tick().wakes; const aid = w[0].attempt_id;
  check(L.open(ids[1], aid).ok && L.open(ids[0], aid).ok && L.open(ids[2], aid).ok, 'L16 three open (the second first)');
  clock.go(181); L.tick();
  const c = L.checkin(ids[1]).notices.find((x) => x.type === 'create');
  check(c && JSON.stringify(c.seat_pks) === JSON.stringify(['kpk0:50000', 'kpk2:50000']), 'L16 the create notice names the other opened seats\' keys, in their order, not the creator\'s');
  const o = L.checkin(ids[0]).notices.find((x) => x.type === 'wait_for_announcement');
  check(o && !('seat_pks' in o), 'L16 a waiting seat is told no keys');
}
// L17 (0.103.0) — the notices name the route (a chain pool: "chain")
{
  const { L, clock } = mk();
  const ids = seats(L, 3, 50000, true, 'r');
  ids.forEach((id) => L.checkin(id));
  L.tick(); clock.go(600);
  const w = L.tick().wakes; const aid = w[0].attempt_id;
  ids.forEach((id) => L.open(id, aid));
  clock.go(181); L.tick();
  const c = L.checkin(ids[0]).notices.find((x) => x.type === 'create');
  const o = L.checkin(ids[1]).notices.find((x) => x.type === 'wait_for_announcement');
  check(c && c.route === 'chain' && o && o.route === 'chain', 'L17 the create and wait_for_announcement notices name the route');
}
console.log(fails ? 'FAIL · tatara-list · ' + fails + ' failed' : 'PASS · tatara-list (L1–L17)');
process.exit(fails ? 1 : 0);
