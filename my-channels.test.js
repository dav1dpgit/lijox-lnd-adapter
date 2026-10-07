// 0.92.0 (S57, DP 2026-10-07 14:15 "Proposal 4 … as long as it does not lock up the device") — MY-CHANNELS.
// A wallet asks, before it connects, which channels this LSP holds under its node key, so a copy of a wallet with no
// record of a channel can stop and ask its person before LND force-closes that channel (Oct 6: the SA tester's
// 35,400-sat JIT channel). Read-only; the answer goes to the key holder only (the recover-close challenge).
//   node my-channels.test.js
// The adapter is one module that starts servers on require, so this reads the source: the MY-CHANNELS block as
// written, evaluated with stand-ins for LND, the nonce store and the HTTP helpers.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

const start = src.indexOf('const MY_CHANNELS_DOMAIN');
const end = src.indexOf('\n}\n', src.indexOf('async function handleMyChannels(')) + 3;
check(start > 0 && end > start, 'the MY-CHANNELS block is where it was');
const block = start > 0 ? src.slice(start, end) : '';
check(/\/lsps\/registry\/my-channels' && method === 'POST'/.test(src), 'the route is dispatched (POST /lsps/registry/my-channels)');
const myIdx = src.indexOf("path === '/lsps/registry/my-channels'"), regIdx = src.indexOf("if (path.startsWith('/lsps/registry/'))");
check(myIdx > 0 && regIdx > myIdx, 'it is dispatched before the registry router and the auth gate');

const PK = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32), NONCE = 'cd'.repeat(32);
function load({ recovered = PK, verifyDown = false, lndDown = false, nonceOk = true, otherSeen = null } = {}) {
  const calls = { verify: [], get: [], consumed: [], registered: [] };
  const copyWatch = { register: (pk, sid) => { calls.registered.push([pk, sid]); return true; }, lastOtherSeenS: () => otherSeen };
  const answers = [];
  const lndRequest = async (method, path, body) => {
    calls.verify.push({ method, path, body });
    if (verifyDown) return { message: 'permission denied' };
    return { pubkey: recovered, valid: false };
  };
  const lndGet = async (path) => {
    calls.get.push(path);
    if (lndDown && path === '/v1/channels') throw new Error('connect ECONNREFUSED');
    if (path === '/v1/channels') return { channels: [
      { remote_pubkey: PK, channel_point: 'aa11:0', capacity: '35400', remote_balance: '0', active: true, pending_htlcs: [], commitment_type: 'STATIC_REMOTE_KEY' },
      { remote_pubkey: OTHER, channel_point: 'bb22:1', capacity: '50000', remote_balance: '1200', active: true },
      { remote_pubkey: PK, channel_point: 'cc33:1', capacity: '60000', remote_balance: '12000', active: false, pending_htlcs: [{}], commitment_type: 'ANCHORS' },
    ] };
    if (path === '/v1/channels/pending') return {
      pending_open_channels: [{ channel: { remote_node_pub: PK, channel_point: 'dd44:0', capacity: '40000', commitment_type: 'STATIC_REMOTE_KEY' } }, { channel: { remote_node_pub: OTHER, channel_point: 'ee55:0', capacity: '1' } }],
      waiting_close_channels: [{ channel: { remote_node_pub: PK, channel_point: 'ff66:0', capacity: '9' } }],
    };
    return {};
  };
  const registryNonceStore = { consume: (n) => { calls.consumed.push(n); return nonceOk ? { ok: true } : { ok: false, code: 'nonce_unknown' }; } };
  const mk = new Function('isRateLimited', 'readBody', 'errResponse', 'jsonResponse', 'lndRequest', 'lndGet', 'registryNonceStore', 'console', 'copyWatch',
    block + '\n; return { handleMyChannels, MY_CHANNELS_DOMAIN };');
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const api = mk(() => false, async (req) => req.body,
    (res, msg, code) => { answers.push({ code: code || 400, body: { error: msg } }); },
    (res, body, code) => { answers.push({ code: code || 200, body }); },
    lndRequest, lndGet, registryNonceStore, quiet, copyWatch);
  return { api, calls, answers };
}
const ask = async (s, body) => { await s.api.handleMyChannels({ body }, {}, '1.2.3.4'); return s.answers[s.answers.length - 1]; };
const good = { node_pubkey: PK, nonce: NONCE, signature: 'd7sig' };

