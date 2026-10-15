// 0.97.0 (S58, DP 2026-10-12 22:07 — LIJOX's Tatara, step 5 slice 1): the module's settings (spec v0.10 §11.1) and
// GET /tatara/info.   node tatara-settings.test.js
'use strict';
const { createTatara, readSettings, readLndRoom, relayUrlOf } = require('./tatara');
const fs = require('fs'); const os = require('os'); const path = require('path');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const has = (st, re) => st.problems.some((p) => re.test(p));

(async () => {
  // s1 — defaults: off, and every default within bounds
  let st = readSettings({});
  check(st.enabled === false && st.ok && JSON.stringify(st.s.sizes) === '[50000,100000,250000,1000000]' && st.s.min_people === 3 && st.s.max_people === 6 &&
        st.s.countdown_s === 600 && st.s.wake_window_s === 180 && st.s.max_retries === 2 && st.s.strikes === 4 && st.s.max_fee_rate === 20 &&
        st.s.channel_pools === false && st.s.forward_payouts && st.s.relay_for_others && st.s.forward_coin_checks && st.s.coin_check_url === '',
        's1 defaults: off; 50k/100k/250k/1M; 3–6 people; 600 s; 180 s; 2 retries; 4 strikes; 20 sat/vB; no channel pools; forwards and relays');
  // s2 — on with the defaults
  st = readSettings({ TATARA_ENABLED: 'true' });
  check(st.enabled && st.ok, 's2 TATARA_ENABLED=true with the defaults: on');
  // s3 — people
  check(has(readSettings({ TATARA_MIN_PEOPLE: '2' }), /MIN_PEOPLE=2 — LiJ pools are 3 to 6/) && has(readSettings({ TATARA_MAX_PEOPLE: '7' }), /MAX_PEOPLE=7/) &&
        has(readSettings({ TATARA_MIN_PEOPLE: '5', TATARA_MAX_PEOPLE: '4' }), /MIN_PEOPLE is above/) && has(readSettings({ TATARA_MIN_PEOPLE: '3.5' }), /MIN_PEOPLE/),
        's3 people: 2, 7, min above max and a fraction are each refused, named');
  // s4 — sizes
  st = readSettings({ TATARA_ENABLED: 'true', TATARA_SIZES: '250000, 50000,100000' });
  check(st.ok && JSON.stringify(st.s.sizes) === '[50000,100000,250000]', 's4 sizes given out of order are kept ascending (the record\'s order)');
  check(has(readSettings({ TATARA_SIZES: '50000,50000' }), /twice/) && has(readSettings({ TATARA_SIZES: '9999' }), /at least 10,000/) &&
        has(readSettings({ TATARA_SIZES: '50k' }), /TATARA_SIZES/) && has(readSettings({ TATARA_SIZES: Array.from({ length: 13 }, (_, i) => 10000 * (i + 1)).join(',') }), /1 to 12/),
        's4 a size twice, below 10,000, not a number, or 13 sizes: refused');
  // s5 — channel pools (0.103.0, Phase 1b): sizes, the channel limits, and LND's room for a retry's channels
  check(has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '250000' }), /maxpendingchannels confirmed at 3 or more — set TATARA_LND_CONF/) &&
        has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '250000' }, { lndConf: '/x/lnd.conf', maxPendingChannels: null }), /\/x\/lnd.conf: not readable/) &&
        has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '250000' }, { maxPendingChannels: 1 }), /maxpendingchannels ≥ 3 \(retries \+ 1\) in lnd.conf — it is 1/) &&
        has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '250000', TATARA_MAX_RETRIES: '4' }, { maxPendingChannels: 4 }), /≥ 5/) &&
        has(readSettings({ TATARA_CHANNEL_SIZES: '250000' }), /CHANNEL_POOLS is not true/) && has(readSettings({ TATARA_CHANNEL_POOLS: 'true' }, { maxPendingChannels: 3 }), /needs TATARA_CHANNEL_SIZES/) &&
        !has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '70000' }, { maxPendingChannels: 3 }), /TATARA_CHANNEL_SIZES/) &&   // 0.105.0: a channel size need not be an on-chain size
        has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '70000,70000' }, { maxPendingChannels: 3 }), /TATARA_CHANNEL_SIZES names a size twice/) &&
        has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '7000' }, { maxPendingChannels: 3 }), /TATARA_CHANNEL_SIZES=7000 — 1 to 12/) &&
        has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '50000' }, { maxPendingChannels: 3, minChanSize: 100000, maxChanSize: 16777215, lndConf: '/l' }), /outside LND's channel limits \(100000–16777215 sats/) &&
        has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '1000000' }, { maxPendingChannels: 3, minChanSize: 20000, maxChanSize: 500000 }), /outside LND's channel limits \(20000–500000/) &&
        !has(readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '50000' }, { maxPendingChannels: 3, minChanSize: 100000, maxChanSize: 16777215, minChannelSats: 100000 }), /provider's channel limits/) &&
        readSettings({ TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '50000' }, { maxPendingChannels: 3, minChanSize: 20000, maxChanSize: 16777215, minChannelSats: 100000, maxChannelSats: 2000000 }).ok,
        's5 channel pools: refused without LND\'s room confirmed (the lnd.conf named), with room below retries + 1, without sizes, with a size not offered or outside LND\'s own limits (0.103.2: MIN/MAX_CHANNEL_SATS no longer count — a 50,000 pool passes under MIN_CHANNEL_SATS=100,000)');
  const cp = readSettings({ TATARA_ENABLED: 'true', TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '250000,100000' }, { maxPendingChannels: 10 });
  check(cp.ok && cp.enabled && JSON.stringify(cp.s.channel_sizes) === '[100000,250000]', 's5 channel pools on: the sizes kept ascending');
  // s6 — the coin-check address
  check(has(readSettings({ TATARA_COIN_CHECK_URL: 'http://filters.example.com/coin' }), /plain https/) && has(readSettings({ TATARA_COIN_CHECK_URL: 'https://x.org/' }), /plain https/) &&
        readSettings({ TATARA_COIN_CHECK_URL: 'https://filters.example.com/coin' }).ok, 's6 coin-check address: http and a trailing slash refused, plain https kept');
  // s7 — switches and the rest
  check(has(readSettings({ TATARA_ENABLED: 'yes' }), /TATARA_ENABLED must be/) && has(readSettings({ TATARA_FORWARD_PAYOUTS: '1' }), /FORWARD_PAYOUTS must be/) &&
        has(readSettings({ TATARA_MAX_POOLS_TOTAL: '2' }), /TOTAL is below/) && has(readSettings({ TATARA_MAX_LIST_PER_SIZE: '5' }), /below TATARA_MAX_PEOPLE/) &&
        has(readSettings({ TATARA_MAX_FEE_RATE: '0' }), /MAX_FEE_RATE/) && has(readSettings({ TATARA_WAKE_WINDOW_S: '30' }), /WAKE_WINDOW_S/),
        's7 a switch that is not true/false, total below per size, list below people, fee cap 0, a 30-s wake window: refused');
  // s8 — the module and GET /tatara/info
  const answers = [];
  const jr = (res, body, code) => answers.push({ code: code || 200, body });
  const off = createTatara({ env: {}, publicHttpsUrl: 'https://lsp.example.com' });
  check(off.recordBlock() === null && await off.handle({}, {}, '/tatara/info', 'GET', '', null, jr) && answers.pop().code === 404 && /off \(TATARA_ENABLED/.test(off.startupLines()[0]),
        's8 off: no record block, /tatara/info 404, the startup line says off');
  const bad = createTatara({ env: { TATARA_ENABLED: 'true', TATARA_MIN_PEOPLE: '2' }, publicHttpsUrl: 'https://lsp.example.com' });
  check(bad.recordBlock() === null && /REFUSED/.test(bad.startupLines()[0]) && /MIN_PEOPLE=2/.test(bad.startupLines()[1]) && await bad.handle({}, {}, '/tatara/info', 'GET', '', null, jr) && answers.pop().code === 404,
        's8 on with a bad value: REFUSED, the value named, nothing declared, /tatara/info 404');
  const on = createTatara({ env: { TATARA_ENABLED: 'true' }, publicHttpsUrl: () => 'https://lsp.example.com/' });
  const onc = createTatara({ env: { TATARA_ENABLED: 'true', TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '250000' }, publicHttpsUrl: 'https://lsp.example.com', lndRoom: () => ({ maxPendingChannels: 3, lndConf: '/l' }) });
  check(onc.recordBlock() && onc.recordBlock().channel_pools === true && JSON.stringify(onc.recordBlock().channel_sizes) === '[250000]' && /channel pools 250000 sats/.test(onc.startupLines()[0]),
        's5 the record block declares the channel pools; the startup line names them');
  await on.handle({}, {}, '/tatara/info', 'GET', '', null, jr);
  const a = answers.pop();
  check(a.code === 200 && a.body.ok && a.body.settings.relay_url === 'wss://lsp.example.com/tatara/relay' && a.body.arrangement === 'v0.8' && /^\[Tatara\] on/.test(on.startupLines()[0]),
        's8 on: /tatara/info answers the declared settings; the relay rides the API host at /tatara/relay');
  check(await on.handle({}, {}, '/tatara/nope', 'POST', '', null, jr) && answers.pop().code === 404 && !(await on.handle({}, {}, '/v1/other', 'GET', '', null, jr)),
        's8 an unknown route: 404; a path outside /tatara is not taken');
  // s9 — the relay address
  check(relayUrlOf('https://lsp.example.com') === 'wss://lsp.example.com/tatara/relay' && relayUrlOf('http://lsp.example.com') === '' && relayUrlOf('') === '' &&
        /PUBLIC_HTTPS_URL is not an https/.test(createTatara({ env: { TATARA_ENABLED: 'true' }, publicHttpsUrl: 'http://x' }).startupLines()[0]),
        's9 the relay address comes from PUBLIC_HTTPS_URL; without an https address the module says so');
  // s10 (0.103.1) — the lnd.conf room reader on a real file (0.103.0's copy in lij-adapter.js threw on an undefined fs)
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lndconf-'));
  fs.writeFileSync(path.join(d, 'lnd.conf'), '[Application Options]\nalias=x\n; a comment\nmaxpendingchannels=10\n[Bitcoin]\n');
  fs.writeFileSync(path.join(d, 'none.conf'), '[Application Options]\nalias=x\n');
  const r1 = readLndRoom(path.join(d, 'lnd.conf')), r2 = readLndRoom(path.join(d, 'none.conf')), r3 = readLndRoom(path.join(d, 'missing.conf')), r4 = readLndRoom('');
  check(r1.maxPendingChannels === 10 && r1.lndConf === path.join(d, 'lnd.conf') && r2.maxPendingChannels === null && r2.lndConf && r3.maxPendingChannels === null && r3.lndConf && r4.maxPendingChannels === null && r4.lndConf === '',
        's10 readLndRoom: the line read (10); no line → null; a missing file → null with the path; no path → null without');
  // s11 (0.103.2) — LND's own channel limits from the same file: the lines when present, LND's defaults when absent (wumbo
  // raises the default ceiling), 0 = not set, nulls when the file was not read; and the size check uses them
  fs.writeFileSync(path.join(d, 'limits.conf'), '[Application Options]\nminchansize=100000\nmaxchansize=2000000\nmaxpendingchannels=10\n');
  fs.writeFileSync(path.join(d, 'wumbo.conf'), '[Application Options]\nmaxpendingchannels=3\nmaxchansize=0\n[protocol]\nprotocol.wumbo-channels=true\n');
  const l1 = readLndRoom(path.join(d, 'lnd.conf')), l2 = readLndRoom(path.join(d, 'limits.conf')), l3 = readLndRoom(path.join(d, 'wumbo.conf')), l4 = readLndRoom(path.join(d, 'missing.conf'));
  check(l1.minChanSize === 20000 && l1.maxChanSize === 16777215 && l2.minChanSize === 100000 && l2.maxChanSize === 2000000 && l3.minChanSize === 20000 && l3.maxChanSize === 1000000000 && l3.maxPendingChannels === 3 && l4.minChanSize === null && l4.maxChanSize === null,
        's11 readLndRoom: LND\'s limits — defaults 20,000–16,777,215 when absent; the lines when present; wumbo → 1,000,000,000; a missing file → null');
  const sz = readSettings({ TATARA_ENABLED: 'true', TATARA_CHANNEL_POOLS: 'true', TATARA_SIZES: '50000,100000', TATARA_CHANNEL_SIZES: '50000,100000' }, readLndRoom(path.join(d, 'lnd.conf')));
  const szr = readSettings({ TATARA_ENABLED: 'true', TATARA_CHANNEL_POOLS: 'true', TATARA_SIZES: '50000,100000', TATARA_CHANNEL_SIZES: '50000,100000' }, readLndRoom(path.join(d, 'limits.conf')));
  check(sz.ok && sz.s.lnd_limits.min_chan_size === 20000 && !szr.ok && has(szr, /outside LND's channel limits \(100000–2000000 sats: minchansize\/maxchansize in .*limits\.conf/),
        's11 a 50,000 channel pool passes against a default lnd.conf and is refused, naming the file, against minchansize=100000');
  const live2 = createTatara({ env: { TATARA_ENABLED: 'true', TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '100000' }, publicHttpsUrl: 'https://lsp.example.com', lndRoom: () => readLndRoom(path.join(d, 'lnd.conf')) });
  check(/channel pools 100000 sats \(LND allows 20000–16777215\)/.test(live2.startupLines()[0]) && live2.settings().lnd_limits.max_chan_size === 16777215,
        's11 the startup line and settings() name the LND limits read');
  const live = createTatara({ env: { TATARA_ENABLED: 'true', TATARA_CHANNEL_POOLS: 'true', TATARA_CHANNEL_SIZES: '100000' }, publicHttpsUrl: 'https://lsp.example.com', lndRoom: () => readLndRoom(path.join(d, 'lnd.conf')) });
  check(/channel pools 100000 sats/.test(live.startupLines()[0]), 's10 the module on with the room read from a real lnd.conf');
  fs.rmSync(d, { recursive: true, force: true });
  // s12 (0.105.1, DP 2026-10-14 16:19 — a channel's coin after its close sits in the on-chain pools): no close list anywhere —
// the settings carry none, the record carries none (it signs v3), a stray TATARA_CLOSE_SIZES line is ignored, the
// startup line names no close pools
{
  const c1 = readSettings({ TATARA_ENABLED: 'true', TATARA_CLOSE_SIZES: '400000' });
  check(c1.ok && !('close_sizes' in c1.s), 's12 a TATARA_CLOSE_SIZES line is ignored — no close list in the settings');
  const tc = createTatara({ env: { TATARA_ENABLED: 'true', TATARA_CLOSE_SIZES: '400000' }, publicHttpsUrl: 'https://lsp.example.com' });
  check(tc.recordBlock() && !('close_sizes' in tc.recordBlock()) && !/close pools/.test(tc.startupLines()[0]), 's12 the record carries no close_sizes; the startup line names no close pools');
  const cp2 = readSettings({ TATARA_ENABLED: 'true', TATARA_CHANNEL_POOLS: 'true', TATARA_SIZES: '50000', TATARA_CHANNEL_SIZES: '250000' }, { maxPendingChannels: 10 });
  check(cp2.ok && JSON.stringify(cp2.s.channel_sizes) === '[250000]', 's12 a channel size outside TATARA_SIZES still stands (0.105.0\'s half that stays)');
}
console.log(fails ? 'FAIL · tatara-settings · ' + fails + ' failed' : 'PASS · tatara-settings (s1–s12)');
  process.exit(fails ? 1 : 0);
})();
