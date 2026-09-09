const path=require('path').join(__dirname,'console.js');
const { createConsole, totpEnroll, totpCode, base32Decode, CSP } = require(path);
const http = require('http'); const crypto = require('crypto');
const e = totpEnroll('t'); process.env.CONSOLE_TOTP_SECRET = e.secret; process.env.CONSOLE_PORT = '17004'; process.env.CONSOLE_TAILSCALE = 'false';
const secret = base32Decode(e.secret);
let snaps = 0;
const con = createConsole({ version: 'v0.71.0-test', snapshot: async () => { snaps++; return { node: { alias: 'T', uris: ['abc.onion:9735', '1.2.3.4:9735'] }, balances: {}, channels: [], wallets: [], pending: [], registry: {}, backups: {}, loops: {}, uptime_s: 1, tapes: 0 }; }, log: () => {} });
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
  for (let i = 0; i < 5; i++) await req('POST', '/console/login', { code: '111111' });
  const locked = await req('POST', '/console/login', { code: totpCode(secret, counter + 1) });
  t('five wrong codes lock the address (429)', locked.status === 429);
  const out = await req('POST', '/console/logout', null, cookie);
  t('logout clears', out.status === 200 && (await req('GET', '/console/events', null, cookie)).status === 401);
  console.log(`\n${pass} passed, ${fail} failed`); servers.forEach((s) => s.close()); process.exit(fail ? 1 : 0);
})();
