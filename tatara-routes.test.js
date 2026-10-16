// 0.98.0 (S58 — LIJOX's Tatara step 5, slices 2–3): the waiting list's routes and their signatures (tatara.js), with
// real BIP-340 seat keys, a stand-in for LND's VerifyMessage / SignMessage, a clock of its own and a temporary folder.
//   node tatara-routes.test.js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const schnorr = require('./schnorr.js');
const { createTatara, seatMsg, seatSignedMsg, noticeMsg } = require('./tatara');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tatara-'));
let t = 1_800_000_000_000;
const clock = { now: () => t, go: (s) => { t += s * 1000; } };
const ts = () => Math.floor(t / 1000);
const wakes = [];
let signing = true;
const nodeSig = (msg) => 'zb' + crypto.createHash('sha256').update(msg).digest('hex');
function make() {
  return createTatara({
    env: { TATARA_ENABLED: 'true', TATARA_SIZES: '50000,100000' }, publicHttpsUrl: 'https://lsp.example.com', dataDir: dir, now: clock.now,
    verifyWalletSig: async (msg, sig) => { const m = /^good:(0[23][0-9a-f]{64})$/.exec(sig); return m && sig === 'good:' + m[1] && msg.startsWith('lij-tatara-seat:v1|') ? m[1] : '02' + '00'.repeat(32); },
    signNotice: async (msg) => (signing ? nodeSig(msg) : ''),
    sendWakePush: async (pk, kind) => { wakes.push([pk, kind]); },
  });
}
let T = make();
const answers = [];
const jr = (res, body, code) => answers.push({ code: code || 200, body });
async function post(action, body, ip = '1.2.3.4') {
  await T.handle({ body }, {}, '/tatara/' + action, 'POST', ip, async (r) => r.body, jr);
  return answers.pop();
}
const key = (i) => { const sk = crypto.createHash('sha256').update('seat' + i).digest(); return { sk, pk: schnorr.pubkey(sk).toString('hex') }; };
const wallet = (i) => '02' + crypto.createHash('sha256').update('wallet' + i).digest('hex');
const sig = (k, action, fields) => schnorr.sign(k.sk, seatMsg(action, fields), crypto.randomBytes(32)).toString('hex');
async function seatUp(i, size = 50000) {
  const k = key(i), pk = wallet(i), now = ts();
  const r = await post('seat', { route: 'chain', size, seat_pk: k.pk, node_pubkey: pk, ts: now, signature: 'good:' + pk });
  return { k, pk, id: r.body.seat_id, r };
}
async function act(s, action, extra = {}) {
  const now = ts();
  const fields = [s.id];
  if (['open', 'report', 'announce'].includes(action)) fields.push(extra.attempt_id);
  if (action === 'report') fields.push(extra.outcome);
  if (action === 'announce') fields.push(crypto.createHash('sha256').update(extra.announcement, 'utf8').digest('hex'));
  fields.push(now);
  return post(action, Object.assign({ seat_id: s.id, ts: now, sig: sig(s.k, action, fields) }, extra));
}
const bodies = (r) => (r.body.notices || []).map((n) => JSON.parse(n.body));
// a pool announcement as the creating phone hands it over: a nostr event signed by the pool's key
const poolSk = crypto.createHash('sha256').update('pool').digest();
const poolPk = schnorr.pubkey(poolSk).toString('hex');
function nostrEvent(sk, kind, tags, content, created_at) {
  const pubkey = schnorr.pubkey(sk).toString('hex');
  const id = crypto.createHash('sha256').update(JSON.stringify([0, pubkey, created_at, kind, tags, content]), 'utf8').digest('hex');
  return { id, pubkey, created_at, kind, tags, content, sig: schnorr.sign(sk, Buffer.from(id, 'hex'), crypto.randomBytes(32)).toString('hex') };
}
const ANN = JSON.stringify(nostrEvent(poolSk, 2022, [], JSON.stringify({ type: 'new_pool', public_key: poolPk }), 1800000000));

