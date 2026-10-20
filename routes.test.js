// 0.108.0 (S61, Step A — docs/design/routes/routes-r1.md) — the LIJOX record's `routes`: the v4 canonical (the registry's
// twin, pinned by vectors lij-worker 0.13.0 produces), the reach rule, and buildRoutes (what the box registers, read from
// its own front doors). The functions are read out of lij-adapter.js and run in a sandbox with a stand-in https module —
// nothing listens.
//   node routes.test.js
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const from = src.indexOf('function canonicalRegisterMsg(f) {');
const to = src.indexOf('// 0.71.0: verbatim twin of the worker\'s canonicalUnregisterMsg');
if (from < 0 || to < 0 || to < from) { console.log('FAIL cannot find the registry block in lij-adapter.js'); process.exit(1); }
const block = src.slice(from, to);

let pass = 0, fail = 0;
const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };

// doors: url → { status, body, headers } | 'timeout' | absent (refused)
function sandbox(doors, pub) {
  const https = {
    get(url, opts, cb) {
      const handlers = {};
      const req = { on(ev, f) { handlers[ev] = f; return req; }, destroy(e) { if (handlers.error) handlers.error(e || new Error('destroyed')); } };
      setImmediate(() => {
        const r = doors[url];
        if (!r) { if (handlers.error) handlers.error(new Error('connect ECONNREFUSED')); return; }
        if (r === 'timeout') { if (handlers.timeout) handlers.timeout(); return; }
        const rh = {};
        const res = { statusCode: r.status, headers: r.headers || {}, on(ev, f) { rh[ev] = f; return res; } };
        cb(res);
        if (rh.data) rh.data(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        if (rh.end) rh.end();
      });
      return req;
    },
  };
  const ctx = { https, CONFIG: { public: Object.assign({ filter_url: '', reach: '', routes_extra: [] }, pub || {}) }, setImmediate, Date, JSON, Number, String, encodeURIComponent, console: { log() {} } };
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.canonicalRegisterMsg = canonicalRegisterMsg; this.buildRoutes = buildRoutes; this.routesStatus = routesStatus; this.checkFilterServer = checkFilterServer; this.filterStatus = filterStatus; this.ROUTE_REACH = ROUTE_REACH; this.wssUrlOk = wssUrlOk;', ctx);
  return ctx;
}

const D = 'https://direct-lsp.example.com', DW = 'wss://direct-ws.example.com', DF = 'https://direct-filters.example.com';
const C = 'https://lsp.example.com', CW = 'wss://ws.example.com', CF = 'https://filters.example.com';
const CFH = { 'cf-ray': '8d1f2a3b4c5d6e7f-SEA', server: 'cloudflare' };
const health = { status: 200, body: { ok: true } };
const healthCf = { status: 200, body: { ok: true }, headers: CFH };
const tip = { status: 200, body: { height: 972224, hash: 'x' } };
const spinfo = { status: 200, body: { format: 'spcommit-v1' } };

(async () => {
  // ── the canonical: vectors from lij-worker 0.13.0's canonicalRegisterMsg (S61) ──
  const b = { name: 'Plotzwerks LSP-1', pubkey: '02' + 'ab'.repeat(32), endpoint: D, route_endpoint: D, route_macaroon: 'a1b2', wss_url: DW, fee_ppm: 250, supports_jit: true, ts: 1700000000, filter_url: DF, filter_sp: true,
    routes: [{ reach: 'direct', endpoint: D, wss_url: DW, filter_url: DF }, { reach: 'cloudflare', endpoint: C, wss_url: CW, filter_url: null }] };
  const V4 = 'lijox-register:v4:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Fdirect-lsp.example.com:wss%3A%2F%2Fdirect-ws.example.com:https%3A%2F%2Fdirect-lsp.example.com:a1b2:250:0:0:0:1:https%3A%2F%2Fdirect-filters.example.com:1:0::0:0:0:0:0:0:0:0:0:0:0:::0:0:0:::direct%7Chttps%3A%2F%2Fdirect-lsp.example.com%7Cwss%3A%2F%2Fdirect-ws.example.com%7Chttps%3A%2F%2Fdirect-filters.example.com%3Bcloudflare%7Chttps%3A%2F%2Flsp.example.com%7Cwss%3A%2F%2Fws.example.com%7C';
  const T = { v: 1, sizes: [50000, 100000], min_people: 3, max_people: 6, countdown_s: 600, wake_window_s: 180, max_retries: 2, strikes: 4, max_pools_per_size: 3, max_pools_total: 10, max_list_per_size: 60, max_fee_rate: 20, channel_pools: true, channel_sizes: [100000], relay_url: 'wss://direct-lsp.example.com/tatara/relay', relay_for_others: true, forward_payouts: true, forward_coin_checks: true, coin_check_url: 'https://direct-filters.example.com/coin', ring_hash: 'ab'.repeat(32) };
  const V4T = 'lijox-register:v4:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Fdirect-lsp.example.com:wss%3A%2F%2Fdirect-ws.example.com:https%3A%2F%2Fdirect-lsp.example.com:a1b2:250:0:0:0:1:https%3A%2F%2Fdirect-filters.example.com:1:1:50000%2C100000:3:6:600:180:2:4:3:10:60:20:1:100000:wss%3A%2F%2Fdirect-lsp.example.com%2Ftatara%2Frelay:1:1:1:https%3A%2F%2Fdirect-filters.example.com%2Fcoin:abababababababababababababababababababababababababababababababab:direct%7Chttps%3A%2F%2Fdirect-lsp.example.com%7Cwss%3A%2F%2Fdirect-ws.example.com%7Chttps%3A%2F%2Fdirect-filters.example.com%3Bcloudflare%7Chttps%3A%2F%2Flsp.example.com%7Cwss%3A%2F%2Fws.example.com%7C';
  const V4ONE = 'lijox-register:v4:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Fdirect-lsp.example.com:wss%3A%2F%2Fdirect-ws.example.com:https%3A%2F%2Fdirect-lsp.example.com:a1b2:250:0:0:0:1::0:0::0:0:0:0:0:0:0:0:0:0:0:::0:0:0:::cloudflare%7Chttps%3A%2F%2Fdirect-lsp.example.com%7Cwss%3A%2F%2Fdirect-ws.example.com%7C';
  const c = sandbox({});
  t('v4 two-route record = the registry\'s v4 bytes', c.canonicalRegisterMsg(b) === V4, c.canonicalRegisterMsg(b));
  t('v4 with a tatara block = the registry\'s bytes (the block before the routes)', c.canonicalRegisterMsg({ ...b, tatara: T }) === V4T);
  t('v4 one-door record, no filter = the registry\'s bytes', c.canonicalRegisterMsg({ ...b, filter_url: null, filter_sp: false, routes: [{ reach: 'cloudflare', endpoint: D, wss_url: DW, filter_url: null }] }) === V4ONE);
  t('a record without routes still signs v3 / v2 / v1 (unchanged)', c.canonicalRegisterMsg({ ...b, routes: undefined, tatara: T }).startsWith('lijox-register:v3:') && c.canonicalRegisterMsg({ ...b, routes: [] }).startsWith('lijox-register:v2:') && c.canonicalRegisterMsg({ ...b, routes: null, filter_url: null }).startsWith('lijox-register:v1:'));
  t('the three reach words; the wss rule', JSON.stringify(c.ROUTE_REACH) === '["direct","cloudflare","tor"]' && c.wssUrlOk(DW) && !c.wssUrlOk('ws://x.org') && !c.wssUrlOk('wss://x.org/') && !c.wssUrlOk('https://x.org'));

  // ── buildRoutes: what the box registers ──
  const base = { https_url: D, wss_url: DW, filter_url: DF, reach: 'direct' };
  // direct as claimed: the door answers without Cloudflare's header; the filter server answers → offered
  let s = sandbox({ [D + '/health']: health, [DF + '/tip']: tip, [DF + '/sp/info']: spinfo }, base);
  await s.checkFilterServer(); let r = await s.buildRoutes();
  t('direct, no cf-ray → route 1 direct with its filter', r.length === 1 && r[0].reach === 'direct' && r[0].endpoint === D && r[0].wss_url === DW && r[0].filter_url === DF, JSON.stringify(r));
  // direct claimed, but the door answers through Cloudflare → registered as cloudflare, the note says so
  s = sandbox({ [D + '/health']: healthCf, [DF + '/tip']: tip, [DF + '/sp/info']: spinfo }, base);
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('direct claimed, cf-ray seen → registered as cloudflare, not as claimed', r[0].reach === 'cloudflare' && /not as claimed/.test(s.routesStatus.notes.join('\n')), s.routesStatus.notes.join(' | '));
  // direct claimed, the door does not answer → the claim stands (nothing proven)
  s = sandbox({ [DF + '/tip']: tip, [DF + '/sp/info']: spinfo }, base);
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('direct claimed, no answer → the claim stands', r[0].reach === 'direct' && /no answer/.test(s.routesStatus.notes.join('\n')));
  // unset reach: registered as cloudflare; a hint when the door answers without Cloudflare's header
  s = sandbox({ [C + '/health']: health }, { https_url: C, wss_url: CW, filter_url: '', reach: '' });
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('unset, no cf-ray → cloudflare with the set-PUBLIC_REACH hint', r[0].reach === 'cloudflare' && r[0].filter_url === null && /set PUBLIC_REACH=direct/.test(s.routesStatus.notes[0]), s.routesStatus.notes[0]);
  s = sandbox({ [C + '/health']: healthCf }, { https_url: C, wss_url: CW, filter_url: '', reach: '' });
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('unset, cf-ray → cloudflare, no hint (the Umbrel today)', r[0].reach === 'cloudflare' && /answers through Cloudflare/.test(s.routesStatus.notes[0]) && !/set PUBLIC_REACH/.test(s.routesStatus.notes[0]), s.routesStatus.notes[0]);
  // a wrong word → cloudflare with a note
  s = sandbox({ [C + '/health']: healthCf }, { https_url: C, wss_url: CW, filter_url: '', reach: 'vpn' });
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('PUBLIC_REACH=vpn → cloudflare, the note names the words', r[0].reach === 'cloudflare' && /not one of direct\|cloudflare\|tor/.test(s.routesStatus.notes[0]));
  // route 1's filter server down → route 1 carries no filter (as 0.87.0's rule)
  s = sandbox({ [D + '/health']: health }, base);
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('route 1\'s filter server silent → no filter on route 1', r[0].filter_url === null);
  // the UM890's intended shape: direct names first, the tunnel names as route 2 (cf-ray on route 2, its filter answers)
  const um = { ...base, routes_extra: [{ n: 2, reach: 'cloudflare', https_url: C, wss_url: CW, filter_url: CF }] };
  s = sandbox({ [D + '/health']: health, [DF + '/tip']: tip, [DF + '/sp/info']: spinfo, [C + '/health']: healthCf, [CF + '/tip']: tip }, um);
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('two doors: direct first, the tunnel second, both filters offered', r.length === 2 && r[0].reach === 'direct' && r[1].reach === 'cloudflare' && r[1].endpoint === C && r[1].wss_url === CW && r[1].filter_url === CF, JSON.stringify(r));
  t('the record signs v4 with both doors', c.canonicalRegisterMsg({ ...b, routes: r }).startsWith('lijox-register:v4:') && c.canonicalRegisterMsg({ ...b, routes: r }).endsWith(encodeURIComponent('direct|' + D + '|' + DW + '|' + DF + ';cloudflare|' + C + '|' + CW + '|' + CF)));
  // route 2's filter server silent → route 2 without a filter, with a note
  s = sandbox({ [D + '/health']: health, [DF + '/tip']: tip, [DF + '/sp/info']: spinfo, [C + '/health']: healthCf }, um);
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('route 2\'s filter server silent → route 2 without a filter', r.length === 2 && r[1].filter_url === null && /not offered on route 2/.test(s.routesStatus.notes.join('\n')));
  // route 2 claims direct but answers through Cloudflare → cloudflare
  s = sandbox({ [D + '/health']: health, [C + '/health']: healthCf }, { ...base, routes_extra: [{ n: 2, reach: 'direct', https_url: C, wss_url: CW, filter_url: '' }] });
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('route 2 claims direct, cf-ray seen → cloudflare', r.length === 2 && r[1].reach === 'cloudflare');
  // malformed secondary routes are skipped, never refused: the box keeps its first door
  const bads = {
    'a wrong word': { n: 2, reach: 'vpn', https_url: C, wss_url: CW, filter_url: '' },
    'no reach': { n: 2, reach: '', https_url: C, wss_url: CW, filter_url: '' },
    'an http endpoint': { n: 2, reach: 'cloudflare', https_url: 'http://lsp.example.com', wss_url: CW, filter_url: '' },
    'a ws:// link': { n: 2, reach: 'cloudflare', https_url: C, wss_url: 'ws://ws.example.com', filter_url: '' },
    'no wss': { n: 2, reach: 'cloudflare', https_url: C, wss_url: '', filter_url: '' },
    'the same endpoint as route 1': { n: 2, reach: 'cloudflare', https_url: D, wss_url: CW, filter_url: '' },
  };
  let every = true;
  for (const [k, x] of Object.entries(bads)) {
    s = sandbox({ [D + '/health']: health, [C + '/health']: healthCf }, { ...base, routes_extra: [x] });
    await s.checkFilterServer(); r = await s.buildRoutes();
    if (!(r.length === 1 && r[0].reach === 'direct' && /route 2 skipped/.test(s.routesStatus.notes.join('\n')))) { every = false; console.log('   (not skipped: ' + k + ' → ' + JSON.stringify(r) + ' ' + s.routesStatus.notes.join(' | ') + ')'); }
  }
  t(Object.keys(bads).length + ' malformed route-2 shapes skipped, route 1 kept', every);
  // a bad ROUTE_2_FILTER_URL: the route stays, without a filter
  s = sandbox({ [D + '/health']: health, [C + '/health']: healthCf }, { ...base, routes_extra: [{ n: 2, reach: 'cloudflare', https_url: C, wss_url: CW, filter_url: 'http://filters.example.com' }] });
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('a bad ROUTE_2_FILTER_URL → route 2 kept without a filter', r.length === 2 && r[1].filter_url === null && /ROUTE_2_FILTER_URL is not a plain https/.test(s.routesStatus.notes.join('\n')));
  // three doors
  s = sandbox({ [D + '/health']: health, [C + '/health']: healthCf, ['https://t.example.com/health']: health }, { ...base, routes_extra: [{ n: 2, reach: 'cloudflare', https_url: C, wss_url: CW, filter_url: '' }, { n: 3, reach: 'tor', https_url: 'https://t.example.com', wss_url: 'wss://t.example.com', filter_url: '' }] });
  await s.checkFilterServer(); r = await s.buildRoutes();
  t('three doors register three routes', r.length === 3 && r[2].reach === 'tor');
  t('routesStatus carries the routes and a stamp (/health and the console read it)', s.routesStatus.routes.length === 3 && s.routesStatus.checked_ms > 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
