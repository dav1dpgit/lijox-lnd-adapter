// lij-sm.js — LSPS2 Payment State Machine · PHASE 0.5 (SHADOW)
// 0.140.0 (S72, the operator's word of 2026-11-25 00:19 "Proceed with in flight repairs"): THE LIST LEARNS OF EVERY ANSWER
// THE ADAPTER WRITES TO LND. Until now a payment the adapter handed straight back to LND (RESUME) stayed INTERCEPTED
// until the once-a-minute count found it older than 90 s — so every forwarded payment was printed as "in flight" once
// or twice after it was over (field, 2026-11-24: "INTERCEPTED@62s" a minute after LND had settled it), and /v1/outcome
// answered "pending" for it in that time. The interceptor wrapper already tells its caller of every answer it writes
// (lnd-grpc.js noteAnswer → onResolve); the adapter passes that on as the event `answered` { ck, action }. An entry all
// of whose parts were handed back ends at once as PASSTHROUGH; one whose parts were all failed back ends as FAILED;
// a promise or a hold is ended by its own events, as before. `hold_refused` (reported from five places since 0.119.x,
// never handled here — each wrote "[SM-NOTE] unknown event") now carries the refusal's reason to that end. A new HTLC
// for a hash whose entry ended as PASSTHROUGH or RESUMED starts a new entry (a sender's further try), where it used to
// be an event on a finished one. The 90-s rule stays as the backstop.
// ─────────────────────────────────────────────────────────────────────────
// Design: docs/design-lsps2-state-machine.md (repo). This module OBSERVES
// events emitted from taps in lij-adapter.js and derives one intent per
// payment_hash. It writes NOTHING — no LND calls, no interceptor writes,
// no shared tables. Its only output is journal lines:
//   [SM-TRANS]      legal transition applied
//   [SM-VIOLATION]  an invariant the live code just broke (the worklist)
//   [SM-NOTE]       observation the shadow can't yet classify
//   [SM-STATE]      periodic one-line census of non-terminal intents
// Phase 0 tap coverage is deliberately partial (no trampoline-settle tap,
// no aggregate-fail tap yet); absence of events degrades to NOTEs, never
// to false VIOLATIONs.

'use strict';

const TERMINAL = new Set(['SETTLED', 'FAILED', 'EXPIRED', 'ABANDONED', 'PASSTHROUGH', 'RESUMED']);

const LEGAL = {
  INTERCEPTED: ['AGGREGATING', 'GATED', 'HOLDING', 'OPENING', 'FORWARDING', 'FAILING', 'PASSTHROUGH'],
  AGGREGATING: ['GATED', 'HOLDING', 'OPENING', 'FORWARDING', 'FAILING', 'PASSTHROUGH'],
  GATED:       ['HOLDING', 'OPENING', 'FORWARDING', 'FAILING'],
  HOLDING:     ['GATED', 'OPENING', 'FORWARDING', 'FAILING', 'RESUMED'],
  OPENING:     ['FORWARDING', 'HOLDING', 'FAILING'],
  FORWARDING:  ['SETTLING', 'HOLDING', 'FAILING'],
  SETTLING:    ['SETTLED'],
  FAILING:     ['FAILED', 'EXPIRED'],
};

const intents = new Map();        // hash -> intent
const secretByHash = new Map();   // hash -> ts
const secretByScid = new Map();   // scid -> ts
const hashByCk = new Map();       // 0.140.0: "chan_id:htlc_id" -> hash, so an answer written to LND finds its entry
const CK_KEEP = 20000;

function short(h) { return h ? String(h).slice(0, 16) : '????'; }
function log(tag, msg) { console.log(`[SM-${tag}] ${msg}`); }

