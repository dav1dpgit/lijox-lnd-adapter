'use strict';
// 0.137.0 (S72 Tue 2026-11-24 — the wallet repo's docs/design/routes/f2-r1.md §6.4): HOW MANY WALLETS STILL USE THE
// OLDER FORMS. Two decisions wait for the same number: refusing wallets that present no pass at the tunnel
// (STATE_PASS_REQUIRED, state-marks.js — its review is due on or after 2027-01-19), and refusing as web requests the
// requests that have moved inside the Lightning connection (lijox-rpc.js). Both ask: "are older wallets still out
// there?" Until 0.137.0 this box wrote nothing down when a wallet came the older way.
//
// What is kept, per day (UTC) and wallet key: tunnel openings with a pass and without one; requests of a moved method
// that came as a web request; the same method inside the connection. COUNTS ONLY — no request contents, no address.
// DATA_DIR/form-counts.json, KEEP_DAYS days. Read by a command on the box: `node lij-adapter.js --form-counts`.
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 40;
const UNKNOWN = 'unknown';   // a tunnel whose wallet key LND did not show in time
const MAX_KEYS_A_DAY = 50000;
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const METHOD_RE = /^[a-z0-9]+\.[a-z0-9_]+$/;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const SAY_EVERY_MS = 3600 * 1000;   // 0.146.0: one journal line an hour for a wallet and a method that came as a web request

