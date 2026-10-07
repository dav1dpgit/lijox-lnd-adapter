// 0.91.1 (S56, DP 2026-10-06 08:15 "Agree then the rate fix") — GET /rates answers at once from the copy it holds.
// The SA tester's wallet held no rand rate when he scanned a Pick n Pay code: a wallet asks /rates and gives up at 4 s,
// and the provider, whenever its copy was over two minutes old (most of the time, with few wallets asking), asked
// CoinGecko FIRST and made the wallet wait for it (up to 8 s). Now a copy within the stale limit answers at once and
// the refresh runs behind it; only a provider with no copy, or one past the stale limit, waits for the upstream.
//   node rates.test.js
// The adapter is one module that starts servers on require, so this reads the source: the RATES block as written,
// evaluated with a stand-in upstream (https.request) whose answer takes as long as the test says.
const fs = require('fs');
const { EventEmitter } = require('events');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

const start = src.indexOf('const RATES_TTL_MS');
const end = src.indexOf('\n}\n', src.indexOf('async function ratesHandler(res)')) + 3;
check(start > 0 && end > start, 'the RATES block is where it was');
const block = src.slice(start, end);

function load({ delayMs = 0, usd = 90000, fail = false } = {}) {
  const calls = [];
  const https = { request: (opts, cb) => {
    calls.push(Date.now());
    const rq = new EventEmitter(); rq.end = () => {
      setTimeout(() => {
        if (fail) { rq.emit('error', new Error('down')); return; }
        const rs = new EventEmitter(); cb(rs);
        rs.emit('data', JSON.stringify({ bitcoin: { usd, zar: usd * 16.6 } })); rs.emit('end');
      }, delayMs);
    }; rq.destroy = () => {}; return rq;
  } };
  const answers = [];
  const env = { RATES_TTL_SECONDS: '120', RATES_STALE_SECONDS: '3600' };
  const mk = new Function('require', 'process', 'errResponse', 'jsonResponse',
    block + '\n; return { ratesHandler, get: () => ratesCache, set: (v) => { ratesCache = v; } };');
  const api = mk((n) => (n === 'https' ? https : require(n)), { env },
    (res, msg, code) => { answers.push({ code, msg }); }, (res, body) => { answers.push({ code: 200, body }); });
  return { api, calls, answers };
}
const timed = async (fn) => { const t0 = Date.now(); await fn(); return Date.now() - t0; };

(async () => {
  // r1 — no copy yet: the first ask waits for the upstream, then answers
  let s = load({ delayMs: 50 });
  let ms = await timed(() => s.api.ratesHandler({}));
  check(s.calls.length === 1 && s.answers[0].code === 200 && s.answers[0].body.rates.ZAR > 0, 'r1 no copy: the upstream is asked and the answer carries ZAR');
  check(s.answers[0].body.stale === false, 'r1 a fresh answer says stale: false');

  // r2 — a copy three minutes old, the upstream slow (3 s): answered at once from the copy, the refresh behind it
  s = load({ delayMs: 3000, usd: 95000 });
  s.api.set({ rates: { USD: 90000, ZAR: 1494000 }, fetched_at_ms: Date.now() - 180_000 });
  ms = await timed(() => s.api.ratesHandler({}));
  check(ms < 200, 'r2 a three-minute-old copy answers at once (' + ms + ' ms) — the wallet is not made to wait for CoinGecko');
  check(s.answers[0].code === 200 && s.answers[0].body.rates.USD === 90000 && s.answers[0].body.stale === true, 'r2 the answer is the copy held, marked stale');
  check(s.calls.length === 1, 'r2 the refresh was started');
  await new Promise((r) => setTimeout(r, 3200));
  check(s.api.get().rates.USD === 95000, 'r2 the refresh landed behind the answer');

  // r3 — two asks while the refresh runs: one upstream request (single flight)
  s = load({ delayMs: 300 });
  s.api.set({ rates: { USD: 90000 }, fetched_at_ms: Date.now() - 180_000 });
  await s.api.ratesHandler({}); await s.api.ratesHandler({});
  check(s.calls.length === 1 && s.answers.length === 2, 'r3 two asks, one upstream request');
  await new Promise((r) => setTimeout(r, 400));

  // r4 — a copy past the stale limit (over an hour), the upstream down: waits for it, then 503 as before
  s = load({ delayMs: 20, fail: true });
  s.api.set({ rates: { USD: 90000 }, fetched_at_ms: Date.now() - 3_700_000 });
  await s.api.ratesHandler({});
  check(s.calls.length === 1 && s.answers[0].code === 503, 'r4 past the stale limit and the upstream down: 503, as before');

  // r5 — a fresh copy (under two minutes): no upstream ask at all
  s = load({ delayMs: 20 });
  s.api.set({ rates: { USD: 90000 }, fetched_at_ms: Date.now() - 30_000 });
  await s.api.ratesHandler({});
  check(s.calls.length === 0 && s.answers[0].body.stale === false, 'r5 a fresh copy: answered, nothing asked upstream');

  if (fails) { console.log('FAIL · ' + fails); process.exit(1); }
  console.log('PASS · rates.test.js');
})();
