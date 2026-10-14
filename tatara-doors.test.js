// 0.101.0 (S58 — LIJOX's Tatara step 5a; design tatara-adapter-r2.md): DOORS 1 AND 2 through tatara.js's routes —
// the ring of Mix-on wallets, ring-signed seats (signatures made by joinstr v2's own sign_tagged: tatara-doors.vectors
// .json), the wake to a seat's own address, the arrangement, the relay at another provider, provider traffic through
// another provider, and the week's end.   node tatara-doors.test.js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const schnorr = require('./schnorr.js');
const { createTatara, seatMsg } = require('./tatara');
const { makeRing } = require('./tatara-ring');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'tatara-doors.vectors.json'), 'utf8'));
const job = (n) => V.jobs.find((j) => j.name === n);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doors-'));
let t = V.T;
const ts = () => Math.floor(t / 1000);
const SELF = '02' + '5e'.repeat(32);
const full = (pk, host) => ({ pubkey: pk, endpoint: 'https://' + host, tatara: { relay_url: 'wss://' + host + '/tatara/relay', relay_for_others: true, forward_payouts: true, forward_coin_checks: true, coin_check_url: null } });
let providers = [full(SELF, 'self.example'), full('02' + 'aa'.repeat(32), 'r1.example'), full('02' + 'bb'.repeat(32), 'r2.example')];
const subs = [], posts = [];
let postAnswer = () => ({ status: 200, json: { ok: true } });
let recordChanged = 0;
const nodeSig = (msg) => 'zb' + crypto.createHash('sha256').update(msg).digest('hex');
const T = createTatara({
  env: { TATARA_ENABLED: 'true', TATARA_SIZES: '50000,100000' }, publicHttpsUrl: 'https://self.example', dataDir: dir, now: () => t,
  verifyWalletSig: async (msg, sig) => { const m = /^good:(0[23][0-9a-f]{64})$/.exec(sig); return m ? m[1] : ''; },
  signNotice: async (msg) => nodeSig(msg),
  sendToSubscription: async (sub, payload) => { subs.push([sub, payload]); },
  listProviders: async () => providers,
  postJson: async (u, b) => { posts.push([u, b]); return postAnswer(u, b); },
  selfPubkey: () => SELF,
  onRecordChanged: () => { recordChanged++; },
});
const answers = [];
const jr = (res, body, code) => answers.push({ code: code || 200, body });
const call = async (p, method, body, ip = '1.1.1.1') => { await T.handle({ body }, {}, p, method, ip, async (r) => r.body, jr); return answers.pop(); };
const W = (i) => '02' + crypto.createHash('sha256').update('wallet-' + i).digest('hex');
const seatSk = (i) => crypto.createHash('sha256').update('seat-' + i).digest();
const seatNo = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
const ringSeat = (n, over = {}) => { const j = job(n); return call('/tatara/seat', 'POST', Object.assign({ route: 'chain', size: j.size, seat_pk: j.seat, wake_json: V.wake, ring_hash: V.ring_hash, ts: V.ts, ring_sig: j.sig }, over)); };
async function act(seatId, n, action, extra = {}) {
  const fields = [seatId];
  if (['open', 'report', 'announce'].includes(action)) fields.push(extra.attempt_id);
  if (action === 'announce') fields.push(crypto.createHash('sha256').update(extra.announcement, 'utf8').digest('hex'));
  fields.push(ts());
  const sig = schnorr.sign(seatSk(seatNo[n]), seatMsg(action, fields), crypto.randomBytes(32)).toString('hex');
  return call('/tatara/' + action, 'POST', Object.assign({ seat_id: seatId, ts: ts(), sig }, extra));
}
const bodies = (r) => (r.body.notices || []).map((x) => JSON.parse(x.body));

