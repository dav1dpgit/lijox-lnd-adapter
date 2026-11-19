'use strict';
// sent-watch.js — 0.133.0 (S70 Thu 2026-11-19, DP 11-18 22:06 "Go" and 11-19 06:37 "Go" on the words — the wallet repo's
// docs/design/htlc/offline-sender-r1.md §4 A and C, and -r2.md): A PAYMENT A WALLET SENT, RESOLVED HERE WHILE THE
// WALLET IS OFFLINE.
//
// An HTLC leaves a channel only when both sides sign. This box can fail a wallet's payment back, or settle it, on its
// own — but the fail or the settle then waits here until that wallet connects again. Two things can follow:
//   · the payment was SETTLED here (this box holds the preimage and has paid it on): LND goes on-chain to collect it
//     16 blocks below the HTLC's expiry (LND 0.21 and above; 10 before — lnd-margins.js, 0.133.4) if the wallet has
//     still not come back — the wallet's
//     channel is closed on-chain. Only the wallet opening before that block prevents it;
//   · the payment was FAILED here: nothing is owed to this box. A wallet whose engine is older than v376 closes its own
//     channel when it next opens to a chain 3 blocks past the expiry; from v376 it waits 4,032 blocks.
// The Push rail already wakes the sender for its own two cases (0.113.0: push_taken / push_returned). This module
// makes it every rail's rule, and gives the Console its line.
//
// A — THE WAKE (the notification's words are the wallet's, by the kind sent here):
//   a sweep, read-only to LND, over the HTLCs that are INCOMING on wallet channels whose wallet is OFFLINE, sorting
//   each into: still in flight (nothing sent) · completed (settled here) · returned (failed here). The evidence, in
//   this order:
//     1. LND forwarded it (forwarding_channel): the outgoing half is still on its channel          → in flight;
//        gone, and LND's forwarding history holds the forward (LND writes one only on a settle;
//        matched by the HTLC's own number on its channel — an amount alone is not taken)          → completed;
//        gone, no such record                                                                     → returned;
//        the outgoing channel itself is no longer open (its HTLC is being decided on-chain)       → undecided, unless
//        the forwarding history already holds the forward.
//        (LND's own record of a forward comes first: an HTLC LND has forwarded is not held by this adapter, whatever
//        this adapter remembers of it.)
//     2. the HTLC is still held unanswered by this adapter's interceptor                          → in flight
//     3. this adapter answered LND about it: SETTLE → completed · FAIL → returned (remembered in DATA_DIR/sent-watch.json)
//     4. it pays an invoice of this node — read on the invoice's own record of THIS HTLC (a second payment to a
//        settled invoice is refused, so the invoice's state alone would mislead): SETTLED → completed ·
//        CANCELED → returned · ACCEPTED → in flight; the HTLC not on the record: invoice CANCELED → returned
//     5. none of these (not held, not forwarded, no invoice): UNDECIDED — nothing is sent. LND may have refused it
//        itself, or (after an LND restart) it waits to be handed to this adapter again when the wallet returns;
//        LND's answers do not tell the two apart.
//   An HTLC LND reports as not yet locked in is in flight. A channel is matched under every number LND gives for it
//   (chan_id, the confirmed number of a zero-conf channel, its aliases) — the interceptor's circuit key and
//   ListChannels need not use the same one. A sorting counts only when two sweeps in a row agree, and
//   not in the first minutes after a start (LND hands the interceptor its held HTLCs again when the adapter
//   reconnects). On any doubt nothing is sent.
//   Wakes are tied to the deadline (DP's decision 2): one at once, then when about a day (144 blocks), six hours (36)
//   and one hour (6) are left. A wallet gets ONE line of wakes, by its lead payment — its completed payment with the
//   lowest deadline block if it has one, else its returned one with the lowest. The deadline is expiry − LND's margin (16 from LND 0.21, 10 before) for a completed payment, expiry + 3 for a returned one.
//   Nothing is sent once the deadline has passed. kinds: 'sent_completed' (carries the time to open by, stated short —
//   blocks can come faster than ten minutes) and 'sent_returned' (no time).
//
// C — THE CONSOLE'S CARD (report only; no button — the Console moves no money): EVERY pending HTLC on every channel
//   (0.133.3 — the card then holds what the Channels pane counts), each with the block at which a channel goes
//   on-chain over it — an outgoing HTLC at its expiry (LND's rule), an incoming one at expiry − LND's margin (LND's rule when it
//   holds the preimage), a returned incoming one on an offline wallet's channel at expiry + 3 (the wallet's rule
//   before engine v376; shown past that block too) — with peer, amount, hash, its sorting and what was sent. One
//   within WARN_BLOCKS (100) of its block is marked `near`: that is the warning (the colour, the Guardrails row).
//   Until 0.133.2 only the near ones were listed, and the card and the Channels pane could not be reconciled.
//
// This module reads LND and sends pushes. It settles, fails, closes and pays nothing.
const fs = require('fs');
const path = require('path');
const { incomingBroadcastDelta } = require('./lnd-margins');   // 0.133.4: LND's margin by its version (16 from 0.21; 10 before)

