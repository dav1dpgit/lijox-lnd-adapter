'use strict';
// 0.136.0 (S71 Fri 2026-11-20, DP 09:45 "'The choices are: catch up, or close on purpose.' Agreed. Carry on and go
// beyond A-E — approved." · 11:30 "Let's go and fold in." — the wallet repo's docs/incidents/2026-11-20-channel-close-r2.md §4.1):
// THE HIGH MARK AND THE PASS — a wallet that is behind its channels is not passed through to LND.
//
// What happened on 2026-11-20: a wallet connected while it held an older channel state than LND did. LND closes a
// channel by force the moment the other side reconnects with an older state (lnwallet ProcessChanSyncMsg, "possible
// remote commitment state data loss"); it does not ask why. Both channels of that wallet were closed in one second.
// What travels through the tunnel is encrypted between the wallet and LND, so the adapter cannot read the wallet's
// reconnect message; and LND's API gives out one of the two numbers it compares, not both. What CAN decide is the
// wallet's own record:
//   · THE STATEMENT. A wallet states, signed with its node key, the update number of each channel record it holds
//     ("txid:vout" → number). That number rises with every change to the channel and never falls.
//   · THE HIGH MARK. This box keeps, per wallet key and channel, the highest number that wallet has stated. A wallet
//     that states a LOWER number than its own high mark holds an older state than one it once held: it is behind,
//     with certainty. Nothing is raised from a statement that is behind.
//   · THE PASS. A statement that is not behind may ask for a pass: 32 random bytes, good once, for PASS_TTL_MS. The
//     wallet presents it on its WebSocket before its first bytes (ws-tunnel.js); a wallet that is behind gets no pass.
// Its limit: the high mark is as fresh as the wallet's last statement. The wallet states after each change of state.
// No network and no LND in this file: the route in lij-adapter.js proves the key, this keeps the marks and the passes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOMAIN = 'lijox-state-v1:';
const MAX_CHANNELS = 64;
const PASS_TTL_MS = 90000;
const SKEW_MS = 120000;        // a statement's own time may differ from this box's clock by this much
const MAX_WALLETS_DEFAULT = 20000;
const PASS_FRAME = 'lijox-pass:';   // the text frame a wallet sends on its WebSocket before its first bytes

function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// The statement in one fixed form: "txid:vout=number" for each channel, sorted by name, joined by commas. The wallet
// writes the very same text and both sides hash it. '' for a wallet that holds no channel record.
function canonical(channels) {
  return Object.keys(channels).sort().map((k) => k + '=' + String(channels[k])).join(',');
}
// what the node key signs: the wallet's key, the statement's own time (unix ms) and the hash of the statement
function signedText(pk, atMs, channels) {
  return DOMAIN + pk + ':' + String(atMs) + ':' + sha256hex(Buffer.from(canonical(channels), 'utf8'));
}
// the statement's shape: at most MAX_CHANNELS records, each "64 hex:index" → a whole number
function cleanChannels(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length > MAX_CHANNELS) return null;
  const out = {};
  for (const k of keys) {
    if (!/^[0-9a-f]{64}:\d{1,5}$/.test(k)) return null;
    const n = v[k];
    if (!Number.isSafeInteger(n) || n < 0) return null;
    out[k] = n;
  }
  return out;
}

