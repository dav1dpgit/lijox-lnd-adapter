'use strict';
// pl.js — PL for the operator console (0.72.0, S45 #10). "PL", never the other spelling.
//
// LINES (DP ruled 2026-09-08):
//   revenue = routing fees earned + JIT channel-open fees collected + hold/LNURL fees
//   costs   = chain fees on opens / closes / sweeps / other + fees on our own payments
//   net     = revenue − costs. Sats, with a fiat column from the adapter's rates cache.
//
// SOURCES, each read-only:
//   - routing fees: LND ForwardingHistory (needs lnrpc.Lightning/ForwardingHistory)
//   - open / hold fees: the adapter's own append-only ledger, DATA_DIR/pl-events.ndjson,
//     written at the moment a fee is actually kept (the LNURL settle and the JIT
//     interceptor settle) — nothing in LND records what an LSP charged
//   - chain fees: LND GetTransactions (our own spends' total_fees), classified as
//     open (txid is a channel point), close (a closed channel's closing tx —
//     ClosedChannels, optional), sweep (LND's sweep label) or other
//   - payment fees: LND ListPayments (every payment this node sent; the LNURL
//     deliveries to wallets we serve carry fee 0 on the direct channel)
//
// SNAPSHOTS: DATA_DIR/pl-daily.json holds one finished row per past day; only
// today is recomputed on each request, so LTD never rescans history. Rows carry
// per-channel routing attribution (chan_id → fee, count) for the phase-2 screen.
// Day boundaries are the box's local time.

const fs = require('fs');
const path = require('path');

