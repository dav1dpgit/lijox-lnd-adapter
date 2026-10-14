// 0.96.0 (S58, DP 2026-10-12 20:18 "Go on Proposals 1, 2, and 3" — proposal 1): THE WALLET CHECKS' OWN LIMITS.
// my-channels and recover-close shared the channel-open limit (3 an hour per address): DP's journal 18:35–18:37,
// "Rate limit hit … resets in 20 min", and the page's provider check showed "no answer".
//   node wallet-limits.test.js
// The limiter runs for real; recover-close's block is read from the source and run with stand-ins for LND (as
// my-channels.test.js does), so its limits are tried in the order they are written.
const fs = require('fs');
const path = require('path');
const { windowLimiter } = require('./wallet-limits');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

(async () => {
  // l1 — the window: max hits, then refused with the time left; a new window after it ends
  {
    let t = 1000; const L = windowLimiter(3, 60000, () => t);
    const r = [L.hit('a'), L.hit('a'), L.hit('a'), L.hit('a')];
    check(r.slice(0, 3).every(x => x.ok) && !r[3].ok && r[3].reset_s === 60, 'l1 three in the window, the fourth refused with 60 s left');
    t += 59999; check(!L.hit('a').ok, 'l1 still refused 1 ms before the window ends');
    t += 1; check(L.hit('a').ok, 'l1 answered once the window has ended');
  }
  // l2 — keys are apart
  {
    const L = windowLimiter(1, 60000, () => 0);
    check(L.hit('a').ok && !L.hit('a').ok && L.hit('b').ok, 'l2 one key\'s count never holds back another');
  }
  // l3 — sweep drops ended windows only
  {
    let t = 0; const L = windowLimiter(1, 1000, () => t);
    L.hit('a'); t = 500; L.hit('b'); t = 1000; L.sweep();
    check(L.size() === 1, 'l3 the sweep drops the ended window and keeps the live one');
  }
  // l4 — the defaults and the wiring
  check(/wallet_check_ip_requests:\s+parseInt\(process\.env\.WALLET_CHECK_IP_REQUESTS\s+\|\| '120'\)/.test(src) &&
        /wallet_check_ip_window_ms:\s+parseInt\(process\.env\.WALLET_CHECK_IP_WINDOW_MS\s+\|\| '600000'\)/.test(src) &&
        /my_channels_key_requests:\s+parseInt\(process\.env\.MY_CHANNELS_KEY_REQUESTS\s+\|\| '60'\)/.test(src) &&
        /recover_close_key_requests:\s+parseInt\(process\.env\.RECOVER_CLOSE_KEY_REQUESTS \|\| '10'\)/.test(src) &&
        /wallet_check_key_window_ms:\s+parseInt\(process\.env\.WALLET_CHECK_KEY_WINDOW_MS \|\| '3600000'\)/.test(src),
        'l4 defaults: 120 per address per 10 min; per key an hour: 60 my-channels, 10 recover-close');
  check((src.match(/if \(isRateLimited\(ip\)\)/g) || []).length === 1 && src.indexOf('if (isRateLimited(ip))') > src.indexOf('LSPS1 disabled'),
        'l4 the channel-open limit (3 an hour) is left only in the disabled LSPS1 route');
  check(/walletCheckIpLimit\.sweep\(\); myChannelsKeyLimit\.sweep\(\); recoverCloseKeyLimit\.sweep\(\);/.test(src), 'l4 the ten-minute sweep clears the new windows too');

  // the order inside each handler: address ceiling → body → signature → key limit → nonce
  const order = (fn, keyName, nonceMark) => {
    const s = src.indexOf('async function ' + fn + '(');
    const e = src.indexOf('\n}\n', s);
    const body = src.slice(s, e);
    const iIp = body.indexOf('walletCheckIpLimit.hit(ip)'), iBody = body.indexOf('readBody(req)'),
          iVerify = body.indexOf("'/v1/verifymessage'"), iBad = body.indexOf("reason: 'bad_signature'"),
          iKey = body.indexOf(keyName + '.hit(pk)'), iNonce = body.indexOf(nonceMark);
    return iIp > 0 && iIp < iBody && iBody < iVerify && iVerify < iBad && iBad < iKey && iKey < iNonce;
  };
  check(order('handleMyChannels', 'myChannelsKeyLimit', 'registryNonceStore.consume'), 'l5 my-channels: address ceiling, then the signature, then this key\'s limit, then the nonce');
  check(order('handleRecoverClose', 'recoverCloseKeyLimit', 'registryNonceStore.consume'), 'l5 recover-close: the same order');

  // l6–l9 — recover-close run with stand-ins
  const start = src.indexOf('const RECOVER_CLOSE_DOMAIN');
  const end = src.indexOf('\n}\n', src.indexOf('async function handleRecoverClose(')) + 3;
  check(start > 0 && end > start, 'l6 the RECOVER-CLOSE block is where it was');
  const block = src.slice(start, end);
  const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32), NONCE = 'cd'.repeat(32);
  function load({ recovered = PK, ipLimit, keyLimit }) {
    const calls = { verify: 0, get: [], consumed: 0, closed: 0 };
    const answers = [];
    const mk = new Function('walletCheckIpLimit', 'recoverCloseKeyLimit', 'readBody', 'errResponse', 'jsonResponse', 'lndRequest', 'lndGet', 'registryNonceStore', 'console', 'leaseForceClose',
      block + '\n; return { handleRecoverClose };');
    const api = mk(ipLimit, keyLimit, async (req) => req.body,
      (res, msg, code) => answers.push({ code: code || 400, body: { error: msg } }),
      (res, body, code) => answers.push({ code: code || 200, body }),
      async () => { calls.verify++; return { pubkey: recovered }; },
      async (p) => { calls.get.push(p); return p === '/v1/channels' ? { channels: [] } : {}; },
      { consume: () => { calls.consumed++; return { ok: true }; } },
      { log: () => {}, warn: () => {}, error: () => {} },
      async () => { calls.closed++; return '{}'; });
    const ask = async (body, ip = '1.2.3.4') => { await api.handleRecoverClose({ body }, {}, ip); return answers[answers.length - 1]; };
    return { ask, calls, answers };
  }
  const good = { node_pubkey: PK, nonce: NONCE, signature: 'sig' };
  {
    let t = 0; const clock = () => t;
    const s = load({ ipLimit: windowLimiter(120, 600000, clock), keyLimit: windowLimiter(10, 3600000, clock) });
    let a;
    for (let i = 0; i < 11; i++) a = await s.ask(good);
    check(s.answers.slice(0, 10).every(x => x.code === 200 && x.body.reason === 'no_channels') && a.code === 429,
      'l7 recover-close: ten an hour per key, the eleventh refused');
    check(s.calls.verify === 11 && s.calls.consumed === 10 && s.calls.get.filter(p => p === '/v1/channels').length === 10,
      'l7 the eleventh was refused after its signature, before its nonce or any channel was touched');
    t = 3600000; a = await s.ask(good);
    check(a.code === 200, 'l7 answered again once the hour has ended');
  }
  {
    const s = load({ ipLimit: windowLimiter(2, 600000, () => 0), keyLimit: windowLimiter(10, 3600000, () => 0) });
    let a;
    for (let i = 0; i < 3; i++) a = await s.ask(good);
    check(a.code === 429 && s.calls.verify === 2, 'l8 past the address ceiling: refused before LND is asked to check the signature');
    a = await s.ask(good, '5.6.7.8');
    check(a.code === 200, 'l8 another address is not held back');
  }
  {
    const s = load({ recovered: OTHER, ipLimit: windowLimiter(120, 600000, () => 0), keyLimit: windowLimiter(1, 3600000, () => 0) });
    let a;
    for (let i = 0; i < 3; i++) a = await s.ask(good);
    check(s.answers.every(x => x.code === 401), 'l9 bad signatures with someone\'s key never use up that key\'s limit');
  }
  // the two checks keep separate counts per key (one wallet start never uses up a recovery)
  check(/const myChannelsKeyLimit\s+= windowLimiter\(CONFIG\.security\.my_channels_key_requests/.test(src) &&
        /const recoverCloseKeyLimit = windowLimiter\(CONFIG\.security\.recover_close_key_requests/.test(src),
        'l9 my-channels and recover-close count apart per key');

  console.log(fails ? 'FAIL · wallet-limits · ' + fails + ' failed' : 'PASS · wallet-limits (l1–l9)');
  process.exit(fails ? 1 : 0);
})();
