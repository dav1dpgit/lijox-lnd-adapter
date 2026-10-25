'use strict';
// jit-guard.js — 0.104.0 (S59, DP 2026-10-14, his UX list item 8; "this will have to be in place until we get to
// wallet-trusts-LSP"): THE JIT GUARD. Today a JIT open publishes the channel's funding BEFORE the wallet has claimed
// the payment; when the forwarded payment then fails, the provider is left with a funded channel it paid for and
// collected nothing on (the Oct 6 channel: 02:16 the open, the wallet refused its own payment, 519 sats of fees, no
// open fee). Nothing in the adapter had linked an open to its payment's outcome — this module does, and counts the
// "funded but failed" opens on a rolling 24-hour window.
//
// 0.111.0 (S63, DP 2026-10-24 — the external review's F2: one wallet could trip the halt alone, for free, as often as
// it liked): TWO COUNTS, not one.
//   THE HALT counts DISTINCT WALLETS whose JIT open failed in the window — DP's failsafe is built for a griefer who
//   fails once per wallet and makes a million wallets, so wallet number three still halts JIT for everyone, as before:
//     1 wallet in 24 h → a red line on the Console's Guardrails;
//     2 wallets        → red, "JIT shutdown ARMED";
//     3 wallets        → JIT opens are REFUSED (every rail) until the operator releases the guard from the Console —
//                        the halt survives a restart (DATA_DIR/jit-guard.json). After a release the clock restarts.
//   THE WALLET BLOCK counts one wallet's own failures: at JIT_GUARD_WALLET_AT (default 2) THAT wallet gets no more JIT
//   opens — only that wallet; its repeat failures count as ONE wallet toward the halt, so a single wallet can no longer
//   switch JIT off for everyone. The block expires on its own 24 h after the wallet's last failure, or when the operator
//   releases that wallet from the Console. Not on the first failure: S46's Register-QR incident was a wallet refusing
//   payments because its block height lagged — a transient fault a one-strike rule would have locked out.
// The thresholds are settings (JIT_GUARD_ARM_AT, JIT_GUARD_HALT_AT, JIT_GUARD_WALLET_AT; 0 disables that step).
// Records are kept 14 days.
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 24 * 3600 * 1000;

