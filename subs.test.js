// 0.134.0 (S71): LIJOX Subscriptions — the provider's part. The rules of subs.js, run for real.
//   node subs.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const S = require('./subs');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };
const A = '02' + 'ab'.repeat(32), B = '03' + 'cd'.repeat(32);

(async () => {
  // n — names
  {
    const sa = S.sellingNameFor(A);
    check(/^subs--[0-9a-f]{26}$/.test(sa) && sa.length === 32 && sa === S.sellingNameFor(A.toUpperCase()) && sa !== S.sellingNameFor(B), 'n1 a wallet\'s selling name: 32 characters, from its key, another wallet\'s is another');
    check(S.isSellingName(sa) && !S.isSellingName('subs--xyz') && S.isOneUseName('once--k7q2m9x4t2ab') && !S.isOneUseName('once--K7Q2M9X4T2AB') && !S.isOneUseName('once--k7q2m9x4t1ab'), 'n2 the two reserved forms (a one-use name: 12 of a–z and 2–9)');
    check(S.nameRule('alice', A, {}).kind === 'plain' && S.nameRule('my-shop_2', A, {}).ok, 'n3 a standing address is untouched');
    check(S.nameRule(sa, A, { sellerOffered: true }).kind === 'selling', 'n4 the wallet\'s own selling name, at a provider that offers the service');
    check(S.nameRule(sa, B, { sellerOffered: true }).status === 403, 'n5 another wallet\'s selling name is refused');
    check(S.nameRule(sa, A, { sellerOffered: false }).status === 404, 'n6 no selling name at a provider without the service');
    check(S.nameRule('once--k7q2m9x4t2ab', A, {}).status === 404, 'n7 no one-use name until the provider has set its host');
    check(S.nameRule('once--k7q2m9x4t2ab', A, { oneUseHost: 'pay.example' }).kind === 'one-use', 'n8 a one-use name once the host is set');
    check(S.nameRule('once--k7q2m9x4t2ab', A, { oneUseHost: 'pay.example', oneUseNamesOfWallet: 20 }).status === 429 && S.nameRule('once--k7q2m9x4t2ab', A, { oneUseHost: 'pay.example', oneUseNamesOfWallet: 20, exists: true }).ok, 'n9 twenty live one-use names a wallet; adding hashes to one it has is not a new name');
    check(S.nameRule('alice--shop', A, { oneUseHost: 'x', sellerOffered: true }).status === 400 && S.nameRule('subs--', A, {}).status === 400, 'n10 any other name with "--" is refused');
  }
  // f — the seller service's fee
  {
    check(S.sellerFeeMsat(8000000n, '2', null) === 160000n && S.sellerFeeMsat('8000000', '1.5', null) === 120000n, 'f1 a percentage of the payment, in millisats');
    check(S.sellerFeeMsat(8000000n, '2', 100) === 100000n && S.sellerFeeMsat(8000000n, '2', 200) === 160000n, 'f2 the cap, when one is set');
    check(S.sellerFeeMsat(8000000n, '', null) === 0n && S.sellerFeeMsat(8000000n, '0', null) === 0n && S.sellerFeeMsat(8000000n, undefined, null) === 0n, 'f3 no fee set: none taken');
    check(S.sellerFeeMsat(999n, '0.1', null) === 0n && S.sellerFeeMsat(1001n, '0.1', null) === 1n, 'f4 rounded down to a whole millisat');
    check(S.parsePct('101') === null && S.parsePct('2%') === null && S.parsePct('-1') === null && S.parsePct('1.23456') === null && S.parsePct('100').n === 100n, 'f5 a percentage that does not read, or over 100, is no percentage');
    check(S.sellerFeeMsat(8000000n, 'abc', null) === 0n && S.sellerFeeMsat(5n, '100', null) === 0n, 'f6 a setting that does not read takes nothing; never the whole payment');
  }
  // m — the sidecar's ask for an invoice
  {
    const d = 'lijox-subs/1 coffee-club #1 01b7594b75f1e059ce7e766c474409bc';
    const good = S.mintRequest({ client_pubkey: A, amount_msat: '8000000', description: d, expiry_s: 600 });
    check(good.ok && good.amountMsat === 8000000n && good.description === d && good.expiryS === 600 && good.client === A, 'm1 a seller\'s key, an amount, a subscription\'s description, a life');
    check(S.mintRequest({ client_pubkey: A, amount_msat: 8000000, description: d }).expiryS === 600, 'm2 the life is 600 s when none is given');
    check(good.noFee === false && S.mintRequest({ client_pubkey: A, amount_msat: '8000000', description: d, no_fee: true }).noFee === true && S.mintRequest({ client_pubkey: A, amount_msat: '8000000', description: d, no_fee: 'yes' }).noFee === false, 'm2b no_fee is the sidecar\'s word for a seller on the monthly service — true only when it is exactly true');
    for (const [bad, why] of [
      [{ client_pubkey: 'x', amount_msat: '1', description: d }, 'no key'], [{ client_pubkey: A, amount_msat: '0', description: d }, 'no amount'],
      [{ client_pubkey: A, amount_msat: '-5', description: d }, 'a negative amount'], [{ client_pubkey: A, amount_msat: '1', description: 'coffee' }, 'a description that is no subscription\'s'],
      [{ client_pubkey: A, amount_msat: '1', description: d + ' and more' }, 'more after the tag'], [{ client_pubkey: A, amount_msat: '1', description: d.replace('#1', '#0') }, 'payment number 0'],
      [{ client_pubkey: A, amount_msat: '1', description: d.replace('coffee-club', 'a|b') }, 'a plan id with a separator'], [{ client_pubkey: A, amount_msat: '1', description: d, expiry_s: 601 }, 'a life over 600 s'],
      [{ client_pubkey: A, amount_msat: '1', description: d, expiry_s: 30 }, 'a life under a minute'], [null, 'nothing'],
    ]) check(!S.mintRequest(bad).ok, 'm3 refused: ' + why);
  }
  // d — the local door
  {
    const secret = 'a-long-shared-secret-0123';
    const rq = (h, ra) => ({ headers: h, socket: { remoteAddress: ra } });
    check(S.localDoorOk(rq({ 'x-subs-secret': secret }, '127.0.0.1'), secret) && S.localDoorOk(rq({ 'x-subs-secret': secret }, '::1'), secret) && S.localDoorOk(rq({ 'x-subs-secret': secret }, '::ffff:127.0.0.1'), secret), 'd1 the secret from this box itself');
    check(!S.localDoorOk(rq({ 'x-subs-secret': secret }, '10.0.0.5'), secret), 'd2 the right secret from another machine is refused');
    check(!S.localDoorOk(rq({ 'x-subs-secret': secret, 'cf-connecting-ip': '1.2.3.4' }, '127.0.0.1'), secret) && !S.localDoorOk(rq({ 'x-subs-secret': secret, 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1'), secret), 'd3 a request that came through the public front is refused, whatever its secret');
    check(!S.localDoorOk(rq({ 'x-subs-secret': 'a-long-shared-secret-0124' }, '127.0.0.1'), secret) && !S.localDoorOk(rq({}, '127.0.0.1'), secret), 'd4 a wrong secret, or none');
    check(!S.localDoorOk(rq({ 'x-subs-secret': 'short' }, '127.0.0.1'), 'short') && !S.localDoorOk(rq({ 'x-subs-secret': '' }, '127.0.0.1'), ''), 'd5 no secret set (or one under 16 characters): the door stays shut');
  }
  // r — the records a wallet's key signs (the engine's twins)
  {
    check(S.wakeRecordId([1795000000, 1795600000]) === 'wake:2:' + crypto.createHash('sha256').update('1795000000,1795600000').digest('hex'), 'r1 the reminder list\'s record: the count and the SHA-256 of the times joined by commas');
    check(S.wakeRecordId([]) === 'wake:0:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'r2 an empty list (the delete) has its own record');
    check(S.sellerRecordId('{"do":"state"}') === 'subs-seller:' + crypto.createHash('sha256').update('{"do":"state"}').digest('hex'), 'r3 a seller\'s request: the SHA-256 of its text as sent');
  }
  // w — reminder times
  {
    const now = 1795000000;
    const a = S.wakeTimes([now + 500, now + 100, now + 500, now - 100], now);
    check(a.ok && JSON.stringify(a.kept) === JSON.stringify([now - 100, now + 100, now + 500]) && a.times.length === 4, 'w1 kept sorted, each once; the list as sent stays whole for the record');
    check(!S.wakeTimes(Array.from({ length: 65 }, (_, i) => now + i + 1), now).ok && S.wakeTimes(Array.from({ length: 64 }, (_, i) => now + i + 1), now).ok, 'w2 at most 64');
    check(!S.wakeTimes([now + 401 * 86400 + 1], now).ok && S.wakeTimes([now + 400 * 86400], now).ok, 'w3 none more than 400 days ahead');
    check(!S.wakeTimes([1.5], now).ok && !S.wakeTimes(['1795000001'], now).ok && !S.wakeTimes([0], now).ok && !S.wakeTimes('x', now).ok, 'w4 whole unix seconds only');
    check(S.wakeTimes([now - 2 * 86400], now).kept.length === 0, 'w5 a time more than a day past is not kept');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-'));
    const file = path.join(dir, 'subs-wake.json');
    const st = S.createWakeStore({ file });
    st.set(A, [now + 100, now + 500]); st.set(B, [now + 300]);
    check(st.wallets() === 2 && st.times() === 3 && (fs.statSync(file).mode & 0o777) === 0o600, 'w6 the lists are written, readable by this user only');
    check(st.due(now + 50).length === 0, 'w7 nothing is due before the first time');
    check(JSON.stringify(st.due(now + 100)) === JSON.stringify([A]) && JSON.stringify(st.get(A)) === JSON.stringify([now + 500]), 'w8 a time that has come is handed back once and taken off');
    check(st.due(now + 100).length === 0, 'w9 not a second time');
    const again = S.createWakeStore({ file });
    check(JSON.stringify(again.get(A)) === JSON.stringify([now + 500]) && JSON.stringify(again.get(B)) === JSON.stringify([now + 300]), 'w10 a restart reads the lists back');
    check(JSON.stringify(again.due(now + 600).sort()) === JSON.stringify([A, B].sort()) && again.wallets() === 0, 'w11 two times of one wallet that passed together are one wake');
    st.set(A, [now + 100]); check(st.due(now + 100 + 2 * 86400).length === 0 && st.get(A).length === 0, 'w12 a time this box slept through for over a day is dropped unsent');
    st.set(B, [now + 9]); st.set(B, []); check(st.get(B).length === 0, 'w13 an empty list deletes');
    fs.writeFileSync(file, 'not json'); let said = '';
    const broken = S.createWakeStore({ file, log: (m) => { said = m; } });
    check(broken.wallets() === 0 && /could not be read/.test(said), 'w14 a file that does not read starts empty and says so');
  }
  // c — what the provider offers, from its settings
  {
    const off = S.createSubs({});
    check(off.capability() === null && off.oneUse() === null && !off.sellerOffered && off.wakeCapability().enabled && /seller service: off/.test(off.bootLine()) && /one-use addresses: off/.test(off.bootLine()), 'c1 nothing set: reminder times only');
    const on = S.createSubs({ SUBS_SIDECAR_URL: 'https://subs.example/s/', SUBS_SIDECAR_LOCAL: 'http://127.0.0.1:7010', SUBS_SIDECAR_SECRET: 'a-long-shared-secret-0123', SUBS_SELLER_FEE_PCT: '2', SUBS_SELLER_FEE_CAP_SAT: '200', LNURLP_ONE_USE_HOST: 'https://Pay.Example/x' });
    check(on.sellerOffered && on.capability().url === 'https://subs.example/s' && on.oneUse().host === 'pay.example' && on.feeMsat(8000000n) === 160000n && on.feeMsat(80000000n) === 200000n, 'c2 all set: the address without its last slash, the one-use host as a bare host, the fee and its cap');
    check(!S.createSubs({ SUBS_SIDECAR_URL: 'https://subs.example', SUBS_SIDECAR_LOCAL: 'http://127.0.0.1:7010', SUBS_SIDECAR_SECRET: 'short' }).sellerOffered && !S.createSubs({ SUBS_SIDECAR_URL: 'http://subs.example', SUBS_SIDECAR_LOCAL: 'http://127.0.0.1:7010', SUBS_SIDECAR_SECRET: 'a-long-shared-secret-0123' }).sellerOffered, 'c3 a short secret, or a public address without https: the seller service is not offered');
    check(S.createSubs({ SUBS_SELLER_FEE_PCT: 'lots' }).feeMsat(8000000n) === 0n, 'c4 a fee setting that does not read takes nothing');
  }
  // p — the sidecar on this box is asked with the secret; no answer is an error answer, never a throw
  {
    let seen = null;
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { seen = { secret: req.headers['x-subs-secret'], url: req.url, body: JSON.parse(b) }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'OK', echo: 1 })); }); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const on = S.createSubs({ SUBS_SIDECAR_URL: 'https://subs.example', SUBS_SIDECAR_LOCAL: 'http://127.0.0.1:' + port, SUBS_SIDECAR_SECRET: 'a-long-shared-secret-0123' });
    const a = await on.toSidecar('/seller', { seller: A, request: { do: 'state' } });
    check(a.code === 200 && a.json.status === 'OK' && seen.secret === 'a-long-shared-secret-0123' && seen.url === '/seller' && seen.body.seller === A, 'p1 the request reaches the sidecar with the secret');
    await new Promise((r) => srv.close(r));
    const gone = await on.toSidecar('/seller', {});
    check(gone.code === 0 && gone.json.status === 'ERROR' && gone.json.code === 'SIDECAR', 'p2 a sidecar that is not running is an error answer');
    check((await S.postLocal('not a url', 'x', {})).json.code === 'SIDECAR', 'p3 no address set is an error answer');
  }
  console.log(fails ? 'FAIL · subs · ' + fails + ' failed' : 'PASS · subs (n, f, m, d, r, w, c, p)');
  process.exit(fails ? 1 : 0);
})();
