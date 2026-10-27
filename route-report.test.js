// 0.113.0 (S63, DP 2026-10-26 — pathfinding r9 §3a–§3c): ROUTING REPORTS and the node-first ask.
//   r1 the record a report binds (routeReportRecordId — the twin of lij-core registry_client::route_report_record_id,
//      the engine's own vectors); r2 the route: a signed report imports only the temporary refusals that sat on routes
//      this adapter handed out for that hash (XImportMissionControl's body shape), permanent ones and strangers' pairs
//      are skipped, the per-wallet hourly cap holds, a bad signature or a replayed nonce is refused, and nothing is
//      imported from a route ask's own ignored_pairs / ignored_nodes (Off really means off, §3e); r3 the handout memory
//      remembers an answer's pairs for 15 minutes; r4 the journal line names every hop.
// The functions are read out of lij-adapter.js and run in a sandbox with the real registry.js (secp256k1), a fake LND
// and a fresh nonce store — nothing listens.
//   node route-report.test.js
'use strict';
const fs = require('fs'); const path = require('path'); const vm = require('vm'); const crypto = require('crypto');
const secp256k1 = require('secp256k1');
const registry = require('./registry');

const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const from = src.indexOf('function lnurlpRegisterRecordId(name, hashes) {');
const to = src.indexOf('// 0.68.0: one boot sweep');
const from2 = src.indexOf('// ── 0.113.0 (S63, DP 2026-10-26 — docs/design/pathfinding/pathfinding-r9.md');
const to2 = src.indexOf('function lnurlpMetadata(name, host) {');
if (from < 0 || to < 0 || to < from || from2 < 0 || to2 < 0 || to2 < from2) { console.log('FAIL cannot find the auth/report blocks in lij-adapter.js'); process.exit(1); }
const block = src.slice(from, to) + '\n' + src.slice(from2, to2);
for (const must of ['function routeReportRecordId(', 'function routeHandoutRemember(', 'async function routeReportHandle(', 'function routeHopsLine(']) {
  if (!block.includes(must)) { console.log('FAIL the block lacks ' + must); process.exit(1); }
}

let pass = 0, fail = 0;
const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };

const LOCAL = '03' + '11'.repeat(32);
const lndCalls = [];
let lndAnswer = {};
const registryNonceStore = new registry.NonceStore();
const ctx = {
  crypto, Buffer, String, Array, Number, Map, Set, Date, Math, JSON, console, parseInt, process: { env: {} },
  registryBuildSignedMessage: registry.buildSignedMessage, registryVerifySignature: registry.verifySignature, registryNonceStore,
  LOCAL_PUBKEY: LOCAL,
  lndPost: async (p, body) => { lndCalls.push({ p, body }); return lndAnswer; },
  errResponse: (res, msg, status) => { res.out = { status: status || 400, data: { ok: false, error: msg } }; return true; },
  jsonResponse: (res, data, status) => { res.out = { status: status || 200, data }; return true; },
};
vm.createContext(ctx);
vm.runInContext(block + '\nthis.routeReportRecordId = routeReportRecordId; this.routeHandoutRemember = routeHandoutRemember; this.routeReportHandle = routeReportHandle; this.routeHopsLine = routeHopsLine; this.routeHandouts = routeHandouts; this.routeReports = routeReports;', ctx);
const { routeReportRecordId, routeHandoutRemember, routeReportHandle, routeHopsLine, routeHandouts, routeReports } = ctx;

