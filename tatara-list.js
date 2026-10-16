// tatara-list.js — 0.98.0 (S58, LIJOX's Tatara step 5, slice 2): THE WAITING LIST. Pure: no network, no signing, no
// clock or random source of its own — the module hands them in (tatara.js). Spec v0.10 §4 and §8; design
// docs/design/mix/tatara-adapter-r1.md §4.
//
// A queue per size and route. Seats in join order. The head group is the first MAX_PEOPLE seats that are waiting, not
// paused, and whose wallet is not already starting or in a pool; its countdown starts when it has MIN_PEOPLE and clears
// when it falls below; a full group starts at once. At zero (and room under the pool limits) the group's seats are
// woken with a new attempt id and have WAKE_WINDOW_S to open. At least MIN_PEOPLE opened → the attempt: the first seat
// that opened is told to create the pool; its announcement goes to the other opened seats only. Fewer → no pool; the
// opened seats go to the front of the queue. A seat that misses two starts is removed and told why. A stop report →
// a retry with the attempt's seats (they open again; no wake), at most MAX_RETRIES; then every seat back to the front.
// A stop at the payout step counts a strike for every seat's wallet; a funding signed clears it; STRIKES in a row →
// removed. After a restart, every start and attempt in progress is ended — never continued.
//
// What a seat is told comes as notices, read at its next check-in (tatara.js signs the ones the spec says are signed).
//
// 0.106.0 (S59 Thu, Phase 2b — docs/design/mix/tatara-public-r1.md): THE HOSTED ROOM's hooks. The host (tatara-host.js)
// opens a public room for a queue short of MIN_PEOPLE; the seats it may take are `eligibleFor` (waiting, unpaused, the
// wallet free, the seat's "public pools" switch on, not holding back after a missed room wake); while the room has
// strangers in it the seats it will take are `reserve`d — the head group skips them, so no LIJOX pool starts with them;
// `roomStart` wakes them with a "room" notice (the announcement, the public relay, the reserved-seat token); a missed
// room wake is NOT a missed start (DP 2026-10-15: no penalty, no re-seating — the seat holds back until the app opens
// once: `room_hold`, cleared at the next check-in); the host decides the outcome (`roomOutcome`): signed → the seats
// are done; stopped → back to the front, no retry (a public room cannot be retried).
'use strict';

const ONLINE_S = 30;                 // "online now": a check-in in the last 30 s (§4.2)
const MISSED_STARTS_MAX = 2;         // a seat that misses two starts is removed (§4.6)
const SEAT_IDLE_MAX_S = 7 * 86400;   // a seat with no check-in for a week is removed (a closed phone can wait days; not forever)
const NOTICES_MAX = 20;
const CREATE_MAX_S = 300;            // the creating phone hands over its announcement within 5 minutes, or the attempt stops
const ATTEMPT_MAX_S = 3600;          // an attempt nobody reports on for an hour is ended (its slot freed)
const SIGNED_KEEP_S = 86400;         // a signed attempt's entry is kept a day (the backup sender keeps its own copy)

