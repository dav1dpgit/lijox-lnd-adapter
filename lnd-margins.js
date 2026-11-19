'use strict';
// lnd-margins.js — 0.133.4 (S70 Thu 2026-11-19, DP 10:51 "Go for 0.133.4"): HOW MANY BLOCKS BELOW AN INCOMING HTLC'S
// EXPIRY LND GOES ON-CHAIN WHEN IT HOLDS THE PREIMAGE — read from the running LND's version, in one place.
//
// The figure is LND's lncfg.DefaultIncomingBroadcastDelta. server.go wires the default in; lnd.conf has no setting
// for it. Read in LND's source, tag by tag (2026-11-19; lncfg/config.go):
//     v0.19.3-beta   10          v0.21.0-beta   16
//     v0.20.1-beta   10          v0.21.6-beta   16
//                                v0.21.8-beta   16   (and the same file in the fork branch v0.21.8-beta-terminus)
// 0.133.0–0.133.3 (sent-watch.js) and the Push rail's sender wake since 0.113.0 (push.js) used a fixed 10 — taken
// from older LND and not re-read. On LND 0.21 that put the deadline of a completed payment's wake 6 blocks too
// high: the time stated to the wallet user could be later than LND's own block, and the last wake left at it.
//
// The rule here: 0.21 and above → 16; below 0.21 → 10; a version that cannot be read → 16 (the larger figure is the
// lower block number — the wallet user is told an earlier time, never a later one). An operator whose LND differs
// (a patched build, a release after this was written) sets LND_INCOMING_BROADCAST_DELTA; a release that changes the
// figure again needs a new line in TABLE.
const TABLE = [   // [major, minor] and above → blocks; the highest line that fits is taken
  [[0, 21], 16],
  [[0, 0], 10],
];
const SAFE = 16;   // for a version that cannot be read
const MIN = 1, MAX = 144;

// "0.21.8-beta commit=v0.21.8-beta-…" → [0, 21, 8]; null when it does not start with numbers
function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v == null ? '' : v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

// → { delta, source: 'setting' | 'version' | 'unknown', version: the short version read, note }
function incomingBroadcastDelta(lndVersion, override) {
  const short = String(lndVersion == null ? '' : lndVersion).trim().split(/\s+/)[0] || '';
  const o = (override === undefined || override === null || String(override).trim() === '') ? null : Number(String(override).trim());
  if (o !== null) {
    if (Number.isInteger(o) && o >= MIN && o <= MAX) return { delta: o, source: 'setting', version: short, note: `LND_INCOMING_BROADCAST_DELTA=${o}` };
    // a setting that is not a whole number of blocks in range is not used — and said, never taken silently
    const r = incomingBroadcastDelta(lndVersion, null);
    return Object.assign(r, { note: r.note + ` (LND_INCOMING_BROADCAST_DELTA="${String(override).slice(0, 20)}" is not a whole number from ${MIN} to ${MAX} — not used)`, bad_setting: true });
  }
  const p = parseVersion(lndVersion);
  if (!p) return { delta: SAFE, source: 'unknown', version: short, note: `LND's version could not be read${short ? ' ("' + short.slice(0, 30) + '")' : ''} — the larger figure, ${SAFE}, is used` };
  for (const [[maj, min], blocks] of TABLE) {
    if (p[0] > maj || (p[0] === maj && p[1] >= min)) return { delta: blocks, source: 'version', version: short, note: `LND ${short}` };
  }
  return { delta: SAFE, source: 'unknown', version: short, note: `no rule for LND ${short} — the larger figure, ${SAFE}, is used` };
}

module.exports = { incomingBroadcastDelta, parseVersion, TABLE, SAFE };
