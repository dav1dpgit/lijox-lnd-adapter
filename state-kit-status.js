'use strict';
// state-kit-status.js — 0.123.0 (S66 Wed 2026-11-04, the box recovery v0.1 — DP's rulings 16:19): THE STATE KIT's receipts
// for the Console's Backups pane. The kit itself is a script on the box (the wallet repo's ops/um890-scb/lij-state-kit.sh,
// run by a daily timer): the box's OWN state — the float wallet's descriptors with their keys, this adapter's env and state
// files (the push subscriptions, the wallets' Black start kits, the Lightning-address names, the Push Keys, the lease
// state, the on-chain pay records, the Mix), bitcoin.conf, the tunnel's files, the units' text — in one age-encrypted
// archive a day, shipped by the SCB kit's two legs (the LAN box, the worker's /lsp-state). The script leaves three files
// in the SCB state folder: state-kit.manifest.json (every piece's size and hash, the versions — no secret) and
// status-state-local.json / status-state-cloud.json (the legs' receipts, the SCB status files' shape plus the archive's
// name, size and sha256). This module only READS them; nothing here can start a kit or open one.
const fs = require('fs');

const STALE_S = 26 * 3600;   // the daily belt plus a margin, as the SCB legs
const LEG_WORDS = {
  local: 'the LAN box — once a day, seven days kept',
  cloud: 'the worker — once a day, the newest and the one before; 20 MB the line',
};
const WHAT_WORDS = 'the box’s own state — the float wallet’s keys, this adapter’s env and state files (the push subscriptions, the wallets’ kits, the names, the lease, the on-chain pay records), bitcoin.conf, the tunnel, the units; age-encrypted, the key with the seed words';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

// readStateKit(dir, nowMs) → { what, legs } or null when the kit has never run here (no manifest, no status file)
function readStateKit(dir, nowMs) {
  const now = Number(nowMs) || Date.now();
  const man = readJson(`${dir}/state-kit.manifest.json`);
  const out = { what: null, legs: {} };
  if (man && typeof man === 'object') {
    const pieces = Array.isArray(man.pieces) ? man.pieces : [];
    out.what = {
      kit: String(man.kit || ''), pieces: pieces.length, bytes: Number(man.total_bytes || 0), built_ms: Number(man.built_at || 0) * 1000,
      groups: (man.groups && typeof man.groups === 'object') ? man.groups : {}, missing: Array.isArray(man.missing) ? man.missing.map(String) : [],
      versions: (man.versions && typeof man.versions === 'object') ? man.versions : {}, host: String(man.host || ''), words: WHAT_WORDS,
    };
  }
  for (const leg of ['local', 'cloud']) {
    const st = readJson(`${dir}/status-state-${leg}.json`);
    if (!st || typeof st !== 'object') continue;
    const lastOk = Number(st.last_ok || 0);
    out.legs[leg] = {
      ok: st.ok !== false, at_ms: (lastOk || Number(st.last_attempt || 0)) * 1000, attempt_ms: Number(st.last_attempt || 0) * 1000,
      stale: !lastOk || (now / 1000 - lastOk) > STALE_S, note: String(st.err || ''), shipped_ms: lastOk * 1000,
      bytes: Number(st.bytes || 0), sha256: String(st.sha256 || ''), name: String(st.name || ''), where: LEG_WORDS[leg],
    };
  }
  if (!out.what && !Object.keys(out.legs).length) return null;
  return out;
}

module.exports = { readStateKit, LEG_WORDS, WHAT_WORDS, STALE_S };
