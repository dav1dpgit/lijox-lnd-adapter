// 0.99.0 (S58): ONE API SERVER, TWO RELAYS — /nwc (nwc.js) and /tatara/relay (tatara.js) — and a 404 for any other
// upgrade. The real modules, the listener lij-adapter.js adds (read out of its source), real sockets.
//   node upgrade-paths.test.js
'use strict';
const http = require('http'); const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { WebSocket } = require('ws');
const { createNwc } = require('./nwc.js');
const { createTatara } = require('./tatara');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const i0 = src.indexOf("  server.on('upgrade', (req, socket, head) => {\n    if (tatara.handleUpgrade(req, socket, head)) return;");
const i1 = src.indexOf('  });\n', i0) + 6;
(async () => {
  check(i0 > 0 && i1 > i0 && src.indexOf('nwc.attach(server);') < i0, 'U0 lij-adapter.js adds its upgrade listener after nwc.attach');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-'));
  const nwc = createNwc({ dataDir: dir, log: () => {}, env: { NWC_ENABLED: 'true' }, publicHttpsUrl: 'https://lsp.example.com' });
  const tatara = createTatara({ env: { TATARA_ENABLED: 'true' }, publicHttpsUrl: 'https://lsp.example.com', dataDir: dir });
  const server = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  nwc.attach(server);
  new Function('server', 'tatara', 'URL', src.slice(i0, i1))(server, tatara, URL);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'ws://127.0.0.1:' + server.address().port;
  const conn = (u) => new Promise((resolve) => { const w = new WebSocket(u); w.got = []; w.on('message', (d) => w.got.push(JSON.parse(d.toString()))); w.on('open', () => resolve(w)); w.on('error', () => resolve(null)); w.on('unexpected-response', (q, r) => resolve({ status: r.statusCode })); });
  const n = await conn(base + '/nwc');
  await new Promise((r) => setTimeout(r, 150));
  check(n && n.got && n.got.some((m) => m[0] === 'AUTH'), 'U1 /nwc still opens the NWC relay (AUTH challenge)');
  const t = await conn(base + '/tatara/relay?token=' + 'ab'.repeat(32));
  check(t && t.status === 404, 'U2 /tatara/relay with a token no room holds: 404 from the Tatara relay');
  const o = await conn(base + '/elsewhere');
  check(o && o.status === 404, 'U3 any other path: 404');
  try { n.close(); } catch (_) {}
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? 'FAIL · upgrade-paths · ' + fails + ' failed' : 'PASS · upgrade-paths (U0–U3)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · upgrade-paths threw: ' + (e && e.stack || e)); process.exit(1); });
