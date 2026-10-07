// copies.js — 0.93.0 (S57, DP 2026-10-07 15:10 "Go with all other proposals (1, 3, etc.)"): ONE OPEN COPY AT A TIME.
// Two copies of one wallet (the same 12 words on two devices) both talking to this provider is how channels get
// force-closed: LND keeps one connection per wallet key, so the copies knock each other off, and a copy whose channel
// state is older re-establishes with that older state. Each copy makes a random session number at unlock and registers
// it in its SIGNED my-channels request (so nobody without the wallet's key can fake a second copy); its heartbeat
// (/health?client=…&session=…) then says it is still open, with two plain facts about how current it is: how many of
// this provider's channels it has a record of (known) and its backup number (bn). When two registered sessions of one
// wallet are both alive — the other one's last heartbeat within the window AND after this one registered (a copy that
// was simply closed and reopened never overlaps itself) — the heartbeat answer names the other copy, and both wallets
// pause and ask their person to close the less current one. In memory only: a restart forgets every session (the next
// heartbeat of a copy that never re-registers simply counts as unregistered — no alarm, nothing blocked).
'use strict';

class CopyWatch {
  constructor({ windowMs = 60_000, keepMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.keepMs = keepMs;
    this.now = now;
    this.byWallet = new Map();   // pubkey → Map(session → { reg, last, known, bn })
  }

  _prune(pk) {
    const m = this.byWallet.get(pk);
    if (!m) return null;
    const t = this.now();
    for (const [sid, s] of m) if (t - Math.max(s.reg, s.last) > this.keepMs) m.delete(sid);
    if (!m.size) { this.byWallet.delete(pk); return null; }
    return m;
  }

  // A session is registered only from a request the wallet's node key signed (my-channels).
  register(pk, sid) {
    if (!/^0[23][0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{32}$/.test(sid)) return false;
    let m = this._prune(pk);
    if (!m) { m = new Map(); this.byWallet.set(pk, m); }
    if (!m.has(sid)) m.set(sid, { reg: this.now(), last: 0, known: null, bn: null });   // a reload in the same tab keeps its first registration
    return true;
  }

  // Seconds since the most recent sign of life of ANOTHER session of this wallet, or null when there is none.
  lastOtherSeenS(pk, sid) {
    const m = this._prune(pk);
    if (!m) return null;
    let best = null;
    for (const [other, s] of m) {
      if (other === sid) continue;
      const seen = Math.max(s.reg, s.last);
      if (best === null || seen > best) best = seen;
    }
    return best === null ? null : Math.max(0, Math.round((this.now() - best) / 1000));
  }

  // A heartbeat. Unregistered sessions are ignored (null). Answers what this copy should know: itself and every other
  // copy that is alive together with it.
  beat(pk, sid, known, bn) {
    const m = this._prune(pk);
    if (!m || !m.has(sid)) return null;
    const me = m.get(sid);
    const t = this.now();
    me.last = t;
    if (Number.isFinite(known) && known >= 0) me.known = Math.floor(known);
    if (Number.isFinite(bn) && bn >= 0) me.bn = Math.floor(bn);
    const others = [];
    for (const [other, s] of m) {
      if (other === sid || !s.last) continue;
      if (t - s.last > this.windowMs) continue;   // not heard within the window
      if (s.last < me.reg) continue;              // its last beat came before this copy began: closed (or reopened as this one), not open
      others.push({ known: s.known, bn: s.bn, seen_s: Math.round((t - s.last) / 1000) });
    }
    return { me: { known: me.known, bn: me.bn }, others };
  }
}

module.exports = { CopyWatch };
