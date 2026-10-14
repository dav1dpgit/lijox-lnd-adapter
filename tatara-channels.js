// tatara-channels.js — 0.103.0 (S58, DP 2026-10-13 18:08 "Proceed with onchain to pool to channel (1b) now"; Tatara
// v0.10 §6.3.4, §6.3.6, §6.3.8; rollout step 12). THE PROVIDER'S SIDE OF A CHANNEL POOL'S PENDING CHANNELS.
//
// In a channel pool each member's payout is a channel's funding (P2WSH) with this provider; LND holds that channel as
// a pending inbound one from the member's funding_created until the pool's exit reaches the chain. The provider keeps
// its side by the same test the phone uses (§6.3.4), read on its own node: the pool's funding transaction is public
// once sent — the backup a seat hands in (tatara-forward.js) holds it — and the pending channel is dropped only when
// one of that transaction's inputs is spent by ANOTHER transaction, 6 blocks deep (the pool's funding can then never
// confirm): LND AbandonChannel with i_know_what_i_am_doing (lnd v0.21.4-beta: the only way on a production build; the
// call is otherwise dev-build only). A pending channel whose pool funding is in a block but whose exit is still
// unconfirmed 144 blocks later raises an alert (§6.3.8) — once, in the log. Nothing else is ever abandoned here.
//
// What it reads: LND's pending open channels (channel_point "txid:vout"), the kept backups (the funding's inputs), a
// spend notification per input (ChainNotifier RegisterSpendNtfn — the spending txid and height), the tip. The watch
// is written to DATA_DIR/tatara/channels.json so a restart keeps it (the spend streams are opened again).
'use strict';

const fs = require('fs');
const path = require('path');

const SETTLE_DEPTH = 6;
const ALERT_BLOCKS = 144;

/// The inputs of a raw transaction (hex): [{ txid (display order), vout }]. Segwit or not.
function inputsOf(hex) {
  const b = Buffer.from(hex, 'hex');
  let o = 4;
  if (b.length > 6 && b[4] === 0x00 && b[5] === 0x01) o = 6;
  const varint = () => { const f = b[o++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(o); o += 2; return v; } if (f === 0xfe) { const v = b.readUInt32LE(o); o += 4; return v; } const v = Number(b.readBigUInt64LE(o)); o += 8; return v; };
  const n = varint();
  const out = [];
  for (let i = 0; i < n; i++) {
    const txid = Buffer.from(b.subarray(o, o + 32)).reverse().toString('hex'); o += 32;
    const vout = b.readUInt32LE(o); o += 4;
    const l = varint(); o += l + 4;
    out.push({ txid, vout });
  }
  return out;
}

