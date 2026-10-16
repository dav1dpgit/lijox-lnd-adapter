// tatara-host.js — 0.107.0 (roomOf: the room's stranger count for a seat's check-in — the phone's "People in it") · 0.106.1 (the announcement names the network 'mainnet' — the public joinstr v2 code's wire name; 0.106.0 said 'bitcoin' and the public code refused the room as another network) · 0.106.0 (S59 Thu 2026-10-15, Phase 2b: THE PROVIDER AS HOST OF A PUBLIC ROOM; the design is
// docs/design/mix/tatara-public-r1.md in the wallet repository, DP's decisions of 12:50–13:14; the 2b security pass's
// findings folded in before the tag — review 2b, two independent reviewers).
//
// A queue (a size on the chain route) with seats waiting but fewer than MIN_PEOPLE gets a ROOM on the public Joinstr
// relay the moment its first eligible seat exists: a pool announcement (kind 2022) signed by a key this host makes for
// the room, N fixed at MIN_PEOPLE (the public protocol takes one number; a room with strangers goes ahead at exactly N
// registrations), the fee rate from the node's estimate under the provider's cap; a seat whose own cap is below that
// rate is not eligible for the room (its phone would refuse the rate). Nothing in the announcement says LIJOX. The host
// answers join requests the public code's way — the room's key to a stranger while the strangers' quota (N − the seats
// it will take) remains, "pool is full" after — and reads the room (it holds the key).
//
// WHAT A STRANGER MUST PUT IN (review 2b #3): the room is honoured — its seats reserved, the LIJOX rule no longer
// withdraws it — only when a stranger has REGISTERED a coin the host has checked: the registration's ownership proof
// (the public code's, over the pool id, the session key and the outpoint, by the coin's own key) and the coin itself
// on the chain (the provider's coin check: confirmed, unspent, the value and script as registered). A key handed out
// and never used costs the seats nothing. Forging a registration costs a real coin of the pool's size.
//
// THE LIJOX RULE (DP: "I agree"): while no stranger has registered, the room is only an offer — the queue's own
// countdown runs as ever, and the moment the head group reaches MIN_PEOPLE the room is withdrawn (a deletion event)
// and the LIJOX pool starts, no provider holding a key.
//
// THE WAKE: when the checked registrations reach the quota, the promised seats are woken (tatara-list roomStart: the
// announcement, the public relay) and have WAKE_WINDOW_S to open; at `open` each phone names the key its join request
// will come from, and the host answers THAT key past the strangers' quota — the join itself carries nothing (review 2b
// #4/#5: v342's token was readable by every key holder). The host stops answering strangers WAKE_WINDOW_S before the
// room's deadline. A room nobody registered in by then closes, and — after a pause that doubles each time a queue's
// room ends empty or stopped (review 2b #3/#5) — a fresh one opens while seats still wait.
//
// THE OUTCOME is NEVER read off the relay (review 2b #1: anyone can encrypt to the pool key and sign with a throwaway
// key). What the host reads is counted for its own record and the console; the list's verdict comes from the seats'
// own signed reports and the list's hour (tatara-list ATTEMPT_MAX_S).
//
// WHAT THE RELAY MAY COST (review 2b #2): a verify budget per room and for the host as a whole (pure-JS Schnorr is
// ~3 ms a verify), the seen-set checked before any signature, the answered keys capped per room, the subscription
// re-opened from the last event seen, never from the room's start.
//
// Rooms live in memory only: a restart ends them (the list's rule — nothing in progress is continued).
'use strict';
const crypto = require('crypto');
const secp = require('secp256k1');
const { checkEvent } = require('./nwc.js');
const nip04 = require('./nip04.js');
const schnorr = require('./schnorr.js');