(async () => {
  await T.refreshArrangement();
  check(T.arrangement() === 'doors', 'D0 three registered providers declare every role: doors 1 and 2');
  // D1 — Mix on: the ring
  for (let i = 0; i < 3; i++) {
    const r = await call('/tatara/ring/join', 'POST', { node_pubkey: W(i), tatara_pk: V.keys[i], ts: ts(), signature: 'good:' + W(i) });
    check(r.code === 200 && r.body.from_week === '2026-W42', 'D1 wallet ' + i + ' turns Mix on (its Tatara key, signed by its node key): in this week\'s ring');
  }
  check((await call('/tatara/ring/join', 'POST', { node_pubkey: W(5), tatara_pk: V.keys[0], ts: ts(), signature: 'good:' + W(5) })).body.reason === 'key_in_use', 'D1 another wallet cannot register a key already in the ring');
  check((await call('/tatara/ring/join', 'POST', { node_pubkey: W(6), tatara_pk: '02' + 'ff'.repeat(32), ts: ts(), signature: 'good:' + W(6) })).body.reason === 'bad_tatara_key', 'D1 a key not on the curve: refused');
  check((await call('/tatara/ring/join', 'POST', { node_pubkey: W(7), tatara_pk: V.keys[0].replace(/.$/, 'f'), ts: ts(), signature: 'good:' + W(8) })).code !== 200, 'D1 a join signed by another wallet\'s key: refused');
  const ring = (await call('/tatara/ring', 'GET')).body;
  check(ring.week === '2026-W42' && JSON.stringify(ring.keys) === JSON.stringify(V.sorted) && ring.hash === V.ring_hash && ring.hash === makeRing(V.sorted, 'lij/tatara/seat/v1/2026-W42').hash, 'D1 GET /tatara/ring: this week\'s three keys, sorted, and the hash bound to 2026-W42');
  const lateKey = Buffer.from(require('secp256k1').publicKeyCreate(crypto.createHash('sha256').update('late').digest(), true)).toString('hex');
  const late = await call('/tatara/ring/join', 'POST', { node_pubkey: W(9), tatara_pk: lateKey, ts: ts(), signature: 'good:' + W(9) });
  check(late.code === 200 && late.body.from_week === '2026-W43', 'D1 a wallet that turns Mix on after the week\'s ring was taken enters next week\'s');
  check(JSON.stringify((await call('/tatara/ring', 'GET')).body.keys) === JSON.stringify(V.sorted), 'D1 this week\'s ring never changes');
  const info = (await call('/tatara/info', 'GET')).body;
  check(info.arrangement === 'doors' && info.settings.ring_hash === V.ring_hash && T.recordBlock().ring_hash === V.ring_hash, 'D1 /tatara/info and the registry record name this week\'s ring hash');
  // D2 — ring-signed seats (signatures by joinstr v2's sign_tagged)
  const a = await ringSeat('a');
  check(a.code === 200 && /^[0-9a-f]{32}$/.test(a.body.seat_id), 'D2 a ring-signed seat: taken (one of 3 Mix-on wallets, never which)');
  check((await ringSeat('b')).body.reason === 'already_seated', 'D2 the same wallet again in the same size (the same key image): refused');
  const c = await ringSeat('c');
  check(c.code === 200, 'D2 the same wallet in another size: taken');
  const d = await ringSeat('d'), f = await ringSeat('f');
  check(d.code === 200 && f.code === 200, 'D2 the other two wallets: taken');
  check((await ringSeat('e')).body.reason === 'bad_ring_signature', 'D2 a signature made under next week\'s tag: refused');
  check((await ringSeat('a', { size: 100000 })).body.reason === 'bad_ring_signature', 'D2 a field changed after signing (the size): refused');
  check((await ringSeat('a', { wake_json: V.wake.replace('seat-1', 'seat-9') })).body.reason === 'bad_ring_signature', 'D2 another wake address than the one signed: refused');
  check((await ringSeat('a', { ring_hash: 'ab'.repeat(32) })).body.reason === 'not_this_weeks_ring', 'D2 another ring than this week\'s: refused');
  check((await call('/tatara/seat', 'POST', { route: 'chain', size: 50000, seat_pk: job('a').seat, node_pubkey: W(0), ts: ts(), signature: 'good:' + W(0) })).body.reason === 'arrangement_doors', 'D2 a node-key seat while the doors are on: refused');
  // D3 — the start wakes each seat's own address; the relay is another provider's
  await T.tick(); t += 601 * 1000; await T.tick();
  check(subs.length === 3 && subs.every(([s, p]) => s.endpoint === 'https://push.example.org/seat-1' && p.t === 'tatara'), 'D3 at zero the three seats are woken at their own wake addresses ({t:"tatara"}) — not by wallet');
  const st = bodies(await act(a.body.seat_id, 'a', 'checkin')).find((x) => x.type === 'start');
  const aid = st.attempt_id;
  for (const [s, n] of [[f.body.seat_id, 'f'], [a.body.seat_id, 'a'], [d.body.seat_id, 'd']]) await act(s, n, 'open', { attempt_id: aid });
  await T.tick();
  const cr = bodies(await act(f.body.seat_id, 'f', 'checkin')).find((x) => x.type === 'create');
  check(cr && /^wss:\/\/r[12]\.example\/tatara\/relay$/.test(cr.relay), 'D3 "create" names a relay at a random other provider (' + (cr && cr.relay) + '), never this one');
  const ann = JSON.stringify((() => { const sk = crypto.createHash('sha256').update('pool').digest(); const pubkey = schnorr.pubkey(sk).toString('hex'); const content = '{}'; const id = crypto.createHash('sha256').update(JSON.stringify([0, pubkey, 1, 2022, [], content])).digest('hex'); return { id, pubkey, created_at: 1, kind: 2022, tags: [], content, sig: schnorr.sign(sk, Buffer.from(id, 'hex'), crypto.randomBytes(32)).toString('hex') }; })());
  postAnswer = () => ({ status: 403, json: { ok: false, reason: 'not_a_registered_provider' } });
  const refused = await act(f.body.seat_id, 'f', 'announce', { attempt_id: aid, announcement: ann });
  check(refused.code === 502 && !bodies(await act(d.body.seat_id, 'd', 'checkin')).some((x) => x.type === 'announcement'), 'D3 the other provider refuses the room: the announcement waits (not passed on)');
  postAnswer = () => ({ status: 200, json: { ok: true } });
  posts.length = 0;
  const okAnn = await act(f.body.seat_id, 'f', 'announce', { attempt_id: aid, announcement: ann });
  const reg = posts.find(([u]) => /\/tatara\/relay\/register$/.test(u));
  check(okAnn.code === 200 && reg && reg[0].replace('/tatara/relay/register', '/tatara/relay').replace('https', 'wss') === cr.relay && reg[1].signature === nodeSig(`lij-tatara-relay:v1|register|${reg[1].token}|${reg[1].pool_pk}|${aid}|${reg[1].expires_at}|${reg[1].ts}`) && reg[1].node_pubkey === SELF,
    'D3 the room is registered at that provider, signed by this provider\'s node key; then the announcement goes out');
  check(T.relayRooms().length === 0, 'D3 no room here: the pool\'s messages go to the other provider\'s relay');
  // D4 — this provider as the other provider: rooms for others' pools
  const P2 = providers[2].pubkey;
  const body = (o = {}) => Object.assign({ token: 'cd'.repeat(32), pool_pk: 'ef'.repeat(32), attempt_id: '12'.repeat(16), expires_at: ts() + 3600, node_pubkey: P2, ts: ts() }, o);
  const signedBody = (o = {}) => { const b = body(o); b.signature = 'good:' + (o.signer || P2); delete b.signer; return b; };
  check((await call('/tatara/relay/register', 'POST', signedBody({ node_pubkey: '02' + '99'.repeat(32), signer: '02' + '99'.repeat(32) }))).code === 403, 'D4 a room asked by a key no registered provider has: 403');
  check((await call('/tatara/relay/register', 'POST', signedBody({ expires_at: ts() + 7201 }))).code === 400, 'D4 a room for more than 2 hours: refused');
  check((await call('/tatara/relay/register', 'POST', signedBody({ signer: '02' + 'bb'.repeat(31) + 'bc' }))).code === 401, 'D4 a room request not signed by the provider it names: 401');
  check((await call('/tatara/relay/register', 'POST', signedBody())).code === 200 && T.relayRooms().length === 1, 'D4 a registered provider\'s signed request: the room opens here');
  // D5 — a phone's seat traffic through this provider to its own
  posts.length = 0;
  let fp = await call('/tatara/forward/provider', 'POST', { endpoint: 'https://r1.example', action: 'checkin', body: { seat_id: 'x', ts: 1, sig: 'y' } });
  check(fp.code === 200 && posts.length === 1 && posts[0][0] === 'https://r1.example/tatara/checkin' && posts[0][1].seat_id === 'x', 'D5 a check-in passed to the phone\'s own provider as it came — that provider sees this one, not the phone');
  check((await call('/tatara/forward/provider', 'POST', { endpoint: 'https://self.example', action: 'checkin', body: {} })).body.reason === 'own_provider', 'D5 never to itself');
  check((await call('/tatara/forward/provider', 'POST', { endpoint: 'https://unknown.example', action: 'checkin', body: {} })).body.reason === 'provider_not_declared', 'D5 never to an address no registered provider declares');
  check((await call('/tatara/forward/provider', 'POST', { endpoint: 'https://r1.example', action: 'ring/join', body: {} })).code === 400, 'D5 only the seat\'s actions are passed');
  // D6 — the week ends
  t = Date.UTC(2026, 9, 19, 0, 0, 30);   // Monday of 2026-W43
  await T.tick();
  const cEnd = await act(c.body.seat_id, 'c', 'checkin');
  check(bodies(cEnd).some((x) => x.type === 'removed' && x.reason === 'week_ended'), 'D6 Monday 00:00 UTC: last week\'s waiting ring-signed seat ends ("week_ended" — the phone asks again)');
  check(recordChanged === 1 && (await call('/tatara/ring', 'GET')).body.week === '2026-W43', 'D6 the new week\'s ring is taken and the record is registered again (its ring hash)');
  t += 3600 * 1000; await T.tick();
  check(T.relayRooms().length === 0, 'D4 the room for another provider\'s pool closes at its time');
  // D7 — fewer than three providers: v0.8's arrangement refuses ring-signed seats
  providers = providers.slice(0, 2); t += 301 * 1000; await T.refreshArrangement();
  check(T.arrangement() === 'v0.8' && (await ringSeat('a', { ts: ts() })).body.reason === 'arrangement_v0.8', 'D7 two providers: v0.8\'s arrangement — a ring-signed seat is refused (the phone reads which from /tatara/info)');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? 'FAIL · tatara-doors · ' + fails + ' failed' : 'PASS · tatara-doors (D0–D7)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · tatara-doors threw: ' + (e && e.stack || e)); process.exit(1); });
