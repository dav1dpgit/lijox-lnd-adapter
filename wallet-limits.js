// 0.96.0 (S58, DP 2026-10-12 20:18 "Go on Proposals 1, 2, and 3" — proposal 1): THE WALLET CHECKS' OWN LIMITS.
// POST /lsps/registry/my-channels (a wallet's start-up check) and POST /lsps/registry/recover-close shared the
// channel-open limit — 3 a window (an hour) per address — so a wallet started a fourth time in an hour got no answer
// from its own provider (DP's journal, 2026-10-12 18:35–18:37: "Rate limit hit … resets in 20 min"), and the page's
// provider check showed "no answer". Each check now has its own limits:
//  - a ceiling per address, checked first, before LND is asked to check the signature (it guards LND's
//    verifymessage); generous, because many phones can share one address (a carrier's NAT);
//  - a limit per node key, counted only once the signature has proven the key, so one wallet never uses up
//    another's, and a stranger cannot use up a wallet's by sending its key with a bad signature.
// The channel-open limit (isRateLimited, 3 an hour) is untouched; nothing else uses these.

'use strict';

// A fixed-window counter per key. hit(key) counts one and answers { ok, reset_s } — reset_s is how long until the
// window that refused it ends (0 when ok). `now` is a clock (tests pass their own).
function windowLimiter(max, windowMs, now = Date.now) {
  const entries = new Map();   // key -> { count, resetAt }
  return {
    hit(key) {
      const t = now();
      let e = entries.get(key);
      if (!e || t >= e.resetAt) { e = { count: 0, resetAt: t + windowMs }; entries.set(key, e); }
      if (e.count >= max) return { ok: false, reset_s: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
      e.count++;
      return { ok: true, reset_s: 0 };
    },
    // drop windows that have ended (the adapter's ten-minute sweep)
    sweep() {
      const t = now();
      for (const [k, e] of entries) if (t >= e.resetAt) entries.delete(k);
    },
    size() { return entries.size; },
  };
}

module.exports = { windowLimiter };