function getIntent(hash) {
  if (!hash) return null;
  let it = intents.get(hash);
  if (!it) {
    it = {
      hash,
      state: 'INTERCEPTED',
      entered_at: Date.now(),
      shards: new Map(),          // circuit-key -> msat (string)
      shard_sum_msat: 0n,
      total_msat_expected: null,  // learned at open_started when available
      scid: null,
      hold: null,                 // { cap_ms, created_at, watchdog_at? }
      history: [],
    };
    intents.set(hash, it);
    log('TRANS', `${short(hash)} · (new) → INTERCEPTED`);
  }
  return it;
}

function transition(it, to, why) {
  if (it.state === to) return;
  const legal = (LEGAL[it.state] || []).includes(to);
  if (!legal && !TERMINAL.has(it.state)) {
    log('VIOLATION', `${short(it.hash)} · illegal ${it.state} → ${to} (${why})`);
    // Shadow follows reality anyway — we track what IS, and flag it.
  }
  if (TERMINAL.has(it.state)) {
    // I5: activity on a terminal intent.
    log('VIOLATION', `${short(it.hash)} · I5: event "${why}" on terminal ${it.state}`);
    return;
  }
  it.history.push([it.state, to, why, Date.now()]);
  if (it.history.length > 40) it.history.shift();
  it.state = to;
  it.entered_at = Date.now();
  log('TRANS', `${short(it.hash)} · → ${to} (${why})`);
}

function secretKnown(it) {
  if (secretByHash.has(it.hash)) return true;
  if (it.scid && secretByScid.has(String(it.scid))) return true;
  return false;
}

