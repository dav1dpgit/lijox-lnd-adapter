// 0.128.0 (S69): the tower's routes — POST /v1/tower/put | drop | status.
//   node tower-route.test.js
// The adapter is one module that starts servers on require, so this reads the source: handleTower as written, evaluated
// with stand-ins for the limits and the HTTP helpers; the holder and the request check are the real tower.js.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const T = require('./tower'); const schnorr = require('./schnorr.js'); const btc = require('./btc-tx.js');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0, n = 0;
const check = (cond, m) => { n++; if (!cond) { fails++; console.log('FAIL · ' + m); } else console.log('  ok · ' + m); };
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const start = src.indexOf('async function handleTower(');
const end = src.indexOf('\n}\n', start) + 3;
check(start > 0 && end > start, 'handleTower is in the adapter');
const rIdx = src.indexOf("path.startsWith('/v1/tower/') && method === 'POST'"), aIdx = src.indexOf("if (path.startsWith('/lsps/registry/'))");
check(rIdx > 0 && aIdx > rIdx, 'the routes are dispatched before the registry router and the auth gate (public, signature-gated)');
check(src.includes("path.startsWith('/v1/tower/')) kitHolder.openCors(res)"), 'every wallet origin may call them');
check(/tower:\s+towerCapability\(\)/.test(src) && (src.match(/towerCapability\(\),/g) || []).length === 2, 'the capability is announced on /health and in get_info');
check(src.includes("const TOWER_ENABLED = String(process.env.TOWER_ENABLED || 'false').toLowerCase() === 'true';"), 'off unless TOWER_ENABLED=true');
check(src.includes("offered: towerState.watching"), 'offered only while the box is watching');
check(src.includes("'/v2/chainkit/bestblock'") && src.includes("'/v2/chainkit/blockhash?block_height='") && src.includes("'/v2/chainkit/block?block_hash=' + encodeURIComponent(hashB64)"), 'the blocks are read through LND\'s ChainKit');
const perms = JSON.parse(fs.readFileSync(path.join(__dirname, 'bake-permissions.json'), 'utf8')), perms2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'bake-permissions-nodelegate.json'), 'utf8'));
for (const [nm, p] of [['bake-permissions.json', perms], ['bake-permissions-nodelegate.json', perms2]]) {
  const txt = JSON.stringify(p);
  check(['/chainrpc.ChainKit/GetBestBlock', '/chainrpc.ChainKit/GetBlockHash', '/chainrpc.ChainKit/GetBlock', '/walletrpc.WalletKit/PublishTransaction'].every((u) => txt.includes('"' + u + '"')), nm + ' carries the three block reads and the publish');
  check(!txt.includes('SendPaymentSync'), nm + ' does not name SendPaymentSync (LND 0.21 refuses the bake)');
}

