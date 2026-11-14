'use strict';
// tower-watch.js — THE TOWER'S BLOCK WATCH (S69 Fri 2026-11-13; the wallet repo's docs/lijox-watch-standard-r1.md §1,
// DP "1" — the blocks are read through LND's own ChainKit). NOT WIRED INTO lij-adapter.js YET, NOT IN ANY RELEASE.
//
// The holder (tower.js) keeps encrypted penalty transactions under 16-byte hints. This reads every new block, takes
// each transaction id in it, and asks the holder whether it has anything under that id's hint. On a match the held
// items are opened with the full id; what opens into a transaction spending THAT transaction is published — the one
// that pays the higher fee first — and published again on each new block for a day (the wallet's delay is 144
// blocks; a penalty that fell out of the mempools must go back in).
//   · blocks come from three LND reads (GetBestBlock, GetBlockHash, GetBlock); `lnd` is handed in, so this file has
//     no network and can be checked with a stand-in;
//   · a block is believed only when its 80-byte header hashes to the hash that was asked for;
//   · the last twelve heights are remembered with their hashes: a height whose hash changed (a reorganisation) is
//     read again;
//   · the height last read is kept on disk: after a stop the blocks missed are read, up to a ceiling (2,016 — two
//     weeks; more than that is said in the journal and the watch starts from the ceiling);
//   · nothing is ever published that the holder's open() did not approve.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const btc = require('./btc-tx.js');

const dsha = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();

/// A raw block → { hash (base64 of the header's hash, in its own byte order — the form LND's REST gives),
/// txs: [{ txid (as written), start, end }] }. Throws on bytes that are not a whole block.
function parseBlock(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 81) throw new Error('not a block');
  let p = 80;
  const need = (n) => { if (p + n > buf.length) throw new Error('block cut short'); };
  const varint = () => {
    need(1); const f = buf[p++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { need(2); const v = buf.readUInt16LE(p); p += 2; return v; }
    if (f === 0xfe) { need(4); const v = buf.readUInt32LE(p); p += 4; return v; }
    need(8); const v = buf.readBigUInt64LE(p); p += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('count too large'); return Number(v);
  };
  const skip = (n) => { need(n); p += n; };
  const n = varint(); const txs = [];
  for (let i = 0; i < n; i++) {
    const start = p; skip(4);
    let segwit = false;
    need(2); if (buf[p] === 0x00 && buf[p + 1] === 0x01) { segwit = true; p += 2; }
    const bodyStart = p;
    const nin = varint();
    for (let k = 0; k < nin; k++) { skip(36); skip(varint()); skip(4); }
    const nout = varint();
    for (let k = 0; k < nout; k++) { skip(8); skip(varint()); }
    const bodyEnd = p;
    if (segwit) for (let k = 0; k < nin; k++) { const w = varint(); for (let m = 0; m < w; m++) skip(varint()); }
    skip(4);
    // the id is the hash of the transaction WITHOUT its witness: version ‖ inputs and outputs ‖ locktime
    const id = dsha(Buffer.concat([buf.subarray(start, start + 4), buf.subarray(bodyStart, bodyEnd), buf.subarray(p - 4, p)]));
    txs.push({ txid: Buffer.from(id).reverse().toString('hex'), start, end: p });
  }
  if (p !== buf.length) throw new Error('bytes after the last transaction');
  return { hash: dsha(buf.subarray(0, 80)).toString('base64'), txs };
}