const handlers = {
  htlc_intercepted(p) {
    // 0.140.0: an entry that ended because LND was handed the payment is over; a part LND shows now on a circuit this
    // entry never saw is a new try of the same hash and gets an entry of its own
    const was = p.hash ? intents.get(p.hash) : null;
    if (was && (was.state === 'PASSTHROUGH' || was.state === 'RESUMED') && p.ck && !was.shards.has(String(p.ck))) intents.delete(p.hash);
    const it = getIntent(p.hash);
    if (!it) return;
    if (p.ck) {
      hashByCk.set(String(p.ck), p.hash);
      if (hashByCk.size > CK_KEEP) { let n = hashByCk.size - CK_KEEP; for (const k of hashByCk.keys()) { if (n-- <= 0) break; hashByCk.delete(k); } }
    }
    if (p.scid && !it.scid) it.scid = String(p.scid);
    if (p.ck && !it.shards.has(p.ck)) {
      it.shards.set(p.ck, String(p.in_msat || '0'));
      try { it.shard_sum_msat += BigInt(p.in_msat || 0); } catch (_) {}
    }
    if (it.shards.size > 1 && it.state === 'INTERCEPTED') {
      transition(it, 'AGGREGATING', 'second shard');
    }
  },

  shard_registered(p) {
    const it = getIntent(p.hash);
    if (!it) return;
    it.promiseBound = true;  // 0.3: promise-bound intents never age out
    if (it.state === 'INTERCEPTED') transition(it, 'AGGREGATING', 'shard registered');
  },

  // 0.3: the adapter's aggregation window closed short — every registered
  // shard was failed back. Honest terminal instead of aging heuristics.
  agg_window_short(p) {
    const it = p.hash ? intents.get(p.hash) : null;
    if (!it) { log('NOTE', 'window closed short for an unbound/unknown intent'); return; }
    transition(it, 'FAILING', 'aggregation window closed short');
    transition(it, 'FAILED', 'all shards failed back');
  },

  // v0.25.0 (S30): the variable quiescence flush failed the whole set
  // (sub-floor, offline-with-no-hold, or open failure) — honest terminal,
  // mirrors agg_window_short. Closes the AGGREGATING leak (specimens
  // 5050249d/5a996bd3).
  var_flush_failed(p) {
    const it = p.hash ? intents.get(p.hash) : null;
    if (!it) { log('NOTE', 'variable flush failed for an unbound/unknown intent'); return; }
    transition(it, 'FAILING', `variable flush failed: ${p.why || '?'}`);
    transition(it, 'FAILED', 'all parts failed back');
  },

  // 0.140.0: the adapter refused a part at the door (it arrived short, or over the promise) and fails it back — the
  // reason is kept for the entry's end, which `answered` writes when every part has its answer
  hold_refused(p) {
    const it = p.hash ? intents.get(p.hash) : null;
    if (it && !TERMINAL.has(it.state)) it.refused = String(p.why || 'refused').slice(0, 80);
  },

  // 0.140.0: one answer the adapter wrote to LND for one part — RESUME, FAIL or SETTLE (from the interceptor wrapper's
  // own hook, so every way an answer is written passes here: the handler's return and the later writes alike).
  answered(p) {
    const ck = p.ck ? String(p.ck) : '';
    const hash = ck ? hashByCk.get(ck) : null;
    if (!hash) return;
    const it = intents.get(hash);
    if (!it || TERMINAL.has(it.state)) return;
    if (!it.answers) it.answers = new Map();
    it.answers.set(ck, String(p.action || ''));
    for (const k of it.shards.keys()) if (!it.answers.has(k)) return;        // a part is still with the adapter
    const acts = Array.from(it.answers.values());
    if (acts.includes('SETTLE')) return;                                      // settled parts: the settle events end it
    const allFail = acts.every((a) => a === 'FAIL');
    if (it.refused && allFail) {
      transition(it, 'FAILING', 'refused at the door: ' + it.refused);
      transition(it, 'FAILED', 'every part failed back');
      return;
    }
    if (it.promiseBound || it.hold) return;                                   // a promise or a hold: its own events end it
    if (it.state !== 'INTERCEPTED' && it.state !== 'AGGREGATING') return;
    if (allFail) { transition(it, 'FAILING', 'failed back by the adapter'); transition(it, 'FAILED', 'every part failed back'); }
    else transition(it, 'PASSTHROUGH', 'handed back to LND');
  },

  secret_registered(p) {
    const ts = Date.now();
    if (p.hash) secretByHash.set(p.hash, ts);
    if (p.scid) secretByScid.set(String(p.scid), ts);
  },

  hold_created(p) {
    const it = getIntent(p.hash);
    if (!it) return;
    it.promiseBound = true;  // 0.3
    // 0.4 (B-18 semantics): ONE watchdog per hold RECORD, not per shard.
    // Subsequent hold events for the same hash are sibling shards joining
    // the record — they must not reset the watchdog nor arm a new pairing
    // check (the old per-shard reset produced false I2s on M3a2's pass).
    if (it.hold) {
      it.hold.shards = (it.hold.shards || 1) + 1;
      log('TRANS', `${short(p.hash)} · sibling shard joined hold (${it.hold.shards} held)`);
      return;
    }
    it.hold = { cap_ms: Number(p.cap_ms || 0), created_at: Date.now(), watchdog_at: null, via: p.via || 'intercept', shards: 1 };
    transition(it, 'HOLDING', p.via === 'b13' ? 'B-13 mid-open disconnect' : 'recipient offline');
    // I2 pairing check: the record's single watchdog must follow within 2 s.
    setTimeout(() => {
      const cur = intents.get(p.hash);
      if (cur && cur.state === 'HOLDING' && cur.hold && !cur.hold.watchdog_at) {
        log('VIOLATION', `${short(p.hash)} · I2: HOLDING for 2 s with NO watchdog scheduled`);
      }
    }, 2000);
  },

  // 0.4: forward-kind replay handed the shards back to LND — the machine's
  // job ended honestly. Terminal, so successful M3a-class replays stop
  // haunting the census (the old blind spot).
  resumed(p) {
    const it = p.hash ? intents.get(p.hash) : null;
    if (!it) return;
    transition(it, 'RESUMED', 'handed back to LND (forward replay)');
  },

  watchdog_scheduled(p) {
    const it = intents.get(p.hash);
    if (it && it.hold) it.hold.watchdog_at = Date.now() + Number(p.in_ms || 0);
    else if (it) log('NOTE', `${short(p.hash)} · watchdog scheduled outside a known hold`);
  },

  watchdog_fired(p) {
    const it = intents.get(p.hash);
    if (!it) { log('NOTE', `watchdog fired for unknown intent ${short(p.hash)}`); return; }
    transition(it, 'FAILING', 'watchdog cap expiry');
    transition(it, 'EXPIRED', 'hold expired');
  },

  replay_started() { /* per-pubkey; intents transition on their own events */ },

  // 0.80.0 (S49): the B-10 trampoline — the adapter pays the recipient itself and settles the inbound
  // with the preimage. The machine had never heard of it, so every hold delivered that way stayed
  // HOLDING in the census for the life of the process (2026-09-24: "HOLDING@21668s" for holds that
  // settled at 07:33). start: HOLDING → FORWARDING; ok: → SETTLING → SETTLED; not ok: back to HOLDING
  // (the replay path takes over, and RESUME or the watchdog ends it).
  trampoline(p) {
    const it = p.hash ? intents.get(p.hash) : null;
    if (!it) return;
    if (p.phase === 'start') { if (it.state === 'HOLDING') transition(it, 'FORWARDING', 'B-10 trampoline'); return; }
    if (p.phase === 'inflight') { if (it.state === 'HOLDING') transition(it, 'FORWARDING', 'B-10 trampoline — LND owns the inner, parked for the probe'); return; }   // 0.114.0 (F1): stays FORWARDING; the park's verdict (trampoline ok / not ok) ends it
    if (p.ok) {
      if (it.state !== 'SETTLING') transition(it, 'SETTLING', 'trampoline paid — preimage received');
      transition(it, 'SETTLED', 'inbound settled with the preimage');
    } else if (it.state === 'FORWARDING') {
      transition(it, 'HOLDING', 'trampoline did not complete — replay path');
    }
  },

  // 0.114.0 (F1): the JIT rail parked the payer's circuits because LND still owns the inner payment — the intent stays
  // where it is (FORWARDING after an open, HOLDING for a held one); the probe's verdict arrives as settle / forward_result /
  // trampoline ok|not ok.
  inflight_parked(p) {
    const it = p.hash ? intents.get(p.hash) : null;
    if (!it) return;
    if (it.state === 'OPENING' || it.state === 'HOLDING' || it.state === 'GATED' || it.state === 'INTERCEPTED' || it.state === 'AGGREGATING') transition(it, 'FORWARDING', `inner payment in flight at LND — ${p.circuits || '?'} circuit(s) parked (${p.kind || 'jit'})`);
  },

  open_started(p) {
    const it = getIntent(p.hash);
    if (!it) return;
    it.promiseBound = true;  // 0.3
    if (p.scid) it.scid = String(p.scid);
    if (p.total_msat != null) it.total_msat_expected = String(p.total_msat);
    // I1 — the split-brain detector. Would have fired live tonight.
    if (!secretKnown(it)) {
      log('VIOLATION', `${short(p.hash)} · I1-secret: OPENING with no payment_secret known for hash or scid=${it.scid} — recipient will reject; channel opens for nothing`);
    }
    // Phase 0.1: fee-consistent sum check. Inbound HTLCs carry the GROSS
    // invoice (net + JIT open fee grossed onto the payer); the promise
    // expects the NET. Compare Σ inbound against expected + fee; skip
    // entirely when the fee is unknown (no more spurious notes).
    if (it.total_msat_expected && p.fee_msat != null && it.shard_sum_msat > 0n) {
      try {
        const want = BigInt(it.total_msat_expected) + BigInt(p.fee_msat);
        // 0.2: inbound also carries per-shard sender routing fees (~1k msat
        // each, live-measured). Speak only on real signal: under-collection,
        // or overage beyond 1% + 50k msat slack.
        const slack = want / 100n + 50000n;
        if (it.shard_sum_msat < want) {
          log('NOTE', `${short(p.hash)} \u00b7 I1-sum UNDER: \u03a3 inbound ${it.shard_sum_msat} < expected ${it.total_msat_expected} + fee ${p.fee_msat}`);
        } else if (it.shard_sum_msat > want + slack) {
          log('NOTE', `${short(p.hash)} \u00b7 I1-sum OVER: \u03a3 inbound ${it.shard_sum_msat} \u226b expected ${it.total_msat_expected} + fee ${p.fee_msat}`);
        }
      } catch (_) {}
    }
    transition(it, 'OPENING', 'JIT open');
  },

  open_result(p) {
    const it = intents.get(p.hash);
    if (!it) return;
    if (p.ok) transition(it, 'FORWARDING', 'channel opened');
    else transition(it, 'FAILING', `open failed: ${p.err || '?'}`);
  },

  forward_result(p) {
    const it = intents.get(p.hash);
    if (!it) return;
    if (p.ok) transition(it, 'SETTLING', 'forward succeeded');
    else {
      transition(it, 'FAILING', `forward failed: ${p.code || '?'}`);
      transition(it, 'FAILED', 'forward failure');
    }
  },

  settle(p) {
    const it = getIntent(p.hash);
    if (!it) return;
    if (it.state !== 'SETTLING') transition(it, 'SETTLING', 'preimage observed');
    transition(it, 'SETTLED', 'preimage applied');
  },
};

