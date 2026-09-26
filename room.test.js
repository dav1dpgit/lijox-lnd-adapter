// 0.84.0 (S49) — THE ROOM: what LND will send on our side of a channel, as written in lij-adapter.js.
//   node room.test.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };
const m = src.match(/const ROOM_MARGIN_SATS = \d+;\nfunction channelRoomMsat\(c\) \{[\s\S]*?\n\}/);
check(!!m, 'channelRoomMsat is defined with its margin');
const room = new Function(m[0] + '; return channelRoomMsat;')();
// the 60,000-sat LSP-2 channel that refused a 1,000-sat push: local 3,200, reserve 600, commit fee 700 at 2,500 sat/kw
const c = { local_balance: '3200', local_chan_reserve_sat: '600', commit_fee: '700', fee_per_kw: '2500', initiator: true };
check(room(c) === 0n, 'a channel LND cannot send 1,000 sats on reads 0 room (local 3,200 − reserve 600 − 2×(700 + 430) − 1,000 < 0) — got ' + room(c));
const c2 = { local_balance: '20000', local_constraints: { chan_reserve_sat: '600' }, commit_fee: '700', fee_per_kw: '2500', initiator: true };
check(room(c2) === (20000n - 600n - 2n * (700n + 430n) - 1000n) * 1000n, 'reserve from local_constraints; initiator pays 2×(commit + one HTLC) and the margin — got ' + room(c2));
const c3 = { local_balance: '20000', local_chan_reserve_sat: '600', commit_fee: '700', fee_per_kw: '2500', initiator: false };
check(room(c3) === (20000n - 600n - 1000n) * 1000n, 'a channel the wallet opened: only the reserve and the margin come off');
check(room({ local_balance: '500' }) === 0n, 'never below zero');
check(room({ local_balance: '100000', commit_fee: '0', fee_per_kw: '0' }) === (100000n - 1000n) * 1000n, 'no reserve/fee fields → balance less the margin');
// the readers
check(/if \(!chan \|\| chan\.room_msat < amt\)/.test(src), 'deliverToWallet decides JIT on room_msat');
check(/const room = chan \? chan\.room_msat : 0n;/.test(src), 'walletReceivable answers with room_msat');
check(/chan && chan\.room_msat > 1000n/.test(src), 'lnurlpMinMsat reads room_msat');
check(!/chan\.local_msat < amt \+ 50000n/.test(src) && !/chan\.local_msat >= amt \+ 50000n/.test(src), 'no reader adds 50 sats to local_balance any more');
const dsrc = fs.readFileSync(require('path').join(__dirname, 'delegate.js'), 'utf8');
check(/chan\.room_msat !== undefined \? chan\.room_msat : chan\.local_msat - 50000n/.test(dsrc), 'the delegate rail\'s same-LSP check reads room_msat');
console.log(fails ? `GATE FAIL · ${fails}` : 'GATE PASS: the room — reserve, commit fee ×2 with one more HTLC, the margin; every reader on room_msat');
process.exit(fails ? 1 : 0);
