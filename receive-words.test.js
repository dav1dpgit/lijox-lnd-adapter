// 0.127.4 — the address rail's refusal before an invoice is made (receive-words.js; the callback in lij-adapter.js).
//   node receive-words.test.js
const fs = require('fs');
const { refusal } = require('./receive-words');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0; const check = (c, m) => { if (!c) { fails++; console.log('FAIL · ' + m); } else console.log('  ok · ' + m); };
// DP's case: room 7,510 sats, 8,000 asked, the opening fee 20,000
let w = refusal({ ok: false, reason: 'under_open_fee', fee_msat: '20000000', receivable_msat: '7510000' }, {});
check(w === 'This wallet can receive up to 7,510 sats right now. More needs a new channel (fee 20,000 sats): send over 20,000, or 7,510 or less.', 'w1 over the room and under the opening fee: the room, the fee, and the two amounts that work — ' + w);
check(w.length <= 140, 'w1 within the 140 characters a payer\'s wallet shows (' + w.length + ')');
w = refusal({ ok: false, reason: 'under_open_fee', fee_msat: '100000', receivable_msat: '0' }, {});
check(w === 'A first channel to this wallet costs 100 sats here, taken from the payment: send more than 100 sats.', 'w2 no room at all: what the first channel costs');
w = refusal({ ok: false, reason: 'provider_reserve', fee_msat: '100000', receivable_msat: '7510000' }, {});
check(w === 'This wallet can receive up to 7,510 sats right now. Its provider cannot open a new channel at the moment.', 'w3 the provider\'s own reserve forbids an open');
w = refusal({ ok: true, mode: 'open', fee_msat: '100000', receivable_msat: '269029000' }, { blocked: true });
check(w === 'This wallet can receive up to 269,029 sats right now. Its provider is not opening a new channel for it at the moment.', 'w4 an open the JIT guard would refuse (11-11: a blocked wallet) is refused before the payer sends');
check(refusal({ ok: true, mode: 'open', fee_msat: '100000', receivable_msat: '0' }, { halted: true }) === 'This wallet cannot receive that amount right now. Its provider is not opening a new channel for it at the moment.', 'w4 the guard halted, no room');
check(refusal({ ok: true, mode: 'channel', fee_msat: '0', receivable_msat: '7510000' }, { halted: true, blocked: true }) === null, 'w5 it fits the room: an invoice is made, whatever the guard says');
check(refusal({ ok: true, mode: 'open', fee_msat: '100000', receivable_msat: '0', delivered_msat: '900000' }, {}) === null, 'w5 an open that will go ahead: an invoice is made');
check(refusal(null, {}) === null, 'w5 no answer about the room: nothing is refused (as before)');
check(refusal({ ok: false, reason: 'under_open_fee', fee_msat: '999999999999', receivable_msat: '999999999999999' }, {}).length <= 140, 'w6 never over 140 characters');
// the wiring
const iR = src.indexOf("const _rw = receiveWords.refusal(_rcv, { halted: jitGuard.halted(), blocked: jitGuard.walletBlocked(rec.client_pubkey) });");
const iE = src.indexOf("    // 0.67.0: never mint an expired hash (the wallet's engine would refuse");
check(iR > 0 && iE > iR, 's1 the callback asks before it picks a hash or makes an invoice');
check(src.includes("return jsonResponse(res, { status: 'ERROR', reason: _rw }, 400);"), 's2 the refusal goes out as the LNURL error the payer\'s wallet shows');
console.log(fails ? `\n${fails} FAILED` : '\nall receive-words checks pass'); process.exit(fails ? 1 : 0);
