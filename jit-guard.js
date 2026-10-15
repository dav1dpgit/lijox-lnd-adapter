'use strict';
// jit-guard.js — 0.104.0 (S59, DP 2026-10-14, his UX list item 8; "this will have to be in place until we get to
// wallet-trusts-LSP"): THE JIT GUARD. Today a JIT open publishes the channel's funding BEFORE the wallet has claimed
// the payment; when the forwarded payment then fails, the provider is left with a funded channel it paid for and
// collected nothing on (the Oct 6 channel: 02:16 the open, the wallet refused its own payment, 519 sats of fees, no
// open fee). Nothing in the adapter had linked an open to its payment's outcome — this module does, and counts the
// "funded but failed" opens on a rolling 24-hour window:
//   1 in 24 h → a red line on the Console's Guardrails;
//   2 in 24 h → red, "JIT shutdown ARMED";
//   3 in 24 h → JIT opens are REFUSED (every rail: the LSPS2 hold path, the LNURL/Push/chit opener) until the operator
//               releases the guard from the Console — the halt survives a restart (DATA_DIR/jit-guard.json).
// After a release the clock restarts: only failures after it count toward a new halt.
// The thresholds are settings (JIT_GUARD_ARM_AT, JIT_GUARD_HALT_AT; 0 disables that step). Records are kept 14 days.
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 24 * 3600 * 1000;

function createJitGuard(deps) {
  const { dataDir = null, log = () => {}, now = () => Date.now(), armAt = 2, haltAt = 3, keepDays = 14 } = deps || {};
  const FILE = dataDir ? path.join(dataDir, 'jit-guard.json') : null;
  let st = { opens: [], halted: null, released: [] };
  load();

  function load() {
    if (!FILE) return;
    try {
      if (!fs.existsSync(FILE)) return;
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      st = { opens: Array.isArray(j.opens) ? j.opens : [], halted: j.halted || null, released: Array.isArray(j.released) ? j.released : [] };
    } catch (e) { log(`[JIT-GUARD] state unreadable (${e.message}) — starting with an empty record`); }
  }
  function persist() {
    if (!FILE) return;
    try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, FILE); }
    catch (e) { log(`[JIT-GUARD] state write failed: ${e.message}`); }
  }
  function prune() { const cut = now() - keepDays * 86400000; st.opens = st.opens.filter((o) => o.ts >= cut); }
  function find(cp) { return st.opens.find((o) => o.cp === cp && o.outcome === 'open') || null; }
  function lastRelease() { return st.released.length ? Number(st.released[st.released.length - 1].at) : 0; }

  /// A JIT channel's funding is published: remember it until its payment's outcome is known.
  function recordOpen(channelPoint, wallet, amountSats, rail) {
    const cp = String(channelPoint || '');
    if (!cp) return;
    st.opens.push({ ts: now(), cp, wallet: String(wallet || '').slice(0, 66), sats: Number(amountSats) || 0, rail: String(rail || ''), outcome: 'open' });
    prune(); persist();
  }
  /// The forwarded payment settled: the open earned its fee.
  function settle(channelPoint) {
    const o = find(String(channelPoint || '')); if (!o) return;
    o.outcome = 'settled'; o.at = now(); persist();
  }
  /// The forwarded payment FAILED after the funding was published: counted; the guard's level moves.
  function fail(channelPoint, code) {
    const cp = String(channelPoint || '');
    const o = find(cp); if (!o) return null;
    o.outcome = 'failed'; o.code = String(code || '').slice(0, 60); o.at = now();
    const c = counts();
    if (haltAt > 0 && c.failed_24h >= haltAt && !st.halted) {
      st.halted = { at: now(), count: c.failed_24h, last_cp: cp };
      log(`[JIT-GUARD] JIT OFF — ${c.failed_24h} funded-but-failed JIT opens in 24 h (the last ${cp}, ${o.code || 'no code'}); every JIT open is refused until released from the Console`);
    } else {
      log(`[JIT-GUARD] a funded-but-failed JIT open: ${cp} (${o.code || 'no code'}) — ${c.failed_24h} in 24 h${c.armed ? ' — JIT shutdown ARMED (one more and JIT is off)' : ''}`);
    }
    persist();
    return counts();
  }
  /// The window's figures for the Console and /health.
  function counts() {
    const t = now(), cut = t - WINDOW_MS, since = Math.max(cut, lastRelease());
    const w = st.opens.filter((o) => o.ts >= cut);
    const failed = w.filter((o) => o.outcome === 'failed' && Number(o.at || o.ts) > since);
    const n = failed.length;
    const halted = st.halted || null;
    const level = halted ? 3 : haltAt > 0 && n >= haltAt ? 3 : armAt > 0 && n >= armAt ? 2 : n >= 1 ? 1 : 0;
    return {
      window_h: 24, failed_24h: n, settled_24h: w.filter((o) => o.outcome === 'settled').length, open_24h: w.filter((o) => o.outcome === 'open').length,
      level, armed: !halted && armAt > 0 && n >= armAt, halted,
      last_failed: failed.length ? { at: failed[failed.length - 1].at, cp: failed[failed.length - 1].cp, code: failed[failed.length - 1].code || '', wallet: failed[failed.length - 1].wallet, sats: failed[failed.length - 1].sats } : null,
      arm_at: armAt, halt_at: haltAt, last_release: lastRelease() || null, released_count: st.released.length,
    };
  }
  function halted() { return !!st.halted; }
  /// The operator's hand: JIT opens again; the clock restarts.
  function release(by) {
    if (!st.halted) return { ok: false, error: 'JIT is not halted' };
    const was = st.halted;
    st.released.push({ at: now(), by: String(by || '').slice(0, 80), was });
    if (st.released.length > 50) st.released.splice(0, st.released.length - 50);
    st.halted = null;
    persist();
    log(`[JIT-GUARD] RELEASED by ${by || '?'} — JIT opens again (the halt of ${new Date(was.at).toISOString()} after ${was.count} failed opens); the count starts afresh`);
    return { ok: true, counts: counts() };
  }

  return { recordOpen, settle, fail, counts, halted, release, _state: () => st };
}

module.exports = { createJitGuard, WINDOW_MS };