const MARKS = [['h1', 6], ['h6', 36], ['d1', 144]];   // blocks before the deadline, nearest first
const KEEP_RES_MS = 24 * 3600 * 1000;                // an answer given to LND is remembered this long after it was given
                                                     // or after its HTLC was last seen on a wallet's channel — whichever is later
const MAX_RES = 20000;

// which wake is due, if any. `left` = blocks until the deadline; `marks` = what was already sent.
function dueMark(left, marks) {
  const m = marks || {};
  if (!(left > 0)) return null;                        // past the deadline: nothing is sent
  for (const [name, blocks] of MARKS) if (left <= blocks) return m[name] ? null : name;
  return m.now ? null : 'now';
}
// after a wake at `name`, every mark at that distance or further is done (no "a day left" after "an hour left")
function marksAfter(marks, name) {
  const m = Object.assign({ now: false, d1: false, h6: false, h1: false }, marks || {});
  m.now = true;
  if (name === 'now') return m;
  const at = MARKS.find((x) => x[0] === name)[1];
  for (const [n, b] of MARKS) if (b >= at) m[n] = true;
  return m;
}
// the time stated in a 'sent_completed' wake: short of the estimate (ten minutes a block), because blocks can come
// faster — a tenth of the blocks left and three more are kept back. Never less than a minute.
function statedMs(left) {
  const usable = left - Math.ceil(left / 10) - 3;
  return Math.max(60 * 1000, usable * 600 * 1000);
}
const b64ToHex = (b) => { try { return Buffer.from(String(b || ''), 'base64').toString('hex'); } catch (_) { return ''; } };
// what happens at the block of a sent payment sorted for an offline wallet — the Console's words
const whatFor = (cls) => cls === 'completed' ? 'settled here, the wallet is offline — LND closes this channel on-chain at this block to collect it'
  : 'failed here, the wallet is offline — a wallet engine before v376 closes its channel when it returns past this block (v376 and newer wait 4,032 blocks)';
const circuitKey = (chanId, htlcId) => `${String(chanId || '0')}:${String(htlcId || '0')}`;
const isZero = (v) => { const s = String(v == null ? '' : v); return s === '' || s === '0'; };
// every number LND gives for one channel: chan_id, a zero-conf channel's confirmed number, its aliases
function idsOf(chan) {
  const out = []; const add = (v) => { if (!isZero(v) && !out.includes(String(v))) out.push(String(v)); };
  if (chan) { add(chan.chan_id); add(chan.zero_conf_confirmed_scid); for (const a of (Array.isArray(chan.alias_scids) ? chan.alias_scids : [])) add(a); }
  return out.length ? out : ['0'];
}

