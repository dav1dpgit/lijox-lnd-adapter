// 0.131.0 — zaps (NIP-57) on the address rail: zap.js, and its wiring in lij-adapter.js.
// 0.132.0 — the wallet chooses (w1–w6), one receipt key per address (y1–y4, k1–k2), the receipt dated when the sender's
//           payment reached the provider (t1–t3, n5), an entry a chit paid sends none at the next start either (w4).
//   node zap.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const schnorr = require('./schnorr.js');
const { eventId, checkEvent } = require('./nwc.js');
const Z = require('./zap');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0; const check = (c, m) => { if (!c) { fails++; console.log('FAIL · ' + m); } else console.log('  ok · ' + m); };

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const SENDER_SK = sha('zap test sender'), SENDER_PK = schnorr.pubkey(SENDER_SK).toString('hex');
const RECIP = schnorr.pubkey(sha('zap test recipient')).toString('hex');
const NOTE_ID = sha('a note').toString('hex');
function signed(fields) {
  const ev = Object.assign({ pubkey: SENDER_PK, created_at: 1763300000, kind: 9734, content: '', tags: [] }, fields);
  ev.id = eventId(ev);
  ev.sig = schnorr.sign(SENDER_SK, ev.id, Buffer.alloc(32)).toString('hex');
  return ev;
}
const goodTags = (amt) => [['relays', 'wss://relay.example.com', 'wss://nos.lol/'], ['amount', String(amt)], ['lnurl', 'lnurl1xyz'], ['p', RECIP], ['e', NOTE_ID], ['k', '1']];
const AMT = 21000n;
const GOOD = signed({ content: 'Zap +1 for this, friend!', tags: goodTags(AMT) });
const GOOD_TEXT = JSON.stringify(GOOD);
const q = (enc) => '?amount=21000&nostr=' + enc + '&lnurl=lnurl1xyz';

// ── the parameter and the three ways apps encode it
check(Z.nostrParam('?amount=1').raw === null, 'p1 no nostr parameter: absent');
check(Z.nostrParam('?nostr=&amount=1').raw === '', 'p1 an empty nostr parameter is seen as empty');
check(Z.nostrParam('?nostr=a&nostr=b').twice === true, 'p1 two nostr parameters are seen');
let r = Z.fromQuery(q(encodeURIComponent(GOOD_TEXT)), AMT);
check(r.zap && r.zap.text === GOOD_TEXT, 'e1 encodeURIComponent: verified, the text kept byte for byte');
r = Z.fromQuery(q(encodeURI(GOOD_TEXT).replace(/&/g, '%26')), AMT);
check(r.zap && r.zap.text === GOOD_TEXT, 'e2 encodeURI (NIP-57\'s own example; a "+" left as it is): verified, the "+" kept');
const formEnc = encodeURIComponent(GOOD_TEXT).replace(/%20/g, '+');
check(formEnc.includes('+') && formEnc.includes('%2B'), 'e3 (the form encoding has "+" for a space and %2B for a plus)');
r = Z.fromQuery(q(formEnc), AMT);
check(r.zap && r.zap.text === GOOD_TEXT, 'e3 form encoding (space as "+"): verified on the second reading, the text as the sender signed it');
check(Z.fromQuery('?amount=21000', AMT).zap === null && !Z.fromQuery('?amount=21000', AMT).error, 'e4 no nostr parameter: no zap, no error (a plain payment)');
check(Z.fromQuery('?nostr=a&nostr=b', AMT).error === 'nostr given twice', 'e5 two nostr parameters are refused');
check(Z.fromQuery('?nostr=%E0%A4%A', AMT).error === 'not URI-encoded', 'e5 broken percent-encoding is refused');