function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayStartMs(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function nextDay(key) { return dayKey(dayStartMs(key) + 36 * 3600 * 1000); }
function emptyRow(key) {
  return { date: key, routing_fee_msat: 0, routing_count: 0, routing_by_chan: {}, open_fee_msat: 0, open_count: 0, hold_fee_msat: 0, hold_count: 0,
    chain_fee_open_sats: 0, chain_fee_close_sats: 0, chain_fee_sweep_sats: 0, chain_fee_other_sats: 0, chain_tx_count: 0,
    payment_fee_msat: 0, payment_count: 0, delivery_count: 0, computed_at: 0, partial: [] };
}

function createPL(deps) {
  // deps: { dataDir, lndGet, lndPost, log, isWalletPubkey(pk)->bool, channelPoints()->Set(txid), rates()->{USD:n}|null }
  const eventsPath = path.join(deps.dataDir, 'pl-events.ndjson');
  const dailyPath = path.join(deps.dataDir, 'pl-daily.json');
  const log = deps.log || (() => {});
  let daily = {};
  try { daily = JSON.parse(fs.readFileSync(dailyPath, 'utf8')); } catch (_) { daily = {}; }
  let bulk = null; // { at, fwd, payments, txs, closes, missing: [] } — one pull per 60 s

  // ── the fee ledger: one line per fee actually kept ─────────────────────────
  function record(kind, fields) {
    try { fs.appendFileSync(eventsPath, JSON.stringify(Object.assign({ ts: Date.now(), kind }, fields)) + '\n'); } catch (e) { log('[PL] ledger append failed: ' + e.message); }
  }
  function readEvents() {
    const out = [];
    try { for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (_) {} } } catch (_) {}
    return out;
  }

  // ── bulk reads from LND (cached 60 s) ───────────────────────────────────────
  async function pullBulk() {
    if (bulk && Date.now() - bulk.at < 60000) return bulk;
    const missing = [];
    // forwarding history: paged, all time
    const fwd = [];
    try {
      let offset = 0;
      for (let i = 0; i < 200; i++) {
        const r = await deps.lndPost('/v1/switch', { start_time: '0', end_time: String(Math.floor(Date.now() / 1000) + 3600), index_offset: offset, num_max_events: 50000 });
        if (!r || !Array.isArray(r.forwarding_events)) { if (r && r.message) throw new Error(r.message); break; }
        fwd.push(...r.forwarding_events);
        const next = Number(r.last_offset_index || 0);
        if (r.forwarding_events.length < 50000 || next <= offset) break;
        offset = next;
      }
    } catch (e) { missing.push('routing fees: ' + shortErr(e, 'ForwardingHistory')); }
    const payments = [];
    try {
      let offset = 0;
      for (let i = 0; i < 200; i++) {
        const r = await deps.lndGet(`/v1/payments?include_incomplete=false&max_payments=5000&index_offset=${offset}`);
        if (!r || !Array.isArray(r.payments)) { if (r && r.message) throw new Error(r.message); break; }
        payments.push(...r.payments);
        const next = Number(r.last_index_offset || 0);
        if (r.payments.length < 5000 || next <= offset) break;
        offset = next;
      }
    } catch (e) { missing.push('payment fees: ' + shortErr(e, 'ListPayments')); }
    let txs = [];
    try {
      const r = await deps.lndGet('/v1/transactions');
      if (r && Array.isArray(r.transactions)) txs = r.transactions; else if (r && r.message) throw new Error(r.message);
    } catch (e) { missing.push('chain fees: ' + shortErr(e, 'GetTransactions')); }
    let closes = new Set();
    try {
      const r = await deps.lndGet('/v1/channels/closed');
      if (r && Array.isArray(r.channels)) closes = new Set(r.channels.map((c) => c.closing_tx_hash).filter(Boolean));
      else if (r && r.message) throw new Error(r.message);
    } catch (e) { missing.push('close classification: ' + shortErr(e, 'ClosedChannels') + ' (closes counted under other)'); }
    bulk = { at: Date.now(), fwd, payments, txs, closes, missing };
    return bulk;
  }
  function shortErr(e, uri) {
    const m = String(e && e.message || e);
    return /permission|macaroon|unauthorized|401|403/i.test(m) ? `needs lnrpc.Lightning/${uri} in the macaroon` : m.slice(0, 80);
  }

  // ── one day, from the bulk data ─────────────────────────────────────────────
  function computeRow(key, b, events, chanPoints) {
    const row = emptyRow(key);
    const start = dayStartMs(key), end = dayStartMs(nextDay(key));
    for (const ev of b.fwd) {
      const t = Number(ev.timestamp_ns ? ev.timestamp_ns / 1e6 : Number(ev.timestamp) * 1000);
      if (t < start || t >= end) continue;
      const fee = Number(ev.fee_msat || 0);
      row.routing_fee_msat += fee; row.routing_count++;
      const k = String(ev.chan_id_out || ''); const c = row.routing_by_chan[k] || (row.routing_by_chan[k] = { fee_msat: 0, count: 0, in: String(ev.chan_id_in || '') });
      c.fee_msat += fee; c.count++;
    }
    for (const e of events) {
      if (e.ts < start || e.ts >= end) continue;
      if (e.kind === 'open_fee') { row.open_fee_msat += Number(e.msat || 0); row.open_count++; }
      else if (e.kind === 'hold_fee') { row.hold_fee_msat += Number(e.msat || 0); row.hold_count++; }
    }
    for (const p of b.payments) {
      const t = Number(p.creation_time_ns ? p.creation_time_ns / 1e6 : Number(p.creation_date) * 1000);
      if (t < start || t >= end) continue;
      if (p.status && p.status !== 'SUCCEEDED') continue;
      const dest = (p.htlcs && p.htlcs[0] && p.htlcs[0].route && p.htlcs[0].route.hops && p.htlcs[0].route.hops.slice(-1)[0] || {}).pub_key || '';
      const delivery = dest && deps.isWalletPubkey && deps.isWalletPubkey(dest);
      row.payment_fee_msat += Number(p.fee_msat || 0); row.payment_count++; if (delivery) row.delivery_count++;
    }
    for (const t of b.txs) {
      const ms = Number(t.time_stamp) * 1000;
      if (ms < start || ms >= end) continue;
      const fee = Number(t.total_fees || 0);
      if (fee <= 0) continue;                               // only fees WE paid
      row.chain_tx_count++;
      const txid = t.tx_hash, label = String(t.label || '').toLowerCase();
      if (chanPoints.has(txid) || /openchannel|funding/.test(label)) row.chain_fee_open_sats += fee;
      else if (b.closes.has(txid) || /closechannel|closing/.test(label)) row.chain_fee_close_sats += fee;
      else if (/sweep/.test(label)) row.chain_fee_sweep_sats += fee;
      else row.chain_fee_other_sats += fee;
    }
    row.partial = b.missing.slice();
    row.computed_at = Date.now();
    return row;
  }

  function firstDayKey(b, events) {
    let first = Date.now();
    for (const ev of b.fwd) { const t = Number(ev.timestamp_ns ? ev.timestamp_ns / 1e6 : Number(ev.timestamp) * 1000); if (t > 0 && t < first) first = t; }
    for (const p of b.payments) { const t = Number(p.creation_time_ns ? p.creation_time_ns / 1e6 : Number(p.creation_date) * 1000); if (t > 0 && t < first) first = t; }
    for (const t of b.txs) { const ms = Number(t.time_stamp) * 1000; if (ms > 0 && ms < first) first = ms; }
    for (const e of events) if (e.ts > 0 && e.ts < first) first = e.ts;
    let key = dayKey(first);
    for (const k of Object.keys(daily)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && k < key) key = k;   // rows already on disk count
    return key;
  }

  // ── the report for a date: day / MTD / YTD / LTD ────────────────────────────
  async function report(dateKey, opts) {
    opts = opts || {};
    const b = await pullBulk();
    const events = readEvents();
    const chanPoints = (deps.channelPoints && deps.channelPoints()) || new Set();
    const today = dayKey(Date.now());
    const sel = /^\d{4}-\d{2}-\d{2}$/.test(dateKey || '') ? dateKey : today;
    const first = firstDayKey(b, events);
    // fill every finished day up to sel that has no row yet (or all, when recomputing)
    let changed = false;
    for (let k = first; k <= sel; k = nextDay(k)) {
      const finished = k < today;
      if (!finished || opts.recompute || !daily[k] || (daily[k].partial && daily[k].partial.length && b.missing.length === 0)) {
        const row = computeRow(k, b, events, chanPoints);
        if (finished) { daily[k] = row; changed = true; }
        else daily[k] = row;
      }
      if (k === today) break;
    }
    if (changed) { try { fs.writeFileSync(dailyPath, JSON.stringify(daily)); } catch (e) { log('[PL] snapshot write failed: ' + e.message); } }

    const sum = (from, to) => {
      const acc = emptyRow(from); acc.date = from + '…' + to; const byChan = {};
      for (let k = from; k <= to; k = nextDay(k)) {
        const r = daily[k]; if (!r) { if (k === to) break; continue; }
        for (const f of ['routing_fee_msat', 'routing_count', 'open_fee_msat', 'open_count', 'hold_fee_msat', 'hold_count', 'chain_fee_open_sats', 'chain_fee_close_sats', 'chain_fee_sweep_sats', 'chain_fee_other_sats', 'chain_tx_count', 'payment_fee_msat', 'payment_count', 'delivery_count']) acc[f] += r[f] || 0;
        for (const [c, v] of Object.entries(r.routing_by_chan || {})) { const x = byChan[c] || (byChan[c] = { fee_msat: 0, count: 0 }); x.fee_msat += v.fee_msat; x.count += v.count; }
        if (k === to) break;
      }
      acc.routing_by_chan = byChan; return acc;
    };
    const monthStart = sel.slice(0, 8) + '01', yearStart = sel.slice(0, 5) + '01-01';
    const periods = { day: sum(sel, sel), mtd: sum(monthStart < first ? first : monthStart, sel), ytd: sum(yearStart < first ? first : yearStart, sel), ltd: sum(first, sel) };
    const rates = (deps.rates && deps.rates()) || null;
    return { date: sel, today, first_day: first, missing: b.missing, rates_usd: rates && rates.USD ? rates.USD : null, periods };
  }

  return { record, report, dayKey };
}

module.exports = { createPL, dayKey };
