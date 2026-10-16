// 0.105.2 (S59 security review): readBody caps the body; getClientIp ignores a client-chosen x-forwarded-for unless trusted.
const assert = require('assert'); const http = require('http');
const src = require('fs').readFileSync(__dirname + '/lij-adapter.js', 'utf8');
function fnFromSource(name, deps) {   // lift one top-level function (and the const it reads) out of the file
  const re = new RegExp('(?:const TRUST_XFF[^\\n]*\\n)?(?:const READ_BODY_MAX[^\\n]*\\n)?function ' + name + '\\([\\s\\S]*?\\n}\\n');
  const m = src.match(re); assert(m, name + ' found');
  return new Function(...Object.keys(deps), m[0] + '; return ' + name + ';')(...Object.values(deps));
}
let passed = 0, failed = 0; const t = (n, ok) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n); } };
(async () => {
  const readBody = fnFromSource('readBody', { leaseTouch: () => {} });
  const getClientIp = fnFromSource('getClientIp', { process: { env: {} } });
  // readBody: a 256 KB cap by default, the route's cap when given; the request destroyed past it
  const srv = http.createServer(async (req, res) => {
    const cap = req.url === '/big' ? 2 * 1024 * 1024 : undefined;
    try { const b = await readBody(req, cap); res.end(JSON.stringify({ ok: true, n: Object.keys(b).length })); }
    catch (e) { res.statusCode = 413; res.end(JSON.stringify({ ok: false, reason: e.message })); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const post = (path, body) => new Promise((resolve) => { const rq = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (rs) => { let d = ''; rs.on('data', (c) => d += c); rs.on('end', () => resolve({ status: rs.statusCode, body: d })); }); rq.on('error', (e) => resolve({ status: 0, body: String(e.message) })); rq.end(body); });
  const small = JSON.stringify({ a: 1 });
  const r1 = await post('/x', small); t('a small body is read', r1.status === 200 && /"n":1/.test(r1.body));
  const big = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
  const r2 = await post('/x', big); t('a 300 KB body is refused by the 256 KB cap (413 or the socket closed)', r2.status === 413 || r2.status === 0);
  const r3 = await post('/big', big); t('the same body passes a 2 MB cap (the backup route)', r3.status === 200);
  const huge = 'x'.repeat(3 * 1024 * 1024);
  const r4 = await post('/big', huge); t('3 MB is refused even by the backup cap', r4.status === 413 || r4.status === 0);
  srv.close();
  // getClientIp
  const req = (h, addr) => ({ headers: h, socket: { remoteAddress: addr } });
  t('cf-connecting-ip wins', getClientIp(req({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' }, '10.0.0.1')) === '1.2.3.4');
  t('x-forwarded-for is ignored when not trusted — the socket speaks', getClientIp(req({ 'x-forwarded-for': '9.9.9.9' }, '10.0.0.1')) === '10.0.0.1');
  const trusted = fnFromSource('getClientIp', { process: { env: { TRUST_FORWARDED_FOR: 'true' } } });
  t('trusted: the LAST hop of x-forwarded-for', trusted(req({ 'x-forwarded-for': '9.9.9.9, 7.7.7.7' }, '10.0.0.1')) === '7.7.7.7');
  t('trusted but absent: the socket', trusted(req({}, '10.0.0.1')) === '10.0.0.1');
  console.log(failed ? 'GATE FAIL · ' + failed : passed + ' passed, 0 failed');
  process.exit(failed ? 1 : 0);
})();
