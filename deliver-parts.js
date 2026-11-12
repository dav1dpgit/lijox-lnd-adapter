// 0.127.0 (S68 Wed 2026-11-11, DP 21:12 "Go and go" — his field find: a wallet with two channels and over
// 500,000 sats of room in total could not be paid 420,000 sats to its Lightning address by a wallet on the same
// provider): A DELIVERY IN PARTS. deliverToWallet sent ONE HTLC over the ONE channel with the most room; an amount
// above that room went to a new channel open, whatever the wallet's other channels held. The wallet's engine has
// always accepted one payment arriving in parts over several channels (its invoices list every usable channel).
// This file is the plan and the reading of the result — no LND call, so it is tested alone (deliver-parts.test.js).
//
//   plan(chans, amountMsat, opts) → null | [{ chan, msat }]
//     chans: the wallet's channels as lnurlpClientChannels lists them ({ scid, room_msat: BigInt, active, … }).
//     The parts fill the channels with the most room first; they sum to the amount exactly. null when the channels
//     together do not have the room, when it would take more than opts.maxParts channels, or when a part cannot be
//     kept at or above opts.minPartMsat.
//   combine(results) → { kind: 'attempt', attempt } | { kind: 'rejected', error }
//     results: Promise.allSettled's array over the parts' SendToRouteV2 calls. One preimage on any part = the wallet
//     claimed (it claims only when every part has arrived) → SUCCEEDED. Else LND still owning any part →
//     HARD_TIMEOUT (the caller's probe decides). Else the first failed attempt's status and failure. No attempt at
//     all → rejected, with the first error.
'use strict';

const DEFAULT_MAX_PARTS = 4;
const DEFAULT_MIN_PART_MSAT = 1000000n;   // 1,000 sats: a part smaller than this is not worth an HTLC slot

function plan(chans, amountMsat, opts) {
  const o = opts || {};
  const maxParts = Number(o.maxParts) > 0 ? Number(o.maxParts) : DEFAULT_MAX_PARTS;
  const minPart = o.minPartMsat !== undefined ? BigInt(o.minPartMsat) : DEFAULT_MIN_PART_MSAT;
  const amt = BigInt(amountMsat);
  if (amt <= 0n) return null;
  const list = (chans || []).filter((c) => c && BigInt(c.room_msat || 0) >= minPart)
    .slice().sort((a, b) => (BigInt(b.room_msat) > BigInt(a.room_msat) ? 1 : (BigInt(b.room_msat) < BigInt(a.room_msat) ? -1 : 0)));
  const parts = [];
  let left = amt;
  for (const c of list) {
    if (left <= 0n) break;
    if (parts.length >= maxParts) return null;
    const room = BigInt(c.room_msat);
    const take = room < left ? room : left;
    parts.push({ chan: c, msat: take });
    left -= take;
  }
  if (left > 0n) return null;
  if (parts.length < 2) return parts.length === 1 ? parts : null;
  // the last part may have come out under the floor: move the difference over from the part before it
  const last = parts[parts.length - 1];
  if (last.msat < minPart) {
    const prev = parts[parts.length - 2];
    const need = minPart - last.msat;
    if (prev.msat - need < minPart) return null;
    prev.msat -= need; last.msat += need;
  }
  return parts;
}

function totalRoomMsat(chans) {
  let s = 0n;
  for (const c of (chans || [])) s += BigInt((c && c.room_msat) || 0);
  return s;
}

function hasPreimage(a) { return !!(a && a.status === 'SUCCEEDED' && a.preimage && a.preimage.length); }

function combine(results) {
  const attempts = [], errors = [];
  for (const r of (results || [])) {
    if (r && r.status === 'fulfilled' && r.value) attempts.push(r.value);
    else if (r && r.status === 'rejected') errors.push(String((r.reason && r.reason.message) || r.reason));
  }
  const paid = attempts.find(hasPreimage);
  if (paid) return { kind: 'attempt', attempt: { status: 'SUCCEEDED', preimage: paid.preimage, parts: attempts.length, parts_paid: attempts.filter(hasPreimage).length } };
  if (!attempts.length) return { kind: 'rejected', error: errors[0] || 'no attempt was made' };
  const owned = attempts.find((a) => a.status === 'HARD_TIMEOUT');
  if (owned) return { kind: 'attempt', attempt: { status: 'HARD_TIMEOUT', failure: owned.failure, preimage: Buffer.alloc(0), parts: attempts.length } };
  // LND still owning a part shows as a rejected call too ("payment in flight") — the caller's own test reads the text
  const inflight = errors.find((e) => /attempted value exceeds|DEADLINE_EXCEEDED|payment in flight|already/i.test(e));
  if (inflight) return { kind: 'rejected', error: inflight };
  const failed = attempts.find((a) => a.status !== 'SUCCEEDED') || attempts[0];
  return { kind: 'attempt', attempt: { status: failed.status || 'FAILED', failure: failed.failure, preimage: Buffer.alloc(0), parts: attempts.length } };
}

module.exports = { plan, combine, totalRoomMsat, DEFAULT_MAX_PARTS, DEFAULT_MIN_PART_MSAT };
