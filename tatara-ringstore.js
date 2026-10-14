// tatara-ringstore.js — 0.101.0 (S58 — LIJOX's Tatara step 5a, door 1; design tatara-adapter-r2.md §2): THE MIX-ON
// WALLETS' TATARA KEYS AND THE WEEK'S RING.
//
// One Tatara key per wallet (its node key certifies it — the route checks that). The ring of an ISO week is a snapshot
// of the members' keys, taken once at the week's first moment (the first tick or the first ask in that week) and never
// changed: a wallet appears in it at most once, so the key image gives one seat per wallet per week (review S58 #4). A key
// registered or replaced after the snapshot enters the next week's ring. The current and the previous week's rings are
// kept (a request signed just before Monday arrives just after); older ones go. DATA_DIR/tatara/ring.json, written whole.
'use strict';

const fs = require('fs');
const path = require('path');
const { makeRing, isoWeek, seatTag } = require('./tatara-ring');

function createRingStore(opts) {
  const { dataDir = null, now = () => Date.now(), max = 1000, log = () => {} } = opts || {};
  const FILE = dataDir ? path.join(dataDir, 'tatara', 'ring.json') : null;
  let st = { members: {}, snapshots: {} };   // members: node_pk → { key, joined_at }; snapshots: week → [keys]
  try { if (FILE) { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && j.members) st = Object.assign({ members: {}, snapshots: {} }, j); } } catch (_) {}
  const save = () => { if (!FILE) return; try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, FILE); } catch (e) { log(`[Tatara] ring not saved: ${e.message}`); } };
  const cache = new Map();   // week → the made ring (Hp_t of every member computed once)

  function join(nodePk, key) {
    const was = st.members[nodePk];
    if (Object.entries(st.members).some(([pk, m]) => pk !== nodePk && m.key === key)) return { ok: false, reason: 'key_in_use' };
    if (!was && Object.keys(st.members).length >= max) return { ok: false, reason: 'ring_full' };
    st.members[nodePk] = { key, joined_at: Math.floor(now() / 1000) };
    save();
    return { ok: true, from_week: fromWeek(), replaced: !!was };
  }
  function leave(nodePk) { if (!st.members[nodePk]) return { ok: true, was: false }; delete st.members[nodePk]; save(); return { ok: true, was: true, from_week: fromWeek() }; }
  // the week a change takes effect: this one while its ring is not yet taken, else the next
  const fromWeek = () => { const cur = isoWeek(now()).label; return st.snapshots[cur] ? isoWeek(now() + 7 * 86400000).label : cur; };

  /// The ring of the week `label` (the current week by default): taken now if not yet taken; null when it has no member.
  function ringOf(label = isoWeek(now()).label) {
    if (!st.snapshots[label]) {
      if (label !== isoWeek(now()).label) return null;   // a past week's ring is never made after the fact
      st.snapshots[label] = Array.from(new Set(Object.values(st.members).map((m) => m.key))).sort();
      // keep this week's and the previous week's only
      const prev = isoWeek(now() - 7 * 86400000).label;
      for (const k of Object.keys(st.snapshots)) if (k !== label && k !== prev) { delete st.snapshots[k]; cache.delete(k); }
      save();
      log(`[Tatara] the ring of ${label}: ${st.snapshots[label].length} Mix-on wallet(s)`);
    }
    const keys = st.snapshots[label];
    if (!keys.length) return null;
    if (!cache.has(label)) cache.set(label, Object.assign(makeRing(keys, 'lij/tatara/seat/v1/' + label), { week: label, list: keys.slice() }));
    return cache.get(label);
  }

  /// The ring a seat request names: this week's or last week's, by hash and by the tag of its time.
  function ringForSeat(ringHash, tsMs) {
    const label = isoWeek(tsMs).label;
    const cur = isoWeek(now()).label;
    if (label !== cur) return { ok: false, reason: 'week_changed' };
    const r = ringOf(cur);
    if (!r) return { ok: false, reason: 'no_ring_this_week' };
    if (r.hash !== ringHash) return { ok: false, reason: 'not_this_weeks_ring' };
    return { ok: true, ring: r, tag: seatTag(tsMs), week: cur };
  }

  return { join, leave, ringOf, ringForSeat, members: () => Object.keys(st.members).length, isMember: (pk) => !!st.members[pk] };
}

module.exports = { createRingStore };