function emit(event, payload) {
  try {
    const h = handlers[event];
    if (h) h(payload || {});
    else log('NOTE', `unknown event "${event}"`);
  } catch (e) {
    // The shadow must NEVER disturb the live path.
    try { log('NOTE', `handler error on "${event}": ${e.message}`); } catch (_) {}
  }
}

// Census: one line a minute while anything is in flight. Phase 0.1: the
// same sweep ages out pass-throughs — RESUME writes aren't tapped in this
// phase (ten scattered return sites; Phase 1's dispatch owns them), so an
// INTERCEPTED intent with no further events for 90 s closes quietly as
// PASSTHROUGH instead of haunting the census.
const _census = setInterval(() => {
  try {
    for (const it of intents.values()) {
      // 0.2: M2a2 taught us AGGREGATING pass-throughs (MPP over existing
      // channels — module-inferred shards, adapter resumes each) age the
      // same way. Both close quietly.
      if ((it.state === 'INTERCEPTED' || it.state === 'AGGREGATING')
          && !it.promiseBound
          && Date.now() - it.entered_at > 90000) {
        transition(it, 'PASSTHROUGH', 'aged out \u2014 resume path untapped in Phase 0');
      }
    }
    const open = [...intents.values()].filter((i) => !TERMINAL.has(i.state));
    if (!open.length) return;
    const parts = open.map((i) => `${short(i.hash)}:${i.state}@${Math.round((Date.now() - i.entered_at) / 1000)}s`);
    log('STATE', `${open.length} in flight · ${parts.join(' · ')}`);
  } catch (_) {}
}, 60000);
if (_census.unref) _census.unref();

// ── v0.38.0 (S31): read-only snapshot for the Pulse W2 pending poll ──────
// Non-terminal intents only; strings for BigInt safety; never throws.
function snapshot() {
  const out = [];
  try {
    for (const it of intents.values()) {
      if (TERMINAL.has(it.state)) continue;
      out.push({
        hash: it.hash,
        state: it.state,
        age_s: Math.round((Date.now() - it.entered_at) / 1000),
        sum_msat: String(it.shard_sum_msat),
        scid: it.scid || null,
      });
    }
  } catch (_) {}
  return out;
}

// ── 0.63.0 (S42): per-hash lookup INCLUDING terminal states, for /v1/outcome.
function lookup(hash) {
  try {
    const it = intents.get(String(hash || '').toLowerCase());
    if (!it) return null;
    return { state: it.state, entered_at: it.entered_at, scid: it.scid || null };
  } catch (_) { return null; }
}

module.exports = { emit, snapshot, lookup };