// ── Appendix D, one rule at a time
const reason = (ev, amt) => Z.checkRequestText(typeof ev === 'string' ? ev : JSON.stringify(ev), amt === undefined ? AMT : amt).reason;
const tampered = Object.assign({}, GOOD, { content: 'changed' });
check(reason(tampered) === 'id does not match', 'd1 a changed request: the id no longer matches');
const badSig = Object.assign({}, GOOD, { sig: GOOD.sig.slice(0, 126) + (GOOD.sig.slice(126) === '00' ? '01' : '00') });
check(reason(badSig) === 'bad signature', 'd1 a bad signature is refused');
check(reason(signed({ kind: 1, tags: goodTags(AMT) })) === 'not kind 9734', 'd1 not a zap request (kind 1)');
check(reason(signed({ tags: [] })) === 'no tags', 'd2 no tags');
check(reason(signed({ tags: [['p', RECIP], ['p', RECIP]] })) === 'needs exactly one p tag', 'd3 two p tags');
check(reason(signed({ tags: [['relays', 'wss://nos.lol']] })) === 'needs exactly one p tag', 'd3 no p tag');
check(reason(signed({ tags: [['p', 'xyz']] })) === 'needs exactly one p tag', 'd3 a p tag that is not a key');
check(reason(signed({ tags: [['p', RECIP], ['e', NOTE_ID], ['e', NOTE_ID]] })) === 'more than one e tag, or a bad one', 'd4 two e tags');
check(reason(signed({ tags: [['p', RECIP]] })) === undefined && Z.checkRequestText(JSON.stringify(signed({ tags: [['p', RECIP]] })), AMT).ok, 'd5 no relays tag and no amount tag: taken (both are optional for the server)');
check(reason(signed({ tags: goodTags(AMT) }), 22000n) === 'amount tag does not match the amount', 'd6 the amount tag must equal the amount asked for');
check(reason(signed({ tags: [['p', RECIP], ['amount', '21000x']] })) === 'bad amount tag', 'd6 an amount tag that is not a number');
check(reason(signed({ tags: [['p', RECIP], ['a', 'not-a-coordinate']] })) === 'bad a tag', 'd7 an a tag that is not an event coordinate');
check(Z.checkRequestText(JSON.stringify(signed({ tags: [['p', RECIP], ['a', '30023:' + RECIP + ':my-article']] })), AMT).ok, 'd7 a valid a tag is taken');
check(reason(signed({ tags: [['p', RECIP], ['P', SENDER_PK], ['P', SENDER_PK]] })) === 'more than one P tag, or a bad one', 'd8 two P tags');
check(reason('{nope') === 'not JSON', 'd9 not JSON');
check(reason('x'.repeat(Z.MAX_REQUEST_CHARS + 1)) === 'too long', 'd9 longer than the cap');

// ── the receipt (Appendix E)
const KEY = crypto.randomBytes(32).toString('hex');
const parsedGood = Z.checkRequestText(GOOD_TEXT, AMT);
const rc = Z.receipt(KEY, parsedGood, 'lnbc210n1test', 1763300100);
const tagOf = (ev, n) => { const t = ev.tags.find((x) => x[0] === n); return t ? t[1] : undefined; };
check(rc.kind === 9735 && rc.content === '' && rc.created_at === 1763300100, 'r1 kind 9735, empty content, created_at = the date handed in');
check(checkEvent(rc) === '', 'r1 the receipt verifies (id and BIP-340 signature)');
check(rc.pubkey === schnorr.pubkey(Buffer.from(KEY, 'hex')).toString('hex'), 'r1 signed by the receipt key');
check(tagOf(rc, 'p') === RECIP && tagOf(rc, 'P') === SENDER_PK && tagOf(rc, 'e') === NOTE_ID && tagOf(rc, 'k') === '1', 'r2 p, P (the sender), e and k carried over');
check(tagOf(rc, 'bolt11') === 'lnbc210n1test', 'r2 the bolt11 tag');
check(tagOf(rc, 'description') === GOOD_TEXT, 'r3 the description is the request exactly as the invoice is tied to it');
check(!rc.tags.some((t) => t[0] === 'preimage' || t[0] === 'relays' || t[0] === 'amount' || t[0] === 'lnurl'), 'r4 no preimage, and none of the request\'s own relays / amount / lnurl tags');
const rcA = Z.receipt(KEY, Z.checkRequestText(JSON.stringify(signed({ tags: [['p', RECIP], ['a', '30023:' + RECIP + ':x']] })), AMT), 'lnbc1', 1);
check(tagOf(rcA, 'a') === '30023:' + RECIP + ':x' && tagOf(rcA, 'e') === undefined, 'r2 an a tag carried over; no e tag when the request has none');

// ── relay addresses
check(Z.relayUrlOk('wss://relay.damus.io') && Z.relayUrlOk('wss://nos.lol/') && Z.relayUrlOk('wss://relay.example.com:4443/path'), 'u1 public wss:// addresses');
for (const bad of ['ws://relay.damus.io', 'https://relay.damus.io', 'wss://localhost', 'wss://127.0.0.1', 'wss://10.0.0.8', 'wss://192.168.1.12', 'wss://[::1]', 'wss://100.100.1.1', 'wss://abc.onion', 'wss://box.local', 'wss://u:p@relay.damus.io', 'wss://a.localhost', 'wss://x.internal', '', 'wss://' + 'a'.repeat(200) + '.com', 42])
  check(!Z.relayUrlOk(bad), 'u2 refused: ' + String(bad).slice(0, 40));