function createList(opts) {
  const { settings, now, newId, save = () => {}, load = () => null, log = () => {} } = opts;
  const S = settings;
  const nowS = () => Math.floor(now() / 1000);
  let st = { seats: {}, queues: {}, strikes: {}, starts: {}, attempts: {} };

  const qkey = (route, size) => route + ':' + size;
  const persist = () => { try { save(st); } catch (e) { log(`[Tatara] list not saved: ${e.message}`); } };
  const tell = (seat, notice) => {
    seat.notices.push(Object.assign({ at: nowS() }, notice));
    if (seat.notices.length > NOTICES_MAX) seat.notices.splice(0, seat.notices.length - NOTICES_MAX);
  };
  const ownerBusy = (owner) => Object.values(st.seats).some((x) => x.owner === owner && (x.state === 'starting' || x.state === 'in_attempt'));
  const reserved = new Map();   // 0.106.0: queue key → seat ids a hosted room will take (never persisted: rooms end with a restart)
  const running = (size) => {
    const live = Object.values(st.starts).concat(Object.values(st.attempts).filter((a) => a.phase !== 'signed'));
    return { size: live.filter((x) => x.size === size).length, total: live.length };
  };
  function removeSeat(id, reason) {
    const s = st.seats[id];
    if (!s) return;
    const q = st.queues[qkey(s.route, s.size)];
    if (q) { const i = q.indexOf(id); if (i >= 0) q.splice(i, 1); }
    if (reason) { s.state = 'removed'; s.removed = reason; tell(s, reason === 'done' ? { type: 'done', attempt_id: s.attempt_id } : { type: 'removed', reason }); s.gone_at = nowS(); }
    else delete st.seats[id];
  }
  const toFront = (ids) => {
    for (const id of ids.slice().reverse()) {
      const s = st.seats[id]; if (!s) continue;
      const q = st.queues[qkey(s.route, s.size)] || (st.queues[qkey(s.route, s.size)] = []);
      const i = q.indexOf(id); if (i >= 0) q.splice(i, 1);
      q.unshift(id);
    }
  };

  /// The head group of a queue: up to MAX_PEOPLE waiting, unpaused seats whose wallet is free.
  function headGroup(route, size) {
    const q = st.queues[qkey(route, size)] || [];
    const g = [], owners = new Set();
    const held = reserved.get(qkey(route, size)) || [];
    for (const id of q) {
      const s = st.seats[id];
      if (!s || s.state !== 'waiting' || s.paused || owners.has(s.owner) || ownerBusy(s.owner) || held.includes(id)) continue;
      g.push(id); owners.add(s.owner);
      if (g.length === S.max_people) break;
    }
    return g;
  }
  /// 0.106.0: the seats a hosted room may take, in queue order — the head group's rules, plus the seat's own "public
  /// pools" switch and no hold-back after a missed room wake. Seats reserved for a room are included (they are its own).
  function eligibleFor(route, size) {
    const q = st.queues[qkey(route, size)] || [];
    const g = [], owners = new Set();
    for (const id of q) {
      const s = st.seats[id];
      if (!s || s.state !== 'waiting' || s.paused || !s.public_ok || s.room_hold || owners.has(s.owner) || ownerBusy(s.owner)) continue;
      g.push(id); owners.add(s.owner);
    }
    return g;
  }
  function reserve(route, size, ids) { const k = qkey(route, size); if (ids && ids.length) reserved.set(k, ids.slice()); else reserved.delete(k); }
  const headCount = (route, size) => headGroup(route, size).length;

  // ── restore: anything in progress is over (§8.0, §8.8) ──
  try {
    const j = load();
    if (j && j.seats) {
      st = Object.assign({ seats: {}, queues: {}, strikes: {}, starts: {}, attempts: {} }, j);
      const ended = Object.keys(st.starts).length + Object.values(st.attempts).filter((a) => a.phase !== 'signed').length;
      for (const s of Object.values(st.seats)) {
        if (s.state === 'starting' || s.state === 'in_attempt') { s.state = 'waiting'; s.attempt_id = null; tell(s, { type: 'stopped', reason: 'provider_restarted' }); }
      }
      st.starts = {};
      for (const [id, a] of Object.entries(st.attempts)) if (a.phase !== 'signed') delete st.attempts[id];
      for (const k of Object.keys(st.queues)) st.queues[k] = st.queues[k].filter((id) => st.seats[id]);
      st.countdowns = {};
      if (ended) log(`[Tatara] restart: ${ended} start(s)/attempt(s) in progress ended (never continued); their seats keep their places`);
      persist();
    }
  } catch (e) { log(`[Tatara] list not restored (${e.message}) — starting empty`); }
  if (!st.countdowns) st.countdowns = {};

  // ── seats ──
  function seat({ owner, size, route = 'chain', seatPk, wake = null, week = null, publicOk = false, feeCap = null }) {
    // 0.105.0: each route by its own list — "chain" TATARA_SIZES, "channel" the channel sizes (a channel's coin after its
    // close is an on-chain coin and seats on the chain route — DP 2026-10-14; 0.105.0's "close" route is gone)
    if (route === 'chain') { if (!S.sizes.includes(size)) return { ok: false, reason: 'size_not_offered' }; }
    else if (route === 'channel') { if (!(S.channel_pools && Array.isArray(S.channel_sizes) && S.channel_sizes.includes(size))) return { ok: false, reason: 'route_not_offered' }; }   // 0.103.0: the channel route
    else return { ok: false, reason: 'route_not_offered' };
    const q = st.queues[qkey(route, size)] || (st.queues[qkey(route, size)] = []);
    if (Object.values(st.seats).some((x) => x.owner === owner && x.size === size && x.route === route && x.state !== 'removed')) return { ok: false, reason: 'already_seated' };
    if (Object.values(st.seats).some((x) => x.seat_pk === seatPk && x.state !== 'removed')) return { ok: false, reason: 'seat_key_used' };
    if (q.length >= S.max_list_per_size) return { ok: false, reason: 'list_full' };
    const id = newId();
    st.seats[id] = { id, owner, size, route, seat_pk: seatPk, wake, week, joined_at: nowS(), last_checkin: nowS(), paused: false, missed: 0, state: 'waiting', attempt_id: null, notices: [],
      public_ok: publicOk === true, fee_cap_milli: Number.isSafeInteger(feeCap) && feeCap > 0 ? feeCap : null, room_hold: false };   // 0.106.0: the seat's "public pools" switch; its fee cap (thousandths of a sat/vB — the phone's own limit) for a hosted room's rate
    q.push(id);
    persist();
    return { ok: true, seat_id: id };
  }

  /// The public count for a seat's queue (§4.3): joined (unpaused waiting seats in its group or ahead), online now, the
  /// seconds left when a countdown runs, and "busy" when the pool limits hold the start.
  function countFor(route, size) {
    const g = headGroup(route, size);
    const t = nowS();
    const cd = st.countdowns[qkey(route, size)];
    const online = g.filter((id) => t - st.seats[id].last_checkin <= ONLINE_S).length;
    const r = running(size);
    const busy = r.size >= S.max_pools_per_size || r.total >= S.max_pools_total;
    return { joined: g.length, online, needed: S.min_people, max: S.max_people, starts_in_s: cd ? Math.max(0, cd + S.countdown_s - t) : null, busy };
  }

  function checkin(id) {
    const s = st.seats[id];
    if (!s) return { ok: false, reason: 'no_such_seat' };
    s.last_checkin = nowS();
    s.room_hold = false;   // 0.106.0: the app is open — the seat may take a hosted room again
    const notices = s.notices.splice(0);
    if (s.state === 'removed') { delete st.seats[id]; persist(); return { ok: true, state: 'removed', notices }; }
    persist();
    return { ok: true, state: s.state, paused: s.paused, attempt_id: s.attempt_id, count: countFor(s.route, s.size), notices };
  }
  function leave(id) {
    const s = st.seats[id];
    if (!s) return { ok: false, reason: 'no_such_seat' };
    if (s.state === 'in_attempt') return { ok: false, reason: 'in_a_pool' };   // the phone stops its attempt first (abort), then leaves
    if (s.state === 'starting') { const sp = st.starts[s.attempt_id]; if (sp) sp.seats = sp.seats.filter((x) => x !== id); }
    removeSeat(id, null);
    persist();
    return { ok: true };
  }
  function pause(id, on) {
    const s = st.seats[id];
    if (!s) return { ok: false, reason: 'no_such_seat' };
    if (s.state !== 'waiting') return { ok: false, reason: 'not_waiting' };
    s.paused = !!on; persist();
    return { ok: true };
  }

  // ── the start (§4.5, §4.6) ──
  function startGroup(route, size, ids, tryN, retryOf) {
    const attemptId = newId();
    st.starts[attemptId] = { attempt_id: attemptId, route, size, seats: ids.slice(), opened: [], deadline: nowS() + S.wake_window_s, try: tryN, retry_of: retryOf || null };
    const wakes = [];
    for (const id of ids) {
      const s = st.seats[id];
      s.state = 'starting'; s.attempt_id = attemptId;
      tell(s, { type: tryN > 1 ? 'retry' : 'start', attempt_id: attemptId, size, try: tryN, of: S.max_retries + 1, open_within_s: S.wake_window_s });
      if (tryN === 1 && s.wake) wakes.push({ seat_id: id, wake: s.wake, attempt_id: attemptId, size });
    }
    log(`[Tatara] ${tryN > 1 ? 'retry ' + (tryN - 1) : 'start'} ${attemptId.slice(0, 8)} · ${size} sats · ${ids.length} seat(s) · ${S.wake_window_s} s to open`);
    return wakes;
  }

  /// 0.106.0: the hosted room's wake — the promised seats are told the room (the announcement, the public relay, the
  /// reserved-seat token) and have WAKE_WINDOW_S to open and join by the public handshake. One try: a public room has no
  /// retry.
  function roomStart(route, size, ids, room) {
    const attemptId = room.attempt_id;
    reserve(route, size, null);
    st.starts[attemptId] = { attempt_id: attemptId, route, size, seats: ids.slice(), opened: [], deadline: nowS() + S.wake_window_s, try: 1, retry_of: null, room: true, join_pks: {} };
    const wakes = [];
    for (const id of ids) {
      const s = st.seats[id];
      s.state = 'starting'; s.attempt_id = attemptId;
      tell(s, { type: 'room', attempt_id: attemptId, route, size, peers: room.peers, relay: room.relay, event: room.event, open_within_s: S.wake_window_s });   // no token (review 2b #4/#5): the phone names its join key at `open`
      if (s.wake) wakes.push({ seat_id: id, wake: s.wake, attempt_id: attemptId, size });
    }
    log(`[Tatara] room ${attemptId.slice(0, 8)} · ${size} sats · ${ids.length} seat(s) woken · ${S.wake_window_s} s to open and join`);
    persist();
    return wakes;
  }

  function open(id, attemptId, joinPk = null) {
    const s = st.seats[id];
    const sp = st.starts[attemptId];
    if (!s || !sp || s.attempt_id !== attemptId || !sp.seats.includes(id)) return { ok: false, reason: 'not_in_this_start' };
    if (nowS() > sp.deadline) return { ok: false, reason: 'too_late' };
    if (sp.room) { if (!joinPk) return { ok: false, reason: 'join_pk_needed' }; sp.join_pks[id] = joinPk; }   // 0.106.0: a room's open names the phone's join key (the host answers it)
    if (!sp.opened.includes(id)) sp.opened.push(id);
    persist();
    return { ok: true, opened: sp.opened.length };
  }

  function closeStart(sp) {
    delete st.starts[sp.attempt_id];
    const opened = sp.opened.filter((id) => st.seats[id]);
    const missed = sp.seats.filter((id) => st.seats[id] && !opened.includes(id));
    if (sp.room) {
      // 0.106.0: a missed room wake is no strike and no re-seating — the seat holds back until the app opens once
      for (const id of missed) { const s = st.seats[id]; s.state = 'waiting'; s.attempt_id = null; s.room_hold = true; tell(s, { type: 'missed_room', attempt_id: sp.attempt_id }); }
      if (opened.length) {
        const seatPks = {}; for (const id of opened) seatPks[id] = st.seats[id].seat_pk;
        st.attempts[sp.attempt_id] = { attempt_id: sp.attempt_id, route: sp.route, size: sp.size, seats: opened, creator: null, try: 1, phase: 'running', announcement: null, reports: {}, created_at: nowS(), token: null, seat_pks: seatPks, room: true, join_pks: sp.join_pks || {} };
        for (const id of opened) { const s = st.seats[id]; s.state = 'in_attempt'; }
        log(`[Tatara] room ${sp.attempt_id.slice(0, 8)}: ${opened.length} of ${sp.seats.length} seat(s) opened — they join the room`);
      } else log(`[Tatara] room ${sp.attempt_id.slice(0, 8)}: no seat opened — the room runs short`);
      return;
    }
    for (const id of missed) {
      const s = st.seats[id];
      s.state = 'waiting'; s.attempt_id = null;
      if (sp.try === 1) {
        s.missed += 1;
        if (s.missed >= MISSED_STARTS_MAX) { removeSeat(id, 'missed_two_starts'); continue; }
        tell(s, { type: 'missed_start', attempt_id: sp.attempt_id, missed: s.missed, of: MISSED_STARTS_MAX });
      } else {
        tell(s, { type: 'stopped', attempt_id: sp.attempt_id, reason: 'not_back_for_the_retry' });
      }
    }
    if (opened.length >= S.min_people) {
      const creator = opened[0];
      const token = newId() + newId();   // 0.99.0: the pool's posting token — the relay room opens with it at the announcement
      const seatPks = {}; for (const id of opened) seatPks[id] = st.seats[id].seat_pk;   // 0.100.0: the backup is checked against these after the seats have gone
      st.attempts[sp.attempt_id] = { attempt_id: sp.attempt_id, route: sp.route, size: sp.size, seats: opened, creator, try: sp.try, phase: 'creating', announcement: null, reports: {}, created_at: nowS(), token, seat_pks: seatPks };
      for (const id of opened) {
        const s = st.seats[id];
        s.state = 'in_attempt'; s.missed = 0;
        tell(s, id === creator
          // 0.102.0: the other opened seats' keys — the creating phone seals the pool's key to each (the provider never sees it)
          ? { type: 'create', attempt_id: sp.attempt_id, route: sp.route, size: sp.size, peers: opened.length, try: sp.try, token, seat_pks: opened.filter((x) => x !== creator).map((x) => st.seats[x].seat_pk) }
          : { type: 'wait_for_announcement', attempt_id: sp.attempt_id, route: sp.route, size: sp.size, peers: opened.length, try: sp.try, token });   // 0.103.0: the route named (a channel pool declares payout_type p2wsh)
      }
      log(`[Tatara] attempt ${sp.attempt_id.slice(0, 8)}: ${opened.length} opened — the first creates the pool (try ${sp.try} of ${S.max_retries + 1})`);
      return;
    }
    // fewer than MIN_PEOPLE: no pool; the opened go to the front
    for (const id of opened) { const s = st.seats[id]; s.state = 'waiting'; s.attempt_id = null; tell(s, { type: 'no_pool', attempt_id: sp.attempt_id, opened: opened.length, needed: S.min_people }); }
    toFront(opened);
    log(`[Tatara] start ${sp.attempt_id.slice(0, 8)}: ${opened.length} of ${sp.seats.length} opened — below ${S.min_people}, no pool; the opened go to the front`);
  }

  function announce(id, attemptId, announcement) {
    const a = st.attempts[attemptId];
    if (!a || a.creator !== id || a.phase !== 'creating') return { ok: false, reason: 'not_the_creator' };
    if (typeof announcement !== 'string' || announcement.length > 32768) return { ok: false, reason: 'bad_announcement' };
    a.announcement = announcement; a.phase = 'running';
    for (const sid of a.seats) if (sid !== id && st.seats[sid]) tell(st.seats[sid], { type: 'announcement', attempt_id: attemptId, announcement });
    persist();
    return { ok: true };
  }

  /// 0.106.0: the host's verdict on a hosted room — 'funding_signed' (the seats are done) or 'stopped' (back to the
  /// front; no retry). A seat's own report on a room attempt lands here too.
  function roomOutcome(attemptId, outcome) {
    const a = st.attempts[attemptId];
    if (!a || !a.room) return { ok: false, reason: 'no_such_room' };
    if (a.phase === 'signed' || a.phase === 'stopped') return { ok: true, phase: a.phase };
    if (outcome === 'funding_signed') {
      a.phase = 'signed'; a.signed_at = nowS();
      for (const sid of a.seats) { const s = st.seats[sid]; if (!s) continue; st.strikes[s.owner] = 0; removeSeat(sid, 'done'); }
      log(`[Tatara] room ${attemptId.slice(0, 8)}: funding signed — its seats leave the list`);
      persist();
      return { ok: true, phase: 'signed' };
    }
    delete st.attempts[attemptId];
    const left = [];
    for (const sid of a.seats) { const s = st.seats[sid]; if (!s) continue; s.state = 'waiting'; s.attempt_id = null; tell(s, { type: 'stopped', attempt_id: attemptId, reason: 'room_stopped' }); left.push(sid); }
    toFront(left);
    log(`[Tatara] room ${attemptId.slice(0, 8)} stopped — its seats back to the front`);
    persist();
    return { ok: true, phase: 'stopped' };
  }

  /// A phone's outcome: 'funding_signed' | 'stopped' | 'stopped_at_payouts'. The first stop decides; later ones are noted.
  function report(id, attemptId, outcome) {
    const a = st.attempts[attemptId];
    if (!a || !a.seats.includes(id)) return { ok: false, reason: 'not_in_this_attempt' };
    if (!['funding_signed', 'stopped', 'stopped_at_payouts'].includes(outcome)) return { ok: false, reason: 'bad_outcome' };
    if (a.room) { a.reports[id] = outcome; return roomOutcome(attemptId, outcome === 'funding_signed' ? 'funding_signed' : 'stopped'); }   // 0.106.0
    a.reports[id] = outcome;
    if (a.phase === 'signed' || a.phase === 'stopped') { persist(); return { ok: true, phase: a.phase }; }
    if (outcome === 'funding_signed') {
      a.phase = 'signed';
      a.signed_at = nowS();
      for (const sid of a.seats) {
        const s = st.seats[sid]; if (!s) continue;
        st.strikes[s.owner] = 0;
        removeSeat(sid, 'done');
      }
      log(`[Tatara] attempt ${attemptId.slice(0, 8)}: funding signed — its seats leave the list`);
      persist();
      return { ok: true, phase: 'signed' };
    }
    a.phase = 'stopped';
    const owners = a.seats.map((sid) => st.seats[sid]).filter(Boolean);
    if (outcome === 'stopped_at_payouts') {
      for (const s of owners) {
        st.strikes[s.owner] = (st.strikes[s.owner] || 0) + 1;
        if (st.strikes[s.owner] >= S.strikes) { s.strike_out = true; }
      }
    }
    // the retry: the attempt's seats still checking in, at least MIN_PEOPLE, retries left
    const t = nowS();
    const back = a.seats.filter((sid) => st.seats[sid] && !st.seats[sid].strike_out && t - st.seats[sid].last_checkin <= ONLINE_S);
    delete st.attempts[attemptId];
    for (const s of owners) { s.state = 'waiting'; s.attempt_id = null; }
    for (const s of owners.filter((x) => x.strike_out)) { removeSeat(s.id, 'strikes'); log(`[Tatara] a wallet reached ${S.strikes} pools in a row stopped at the payout step — off the list`); }
    if (a.try <= S.max_retries && back.length >= S.min_people) {
      for (const sid of a.seats) if (!back.includes(sid) && st.seats[sid] && st.seats[sid].state === 'waiting') tell(st.seats[sid], { type: 'stopped', attempt_id: attemptId, reason: 'retry_without_you' });
      startGroup(a.route, a.size, back, a.try + 1, attemptId);
    } else {
      const left = a.seats.filter((sid) => st.seats[sid] && st.seats[sid].state === 'waiting');
      for (const sid of left) tell(st.seats[sid], { type: 'stopped', attempt_id: attemptId, reason: a.try > S.max_retries ? 'retries_used' : 'too_few_left' });
      toFront(left);
      log(`[Tatara] attempt ${attemptId.slice(0, 8)} stopped (${outcome}) — ${a.try > S.max_retries ? 'retries used' : 'too few left for a retry'}; its seats back to the front`);
    }
    persist();
    return { ok: true, phase: 'stopped' };
  }

  /// Advance the timers. Answers the wakes to send (tatara.js sends them through the existing web push).
  function tick() {
    const t = nowS();
    const wakes = [];
    let changed = false;
    for (const sp of Object.values(st.starts)) {
      if (t > sp.deadline || sp.opened.length === sp.seats.length) { closeStart(sp); changed = true; }
    }
    for (const a of Object.values(st.attempts)) {
      if (a.phase === 'creating' && t - a.created_at > CREATE_MAX_S) { report(a.creator, a.attempt_id, 'stopped'); changed = true; continue; }
      if (a.phase === 'running' && t - a.created_at > ATTEMPT_MAX_S) {
        delete st.attempts[a.attempt_id];
        for (const sid of a.seats) { const s = st.seats[sid]; if (s && s.state === 'in_attempt') { s.state = 'waiting'; s.attempt_id = null; tell(s, { type: 'stopped', attempt_id: a.attempt_id, reason: 'no_outcome_in_an_hour' }); } }
        toFront(a.seats.filter((sid) => st.seats[sid] && st.seats[sid].state === 'waiting'));
        log(`[Tatara] attempt ${a.attempt_id.slice(0, 8)}: no outcome in an hour — ended, its seats back to the front`);
        changed = true; continue;
      }
      if (a.phase === 'signed' && t - (a.signed_at || a.created_at) > SIGNED_KEEP_S) { delete st.attempts[a.attempt_id]; changed = true; }
    }
    for (const s of Object.values(st.seats)) {
      if (s.state === 'waiting' && t - s.last_checkin > SEAT_IDLE_MAX_S) { removeSeat(s.id, 'idle_a_week'); changed = true; }
      if (s.state === 'removed' && s.gone_at && t - s.gone_at > SEAT_IDLE_MAX_S) { delete st.seats[s.id]; changed = true; }
    }
    for (const [route, size] of queues()) {
      const k = qkey(route, size);
      const g = headGroup(route, size);
      if (g.length < S.min_people) { if (st.countdowns[k]) { delete st.countdowns[k]; changed = true; } continue; }
      if (!st.countdowns[k]) { st.countdowns[k] = t; changed = true; }
      const due = g.length >= S.max_people || t >= st.countdowns[k] + S.countdown_s;
      if (!due) continue;
      const r = running(size);
      if (r.size >= S.max_pools_per_size || r.total >= S.max_pools_total) continue;   // busy: starts when a pool ends
      delete st.countdowns[k];
      for (const w of startGroup(route, size, g, 1, null)) wakes.push(w);
      changed = true;
    }
    if (changed) persist();
    return { wakes };
  }

  /// 0.101.0 (door 1): a ring-signed seat lasts its week — at the change the waiting ones go ("week_ended"; the phone
  /// asks again under the new week's tag). Seats starting or in a pool finish first.
  function endWeek(label) {
    let n = 0;
    for (const s of Object.values(st.seats)) if (s.week && s.week !== label && s.state === 'waiting') { removeSeat(s.id, 'week_ended'); n++; }
    if (n) { persist(); log(`[Tatara] the week changed: ${n} ring-signed seat(s) ended (they ask again under ${label})`); }
    return n;
  }

  /// 0.103.0: every queue — the chain route per size and, when offered, the channel route per channel size.
  function queues() {
    const chain = S.sizes.map((size) => ['chain', size]);
    const channel = S.channel_pools && Array.isArray(S.channel_sizes) ? S.channel_sizes.map((size) => ['channel', size]) : [];
    return chain.concat(channel);
  }
  function counts() {
    return queues().map(([route, size]) => Object.assign({ size, route }, countFor(route, size)));
  }
  function attemptOf(attemptId) { return st.attempts[attemptId] || null; }
  function seatOf(id) { return st.seats[id] || null; }

  return { seat, endWeek, checkin, leave, pause: (id) => pause(id, true), resume: (id) => pause(id, false), open, announce, report, tick, counts, attemptOf, seatOf, state: () => st,
    eligibleFor, reserve, headCount, roomStart, roomOutcome, startOf: (id) => st.starts[id] || null };   // 0.106.0: the hosted room's hooks
}

module.exports = { createList, ONLINE_S, MISSED_STARTS_MAX, SEAT_IDLE_MAX_S, CREATE_MAX_S, ATTEMPT_MAX_S };
