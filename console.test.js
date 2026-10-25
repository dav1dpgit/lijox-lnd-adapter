const path=require('path').join(__dirname,'console.js');
const { createConsole, totpEnroll, totpCode, base32Decode, CSP } = require(path);
const http = require('http'); const crypto = require('crypto');
const e = totpEnroll('t'); process.env.CONSOLE_TOTP_SECRET = e.secret; process.env.CONSOLE_PORT = '17004'; process.env.CONSOLE_TAILSCALE = 'false';
const secret = base32Decode(e.secret);
let snaps = 0;
// 0.111.0 (S63): the deps behind the three routes that left the public API — recorded, so the test can see what was called
const calls = [];
const con = createConsole({ version: 'v0.71.0-test', snapshot: async () => { snaps++; return { node: { alias: 'T', uris: ['abc.onion:9735', '1.2.3.4:9735'] }, balances: {}, channels: [], wallets: [], pending: [], registry: {}, backups: {}, loops: {}, uptime_s: 1, tapes: 0 }; }, log: () => {},
  routeToken: () => 'route-token-published-to-wallets',
  leaseStatus: () => ({ ok: true, enabled: true, dry_run: true, channels: [{ chan_point: 'aa'.repeat(32) + ':0', idle_days: 3.2, ttl_days_effective: 60 }] }),
  setLeaseTtl: async (cp, ttl, by) => { calls.push(['ttl', cp, ttl, by]); return (ttl === null || (ttl >= 1 && ttl <= 3650)) ? { ok: true, chan_point: cp, ttl_days: ttl } : { ok: false, error: 'ttl_days must be a number from 1 to 3650, or empty to clear the override' }; },
  releaseJitWallet: async (w, by) => { calls.push(['rw', w, by]); return /^02aa/.test(w) ? { ok: true } : { ok: false, error: 'that wallet is not blocked' }; },
});
const servers = con.start();
function req(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 17004, path: p, method, headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}) }, (res) => { let d = ''; res.on('data', (c) => { d += c; if (p.endsWith('/events') && d.includes('\n\n')) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: d }); } }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}
(async () => {
  let pass = 0, fail = 0; const t = (n, ok) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n); };
  await new Promise((r) => setTimeout(r, 200));
  const login = await req('GET', '/console');
  t('login page without session', login.status === 200 && login.body.includes('id="login"'));
  // CSP hashes match the served inline script/style
  const sj = /<script>([\s\S]*?)<\/script>/.exec(login.body)[1], ss = /<style>([\s\S]*?)<\/style>/.exec(login.body)[1];
  const h = (x) => crypto.createHash('sha256').update(x, 'utf8').digest('base64');
  t('CSP script hash matches served page', login.headers['content-security-policy'].includes(`'sha256-${h(sj)}'`));
  t('CSP style hash matches served page', login.headers['content-security-policy'].includes(`'sha256-${h(ss)}'`));
  // 0.105.1: the served page script parses — 0.104.0's did not (a `\n` inside the JS template became a real newline
  // inside a quoted string; the browser refused the whole script and the code field was never wired)
  t('the served page script parses', (() => { try { new Function(sj); return true; } catch (e) { console.log('   ' + e.message); return false; } })());
  t('CSP default-src none, no unsafe-inline', /default-src 'none'/.test(CSP) && !/unsafe-inline/.test(CSP));
  t('events refused without session', (await req('GET', '/console/events')).status === 401);
  const bad = await req('POST', '/console/login', { code: '000000' });
  t('wrong code refused', bad.status === 401);
  const counter = Math.floor(Date.now() / 1000 / 30); const code = totpCode(secret, counter);
  const ok = await req('POST', '/console/login', { code });
  t('right code accepted', ok.status === 200 && /lijc_[a-f0-9]{8}=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/console/.test(ok.headers["set-cookie"][0]));
  const cookie = ok.headers['set-cookie'][0].split(';')[0];
  const replay = await req('POST', '/console/login', { code });
  t('same code refused a second time (replay)', replay.status === 401);
  const page = await req('GET', '/console', null, cookie);
  t('console page with session', page.status === 200 && page.body.includes('id="chan"'));
  const ev = await req('GET', '/console/events', null, cookie);
  t('first event carries a snapshot', ev.status === 200 && ev.body.startsWith('data: ') && ev.body.includes('"alias":"T"') && snaps >= 1);
  // 0.111.0 (S63): the routes that left the public API
  const cookie2 = cookie;
  t('the page has the JIT \u00b7 now pane', (await req('GET', '/console', null, cookie2)).body.includes('id="jitnow"'));
  t('/console/lease refused with no session and no token', (await req('GET', '/console/lease')).status === 401);
  const wrongTok = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: 17004, path: '/console/lease', headers: { 'x-adapter-secret': 'wrong' } }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); }); r.end(); });
  t('/console/lease refused with the wrong token', wrongTok.status === 401);
  const rightTok = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port: 17004, path: '/console/lease', headers: { 'x-adapter-secret': 'route-token-published-to-wallets' } }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); }); r.end(); });
  t('/console/lease answers the box-local dashboard: loopback + the route token, no session', rightTok.status === 200 && JSON.parse(rightTok.body).channels[0].ttl_days_effective === 60);
  t('/console/lease answers a session too', (await req('GET', '/console/lease', null, cookie2)).status === 200);
  t('lease-ttl refused without a session', (await req('POST', '/console/lease-ttl', { chan_point: 'aa'.repeat(32) + ':0', ttl_days: 90 })).status === 401);
  const setTtl = await req('POST', '/console/lease-ttl', { chan_point: 'aa'.repeat(32) + ':0', ttl_days: 90 }, cookie2);
  t('lease-ttl sets 90 days through the dep, audited with the address', setTtl.status === 200 && JSON.parse(setTtl.body).ttl_days === 90 && calls.some((c) => c[0] === 'ttl' && c[2] === 90 && /^console 127/.test(c[3])));
  const clrTtl = await req('POST', '/console/lease-ttl', { chan_point: 'aa'.repeat(32) + ':0', ttl_days: null }, cookie2);
  t('lease-ttl clears the override with null', clrTtl.status === 200 && JSON.parse(clrTtl.body).ttl_days === null);
  t('lease-ttl below one day is refused by the dep (400)', (await req('POST', '/console/lease-ttl', { chan_point: 'aa'.repeat(32) + ':0', ttl_days: 0.0001 }, cookie2)).status === 400);
  t('lease-ttl without a chan_point is refused', (await req('POST', '/console/lease-ttl', { ttl_days: 5 }, cookie2)).status === 400);
  t('jit-release-wallet refused without a session', (await req('POST', '/console/jit-release-wallet', { wallet: '02' + 'aa'.repeat(32) })).status === 401);
  const rw = await req('POST', '/console/jit-release-wallet', { wallet: '02' + 'aa'.repeat(32) }, cookie2);
  t('jit-release-wallet releases through the dep, audited', rw.status === 200 && calls.some((c) => c[0] === 'rw' && c[1] === '02' + 'aa'.repeat(32) && /^console 127/.test(c[2])));
  t('jit-release-wallet of an unblocked wallet answers 400 with the reason', (await req('POST', '/console/jit-release-wallet', { wallet: '02' + 'bb'.repeat(32) }, cookie2)).status === 400);
  for (let i = 0; i < 5; i++) await req('POST', '/console/login', { code: '111111' });
  const locked = await req('POST', '/console/login', { code: totpCode(secret, counter + 1) });
  t('five wrong codes lock the address (429)', locked.status === 429);
  const out = await req('POST', '/console/logout', null, cookie);
  t('logout clears', out.status === 200 && (await req('GET', '/console/events', null, cookie)).status === 401);
  console.log(`\n${pass} passed, ${fail} failed`); servers.forEach((s) => s.close()); process.exit(fail ? 1 : 0);
})();
