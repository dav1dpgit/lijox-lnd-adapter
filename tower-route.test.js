// 0.128.0 (S69): the tower's routes — POST /v1/tower/put | drop | status.
//   node tower-route.test.js
// The adapter is one module that starts servers on require, so this reads the source: handleTower as written, evaluated
// with stand-ins for the limits and the HTTP helpers; the holder and the request check are the real tower.js.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const T = require('./tower'); const schnorr = require('./schnorr.js'); const btc = require('./btc-tx.js');
const AD = require('./tower-admit.js');   // 0.130.0: the way in
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
// 0.130.0: a stand-in for LND's message signature and its check (the provider's node key signs the voucher text)
const ME = '02' + 'aa'.repeat(32), PROV = '02' + 'c1'.repeat(32), WALLET = '03' + '71'.repeat(32);
const sigBook = new Map();
const signAs = (issuer, text) => { const s = 'z' + sha(Buffer.from(issuer + '|' + text)).toString('hex'); sigBook.set(s + '|' + text, issuer); return s; };
const vStart = src.indexOf('async function handleTowerVoucher('), vEnd = src.indexOf('\n}\n', vStart) + 3;
function make({ on = true, watching = true, ipOk = true, keyOk = true, quota, mode = 'open', maxBytes, authOk = true, paid = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twr-'));
  const tower = on ? T.createTower({ dataDir: dir, quotaBytes: quota, maxBytes, log() {} }) : null;
  const towerAdmit = on ? AD.createAdmit({ dataDir: dir, mode, self: () => ME, held: (k) => tower.has(k), listed: async () => [{ pubkey: PROV, tower: { offered: true } }],
    verifyNode: async (text, sig) => sigBook.get(sig + '|' + text) || null, capacity: async () => 5000000, log() {} }) : null;
  const towerDesk = on ? AD.createDesk({ dataDir: dir, log() {}, sign: async (text) => signAs(ME, text), eligible: async () => (paid ? { ok: true, why: 'its channel has carried a payment' } : { ok: false, why: 'no fee from this wallet yet' }) }) : null;
  const seenAuth = [];
  const lnurlpAuthCheck = (body, action, pk, rec) => { seenAuth.push({ action, pk, rec }); return authOk ? { ok: true } : { ok: false, code: 'bad_signature', status: 401 }; };
  const lim = (v) => ({ hit: () => (v ? { ok: true } : { ok: false, reset_s: 60 }) });
  const out = []; let bodyNext = null;
  const jsonResponse = (res, j, status) => { out.push({ status: status || 200, json: j }); };
  const errResponse = (res, m, status) => { out.push({ status: status || 400, json: { error: m } }); };
  const readBody = async (req, cap) => { if (JSON.stringify(bodyNext).length > cap) throw new Error('Body too large'); return bodyNext; };
  const fn = new Function('tower', 'towerLib', 'towerState', 'towerIpLimit', 'towerKeyLimit', 'jsonResponse', 'errResponse', 'readBody', 'console',
    'towerAdmit', 'TOWER_ADMIT', 'towerDesk', 'towerVoucherKeyLimit', 'lnurlpAuthCheck', 'LOCAL_PUBKEY',
    src.slice(vStart, vEnd) + src.slice(start, end) + '\nreturn handleTower;')(tower, T, { watching }, lim(ipOk), lim(keyOk), jsonResponse, errResponse, readBody, { log() {}, warn() {}, error() {} },
    towerAdmit, mode, towerDesk, lim(keyOk), lnurlpAuthCheck, ME);
  return { tower, towerAdmit, seenAuth, call: async (action, body) => { bodyNext = body; out.length = 0; await fn({}, {}, '1.2.3.4', action); return out[0]; } };
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
  // ── 0.130.0: THE WAY IN ──
  check(vStart > 0 && vEnd > vStart && src.includes("if (action === 'voucher') return handleTowerVoucher(req, res, ip);"), 'handleTowerVoucher is in the adapter and reached through /v1/tower/voucher');
  check(src.includes("const TOWER_ADMIT = String(process.env.TOWER_ADMIT || 'open').trim().toLowerCase() === 'voucher' ? 'voucher' : 'open';"), 'keys are still taken without a voucher unless TOWER_ADMIT=voucher');
  check(perms.permissions.some((p) => p.action === '/lnrpc.Lightning/GetNodeInfo') && perms2.permissions.some((p) => p.action === '/lnrpc.Lightning/GetNodeInfo'), 'both key recipes carry the graph read (GetNodeInfo)');
  for (const [nm, p] of [['bake-permissions.json', perms], ['bake-permissions-nodelegate.json', perms2]]) check(['/lnrpc.Lightning/SignMessage', '/lnrpc.Lightning/VerifyMessage'].every((u) => p.permissions.some((q) => q.action === u)), nm + ' carries SignMessage and VerifyMessage (the voucher\'s two calls)');
  const vkp = (name) => { const s = sha(Buffer.from('voucher ' + name)); return { sk: s, pk: schnorr.pubkey(s).toString('hex') }; };
  const voucher = (issuer, v, towerNode, towerKey) => ({ key: v.pk, issuer, issuer_sig: signAs(issuer, AD.voucherText(v.pk)), use_sig: AD.signUse(v.sk, towerNode, towerKey) });
  const wv = vkp('wallet');
  h = make();   // open
  r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 200 && r.json.admitted === 'open' && h.towerAdmit.standing(key) === 'open', 'open: a put with no voucher is kept and answers admitted "open"');
  r = await h.call('status', Object.assign(mkBody('status', sk), { voucher: voucher(PROV, wv, ME, key) }));
  check(r.status === 200 && r.json.admitted === 'voucher' && r.json.admit === 'open' && r.json.items === 2, 'a status that carries a good voucher turns a held key into "by voucher" (nothing new to upload needed)');
  h = make({ mode: 'voucher' });
  r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 403 && r.json.code === 'voucher_needed' && r.json.admit === 'voucher' && h.tower.summary().items === 0, 'voucher required: a put with no voucher is 403 voucher_needed and nothing is kept');
  r = await h.call('put', Object.assign(mkBody('put', sk, items), { voucher: voucher(PROV, wv, '02' + 'bb'.repeat(32), key) }));
  check(r.status === 403 && r.json.code === 'use_signature' && h.tower.summary().items === 0, 'a voucher whose use line names ANOTHER tower: 403 use_signature, nothing kept');
  r = await h.call('put', Object.assign(mkBody('put', sk, items), { voucher: voucher('02' + '99'.repeat(32), wv, ME, key) }));
  check(r.status === 403 && r.json.code === 'issuer_unknown', 'a voucher of a provider that is not listed: 403 issuer_unknown');
  r = await h.call('status', mkBody('status', sk));
  check(r.status === 200 && r.json.admitted === null && r.json.admit === 'voucher', 'status says how a key gets in here and that this one is not in');
  r = await h.call('put', Object.assign(mkBody('put', sk, items), { voucher: voucher(PROV, wv, ME, key) }));
  check(r.status === 200 && r.json.kept === 2 && r.json.admitted === 'voucher', 'a good voucher: admitted and kept');
  r = await h.call('put', mkBody('put', sk, [{ hint: T.hintOf(OLD), blob: T.encrypt(pen(700), OLD) }]));
  check(r.status === 200 && r.json.kept === 1 && r.json.admitted === 'voucher', 'the next put needs no voucher');
  const dirKeep = fs.mkdtempSync(path.join(os.tmpdir(), 'twr-keep-'));
  { const t0 = T.createTower({ dataDir: dirKeep, log() {} }); t0.put(key, group, items);
    const t1 = T.createTower({ dataDir: dirKeep, log() {} }); const a1 = AD.createAdmit({ dataDir: dirKeep, mode: 'voucher', self: () => ME, held: (k) => t1.has(k), log() {} });
    check(a1.seed(t1.heldKeys()) === 1 && (await a1.admit(key, undefined)).ok, 'a key held from before vouchers stays admitted where a voucher is required'); }
  h = make({ maxBytes: 300 }); r = await h.call('put', mkBody('put', sk, items));
  check(r.status === 507 && r.json.code === 'full' && h.tower.summary().items === 0 && h.towerAdmit.standing(key) === null, 'over the box\'s ceiling for every key together: 507 full, nothing kept, no record of the key');
  // the provider's side
  const VK = vkp('desk').pk, ask = { node_pubkey: WALLET, nonce: 'ab'.repeat(32), signature: 'cd'.repeat(64), voucher_key: VK };
  h = make(); r = await h.call('voucher', ask);
  check(r.status === 200 && r.json.ok && r.json.issuer === ME && r.json.voucher_key === VK && sigBook.get(r.json.issuer_sig + '|' + AD.voucherText(VK)) === ME, 'POST /v1/tower/voucher: a wallet that has paid gets this node\'s signature on its voucher key');
  check(h.seenAuth.length === 1 && h.seenAuth[0].action === 'tower-voucher' && h.seenAuth[0].pk === WALLET && h.seenAuth[0].rec === 'voucher:' + VK, '…the ask is proven by the wallet\'s node key over "voucher:<voucher key>" (action tower-voucher)');
  const sig1 = r.json.issuer_sig; r = await h.call('voucher', ask);
  check(r.status === 200 && r.json.issuer_sig === sig1, '…asked again: the same voucher');
  r = await h.call('voucher', Object.assign({}, ask, { voucher_key: vkp('desk other').pk }));
  check(r.status === 409 && r.json.code === 'already_issued', '…another voucher key for the same wallet: 409 already_issued');
  h = make({ paid: false }); r = await h.call('voucher', ask);
  check(r.status === 403 && r.json.code === 'not_yet' && /no fee/.test(r.json.why), 'a wallet that has paid no fee yet: 403 not_yet, with the reason');
  h = make({ authOk: false }); r = await h.call('voucher', ask);
  check(r.status === 401 && r.json.code === 'auth', 'an ask not proven by the node key: 401');
  r = await h.call('voucher', Object.assign({}, ask, { voucher_key: 'zz' }));
  check(r.status === 400 && r.json.code === 'bad_request', 'a malformed ask: 400');
  h = make({ on: false }); r = await h.call('voucher', ask);
  check(r.status === 404 && r.json.code === 'not_offered', 'a box with the tower off gives no vouchers: 404');
  check(/async function towerVoucherEligible\(wallet\) \{[\s\S]{0,900}'open_fee'[\s\S]{0,900}total_satoshis_sent/.test(src), 'eligible = a fee from the wallet in the ledger, or its channel having carried a payment');
  console.log(`${fails ? 'FAIL' : 'PASS'} · tower-route · ${n - fails} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
})();