const ANNOUNCE_KIND = 2022;
const DELETE_KIND = 5;
const MSG_KIND = 4;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;
const ROOM_GRACE_S = 120;         // a filling room is closed this long after its deadline (the last registrations)
const RUN_MAX_S = 3600;           // a running room with no verdict from the list in an hour is closed
const SEEN_MAX = 8192;
const ROOMS_MAX = 24;             // at most this many rooms open at once (a size each)
const ANSWERED_MAX = 64;          // distinct keys answered per room; past it a join gets no answer
const VERIFY_PER_ROOM_S = 10;     // events verified per room per second; past it dropped
const VERIFY_TOTAL_S = 40;        // …and for the host as a whole
const VERIFY_KNOWN_S = 5;         // …and a lane of its own, per room, for keys the host already knows (its seats' join keys, the keys it handed credentials to) — a flood never starves them (re-check a)
const CHECKS_PER_ROOM = 12;       // coin checks a room may cost (re-check c)
const FUTURE_S = 900;             // an event dated further ahead than this is dropped unread (re-check d)
const BAD_COIN_KEEP_MS = 24 * 3600000;   // a coin from a room that ended stopped is refused for a day (the hostage loop costs a fresh coin each time)
const ROOM_GAP_S = 60;            // the least time between two rooms of one queue, whatever closed the last
const BACKOFF_MIN_S = 60, BACKOFF_MAX_S = 1800;   // after a room ends empty or stopped: 1, 2, 4 … 30 minutes
const FEE_CACHE_MS = 60000;
const MAX_INPUTS = 8;             // registrations with more inputs are not counted

const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);
const sha256 = (...parts) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
/// The public code's tagged hash: sha256(sha256(tag) || sha256(tag) || parts…).
function taggedHash(tag, parts) { const t = sha256(Buffer.from(tag, 'utf8')); return sha256(t, t, ...parts); }
/// The outputs of a raw transaction (hex): [{ value, spk (hex) }]. Segwit or not.
function outputsOf(hex) {
  const b = Buffer.from(hex, 'hex');
  let o = 4;
  if (b.length > 6 && b[4] === 0x00 && b[5] === 0x01) o = 6;
  const varint = () => { const f = b[o++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(o); o += 2; return v; } if (f === 0xfe) { const v = b.readUInt32LE(o); o += 4; return v; } const v = Number(b.readBigUInt64LE(o)); o += 8; return v; };
  const nIn = varint();
  for (let i = 0; i < nIn; i++) { o += 36; const l = varint(); o += l + 4; }
  const nOut = varint();
  const out = [];
  for (let i = 0; i < nOut; i++) { const value = Number(b.readBigUInt64LE(o)); o += 8; const l = varint(); out.push({ value, spk: b.subarray(o, o + l).toString('hex') }); o += l; }
  return out;
}
/// The public code's ownership proof over (pool id, session key, outpoint) by the coin's own key: P2TR → BIP-340 by
/// the output key; P2WPKH → ECDSA (DER, low-S) by the key whose hash160 is the program.
function proofOk(poolId, sessionHex, txid, vout, spkHex, proof) {
  if (!proof || typeof proof !== 'object' || typeof proof.sig !== 'string') return false;
  const op = Buffer.concat([Buffer.from(txid, 'hex').reverse(), Buffer.alloc(4)]); op.writeUInt32LE(vout, 32);
  const msg = taggedHash('joinstr/v2/ownership', [Buffer.from(poolId, 'utf8'), Buffer.from(sessionHex, 'hex'), op]);
  try {
    if (spkHex.length === 68 && spkHex.startsWith('5120')) return isHex(proof.sig, 128) && schnorr.verify(proof.sig, msg, spkHex.slice(4));
    if (spkHex.length === 44 && spkHex.startsWith('0014')) {
      if (!isHex(String(proof.pubkey || ''), 66) || !/^[0-9a-f]+$/.test(proof.sig) || proof.sig.length < 16 || proof.sig.length > 144) return false;
      const pk = Buffer.from(proof.pubkey, 'hex');
      const h160 = crypto.createHash('ripemd160').update(sha256(pk)).digest('hex');
      if (h160 !== spkHex.slice(4)) return false;
      return secp.ecdsaVerify(secp.signatureImport(Buffer.from(proof.sig, 'hex')), msg, pk);
    }
  } catch (_) { return false; }
  return false;
}