// THE SORTING of one incoming HTLC — pure. ev = { open(key)→bool, res(key)→'S'|'F'|null, chansById,
// invoice(hex)→{ state, htlcs } | null (LND has no such invoice) | undefined (could not be read),
// fwdSettled(idsIn[], htlcIdIn, idsOut[], htlcIdOut)→bool|null }. Answers { cls: 'flight'|'completed'|'returned'|'undecided', why }.
async function classify(chan, htlc, ev) {
  const ids = idsOf(chan); const idx = String(htlc.htlc_index || '0');
  const keys = ids.map((id) => circuitKey(id, idx));
  if (htlc.locked_in === false) return { cls: 'flight', why: 'not yet locked in' };
  if (!isZero(htlc.forwarding_channel)) {
    const out = ev.chansById[String(htlc.forwarding_channel)];
    if (out) {
      const still = (out.pending_htlcs || []).some((x) => x && !x.incoming && String(x.htlc_index || '0') === String(htlc.forwarding_htlc_index || '0'));
      if (still) return { cls: 'flight', why: 'forwarded, the outgoing half is still on its channel' };
    }
    const s = await ev.fwdSettled(ids, idx, out ? idsOf(out) : [String(htlc.forwarding_channel)], String(htlc.forwarding_htlc_index || '0'));
    if (s === true) return { cls: 'completed', why: 'forwarded and settled (LND\'s forwarding history)' };
    if (s === null) return { cls: 'undecided', why: 'forwarded; LND\'s forwarding history could not be read, or carries no HTLC numbers' };
    if (!out) return { cls: 'undecided', why: 'forwarded; the outgoing channel is no longer open — decided on-chain' };
    return { cls: 'returned', why: 'forwarded, the outgoing half is gone and LND recorded no settle' };
  }
  if (keys.some((k) => ev.open(k))) return { cls: 'flight', why: 'held by this adapter, unanswered' };
  let r = null; for (const k of keys) { r = ev.res(k); if (r) break; }
  if (r === 'S') return { cls: 'completed', why: 'this adapter settled it' };
  if (r === 'F') return { cls: 'returned', why: 'this adapter failed it' };
  const inv = await ev.invoice(b64ToHex(htlc.hash_lock));
  if (inv === undefined) return { cls: 'undecided', why: 'the invoice could not be read' };
  if (inv === null) return { cls: 'undecided', why: 'not held, not forwarded, no invoice — LND refused it, or it waits to be handed to this adapter again' };
  const mine = (inv.htlcs || []).find((x) => x && ids.includes(String(x.chan_id || '0')) && String(x.htlc_index || '0') === idx);
  const hs = mine ? String(mine.state || '') : '';
  if (hs === 'SETTLED') return { cls: 'completed', why: 'this node\'s invoice took this HTLC (SETTLED)' };
  if (hs === 'CANCELED') return { cls: 'returned', why: 'this node\'s invoice refused this HTLC (CANCELED)' };
  if (hs === 'ACCEPTED') return { cls: 'flight', why: 'this node\'s invoice holds this HTLC (ACCEPTED)' };
  if (String(inv.state || '') === 'CANCELED') return { cls: 'returned', why: 'this node\'s invoice is CANCELED' };
  return { cls: 'undecided', why: 'this node\'s invoice is ' + String(inv.state || '?') + ' and does not list this HTLC' };
}