function createFormCounts(opts) {
  const o = opts || {};
  const file = path.join(o.dataDir, 'form-counts.json');
  const now = o.now || (() => Date.now());
  const log = o.log || function () {};
  let data = { v: 1, days: {} }, dirty = false;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j === 'object' && j.days && typeof j.days === 'object') data = { v: 1, days: j.days }; } catch (_) {}

  function prune() {
    const floor = dayOf(now() - KEEP_DAYS * 86400000);
    for (const d of Object.keys(data.days)) if (d < floor) { delete data.days[d]; dirty = true; }
  }
  function rec(key) {
    const d = dayOf(now());
    const day = data.days[d] || (data.days[d] = {});
    const k = KEY_RE.test(String(key)) ? String(key) : UNKNOWN;
    if (!day[k]) { if (Object.keys(day).length >= MAX_KEYS_A_DAY) return null; day[k] = { tp: 0, tn: 0, w: {}, r: {} }; }
    return day[k];
  }
  function flush() {
    if (!dirty) return false;
    prune();
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); dirty = false; return true; }
    catch (e) { log('[FormCounts] not written: ' + e.message); return false; }
  }
  // a tunnel whose handshake has passed: with a pass, or without one
  function tunnel(key, withPass) { const r = rec(key); if (!r) return; if (withPass) r.tp++; else r.tn++; dirty = true; }
  // a request of a moved method that came as a web request
  // 0.146.0 (the operator, 2026-11-25: "When not going through lightning I want to know as both the wallet user and the
  // LSP user"): each such request is also SAID in the journal — once an hour for a wallet and a method, not once a request.
  const said = new Map();   // wallet|method → the time of its last journal line
  function web(key, method) {
    if (!METHOD_RE.test(String(method))) return;
    const r = rec(key); if (!r) return;
    r.w[method] = (r.w[method] || 0) + 1; dirty = true;
    const named = KEY_RE.test(String(key)), k = (named ? String(key) : UNKNOWN) + '|' + method, t = now();
    if (t - (said.has(k) ? said.get(k) : -SAY_EVERY_MS) >= SAY_EVERY_MS) {
      if (said.size >= 5000) said.clear();
      said.set(k, t);
      log(`[RPC] NOT INSIDE LIGHTNING: ${method} came as a web request from ${named ? String(key).slice(0, 16) + '…' : 'a wallet the request does not name'} — this request has a form inside the Lightning connection (said once an hour for this wallet and method; the counts: the Console's "Not inside Lightning", or node lij-adapter.js --form-counts)`);
    }
  }
  // the same method inside the Lightning connection
  function rpc(key, method) { if (!METHOD_RE.test(String(method))) return; const r = rec(key); if (!r) return; r.r[method] = (r.r[method] || 0) + 1; dirty = true; }

  // 0.146.0: TODAY, for the Console — the moved requests that came as web requests, how many wallets they name, which
  // methods, and beside them how many requests came inside the connection.
  function today() {
    const d = dayOf(now()), day = data.days[d] || {}, methods = {};
    let webN = 0, inside = 0, wallets = 0;
    for (const [k, v] of Object.entries(day)) {
      const w = Object.values(v.w || {}).reduce((a, b) => a + b, 0);
      inside += Object.values(v.r || {}).reduce((a, b) => a + b, 0);
      if (!w) continue;
      webN += w; if (k !== UNKNOWN) wallets++;
      for (const [m, c] of Object.entries(v.w || {})) methods[m] = (methods[m] || 0) + c;
    }
    return { day: d, web_requests: webN, wallets, inside_requests: inside, methods };
  }

  // The last `days` days, today included. Keys are cut to 16 characters in the report.
  function report(days) {
    const n = Math.max(1, Math.min(KEEP_DAYS, Number(days) || 30));
    const floor = dayOf(now() - (n - 1) * 86400000);
    const per = {};   // key → totals
    let unknownTunnels = 0; const unknownWeb = {};   // 0.138.0: a moved request whose WEB form names no wallet (the route request, the outcome check)
    for (const d of Object.keys(data.days).sort()) {
      if (d < floor) continue;
      for (const [k, v] of Object.entries(data.days[d])) {
        if (k === UNKNOWN) { unknownTunnels += (v.tp || 0) + (v.tn || 0); for (const [m, c] of Object.entries(v.w || {})) unknownWeb[m] = (unknownWeb[m] || 0) + c; continue; }
        const p = per[k] || (per[k] = { tp: 0, tn: 0, w: 0, r: 0, last_no_pass: null, last_web: null, last_seen: null, web_methods: {} });
        p.tp += v.tp || 0; p.tn += v.tn || 0;
        const w = Object.values(v.w || {}).reduce((a, b) => a + b, 0), r = Object.values(v.r || {}).reduce((a, b) => a + b, 0);
        p.w += w; p.r += r;
        for (const [m, c] of Object.entries(v.w || {})) p.web_methods[m] = (p.web_methods[m] || 0) + c;
        if (v.tn) p.last_no_pass = d;
        if (w) p.last_web = d;
        p.last_seen = d;
      }
    }
    const keys = Object.keys(per).sort();
    const short = (k) => k.slice(0, 16);
    return {
      days: n, from: floor, to: dayOf(now()),
      wallets_seen: keys.length,
      wallets_without_a_pass: keys.filter((k) => per[k].tn > 0).map((k) => ({ wallet: short(k), openings_without: per[k].tn, openings_with: per[k].tp, last_day_without: per[k].last_no_pass })),
      wallets_with_web_requests_for_moved_methods: keys.filter((k) => per[k].w > 0).map((k) => ({ wallet: short(k), web_requests: per[k].w, inside_the_connection: per[k].r, last_day_web: per[k].last_web, methods: per[k].web_methods })),
      wallets_only_inside_the_connection: keys.filter((k) => per[k].r > 0 && per[k].w === 0).length,
      tunnels_whose_wallet_was_not_named: unknownTunnels,
      web_requests_that_name_no_wallet: unknownWeb,
    };
  }
  // the report as lines for a terminal
  function reportText(days) {
    const r = report(days), L = [];
    L.push(`Wallets seen, ${r.from} to ${r.to} (${r.days} days): ${r.wallets_seen}`);
    L.push(`Opened a tunnel WITHOUT a pass: ${r.wallets_without_a_pass.length}`);
    for (const w of r.wallets_without_a_pass) L.push(`  ${w.wallet}…  without ${w.openings_without} · with ${w.openings_with} · last without ${w.last_day_without}`);
    L.push(`Sent a moved request as a WEB request: ${r.wallets_with_web_requests_for_moved_methods.length}`);
    for (const w of r.wallets_with_web_requests_for_moved_methods) L.push(`  ${w.wallet}…  web ${w.web_requests} · inside the connection ${w.inside_the_connection} · last web ${w.last_day_web} · ${Object.keys(w.methods).join(', ')}`);
    L.push(`Used only the form inside the connection: ${r.wallets_only_inside_the_connection}`);
    if (r.tunnels_whose_wallet_was_not_named) L.push(`Tunnels whose wallet LND did not name in time: ${r.tunnels_whose_wallet_was_not_named}`);
    const uw = Object.entries(r.web_requests_that_name_no_wallet || {});
    if (uw.length) L.push(`Moved requests that came as WEB requests and name no wallet: ${uw.map(([m, c]) => m + ' ' + c).join(' · ')}`);
    return L.join('\n');
  }

  const timer = setInterval(() => { try { flush(); } catch (_) {} }, 60000);
  if (timer.unref) timer.unref();
  return { tunnel, web, rpc, today, report, reportText, flush, stop: () => { clearInterval(timer); flush(); }, _data: () => data };
}

module.exports = { createFormCounts, KEEP_DAYS, UNKNOWN };