function createHost(deps) {
  const {
    settings, now, log = () => {}, list, publicRelayUrl, connect, feeRateSatVb = async () => null, coinCheck = async () => null, network = 'mainnet',
    newId = () => crypto.randomBytes(16).toString('hex'), randomKey = () => crypto.randomBytes(32).toString('hex'),
  } = deps;
  const nowS = () => Math.floor(now() / 1000);
  const rooms = new Map();        // queue key → room
  const lastRoom = new Map();     // queue key → { closed_at (s), backoff_s }
  const badCoins = new Map();     // "txid:vout" → until (ms): coins registered in rooms that ended stopped
  let client = null;
  let feeWarned = 0, feeCache = { at: 0, v: null };
  let verifyWindow = { at: 0, n: 0 }, dropSaid = 0;
  let ticking = false;
  const pendingWakes = [];
  const qkey = (route, size) => route + ':' + size;

  function relay() {
    if (!client) client = connect(publicRelayUrl);
    return client;
  }

  function announcement(room) {
    const ev = {
      versions: ['2'], id: room.id, network, type: 'new_pool', public_key: room.pool_pk, denomination: room.size, peers: room.peers,
      timeout: room.timeout, relays: [publicRelayUrl], fee_rate: room.fee_rate,
      transport: { vpn: { enable: false, vpn_gateway: null }, tor: { enable: false } },
    };
    return nip04.signEvent(room.pool_sk, nowS(), ANNOUNCE_KIND, [], JSON.stringify(ev));
  }
  function sealTo(room, toXonly, msg) { return nip04.seal(room.pool_sk, toXonly, JSON.stringify(Object.assign({ version: '2' }, msg)), nowS()); }

  /// The node's fee estimate, cached a minute. Thousandths of a sat/vB, or null.
  async function estimate() {
    if (now() - feeCache.at < FEE_CACHE_MS) return feeCache.v;
    let est = null;
    try { est = await feeRateSatVb(); } catch (_) { est = null; }
    feeCache = { at: now(), v: Number.isFinite(est) && est > 0 ? Math.round(est * 1000) / 1000 : null };
    return feeCache.v;
  }
  /// The room's rate: the estimate under the provider's cap, never below 1 sat/vB (thousandths).
  const roomRate = (s, est) => Math.round(Math.max(1, Math.min(s.max_fee_rate, est)) * 1000) / 1000;
  /// The seats a room at `rate` may take: the list's eligible seats whose own cap (thousandths) allows the rate.
  function eligibleAt(route, size, rate) {
    return list.eligibleFor(route, size).filter((id) => { const seat = list.seatOf(id); return !!(seat && seat.fee_cap_milli && seat.fee_cap_milli >= Math.round(rate * 1000)); });   // no cap = no room
  }
  /// The seats a room will take (k, at most peers − 1) and the strangers it wants (peers − k).
  function wanted(room) {
    const eligible = eligibleAt(room.route, room.size, room.fee_rate);
    const k = Math.min(eligible.length, room.peers - 1);
    return { eligible, k, quota: room.peers - k };
  }
  const registered = (room) => Array.from(room.regs.values()).filter((r) => r.checked).length;

  async function openRoom(route, size, s) {
    const est = await estimate();
    if (est === null) {
      if (now() - feeWarned > 600000) { feeWarned = now(); log('[Tatara] no fee estimate from the node — no public room opens until there is one'); }
      return null;
    }
    const rate = roomRate(s, est);
    const eligible = eligibleAt(route, size, rate);
    if (!eligible.length) return null;
    const key = qkey(route, size);
    if (rooms.has(key)) return null;
    const pool_sk = randomKey();
    const jitter = Math.floor(s.room_window_s * (0.9 + 0.1 * crypto.randomInt(1000) / 1000));   // −10 %…0, so the rooms are not a clock (review 2b #9) and never outlast the phone's hour
    const room = {
      key, route, size, peers: s.min_people, id: newId(), pool_sk, pool_pk: schnorr.pubkey(Buffer.from(pool_sk, 'hex')).toString('hex'),
      attempt_id: newId(), announced_at: nowS(), timeout: nowS() + jitter, fee_rate: rate,
      phase: 'filling', answered: new Map(), strangers: 0, regs: new Map(), witnesses: new Set(), seen: new Set(), promised: [], join_pks: new Set(), seats_answered: 0,
      event: null, event_id: null, sub: null, closed_at: null, last_seen_at: 0, verify: { at: 0, n: 0 }, checks: 0,
    };
    rooms.set(key, room);   // before anything awaits again: one room per queue (review 2b #7)
    const ev = announcement(room);
    room.event = JSON.stringify(ev); room.event_id = ev.id; room.sub = 'room-' + room.id.slice(0, 12);
    const c = relay();
    c.subscribe(room.sub, { kinds: [MSG_KIND], '#p': [room.pool_pk], since: room.announced_at - 60 }, (e) => onEvent(room, e));
    c.publish(ev);
    const k = Math.min(eligible.length, room.peers - 1);
    log(`[Tatara] a public room opens · ${size} sats · ${room.peers} people · ${k} seat(s) waiting · ${room.peers - k} stranger(s) wanted · ${rate} sat/vB · until ${new Date(room.timeout * 1000).toISOString().slice(11, 16)} UTC`);
    return room;
  }

  function closeRoom(room, why, withdraw, outcome) {
    if (room.closed_at) return;
    room.closed_at = nowS();
    room.phase = 'closed';
    if (withdraw && room.event_id) { try { relay().publish(nip04.signEvent(room.pool_sk, nowS(), DELETE_KIND, [['e', room.event_id]], 'withdrawn')); } catch (_) {} }
    try { if (client && room.sub) client.unsubscribe(room.sub); } catch (_) {}
    list.reserve(room.route, room.size, null);
    rooms.delete(room.key);
    const prev = lastRoom.get(room.key) || { backoff_s: 0 };
    const backoff = outcome === 'good' ? 0 : Math.min(BACKOFF_MAX_S, prev.backoff_s ? prev.backoff_s * 2 : BACKOFF_MIN_S);
    lastRoom.set(room.key, { closed_at: nowS(), backoff_s: backoff });
    if (outcome === 'stopped') { for (const r of room.regs.values()) if (!r.seat) for (const i of r.inputs) badCoins.set(i.txid + ':' + i.vout, now() + BAD_COIN_KEEP_MS); }   // the strangers' coins of a room that went nowhere
    if (badCoins.size > 4096) { const t0 = now(); for (const [k, u] of badCoins) if (u < t0) badCoins.delete(k); }
    room.pool_sk = null;   // the key goes with the room
    log(`[Tatara] room ${room.id.slice(0, 8)} closed — ${why}${backoff ? ` · the next room for this size in ${backoff} s at the earliest` : ''}`);
  }

  /// The verify budget: per room and for the host as a whole, per second — and a lane of its own for keys the host
  /// already knows (re-check a: a flood of unsigned noise must not starve the seats' joins or the members' messages).
  function mayVerify(room, from) {
    const t = nowS();
    if (verifyWindow.at !== t) verifyWindow = { at: t, n: 0 };
    if (room.verify.at !== t) room.verify = { at: t, n: 0, known: 0 };
    const known = room.join_pks.has(from) || (room.answered.get(from) || {}).type === 'credentials' || room.regs.has(from);
    if (known) { if (room.verify.known >= VERIFY_KNOWN_S) return false; room.verify.known++; return true; }
    if (verifyWindow.n >= VERIFY_TOTAL_S || room.verify.n >= VERIFY_PER_ROOM_S) {
      if (now() - dropSaid > 60000) { dropSaid = now(); log(`[Tatara] room ${room.id.slice(0, 8)}: more relay events than the host verifies — the rest are dropped this second`); }
      return false;
    }
    verifyWindow.n++; room.verify.n++;
    return true;
  }

  /// A message to the room's key, from the relay. Nothing here changes the list (review 2b #1).
  function onEvent(room, ev) {
    try {
      if (room.closed_at || !room.pool_sk) return;
      if (!ev || ev.kind !== MSG_KIND || typeof ev.id !== 'string' || typeof ev.pubkey !== 'string') return;
      if (!(ev.tags || []).some((t) => Array.isArray(t) && t[0] === 'p' && t[1] === room.pool_pk)) return;
      if (ev.pubkey === room.pool_pk) return;                 // the host's own answers echoed
      if (room.seen.has(ev.id)) return;                         // before any signature (review 2b #2)
      if (!Number.isInteger(ev.created_at) || ev.created_at > nowS() + FUTURE_S) return;   // dated ahead: unread (re-check d)
      if (JSON.stringify(ev).length > MAX_EVENT_BYTES) return;
      if (!mayVerify(room, ev.pubkey)) return;
      if (checkEvent(ev)) return;                               // id or signature
      if (room.seen.size >= SEEN_MAX) room.seen.clear();
      room.seen.add(ev.id);
      const at = Math.min(ev.created_at, nowS() + 60);
      if (at > room.last_seen_at) { room.last_seen_at = at; try { relay().since(room.sub, room.last_seen_at); } catch (_) {} }
      let json;
      try { json = nip04.decrypt(nip04.sharedX(room.pool_sk, ev.pubkey), ev.content); } catch (_) { return; }
      if (json.length > MAX_MESSAGE_BYTES) return;
      let m; try { m = JSON.parse(json); } catch (_) { return; }
      if (!m || typeof m !== 'object' || m.version !== '2' || typeof m.type !== 'string') return;
      const from = ev.pubkey;
      if (m.type === 'join_pool') return onJoin(room, from);
      if (m.type === 'inputs') return onInputs(room, from, m);
      if (m.type === 'funding_sigs') { if (room.regs.has(from)) room.witnesses.add(from); return; }
      if (m.type === 'abort') { if (room.regs.has(from) && !room.abort_at) { room.abort_at = nowS(); log(`[Tatara] room ${room.id.slice(0, 8)}: a member aborted (noted — the seats' reports decide)`); } return; }
    } catch (e) { log(`[Tatara] a room message was not handled: ${e.message}`); }
  }

  function onJoin(room, from) {
    const s = settings();
    const c = relay();
    const credentials = { type: 'credentials', credentials: { id: room.id, key: room.pool_sk } };
    const full = { type: 'reject', reason: 'pool is full' };
    const again = room.answered.get(from);
    const mine = room.join_pks.has(from) && (room.phase === 'woken' || room.phase === 'running');
    // one of this room's own seats (the key it named at `open`): credentials while its promised places remain — even
    // when an earlier "full" was cached for the key (re-check b: the join may land before the tick that read the key)
    if (mine && (!again || again.type !== 'credentials') && room.seats_answered < room.promised.length) { room.seats_answered++; room.answered.set(from, credentials); c.publish(sealTo(room, from, credentials)); return; }
    if (again) { c.publish(sealTo(room, from, again)); return; }   // the relay replays: the same answer
    if (room.answered.size >= ANSWERED_MAX) return;                 // a flood of strangers' keys: no answer at all (review 2b #2)
    let answer = full;
    if (room.phase === 'filling' && nowS() < room.timeout - s.wake_window_s) {
      const { quota } = wanted(room);
      if (room.strangers < quota) { answer = credentials; room.strangers++; log(`[Tatara] room ${room.id.slice(0, 8)}: a stranger takes the key (${room.strangers} of ${quota} wanted — a registration is what counts)`); }
    }
    room.answered.set(from, answer);
    c.publish(sealTo(room, from, answer));
  }

  /// A registration: parsed strictly, its ownership proofs checked, then its coins checked on the chain — only then
  /// counted (review 2b #3). Before the wake every registration is a stranger's.
  function onInputs(room, from, m) {
    if (room.regs.has(from) || room.regs.size >= room.peers + 2) return;
    const ins = m.inputs;
    if (!Array.isArray(ins) || !ins.length || ins.length > MAX_INPUTS) return;
    if (!isHex(String(m.musig_pubkey || ''), 66) || !isHex(String(m.ring_pubkey || ''), 66)) return;
    const inputs = [];
    for (const i of ins) {
      const spk = String((i && i.script_pubkey) || '');
      if (!i || !isHex(String(i.txid || ''), 64) || !Number.isSafeInteger(i.vout) || i.vout < 0 || i.vout > 0xffffffff || !Number.isSafeInteger(i.amount) || i.amount <= 0 || !spk || !isHex(spk, spk.length)) return;
      if (badCoins.has(i.txid + ':' + i.vout) && badCoins.get(i.txid + ':' + i.vout) > now()) return;   // a coin from a room that went nowhere
      if (!proofOk(room.id, from, i.txid, i.vout, spk, i.proof)) return;
      inputs.push({ txid: i.txid, vout: i.vout, amount: i.amount, spk });
    }
    if (inputs.reduce((a, x) => a + x.amount, 0) < room.size) return;   // a registration must at least carry the pool's size
    const rec = { from, inputs, checked: false, at: nowS(), seat: room.phase !== 'filling' };
    if (rec.seat) { rec.checked = true; room.regs.set(from, rec); return; }   // after the wake the seats register; their coins are the list's business
    if (room.checks >= CHECKS_PER_ROOM) return;                           // the room's coin checks are spent (re-check c)
    room.checks++;
    room.regs.set(from, rec);
    // the coins on the chain — confirmed, unspent, the value and script as registered; a failed check frees the slot
    (async () => {
      let good = true;
      for (const i of inputs) {
        let a = null; try { a = await coinCheck({ txid: i.txid, vout: i.vout }); } catch (_) { a = null; }
        if (!a || !a.ok || a.unspent !== true || !(Number(a.confirmations) >= 1) || typeof a.tx !== 'string') { good = false; break; }
        let outs; try { outs = outputsOf(a.tx); } catch (_) { good = false; break; }
        const o = outs[i.vout];
        if (!o || o.value !== i.amount || o.spk !== i.spk) { good = false; break; }
      }
      if (room.closed_at) return;
      if (!good) { room.regs.delete(from); return; }
      rec.checked = true;
      log(`[Tatara] room ${room.id.slice(0, 8)}: a stranger registered a checked coin (${registered(room)} of ${wanted(room).quota} wanted)`);
    })().catch((e) => { room.regs.delete(from); log(`[Tatara] room ${room.id.slice(0, 8)}: a coin check failed: ${e.message}`); });
  }

  /// tatara.js: a seat opened for a room and named its join key — known to the host at once, before any tick (re-check b).
  function noteJoinKey(attemptId, joinPk) {
    for (const room of rooms.values()) if (room.attempt_id === attemptId && isHex(joinPk, 64)) room.join_pks.add(joinPk);
  }

  /// Every second, after the list's own tick.
  async function tick() {
    if (ticking) return { wakes: [] };
    ticking = true;
    try {
      const s = settings();
      if (!s.public_rooms || !list) return { wakes: [] };
      const t = nowS();
      for (const room of Array.from(rooms.values())) {
        if (room.phase === 'filling') {
          const { eligible, k, quota } = wanted(room);
          const regs = registered(room);
          if (regs === 0) {
            list.reserve(room.route, room.size, null);
            if (list.headCount(room.route, room.size) >= s.min_people) { closeRoom(room, 'the list filled by itself — the LIJOX pool starts', true, 'good'); continue; }   // the LIJOX rule
            if (!eligible.length) { closeRoom(room, 'no seat waits any more', true, 'good'); continue; }
            if (t >= room.timeout - s.wake_window_s) { closeRoom(room, 'nobody registered in time — announced again while seats wait', true, 'empty'); continue; }
            continue;
          }
          // a stranger registered a checked coin: the room is honoured — the seats it will take are its own
          const take = eligible.slice(0, Math.max(0, room.peers - regs));
          list.reserve(room.route, room.size, take);
          if (regs >= room.peers) { if (!room.too_many) { room.too_many = true; log(`[Tatara] room ${room.id.slice(0, 8)}: strangers alone fill it — no seat of ours goes in; left to its deadline`); } }
          else if (regs >= quota && k > 0 && take.length && t < room.timeout) {   // peers − regs seats + regs strangers = peers: it fills exactly
            room.promised = take; room.phase = 'woken'; room.woken_at = t;
            const wakes = list.roomStart(room.route, room.size, take, { attempt_id: room.attempt_id, peers: room.peers, relay: publicRelayUrl, event: room.event });
            for (const w of wakes) pendingWakes.push(w);
            continue;
          }
          if (t > room.timeout + ROOM_GRACE_S) { closeRoom(room, 'its time ran out short of people', false, 'stopped'); continue; }
          continue;
        }
        if (room.phase === 'woken') {
          const sp = list.startOf(room.attempt_id);
          if (sp) { for (const pk of Object.values(sp.join_pks || {})) room.join_pks.add(pk); if (t > room.timeout + ROOM_GRACE_S) closeRoom(room, 'its time ran out while the seats opened', false, 'stopped'); continue; }
          const a = list.attemptOf(room.attempt_id);
          if (a && a.room) { for (const pk of Object.values(a.join_pks || {})) room.join_pks.add(pk); room.phase = 'running'; continue; }
          closeRoom(room, 'no seat opened — the room runs short', false, 'stopped');
          continue;
        }
        if (room.phase === 'running') {
          const a = list.attemptOf(room.attempt_id);
          if (!a) { closeRoom(room, 'the list ended the attempt', false, 'stopped'); continue; }
          if (a.phase === 'signed' || a.phase === 'stopped') { closeRoom(room, 'the seats reported: ' + a.phase, false, a.phase === 'signed' ? 'good' : 'stopped'); continue; }
          if (t - (room.woken_at || room.announced_at) > RUN_MAX_S) { closeRoom(room, 'no verdict in an hour', false, 'stopped'); continue; }
        }
      }
      // new rooms: a queue short of MIN_PEOPLE with an eligible seat, past the queue's pause
      for (const size of s.sizes || []) {
        const route = 'chain';   // the channel route has no public room: the public code knows no channel payout
        const key = qkey(route, size);
        if (rooms.has(key) || rooms.size >= ROOMS_MAX) continue;
        const last = lastRoom.get(key);
        if (last && t - last.closed_at < Math.max(ROOM_GAP_S, last.backoff_s)) continue;
        if (!list.eligibleFor(route, size).length || list.headCount(route, size) >= s.min_people) continue;
        await openRoom(route, size, s);
      }
      return { wakes: pendingWakes.splice(0) };
    } finally { ticking = false; }
  }

  /// 0.107.0 (DP 2026-10-15 20:48 "Do the People in it cut"): the room of a queue, for a seat's check-in — how many
  /// strangers have registered a checked coin (the seats' own registrations after the wake are not strangers), the room's
  /// N, the seconds until it closes. Nothing secret: the count the host already logs; no coin, no key.
  function roomOf(route, size) {
    const room = rooms.get(qkey(route, size));
    if (!room || room.closed_at) return null;
    const strangers = Array.from(room.regs.values()).filter((r) => r.checked && !r.seat).length;
    return { strangers, peers: room.peers, closes_in_s: Math.max(0, room.timeout - nowS()), phase: room.phase };
  }
  function summary() {
    return Array.from(rooms.values()).map((r) => ({ id: r.id.slice(0, 8), route: r.route, size: r.size, peers: r.peers, phase: r.phase, strangers: r.strangers, registered: registered(r), promised: r.promised.length, ends_in_s: Math.max(0, r.timeout - nowS()), fee_rate: r.fee_rate }));
  }
  function close() { for (const r of Array.from(rooms.values())) closeRoom(r, 'the host closes', true, 'good'); if (client) { try { client.close(); } catch (_) {} client = null; } }

  return { tick, summary, close, noteJoinKey, roomOf, relayStats: () => (client ? client.stats() : null) };   // 0.107.0: roomOf
}

module.exports = { createHost, ANNOUNCE_KIND, ROOM_GRACE_S, RUN_MAX_S, ROOM_GAP_S, proofOk, outputsOf, taggedHash };