function createTowerWatch(opts) {
  const tower = opts.tower, lnd = opts.lnd;
  const dir = path.join(opts.dataDir, 'tower');
  const log = opts.log || function () {};
  const now = opts.now || (() => Date.now());
  const KEEP = opts.recentKeep || 12, CEILING = opts.catchUpMax || 2016, AGAIN_BLOCKS = opts.republishBlocks || 144;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const stateFile = path.join(dir, 'watch.json'), pubFile = path.join(dir, 'published.ndjson');
  let st = { last_height: null, recent: {}, live: [] };   // live: penalties still being published again
  try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (j && typeof j === 'object') st = Object.assign(st, j); } catch (e) {}
  if (!st.recent || typeof st.recent !== 'object') st.recent = {};
  if (!Array.isArray(st.live)) st.live = [];
  const save = () => { const t = stateFile + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(st)); fs.renameSync(t, stateFile); };
  let justNow = new Set();   // old states handled in the look now running: not sent a second time in it
  let busy = false, counts = { blocks: 0, matches: 0, published: 0, last_scan_ms: null, last_error: null };

  async function readBlock(height, hashB64) {
    const raw = await lnd.block(hashB64);
    if (!Buffer.isBuffer(raw)) throw new Error('GetBlock gave no block');
    const b = parseBlock(raw);
    if (b.hash !== hashB64) throw new Error(`the block for height ${height} does not hash to the hash asked for`);
    return { raw, txs: b.txs };
  }
  /// The three reads, end to end, once: said in the journal at start. → { ok, height, txs } | { ok:false, why }
  async function probe() {
    try {
      const best = await lnd.bestBlock();
      if (!best || !Number.isSafeInteger(best.height) || typeof best.hash !== 'string' || !best.hash) return { ok: false, why: 'GetBestBlock gave no height and hash' };
      const h = await lnd.blockHash(best.height);
      if (typeof h !== 'string' || !h) return { ok: false, why: 'GetBlockHash gave no hash' };
      const b = await readBlock(best.height, h);
      return { ok: true, height: best.height, txs: b.txs.length };
    } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 200) }; }
  }
  async function publish(hex) {
    try { await lnd.publish(hex); return null; } catch (e) { return String((e && e.message) || e).slice(0, 160); }
  }
  async function handleMatch(height, blk, m) {
    counts.matches++; justNow.add(m.txid);
    const tx = blk.txs.find((t) => t.txid === m.txid);
    let old = null; try { old = btc.parse(blk.raw.subarray(tx.start, tx.end).toString('hex')); } catch (e) {}
    const good = [];
    for (const h of m.held) {
      const o = tower.open(m.txid, h.blob);
      if (!o.ok) continue;   // a chance match of hints, or an item that is not a penalty for this transaction
      let fee = null;
      try {
        const p = btc.parse(o.tx_hex);
        const inSum = p.inputs.reduce((s, i) => s + (old && old.outputs[i.vout] ? old.outputs[i.vout].value : NaN), 0);
        const outSum = p.outputs.reduce((s, x) => s + x.value, 0);
        if (Number.isFinite(inSum) && inSum >= outSum) fee = inSum - outSum;
      } catch (e) {}
      good.push({ key: h.key, tx_hex: o.tx_hex, penalty_txid: o.penalty_txid, vsize: o.vsize, fee });
    }
    if (!good.length) return;
    good.sort((a, b) => (b.fee === null ? -1 : b.fee) - (a.fee === null ? -1 : a.fee));
    log(`[TOWER] AN OLD STATE WAS PUBLISHED: ${m.txid} in block ${height} — ${good.length} penalty transaction(s) held for it (wallet key ${good[0].key.slice(0, 8)})`);
    let sent = null;
    for (const g of good) {
      const err = await publish(g.tx_hex);
      if (!err) { sent = g; log(`[TOWER] penalty ${g.penalty_txid} published (${g.vsize} vB${g.fee === null ? '' : ', fee ' + g.fee + ' sats'})`); break; }
      log(`[TOWER] penalty ${g.penalty_txid} was refused: ${err}`);
    }
    const rec = { old_txid: m.txid, height, at: now(), wallet_key: good[0].key.slice(0, 8), penalties: good.map((g) => ({ txid: g.penalty_txid, tx_hex: g.tx_hex, fee: g.fee })), first_accepted: sent ? sent.penalty_txid : null };
    try { fs.appendFileSync(pubFile, JSON.stringify(rec) + '\n'); } catch (e) {}
    st.live = st.live.filter((x) => x.old_txid !== m.txid);
    st.live.push({ old_txid: m.txid, height, penalties: good.map((g) => ({ txid: g.penalty_txid, tx_hex: g.tx_hex })) });
    if (sent) counts.published++;
    else log(`[TOWER] NO penalty for ${m.txid} was accepted — it is tried again on every new block for ${AGAIN_BLOCKS} blocks`);
  }
  async function scan(height, hashB64) {
    const blk = await readBlock(height, hashB64);
    counts.blocks++;
    const hits = tower.match(blk.txs.map((t) => t.txid));
    for (const m of hits) await handleMatch(height, blk, m);
    st.recent[String(height)] = hashB64;
    for (const k of Object.keys(st.recent)) if (Number(k) <= height - KEEP) delete st.recent[k];
    if (st.last_height === null || height > st.last_height) st.last_height = height;
  }
  /// One look at the chain. Safe to call on a timer; a second call while one runs does nothing.
  async function poll() {
    if (busy) return { ok: true, busy: true };
    busy = true; justNow = new Set();
    try {
      const best = await lnd.bestBlock();
      if (!best || !Number.isSafeInteger(best.height) || !best.hash) throw new Error('GetBestBlock gave no height and hash');
      if (st.recent[String(best.height)] === best.hash) return { ok: true, height: best.height, new_blocks: 0 };
      let from;
      if (st.last_height === null) from = best.height;   // the first start: nothing was held before now
      else {
        // the heights remembered are looked at again (their hash may have changed); nothing older than them is
        const known = Object.keys(st.recent).map(Number).filter((h) => h <= st.last_height);
        from = known.length ? Math.min.apply(null, known) : st.last_height + 1;
        if (best.height - st.last_height > CEILING) {
          log(`[TOWER] the watch was away for ${best.height - st.last_height} blocks — more than ${CEILING}; blocks ${st.last_height + 1} to ${best.height - CEILING} are NOT read`);
          from = best.height - CEILING + 1;
        }
      }
      let fresh = 0;
      for (let h = from; h <= best.height; h++) {
        const hash = h === best.height ? best.hash : await lnd.blockHash(h);
        if (typeof hash !== 'string' || !hash) throw new Error('GetBlockHash gave no hash for ' + h);
        if (st.recent[String(h)] === hash) continue;
        if (st.recent[String(h)] !== undefined) log(`[TOWER] block ${h} changed (a reorganisation) — read again`);
        await scan(h, hash); fresh++;
      }
      // penalties still inside their day go out again with every new block
      if (fresh) {
        const keep = [];
        for (const x of st.live) {
          if (best.height > x.height + AGAIN_BLOCKS) continue;
          if (justNow.has(x.old_txid)) { keep.push(x); continue; }
          for (const pen of x.penalties) { const err = await publish(pen.tx_hex); if (!err) break; }
          keep.push(x);
        }
        st.live = keep;
      }
      save(); counts.last_scan_ms = now(); counts.last_error = null;
      return { ok: true, height: best.height, new_blocks: fresh };
    } catch (e) {
      counts.last_error = String((e && e.message) || e).slice(0, 200);
      try { save(); } catch (e2) {}
      return { ok: false, why: counts.last_error };
    } finally { busy = false; }
  }
  const summary = () => Object.assign({ last_height: st.last_height, penalties_live: st.live.length }, counts);
  return { probe, poll, summary };
}

module.exports = { createTowerWatch, parseBlock };