function createStateMarks(opts) {
  const dir = path.join(opts.dataDir, 'state-marks');
  const log = opts.log || function () {};
  const now = opts.now || (() => Date.now());
  const passTtl = opts.passTtlMs || PASS_TTL_MS;
  const skew = opts.skewMs || SKEW_MS;
  const maxWallets = opts.maxWallets || MAX_WALLETS_DEFAULT;
  const required = !!opts.required;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const okPk = (pk) => /^0[23][0-9a-f]{64}$/.test(pk);
  const file = (pk) => path.join(dir, pk + '.json');
  const lastAt = new Map();    // wallet key → the time of its last accepted statement (a statement is taken once)
  const passes = new Map();    // pass → { pk, exp }

  function marksOf(pk) {
    if (!okPk(pk)) return {};
    try { const m = JSON.parse(fs.readFileSync(file(pk), 'utf8')); return cleanChannels(m && m.marks) || {}; } catch (e) { return {}; }
  }
  function count() { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch (e) { return 0; } }
  function writeAtomic(f, data) { const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, data); fs.renameSync(t, f); }
  function sweep() { const t = now(); for (const [p, r] of passes) if (r.exp <= t) passes.delete(p); }

  // Which channels of a statement are below this wallet's high marks — a look, nothing kept. [{chan_point, stated, mark}]
  function behindOf(pk, channelsIn) {
    const channels = cleanChannels(channelsIn);
    if (!okPk(pk) || !channels) return [];
    const marks = marksOf(pk), out = [];
    for (const k of Object.keys(channels)) {
      if (Object.prototype.hasOwnProperty.call(marks, k) && channels[k] < marks[k]) out.push({ chan_point: k, stated: channels[k], mark: marks[k] });
    }
    return out;
  }

  // One statement. → { ok:false, code } | { ok:true, behind:[{chan_point, stated, mark}], pass?, pass_ttl_s? }
  // opts.ignore: channel names left out of the comparison and never raised — the route gives the ones LND no longer
  // holds open with this wallet (closed or closing): a reconnect cannot close those, so a lower number for them is
  // no reason to refuse the pass.
  function state(pk, channelsIn, atMs, wantPass, opts) {
    const ignore = new Set(((opts && opts.ignore) || []).map((x) => String(x)));
    if (!okPk(pk)) return { ok: false, code: 'bad_key' };
    const channels = cleanChannels(channelsIn);
    if (!channels) return { ok: false, code: 'bad_channels' };
    if (!Number.isSafeInteger(atMs)) return { ok: false, code: 'bad_time' };
    const t = now();
    // The statement's own time must be near this box's clock, and above the last one taken from this key: a statement
    // is taken once (a copy of an old one could do no harm — marks only rise — but it is not taken twice). A refusal
    // answers a time the wallet may sign instead (now_ms): a phone whose clock is off states again with it, once.
    const last = lastAt.get(pk) || 0;
    if (Math.abs(t - atMs) > skew || atMs <= last) return { ok: false, code: 'clock', now_ms: Math.max(t, last + 1) };
    const marks = marksOf(pk);
    const behind = [];
    for (const k of Object.keys(channels)) {
      if (ignore.has(k)) continue;
      if (Object.prototype.hasOwnProperty.call(marks, k) && channels[k] < marks[k]) behind.push({ chan_point: k, stated: channels[k], mark: marks[k] });
    }
    lastAt.set(pk, atMs);
    if (lastAt.size > maxWallets * 2) lastAt.clear();
    if (behind.length) {
      log(`[State] ${pk.slice(0, 16)} is BEHIND its own high mark on ${behind.length} channel(s): ` + behind.map((b) => `${b.chan_point.slice(0, 12)}… stated ${b.stated}, mark ${b.mark}`).join('; ') + ' — no pass');
      return { ok: true, behind };
    }
    let rose = false, isNew = Object.keys(marks).length === 0;
    for (const k of Object.keys(channels)) { if (ignore.has(k)) continue; if (!Object.prototype.hasOwnProperty.call(marks, k) || channels[k] > marks[k]) { marks[k] = channels[k]; rose = true; } }
    if (rose) {
      if (isNew && count() >= maxWallets) return { ok: false, code: 'full' };
      // a mark for a channel the wallet no longer states stays: it costs a line and can never wrongly refuse (a
      // channel's name is never used twice)
      try { writeAtomic(file(pk), JSON.stringify({ marks, at: t })); }
      catch (e) { log(`[State] the marks of ${pk.slice(0, 16)} could not be written: ${e.message}`); return { ok: false, code: 'store' }; }
    }
    const out = { ok: true, behind: [] };
    if (wantPass) {
      sweep();
      const pass = crypto.randomBytes(32).toString('hex');
      passes.set(pass, { pk, exp: t + passTtl });
      out.pass = pass; out.pass_ttl_s = Math.floor(passTtl / 1000);
    }
    return out;
  }

  // A pass presented on a WebSocket: good once, before it expires.
  function takePass(pass) {
    const p = String(pass || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(p)) return { ok: false, code: 'bad_pass' };
    const r = passes.get(p);
    if (!r) return { ok: false, code: 'unknown' };
    passes.delete(p);
    if (r.exp <= now()) return { ok: false, code: 'expired' };
    return { ok: true, pubkey: r.pk };
  }

  return { state, behindOf, takePass, marksOf, count, required: () => required, capability: { v: 1, required } };
}

module.exports = { createStateMarks, signedText, canonical, cleanChannels, sha256hex, DOMAIN, PASS_FRAME, PASS_TTL_MS, SKEW_MS, MAX_CHANNELS };
