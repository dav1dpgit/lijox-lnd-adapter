// 0.136.0 (S71 Fri 2026-11-20): THE HIGH MARK AND THE PASS (state-marks.js).
//   node state-marks.test.js
// The real store in a temp directory, a clock the test moves. The numbers of m3 are the ones of 2026-11-20: a wallet
// that had stated 1788 and 707 came back holding 1785 and 699.
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { createStateMarks, signedText, canonical, cleanChannels, DOMAIN, PASS_FRAME, PASS_TTL_MS, SKEW_MS, MAX_CHANNELS } = require('./state-marks');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); } else ok(m); };
const PK = '02' + 'aa'.repeat(32), PK2 = '03' + 'bb'.repeat(32);
const A = 'a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4:0', B = 'b6'.repeat(32) + ':1';
let t = 1795000000000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
const logs = [];
const M = createStateMarks({ dataDir: dir, now: () => t, log: (m) => logs.push(m) });
const state = (pk, ch, want) => { t += 1000; return M.state(pk, ch, t, want); };

// m1 — the fixed form and the signed text
check(canonical({ [B]: 707, [A]: 1788 }) === A + '=1788,' + B + '=707' && canonical({}) === '', 'm1 the statement in its fixed form: sorted by name, "name=number", commas; empty for no channel');
check(signedText(PK, 5, { [A]: 1 }) === DOMAIN + PK + ':5:' + crypto.createHash('sha256').update(A + '=1').digest('hex') && DOMAIN === 'lijox-state-v1:', 'm1 what the node key signs: the key, the time, the hash of the fixed form');
check(cleanChannels({ [A]: 0 }) && !cleanChannels({ [A]: -1 }) && !cleanChannels({ [A]: 1.5 }) && !cleanChannels({ 'xyz:0': 1 }) && !cleanChannels([1]) && !cleanChannels(null) && !cleanChannels({ [A]: '7' }), 'm1 the shape: "64 hex:index" → a whole number, nothing else');
{ const big = {}; for (let i = 0; i <= MAX_CHANNELS; i++) big[i.toString(16).padStart(64, '0') + ':0'] = 1; check(!cleanChannels(big), 'm1 more than ' + MAX_CHANNELS + ' records: refused'); }

// m2 — a first statement sets the marks; a pass comes only when asked for
let r = state(PK, { [A]: 1785, [B]: 699 }, false);
check(r.ok && r.behind.length === 0 && r.pass === undefined, 'm2 a first statement is taken; no pass unless asked for', r);
check(JSON.stringify(M.marksOf(PK)) === JSON.stringify({ [A]: 1785, [B]: 699 }), 'm2 the marks are what was stated');
r = state(PK, { [A]: 1788, [B]: 707 }, true);
check(r.ok && r.behind.length === 0 && /^[0-9a-f]{64}$/.test(r.pass) && r.pass_ttl_s === Math.floor(PASS_TTL_MS / 1000), 'm2 a later statement with higher numbers: a pass, good for 90 s', r);
check(JSON.stringify(M.marksOf(PK)) === JSON.stringify({ [A]: 1788, [B]: 707 }), 'm2 the marks rose to 1788 and 707');
const goodPass = r.pass;

// m3 — 2026-11-20: the wallet comes back holding an older state
r = state(PK, { [A]: 1785, [B]: 699 }, true);
check(r.ok && r.pass === undefined && JSON.stringify(r.behind) === JSON.stringify([{ chan_point: A, stated: 1785, mark: 1788 }, { chan_point: B, stated: 699, mark: 707 }]), 'm3 the wallet states 1785 and 699 against its own marks 1788 and 707: BEHIND on both, and NO pass', r);
check(JSON.stringify(M.marksOf(PK)) === JSON.stringify({ [A]: 1788, [B]: 707 }), 'm3 nothing is lowered and nothing is raised by a statement that is behind');
check(logs.some((l) => /is BEHIND its own high mark on 2 channel\(s\)/.test(l) && /no pass/.test(l)), 'm3 the box writes it down');
r = state(PK, { [A]: 1790, [B]: 699 }, true);
check(r.ok && !r.pass && r.behind.length === 1 && r.behind[0].chan_point === B && M.marksOf(PK)[A] === 1788, 'm3 behind on ONE channel is behind: no pass, and the other channel\'s higher number is not taken from it', r);
r = state(PK, { [A]: 1788, [B]: 707 }, true);
check(r.ok && r.behind.length === 0 && !!r.pass, 'm3 the wallet catches up (1788 and 707 again): not behind, a pass');

// m4 — equal is not behind; a channel the wallet no longer states is not asked about; a new channel starts its mark
r = state(PK, { [A]: 1788 }, true);
check(r.ok && r.behind.length === 0 && !!r.pass && M.marksOf(PK)[B] === 707, 'm4 a channel left out of the statement (put away) is not asked about; its mark stays');
const C = 'cc'.repeat(32) + ':0';
r = state(PK, { [A]: 1788, [C]: 0 }, false);
check(r.ok && M.marksOf(PK)[C] === 0, 'm4 a new channel starts its mark at what is stated');
r = state(PK, {}, true);
check(r.ok && r.behind.length === 0 && !!r.pass, 'm4 a wallet with no channel record at all is not behind: a pass');

// m5 — another wallet's marks are its own
r = state(PK2, { [A]: 3 }, true);
check(r.ok && r.behind.length === 0 && M.marksOf(PK2)[A] === 3 && M.marksOf(PK)[A] === 1788 && M.count() === 2, 'm5 marks are kept per wallet key');