const sk = sha(Buffer.from('route key 1')), key = schnorr.pubkey(sk).toString('hex'), sk2 = sha(Buffer.from('route key 2'));
const OLD = 'd6ac4a5e61657c4c604dcde855a1db74ec6b3e54f32695d72c5e11c7761ea1b4', group = 'c1'.repeat(16);
const pen = (fee) => btc.serialize({ version: 2, locktime: 0, inputs: [{ txid: OLD, vout: 0, sequence: 0xffffffff, witness: [Buffer.alloc(71, 1)] }], outputs: [{ value: 70000 - fee, script: Buffer.from('0014' + '44'.repeat(20), 'hex') }] });
const nowS = () => Math.floor(Date.now() / 1000);
const mkBody = (action, s, items, ts) => {
  const b = { key, ts: ts == null ? nowS() : ts }; if (action !== 'status') b.group = group; let ish = '';
  if (action === 'put') { b.items = items.map((i) => ({ hint: i.hint, blob: i.blob.toString('base64') })); ish = T.itemsSha(items); }
  b.signature = schnorr.sign(s, sha(Buffer.from(T.signedText(action, key, action === 'status' ? '' : group, b.ts, ish), 'utf8')), Buffer.alloc(32)).toString('hex');
  return b;
};
const items = [{ hint: T.hintOf(OLD), blob: T.encrypt(pen(600), OLD) }, { hint: T.hintOf(OLD), blob: T.encrypt(pen(1500), OLD) }];
function make({ on = true, watching = true, ipOk = true, keyOk = true, quota } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twr-'));
  const tower = on ? T.createTower({ dataDir: dir, quotaBytes: quota, log() {} }) : null;
  const lim = (v) => ({ hit: () => (v ? { ok: true } : { ok: false, reset_s: 60 }) });
  const out = []; let bodyNext = null;
  const jsonResponse = (res, j, status) => { out.push({ status: status || 200, json: j }); };
  const errResponse = (res, m, status) => { out.push({ status: status || 400, json: { error: m } }); };
  const readBody = async (req, cap) => { if (JSON.stringify(bodyNext).length > cap) throw new Error('Body too large'); return bodyNext; };
  const fn = new Function('tower', 'towerLib', 'towerState', 'towerIpLimit', 'towerKeyLimit', 'jsonResponse', 'errResponse', 'readBody', 'console',
    src.slice(start, end) + '\nreturn handleTower;')(tower, T, { watching }, lim(ipOk), lim(keyOk), jsonResponse, errResponse, readBody, { log() {}, warn() {}, error() {} });
  return { tower, call: async (action, body) => { bodyNext = body; out.length = 0; await fn({}, {}, '1.2.3.4', action); return out[0]; } };
}
(async () => {
  let h = make();
  let r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 200 && r.json.ok && r.json.kept === 2 && r.json.items === 2, 'put: two items are kept');
  check(h.tower.match([OLD]).length === 1 && h.tower.match([OLD])[0].held.length === 2, '…and the holder finds them under the old state\'s id');
  r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 200 && r.json.kept === 0 && r.json.items === 2, 'put: the same items sent again are kept once');
  r = await h.call('status', mkBody('status', sk));
  check(r.status === 200 && r.json.items === 2 && r.json.watching === true && r.json.quota_bytes === 5 * 1024 * 1024 && r.json.keep_days_silent === 400, 'status: the count, the room, the keeping time, and that the box is watching');
  r = await h.call('put', mkBody('put', sk2, items));
  check(r.status === 401 && r.json.code === 'signature' && h.tower.summary().items === 2, 'signed by another key: 401, nothing kept');
  r = await h.call('put', mkBody('put', sk, items, nowS() - 700));
  check(r.status === 400 && r.json.code === 'bad_ts', 'a request eleven minutes old: 400');
  r = await h.call('put', Object.assign(mkBody('put', sk, items), { key: '02' + 'a'.repeat(64) }));
  check(r.status === 400 && r.json.code === 'bad_key', 'a node key in place of a tower key: 400');
  r = await h.call('drop', mkBody('drop', sk));
  check(r.status === 200 && r.json.dropped === 2 && h.tower.match([OLD]).length === 0, 'drop: the channel\'s items are gone');
  r = await h.call('peek', mkBody('status', sk));
  check(r.status === 404, 'any other action: 404');
  h = make({ watching: false });
  r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 503 && r.json.code === 'not_watching' && h.tower.summary().items === 0, 'a box that cannot read blocks keeps nothing: 503 not_watching');
  r = await h.call('status', mkBody('status', sk));
  check(r.status === 200 && r.json.watching === false, '…and its status says it is not watching');
  h = make({ on: false });
  r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 404 && r.json.code === 'not_offered', 'TOWER_ENABLED not true: 404 not_offered');
  h = make({ ipOk: false }); r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 429 && h.tower.summary().items === 0, 'the address limit: 429');
  h = make({ keyOk: false }); r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 429 && h.tower.summary().items === 0, 'the key limit: 429 (after the signature is proven)');
  h = make({ quota: 300 }); r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 413 && r.json.code === 'quota' && r.json.quota_bytes === 300, 'over the room for one wallet key: 413 with the numbers');
  h = make(); const many = []; for (let i = 0; i < 65; i++) many.push({ hint: T.hintOf(OLD), blob: T.encrypt(pen(600 + i), OLD) });
  r = await h.call('put', mkBody('put', sk, many));
  check(r.status === 400 && r.json.code === 'bad_items', '65 items in one request: 400');
  console.log(`${fails ? 'FAIL' : 'PASS'} · tower-route · ${n - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
