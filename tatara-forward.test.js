// 0.100.0 (S58 — LIJOX's Tatara step 5, slice 5): forwarding for other providers' pools and the backup sender
// (tatara-forward.js), with a real relay on a real socket for the payout.   node tatara-forward.test.js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const crypto = require('crypto');
const schnorr = require('./schnorr.js');
const { createForward, txid, BACKUP_DELAY_S } = require('./tatara-forward');
const { createRelay } = require('./tatara-relay');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const sk = (s) => crypto.createHash('sha256').update(s).digest();
const pk = (k) => schnorr.pubkey(k).toString('hex');
function ev(k, kind, tags, content, created_at = 1800000000) {
  const pubkey = pk(k);
  const id = crypto.createHash('sha256').update(JSON.stringify([0, pubkey, created_at, kind, tags, content]), 'utf8').digest('hex');
  return { id, pubkey, created_at, kind, tags, content, sig: schnorr.sign(k, Buffer.from(id, 'hex'), crypto.randomBytes(32)).toString('hex') };
}
const dsha = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest().reverse().toString('hex');

(async () => {
  // a real relay at another provider, with a room
  const relay = createRelay({});
  const server = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  server.on('upgrade', (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const OTHER_RELAY = 'wss://other.example.org/tatara/relay';
  const realUrl = 'ws://127.0.0.1:' + server.address().port + '/tatara/relay';
  const POOL = pk(sk('pool')), TOKEN = crypto.randomBytes(32).toString('hex');
  relay.open(TOKEN, POOL, 'c'.repeat(32));

  let S = { forward_payouts: true, forward_coin_checks: true, coin_check_url: '' };
  const gets = [];
  let answer = (u) => ({ status: 200, json: { txid: new URL(u).searchParams.get('txid'), vout: 0, unspent: true, confirmations: 7, tx: 'aa', proof: 'bb' } });
  const providers = [
    { pubkey: '02aa', tatara: { relay_url: OTHER_RELAY, relay_for_others: true, coin_check_url: 'https://filters.other.org/coin' } },
    { pubkey: '02bb', tatara: { relay_url: 'wss://quiet.example.org/tatara/relay', relay_for_others: false, coin_check_url: null } },
    { pubkey: '02cc' },
  ];
  const published = [];
  let publish = async (hex) => { published.push(hex); return { ok: true }; };
  let t = 1_800_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-'));
  const F = createForward({
    now: () => t, dataDir: dir, settings: () => S, ownRelayUrl: () => 'wss://lsp.example.com/tatara/relay',
    listProviders: async () => providers, getJson: async (u) => { gets.push(u); return answer(u); },
    publishTx: (h) => publish(h), wsConnect: (u) => new (require('ws').WebSocket)(u.replace(OTHER_RELAY, realUrl)),
  });

  // F1 — the payout
  const alice = sk('alice');
  const pay = ev(alice, 4, [['p', POOL]], 'sealed?iv=AAAA');
  let r = await F.forwardPayout({ relay_url: OTHER_RELAY, token: TOKEN, event: pay });
  check(r.code === 200 && r.body.ok === true && relay.rooms()[0].events === 1, 'F1 a sealed payout to a declared relay: posted with the token, the relay said OK');
  check((await F.forwardPayout({ relay_url: 'wss://lsp.example.com/tatara/relay', token: TOKEN, event: pay })).body.reason === 'own_relay', 'F1 never to this provider\'s own relay');
  check((await F.forwardPayout({ relay_url: 'wss://quiet.example.org/tatara/relay', token: TOKEN, event: pay })).body.reason === 'relay_not_declared', 'F1 a relay that does not relay for others: refused');
  check((await F.forwardPayout({ relay_url: 'wss://unknown.example.org/r', token: TOKEN, event: pay })).body.reason === 'relay_not_declared', 'F1 a relay no registered provider declares: refused (never an open proxy)');
  const forged = Object.assign({}, pay, { content: 'changed' });
  check((await F.forwardPayout({ relay_url: OTHER_RELAY, token: TOKEN, event: forged })).body.reason === 'bad_event', 'F1 an event whose id or signature does not hold: refused');
  check((await F.forwardPayout({ relay_url: OTHER_RELAY, token: TOKEN, event: ev(alice, 1, [['p', POOL]], 'x') })).body.reason === 'bad_event', 'F1 not kind 4: refused');
  r = await F.forwardPayout({ relay_url: OTHER_RELAY, token: TOKEN, event: ev(alice, 4, [['p', pk(sk('elsewhere'))]], 'x') });
  check(r.code === 502 && r.body.ok === false && /not for this pool/.test(r.body.relay_said), 'F1 the relay refuses (another pool\'s tag): the refusal is the answer');
  S = Object.assign({}, S, { forward_payouts: false });
  check((await F.forwardPayout({ relay_url: OTHER_RELAY, token: TOKEN, event: pay })).code === 404, 'F1 TATARA_FORWARD_PAYOUTS=false: not offered');
  // F2 — the coin check
  S = { forward_payouts: true, forward_coin_checks: true, coin_check_url: '' };
  const TX = 'ab'.repeat(32);
  gets.length = 0;
  r = await F.forwardCoin({ txid: TX, vout: 1 });
  check(r.code === 200 && r.body.proof === 'bb' && gets[0] === 'https://filters.other.org/coin?txid=' + TX + '&vout=1', 'F2 no coin-check address here: a registered provider\'s answers, passed on as it came');
  S = Object.assign({}, S, { coin_check_url: 'https://filters.mine.org/coin' });
  gets.length = 0;
  await F.forwardCoin({ txid: TX, vout: 0 });
  check(gets[0] === 'https://filters.mine.org/coin?txid=' + TX + '&vout=0', 'F2 with its own coin-check address: answered from its own');
  check((await F.forwardCoin({ txid: 'zz', vout: 0 })).code === 400 && (await F.forwardCoin({ txid: TX, vout: -1 })).code === 400, 'F2 a malformed question: 400');
  answer = () => ({ status: 200, json: { txid: 'cd'.repeat(32) } });
  check((await F.forwardCoin({ txid: TX, vout: 0 })).code === 502, 'F2 an answer about another transaction: not passed on');
  // F3 — the transaction ids the backup sender keys on
  const legacy = '0100000001a6b97044d03da79c005b20ea9c0e1a6d9dc12d9f7b91a5911c9030a439eed8f5000000004948304502206e21798a42fae0e854281abd38bacd1aeed3ee3738d9e1446618c4571d1090db022100e2ac980643b0b82c0e88ffdfec6b64e3e6ba35e7ba5fdd7d5d6cc8d25c6b241501ffffffff0100f2052a010000001976a914404371705fa9bd789a2fcd52d2c580b65d35549d88ac00000000';
  check(txid(legacy) === '5a4ebf66822b0b2d56bd9dc64ece0bc38ee7844a23ff1d7320a88c5fdb2ad3e2', 'F3 a legacy transaction\'s id (block 80,000)');
  const ver = '02000000', ins = '01' + '11'.repeat(32) + '00000000' + '00' + 'ffffffff', outs = '01' + '50c3000000000000' + '16' + '0014' + '22'.repeat(20), lock = '00000000';
  const wit = '02' + '47' + '33'.repeat(71) + '21' + '02' + '44'.repeat(32);
  const segwit = ver + '0001' + ins + outs + wit + lock;
  check(txid(segwit) === dsha(Buffer.from(ver + ins + outs + lock, 'hex')) && txid(segwit) !== dsha(Buffer.from(segwit, 'hex')), 'F3 a segwit transaction\'s id is over its witness-free bytes');
  check(txid(ver + '0001' + ins + outs + wit) === '', 'F3 a cut segwit transaction: no id');
  // F4 — the backup sender
  const AID = 'd'.repeat(32);
  check(F.keepBackup(AID, legacy, [segwit]).ok && F.keepBackup(AID, legacy, [segwit]).kept === 'already', 'F4 a backup kept once');
  check(!F.keepBackup('e'.repeat(32), 'zz', [segwit]).ok && !F.keepBackup('e'.repeat(32), legacy, []).ok, 'F4 a malformed backup: refused');
  await F.backupTick();
  check(published.length === 0, 'F4 nothing sent in the first 3 minutes (the members send them)');
  t += (BACKUP_DELAY_S + 1) * 1000;
  publish = async (hex) => { published.push(hex); return hex === legacy ? { ok: false, error: 'transaction already exists' } : { ok: false, error: 'missing inputs' }; };
  await F.backupTick();
  check(published.length === 2 && published[0] === legacy && F.backups()[0].sent === 1 && !F.backups()[0].done, 'F4 after 3 minutes: the funding (already known = sent), then the exit (refused — tried again later)');
  publish = async (hex) => { published.push(hex); return { ok: true }; };
  t += 60000; await F.backupTick();
  check(F.backups()[0].done && F.backups()[0].sent === 2, 'F4 a minute later the exit goes: every transaction out');
  S = Object.assign({}, S, { coin_check_url: 'https://filters.mine.org/coin' });
  answer = (u) => ({ status: 200, json: { txid: new URL(u).searchParams.get('txid'), confirmations: 6 } });
  t += 60000; await F.backupTick();
  check(F.backups().length === 0, 'F4 the last exit 6 deep: the copy is deleted');
  F.keepBackup('f'.repeat(32), legacy, [segwit]);
  t += 14 * 86400 * 1000 + 1000; await F.backupTick();
  check(F.backups().length === 0, 'F4 a copy 14 days old is deleted whatever happened');
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? 'FAIL · tatara-forward · ' + fails + ' failed' : 'PASS · tatara-forward (F1–F4)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · tatara-forward threw: ' + (e && e.stack || e)); process.exit(1); });