(async () => {
  if (!block) { console.log('FAIL · 0.92.0 not cut'); process.exit(1); }
  // m1 — the key holder gets this key's open channels (and pending opens), nothing of anyone else's
  let s = load();
  let a = await ask(s, good);
  check(a.code === 200 && a.body.ok === true, 'm1 a good signature is answered');
  check(JSON.stringify(a.body.channels) === JSON.stringify([
    { chan_point: 'aa11:0', capacity_sats: 35400, wallet_side_sats: 0, active: true, pending_htlcs: 0, commitment_type: 'STATIC_REMOTE_KEY' },
    { chan_point: 'cc33:1', capacity_sats: 60000, wallet_side_sats: 12000, active: false, pending_htlcs: 1, commitment_type: 'ANCHORS' },
  ]), 'm1 only this key\'s open channels, with size, the wallet\'s side, active, HTLCs in flight and the commitment type');
  check(JSON.stringify(a.body.pending_open) === JSON.stringify([{ chan_point: 'dd44:0', capacity_sats: 40000, commitment_type: 'STATIC_REMOTE_KEY' }]), 'm1 this key\'s pending opens; no closes, no other key');
  check(s.calls.verify.length === 1 && s.calls.verify[0].path === '/v1/verifymessage' &&
    Buffer.from(s.calls.verify[0].body.msg, 'base64').toString('utf8') === 'lij-my-channels-v1:' + NONCE, 'm1 the signature is checked over "lij-my-channels-v1:" + nonce');
  check(JSON.stringify(s.calls.consumed) === JSON.stringify([NONCE]), 'm1 the nonce is used up');
  // m2 — a signature by another key: refused, the nonce left alone, LND's channels never read
  s = load({ recovered: OTHER });
  a = await ask(s, good);
  check(a.code === 401 && a.body.reason === 'bad_signature' && s.calls.consumed.length === 0 && s.calls.get.length === 0, 'm2 another key\'s signature: 401, nonce kept, no channel read');
  // m3 — a used or unknown nonce: refused
  s = load({ nonceOk: false });
  a = await ask(s, good);
  check(a.code === 400 && a.body.ok === false && s.calls.get.length === 0, 'm3 a spent nonce: 400, no channel read');
  // m4 — LND cannot verify: 503, so the wallet starts as today
  s = load({ verifyDown: true });
  a = await ask(s, good);
  check(a.code === 503 && a.body.reason === 'verify_unavailable', 'm4 no verify: 503 verify_unavailable');
  // m5 — LND down when listing: 503
  s = load({ lndDown: true });
  a = await ask(s, good);
  check(a.code === 503 && a.body.reason === 'lnd_unavailable', 'm5 LND down: 503 lnd_unavailable');
  // m6 — bad input never reaches LND
  s = load();
  a = await ask(s, { node_pubkey: 'zz', nonce: NONCE, signature: 'x' });
  check(a.code === 400 && s.calls.verify.length === 0, 'm6 a malformed key: 400 before LND');
  a = await ask(s, { node_pubkey: PK, nonce: 'short', signature: 'x' });
  check(a.code === 400 && s.calls.verify.length === 0, 'm6 a malformed nonce: 400 before LND');
  // m8 — 0.93.0: a session in the signed request is registered after the checks; the answer says when another copy was seen
  s = load({ otherSeen: 12 });
  a = await ask(s, Object.assign({ session: 'ab'.repeat(16) }, good));
  check(JSON.stringify(s.calls.registered) === JSON.stringify([[PK, 'ab'.repeat(16)]]) && a.body.other_copy_seen_s === 12, 'm8 the session is registered and another copy\'s last sign of life is named (12 s)');
  s = load({ recovered: OTHER });
  a = await ask(s, Object.assign({ session: 'ab'.repeat(16) }, good));
  check(s.calls.registered.length === 0, 'm8 a bad signature registers no session');
  s = load();
  a = await ask(s, good);
  check(s.calls.registered.length === 0 && !('other_copy_seen_s' in a.body), 'm8 no session sent: nothing registered, no copy field');
  // m7 — read-only: the handler closes nothing and writes nothing
  check(!/leaseForceClose|closechannel|\/v1\/channels\/[^'"]*close|POST'?\s*,\s*'\/v1\/channels/.test(block.replace(/\/\/[^\n]*/g, '')), 'm7 the handler closes nothing (no close call in its code)');
  console.log(fails ? 'FAIL · my-channels · ' + fails + ' failed' : 'PASS · my-channels (m1–m8)');
  process.exit(fails ? 1 : 0);
})();
