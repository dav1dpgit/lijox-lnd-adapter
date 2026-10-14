// 0.101.0 (S58 — LIJOX's Tatara step 5a, door 1): THE TAGGED RING SIGNATURE'S VERIFIER (tatara-ring.js) against joinstr
// v2's own ring.rs: tatara-ring.vectors.json (7 rings of 1–40 keys, three tags incl. the empty one, made by ring.rs S58)
// and P10's known answers (lij_tests p10_known_answers). Then every way a signature can be wrong, and the ISO week.
//   node tatara-ring.test.js
'use strict';
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { makeRing, verify, isoWeek, seatTag, N } = require('./tatara-ring');
let fails = 0;
const check = (c, m) => { console.log((c ? '  ok · ' : 'FAIL · ') + m); if (!c) fails++; };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'tatara-ring.vectors.json'), 'utf8'));
const sigOf = (v) => ({ key_image: v.key_image, c0: v.c0, s: v.s.slice() });

// G1 — every vector verifies; the key image and every Hp_t are ring.rs's
let allOk = true, hpsOk = true;
const t0 = Date.now();
for (const v of V) {
  const ring = makeRing(v.ring, v.tag);
  try { if (verify(ring, Buffer.from(v.m, 'hex'), sigOf(v)) !== v.key_image) allOk = false; } catch (e) { allOk = false; console.log('   ' + e.message); }
  if (ring.hps.map((h) => h.toString('hex')).join() !== v.hps.join()) hpsOk = false;
}
const ms = Date.now() - t0;
check(allOk, 'G1 ring.rs\'s ' + V.length + ' signatures (rings of ' + V.map((v) => v.ring.length).join(', ') + ' keys) verify, each to ring.rs\'s key image');
check(hpsOk, 'G1 Hp_t of every one of the ' + V.reduce((a, v) => a + v.ring.length, 0) + ' keys equals ring.rs\'s hash_to_point_tagged');
// G2 — P10's known answers (ring.rs p10_known_answers): the ring, Hp_t(ring[0]), the image, c0, s
const KAT = [["02032211446d417461b08f64b89e98896948e64cca9f0fd4865130ce446d712047","0371d255e3be5e8f95aacb7502bd489d3daa52983a8b1ac67460cd502e02190d0f","03cf270318ba395c546401776e336d0345c68898cd1650d4645a64bf35ca9c6006"],"028fb52c6044f06312dbd3d226f55cf005abd3ba772501b8ca137652a8f88888be","02ccb6b11b832f59132e2896e3b355645d3a2c3a20c5a7feac645748f0e0a03647","d0f7859d4db5ce3f4a6e30c82af9200daa3d84b4f554762ec7c62fe56f0975c4",["fd7517a510990f3a844836c6e760664e20b0618291654a950b39426b0c703baf","d33e44d296f2b466669eb4764bffd2bdcdc9a28441511ccaf5572d9a2d28a0a1","85dde66fc8dbb4c54eb03883d2e378d14bd42c11adfb7558f2076be53a773c6f"]];
const kring = makeRing(KAT[0], 'lij/tatara/seat/v1/2026-W41');
check(kring.hps[0].toString('hex') === KAT[1] && verify(kring, Buffer.alloc(32, 0x42), { key_image: KAT[2], c0: KAT[3], s: KAT[4] }) === KAT[2], 'G2 P10\'s known answers: Hp_t(ring[0]) and the signature over [0x42; 32] under 2026-W41 verify to its image');
// G3 — another tag, another message, another ring: refused
const v3 = V[3], r3 = makeRing(v3.ring, v3.tag), m3 = Buffer.from(v3.m, 'hex');   // a 5-key ring under 2026-W41
check(throws(() => verify(makeRing(v3.ring, 'lij/tatara/seat/v1/2026-W43'), m3, sigOf(v3)), /does not verify/), 'G3 the same signature under another week\'s tag: refused');
check(throws(() => verify(makeRing(v3.ring, ''), m3, sigOf(v3))), 'G3 … under no tag (joinstr\'s untagged): refused');
const m3b = Buffer.from(m3); m3b[0] ^= 1;
check(throws(() => verify(r3, m3b, sigOf(v3)), /does not verify/), 'G3 another message: refused');
const other = V[4];
check(throws(() => verify(makeRing(other.ring.slice(0, 5), v3.tag), m3, sigOf(v3))), 'G3 another ring of the same size: refused');
check(V[2].tag === '' && verify(makeRing(V[2].ring, ''), Buffer.from(V[2].m, 'hex'), sigOf(V[2])) === V[2].key_image && throws(() => verify(makeRing(V[2].ring, 'lij/tatara/seat/v1/2026-W41'), Buffer.from(V[2].m, 'hex'), sigOf(V[2]))), 'G3 a signature under the empty tag verifies only under the empty tag');
// G4 — tampered signatures
const v5 = V[3], r5 = makeRing(v5.ring, v5.tag), m5 = Buffer.from(v5.m, 'hex');
let tamperOk = true;
for (let i = 0; i < v5.s.length; i++) { const s = sigOf(v5); s.s[i] = (BigInt('0x' + s.s[i]) + 1n).toString(16).padStart(64, '0'); if (!throws(() => verify(r5, m5, s))) tamperOk = false; }
const c = sigOf(v5); c.c0 = (BigInt('0x' + c.c0) ^ 1n).toString(16).padStart(64, '0');
if (!throws(() => verify(r5, m5, c))) tamperOk = false;
check(tamperOk, 'G4 each s_i changed by one, and c0 changed by one bit: every one refused');
const img = sigOf(v5); img.key_image = V[5].key_image;
check(throws(() => verify(r5, m5, img), /does not verify/), 'G4 another signer\'s key image: refused (the image is bound into every challenge)');
const order = N.toString(16);
const big = sigOf(v5); big.s[0] = order;
check(throws(() => verify(r5, m5, big), /group order/), 'G4 a scalar equal to the group order: refused (P8)');
const up = sigOf(v5); up.c0 = up.c0.toUpperCase();
check(throws(() => verify(r5, m5, up), /lowercase hex/), 'G4 upper-case hex: refused (P8)');
const short = sigOf(v5); short.s.pop();
check(throws(() => verify(r5, m5, short), /size mismatch/), 'G4 one response short: refused');
check(throws(() => verify(r5, m5, Object.assign(sigOf(v5), { extra: 1 })), /unknown/), 'G4 an unknown field: refused (P8: deny unknown fields)');
const off = sigOf(v5); off.key_image = '02' + 'ff'.repeat(32);
check(throws(() => verify(r5, m5, off), /point/), 'G4 an image not on the curve: refused');
const unc = sigOf(v5); unc.key_image = '04' + v5.key_image.slice(2);
check(throws(() => verify(r5, m5, unc), /point/), 'G4 an image not compressed: refused');
const zero = sigOf(v5); zero.c0 = '00'.repeat(32); zero.s = zero.s.map(() => '00'.repeat(32));
check(throws(() => verify(r5, m5, zero), /infinity|does not verify/), 'G4 all-zero scalars: refused (a point at infinity — never a crash)');
// G5 — the ring's shape (P7)
check(throws(() => makeRing([], 't'), /empty/) && throws(() => makeRing(v5.ring.slice().reverse(), 't'), /sorted/) && throws(() => makeRing([v5.ring[0], v5.ring[0]], 't'), /sorted/) && throws(() => makeRing([v5.ring[0].toUpperCase()], 't')), 'G5 an empty, unsorted, repeated or upper-case ring: refused');
check(makeRing(v5.ring, v5.tag).hash === makeRing(v5.ring, v5.tag).hash && makeRing(v5.ring, v5.tag).hash !== makeRing(v5.ring, 'lij/tatara/seat/v1/2026-W43').hash, 'G5 the ring hash is bound to its week');
// G6 — random garbage never throws anything but an Error
let crash = 0;
for (let i = 0; i < 300; i++) {
  const s = sigOf(v5);
  const k = i % 3;
  if (k === 0) s.key_image = crypto.randomBytes(33).toString('hex');
  if (k === 1) s.c0 = crypto.randomBytes(32).toString('hex');
  if (k === 2) s.s[i % s.s.length] = crypto.randomBytes(32).toString('hex');
  try { verify(r5, m5, s); crash++; } catch (e) { if (!(e instanceof Error)) crash++; }
}
check(crash === 0, 'G6 300 random signatures: every one refused with an error, none accepted');
// G7 — the ISO week (against Python's isocalendar: 40 random moments 2020–2033 and the year-end edges)
const W = [[1751693191000, "2025-W27"], [1658823334000, "2022-W30"], [1789806049000, "2026-W38"], [1927304586000, "2031-W05"], [1603760378000, "2020-W44"], [1616725734000, "2021-W12"], [2018755076000, "2033-W51"], [1865536261000, "2029-W06"], [1628372482000, "2021-W31"], [1774164543000, "2026-W12"], [1890718731000, "2029-W48"], [1608974734000, "2020-W52"], [1850264286000, "2028-W33"], [1693102009000, "2023-W34"], [1597967131000, "2020-W34"], [1623979371000, "2021-W24"], [1810648555000, "2027-W20"], [1802341267000, "2027-W06"], [1615340145000, "2021-W10"], [1707041764000, "2024-W05"], [1626537979000, "2021-W28"], [1873678041000, "2029-W20"], [1805748804000, "2027-W12"], [1609571510000, "2020-W53"], [1881412441000, "2029-W33"], [1644302468000, "2022-W06"], [1697687307000, "2023-W42"], [1916401511000, "2030-W39"], [1914687446000, "2030-W36"], [1890830878000, "2029-W48"], [1611048734000, "2021-W03"], [1887666585000, "2029-W43"], [1892196958000, "2029-W51"], [1790803010000, "2026-W40"], [1604459859000, "2020-W45"], [1696529202000, "2023-W40"], [1602845686000, "2020-W42"], [1876693991000, "2029-W25"], [1649334485000, "2022-W14"], [1733319602000, "2024-W49"], [1791763200000, "2026-W42"], [1791763199000, "2026-W41"], [1767225600000, "2026-W01"], [1766966400000, "2026-W01"], [1609416000000, "2020-W53"], [1609718399000, "2020-W53"], [1609718400000, "2021-W01"], [1798761600000, "2026-W53"], [1798761599000, "2026-W53"]];
const bad = W.filter(([ms, label]) => isoWeek(ms).label !== label);
check(bad.length === 0, 'G7 the ISO week of ' + W.length + ' moments matches Python\'s isocalendar (incl. 2020-W53, 2026-W53 on 2027-01-01)' + (bad.length ? ' — ' + JSON.stringify(bad.slice(0, 3)) : ''));
check(seatTag(Date.UTC(2026, 9, 12)) === 'lij/tatara/seat/v1/2026-W42' && seatTag(Date.UTC(2026, 9, 11, 23, 59, 59)) === 'lij/tatara/seat/v1/2026-W41', 'G7 the seat tag changes at Monday 00:00 UTC (2026-W41 → 2026-W42)');
// G8 — review S58 (#5, #6): a time that is not milliseconds, and a field list that only looks right
check(throws(() => isoWeek(NaN), /milliseconds/) && throws(() => isoWeek(1791763200), /milliseconds/) && throws(() => seatTag(undefined), /milliseconds/), 'G8 isoWeek refuses NaN, undefined and seconds (never "NaN-WNaN", never 1970)');
check(throws(() => verify(r5, m5, { 'c0,key_image': 1, s: [], x: 2 }), /unknown/) && throws(() => verify(r5, m5, Object.create({ c0: '00', key_image: '02', s: [] })), /unknown/), 'G8 a field list that only joins to the right names, or fields that are not its own: refused');
console.log('  · ' + V.length + ' verifications (' + V.reduce((a, v) => a + v.ring.length, 0) + ' ring members) in ' + ms + ' ms');
console.log(fails ? 'FAIL · tatara-ring · ' + fails + ' failed' : 'PASS · tatara-ring (G1–G8)');
process.exit(fails ? 1 : 0);