const cl = Z.cleanRelays(['wss://nos.lol/', 'wss://nos.lol', 'ws://x.com', 'wss://127.0.0.1', ...Array.from({ length: 12 }, (_, i) => 'wss://r' + i + '.example.com')]);
check(cl[0] === 'wss://nos.lol' && cl.length === Z.MAX_RELAYS && !cl.includes('ws://x.com'), 'u3 cleaned: one slash dropped, no repeats, the bad ones out, at most ' + Z.MAX_RELAYS);
check(JSON.stringify(Z.requestRelays(GOOD)) === JSON.stringify(['wss://relay.example.com', 'wss://nos.lol']), 'u4 the request\'s relays read and cleaned');

// ── the connect-time address check (the socket's own lookup)
(async () => {
  const keepAlive = setInterval(() => {}, 1000);   // zap.js unrefs its timers (right in the adapter); here they are all there is
  const lk = (ans) => Z.makeSafeLookup((h, o, cb) => (o && o.all ? cb(null, ans.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }))) : cb(null, ans[0], ans[0].includes(':') ? 6 : 4)));
  const call = (f, all) => new Promise((res) => f('relay.example.com', all ? { all: true } : {}, (e, a) => res({ e, a })));
  let x = await call(lk(['127.0.0.1']), false); check(x.e && x.e.code === 'EZAPPRIVATE', 'l1 a name that resolves to 127.0.0.1 is refused');
  x = await call(lk(['10.0.0.1', 'fd00::1']), true); check(x.e && x.e.code === 'EZAPPRIVATE', 'l1 every address private (all: true): refused');
  x = await call(lk(['10.0.0.1', '93.184.216.34']), true); check(!x.e && x.a.length === 1 && x.a[0].address === '93.184.216.34', 'l2 the private addresses dropped, the public one kept');
  x = await call(lk(['93.184.216.34']), false); check(!x.e && x.a === '93.184.216.34', 'l2 a public address passes');

  // ── a fake relay: answers OK true / OK false / an error, or nothing
  const seen = [];
  function fakeWs(behaviour) {
    return class extends EventEmitter {
      constructor(url, opts) { super(); this.url = url; this.opts = opts; this.rec = { url, opts }; seen.push(this.rec); const b = behaviour(url);
        setImmediate(() => { if (b === 'error') { this.emit('error', new Error('boom')); return; } if (b === 'silent-connect') return; this.emit('open'); }); this.b = b; }
      send(s) { const m = JSON.parse(s); this.sent = m; this.rec.sent = m;
        if (this.b === 'ok') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(['OK', m[1].id, true, '']))));
        if (this.b === 'no') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(['OK', m[1].id, false, 'blocked: no']))));
        if (this.b === 'other') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify(['OK', 'ff'.repeat(32), true, '']))));
      }
      terminate() { this.closed = true; }
      close() { this.closed = true; }
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptest-'));
  const logs = []; let persisted = 0; const timers = [];
  // 0.132.0: `allowed` is the wallet's choice — here every address's wallet has said yes, unless a test says otherwise
  const mk = (extra) => Z.createZaps(Object.assign({ enabled: true, dataDir: dir, allowed: () => true, log: (m) => logs.push(m), persist: () => { persisted++; }, timeoutMs: 300,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return 0; } }, extra));

  // off
  const off = Z.createZaps({ enabled: false, dataDir: dir });
  check(JSON.stringify(off.answerFields('dp')) === '{}', 'o1 off: the answer gets no field');
  check(off.fromCallback('dp', q(encodeURIComponent(GOOD_TEXT)), AMT).zap === null && !off.fromCallback('dp', '?nostr=garbage', AMT).error, 'o1 off: the nostr parameter is ignored, a bad one too (as before 0.131.0)');
  check(!fs.existsSync(path.join(dir, Z.KEY_FILE)), 'o1 off: no key file is made');
  check(off.bootLine() === '[Startup] Zaps (NIP-57): off (ZAPS_ENABLED is not true)', 'o1 off: the boot line says so');

  // on: the key
  const z1 = mk({ WebSocketImpl: fakeWs(() => 'ok') });
  const kf = path.join(dir, Z.KEY_FILE);
  check(z1.on && fs.existsSync(kf) && (fs.statSync(kf).mode & 0o077) === 0, 'k1 on: the key file is made, readable by the owner only');
  const af = z1.answerFields('dp');
  const BOX = fs.readFileSync(kf, 'utf8').trim();
  check(af.allowsNostr === true && /^[0-9a-f]{64}$/.test(af.nostrPubkey) && af.nostrPubkey === Z.nameKey(BOX, 'dp').pk, 'k1 allowsNostr: true and nostrPubkey = this address\'s own key (made from the key file and the address name)');
  check(af.nostrPubkey !== schnorr.pubkey(Buffer.from(BOX, 'hex')).toString('hex') && z1.answerFields('lij').nostrPubkey !== af.nostrPubkey && z1.answerFields('lij').nostrPubkey === Z.nameKey(BOX, 'lij').pk, 'k1 no address answers the box\'s own key, and two addresses answer two keys');
  check(z1.bootLine().startsWith('[Startup] Zaps (NIP-57): OFFERED — each wallet chooses') && z1.bootLine().includes('one receipt key per address, made from zap-receipt.key (new)') && z1.bootLine().includes('wss://relay.primal.net, wss://relay.damus.io, wss://nos.lol') && !z1.bootLine().includes(af.nostrPubkey.slice(0, 16)), 'k1 the boot line: offered, each wallet chooses; the key file new; the default relays; no key printed');
  const z1b = mk({ WebSocketImpl: fakeWs(() => 'ok') });
  check(z1b.answerFields('dp').nostrPubkey === af.nostrPubkey && !z1b.bootLine().includes('(new)'), 'k2 a restart: the same key for the same address');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'zaptest-'));
  fs.writeFileSync(path.join(dir2, Z.KEY_FILE), 'not a key\n');
  const zj = Z.createZaps({ enabled: true, dataDir: dir2, log: (m) => logs.push(m) });
  check(!zj.on && fs.readFileSync(path.join(dir2, Z.KEY_FILE), 'utf8') === 'not a key\n' && JSON.stringify(zj.answerFields('dp')) === '{}', 'k3 a key file that holds no key: zaps OFF, the file left exactly as it was');
  const zr = Z.createZaps({ enabled: true, dataDir: dir, relays: 'ws://bad, wss://127.0.0.1' });
  check(!zr.on && zr.summary().why_off.includes('ZAP_RELAYS'), 'k4 no usable relay in ZAP_RELAYS: zaps OFF, and why');
  const zc = Z.createZaps({ enabled: true, dataDir: dir, relays: ' wss://relay.one.example/ , wss://relay.two.example' });
  check(JSON.stringify(zc.summary().relays) === JSON.stringify(['wss://relay.one.example', 'wss://relay.two.example']), 'k5 ZAP_RELAYS read and cleaned');

  // the callback
  const cbOk = z1.fromCallback('dp', q(encodeURIComponent(GOOD_TEXT)), AMT);
  check(cbOk.zap && cbOk.zap.text === GOOD_TEXT && cbOk.zap.relays.length === 0, 'c1 on: a good request taken; the sender\'s relays NOT used (ZAP_REQUEST_RELAYS off)');
  check(/amount tag/.test(z1.fromCallback('dp', q(encodeURIComponent(GOOD_TEXT)), 1000n).error), 'c2 on: a bad request answers its reason');
  check(z1.fromCallback('dp', '?amount=21000', AMT).zap === null, 'c3 on: no nostr parameter — a plain payment');
  const zRR = mk({ requestRelays: true, WebSocketImpl: fakeWs(() => 'ok') });
  check(JSON.stringify(zRR.fromCallback('dp', q(encodeURIComponent(GOOD_TEXT)), AMT).zap.relays) === JSON.stringify(['wss://relay.example.com', 'wss://nos.lol']), 'c4 ZAP_REQUEST_RELAYS=true: the sender\'s relays kept (cleaned)');

  // the entry and the receipt
  const entry = { hash: 'aa'.repeat(32), status: 'reserved', amount_msat: '21000' };
  entry.zap = z1.entryRecord(cbOk.zap);
  check(entry.zap.state === 'minting' && entry.zap.req === GOOD_TEXT && !('relays' in entry.zap), 'n1 at the reservation: the request kept, state minting');
  z1.minted(entry, 'lnbc210n1zap');
  check(entry.zap.state === 'waiting' && entry.zap.bolt11 === 'lnbc210n1zap', 'n2 once the invoice exists: waiting, the invoice kept');
  await z1.onSettled('dp', entry);
  check(entry.zap.state === 'waiting', 'n3 not settled yet: nothing sent');
  entry.status = 'settled'; entry.accepted_at = 1763300040000; entry.settled_at = 1763300100000;   // the sender's payment reached the provider 60 s before the wallet took it
  seen.length = 0; logs.length = 0;
  const pA = z1.onSettled('dp', entry), pB = z1.onSettled('dp', entry);   // the two settle paths at once
  await Promise.all([pA, pB]);
  check(seen.length === 3, 'n4 one round only (two calls at once): one connection per relay — ' + seen.length);
  check(entry.zap.state === 'sent' && entry.zap.ok === 3 && entry.zap.tried === 3 && !entry.zap.req, 'n4 sent: 3 of 3; the request text dropped from the record');
  const ev = seen[0].sent[1];
  check(seen[0].sent[0] === 'EVENT' && ev.kind === 9735 && checkEvent(ev) === '' && ev.pubkey === af.nostrPubkey && ev.created_at === 1763300040, 'n5 the relays got the receipt signed with the address\'s key, dated when the sender\'s payment reached the provider — not at the settle (60 s after)');
  check(tagOf(ev, 'bolt11') === 'lnbc210n1zap' && tagOf(ev, 'description') === GOOD_TEXT && crypto.createHash('sha256').update(tagOf(ev, 'description'), 'utf8').digest('hex') === crypto.createHash('sha256').update(GOOD_TEXT, 'utf8').digest('hex'), 'n5 SHA-256(description) is what the invoice was tied to');
  check(seen.every((s) => typeof s.opts.lookup === 'function' && s.opts.followRedirects === false), 'n6 every connection carries the address check and follows no redirect');
  check(logs.some((m) => m === '[ZAP] dp: zap receipt published — 3 of 3 relays took it (21000 msat)') && !logs.some((m) => m.includes(SENDER_PK.slice(0, 12)) || m.includes(RECIP.slice(0, 12)) || m.includes('wss://')), 'n7 the journal: the name and the amount; no key, no relay');
  await z1.onSettled('dp', entry);
  check(seen.length === 3, 'n8 settled again (the watcher\'s SETTLED branch): nothing sent again');

  // some relays refuse
  const zMix = mk({ relays: 'wss://a.example, wss://b.example, wss://c.example, wss://d.example', WebSocketImpl: fakeWs((u) => ({ 'wss://a.example': 'ok', 'wss://b.example': 'no', 'wss://c.example': 'error', 'wss://d.example': 'other' })[u]) });
  const e2 = { hash: 'bb'.repeat(32), status: 'settled', settled_at: Date.now(), amount_msat: '21000', zap: Object.assign(zMix.entryRecord(cbOk.zap), { state: 'waiting', bolt11: 'lnbc1' }) };
  await zMix.onSettled('dp', e2);
  check(e2.zap.state === 'sent' && e2.zap.ok === 1 && e2.zap.tried === 4, 'm1 one of four took it (refused, error, a reply to another id, a timeout counted out): sent');

  // no relay takes it: twice more, then given up
  timers.length = 0;
  const zNone = mk({ WebSocketImpl: fakeWs(() => 'error') });
  const e3 = { hash: 'cc'.repeat(32), status: 'settled', settled_at: Date.now(), amount_msat: '5000', zap: Object.assign(zNone.entryRecord(cbOk.zap), { state: 'waiting', bolt11: 'lnbc1' }) };
  await zNone.onSettled('dp', e3);
  check(e3.zap.state === 'waiting' && e3.zap.tries === 1 && timers.length === 1 && timers[0].ms === 60000, 'f1 no relay took it: waiting, a second try in 60 s');
  await zNone.onSettled('dp', e3); check(e3.zap.tries === 2 && timers[1].ms === 300000, 'f2 the third try in 5 minutes');
  await zNone.onSettled('dp', e3); check(e3.zap.state === 'failed' && timers.length === 2, 'f3 then given up — failed, no more tries');
  const eSilent = { hash: 'dd'.repeat(32), status: 'settled', settled_at: Date.now(), amount_msat: '5000', zap: Object.assign(mk({}).entryRecord(cbOk.zap), { state: 'waiting', bolt11: 'lnbc1' }) };
  const zSilent = mk({ WebSocketImpl: fakeWs(() => 'silent-connect'), timeoutMs: 50 });
  const t0 = Date.now(); await zSilent.onSettled('dp', eSilent);
  check(Date.now() - t0 < 2000 && eSilent.zap.tries === 1, 'f4 a relay that never answers: the time limit ends the try');

  // resume after a restart
  const reg = { dp: { entries: [
    { hash: '11'.repeat(32), status: 'settled', settled_at: Date.now() - 3600e3, amount_msat: '1000', zap: { req: GOOD_TEXT, bolt11: 'lnbc1', state: 'sending', at: Date.now() - 3700e3 } },
    { hash: '22'.repeat(32), status: 'settled', settled_at: Date.now() - 2 * 86400e3, amount_msat: '1000', zap: { req: GOOD_TEXT, bolt11: 'lnbc1', state: 'waiting', at: Date.now() - 2 * 86400e3 } },
    { hash: '33'.repeat(32), status: 'accepted', amount_msat: '1000', zap: { req: GOOD_TEXT, bolt11: 'lnbc1', state: 'waiting', at: Date.now() - 2 * 86400e3 } },
    { hash: '44'.repeat(32), status: 'settled', settled_at: Date.now(), amount_msat: '1000', zap: { state: 'sent', ok: 1 } },
  ] } };
  const zRes = mk({ WebSocketImpl: fakeWs(() => 'ok') });
  check(zRes.resume(reg) === 1, 'b1 boot: one receipt taken up (stopped mid-send, within a day)');
  await new Promise((res) => setTimeout(res, 100));
  const ents = reg.dp.entries;
  check(ents[0].zap.state === 'sent' && ents[1].zap.state === 'failed' && ents[2].zap.state === 'waiting' && ents[3].zap.state === 'sent', 'b2 sent; over a day old → failed, not sent; not yet settled → left; already sent → left');
  check(off.resume(reg) === 0, 'b3 off: nothing is sent at boot');

  // pruning
  const pr = (e) => { z1.prune(e); return e.zap; };
  check(pr({ status: 'burned', zap: { state: 'minting', at: Date.now() } }) === undefined, 'x1 an entry that did not settle loses its zap record');
  check(pr({ status: 'reserved', zap: { state: 'minting', at: Date.now() - 30 * 86400e3 } }) !== undefined, 'x2 a live entry keeps it');
  check(pr({ status: 'settled', zap: { state: 'sent', sent_at: Date.now() - 8 * 86400e3 } }) === undefined, 'x3 a sent receipt\'s record goes after a week');
  check(pr({ status: 'settled', zap: { state: 'sent', sent_at: Date.now() - 86400e3 } }) !== undefined, 'x3 … and stays before');
  check(pr({ status: 'settled', settled_at: Date.now() - 30 * 86400e3, zap: { state: 'waiting', at: Date.now() - 30 * 86400e3 } }) !== undefined, 'x4 a receipt still to send is never pruned (boot resume decides)');
  check(pr({ status: 'settled' }) === undefined && pr({ status: 'chit', zap: { state: 'waiting' } }) === undefined, 'x5 nothing to prune; a chit-paid entry loses it');

  // ── 0.132.0: THE WALLET'S CHOICE
  const zNo = Z.createZaps({ enabled: true, dataDir: dir, log: (m) => logs.push(m), WebSocketImpl: fakeWs(() => 'ok') });   // no `allowed` handed in
  check(zNo.on && JSON.stringify(zNo.answerFields('dp')) === '{}' && zNo.fromCallback('dp', q(encodeURIComponent(GOOD_TEXT)), AMT).zap === null && !zNo.fromCallback('dp', '?nostr=garbage', AMT).error, 'w1 offered, but no wallet has chosen: no field on any answer, the nostr parameter ignored (a bad one too) — as before 0.131.0');
  const chosen = new Set(['dp']);
  const zW = mk({ allowed: (n) => chosen.has(n), countOn: () => chosen.size, WebSocketImpl: fakeWs(() => 'ok') });
  check(zW.answerFields('dp').allowsNostr === true && JSON.stringify(zW.answerFields('other')) === '{}' && JSON.stringify(zW.answerFields('')) === '{}' && JSON.stringify(zW.answerFields()) === '{}', 'w2 only the address whose wallet said yes answers allowsNostr; another address, and no name, nothing');
  check(!!zW.fromCallback('dp', q(encodeURIComponent(GOOD_TEXT)), AMT).zap && zW.fromCallback('other', q(encodeURIComponent(GOOD_TEXT)), AMT).zap === null && !zW.fromCallback('other', '?nostr=garbage', AMT).error, 'w2 … and only its callback reads a zap request');
  const eW = { hash: 'ee'.repeat(32), status: 'reserved', amount_msat: '21000' };
  eW.zap = zW.entryRecord(zW.fromCallback('dp', q(encodeURIComponent(GOOD_TEXT)), AMT).zap); zW.minted(eW, 'lnbc210n1w');
  chosen.delete('dp');   // the wallet turns zaps off while the payment is held
  eW.status = 'settled'; eW.accepted_at = Date.now() - 5000; eW.settled_at = Date.now();
  seen.length = 0; logs.length = 0;
  await zW.onSettled('dp', eW);
  check(seen.length === 0 && eW.zap.state === 'dropped' && !eW.zap.req && zW.summary().counts.dropped === 1 && logs.includes('[ZAP] dp: the wallet has zaps off — no receipt is sent'), 'w3 zaps turned off after the invoice was made: no receipt, no connection, the request dropped from the record');
  chosen.add('dp');
  await zW.onSettled('dp', eW);
  check(seen.length === 0 && eW.zap.state === 'dropped', 'w3 … and turning them on again does not send it late');
  const eChit = { hash: 'ab'.repeat(32), status: 'settled', settled_by: 'chit', settled_at: Date.now(), amount_msat: '21000', zap: Object.assign(zW.entryRecord(cbOk.zap), { state: 'waiting', bolt11: 'lnbc1' }) };
  seen.length = 0;
  zW.resume({ dp: { entries: [eChit] } }); await new Promise((res) => setTimeout(res, 50));
  check(seen.length === 0 && eChit.zap.state === 'dropped', 'w4 an entry a chit paid: no receipt at the settle and none at the next start (its invoice was cancelled)');
  const zThrow = mk({ allowed: () => { throw new Error('boom'); } });
  check(JSON.stringify(zThrow.answerFields('dp')) === '{}' && zThrow.fromCallback('dp', '?nostr=garbage', AMT).zap === null, 'w5 a choice that cannot be read is a no');
  check(JSON.stringify(zW.capability()) === JSON.stringify({ enabled: true, choice: 'wallet' }) && zW.summary().per_wallet === true && zW.summary().wallets_on === 1 && !('pubkey' in zW.summary()) && zW.bootLine().includes('(1 wallet(s) have zaps on)'), 'w6 /health says the choice is the wallet\'s; the summary counts the wallets with zaps on and names no key');

  // ── 0.132.0: the receipt's date
  const eT = { hash: 'cd'.repeat(32), status: 'settled', settled_at: 1763309999000, amount_msat: '21000', zap: { req: GOOD_TEXT, bolt11: 'lnbc1', state: 'waiting', at: 1763300007000 } };
  seen.length = 0; await z1.onSettled('dp', eT);
  check(seen.length === 3 && seen[0].sent[1].created_at === 1763300007, 't1 no accept time on the entry: dated when the invoice was made — never at the settle');
  const eT2 = { hash: 'ce'.repeat(32), status: 'settled', accepted_at: 1763300555000, settled_at: 1763309999000, amount_msat: '21000', zap: { req: GOOD_TEXT, bolt11: 'lnbc1', state: 'waiting', at: 1763300007000 } };
  seen.length = 0; await z1.onSettled('dp', eT2);
  check(seen.length === 3 && seen[0].sent[1].created_at === 1763300555, 't2 dated when the sender\'s payment reached the provider (accepted_at) — hours before a late settle');
  const eT3 = { hash: 'cf'.repeat(32), status: 'settled', settled_at: Date.now(), amount_msat: '21000', zap: { req: GOOD_TEXT, bolt11: 'lnbc1', state: 'waiting' } };
  seen.length = 0; await z1.onSettled('dp', eT3);
  check(seen.length === 0 && eT3.zap.state === 'failed', 't3 a record with no time at all: no receipt is made (never dated "now")');

  // ── 0.132.0: one receipt key per address
  const BK = 'ab'.repeat(32), BK2 = 'cd'.repeat(32);
  const nk = Z.nameKey(BK, 'dp');
  check(/^[0-9a-f]{64}$/.test(nk.sk) && nk.pk === schnorr.pubkey(Buffer.from(nk.sk, 'hex')).toString('hex') && Z.nameKey(BK, 'dp').sk === nk.sk, 'y1 an address\'s key: a valid key, the same each time');
  check(Z.nameKey(BK, 'lij').pk !== nk.pk && Z.nameKey(BK2, 'dp').pk !== nk.pk && nk.sk !== BK, 'y2 another address, or another box, gets another key; none is the box\'s secret');
  check(nk.sk === crypto.createHmac('sha256', Buffer.from(BK, 'hex')).update('lijox-zap-receipt-key-v1|dp', 'utf8').digest('hex'), 'y3 the key is HMAC-SHA256(the box\'s secret, "lijox-zap-receipt-key-v1|<name>")');
  let threw = 0; for (const bad of [[BK, ''], ['xyz', 'dp'], [BK, null]]) { try { Z.nameKey(bad[0], bad[1]); } catch (_) { threw++; } }
  check(threw === 3, 'y4 no name, or no box key: no key');

  // ── the wiring in lij-adapter.js
  const iAns = src.indexOf("if (!isRegister) Object.assign(answer, zaps.answerFields(name));");
  check(iAns > 0 && iAns < src.indexOf("    if (isRegister) {\n      const cur = lnurlpRegisterCurrency(rec);"), 's1 the two fields go on the plain answer only, before the Register branch');
  const iZ = src.indexOf("const zc = zaps.fromCallback(name, parsed.search, amt);");
  check(iZ > src.indexOf("return jsonResponse(res, { status: 'ERROR', reason: 'amount out of range' }, 400);") && iZ < src.indexOf("    // 0.67.0: never mint an expired hash (the wallet's engine would refuse") && src.includes("if (!isRegisterCb) {\n      const zc = zaps.fromCallback(name, parsed.search, amt);"), 's2 the request is checked after the amount and before a hash is picked; plain callback only');
  check(src.includes("return jsonResponse(res, { status: 'ERROR', reason: 'invalid zap request: ' + zc.error }, 400);"), 's3 a bad request is refused as an LNURL error');
  check(src.includes("update(zapReq ? zapReq.text : metaStr, 'utf8')"), 's4 a zap\'s invoice is tied to the request; every other invoice to the metadata as before');
  check(src.includes("delete entry.zap; if (zapReq) entry.zap = zaps.entryRecord(zapReq);") && src.includes("if (zapReq) { zaps.minted(entry, hodl.payment_request); lnurlpPersist();"), 's5 the record at the reservation and the invoice once minted');
  check((src.match(/zapSettled\(name, entry\);/g) || []).length === 4, 's6 the receipt hook at the four places an address entry becomes settled');
  const chitDone = src.slice(src.indexOf('function lnurlpChitDone('), src.indexOf('async function lnurlpCancelOuter('));
  check(!chitDone.includes('zapSettled'), 's7 a chit-paid entry sends no receipt (its invoice was cancelled)');
  check(src.includes("setTimeout(() => { try { zaps.resume(lnurlpRegistry); }") && src.includes("console.log(zaps.bootLine());") && src.includes("zaps:            zaps.capability(),"), 's8 the boot resume, the boot line, the capability on /health');
  check(src.includes("String(process.env.ZAPS_ENABLED || 'false').trim().toLowerCase() === 'true'"), 's9 off unless ZAPS_ENABLED=true');
  // 0.132.0: the wallet's choice, as the adapter reads and takes it
  check(src.includes("allowed: (name) => zapsWalletOn(name), countOn: () => zapsWalletsOn(),"), 's10 zap.js is handed the wallet\'s choice');
  const fnSrc = src.match(/function zapsWalletOn\(name\) \{[\s\S]*?\n\}\nfunction zapsWalletsOn\(\) \{[^\n]*\n/);
  check(!!fnSrc, 's11 zapsWalletOn and zapsWalletsOn are in the adapter');
  if (fnSrc) {
    const W = new Function('lnurlpRegistry', 'clientPrefs', fnSrc[0] + '; return { zapsWalletOn, zapsWalletsOn };')(
      { dp: { client_pubkey: '02AA' }, lij: { client_pubkey: '02aa' }, sam: { client_pubkey: '03bb' }, eve: { client_pubkey: '03cc' } },
      { '02aa': { zaps: true, hold_ms: 1 }, '03bb': { hold_ms: 5 }, '03cc': { zaps: false }, '03dd': { zaps: 'yes' } });
    check(W.zapsWalletOn('dp') && W.zapsWalletOn('LIJ') && !W.zapsWalletOn('sam') && !W.zapsWalletOn('eve') && !W.zapsWalletOn('nobody') && !W.zapsWalletOn('') && W.zapsWalletsOn() === 1,
      's11 the choice is the address OWNER\'s own: both addresses of a wallet that said yes; not a wallet that only set its holding, one that said no, or an unknown name');
  }
  check(src.includes("if (body && typeof body.zaps === 'boolean' && body.hold_ms === undefined) return clientPrefsZaps(body, res);") && src.includes("lnurlpAuthCheck(body, 'client-prefs', zpk, 'prefs-zaps:' + (body.zaps ? '1' : '0'))"), 's12 the wallet\'s choice is taken on POST /client/prefs { zaps }, proven by its node key over prefs-zaps:1 or prefs-zaps:0');
  const iForm = src.indexOf("function clientPrefsZaps(body, res) {"), iProof = src.indexOf("lnurlpAuthCheck(body, 'client-prefs', zpk,"), iWrite = src.indexOf("clientPrefs[zpk] = Object.assign(clientPrefs[zpk] || {}, { zaps: body.zaps, zaps_updated: Date.now() });");
  check(iForm > 0 && iProof > iForm && iWrite > iProof && src.slice(iProof, iWrite).includes("if (body.zaps && !zaps.on) return jsonResponse(res, { ok: false, error: 'not_offered'"), 's13 nothing is written before the proof holds; "on" is refused while this provider does not offer zaps');
  const zf = src.slice(iForm, src.indexOf('\n}\n', iForm));
  check(!zf.includes('touchWalletActive') && src.indexOf("return clientPrefsZaps(body, res);") < src.indexOf("|| typeof body.hold_ms !== 'number' || body.hold_ms < 0 || body.hold_ms > 86400000) {"), 's13 … it makes no "awake" stamp, and it is read before the holding form\'s own checks');
  check(src.includes("zaps: !!(clientPrefs[pk] && clientPrefs[pk].zaps === true), zaps_offered: zaps.on });"), 's14 the holding answer tells the wallet its zap choice as the provider holds it, and whether zaps are offered');
  check(!src.includes('the invoice is sealed to it') && src.includes('the invoice is tied to it') && !/sealed/.test(fs.readFileSync(path.join(__dirname, 'zap.js'), 'utf8')), 's15 the wording: an invoice is "tied to" its zap request (a hash) — nothing is called sealed');

  clearInterval(keepAlive);
  try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
  console.log(fails ? `\n${fails} FAILED` : '\nall zap checks pass'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · threw ' + (e && e.stack)); process.exit(1); });
