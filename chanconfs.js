'use strict';
// LIJOX Adapter — chanconfs.js (0.135.0, S71; the wallet repo's docs/design/channel-confs/channel-confs-r1.md).
// How many confirmations this provider's LND asks for before a channel the WALLET funds can be used. The number is
// LND's, not the adapter's: LND tells it to the wallet's node when it accepts the channel, and LND does not give it
// out over its API. So the adapter STATES it on the registry record (the `chan_confs` block, {min, max}) from what it
// can read, and the wallet checks the statement at every channel it funds against the number LND really asked for.
//
// Where the statement comes from, first that holds:
//   1. CHAN_CONFS in .env — the operator states it: one number ("3") or a range ("3-6").
//   2. bitcoin.defaultchanconfs in the lnd.conf TATARA_LND_CONF names — one number for every channel.
//   3. LND's own rule when that setting is absent: 3 for a small channel, rising with its size to 6.
// This file reads a settings file and nothing else: no LND call, no network, no state.
const fs = require('fs');

const LND_OWN_MIN = 3, LND_OWN_MAX = 6;   // lnd, when bitcoin.defaultchanconfs is not set: scaled with the channel's size
const CONFS_MAX = 144;                    // the registry refuses more

/// CHAN_CONFS as written → { min, max }, null when not set, or { problem } when it cannot be read.
function parseStated(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null;
  const m = /^([0-9]{1,3})(?:\s*-\s*([0-9]{1,3}))?$/.exec(s);
  if (!m) return { problem: 'CHAN_CONFS="' + s + '" is not a number ("3") or a range ("3-6")' };
  const min = Number(m[1]), max = m[2] === undefined ? min : Number(m[2]);
  if (min < 1 || max < min || max > CONFS_MAX) return { problem: 'CHAN_CONFS="' + s + '" must be from 1 to ' + CONFS_MAX + ', the first number not above the second' };
  return { min, max };
}

/// bitcoin.defaultchanconfs in an lnd.conf: the number (0 = the line is absent or 0, LND's own rule applies);
/// null = no path, or the file could not be read.
function readDefaultChanConfs(path) {
  const p = String(path || '').trim();
  if (!p) return null;
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const m = /^\s*bitcoin\.defaultchanconfs\s*=\s*([^\s;#]+)\s*$/mi.exec(txt);
    if (!m) return 0;
    return /^[0-9]+$/.test(m[1]) ? Number(m[1]) : 0;
  } catch (_) { return null; }
}

/// What this provider states: { min, max, from, problem }. `from` says in plain words where the numbers came from.
function chanConfs(env) {
  const e = env || {};
  const stated = parseStated(e.CHAN_CONFS);
  const problem = (stated && stated.problem) || '';
  if (stated && !stated.problem) return { min: stated.min, max: stated.max, from: 'CHAN_CONFS', problem: '' };
  const n = readDefaultChanConfs(e.TATARA_LND_CONF);
  if (n !== null && n >= 1 && n <= CONFS_MAX) return { min: n, max: n, from: 'bitcoin.defaultchanconfs in ' + String(e.TATARA_LND_CONF).trim(), problem };
  if (n === 0) return { min: LND_OWN_MIN, max: LND_OWN_MAX, from: "LND's own rule (" + String(e.TATARA_LND_CONF).trim() + ' sets no bitcoin.defaultchanconfs)', problem };
  return { min: LND_OWN_MIN, max: LND_OWN_MAX, from: "LND's own rule, assumed (lnd.conf not read — set CHAN_CONFS if it sets bitcoin.defaultchanconfs)", problem };
}

const words = (c) => (c.min === c.max ? String(c.min) : c.min + ' to ' + c.max) + (c.max === 1 ? ' confirmation' : ' confirmations');
function bootLine(c) {
  return '[ChanConfs] a channel a wallet funds is usable after ' + words(c) + ' · from: ' + c.from + (c.problem ? ' · NOT USED: ' + c.problem : '');
}

module.exports = { chanConfs, parseStated, readDefaultChanConfs, bootLine, words, LND_OWN_MIN, LND_OWN_MAX, CONFS_MAX };