function createJitGuard(deps) {
  const { dataDir = null, log = () => {}, now = () => Date.now(), armAt = 2, haltAt = 3, walletAt = 2, keepDays = 14 } = deps || {};
  const FILE = dataDir ? path.join(dataDir, 'jit-guard.json') : null;
  let st = { opens: [], halted: null, released: [], wallet_released: {} };
  load();

  function load() {
    if (!FILE) return;
    try {
      if (!fs.existsSync(FILE)) return;
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      st = { opens: Array.isArray(j.opens) ? j.opens : [], halted: j.halted || null, released: Array.isArray(j.released) ? j.released : [],
             wallet_released: (j.wallet_released && typeof j.wallet_released === 'object') ? j.wallet_released : {} };
    } catch (e) { log(`[JIT-GUARD] state unreadable (${e.message}) — starting with an empty record`); }
  }
  function persist() {
    if (!FILE) return;
    try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, FILE); }
    catch (e) { log(`[JIT-GUARD] state write failed: ${e.message}`); }
  }
  function prune() {
    const cut = now() - keepDays * 86400000;
    st.opens = st.opens.filter((o) => o.ts >= cut);
    for (const [w, at] of Object.entries(st.wallet_released)) if (Number(at) < cut) delete st.wallet_released[w];
  }
  function find(cp) { return st.opens.find((o) => o.cp === cp && o.outcome === 'open') || null; }
  function lastRelease() { return st.released.length ? Number(st.released[st.released.length - 1].at) : 0; }
  // the key a failure is counted under: the wallet's node pubkey; an open whose wallet is unknown counts on its own
  const keyOf = (o) => (o.wallet ? String(o.wallet).toLowerCase() : 'cp:' + o.cp);
  const walletKey = (w) => String(w || '').toLowerCase();

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
    const mine = walletFailures(keyOf(o));
    if (walletAt > 0 && mine.length === walletAt) {
      log(`[JIT-GUARD] wallet ${keyOf(o).slice(0, 16)}… BLOCKED from JIT opens — ${mine.length} funded-but-failed opens in 24 h (the last ${cp}, ${o.code || 'no code'}); it clears 24 h after the last failure, or from the Console`);
    }
    if (haltAt > 0 && c.failed_wallets_24h >= haltAt && !st.halted) {
      st.halted = { at: now(), count: c.failed_24h, wallets: c.failed_wallets_24h, last_cp: cp };
      log(`[JIT-GUARD] JIT OFF — ${c.failed_wallets_24h} wallets with a funded-but-failed JIT open in 24 h (${c.failed_24h} opens; the last ${cp}, ${o.code || 'no code'}); every JIT open is refused until released from the Console`);
    } else {
      log(`[JIT-GUARD] a funded-but-failed JIT open: ${cp} (${o.code || 'no code'}) — ${c.failed_wallets_24h} wallet${c.failed_wallets_24h === 1 ? '' : 's'}, ${c.failed_24h} open${c.failed_24h === 1 ? '' : 's'} in 24 h${c.armed ? ' — JIT shutdown ARMED (one more wallet and JIT is off)' : ''}`);
    }
    persist();
    return counts();
  }
  /// One wallet's failed opens in the window, after that wallet's own last release.
  function walletFailures(key) {
    const t = now(), cut = t - WINDOW_MS, since = Math.max(cut, Number(st.wallet_released[key] || 0));
    return st.opens.filter((o) => o.outcome === 'failed' && keyOf(o) === key && Number(o.at || o.ts) > since);
  }
  /// Is this wallet blocked from JIT opens right now?
  function walletBlocked(wallet) {
    if (!(walletAt > 0)) return false;
    const key = walletKey(wallet);
    if (!key) return false;
    return walletFailures(key).length >= walletAt;
  }
  /// The blocked wallets, for the Console.
  function blockedWallets() {
    const keys = new Set(st.opens.filter((o) => o.outcome === 'failed').map(keyOf));
    const out = [];
    for (const key of keys) {
      const f = walletFailures(key);
      if (!(walletAt > 0) || f.length < walletAt) continue;
      const last = f[f.length - 1];
      out.push({ wallet: key, failures: f.length, last_at: Number(last.at || last.ts), last_code: last.code || '', last_cp: last.cp, expires_at: Number(last.at || last.ts) + WINDOW_MS });
    }
    out.sort((a, b) => b.last_at - a.last_at);
    return out;
  }
  /// The window's figures for the Console and /health.
  function counts() {
    const t = now(), cut = t - WINDOW_MS, since = Math.max(cut, lastRelease());
    const w = st.opens.filter((o) => o.ts >= cut);
    const failed = w.filter((o) => o.outcome === 'failed' && Number(o.at || o.ts) > since);
    const n = failed.length;
    const nw = new Set(failed.map(keyOf)).size;
    const halted = st.halted || null;
    const level = halted ? 3 : haltAt > 0 && nw >= haltAt ? 3 : armAt > 0 && nw >= armAt ? 2 : nw >= 1 ? 1 : 0;
    return {
      window_h: 24, failed_24h: n, failed_wallets_24h: nw, settled_24h: w.filter((o) => o.outcome === 'settled').length, open_24h: w.filter((o) => o.outcome === 'open').length,
      level, armed: !halted && armAt > 0 && nw >= armAt, halted,
      last_failed: failed.length ? { at: failed[failed.length - 1].at, cp: failed[failed.length - 1].cp, code: failed[failed.length - 1].code || '', wallet: failed[failed.length - 1].wallet, sats: failed[failed.length - 1].sats } : null,
      arm_at: armAt, halt_at: haltAt, wallet_at: walletAt, last_release: lastRelease() || null, released_count: st.released.length,
      blocked_wallets: blockedWallets(),
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
    log(`[JIT-GUARD] RELEASED by ${by || '?'} — JIT opens again (the halt of ${new Date(was.at).toISOString()} after ${was.wallets || was.count} wallets' failed opens); the count starts afresh`);
    return { ok: true, counts: counts() };
  }
  /// The operator's hand on one wallet: its block clears; only failures after this count against it again.
  function releaseWallet(wallet, by) {
    const key = walletKey(wallet);
    if (!/^(0[23][0-9a-f]{64}|cp:.+)$/.test(key)) return { ok: false, error: 'wallet must be a node pubkey' };
    if (!walletBlocked(key)) return { ok: false, error: 'that wallet is not blocked' };
    st.wallet_released[key] = now();
    persist();
    log(`[JIT-GUARD] wallet ${key.slice(0, 16)}… RELEASED by ${by || '?'} — JIT opens for it again; its count starts afresh`);
    return { ok: true, counts: counts() };
  }

  return { recordOpen, settle, fail, counts, halted, release, walletBlocked, blockedWallets, releaseWallet, _state: () => st };
}

module.exports = { createJitGuard, WINDOW_MS };
