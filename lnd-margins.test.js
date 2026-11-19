// lnd-margins.test.js — 0.133.4: how many blocks below an incoming HTLC's expiry LND goes on-chain when it holds the
// preimage, by LND's version (10 below 0.21; 16 from 0.21 — read in LND's lncfg/config.go at each tag named below).
//   node lnd-margins.test.js
const { incomingBroadcastDelta, parseVersion, SAFE } = require('./lnd-margins');
let fails = 0;
const eq = (a, b, m) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log((ok ? '  ok · ' : 'FAIL · ') + m + (ok ? '' : ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b))); if (!ok) fails++; };
const d = (v, o) => { const r = incomingBroadcastDelta(v, o); return [r.delta, r.source]; };

eq([parseVersion('0.21.8-beta commit=v0.21.8-beta-terminus'), parseVersion('v0.20.1-beta'), parseVersion('0.19'), parseVersion(''), parseVersion(undefined), parseVersion('beta')], [[0, 21, 8], [0, 20, 1], [0, 19, 0], null, null, null], 'p1 the version as LND\'s getinfo gives it → numbers; nothing readable → null');
// the tags read in LND's source on 2026-11-19
eq([d('0.19.3-beta commit=v0.19.3-beta'), d('0.20.1-beta commit=v0.20.1-beta'), d('0.20.1-beta commit=v0.20.1-beta-dirty')], [[10, 'version'], [10, 'version'], [10, 'version']], 'v1 LND 0.19.3 and 0.20.1: 10 blocks');
eq([d('0.21.0-beta commit=v0.21.0-beta'), d('0.21.6-beta commit=v0.21.6-beta'), d('0.21.8-beta commit=v0.21.8-beta'), d('0.21.8-beta commit=v0.21.8-beta-terminus')], [[16, 'version'], [16, 'version'], [16, 'version'], [16, 'version']], 'v2 LND 0.21.0, 0.21.6, 0.21.8 and the boxes\' own build of 0.21.8: 16 blocks');
eq([d('0.22.0-beta'), d('1.0.0'), d('0.18.5-beta'), d('0.9.0')], [[16, 'version'], [16, 'version'], [10, 'version'], [10, 'version']], 'v3 a later LND keeps the newest figure known (16); an older one 10');
eq([d(''), d(undefined), d('unknown-build'), d(null)], [[SAFE, 'unknown'], [SAFE, 'unknown'], [SAFE, 'unknown'], [SAFE, 'unknown']], 'v4 a version that cannot be read: the larger figure (16) — an earlier time for the wallet user, never a later one');
eq(SAFE, 16, 'v4 … and that figure is 16');
// the operator's setting
eq([d('0.21.8-beta', '12'), d('0.20.1-beta', 20), d('', ' 10 '), d('0.21.8-beta', '144'), d('0.21.8-beta', '1')], [[12, 'setting'], [20, 'setting'], [10, 'setting'], [144, 'setting'], [1, 'setting']], 's1 LND_INCOMING_BROADCAST_DELTA, a whole number of blocks from 1 to 144, wins over the version');
eq([d('0.21.8-beta', ''), d('0.21.8-beta', undefined), d('0.20.1-beta', null), d('0.20.1-beta', '   ')], [[16, 'version'], [16, 'version'], [10, 'version'], [10, 'version']], 's2 an empty setting is no setting');
const bad = ['0', '-3', '145', '10.5', 'ten', '1e2x'].map((o) => { const r = incomingBroadcastDelta('0.21.8-beta', o); return [r.delta, r.source, r.bad_setting === true, /not a whole number from 1 to 144 — not used/.test(r.note)]; });
eq(bad, bad.map(() => [16, 'version', true, true]), 's3 a setting that is not a whole number in range is not used, and the note says so — the version\'s figure stands');
eq([incomingBroadcastDelta('0.21.8-beta commit=v0.21.8-beta', null).note, incomingBroadcastDelta('0.21.8-beta commit=x', '12').note, /could not be read/.test(incomingBroadcastDelta('', null).note), incomingBroadcastDelta('0.21.8-beta commit=x').version], ['LND 0.21.8-beta', 'LND_INCOMING_BROADCAST_DELTA=12', true, '0.21.8-beta'], 'n1 the note names where the figure came from, for the journal and the Settings report');
console.log(fails ? `\nFAILED: ${fails}` : '\nlnd-margins: all checks passed');
process.exit(fails ? 1 : 0);