(async () => {
  // R1 — the seat: signed by the wallet's node key
  const k0 = key(0), w0 = wallet(0);
  let r = await post('seat', { route: 'chain', size: 50000, seat_pk: k0.pk, node_pubkey: w0, ts: ts(), signature: 'good:' + wallet(9) });
  check(r.code === 401 && r.body.reason === 'bad_signature', 'R1 a seat signed by another wallet\'s key: 401');
  r = await post('seat', { route: 'chain', size: 50000, seat_pk: k0.pk, node_pubkey: w0, ts: ts() - 601, signature: 'good:' + w0 });
  check(r.code === 400 && r.body.reason === 'stale', 'R1 a seat request 601 s old: refused');
  r = await post('seat', { route: 'channel', size: 50000, seat_pk: k0.pk, node_pubkey: w0, ts: ts(), signature: 'good:' + w0 });
  check(r.code === 409 && r.body.reason === 'route_not_offered', 'R1 the channel route where no channel pool is offered: 409 route_not_offered (0.103.0: the route exists; R10 has the pools)');
  r = await post('seat', { route: 'chain', size: 50000, seat_pk: 'zz', node_pubkey: w0, ts: ts(), signature: 'good:' + w0 });
  check(r.code === 400, 'R1 a malformed seat key: refused');
  const s0 = await seatUp(0);
  check(s0.r.code === 200 && /^[0-9a-f]{32}$/.test(s0.id), 'R1 a seat signed by the wallet\'s own key: taken, a seat id');
  check(seatSignedMsg('chain', 50000, k0.pk, 5) === `lij-tatara-seat:v1|chain|50000|${k0.pk}|5`, 'R1 the seat message: "lij-tatara-seat:v1|route|size|seat_pk|ts"');
  // R2 — check-ins: the seat key's signature, never older than the last
  r = await act(s0, 'checkin');
  check(r.code === 200 && r.body.count.joined === 1 && r.body.state === 'waiting' && !('room' in r.body), 'R2 a check-in signed by the seat key: the count (0.107.0: no public room open — no room field)');
  const forged = await post('checkin', { seat_id: s0.id, ts: ts(), sig: sig(key(5), 'checkin', [s0.id, ts()]) });
  check(forged.code === 401, 'R2 a check-in signed by another key: 401');
  const old = ts() - 5;
  const replay = await post('checkin', { seat_id: s0.id, ts: old, sig: sig(s0.k, 'checkin', [s0.id, old]) });
  check(replay.code === 400 && replay.body.reason === 'stale', 'R2 a check-in older than the last one: refused');
  check((await post('checkin', { seat_id: 'ab'.repeat(16), ts: ts(), sig: 'x' })).code === 404, 'R2 an unknown seat: 404');
  // R3 — the start: wakes and a signed "start"
  const s1 = await seatUp(1), s2 = await seatUp(2);
  for (const s of [s0, s1, s2]) await act(s, 'checkin');
  await T.tick(); clock.go(601); await T.tick();
  check(wakes.length === 3 && wakes.every(([pk, kind]) => kind === 'tatara' && [w0, wallet(1), wallet(2)].includes(pk)), 'R3 at zero the three wallets are woken through the web push ({t:"tatara"})');
  r = await act(s1, 'checkin');
  const n = r.body.notices[0];
  const start = JSON.parse(n.body);
  check(start.type === 'start' && start.seat_id === s1.id && /^[0-9a-f]{32}$/.test(start.attempt_id) && n.sig === nodeSig(noticeMsg(s1.id, n.body)),
    'R3 the seat is told "start" with the attempt id, signed by the provider\'s node key over "lij-tatara-notice:v1|seat|body"');
  const aid = start.attempt_id;
  // R4 — open, create, announce
  for (const s of [s0, s1, s2]) check((await act(s, 'open', { attempt_id: aid })).code === 200, 'R4 open (' + s.id.slice(0, 4) + ')');
  await T.tick();
  const c0 = bodies(await act(s0, 'checkin'));
  check(c0.some((x) => x.type === 'create' && x.attempt_id === aid && x.peers === 3), 'R4 all three opened: the first to open is told "create" (signed)');
  check((await act(s1, 'announce', { attempt_id: aid, announcement: ANN })).code === 409, 'R4 only the creator hands over the announcement');
  check((await act(s0, 'announce', { attempt_id: aid, announcement: '{"type":"new_pool"}' })).code === 400, 'R4 an announcement without the pool\'s key: refused');
  const forgedAnn = JSON.parse(ANN); forgedAnn.content = forgedAnn.content.replace('new_pool', 'old_pool');
  check((await act(s0, 'announce', { attempt_id: aid, announcement: JSON.stringify(forgedAnn) })).code === 400, 'R4 an announcement whose signature does not hold: refused');
  check((await act(s0, 'announce', { attempt_id: aid, announcement: ANN })).code === 200, 'R4 the creator\'s signed announcement taken');
  check(T.relayRooms().length === 1 && T.relayRooms()[0].pool_pk === poolPk, 'R4 the pool\'s relay room opens with the pool\'s key');
  const an = bodies(await act(s2, 'checkin'));
  check(an.some((x) => x.type === 'announcement' && x.announcement === ANN), 'R4 the others get it (signed)');
  check(c0.find((x) => x.type === 'create').relay === 'wss://lsp.example.com/tatara/relay' && /^[0-9a-f]{64}$/.test(c0.find((x) => x.type === 'create').token), 'R4 "create" names the relay and the pool\'s posting token');
  // R6 — a notice the provider cannot sign is kept, not sent unsigned
  signing = false;
  const kept = await act(s1, 'checkin');
  check(kept.body.notices.length === 0 && kept.body.retry_s === 2, 'R6 the node key cannot sign: no notice goes out unsigned; ask again in 2 s');
  signing = true;
  check(bodies(await act(s1, 'checkin')).some((x) => x.type === 'announcement'), 'R6 signed and sent at the next check-in');
  // R7 — a restart ends the attempt; the seats keep their places
  T = make();
  const after = bodies(await act(s2, 'checkin'));
  check(after.some((x) => x.type === 'stopped' && x.reason === 'provider_restarted'), 'R7 after a restart the attempt is over, never continued; the seat told why');
  check(fs.existsSync(path.join(dir, 'tatara', 'state.json')) && !fs.existsSync(path.join(dir, 'tatara', 'state.json.tmp')), 'R7 the list lives in DATA_DIR/tatara/state.json, written whole');
  // R5 — funding signed (a fresh attempt after the restart)
  for (const s of [s0, s1, s2]) await act(s, 'checkin');
  await T.tick(); clock.go(601); await T.tick();
  const aid2 = bodies(await act(s0, 'checkin')).find((x) => x.type === 'start').attempt_id;
  for (const s of [s0, s1, s2]) await act(s, 'open', { attempt_id: aid2 });
  await T.tick();
  await act(s0, 'checkin');
  check((await act(s1, 'report', { attempt_id: aid2, outcome: 'funding_signed' })).code === 200, 'R5 a member reports "funding signed"');
  check(bodies(await act(s2, 'checkin')).some((x) => x.type === 'done'), 'R5 its seats are told "done" (signed) and leave the list');
  // R9 — 0.100.0: the backup, from a seat of the attempt (checked against the key kept with the attempt), signed over both
  const FUND = '0100000001a6b97044d03da79c005b20ea9c0e1a6d9dc12d9f7b91a5911c9030a439eed8f5000000004948304502206e21798a42fae0e854281abd38bacd1aeed3ee3738d9e1446618c4571d1090db022100e2ac980643b0b82c0e88ffdfec6b64e3e6ba35e7ba5fdd7d5d6cc8d25c6b241501ffffffff0100f2052a010000001976a914404371705fa9bd789a2fcd52d2c580b65d35549d88ac00000000';
  const EXITS = [FUND];
  const dg = crypto.createHash('sha256').update(FUND + '|' + EXITS.join('|'), 'utf8').digest('hex');
  const bsig = (k) => sig(k, 'backup', [s2.id, aid2, dg, ts()]);
  check((await post('backup', { seat_id: s2.id, attempt_id: aid2, funding_hex: FUND, exits: EXITS, ts: ts(), sig: bsig(key(7)) })).code === 401, 'R9 a backup signed by a key that is not the seat\'s: 401');
  check((await post('backup', { seat_id: s2.id, attempt_id: 'ab'.repeat(16), funding_hex: FUND, exits: EXITS, ts: ts(), sig: bsig(s2.k) })).code === 404, 'R9 a backup for an attempt this provider did not run: 404');
  check((await post('backup', { seat_id: s2.id, attempt_id: aid2, funding_hex: FUND, exits: EXITS, ts: ts(), sig: bsig(s2.k) })).code === 200 && T.backups().length === 1, 'R9 the seat\'s signed backup is kept (after its seat has left the list)');
  // R8 — /tatara/info and the rate limit
  await T.handle({}, {}, '/tatara/info', 'GET', '9.9.9.9', null, jr);
  const info = answers.pop();
  check(info.code === 200 && info.body.queues.length === 2 && info.body.queues[0].size === 50000 && info.body.settings.relay_url === 'wss://lsp.example.com/tatara/relay', 'R8 /tatara/info: the settings and a count per size — no seat, no wallet');
  let last;
  for (let i = 0; i < 601; i++) last = await post('checkin', { seat_id: 'ab'.repeat(16), ts: ts(), sig: 'x' }, '5.5.5.5');
  check(last.code === 429, 'R8 more than 600 requests in 10 minutes from one address: 429');
  // R10 (0.103.0) — the channel route: refused where not offered; a seat where offered, in its own queue; the notices name the route
  check((await post('seat', { route: 'channel', size: 50000, seat_pk: key(40).pk, node_pubkey: wallet(40), ts: ts(), signature: 'good:' + wallet(40) })).body.reason === 'route_not_offered', 'R10 a channel seat at a provider without channel pools: 409 route_not_offered');
  check((await post('seat', { route: 'hop', size: 50000, seat_pk: key(40).pk, node_pubkey: wallet(40), ts: ts(), signature: 'good:' + wallet(40) })).code === 400, 'R10 an unknown route: 400');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tatara-c-'));
  const TC = createTatara({
    env: { TATARA_ENABLED: 'true', TATARA_SIZES: '50000,100000', TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '100000', TATARA_COUNTDOWN_S: '60' }, publicHttpsUrl: 'https://lsp.example.com', dataDir: dir2, now: clock.now,
    lndRoom: () => ({ maxPendingChannels: 3, lndConf: '/l' }),
    verifyWalletSig: async (msg, sig) => { const m = /^good:(0[23][0-9a-f]{64})$/.exec(sig); return m && sig === 'good:' + m[1] && /^lij-tatara-seat:v1\|(chain|channel)\|/.test(msg) ? m[1] : '02' + '00'.repeat(32); },
    signNotice: async (msg) => nodeSig(msg), sendWakePush: async () => {},
  });
  const postC = async (action, body) => { await TC.handle({ body }, {}, '/tatara/' + action, 'POST', '7.7.7.7', async (r) => r.body, jr); return answers.pop(); };
  check((await postC('seat', { route: 'channel', size: 50000, seat_pk: key(41).pk, node_pubkey: wallet(41), ts: ts(), signature: 'good:' + wallet(41) })).body.reason === 'route_not_offered', 'R10 a channel seat for a size not offered as a channel pool: 409');
  const cs = [];
  for (let i = 0; i < 3; i++) { const k = key(50 + i), pk = wallet(50 + i); const rr = await postC('seat', { route: 'channel', size: 100000, seat_pk: k.pk, node_pubkey: pk, ts: ts(), signature: 'good:' + pk }); cs.push({ k, id: rr.body.seat_id, code: rr.code }); }
  check(cs.every((c) => c.code === 200 && c.id), 'R10 three channel seats of 100,000 at a provider that offers them');
  check(seatSignedMsg('channel', 100000, cs[0].k.pk, 5) === `lij-tatara-seat:v1|channel|100000|${cs[0].k.pk}|5`, 'R10 the seat message carries the route');
  await TC.handle({}, {}, '/tatara/info', 'GET', '7.7.7.8', null, jr);
  const infoC = answers.pop();
  check(infoC.body.queues.some((q) => q.route === 'channel' && q.size === 100000 && q.joined === 3) && infoC.body.settings.channel_pools === true, 'R10 /tatara/info: the channel queue, 3 joined; channel pools declared');
  for (const c of cs) await postC('checkin', { seat_id: c.id, ts: ts(), sig: sig(c.k, 'checkin', [c.id, ts()]) });
  await TC.tick(); clock.go(61); await TC.tick();
  const n0 = (await postC('checkin', { seat_id: cs[0].id, ts: ts(), sig: sig(cs[0].k, 'checkin', [cs[0].id, ts()]) })).body.notices;
  const startC = n0.find((n) => JSON.parse(n.body).type === 'start'); const aidC = startC && JSON.parse(startC.body).attempt_id;
  check(!!aidC, 'R10 the channel pool starts');
  for (const c of cs) await postC('open', { seat_id: c.id, attempt_id: aidC, ts: ts(), sig: sig(c.k, 'open', [c.id, aidC, ts()]) });
  clock.go(181); await TC.tick();
  const n1 = (await postC('checkin', { seat_id: cs[0].id, ts: ts(), sig: sig(cs[0].k, 'checkin', [cs[0].id, ts()]) })).body.notices.map((n) => JSON.parse(n.body));
  const n2 = (await postC('checkin', { seat_id: cs[1].id, ts: ts(), sig: sig(cs[1].k, 'checkin', [cs[1].id, ts()]) })).body.notices.map((n) => JSON.parse(n.body));
  const cr = n1.find((n) => n.type === 'create'), wa = n2.find((n) => n.type === 'wait_for_announcement');
  check(cr && cr.route === 'channel' && wa && wa.route === 'channel', 'R10 the create and wait_for_announcement notices name the channel route');
  // R11 (0.105.1, DP 2026-10-14 16:19 — a channel's coin after its close sits in the on-chain pools): there is no close
  // route — "close" is an unknown route (400) like any other word; the coin seats on the chain route; a stray
  // TATARA_CLOSE_SIZES line adds no queue
  check((await post('seat', { route: 'close', size: 50000, seat_pk: key(60).pk, node_pubkey: wallet(60), ts: ts(), signature: 'good:' + wallet(60) })).code === 400, 'R11 route "close": 400 — not a route');
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tatara-d-'));
  const TD = createTatara({
    env: { TATARA_ENABLED: 'true', TATARA_SIZES: '50000,100000', TATARA_CLOSE_SIZES: '400000', TATARA_COUNTDOWN_S: '60' }, publicHttpsUrl: 'https://lsp.example.com', dataDir: dir3, now: clock.now,
    verifyWalletSig: async (msg, sig) => { const m = /^good:(0[23][0-9a-f]{64})$/.exec(sig); return m && sig === 'good:' + m[1] && /^lij-tatara-seat:v1\|(chain|channel)\|/.test(msg) ? m[1] : '02' + '00'.repeat(32); },
    signNotice: async (msg) => nodeSig(msg), sendWakePush: async () => {},
  });
  const postD = async (action, body) => { await TD.handle({ body }, {}, '/tatara/' + action, 'POST', '7.7.7.9', async (r) => r.body, jr); return answers.pop(); };
  check((await postD('seat', { route: 'close', size: 400000, seat_pk: key(61).pk, node_pubkey: wallet(61), ts: ts(), signature: 'good:' + wallet(61) })).code === 400, 'R11 a stray TATARA_CLOSE_SIZES line opens no close route');
  check((await postD('seat', { route: 'chain', size: 400000, seat_pk: key(61).pk, node_pubkey: wallet(61), ts: ts(), signature: 'good:' + wallet(61) })).body.reason === 'size_not_offered', 'R11 … and no chain queue of that size');
  await TD.handle({}, {}, '/tatara/info', 'GET', '7.7.7.10', null, jr);
  const infoD = answers.pop();
  check(infoD.body.queues.length === 2 && infoD.body.queues.every((q) => q.route === 'chain') && !('close_sizes' in infoD.body.settings), 'R11 /tatara/info: the two chain queues, no close queue, no close_sizes in the settings');
  fs.rmSync(dir3, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? 'FAIL · tatara-routes · ' + fails + ' failed' : 'PASS · tatara-routes (R1–R11)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · tatara-routes threw: ' + (e && e.stack || e)); process.exit(1); });