// ── r1 the record rule — the engine's vectors (lij-core registry_client::tests::route_report_record_id_rule)
const H = 'ab'.repeat(32);
t('r1 no refusals: the hash lowercased, count 0, the sha256 of nothing', routeReportRecordId('AB'.repeat(32), []) === H + ':0:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', routeReportRecordId('AB'.repeat(32), []));
const two = [{ from: '02AA', to: '03BB', scid: '123456789', amount_msat: '31020000', code: 'temporary', attempt: 3 }, { from: '02cc', to: '03dd', scid: '5', amount_msat: '7', code: 'permanent' }];
const PINNED = H + ':2:c7cb69c11102edfd7e855283051a57954ee30f825fc95ed93497bdce28ff693d';
t('r1 two refusals: lowercased, sorted, joined with a newline each; the attempt number never enters — the pinned vector', routeReportRecordId(H, two) === PINNED, routeReportRecordId(H, two));
t('r1 order, case and number-vs-string do not change the record', routeReportRecordId(H, [{ from: '02cc', to: '03dd', scid: 5, amount_msat: 7, code: 'permanent' }, { from: '02aa', to: '03bb', scid: 123456789, amount_msat: 31020000, code: 'TEMPORARY' }]) === PINNED);
t('r1 a non-object entry is skipped, as the engine skips none but reads blanks (the route refuses it later)', routeReportRecordId(H, [null, 'x', 7]) === H + ':0:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

// ── the wallet that signs, and the fake routes this adapter "handed out"
const priv = crypto.randomBytes(32); const pub = Buffer.from(secp256k1.publicKeyCreate(priv, true)).toString('hex');
const other = crypto.randomBytes(32);
const COINGATE = '02' + '42'.repeat(32), SEDGE = '02' + '77'.repeat(32), BABYLON = '03' + '40'.repeat(32), STRANGER = '02' + '99'.repeat(32);
function proof(recordId, key = priv, pk = pub) {
  const { nonce } = registryNonceStore.issue();
  const digest = registry.buildSignedMessage('route-report', nonce, pk, recordId);
  return { node_pubkey: pk, nonce, signature: Buffer.from(secp256k1.ecdsaSign(digest, key).signature).toString('hex') };
}
const hash = crypto.randomBytes(32).toString('hex');
const routes = [{ hops: [{ pub_key: SEDGE, chan_id: '1057000000000000001', amt_to_forward_msat: '31021000' }, { pub_key: COINGATE, chan_id: '1057000000000000002', amt_to_forward_msat: '31020500' }, { pub_key: BABYLON, chan_id: '1057000000000000003', amt_to_forward_msat: '31020000' }] }];
routeHandoutRemember(hash, routes);
const hd = routeHandouts.get(hash);
t('r3 the handout remembers the answer\'s pairs: this node → Sedgefield → CoinGate → Babylon', hd && hd.pairs.size === 3 && hd.pairs.has(LOCAL + ':' + SEDGE) && hd.pairs.has(SEDGE + ':' + COINGATE) && hd.pairs.has(COINGATE + ':' + BABYLON));
t('r4 the journal line names every hop as prefix:scid:msat', routeHopsLine(routes) === `${SEDGE.slice(0, 8)}:1057000000000000001:31021000 -> ${COINGATE.slice(0, 8)}:1057000000000000002:31020500 -> ${BABYLON.slice(0, 8)}:1057000000000000003:31020000`, routeHopsLine(routes));
t('r4 no routes: none', routeHopsLine([]) === 'none' && routeHopsLine(null) === 'none');

const call = async (body) => { const res = {}; await routeReportHandle(body, res, '1.2.3.4'); return res.out; };
// ── r2 a proper report: CoinGate refused temporarily on a route of ours → imported; the permanent one and the stranger's pair skipped
const failures = [
  { attempt: 1, from: COINGATE, to: BABYLON, scid: '1057000000000000003', amount_msat: '31020000', code: 'temporary' },
  { attempt: 2, from: SEDGE, to: COINGATE, scid: '1057000000000000002', amount_msat: '31020500', code: 'permanent' },
  { attempt: 3, from: STRANGER, to: BABYLON, scid: '9', amount_msat: '31020000', code: 'temporary' },
  { attempt: 4, from: LOCAL, to: SEDGE, scid: '1057000000000000001', amount_msat: '31021000', code: 'temporary' },
];
(async () => {
  let r = await call(Object.assign({ client_pubkey: pub, payment_hash: hash, failures }, proof(routeReportRecordId(hash, failures))));
  t('r2 a signed report is accepted: 4 refusals received, 1 imported', r.status === 200 && r.data.ok && r.data.received === 4 && r.data.imported === 1, JSON.stringify(r));
  t('r2 the skips are named: a stranger\'s pair, a permanent code, our own link', r.data.skipped && r.data.skipped.not_on_route === 1 && r.data.skipped.permanent === 1 && r.data.skipped.own_link === 1 && r.data.skipped.malformed === 0, JSON.stringify(r.data.skipped));
  const imp = lndCalls.find((c) => c.p === '/v2/router/x/importhistory');
  t('r2 XImportMissionControl: one pair, from CoinGate to Babylon as base64, a fail_time now and the msat/sat amounts, force false', imp && imp.body.force === false && imp.body.pairs.length === 1 && imp.body.pairs[0].node_from === Buffer.from(COINGATE, 'hex').toString('base64') && imp.body.pairs[0].node_to === Buffer.from(BABYLON, 'hex').toString('base64') && imp.body.pairs[0].history.fail_amt_msat === '31020000' && imp.body.pairs[0].history.fail_amt_sat === '31020' && /^\d{9,}$/.test(imp.body.pairs[0].history.fail_time), JSON.stringify(imp && imp.body));
  t('r2 the counters: received 1, imported 1, refused 0; a line for the console', routeReports.received === 1 && routeReports.imported === 1 && routeReports.refused === 0 && routeReports.last.length === 1 && /1 imported/.test(routeReports.last[0].line));
  // a replayed proof
  const replay = Object.assign({ client_pubkey: pub, payment_hash: hash, failures }, proof(routeReportRecordId(hash, failures)));
  await call(replay); r = await call(replay);
  t('r2 the same proof again: refused (nonce_already_used)', r.status === 401 && /nonce_already_used/.test(r.data.error) && lndCalls.length === 2, JSON.stringify(r));
  // another key's signature, the body unchanged
  r = await call(Object.assign({ client_pubkey: pub, payment_hash: hash, failures }, proof(routeReportRecordId(hash, failures), other, Buffer.from(secp256k1.publicKeyCreate(other, true)).toString('hex'))));
  t('r2 a stranger\'s signature over the wallet\'s body: 403', r.status === 403 && lndCalls.length === 2, JSON.stringify(r));
  // the body changed after signing
  const tampered = Object.assign({ client_pubkey: pub, payment_hash: hash, failures: failures.map((f) => Object.assign({}, f, { to: SEDGE })) }, proof(routeReportRecordId(hash, failures)));
  r = await call(tampered);
  t('r2 a body that differs from what was signed: 401, nothing imported', r.status === 401 && lndCalls.length === 2, JSON.stringify(r));
  // a hash this adapter handed no route out for: nothing imported
  const h2 = crypto.randomBytes(32).toString('hex');
  r = await call(Object.assign({ client_pubkey: pub, payment_hash: h2, failures: [failures[0]] }, proof(routeReportRecordId(h2, [failures[0]]))));
  t('r2 a report on a hash with no route of ours: accepted, 0 imported (not_on_route 1)', r.status === 200 && r.data.imported === 0 && r.data.skipped.not_on_route === 1 && lndCalls.length === 2, JSON.stringify(r));
  // the per-wallet cap: 20 an hour
  const big = Array.from({ length: 25 }, (_, i) => { const pk = '02' + i.toString(16).padStart(2, '0').repeat(32); routeHandoutRemember(hash, [{ hops: [{ pub_key: COINGATE, chan_id: '1' }, { pub_key: pk, chan_id: String(100 + i) }] }]); return { from: COINGATE, to: pk, scid: String(100 + i), amount_msat: '1000', code: 'temporary' }; });
  r = await call(Object.assign({ client_pubkey: pub, payment_hash: hash, failures: big }, proof(routeReportRecordId(hash, big))));
  t('r2 the per-wallet cap: 25 fresh refusals on routes of ours → 18 imported (20 an hour; two spent by the accepted reports above), 7 capped', r.status === 200 && r.data.imported === 18 && r.data.skipped.capped === 7, JSON.stringify(r.data));
  // malformed entries never reach LND
  const bad = [{ from: 'zz', to: BABYLON, scid: '3', amount_msat: '1', code: 'temporary' }, { from: COINGATE, to: BABYLON, scid: '3', amount_msat: '0', code: 'temporary' }];
  r = await call(Object.assign({ client_pubkey: pub, payment_hash: hash, failures: bad }, proof(routeReportRecordId(hash, bad))));
  t('r2 malformed entries are skipped, not imported', r.status === 200 && r.data.imported === 0 && r.data.skipped.malformed === 2);
  // the fields
  r = await call({ client_pubkey: pub, payment_hash: 'nothex', failures: [] });
  t('r2 a bad hash: 400', r.status === 400);
  r = await call({ client_pubkey: pub, payment_hash: hash, failures: [] });
  t('r2 no proof at all: 401', r.status === 401, JSON.stringify(r));
  // §3e Off really means off: nothing in this block ever imports from a route ask — the only importer is the report
  const importers = (src.match(/\/v2\/router\/x\/importhistory/g) || []).length;
  const inHandler = src.slice(src.indexOf('async function routeReportHandle('), src.indexOf('function lnurlpMetadata(name, host) {')).includes('/v2/router/x/importhistory');
  t('r2 §3e: XImportMissionControl is called from the report handler alone (a route ask\'s ignored_pairs / ignored_nodes never enter LND\'s memory)', importers === 1 && inHandler, 'importers in the file: ' + importers);
  // the route ask passes ignored_nodes through, validated
  const askBlock = src.slice(src.indexOf("const ignoredNodes  = body.ignored_nodes;"), src.indexOf("lndBody.use_mission_control = true;"));
  t('r2 the route ask: ignored_nodes validated (66 hex, at most 20) and handed to LND as bytes', /ignoredNodes\.length > 20/.test(askBlock) && /\^\[0-9a-f\]\{66\}\$/.test(askBlock) && /lndBody\.ignored_nodes = ignoredNodes\.map/.test(askBlock));
  t('r2 the route ask answers no_route as a plain 200 when LND finds no path (the engine asks once more avoiding only the channels)', /error: 'no_route', routes: \[\], lnd_error/.test(src));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
