// 0.95.0 (Start9 session, DP 2026-10-10) — the REST channel list follows LND_ENDPOINT, and D3's certificate rule.
//   node rest-endpoint.test.js
// The adapter is one module that starts servers on require, so this reads the source (the decide.test.js way):
// it checks the shape, then lifts the REST functions out as written and runs them for real against a local HTTPS
// server on a random port (never 8080) — certificate checked, unchecked, and asked for with an unreadable file; an
// answer cut off halfway; the chain bridge's own helper; the port rule.
// The functional half needs the openssl command to make throwaway certificates; without it, it says SKIP.
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execFileSync } = require('child_process');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, 'cooperative-chain-bridge.js'), 'utf8');
const example = fs.readFileSync(path.join(__dirname, 'config.env.example'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

function lift(name, text = src, indent = '') {
  const m = text.match(new RegExp(indent + '(async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n' + indent + '\\}'));
  if (!m) throw new Error('cannot find ' + name);
  return m[0];
}

// ── the shape ──
check(!/rest_hostname|rest_port/.test(src), 'r1 · rest_hostname / rest_port are gone (nothing ever set them)');
const raw = lift('lndRequestRaw');
check((src.match(/Grpc-Metadata-macaroon/g) || []).length === 1 && /Grpc-Metadata-macaroon/.test(raw),
  'r2 · the macaroon goes onto a REST request in one place only: lndRequestRaw');
check(/hostname:\s+lndUrl\.hostname/.test(raw) && /port:\s+lndRestPort\(\)/.test(raw), 'r2 · lndRequestRaw takes host and port from LND_ENDPOINT');
const fcs = lift('findChannelScid'), rrc = lift('refreshRealChannelScids');
check(/lndGetOk\('\/v1\/channels'\)/.test(fcs) && !/https\.request/.test(fcs), 'r3 · findChannelScid reads the channel list through lndGetOk, with no request of its own');
check(/lndGetOk\('\/v1\/channels'\)/.test(rrc) && !/https\.request/.test(rrc), 'r3 · refreshRealChannelScids reads it the same way');
check((src.match(/rejectUnauthorized\s*:\s*false/g) || []).length === 1 && /rejectUnauthorized\s*:\s*false/.test(lift('lndRestTls')),
  'r4 · the only unchecked REST connection left in the adapter is lndRestTls()\'s "LND_REST_CA_PATH empty" case');
check(/restTls:\s+lndRestTls\(\)/.test(src) && /port:\s+lndRestPort\(\)/.test(src.slice(src.indexOf('chainBridge = startBridge({'))),
  'r5 · the chain bridge is started with the same certificate rule and port rule');
check(/rest_ca_path:\s+\(process\.env\.LND_REST_CA_PATH \|\| ''\)\.trim\(\)/.test(src), 'r6 · LND_REST_CA_PATH is read (empty by default)');
check(/CONFIG\.lnd\.rest_ca_path && !LND_REST_CA\) missing\.push/.test(lift('requireIdentityConfig')) && /LND REST certificate: \$\{LND_REST_CA \?/.test(src),
  'r7 · an unreadable CA file stops the start in requireIdentityConfig (the doctor cannot skip it); the doctor logs the mode');
check(/async function main\(\) \{\n\s+requireIdentityConfig\(\);\n\s+await runStartupDoctor\(\);/.test(src), 'r7 · main() runs requireIdentityConfig() first, before the doctor');
check(/row\('Paths', 'LND REST certificate', 'LND_REST_CA_PATH'/.test(src) && /#LND_REST_CA_PATH=/.test(example), 'r8 · the Settings report and config.env.example list it');
{
  // every module, not only the main file: the macaroon goes onto a REST request in exactly two places
  const where = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => [f, (fs.readFileSync(path.join(__dirname, f), 'utf8').match(/Grpc-Metadata-macaroon/g) || []).length])
    .filter(([, n]) => n > 0).map(([f, n]) => f + ':' + n).sort().join(' ');
  check(where === 'cooperative-chain-bridge.js:1 lij-adapter.js:1', 'r2 · across all modules, REST requests to LND are built only in lndRequestRaw and the bridge helper (' + where + ')');
}

// ── lift the functions as written ──
function build(endpoint, caPem, caPath) {
  const body = [
    'let realChannelScids = null;',
    lift('lndRestTls'), lift('lndRestPort'), lift('lndRequestRaw'), lift('lndRequest'), lift('lndGetOk'),
    lift('findChannelScid'), lift('refreshRealChannelScids'),
    'return { lndRestTls, lndRestPort, lndRequest, lndGetOk, findChannelScid, refreshRealChannelScids, scids: () => realChannelScids };',
  ].join('\n');
  const CONFIG = { lnd: { macaroon: 'abcd01', endpoint, rest_ca_path: caPath || '' }, lsps2: { scid_lookup_attempts: 3, scid_lookup_delay_ms: 10 } };
  const quiet = { log() {}, warn() {}, error() {} };
  return new Function('CONFIG', 'https', 'lndUrl', 'LND_REST_CA', 'console', body)(
    CONFIG, https, new URL(endpoint), caPem || null, quiet);
}
const settle = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ hung: true }), ms))]);