/// `deps`: { log, dataDir, backups: () => [{ attempt_id, funding_hex, funding_txid, exit_txids }], pendingChannels:
/// async () => ["txid:vout"…], abandonChannel: async (txid, vout) => { ok, error }, watchSpend: ({ txid, vout }, cb) =>
/// handle | null (cb({ spending_txid, height })), tipHeight: async () => number, now }.
function createChannelWatch(deps) {
  const { log = () => {}, dataDir = '', backups = () => [], pendingChannels = async () => [], abandonChannel = async () => ({ ok: false, error: 'no abandon' }),
    watchSpend = () => null, tipHeight = async () => 0, now = Date.now } = deps || {};
  const FILE = dataDir ? path.join(dataDir, 'tatara', 'channels.json') : '';
  // channel_point → { attempt_id, funding_txid, inputs: [{txid, vout, spent_by, height}], funded_at, elsewhere_at, alerted, since }
  let watched = {};
  const streams = new Map();   // "txid:vout" → handle
  if (FILE) { try { watched = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (_) { watched = {}; } }
  const persist = () => { if (!FILE) return; try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(watched)); fs.renameSync(tmp, FILE); } catch (e) { log(`[Tatara] channels.json: ${e.message}`); } };

  function onSpend(cp, inp, ev) {
    const w = watched[cp]; if (!w) return;
    const i = w.inputs.find((x) => x.txid === inp.txid && x.vout === inp.vout); if (!i) return;
    i.spent_by = String(ev.spending_txid || '').toLowerCase(); i.height = Number(ev.height) || 0;
    if (i.spent_by === w.funding_txid) { w.funded_at = w.funded_at || i.height; log(`[Tatara] channel ${cp.slice(0, 12)}…: the pool's funding is in a block (${i.height})`); }
    else { w.elsewhere_at = w.elsewhere_at ? Math.min(w.elsewhere_at, i.height) : i.height; log(`[Tatara] channel ${cp.slice(0, 12)}…: a pool input went elsewhere at ${i.height} (${i.spent_by.slice(0, 12)}…) — the channel is dropped once that is ${SETTLE_DEPTH} deep`); }
    persist();
  }
  function ensureStream(cp, inp) {
    const k = inp.txid + ':' + inp.vout;
    if (streams.has(k)) return;
    const h = watchSpend({ txid: inp.txid, vout: inp.vout }, (ev) => onSpend(cp, inp, ev));
    if (h) streams.set(k, h);
  }
  function forget(cp) {
    const w = watched[cp]; if (!w) return;
    for (const inp of w.inputs) { const k = inp.txid + ':' + inp.vout; const h = streams.get(k); if (h && typeof h.close === 'function') { try { h.close(); } catch (_) {} } streams.delete(k); }
    delete watched[cp]; persist();
  }
  // the watch written before a restart: its streams again
  for (const [cp, w] of Object.entries(watched)) for (const inp of w.inputs) if (!inp.spent_by) ensureStream(cp, inp);

  /// Every minute (the module's tick): new pending channels that a kept backup explains are watched; a watched one
  /// whose pool input went elsewhere SETTLE_DEPTH deep is abandoned; a funded pool whose exit is still pending
  /// ALERT_BLOCKS later is alerted once; a channel no longer pending is forgotten.
  async function tick() {
    let pending;
    try { pending = await pendingChannels(); } catch (e) { log(`[Tatara] pending channels could not be read: ${e.message}`); return { watched: Object.keys(watched).length }; }
    const set = new Set(pending);
    for (const cp of Object.keys(watched)) if (!set.has(cp)) { log(`[Tatara] channel ${cp.slice(0, 12)}… is no longer pending — watch ended`); forget(cp); }
    let bks = null;
    for (const cp of pending) {
      if (watched[cp]) continue;
      const [txid] = cp.split(':');
      if (!bks) { try { bks = backups(); } catch (_) { bks = []; } }
      const bk = bks.find((b) => Array.isArray(b.exit_txids) && b.exit_txids.includes(txid));
      if (!bk) continue;   // not a pool's channel (or no backup yet) — LND's own 2,016-block rule applies
      let inputs;
      try { inputs = inputsOf(bk.funding_hex); } catch (e) { log(`[Tatara] backup ${bk.attempt_id.slice(0, 8)}: the funding does not parse (${e.message})`); continue; }
      if (!inputs.length) continue;
      watched[cp] = { attempt_id: bk.attempt_id, funding_txid: bk.funding_txid, inputs, funded_at: 0, elsewhere_at: 0, alerted: false, since: now() };
      for (const inp of inputs) ensureStream(cp, inp);
      log(`[Tatara] channel ${cp.slice(0, 12)}… pending for pool ${bk.attempt_id.slice(0, 8)}: ${inputs.length} input(s) of its funding watched`);
      persist();
    }
    const tip = await tipHeight().catch(() => 0);
    let abandoned = 0;
    for (const [cp, w] of Object.entries(watched)) {
      if (w.elsewhere_at && tip && tip - w.elsewhere_at + 1 >= SETTLE_DEPTH && !w.funded_at) {
        const [txid, vout] = cp.split(':');
        const r = await abandonChannel(txid, Number(vout)).catch((e) => ({ ok: false, error: e.message }));
        if (r && r.ok) { abandoned++; log(`[Tatara] channel ${cp.slice(0, 12)}… ABANDONED: a pool input went elsewhere ${tip - w.elsewhere_at + 1} blocks ago — the pool's funding can never confirm`); forget(cp); }
        else log(`[Tatara] channel ${cp.slice(0, 12)}… could not be abandoned: ${(r && r.error) || 'no answer'} (the key needs /lnrpc.Lightning/AbandonChannel)`);
        continue;
      }
      if (w.funded_at && tip && tip - w.funded_at >= ALERT_BLOCKS && !w.alerted) {
        w.alerted = true; persist();
        log(`[Tatara] ALERT: channel ${cp.slice(0, 12)}… — the pool's funding has been in a block for ${tip - w.funded_at} blocks and the exit funding this channel is still not; the member's exit may be stuck (§6.3.8)`);
      }
    }
    return { watched: Object.keys(watched).length, abandoned };
  }

  return { tick, inputsOf, watched: () => JSON.parse(JSON.stringify(watched)), SETTLE_DEPTH, ALERT_BLOCKS };
}

module.exports = { createChannelWatch, inputsOf, SETTLE_DEPTH, ALERT_BLOCKS };
