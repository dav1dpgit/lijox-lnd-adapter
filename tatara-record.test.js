// 0.97.0 (S58 — LIJOX's Tatara, step 5 slice 1): the registry record's tatara block. The adapter's canonicalRegisterMsg
// (read out of lij-adapter.js) against vectors lij-worker 0.11.0's canonicalRegisterMsg produced (S58), and the block
// tatara.js builds against the worker's rules.   node tatara-record.test.js
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const { createTatara } = require('./tatara');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const from = src.indexOf('function canonicalRegisterMsg(f) {');
const to = src.indexOf('// 0.87.0: the address rule');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
if (from < 0 || to < from) { console.log('FAIL · cannot find the canonical in lij-adapter.js'); process.exit(1); }
const ctx = { encodeURIComponent, String, Number };
vm.createContext(ctx);
vm.runInContext(src.slice(from, to) + '\nthis.canonicalRegisterMsg = canonicalRegisterMsg; this.TATARA_FIELDS = TATARA_FIELDS;', ctx);

const b = { name: 'Plotzwerks LSP-1', pubkey: '02' + 'ab'.repeat(32), endpoint: 'https://lsp.example.com', route_endpoint: 'https://lsp.example.com', route_macaroon: 'a1b2', wss_url: 'wss://ws.example.com', fee_ppm: 250, fee_base_sats: 0, channel_open_fee_sats: 100, max_channel_size_sats: 2000000, supports_jit: true, ts: 1700000000 };
const T = { v: 1, sizes: [50000, 100000, 250000, 1000000], min_people: 3, max_people: 6, countdown_s: 600, wake_window_s: 180, max_retries: 2, strikes: 4, max_pools_per_size: 3, max_pools_total: 10, max_list_per_size: 60, max_fee_rate: 20, channel_pools: false, channel_sizes: [], relay_url: 'wss://lsp.example.com/tatara/relay', relay_for_others: true, forward_payouts: true, forward_coin_checks: true, coin_check_url: null, ring_hash: null };
const T2 = Object.assign({}, T, { coin_check_url: 'https://filters.example.com/coin', ring_hash: 'ab'.repeat(32), forward_payouts: false });
// produced by lij-worker 0.11.0 (docs/pending/worker-0.11.0-tatara-record.diff applied), S58
const V3a = 'lijox-register:v3:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Flsp.example.com:wss%3A%2F%2Fws.example.com:https%3A%2F%2Flsp.example.com:a1b2:250:0:100:2000000:1::0:1:50000%2C100000%2C250000%2C1000000:3:6:600:180:2:4:3:10:60:20:0::wss%3A%2F%2Flsp.example.com%2Ftatara%2Frelay:1:1:1::';
const V3b = 'lijox-register:v3:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Flsp.example.com:wss%3A%2F%2Fws.example.com:https%3A%2F%2Flsp.example.com:a1b2:250:0:100:2000000:1:https%3A%2F%2Ffilters.example.com:1:1:50000%2C100000%2C250000%2C1000000:3:6:600:180:2:4:3:10:60:20:0::wss%3A%2F%2Flsp.example.com%2Ftatara%2Frelay:1:0:1:https%3A%2F%2Ffilters.example.com%2Fcoin:abababababababababababababababababababababababababababababababab';
const V1 = 'lijox-register:v1:02abababababababababababababababababababababababababababababababab:1700000000:Plotzwerks%20LSP-1:https%3A%2F%2Flsp.example.com:wss%3A%2F%2Fws.example.com:https%3A%2F%2Flsp.example.com:a1b2:250:0:100:2000000:1';
const WORKER_FIELDS = 'v,sizes,min_people,max_people,countdown_s,wake_window_s,max_retries,strikes,max_pools_per_size,max_pools_total,max_list_per_size,max_fee_rate,channel_pools,channel_sizes,relay_url,relay_for_others,forward_payouts,forward_coin_checks,coin_check_url,ring_hash';

check(ctx.canonicalRegisterMsg(Object.assign({}, b, { tatara: T })) === V3a, 'r1 a record with the block and no filter server = the registry\'s v3 bytes');
check(ctx.canonicalRegisterMsg(Object.assign({}, b, { filter_url: 'https://filters.example.com', filter_sp: true, tatara: T2 })) === V3b, 'r2 with a filter server, a coin-check address and a ring hash = the registry\'s v3 bytes');
check(ctx.canonicalRegisterMsg(b) === V1, 'r3 without the block: v1, byte for byte as before');
check(ctx.TATARA_FIELDS.map((x) => x[0]).join(',') === WORKER_FIELDS, 'r4 TATARA_FIELDS is the worker\'s list, in its order');
const blk = createTatara({ env: { TATARA_ENABLED: 'true' }, publicHttpsUrl: 'https://lsp.example.com' }).recordBlock();
check(JSON.stringify(blk) === JSON.stringify(T), 'r5 the block tatara.js builds from the defaults is exactly the worker-checked block (keys, order, values)');
check(Object.keys(blk).join(',') === WORKER_FIELDS && ctx.canonicalRegisterMsg(Object.assign({}, b, { tatara: blk })) === V3a, 'r5 its keys are the worker\'s and it signs to the same bytes');
const reg = src.slice(src.indexOf('async function registerWithRegistry()'), src.indexOf('// ── 0.73.0: console notes'));
check(/const tb = tatara\.recordBlock\(\);\s*\n\s*if \(tb\) \{ body\.tatara = tb;/.test(reg) && reg.indexOf('body.tatara = tb') < reg.indexOf('canonicalRegisterMsg(body)'),
  'r6 the registration adds the block only when the module gives one, before the message is signed');
console.log(fails ? 'FAIL · tatara-record · ' + fails + ' failed' : 'PASS · tatara-record (r1–r6)');
process.exit(fails ? 1 : 0);