(async () => {
  // the port rule needs no server
  const port = (ep) => build(ep, null).lndRestPort();
  check(port('https://10.0.3.1:443') === 443 && port('https://[::1]:443/') === 443, 'r20 · a written :443 is kept (it fell to 8080)');
  check(port('https://localhost') === 8080 && port('https://10.0.3.1:49153') === 49153 && port('https://localhost:8080') === 8080,
    'r20 · no port = LND\'s 8080; any other written port as written');

  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-endpoint-'));
    const mk = (n) => execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-keyout', path.join(tmp, n + '.key'), '-out', path.join(tmp, n + '.crt'), '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    mk('lnd'); mk('other');
  } catch (e) {
    console.log('  SKIP · functional half (openssl not available: ' + e.message.split('\n')[0] + ')');
    finish(); return;
  }
  const key = fs.readFileSync(path.join(tmp, 'lnd.key')), cert = fs.readFileSync(path.join(tmp, 'lnd.crt'));
  const other = fs.readFileSync(path.join(tmp, 'other.crt'));

  // the module-load read of LND_REST_CA_PATH, as written
  const loadBlock = src.match(/let LND_REST_CA = null;\nif \(CONFIG\.lnd\.rest_ca_path\) \{[\s\S]*?\n\}/);
  check(!!loadBlock, 'r19 · the LND_REST_CA_PATH read is where it was');
  const load = (p) => new Function('CONFIG', 'require', loadBlock[0] + '; return LND_REST_CA;')({ lnd: { rest_ca_path: p } }, require);
  check(Buffer.isBuffer(load(path.join(tmp, 'lnd.crt'))) && load(path.join(tmp, 'missing.crt')) === null && load('') === null,
    'r19 · a readable file is loaded; a missing one or none leaves it empty');

  // a channel point as LND's OpenChannelSync returns it (txid bytes in wire order) and as REST lists it (display order)
  const wire = Buffer.alloc(32); for (let i = 0; i < 32; i++) wire[i] = i + 1;
  const display = Buffer.from(wire).reverse().toString('hex');
  const CP = { funding_txid_bytes: wire, output_index: 1 };
  const LIST = JSON.stringify({ channels: [
    { channel_point: display + ':1', chan_id: '0', alias_scids: ['17592186044416001'], peer_scid_alias: '17592186044416777' },
    { channel_point: 'ff'.repeat(32) + ':0', chan_id: '871234567890', alias_scids: [] },
  ] });
  let mode = 'ok', lastMacaroon = '';
  const server = https.createServer({ key, cert }, (req, res) => {
    lastMacaroon = req.headers['grpc-metadata-macaroon'] || '';
    if (req.url !== '/v1/channels') { res.writeHead(404); res.end('{}'); return; }
    if (mode === 'err') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"code":2,"message":"boom","details":[]}'); return; }
    if (mode === 'cut') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(LIST.length) }); res.write(LIST.slice(0, 40)); setTimeout(() => res.socket.destroy(), 30); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(LIST);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = 'https://127.0.0.1:' + server.address().port;
  try {
    check(server.address().port !== 8080, 'r9 · the test LND answers on port ' + server.address().port + ', not 8080');

    // unchecked (LND_REST_CA_PATH empty)
    const u = build(endpoint, null);
    check(u.lndRestTls().rejectUnauthorized === false && !u.lndRestTls().ca, 'r10 · empty LND_REST_CA_PATH → certificate not checked (as before)');
    check(await u.findChannelScid('02aa', CP) === '17592186044416001', 'r11 · findChannelScid finds the new channel\'s alias at LND_ENDPOINT');
    check(lastMacaroon === 'abcd01', 'r11 · the macaroon travels in the header');
    await u.refreshRealChannelScids();
    const s1 = u.scids();
    check(s1 && s1.has('17592186044416001') && s1.has('17592186044416777') && s1.has('871234567890') && s1.size === 3,
      'r12 · refreshRealChannelScids loads chan_id, alias and peer alias');
    mode = 'err';
    await u.refreshRealChannelScids();
    check(u.scids() === s1 && u.scids().size === 3, 'r13 · an LND error reply keeps the last good list (never an empty one)');
    let threw = null; try { await u.findChannelScid('02aa', CP); } catch (e) { threw = e; }
    check(!!threw && /HTTP 500/.test(threw.message), 'r13 · findChannelScid treats an error reply as an error, not as "no channels"');
    const asData = await u.lndRequest('GET', '/v1/channels', null);
    check(asData && asData.message === 'boom', 'r14 · lndRequest keeps its contract: the error body comes back as data');
    const cold = build(endpoint, null);
    await cold.refreshRealChannelScids();
    check(cold.scids() === null, 'r14 · a first refresh that fails stays cold (null), as before');

    // an answer cut off halfway (LND restarting)
    mode = 'cut';
    const cutGet = await settle(u.lndGetOk('/v1/channels'), 3000);
    check(!cutGet.hung && !!cutGet.e, 'r17 · an answer cut off halfway is an error, not a wait with no end (' + (cutGet.hung ? 'hung' : cutGet.e ? cutGet.e.message : 'resolved') + ')');
    const cutFind = await settle(u.findChannelScid('02aa', CP), 3000);
    check(!cutFind.hung && !!cutFind.e, 'r17 · findChannelScid returns with an error on a cut-off answer');
    const cutRefresh = await settle(u.refreshRealChannelScids(), 3000);
    check(!cutRefresh.hung && u.scids() === s1, 'r17 · the refresh returns and keeps the last good list');
    mode = 'ok';

    // checked (LND_REST_CA_PATH = the authority LND answers with)
    const c = build(endpoint, cert, '/ca.crt');
    check(c.lndRestTls().rejectUnauthorized === true && Buffer.isBuffer(c.lndRestTls().ca), 'r15 · LND_REST_CA_PATH set → certificate checked against it');
    check(await c.findChannelScid('02aa', CP) === '17592186044416001', 'r15 · the right authority → the call goes through');
    const w = build(endpoint, other, '/other.crt');
    let werr = null; try { await w.lndGetOk('/v1/channels'); } catch (e) { werr = e; }
    check(!!werr && /self[- ]signed|unable to verify|certificate/i.test(werr.message), 'r16 · a wrong authority → refused with a certificate error (' + (werr ? werr.code || werr.message : 'none') + ')');
    // asked for, file unreadable → still checked (never quietly off)
    const x = build(endpoint, null, '/unreadable.crt');
    check(x.lndRestTls().rejectUnauthorized === true, 'r18 · LND_REST_CA_PATH set but unreadable → the check stays on');
    let xerr = null; try { await x.lndGetOk('/v1/channels'); } catch (e) { xerr = e; }
    check(!!xerr && /self[- ]signed|unable to verify|certificate/i.test(xerr.message), 'r18 · … and LND\'s self-signed certificate is refused (' + (xerr ? xerr.code || xerr.message : 'none') + ')');

    // the chain bridge's own REST helper, as written
    const bl = lift('lndRequest', bridge, '  ');
    const mkb = (restTls) => new Function('hostname', 'port', 'macaroon', 'restTls', 'https', bl + '; return lndRequest;')(
      '127.0.0.1', server.address().port, 'abcd01', restTls, https);
    const b1 = await settle(mkb(undefined)('/v1/channels'), 3000);
    check(b1.v && Array.isArray(b1.v.channels), 'r21 · bridge helper, no rule handed → unchecked, as before');
    const b2 = await settle(mkb({ ca: cert, rejectUnauthorized: true })('/v1/channels'), 3000);
    check(b2.v && Array.isArray(b2.v.channels), 'r21 · bridge helper, right authority → goes through');
    const b3 = await settle(mkb({ ca: other, rejectUnauthorized: true })('/v1/channels'), 3000);
    check(!!b3.e && /self[- ]signed|unable to verify|certificate/i.test(b3.e.message), 'r21 · bridge helper, wrong authority → refused');
  } finally {
    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  finish();
})().catch((e) => { fails++; console.log('FAIL · ' + (e && e.stack || e)); finish(); });

function finish() {
  console.log(fails ? `\n${fails} FAILED` : '\nall rest-endpoint checks pass');
  process.exitCode = fails ? 1 : 0;
}