// m6 — the statement's time: near this box's clock, and each taken once
r = M.state(PK, { [A]: 1788 }, t - SKEW_MS - 1, true);
check(!r.ok && r.code === 'clock' && r.now_ms > t - 1, 'm6 a statement timed outside the allowed difference: refused with a time to sign instead', r);
t += 1000; const tUsed = t;
r = M.state(PK, { [A]: 1788 }, tUsed, false);
check(r.ok, 'm6 a statement at a new time is taken');
r = M.state(PK, { [A]: 1788 }, tUsed, true);
check(!r.ok && r.code === 'clock' && r.now_ms === tUsed + 1, 'm6 the same time again from this key: refused — a statement is taken once — and the time answered is above it', r);
r = M.state(PK, { [A]: 1788 }, r.now_ms, true);
check(r.ok && !!r.pass, 'm6 stated again with the answered time: taken');
r = M.state('zz', {}, t, true); check(!r.ok && r.code === 'bad_key', 'm6 a key that is not a node key: refused');
r = M.state(PK, { bad: 1 }, t + 5, true); check(!r.ok && r.code === 'bad_channels', 'm6 a statement of the wrong shape: refused');
r = M.state(PK, {}, 1.5, true); check(!r.ok && r.code === 'bad_time', 'm6 a time that is not a whole number: refused');

// m7 — the pass: good once, before it expires, and only one this box made
check(JSON.stringify(M.takePass(goodPass)) === JSON.stringify({ ok: true, pubkey: PK }), 'm7 a pass is good and names the wallet key it was made for');
check(M.takePass(goodPass).code === 'unknown', 'm7 the same pass a second time: not good');
check(M.takePass('ab'.repeat(32)).code === 'unknown' && M.takePass('nope').code === 'bad_pass' && M.takePass(undefined).code === 'bad_pass', 'm7 a pass this box never made, and one of the wrong shape');
r = state(PK, { [A]: 1788 }, true); const late = r.pass; t += PASS_TTL_MS + 1;
check(M.takePass(late).code === 'expired', 'm7 a pass presented after 90 s: expired');
check(PASS_FRAME === 'lijox-pass:', 'm7 the frame that carries it on the WebSocket');

// m8 — the marks outlive a restart of the adapter; the passes do not
const M2 = createStateMarks({ dataDir: dir, now: () => t });
r = state(PK, { [A]: 1788 }, true); const before = r.pass;
check(JSON.stringify(M2.marksOf(PK)) === JSON.stringify(M.marksOf(PK)) && M2.marksOf(PK)[A] === 1788, 'm8 a new start reads the same marks from the disk');
t += 1000; r = M2.state(PK, { [A]: 1785 }, t, true);
check(r.ok && r.behind.length === 1 && !r.pass, 'm8 after a restart a wallet that is behind is still behind');
check(M2.takePass(before).code === 'unknown', 'm8 a pass made before the restart is not known after it (the wallet asks again)');

// m9 — required or not is the operator's setting, said in the capability
check(M.required() === false && M.capability.required === false && M.capability.v === 1, 'm9 passes are not required unless set');
const M3 = createStateMarks({ dataDir: dir, required: true });
check(M3.required() === true && M3.capability.required === true, 'm9 required when set');

// m10 — the store is full: a NEW wallet is refused, a known one is still served
const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sm2-'));
const M4 = createStateMarks({ dataDir: d2, now: () => t, maxWallets: 1 });
t += 1000; r = M4.state(PK, { [A]: 1 }, t, true); check(r.ok, 'm10 the first wallet is kept');
t += 1000; r = M4.state(PK2, { [A]: 1 }, t, true); check(!r.ok && r.code === 'full', 'm10 the store is full: a new wallet is refused', r);
t += 1000; r = M4.state(PK, { [A]: 2 }, t, true); check(r.ok && M4.marksOf(PK)[A] === 2, 'm10 the wallet already kept still states and rises');

// m11 — a channel LND no longer holds open is left out: a reconnect cannot close it, so it does not refuse the pass
const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sm3-'));
const M5 = createStateMarks({ dataDir: d3, now: () => t });
t += 1000; M5.state(PK, { [A]: 1788, [B]: 707 }, t, false);
check(JSON.stringify(M5.behindOf(PK, { [A]: 1785, [B]: 707 })) === JSON.stringify([{ chan_point: A, stated: 1785, mark: 1788 }]) && M5.behindOf(PK, { [A]: 1788 }).length === 0, 'm11 a look at which channels are below the marks keeps nothing');
t += 1000; r = M5.state(PK, { [A]: 1785, [B]: 708 }, t, true, { ignore: [A] });
check(r.ok && r.behind.length === 0 && !!r.pass, 'm11 the channel that is closed at LND is left out of the comparison: not behind, a pass', r);
check(M5.marksOf(PK)[A] === 1788 && M5.marksOf(PK)[B] === 708, 'm11 its mark is not touched; the other channel rises as always');
t += 1000; r = M5.state(PK, { [A]: 1785, [B]: 700 }, t, true, { ignore: [A] });
check(r.ok && r.behind.length === 1 && r.behind[0].chan_point === B && !r.pass, 'm11 a channel that is NOT left out and is below its mark is still behind');

console.log(fails ? 'FAIL · state-marks · ' + fails + ' failed' : 'PASS · state-marks (m1–m11)');
process.exit(fails ? 1 : 0);
