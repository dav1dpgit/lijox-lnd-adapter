// sent-watch.test.js — 0.133.0 (S70): a payment a wallet sent, resolved here while the wallet is offline — the sorting
// (in flight / completed / returned / undecided), the wakes tied to the deadline, and the Console's line.
const { createSentWatch, classify, dueMark, marksAfter, statedMs, circuitKey, idsOf } = require('./sent-watch');
const fs = require('fs'); const os = require('os'); const path = require('path');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), m + (JSON.stringify(a) === JSON.stringify(b) ? '' : ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)));
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const H = (n) => String(n).repeat(64).slice(0, 64);
const W1 = '02' + 'a1'.repeat(32), W2 = '02' + 'b2'.repeat(32), EXT = '03' + 'c3'.repeat(32);

(async () => {
  // ── m: the marks ──
  eq([dueMark(500, {}), dueMark(500, { now: true }), dueMark(144, { now: true }), dueMark(144, { now: true, d1: true }), dueMark(36, { now: true, d1: true }), dueMark(6, { now: true, d1: true, h6: true }), dueMark(6, { now: true, d1: true, h6: true, h1: true })],
     ['now', null, 'd1', null, 'h6', 'h1', null], 'm1 at once; then at 144, 36 and 6 blocks left; each once');
  eq([dueMark(0, {}), dueMark(-5, {}), dueMark(1, {})], [null, null, 'h1'], 'm2 nothing once the deadline has passed; one block left is still the last mark');
  eq([dueMark(30, {}), marksAfter({}, 'h6'), dueMark(30, marksAfter({}, 'h6')), dueMark(6, marksAfter({}, 'h6'))],
     ['h6', { now: true, d1: true, h6: true, h1: false }, null, 'h1'], 'm3 first seen with 30 blocks left: the six-hour wake is the first one, "at once" and "a day" are done with it; the last mark still comes');
  eq([marksAfter({}, 'now'), marksAfter({ now: true }, 'd1'), marksAfter({}, 'h1')], [{ now: true, d1: false, h6: false, h1: false }, { now: true, d1: true, h6: false, h1: false }, { now: true, d1: true, h6: true, h1: true }], 'm4 a mark closes itself and every mark further out');
  eq([statedMs(200) / 600000, statedMs(100) / 600000, statedMs(6) / 600000, statedMs(3), statedMs(1)], [177, 87, 2, 60000, 60000], 'm5 the stated time keeps a tenth and three blocks back; never under a minute');

  // ── c: the sorting ──
  const chanW = { chan_id: '111', remote_pubkey: W1, active: false, private: true, channel_point: 'aa:0' };
  const outCh = (hs) => ({ chan_id: '222', remote_pubkey: EXT, active: true, pending_htlcs: hs });
  const ev0 = (o) => Object.assign({ open: () => false, res: () => null, chansById: {}, invoice: async () => null, fwdSettled: async () => false }, o || {});
  const h0 = (o) => Object.assign({ incoming: true, amount: '1000', hash_lock: b64(H('ab')), expiration_height: 1000, htlc_index: '7', forwarding_channel: '0', forwarding_htlc_index: '0', locked_in: true }, o || {});
  eq((await classify(chanW, h0({ locked_in: false }), ev0({ res: () => 'S' }))).cls, 'flight', 'c1 not yet locked in: in flight, whatever else is known');
  eq((await classify(chanW, h0(), ev0({ open: (k) => k === '111:7', res: () => 'F' }))).cls, 'flight', 'c2 held unanswered by the interceptor: in flight (asked by its own circuit key)');
  eq([(await classify(chanW, h0(), ev0({ res: () => 'S' }))).cls, (await classify(chanW, h0(), ev0({ res: () => 'F' }))).cls], ['completed', 'returned'], 'c3 this adapter\'s own answer: SETTLE → completed, FAIL → returned');
  const fw = h0({ forwarding_channel: '222', forwarding_htlc_index: '9' });
  eq((await classify(chanW, fw, ev0({ chansById: { 222: outCh([{ incoming: false, htlc_index: '9' }]) } }))).cls, 'flight', 'c4 forwarded, the outgoing half still on its channel: in flight');
  eq((await classify(chanW, fw, ev0({ chansById: { 222: outCh([{ incoming: true, htlc_index: '9' }, { incoming: false, htlc_index: '8' }]) }, fwdSettled: async () => true }))).cls, 'completed', 'c5 forwarded, the outgoing half gone (another HTLC with the number, incoming, does not count), LND recorded the settle: completed');
  let asked = null;
  eq([(await classify(chanW, fw, ev0({ chansById: { 222: outCh([]) }, fwdSettled: async (...a) => { asked = a; return false; } }))).cls, asked], ['returned', [['111'], '7', ['222'], '9']], 'c6 forwarded, gone, no settle recorded, the outgoing channel open: returned (asked by both channels\' HTLC numbers)');
  eq([(await classify(chanW, fw, ev0({ chansById: {}, fwdSettled: async () => false }))).cls, (await classify(chanW, fw, ev0({ chansById: {}, fwdSettled: async () => true }))).cls, (await classify(chanW, fw, ev0({ chansById: { 222: outCh([]) }, fwdSettled: async () => null }))).cls],
     ['undecided', 'completed', 'undecided'], 'c7 the outgoing channel no longer open: undecided unless the settle is recorded; the history unreadable: undecided');
  const inv = (state, htlcs) => ({ invoice: async () => ({ state, htlcs: htlcs || [] }) });
  eq([(await classify(chanW, h0(), ev0(inv('SETTLED', [{ chan_id: '111', htlc_index: '7', state: 'SETTLED' }])))).cls, (await classify(chanW, h0(), ev0(inv('SETTLED', [{ chan_id: '111', htlc_index: '6', state: 'SETTLED' }, { chan_id: '111', htlc_index: '7', state: 'CANCELED' }])))).cls,
      (await classify(chanW, h0(), ev0(inv('ACCEPTED', [{ chan_id: '111', htlc_index: '7', state: 'ACCEPTED' }])))).cls, (await classify(chanW, h0(), ev0(inv('SETTLED', [{ chan_id: '999', htlc_index: '7', state: 'SETTLED' }])))).cls],
     ['completed', 'returned', 'flight', 'undecided'], 'c8 this node\'s invoice, read on its record of THIS HTLC: taken → completed; a second payment to a settled invoice → returned; held → in flight; settled by another HTLC and ours not listed → undecided');
  eq([(await classify(chanW, h0(), ev0(inv('CANCELED', [])))).cls, (await classify(chanW, h0(), ev0(inv('OPEN', [])))).cls], ['returned', 'undecided'], 'c9 the HTLC not on the record: a CANCELED invoice → returned; an OPEN one → undecided');
  eq([(await classify(chanW, h0(), ev0())).cls, (await classify(chanW, h0(), ev0({ invoice: async () => undefined }))).cls], ['undecided', 'undecided'], 'c10 not held, not forwarded, no invoice — or the invoice unreadable: undecided, nothing sent');
  eq(circuitKey('111', '7'), '111:7', 'c11 the circuit key');
  const chanZ = { chan_id: '17592186044416000001', zero_conf_confirmed_scid: '900000000000000001', alias_scids: ['17592186044416000001', '17592186044416000009'], remote_pubkey: W1, active: false };
  eq([idsOf(chanZ), idsOf({ chan_id: '5', zero_conf_confirmed_scid: '0', alias_scids: [] }), idsOf({})], [['17592186044416000001', '900000000000000001', '17592186044416000009'], ['5'], ['0']], 'c12 every number LND gives for a channel: chan_id, the confirmed number of a zero-conf channel, its aliases');
  eq([(await classify(chanZ, h0(), ev0({ res: (k) => k === '900000000000000001:7' ? 'S' : null }))).cls, (await classify(chanZ, h0(), ev0({ open: (k) => k === '17592186044416000009:7', res: () => 'F' }))).cls,
      (await classify(chanZ, h0(), ev0(inv('SETTLED', [{ chan_id: '900000000000000001', htlc_index: '7', state: 'SETTLED' }])))).cls],
     ['completed', 'flight', 'completed'], "c13 a zero-conf channel: the adapter's answer, the interceptor's hold and the invoice's record are found under any of the channel's numbers");
  let askedZ = null; await classify(chanZ, fw, ev0({ chansById: { 222: outCh([]) }, fwdSettled: async (...a) => { askedZ = a; return false; } }));
  eq(askedZ, [['17592186044416000001', '900000000000000001', '17592186044416000009'], '7', ['222'], '9'], 'c13 … and the forwarding history is asked under all of them');
  eq([(await classify(chanW, fw, ev0({ open: () => true, res: () => 'S', chansById: { 222: outCh([]) }, fwdSettled: async () => false }))).cls, (await classify(chanW, fw, ev0({ open: () => true, res: () => 'F', chansById: { 222: outCh([]) }, fwdSettled: async () => true }))).cls],
     ['returned', 'completed'], "c14 an HTLC LND has forwarded is read from LND's own record — not from what this adapter remembers of it (a hold or an answer that never reached LND)");

  // ── s: the sweep ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentwatch-'));
  let t = 1_700_000_000_000; const now = () => t;
  let height = 900; let channels = []; const invoices = {}; let fwdEvents = []; let fwdCalls = 0;
  let lndVersion = '0.20.1-beta commit=v0.20.1-beta';   // the cases below were written on LND 0.20's margin of 10 blocks; s25 runs LND 0.21's 16
  const lndGet = async (p) => {
    if (p === '/v1/channels') return { channels };
    if (p === '/v1/getinfo') return { block_height: height, version: lndVersion };
    if (p.startsWith('/v1/invoice/')) { const h = p.slice(12); return invoices[h] || { code: 5, message: 'unable to locate invoice', details: [] }; }
    throw new Error('unexpected GET ' + p);
  };
  const lndPost = async (p) => { if (p === '/v1/switch') { fwdCalls++; return { forwarding_events: fwdEvents, last_offset_index: fwdEvents.length }; } throw new Error('unexpected POST ' + p); };
  const wakes = []; const logs = []; const open = new Set(); const subs = new Set([W1, W2]); const pushLocks = new Set(); let sendAnswer = true;
  const mk = (extra) => createSentWatch(Object.assign({ dataDir: dir, lndGet, lndPost, log: (m) => logs.push(m), now, isWalletPeer: (pk) => pk === W1 || pk === W2, interceptOpen: (k) => open.has(k),
    sendWakePush: async (pk, holdMs, kind, x, ttlS) => { wakes.push({ pk, holdMs, kind, ttlS }); return sendAnswer; }, hasPushSub: (pk) => subs.has(pk), isPushLock: (h) => pushLocks.has(h), upSince: t }, extra || {}));
  let sw = mk();
  const hA = H('a1'), hB = H('b2'), hC = H('c3'), hD = H('d4');
  // wallet 1, offline: one HTLC this adapter settled (expiry 1100), one it failed (expiry 1200)
  channels = [
    { chan_id: '111', remote_pubkey: W1, active: false, private: true, channel_point: 'aa:0', pending_htlcs: [
      { incoming: true, amount: '5000', hash_lock: b64(hA), expiration_height: 1100, htlc_index: '1', forwarding_channel: '0', forwarding_htlc_index: '0', locked_in: true },
      { incoming: true, amount: '700', hash_lock: b64(hB), expiration_height: 1200, htlc_index: '2', forwarding_channel: '0', forwarding_htlc_index: '0', locked_in: true }] },
    { chan_id: '222', remote_pubkey: EXT, active: true, private: false, channel_point: 'bb:1', pending_htlcs: [
      { incoming: false, amount: '9000', hash_lock: b64(hC), expiration_height: 950, htlc_index: '4', forwarding_channel: '0', forwarding_htlc_index: '0', locked_in: true },
      { incoming: false, amount: '100', hash_lock: b64(hD), expiration_height: 1500, htlc_index: '5', forwarding_channel: '0', forwarding_htlc_index: '0', locked_in: true }] },
  ];
  sw.noteResolution({ chan_id: '111', htlc_id: '1' }, 'SETTLE'); sw.noteResolution({ chan_id: '111', htlc_id: '2' }, 'FAIL');
  sw.noteResolution({ chan_id: '333', htlc_id: '3' }, 'FAIL'); sw.noteResolution({ chan_id: '333', htlc_id: '3' }, 'RESUME'); sw.noteResolution(null, 'SETTLE'); sw.noteResolution({ chan_id: '1', htlc_id: '1' }, undefined);
  eq([Object.keys(sw._state().res).sort(), sw._state().res['111:1'].a, sw._state().res['111:2'].a], [['0:0', '111:1', '111:2'], 'S', 'F'], 's1 the adapter\'s answers are remembered: SETTLE and FAIL kept, a RESUME clears, a call with no key never throws');
  eq(await sw.sweep(), { skipped: 'boot' }, 's2 the first minutes after a start: no sweep');
  t += 200000;
  let r = await sw.sweep();
  eq([r.ok, r.items, wakes.length, sw.report().items.map((i) => [i.cls, i.confirmed]).sort()], [true, 2, 0, [['completed', false], ['returned', false]]], 's3 the first sweep sorts both and sends nothing — one sweep is not enough');
  t += 120000; await sw.sweep();
  eq(wakes.map((w) => [w.pk, w.kind, w.holdMs, w.ttlS]), [[W1, 'sent_completed', statedMs(1100 - 10 - 900), Math.floor(statedMs(190) / 1000)]],
     's4 the second sweep agrees: ONE wake for the wallet, by its lead payment — the completed one, with the time to open by (short of the estimate), kept at the push service that long; the returned one sends none of its own');
  eq(sw.report().items.map((i) => [i.cls, i.deadline, i.left, i.wakes, i.lead]).sort(), [['completed', 1090, 190, 1, true], ['returned', 1203, 303, 0, false]], 's4 the deadlines: expiry − 10 for completed, expiry + 3 for returned; the completed one leads');
  t += 120000; await sw.sweep(); t += 120000; await sw.sweep();
  eq(wakes.length, 1, 's5 later sweeps at the same height send nothing more');
  height = 1090 - 144; t += 120000; await sw.sweep();
  eq(wakes.slice(1).map((w) => [w.kind, w.holdMs]), [['sent_completed', statedMs(144)]], 's6 144 blocks before the deadline: the "about a day" wake');
  height = 1090 - 36; t += 120000; await sw.sweep();
  height = 1090 - 6; t += 120000; await sw.sweep();
  eq(wakes.slice(2).map((w) => [w.kind, w.holdMs]), [['sent_completed', statedMs(36)], ['sent_completed', statedMs(6)]], 's7 36 blocks left: the six-hour wake; 6 blocks left: the last-hour wake');
  height = 1090; t += 120000; await sw.sweep(); height = 1095; t += 120000; await sw.sweep();
  eq([wakes.filter((w) => w.kind === 'sent_completed').length, wakes.filter((w) => w.kind === 'sent_returned').length], [4, 0], 's8 at and past the deadline nothing more is sent (4 in all: at once, a day, six hours, one hour); none for the returned one while a completed one leads');

  // the Console's line
  height = 1000; t += 120000; await sw.sweep();
  let near = sw.report().near;
  eq(near.map((n) => [n.dir, n.cls || '', n.hash.slice(0, 2), n.block, n.left]), [['out', '', 'c3', 950, -50], ['in', 'completed', 'a1', 1090, 90]], 's9 the Console\'s line at block 1000: the outgoing HTLC past its expiry and the completed one 90 blocks from LND\'s block — nearest first; the outgoing one at 1500 and the returned one at 1203 are further than 100');
  height = 1150; t += 120000; await sw.sweep(); near = sw.report().near;
  eq(near.filter((n) => n.dir === 'in').map((n) => [n.cls, n.block, n.left, n.wakes]), [['completed', 1090, -60, 4], ['returned', 1203, 53, 0]], 's10 at 1150: both incoming ones listed with what was sent');
  eq(typeof near[0].what === 'string' && /LND closes this channel on-chain/.test(near.find((n) => n.cls === 'completed').what) && /before v376/.test(near.find((n) => n.cls === 'returned').what), true, 's10 each row says in words what happens at its block');
  eq([near.find((n) => n.cls === 'completed').why, near.find((n) => n.cls === 'returned').confirmed, sw.report().items.map((i) => /this channel|closes its channel/.test(i.what)).every(Boolean)], ['this adapter settled it', true, true], 's10 … how it was sorted rides in its own field, and each sent payment in the report carries what happens at its block (the Console lists the far ones in the same table)');

  height = 1000; t += 120000; await sw.sweep();
  eq(sw.report().htlcs.map((n) => [n.dir, n.cls || '', n.hash.slice(0, 2), n.block, n.left, n.near]), [['out', '', 'c3', 950, -50, true], ['in', 'completed', 'a1', 1090, 90, true], ['in', 'returned', 'b2', 1203, 203, false], ['out', '', 'd4', 1500, 500, false]],
     's10b 0.133.3: the report lists EVERY pending HTLC — the two within 100 blocks marked near, the returned one at 203 and the outgoing one at 500 listed after them');
  eq(sw.report().near.length, 2, 's10b the warning still counts only the near ones');
  height = 1150; t += 120000; await sw.sweep();

  // the wallet comes back, or the HTLC is answered: the item goes
  channels[0].active = true; t += 120000; await sw.sweep();
  eq([sw.report().items.length, Object.keys(sw._state().items).length], [0, 0], 's11 the wallet is connected again: nothing is watched for it');
  channels[0].active = false; channels[0].pending_htlcs = [channels[0].pending_htlcs[1]]; height = 1000; t += 120000; await sw.sweep();
  eq(sw.report().items.map((i) => [i.cls, i.confirmed, i.wakes]), [['returned', false, 0]], 's12 offline again with one HTLC left: sorted afresh (its count of sweeps starts again)');

  // a restart keeps what was sent and what was answered
  sw.flush(); const before = wakes.length;
  t += 120000; await sw.sweep();   // second agreeing sweep → the 'now' wake for the fresh item
  eq(wakes.length - before, 1, 's13 the fresh item\'s wake after its second sweep');
  sw.flush(); sw = mk({ upSince: t }); t += 200000; await sw.sweep(); t += 120000; await sw.sweep();
  eq([wakes.length - before, sw._state().res['111:2'].a, sw.report().items[0].wakes], [1, 'F', 1], 's14 after a restart: the answers given to LND and the wakes already sent are read from the state file — nothing is sent twice');

  // undecided, in flight, no subscription, the Push rail's own wake, a wake that did not go out
  const hE = H('e5'), hF = H('f6'), hG = H('07');
  channels.push({ chan_id: '444', remote_pubkey: W2, active: false, private: true, channel_point: 'cc:0', pending_htlcs: [
    { incoming: true, amount: '1', hash_lock: b64(hE), expiration_height: 2000, htlc_index: '1', forwarding_channel: '0', forwarding_htlc_index: '0', locked_in: true },      // no evidence at all → undecided
    { incoming: true, amount: '2', hash_lock: b64(hF), expiration_height: 2000, htlc_index: '2', forwarding_channel: '0', forwarding_htlc_index: '0', locked_in: true },      // held by the interceptor
    { incoming: true, amount: '3', hash_lock: b64(hG), expiration_height: 2000, htlc_index: '3', forwarding_channel: '222', forwarding_htlc_index: '77', locked_in: true }] }); // forwarded, gone
  open.add('444:2'); fwdEvents = [{ chan_id_in: '444', chan_id_out: '222', incoming_htlc_id: '3', outgoing_htlc_id: '77', amt_in_msat: '3000' }];
  const w0 = wakes.length; t += 120000; await sw.sweep(); t += 120000; await sw.sweep();
  eq([sw.report().items.filter((i) => i.peer === W2).map((i) => [i.hash.slice(0, 2), i.cls]), wakes.slice(w0).map((w) => [w.pk === W2, w.kind]), sw.report().fwd_ids], [[['07', 'completed']], [[true, 'sent_completed']], true],
     's15 wallet 2: the HTLC with no evidence and the held one get nothing; the forwarded one whose settle LND recorded (by its HTLC number) is completed and woken');
  fwdEvents = [{ chan_id_in: '444', chan_id_out: '222', amt_in_msat: '3000' }]; const sw2 = mk({ dataDir: null, upSince: t - 999999 }); await sw2.sweep(); await sw2.sweep();
  eq(sw2.report().items.filter((i) => i.peer === W2).length, 0, 's16 an LND whose records carry no HTLC numbers: the same forward is undecided — an amount alone is not evidence');
  fwdEvents = []; const sw3 = mk({ dataDir: null, upSince: t - 999999 }); await sw3.sweep(); await sw3.sweep();
  eq(sw3.report().items.filter((i) => i.peer === W2).map((i) => i.cls), ['returned'], 's17 no settled forward recorded at all, the outgoing channel open: returned');
  subs.delete(W2); const sw4 = mk({ dataDir: null, upSince: t - 999999 }); const w1 = wakes.length; const l1 = logs.length; await sw4.sweep(); await sw4.sweep(); await sw4.sweep();
  eq([wakes.slice(w1).filter((w) => w.pk === W2).length, logs.slice(l1).filter((l) => /no push subscription/.test(l)).length, sw4.report().items.find((i) => i.peer === W2).nosub], [0, 1, true], 's18 a wallet with no push subscription: nothing sent, said once in the log, shown on the Console');
  subs.add(W2); pushLocks.add(hG); const sw5 = mk({ dataDir: null, upSince: t - 999999 }); const w2 = wakes.length; await sw5.sweep(); await sw5.sweep(); await sw5.sweep();
  eq([wakes.slice(w2).filter((w) => w.pk === W2).length, sw5._state().items['444:3'].marks.now], [0, true], 's19 a Push Key lock: the first wake is the Push rail\'s own — none from here, the mark closed');
  pushLocks.delete(hG); sendAnswer = undefined; const sw6 = mk({ dataDir: null, upSince: t - 999999 }); const w3 = wakes.length; await sw6.sweep(); await sw6.sweep(); await sw6.sweep();
  eq([wakes.slice(w3).filter((w) => w.pk === W2).length, sw6._state().items['444:3'].marks.now, sw6.report().items.find((i) => i.peer === W2).wakes], [2, false, 0], 's20 a wake that did not go out (throttled, the wallet seen live) is tried again at the next sweep; it is not counted as sent');
  sendAnswer = true;

  // the lead: a returned payment leads until a completed one appears; of two completed ones the lower deadline block leads
  {
    let hh = 5000; const chs = [{ chan_id: '777', remote_pubkey: W1, active: false, private: true, channel_point: 'dd:0', pending_htlcs: [
      { incoming: true, amount: '10', hash_lock: b64(H('11')), expiration_height: 6000, htlc_index: '1', forwarding_channel: '0', locked_in: true }] }];
    const wk = []; const swL = createSentWatch({ lndGet: async (p) => p === '/v1/channels' ? { channels: chs } : (p === '/v1/getinfo' ? { block_height: hh, version: '0.20.1-beta commit=v0.20.1-beta' } : { code: 5, message: 'unable to locate invoice' }), lndPost, now, upSince: t - 999999,
      isWalletPeer: () => true, hasPushSub: () => true, sendWakePush: async (pk, ms, kind) => { wk.push([kind, ms]); return true; } });
    swL.noteResolution({ chan_id: '777', htlc_id: '1' }, 'FAIL'); await swL.sweep(); await swL.sweep();
    chs[0].pending_htlcs.push({ incoming: true, amount: '20', hash_lock: b64(H('22')), expiration_height: 5900, htlc_index: '2', forwarding_channel: '0', locked_in: true },
                              { incoming: true, amount: '30', hash_lock: b64(H('33')), expiration_height: 5800, htlc_index: '3', forwarding_channel: '0', locked_in: true });
    swL.noteResolution({ chan_id: '777', htlc_id: '2' }, 'SETTLE'); swL.noteResolution({ chan_id: '777', htlc_id: '3' }, 'SETTLE'); await swL.sweep(); await swL.sweep(); await swL.sweep();
    eq([wk, swL.report().items.filter((i) => i.lead).map((i) => [i.hash.slice(0, 2), i.deadline])], [[['sent_returned', undefined], ['sent_completed', statedMs(5790 - 5000)]], [['33', 5790]]],
       's23 a returned payment leads and is woken for; when completed ones appear the one with the lowest deadline block leads and gets its own wake at once — one notification per change, not one per payment');
  }

  // C lists every incoming HTLC that is near, whatever its channel and its sorting; a far one is not even read
  {
    const invAsked = []; const chs = [
      { chan_id: '801', remote_pubkey: W1, active: false, private: true, channel_point: 'a8:0', pending_htlcs: [
        { incoming: true, amount: '421', hash_lock: b64(H('51')), expiration_height: 4000, htlc_index: '1', forwarding_channel: '0', locked_in: true },      // no evidence, far past its block
        { incoming: true, amount: '60', hash_lock: b64(H('52')), expiration_height: 9000, htlc_index: '2', forwarding_channel: '0', locked_in: true }] },     // no evidence, far away
      { chan_id: '802', remote_pubkey: EXT, active: true, private: false, channel_point: 'b8:0', pending_htlcs: [
        { incoming: true, amount: '70', hash_lock: b64(H('53')), expiration_height: 5090, htlc_index: '5', forwarding_channel: '0', locked_in: true },        // held by the interceptor, 80 blocks from expiry − 10
        { incoming: true, amount: '80', hash_lock: b64(H('54')), expiration_height: 9000, htlc_index: '6', forwarding_channel: '0', locked_in: true }] }];    // far away, a connected peer: not read at all
    const wk = []; const swC = createSentWatch({ lndGet: async (p) => { if (p === '/v1/channels') return { channels: chs }; if (p === '/v1/getinfo') return { block_height: 5000, version: '0.20.1-beta commit=v0.20.1-beta' }; invAsked.push(p.slice(12, 14)); return { code: 2, message: 'unable to locate invoice' }; }, lndPost, now, upSince: t - 999999,
      isWalletPeer: (pk) => pk === W1, interceptOpen: (k) => k === '802:5', sendWakePush: async () => { wk.push(1); return true; } });
    await swC.sweep(); await swC.sweep();
    const nr = swC.report().near;
    eq([nr.map((n) => [n.cls, n.hash.slice(0, 2), n.block, n.left, n.active, n.wallet, n.wakes]), wk.length, swC.report().items.length],
       [[['undecided', '51', 3990, -1010, false, true, undefined], ['flight', '53', 5080, 80, true, false, undefined]], 0, 0],
       's24 within 100 blocks: an undecided HTLC far past its block on an offline wallet\'s channel and a held one near its block on a connected peer\'s channel — at expiry − 10, with their sorting; no wake for either');
    eq([swC.report().htlcs.map((n) => [n.cls, n.hash.slice(0, 2), n.block, n.left, n.near, n.active]), [...new Set(invAsked)].sort()],
       [[['undecided', '51', 3990, -1010, true, false], ['flight', '53', 5080, 80, true, true], ['undecided', '52', 8990, 3990, false, false], ['undecided', '54', 8990, 3990, false, true]], ['51', '52', '54']],
       's24 0.133.3: EVERY pending HTLC is in the report, nearest first — the two far ones too, each sorted (the held one needs no invoice read), marked not near');
    eq([/^not sorted — if this box settled it/.test(nr[0].what), /^not held, not forwarded, no invoice/.test(nr[0].why), /^still in flight — /.test(nr[1].what), nr[1].why], [true, true, true, 'held by this adapter, unanswered'], 's24 … each says what happens at its block, and — in its own field — how it was sorted');
  }

  // 0.133.4: LND's margin by its version — on LND 0.21 it goes on-chain 16 blocks below the expiry, not 10
  {
    let hh = 900; let ver = '0.21.8-beta commit=v0.21.8-beta-terminus'; const lg = [];
    const chs = [{ chan_id: '901', remote_pubkey: W1, active: false, private: true, channel_point: 'c9:0', pending_htlcs: [
      { incoming: true, amount: '5000', hash_lock: b64(H('71')), expiration_height: 1100, htlc_index: '1', forwarding_channel: '0', locked_in: true },
      { incoming: true, amount: '6', hash_lock: b64(H('72')), expiration_height: 1000, htlc_index: '2', forwarding_channel: '0', locked_in: true }] }];
    const wk = []; const mkM = (extra) => createSentWatch(Object.assign({ lndGet: async (p) => p === '/v1/channels' ? { channels: chs } : (p === '/v1/getinfo' ? { block_height: hh, version: ver } : { code: 2, message: 'unable to locate invoice' }), lndPost, now, upSince: t - 999999, log: (m) => lg.push(m),
      isWalletPeer: () => true, hasPushSub: () => true, sendWakePush: async (pk, ms, kind) => { wk.push([kind, ms, hh]); return true; } }, extra || {}));
    const swM = mkM(); swM.noteResolution({ chan_id: '901', htlc_id: '1' }, 'SETTLE');
    eq([swM.report().incoming_delta, swM.report().incoming_delta_source], [16, 'unknown'], 's25 before LND has been read the larger figure stands');
    await swM.sweep(); await swM.sweep();
    const r1 = swM.report();
    eq([r1.incoming_delta, r1.incoming_delta_source, r1.lnd_version, r1.items.map((i) => [i.cls, i.deadline, i.left]), r1.htlcs.map((n) => [n.cls, n.block, n.left, n.near])],
       [16, 'version', '0.21.8-beta', [['completed', 1084, 184]], [['undecided', 984, 84, true], ['completed', 1084, 184, false]]],
       's25 LND 0.21.8: a completed payment\'s deadline is expiry − 16 (1084, not 1090), and every incoming HTLC\'s on-chain block is counted 16 below its expiry');
    eq(wk, [['sent_completed', statedMs(184), 900]], 's25 … the first wake states its time counted to that block');
    eq(lg.filter((l) => /LND goes on-chain 16 blocks below the expiry/.test(l)).map((l) => /\(LND 0\.21\.8-beta\)/.test(l)), [true], 's25 … and the journal says the figure and where it came from, once');
    hh = 1084 - 144; await swM.sweep(); hh = 1084 - 36; await swM.sweep(); hh = 1084 - 6; await swM.sweep();
    eq(wk.slice(1), [['sent_completed', statedMs(144), 940], ['sent_completed', statedMs(36), 1048], ['sent_completed', statedMs(6), 1078]], 's26 the day, six-hour and one-hour wakes leave 144, 36 and 6 blocks before LND\'s real block');
    eq([1084 - wk[wk.length - 1][2], wk[wk.length - 1][1] / 600000 < 1084 - wk[wk.length - 1][2]], [6, true], 's26 the last wake leaves with 6 blocks still to go, and the time it states (2 blocks) is before LND\'s block — on the fixed 10 it left AT LND\'s block');
    hh = 1084; await swM.sweep(); hh = 1089; await swM.sweep();
    eq(wk.length, 4, 's26 at and past expiry − 16 nothing more is sent (the fixed 10 would have sent until 1090)');
    // the stated time is never later than LND's block, at any distance
    eq(Array.from({ length: 300 }, (_, i) => i + 1).filter((left) => statedMs(left) / 600000 > left && left > 1).length, 0, 's27 counted to the right block, the stated time is at or before LND\'s block at every distance from 2 to 300 blocks (one block left: the one-minute floor)');
    // the operator's setting; an LND below 0.21; a version that cannot be read
    const swS = mkM({ incomingDeltaSetting: '12' }); hh = 900; await swS.sweep();
    ver = '0.20.1-beta commit=v0.20.1-beta'; const swO = mkM(); await swO.sweep();
    ver = ''; const swU = mkM(); await swU.sweep();
    eq([[swS.report().incoming_delta, swS.report().incoming_delta_source, swS.report().htlcs[0].block], [swO.report().incoming_delta, swO.report().incoming_delta_source, swO.report().htlcs[0].block], [swU.report().incoming_delta, swU.report().incoming_delta_source, swU.report().htlcs[0].block]],
       [[12, 'setting', 988], [10, 'version', 990], [16, 'unknown', 984]], 's28 the setting wins (12); LND 0.20.1 keeps 10; a version that cannot be read takes the larger figure, 16');
    // LND is replaced under a running adapter: the figure follows at the next sweep, and the journal says so again
    ver = '0.21.8-beta'; const n0 = lg.length; await swO.sweep();
    eq([swO.report().incoming_delta, lg.slice(n0).filter((l) => /LND goes on-chain 16 blocks/.test(l)).length], [16, 1], 's29 LND replaced by 0.21 under a running adapter: the figure follows at the next read, said once in the journal');
  }

  // LND unreadable: no verdicts, no wakes, the error on the report
  const sw7 = createSentWatch({ lndGet: async () => { throw new Error('LND down'); }, lndPost, now, upSince: t - 999999 });
  eq([await sw7.sweep(), sw7.report().last_error], [{ error: 'LND down' }, 'LND down'], 's21 LND unreadable: the sweep says so and does nothing');
  const sw8 = createSentWatch({ lndGet: async (p) => p === '/v1/channels' ? { channels: [{ chan_id: '111', remote_pubkey: W1, active: false, pending_htlcs: [{ incoming: true, amount: '5', hash_lock: b64(hA), expiration_height: 5000, htlc_index: '1', forwarding_channel: '0', locked_in: true }] }] } : (p === '/v1/getinfo' ? { block_height: 100, version: '0.20.1-beta' } : { code: 2, message: 'server is still in the process of starting' }), lndPost, now, upSince: t - 999999, sendWakePush: async () => { wakes.push('never'); return true; } });
  await sw8.sweep(); await sw8.sweep();
  eq([sw8.report().items.length, wakes.includes('never')], [0, false], 's22 an invoice answer that is neither an invoice nor "not found" (LND starting): undecided, nothing sent');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fails ? `\nFAILED: ${fails}` : '\nsent-watch: all checks passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('the test threw:', e); process.exit(1); });
