// 0.87.0 (S52) — the LIJOX record's block-filter server: the canonical (the registry's twin, pinned by vectors the
// registry worker 0.8.0 produces), the address rule, and the check that decides whether the server is offered.
// The functions are read out of lij-adapter.js and run in a sandbox with a stand-in https module — nothing listens.
//   node registry-filter.test.js
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const from = src.indexOf('function canonicalRegisterMsg(f) {');
const to = src.indexOf('// 0.71.0: verbatim twin of the worker\'s canonicalUnregisterMsg');
if (from < 0 || to < 0 || to < from) { console.log('FAIL cannot find the registry block in lij-adapter.js'); process.exit(1); }
const block = src.slice(from, to);

let pass = 0, fail = 0;
const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };

function sandbox(routes, filterUrl) {
  const https = {
    get(url, opts, cb) {
      const handlers = {};
      const req = { on(ev, f) { handlers[ev] = f; return req; }, destroy(e) { if (handlers.error) handlers.error(e || new Error('destroyed')); } };
      setImmediate(() => {
        const r = routes[url];
        if (!r) { if (handlers.error) handlers.error(new Error('connect ECONNREFUSED')); return; }
        if (r === 'timeout') { if (handlers.timeout) handlers.timeout(); return; }
        const rh = {};
        const res = { statusCode: r.status, on(ev, f) { rh[ev] = f; return res; } };
        cb(res);
        if (rh.data) rh.data(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        if (rh.end) rh.end();
      });
      return req;
    },
  };
  const ctx = { https, CONFIG: { public: { filter_url: filterUrl } }, setImmediate, Date, JSON, Number, String, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.canonicalRegisterMsg = canonicalRegisterMsg; this.filterUrlOk = filterUrlOk; this.checkFilterServer = checkFilterServer; this.filterStatus = filterStatus;', ctx);
  return ctx;
}

(async () => {
  // the canonical: vectors from lij-worker 0.8.0's canonicalRegisterMsg (S52) — a v1 record unchanged, v2 with the server
  const b = { name: 'Plotzwerks LSP-1', pubkey: '02' + 'ab'.repeat(32), endpoint: 'https://lsp.example.com', route_endpoint: 'https://lsp.example.com', route_macaroon: 'a1b2', wss_url: 'wss://ws.example.com', fee_ppm: 250, fee_base_sats: 0, channel_open_fee_sats: 100, max_channel_size_sats: 2000000, supports_jit: true, ts: 1700000000 };
  const V1 = 'lijox-register:v1:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Flsp.example.com:wss%3A%2F%2Fws.example.com:https%3A%2F%2Flsp.example.com:a1b2:250:0:100:2000000:1';
  const V2 = 'lijox-register:v2:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Flsp.example.com:wss%3A%2F%2Fws.example.com:https%3A%2F%2Flsp.example.com:a1b2:250:0:100:2000000:1:https%3A%2F%2Ffilters.example.com:1';
  const V2b = 'lijox-register:v2:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Flsp.example.com:wss%3A%2F%2Fws.example.com:https%3A%2F%2Flsp.example.com:a1b2:250:0:100:2000000:1:https%3A%2F%2Fbox.example.org%3A8443%2Flij%2Ffilters:0';
  const c = sandbox({}, '');
  t('v1 record (no filter server) = the registry\'s v1 bytes', c.canonicalRegisterMsg(b) === V1);
  t('v2 record = the registry\'s v2 bytes', c.canonicalRegisterMsg({ ...b, filter_url: 'https://filters.example.com', filter_sp: true }) === V2);
  t('v2 record with a port and a path, no index', c.canonicalRegisterMsg({ ...b, filter_url: 'https://box.example.org:8443/lij/filters', filter_sp: false }) === V2b);

  // the address rule
  t('plain https addresses pass', c.filterUrlOk('https://filters.example.com') && c.filterUrlOk('https://box.example.org:8443/lij/filters'));
  t('every bad shape is refused', ['', 'http://x.org', 'https://x.org/', 'https://', 'https://-x.org', 'https://a b.org', 'https://user@x.org', 'https://x.org?q=1', 'https://x.org:port', 'https://x.org:123456', 'https://' + 'a'.repeat(200) + '.org'].every((u) => !c.filterUrlOk(u)));

  // the check: a server that answers /tip and serves the index
  const U = 'https://filters.example.com';
  let s = sandbox({ [U + '/tip']: { status: 200, body: { height: 969500, hash: 'x' } }, [U + '/sp/info']: { status: 200, body: { format: 'spcommit-v1', start_height: 840000 } } }, U);
  await s.checkFilterServer();
  t('answers + index → offered with sp', s.filterStatus.ok === true && s.filterStatus.sp === true, JSON.stringify(s.filterStatus));
  // answers, no index (404)
  s = sandbox({ [U + '/tip']: { status: 200, body: { height: 969500 } }, [U + '/sp/info']: { status: 404, body: { error: 'no silent-payment index on this box' } } }, U);
  await s.checkFilterServer();
  t('answers, no index → offered without sp', s.filterStatus.ok === true && s.filterStatus.sp === false, JSON.stringify(s.filterStatus));
  // an unknown index format is not "serves the index"
  s = sandbox({ [U + '/tip']: { status: 200, body: { height: 969500 } }, [U + '/sp/info']: { status: 200, body: { format: 'other' } } }, U);
  await s.checkFilterServer();
  t('unknown index format → sp false', s.filterStatus.ok === true && s.filterStatus.sp === false);
  // no answer, a 502, a body that is not a tip → not offered, with a plain sentence
  for (const [label, routes] of [['refused', {}], ['timeout', { [U + '/tip']: 'timeout' }], ['502', { [U + '/tip']: { status: 502, body: 'Bad Gateway' } }], ['no height', { [U + '/tip']: { status: 200, body: { hello: 1 } } }]]) {
    s = sandbox(routes, U);
    await s.checkFilterServer();
    t('/tip ' + label + ' → not offered', s.filterStatus.ok === false && /did not answer \/tip/.test(s.filterStatus.note), JSON.stringify(s.filterStatus));
  }
  // a bad address is never asked
  s = sandbox({}, 'http://filters.example.com');
  await s.checkFilterServer();
  t('a bad address → not offered, says why', s.filterStatus.ok === false && /not a plain https/.test(s.filterStatus.note));
  // none configured
  s = sandbox({}, '');
  await s.checkFilterServer();
  t('none configured → nothing offered', s.filterStatus.ok === false && s.filterStatus.note === 'none configured');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