function createSentWatch(deps) {
  const {
    dataDir = null, lndGet, lndPost, log = () => {}, now = () => Date.now(),
    isWalletPeer = () => true,            // (pubkey) → is this peer a wallet this box serves
    interceptOpen = () => false,          // (circuit key) → the interceptor still holds it unanswered
    sendWakePush = async () => undefined, // (pubkey, holdMs, kind, extra, ttlS) → true when a push went out
    hasPushSub = () => true,              // (pubkey) → the wallet has a push subscription here
    isPushLock = () => false,             // (hash hex) → a Push Key lock: its own rail sends the first wake
    upSince = null, bootGraceMs = 180000, warnBlocks = 100, walletGrace = 3, fwdDays = 14,
    lndIncomingDelta = null,              // a fixed figure (tests); normally left out — the figure is read from LND's version at every sweep
    incomingDeltaSetting = undefined,     // the operator's LND_INCOMING_BROADCAST_DELTA, when set
  } = deps || {};
  const FILE = dataDir ? path.join(dataDir, 'sent-watch.json') : null;
  const started = upSince == null ? now() : upSince;
  let st = { res: {}, items: {} };
  let rep = { ts: 0, height: 0, warn_blocks: warnBlocks, items: [], htlcs: [], near: [], sweeps: 0, last_error: null, fwd_ids: null };
  // 0.133.4: how many blocks below an incoming HTLC's expiry LND goes on-chain when it holds the preimage — by LND's
  // version (lnd-margins.js), read again at every sweep. Until LND has been read: the larger figure.
  let margin = { delta: 16, source: 'unknown', version: '', note: 'LND not read yet' };
  let saveT = null;
  load();

  function load() {
    if (!FILE) return;
    try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && typeof j === 'object') st = { res: j.res || {}, items: j.items || {} }; }
    catch (e) { if (e && e.code !== 'ENOENT') log(`[SENT-WATCH] the state file could not be read (${e.message}) — starting empty`); }
  }
  function saveNow() {
    if (!FILE) return;
    try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, FILE); }
    catch (e) { log(`[SENT-WATCH] the state file could not be written: ${e.message}`); }
  }
  function saveSoon() {
    if (!FILE || saveT) return;
    saveT = setTimeout(() => { saveT = null; saveNow(); }, 2000);
    if (saveT && saveT.unref) saveT.unref();
  }

  // called for every answer this adapter gives LND about an intercepted HTLC. Never throws.
  function noteResolution(incomingCircuitKey, action) {
    try {
      const ck = incomingCircuitKey || {};
      const key = circuitKey(ck.chan_id, ck.htlc_id);
      const a = String(action || '').toUpperCase();
      if (a === 'SETTLE' || a === 'FAIL') { st.res[key] = { a: a === 'SETTLE' ? 'S' : 'F', t: now() }; saveSoon(); }
      else if (st.res[key]) { delete st.res[key]; saveSoon(); }   // RESUME: LND forwards it — its fate is read from LND
    } catch (_) {}
  }
  function pruneRes() {
    const t = now(); const keys = Object.keys(st.res);
    for (const k of keys) if (!(st.res[k] && t - Math.max(Number(st.res[k].t || 0), Number(st.res[k].p || 0)) < KEEP_RES_MS)) delete st.res[k];
    const left = Object.keys(st.res);
    if (left.length > MAX_RES) { left.sort((a, b) => st.res[a].t - st.res[b].t); for (const k of left.slice(0, left.length - MAX_RES)) delete st.res[k]; }
  }

  // LND's forwarding history, read at most once a sweep and only when a forwarded HTLC's outgoing half is gone
  async function loadFwd() {
    const t1 = Math.floor(now() / 1000) + 3600, t0 = t1 - fwdDays * 86400 - 3600;
    const evs = []; let offset = 0;
    for (let page = 0; page < 20; page++) {
      const r = await lndPost('/v1/switch', { start_time: String(t0), end_time: String(t1), index_offset: offset, num_max_events: 10000 });
      if (!r || !Array.isArray(r.forwarding_events)) { if (page === 0) throw new Error((r && r.message) || 'no forwarding_events in the answer'); break; }
      for (const e of r.forwarding_events) evs.push(e);
      if (r.forwarding_events.length < 10000) break;
      offset = Number(r.last_offset_index || 0); if (!offset) break;
    }
    const withIds = evs.some((e) => e && e.incoming_htlc_id !== undefined && e.incoming_htlc_id !== null);
    rep.fwd_ids = evs.length ? withIds : rep.fwd_ids;
    const byIn = new Set(), byOut = new Set();
    for (const e of evs) {
      if (!e) continue;
      if (e.incoming_htlc_id !== undefined && e.incoming_htlc_id !== null) byIn.add(`${e.chan_id_in}:${e.incoming_htlc_id}`);
      if (e.outgoing_htlc_id !== undefined && e.outgoing_htlc_id !== null) byOut.add(`${e.chan_id_out}:${e.outgoing_htlc_id}`);
    }
    return { count: evs.length, withIds, byIn, byOut };
  }

  async function sweep() {
    const t = now();
    if (t - started < bootGraceMs) return { skipped: 'boot' };
    let chans, info, lastError = null;
    try { [chans, info] = await Promise.all([lndGet('/v1/channels'), lndGet('/v1/getinfo')]); }
    catch (e) { rep.last_error = String(e.message || e); return { error: rep.last_error }; }
    const list = chans && Array.isArray(chans.channels) ? chans.channels : null;
    const height = Number(info && info.block_height);
    if (!list || !(height > 0)) { rep.last_error = 'LND gave no channel list or no block height'; return { error: rep.last_error }; }
    const mg = Number.isInteger(lndIncomingDelta) ? { delta: lndIncomingDelta, source: 'fixed', version: '', note: 'fixed by the caller' } : incomingBroadcastDelta(info && info.version, incomingDeltaSetting);
    if (mg.delta !== margin.delta || mg.note !== margin.note) log(`[SENT-WATCH] LND goes on-chain ${mg.delta} blocks below the expiry of an incoming HTLC it holds the preimage of (${mg.note}) — a completed payment's wakes count to that block`);
    margin = mg; const lndDelta = mg.delta;
    const chansById = {}; for (const c of list) for (const id of idsOf(c)) chansById[id] = c;

    let fwd; const invCache = new Map();
    const ev = {
      open: (k) => { try { return !!interceptOpen(k); } catch (_) { return true; } },   // unreadable → treated as held: no wake on doubt
      res: (k) => (st.res[k] && st.res[k].a) || null,
      chansById,
      invoice: async (hex) => {
        if (!hex) return undefined;
        if (invCache.has(hex)) return invCache.get(hex);
        let v;
        try {
          const inv = await lndGet('/v1/invoice/' + hex);
          if (inv && inv.state) v = { state: String(inv.state), htlcs: Array.isArray(inv.htlcs) ? inv.htlcs : [] };
          else if (inv && /unable to locate invoice|no existing invoices|not found/i.test(String(inv.message || inv.error || ''))) v = null;
          else v = undefined;   // any other answer (LND busy, a refused key): not evidence
        } catch (_) { v = undefined; }
        invCache.set(hex, v); return v;
      },
      fwdSettled: async (idsIn, hin, idsOut, hout) => {
        try { if (fwd === undefined) fwd = await loadFwd(); } catch (e) { fwd = null; lastError = 'forwarding history: ' + String(e.message || e); }
        if (!fwd) return null;
        if (fwd.count === 0) return false;   // LND recorded no settled forward at all in the window
        if (fwd.withIds) return (idsIn || []).some((c) => fwd.byIn.has(`${c}:${String(hin || '0')}`)) || (idsOut || []).some((c) => fwd.byOut.has(`${c}:${String(hout || '0')}`));
        return null;   // this LND's records carry no HTLC numbers: an amount alone is not evidence — undecided
      },
    };

    const seen = new Set(); const rows = []; const cands = []; let changed = false;   // rows: EVERY pending HTLC (0.133.3)
    for (const c of list) {
      const wallet = !!isWalletPeer(c.remote_pubkey);
      for (const h of (c.pending_htlcs || [])) {
        if (!h) continue;
        const exp = Number(h.expiration_height), amt = Number(h.amount || 0), hash = b64ToHex(h.hash_lock);
        if (!h.incoming) {
          // C: an outgoing HTLC — LND goes on-chain over it at its expiry
          const left = exp - height;
          rows.push({ dir: 'out', near: left <= warnBlocks, peer: c.remote_pubkey, chan_point: c.channel_point, active: !!c.active, sats: amt, hash, expiry: exp, block: exp, left, what: 'outgoing — LND closes this channel on-chain at this block if the peer has not answered' });
          continue;
        }
        if (wallet) for (const id of idsOf(c)) { const rk = st.res[circuitKey(id, h.htlc_index)]; if (rk) rk.p = t; }   // its answer is kept while the HTLC is still here
        const offlineWallet = wallet && !c.active;            // only a wallet that is offline needs a wake; a connected one is answered at once
        const lndBlock = exp - lndDelta;              // where LND goes on-chain for an incoming HTLC it holds the preimage of
        // 0.133.3: every incoming HTLC is sorted and listed, whatever its channel and however far its block — the
        // Console's card then holds what the Channels pane counts; `near` (within WARN_BLOCKS) only marks the warning
        const key = circuitKey(c.chan_id, h.htlc_index);
        let k; try { k = await classify(c, h, ev); } catch (e) { k = { cls: 'undecided', why: 'error: ' + String(e.message || e) }; }
        if (!offlineWallet || (k.cls !== 'completed' && k.cls !== 'returned')) {
          if (offlineWallet && st.items[key]) { delete st.items[key]; changed = true; }
          // C: an incoming HTLC that is not a sent payment sorted for an offline wallet
          rows.push({ dir: 'in', near: lndBlock - height <= warnBlocks, cls: k.cls, why: k.why, peer: c.remote_pubkey, chan_point: c.channel_point, active: !!c.active, wallet, sats: amt, hash, expiry: exp, block: lndBlock, left: lndBlock - height,
            what: k.cls === 'flight' ? 'still in flight — if this box comes to hold its preimage, LND closes this channel on-chain at this block to collect it'
              : k.cls === 'undecided' ? 'not sorted — if this box settled it, LND closes this channel on-chain at this block; if it failed it, a wallet engine before v376 closes its channel when it returns 3 blocks past the expiry'
              : k.cls === 'completed' ? 'settled here and the peer is connected — it should leave the channel at once; if it stays, LND closes this channel on-chain at this block to collect it'
              : 'failed here and the peer is connected — it should leave the channel at once' });
          continue;
        }
        seen.add(key);
        let it = st.items[key];
        if (!it || it.cls !== k.cls) { it = st.items[key] = { key, hash, pk: String(c.remote_pubkey || '').toLowerCase(), cp: c.channel_point, cls: k.cls, why: k.why, expiry: exp, sats: amt, first_ms: t, seen: 1, marks: { now: false, d1: false, h6: false, h1: false }, last_wake_ms: 0, wakes: 0 }; changed = true; log(`[SENT-WATCH] ${hash.slice(0, 16)}… on ${String(c.remote_pubkey).slice(0, 16)}…'s channel: ${k.cls.toUpperCase()} while the wallet is offline (${k.why}); expiry block ${exp}, now ${height}`); }
        else { if (it.seen < 2) { it.seen += 1; changed = true; } if (it.why !== k.why) { it.why = k.why; changed = true; } }
        const deadline = k.cls === 'completed' ? exp - lndDelta : exp + walletGrace;
        cands.push({ it, cls: k.cls, hash, deadline, left: deadline - height, exp, amt, c });
      }
    }
    // A: THE WAKE — one line of wakes per wallet, by its LEAD payment: its completed payment with the lowest deadline
    // block if it has one (that wake carries the time to open by), else its returned payment with the lowest. Opening
    // the wallet answers every one of them, and a second notification would only replace the first on the phone.
    const lead = new Map();
    for (const x of cands) {
      if (x.it.seen < 2) continue;
      const cur = lead.get(x.it.pk);
      if (!cur || (x.cls === 'completed' && cur.cls !== 'completed') || (x.cls === cur.cls && x.deadline < cur.deadline)) lead.set(x.it.pk, x);
    }
    for (const x of lead.values()) {
      const it = x.it, left = x.left, hash = x.hash;
      const due = dueMark(left, it.marks);
      if (!due) continue;
      if (!hasPushSub(it.pk)) { if (!it.nosub) { it.nosub = true; changed = true; log(`[SENT-WATCH] ${hash.slice(0, 16)}…: that wallet has no push subscription here — it cannot be woken`); } continue; }
      if (it.nosub) { delete it.nosub; changed = true; }
      if (due === 'now' && isPushLock(hash)) { it.marks = marksAfter(it.marks, 'now'); changed = true; continue; }   // the Push rail sent this one itself
      const kind = x.cls === 'completed' ? 'sent_completed' : 'sent_returned';
      const holdMs = x.cls === 'completed' ? statedMs(left) : undefined;
      const ttlS = Math.max(60, Math.min(28 * 86400, x.cls === 'completed' ? Math.floor(holdMs / 1000) : left * 600));
      let sent; try { sent = await sendWakePush(it.pk, holdMs, kind, undefined, ttlS); } catch (_) { sent = undefined; }
      if (sent === true) { it.marks = marksAfter(it.marks, due); it.last_wake_ms = now(); it.wakes = Number(it.wakes || 0) + 1; changed = true; log(`[SENT-WATCH] ${hash.slice(0, 16)}…: wake sent to ${it.pk.slice(0, 16)}… (${kind}, ${due === 'now' ? 'at once' : due}; ${left} block(s) to the deadline ${x.deadline})`); }
    }
    // C: the Console's line
    for (const x of cands) {
      const isLead = lead.get(x.it.pk) === x; if (!!x.it.lead !== isLead) { x.it.lead = isLead; changed = true; }
      rows.push({ dir: 'in', near: x.left <= warnBlocks, cls: x.cls, peer: x.c.remote_pubkey, chan_point: x.c.channel_point, active: false, wallet: true, sats: x.amt, hash: x.hash, expiry: x.exp, block: x.deadline, left: x.left,
        what: whatFor(x.cls), why: x.it.why, wakes: Number(x.it.wakes || 0), nosub: !!x.it.nosub, lead: isLead, last_wake_ms: x.it.last_wake_ms || 0, confirmed: x.it.seen >= 2 });
    }
    for (const k of Object.keys(st.items)) if (!seen.has(k)) { delete st.items[k]; changed = true; }   // answered, or the wallet is back
    pruneRes();
    rows.sort((a, b) => a.left - b.left);
    const near = rows.filter((r) => r.near);   // within WARN_BLOCKS of the block at which a channel goes on-chain over it — the warning
    rep = Object.assign({}, rep, { ts: t, height, warn_blocks: warnBlocks, htlcs: rows, near,
      items: Object.keys(st.items).map((k) => { const i = st.items[k]; const dl = i.cls === 'completed' ? i.expiry - lndDelta : i.expiry + walletGrace; return { hash: i.hash, peer: i.pk, chan_point: i.cp, cls: i.cls, why: i.why, what: whatFor(i.cls), sats: i.sats, expiry: i.expiry, deadline: dl, left: dl - height, wakes: Number(i.wakes || 0), last_wake_ms: i.last_wake_ms || 0, nosub: !!i.nosub, confirmed: i.seen >= 2, lead: !!i.lead }; }),
      sweeps: Number(rep.sweeps || 0) + 1, last_error: lastError, incoming_delta: margin.delta, incoming_delta_source: margin.source, incoming_delta_note: margin.note, lnd_version: margin.version });
    if (changed) saveSoon();
    return { ok: true, height, items: rep.items.length, near: near.length, htlcs: rows.length };
  }

  return {
    noteResolution, sweep,
    report: () => Object.assign({ incoming_delta: margin.delta, incoming_delta_source: margin.source, incoming_delta_note: margin.note, lnd_version: margin.version }, rep, { up_grace_left_ms: Math.max(0, bootGraceMs - (now() - started)) }),
    flush: () => { if (saveT) { clearTimeout(saveT); saveT = null; } saveNow(); },
    _state: () => st,
  };
}

module.exports = { createSentWatch, classify, dueMark, marksAfter, statedMs, circuitKey, idsOf };
