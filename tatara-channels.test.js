// 0.103.0 (S58 — Tatara step 12, the channel route): the provider's watch over a channel pool's pending channels
// (tatara-channels.js) against a stand-in LND — pending channels, spend notifications, the tip, AbandonChannel.
//   node tatara-channels.test.js
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createChannelWatch, inputsOf, SETTLE_DEPTH, ALERT_BLOCKS } = require('./tatara-channels');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };

// a segwit funding with two inputs (the members' coins), one output — hand-built, so inputsOf is checked on known bytes
const rev = (h) => Buffer.from(h, 'hex').reverse().toString('hex');
const IN1 = 'aa'.repeat(32), IN2 = 'bb'.repeat(32);
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b.toString('hex'); };
const FUND = '02000000' + '0001' + '02' + rev(IN1) + le32(0) + '00' + 'ffffffff' + rev(IN2) + le32(3) + '00' + 'ffffffff'
  + '01' + '40420f0000000000' + '22' + '5120' + '66'.repeat(32) + '00' + '00' + '00000000';
const IN3 = 'cc'.repeat(32), IN4 = 'dd'.repeat(32);
const FUND2 = '02000000' + '0001' + '02' + rev(IN3) + le32(1) + '00' + 'ffffffff' + rev(IN4) + le32(0) + '00' + 'ffffffff'
  + '01' + '40420f0000000000' + '22' + '5120' + '77'.repeat(32) + '00' + '00' + '00000000';
const FUND_TXID = 'f1'.repeat(32), EXIT1 = 'e1'.repeat(32), EXIT2 = 'e2'.repeat(32);
const CP1 = EXIT2 + ':1', CP_OTHER = 'c0'.repeat(32) + ':0';

(async () => {
  // c1 — the inputs of a raw transaction, in display order, with their vouts
  const ins = inputsOf(FUND);
  check(ins.length === 2 && ins[0].txid === IN1 && ins[0].vout === 0 && ins[1].txid === IN2 && ins[1].vout === 3, 'c1 inputsOf: two inputs, txids in display order, vouts 0 and 3');
  check(inputsOf('0100000001' + rev(IN1) + le32(7) + '00' + 'ffffffff' + '00' + '00000000').length === 1, 'c1 a legacy (non-segwit) transaction parses too');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tatara-ch-'));
  const logs = []; const log = (m) => logs.push(m);
  let pending = [CP1, CP_OTHER]; let tip = 1000; const abandoned = []; const streams = {}; let abandonOk = true;
  const deps = () => ({
    log, dataDir: dir, now: () => 1_800_000_000_000,
    backups: () => [{ attempt_id: '11'.repeat(16), funding_hex: FUND, funding_txid: FUND_TXID, exit_txids: [EXIT1, EXIT2] }],
    pendingChannels: async () => pending.slice(),
    abandonChannel: async (txid, vout) => { abandoned.push(txid + ':' + vout); return abandonOk ? { ok: true } : { ok: false, error: 'permission denied' }; },
    watchSpend: ({ txid, vout }, cb) => { streams[txid + ':' + vout] = cb; return { close: () => { delete streams[txid + ':' + vout]; } }; },
    tipHeight: async () => tip,
  });
  let W = createChannelWatch(deps());

  // c2 — a pending channel a backup explains is watched (its funding's inputs); one the backups do not explain is not
  let r = await W.tick();
  check(r.watched === 1 && W.watched()[CP1] && W.watched()[CP1].inputs.length === 2 && Object.keys(streams).sort().join(',') === IN1 + ':0,' + IN2 + ':3' && !W.watched()[CP_OTHER],
    'c2 the pool\'s pending channel is watched through its funding\'s two inputs; a channel no backup explains is left to LND');
  check(fs.existsSync(path.join(dir, 'tatara', 'channels.json')), 'c2 the watch is written to channels.json');

  // c3 — an input spent by the pool's own funding = funded; nothing is abandoned, ever
  streams[IN1 + ':0']({ spending_txid: FUND_TXID, height: 1001 });
  tip = 1100;
  r = await W.tick();
  check(W.watched()[CP1].funded_at === 1001 && abandoned.length === 0, 'c3 the pool\'s funding spent the input: funded, not abandoned');
  // the 144-block alert, once
  tip = 1001 + ALERT_BLOCKS;
  await W.tick(); await W.tick();
  check(logs.filter((m) => /ALERT/.test(m)).length === 1 && /144 blocks/.test(logs.find((m) => /ALERT/.test(m))), 'c3 the pool funded 144 blocks ago and the exit still pending: one alert');

  // c4 — a restart keeps the watch (streams opened again); an input spent ELSEWHERE 6 deep → AbandonChannel
  for (const k of Object.keys(streams)) delete streams[k];
  W = createChannelWatch(deps());
  check(W.watched()[CP1] && Object.keys(streams).join(',') === IN2 + ':3', 'c4 after a restart the watch is back and only the unspent input\'s stream is opened again');
  // a fresh pool whose input goes elsewhere
  const CP2 = EXIT1 + ':0';
  pending = [CP1, CP2];
  W = createChannelWatch(Object.assign(deps(), { backups: () => [{ attempt_id: '22'.repeat(16), funding_hex: FUND2, funding_txid: 'f2'.repeat(32), exit_txids: [EXIT1] }, { attempt_id: '11'.repeat(16), funding_hex: FUND, funding_txid: FUND_TXID, exit_txids: [EXIT2] }] }));
  await W.tick();
  streams[IN4 + ':0']({ spending_txid: '99'.repeat(32), height: 2000 });   // the second pool's input went elsewhere
  tip = 2000 + SETTLE_DEPTH - 2;
  await W.tick();
  check(abandoned.length === 0, 'c4 five deep: not yet');
  tip = 2000 + SETTLE_DEPTH - 1;
  r = await W.tick();
  check(abandoned.length === 1 && abandoned[0] === CP2 && r.abandoned === 1 && !W.watched()[CP2] && W.watched()[CP1], 'c4 six deep: the unfunded pool\'s channel is abandoned (channel_point); the funded one stays');
  // AbandonChannel refused (the key lacks it): said, and tried again next tick
  pending = [CP1, CP2]; abandonOk = false; abandoned.length = 0;
  W = createChannelWatch(Object.assign(deps(), { backups: () => [{ attempt_id: '22'.repeat(16), funding_hex: FUND2, funding_txid: 'f2'.repeat(32), exit_txids: [EXIT1] }] }));
  await W.tick();
  streams[IN3 + ':1']({ spending_txid: '98'.repeat(32), height: 2100 }); tip = 2110;
  await W.tick(); await W.tick();
  check(abandoned.length === 2 && logs.some((m) => /could not be abandoned: permission denied/.test(m)), 'c4 a refused AbandonChannel is said (the key) and tried again');

  // c5 — a channel no longer pending is forgotten
  pending = [CP1];
  await W.tick();
  check(!W.watched()[CP2] && logs.some((m) => /no longer pending/.test(m)), 'c5 a channel that left LND\'s pending list is forgotten');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? 'FAIL · tatara-channels · ' + fails + ' failed' : 'PASS · tatara-channels (c1–c5)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · tatara-channels threw: ' + (e && e.stack || e)); process.exit(1); });
