// 0.127.4 (S68 Thu 2026-11-12 — DP's test: 8,000 sats to an address whose wallet could take 7,510; the provider's
// opening fee there is far above 8,000; the payer saw "the recipient's wallet declined it" eight seconds after sending):
// RECEIVABILITY FIRST ON THE ADDRESS RAIL. The callback asked nothing before minting: the payer's sats went out, were
// held, and came back with a refusal that named no cause. The one answer every rail shares (walletReceivable) is now
// read before the invoice is made, and a payment that cannot be delivered is refused there, in words the payer's
// wallet shows as written. This file is the words — no LND call, tested alone (receive-words.test.js).
//   refusal(rcv, guard) → null (mint the invoice) | a sentence of at most 140 characters (the payer's wallet cuts there)
//     rcv:   walletReceivable's answer { ok, mode, reason, fee_msat, receivable_msat }
//     guard: { halted, blocked } — the JIT guard's two states (an open would be refused at delivery)
'use strict';
const sats = (msat) => { try { return BigInt(msat || 0) / 1000n; } catch (_) { return 0n; } };
const n = (v) => v.toLocaleString('en-US');
function refusal(rcv, guard) {
  if (!rcv) return null;
  const g = guard || {};
  const room = sats(rcv.receivable_msat);
  const upTo = room > 0n ? `This wallet can receive up to ${n(room)} sats right now.` : 'This wallet cannot receive that amount right now.';
  if (rcv.ok === false && rcv.reason === 'under_open_fee') {
    const fee = (BigInt(rcv.fee_msat || 0) + 999n) / 1000n;
    return (room > 0n
      ? `${upTo} More needs a new channel (fee ${n(fee)} sats): send over ${n(fee)}, or ${n(room)} or less.`
      : `A first channel to this wallet costs ${n(fee)} sats here, taken from the payment: send more than ${n(fee)} sats.`).slice(0, 140);
  }
  if (rcv.ok === false && rcv.reason === 'provider_reserve') return `${upTo} Its provider cannot open a new channel at the moment.`.slice(0, 140);
  if (rcv.ok === true && rcv.mode === 'open' && (g.halted || g.blocked)) return `${upTo} Its provider is not opening a new channel for it at the moment.`.slice(0, 140);
  return null;
}
module.exports = { refusal };
