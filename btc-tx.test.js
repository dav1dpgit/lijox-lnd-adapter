'use strict';
// btc-tx.test.js — 0.120.0: the transaction library against BIP-143's published vectors and fixed vectors of our own.
//   node btc-tx.test.js
const crypto = require('crypto');
const T = require('./btc-tx');
let n = 0, bad = 0;
const check = (c, m) => { n++; if (c) console.log('  ok · ' + m); else { bad++; console.log('  FAIL · ' + m); } };
const eq = (a, b, m) => check(a === b, m + (a === b ? '' : ' — got ' + a + ', want ' + b));

// ── BIP-143, "Native P2WPKH": the second input's signature hash and the deterministic signature ──
{
  const unsigned = '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000';
  const tx = T.parse(unsigned);
  eq(T.serialize(tx, false).toString('hex'), unsigned, 'BIP-143 P2WPKH: parse → serialize is the identity');
  eq(tx.version, 1, 'version 1'); eq(tx.locktime, 0x11, 'lock time 17'); eq(tx.inputs.length, 2, 'two inputs'); eq(tx.inputs[0].sequence, 0xffffffee, 'input 0 sequence');
  const scriptCode = Buffer.from('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac', 'hex');
  const h = T.sighashBip143(tx, 1, scriptCode, 600000000, T.SIGHASH_ALL);
  eq(h.toString('hex'), 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670', 'BIP-143 P2WPKH: the signature hash');
  const priv = Buffer.from('619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9', 'hex');
  const sig = T.signDer(h, priv);
  eq(sig.toString('hex'), '304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01', 'BIP-143 P2WPKH: RFC 6979 gives the published signature, byte for byte');
  check(T.verifyDer(h, sig, T.pubkeyOf(priv)), 'the signature verifies against the key');
  check(!T.verifyDer(Buffer.alloc(32, 1), sig, T.pubkeyOf(priv)), 'a different hash does not');
}
// ── BIP-143, "P2SH-P2WSH": the unsigned transaction reads and writes back to the same bytes ──
{
  const unsigned = '010000000136641869ca081e70f394c6948e8af409e18b619df2ed74aa106c1ca29787b96e0100000000ffffffff0200e9a435000000001976a914389ffce9cd9ae88dcc0631e88a821ffdbe9bfe2688acc0832f05000000001976a9147480a33f950689af511e6e84c138dbbd3c3ee41588ac00000000';
  const tx = T.parse(unsigned);
  eq(T.serialize(tx, false).toString('hex'), unsigned, 'BIP-143 P2SH-P2WSH: parse → serialize is the identity');
  eq(tx.inputs[0].txid, '6eb98797a21c6c10aa74edf29d618be109f48a8e94c694f3701e08ca69186436', 'the input txid reads in display order');
  eq(tx.outputs[0].value, 900000000, 'the first output: 9 BTC'); eq(tx.outputs[1].value, 87000000, 'the second: 0.87 BTC');
}
// ── script numbers and pushes ──
{
  eq(T.scriptNum(975123).toString('hex'), '0313e10e', 'script number 975,123 → 03 13 e1 0e');
  eq(T.scriptNum(128).toString('hex'), '028000', '128 needs a sign byte');
  eq(T.scriptNum(16).toString('hex'), '60', '16 is OP_16');
  eq(T.scriptNum(17).toString('hex'), '0111', '17 is a one-byte push');
  eq(T.scriptNum(32).toString('hex'), '0120', '32 (the secret\'s size) is a one-byte push');
  eq(T.varint(0xfc).toString('hex'), 'fc', 'varint 252'); eq(T.varint(0xfd).toString('hex'), 'fdfd00', 'varint 253'); eq(T.varint(70000).toString('hex'), 'fe70110100', 'varint 70,000');
}
// ── the hand-over script and its address ──
{
  const H = '11'.repeat(32), W = '02' + 'aa'.repeat(32), L = '03' + 'bb'.repeat(32), Tb = 975123;
  const s = T.handoverScript(H, W, L, Tb);
  const want = '82' + '0120' + '87' + '63' + 'a8' + '20' + H + '88' + '21' + W + '67' + '75' + '0313e10e' + 'b1' + '75' + '21' + L + '68' + 'ac';
  eq(s.toString('hex'), want, 'the hand-over script, opcode by opcode (v0.6 §6)');
  eq(s.length, 1 + 2 + 1 + 1 + 1 + 33 + 1 + 34 + 1 + 1 + 4 + 1 + 1 + 34 + 1 + 1, 'its length');
  const spk = T.p2wshScriptPubKey(s);
  eq(spk.toString('hex'), '0020' + T.sha256(s).toString('hex'), 'P2WSH: OP_0 <sha256(script)>');
  const addr = T.p2wshAddress(s);
  check(/^bc1q[a-z0-9]{58}$/.test(addr), 'a bc1q… P2WSH address: ' + addr);
  eq(T.addressToScript(addr).toString('hex'), spk.toString('hex'), 'the address decodes back to the same script');
  let threw = false; try { T.handoverScript('11'.repeat(31), W, L, Tb); } catch (e) { threw = true; } check(threw, 'a 31-byte hash is refused');
  threw = false; try { T.handoverScript(H, W, L, 0); } catch (e) { threw = true; } check(threw, 'T = 0 is refused');
}
// ── bech32 / bech32m against BIP-173 / BIP-350 ──
{
  eq(T.bech32Encode('bc', 0, Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6', 'hex')), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BIP-173 P2WPKH example');
  eq(T.bech32Encode('bc', 0, Buffer.from('1863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262', 'hex')), 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 'BIP-173 P2WSH example');
  eq(T.bech32Encode('bc', 1, Buffer.from('751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6', 'hex')), 'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 'BIP-350 bech32m example (a 40-byte program)');
  eq(T.bech32Encode('bc', 1, Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex')), 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'a P2TR address of the generator\'s x coordinate');
  const d = T.bech32Decode('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4');
  check(d && d.version === 0 && d.program.toString('hex') === '751e76e8199196d454941c45d1b3a323f1433bd6', 'decode, upper case accepted');
  check(T.bech32Decode('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5') === null, 'a bad checksum is refused');
  check(T.bech32Decode('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8F3t4') === null, 'mixed case is refused');
  eq(T.addressToScript('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0').toString('hex').slice(0, 4), '5120', 'a taproot address → OP_1 <32 bytes>');
  let threw = false; try { T.addressToScript('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'); } catch (e) { threw = true; } check(threw, 'a testnet address is refused on mainnet');
}
// ── THE TAKE-BACK, built and checked by hand ──
{
  const priv = crypto.createHash('sha256').update('lij take-back test key').digest();
  const L = T.pubkeyOf(priv).toString('hex');
  const H = T.sha256(Buffer.alloc(32, 7)).toString('hex'); const W = '02' + 'cc'.repeat(32); const Tb = 975123;
  const script = T.handoverScript(H, W, L, Tb);
  const dest = T.addressToScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  const lockTxid = 'ab'.repeat(32), lockValue = 101700;
  for (const rate of [1, 5, 40]) {
    const r = T.buildTakeBack({ lockTxid, lockVout: 1, lockValue, script, T: Tb, destScript: dest, feeRateSatVb: rate, privkey: priv });
    const tx = r.tx;
    eq(tx.locktime, Tb, rate + ' sat/vB: lock time T');
    eq(tx.inputs[0].sequence, 0xfffffffd, 'the input\'s sequence below final (lock time in force) and replaceable (BIP-125)');
    eq(tx.inputs[0].txid + ':' + tx.inputs[0].vout, lockTxid + ':1', 'spends the lock\'s output');
    eq(tx.outputs.length, 1, 'one output'); eq(tx.outputs[0].script.toString('hex'), dest.toString('hex'), 'to the float\'s address');
    eq(tx.outputs[0].value + r.fee, lockValue, 'value in = value out + fee');
    check(r.fee >= r.vsize * rate && r.fee <= r.vsize * rate + rate, 'the fee is the rate × ' + r.vsize + ' vB (' + r.fee + ' sats)');
    const w = tx.inputs[0].witness;
    check(w.length === 3 && w[1].length === 0 && w[2].equals(script), 'witness [sig, empty, script]');
    const h = T.sighashBip143(tx, 0, script, lockValue, T.SIGHASH_ALL);
    check(T.verifyDer(h, w[0], Buffer.from(L, 'hex')), 'the signature is L\'s over the BIP-143 hash of the hand-over script');
    eq(w[0][w[0].length - 1], 0x01, 'SIGHASH_ALL');
    const again = T.buildTakeBack({ lockTxid, lockVout: 1, lockValue, script, T: Tb, destScript: dest, feeRateSatVb: rate, privkey: priv });
    eq(again.hex, r.hex, 'the same bytes every time (RFC 6979)');
    const back = T.parse(r.hex);
    eq(T.serialize(back, true).toString('hex'), r.hex, 'parse → serialize of the signed take-back is the identity');
    eq(T.txid(back), r.txid, 'the txid from the parsed form matches');
    check(T.weight(tx) === T.serialize(tx, false).length * 3 + T.serialize(tx, true).length, 'weight = 3 × base + total');
  }
  let threw = false; try { T.buildTakeBack({ lockTxid, lockVout: 1, lockValue: 700, script, T: Tb, destScript: dest, feeRateSatVb: 5, privkey: priv }); } catch (e) { threw = String(e.message); }
  check(/less than dust/.test(threw), 'a take-back that would leave dust is refused: ' + threw);
}
// ── a release (the wallet's branch), parsed and read as the adapter will read a handed-over one ──
{
  const H = T.sha256(Buffer.alloc(32, 9)).toString('hex'); const W = '02' + 'dd'.repeat(32); const L = '03' + 'ee'.repeat(32);
  const script = T.handoverScript(H, W, L, 975123);
  const rel = { version: 2, locktime: 0, inputs: [{ txid: 'cd'.repeat(32), vout: 0, sequence: 0xfffffffd, witness: [Buffer.alloc(71, 0x30), Buffer.alloc(32, 9), script] }], outputs: [{ value: 100000, script: T.addressToScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4') }, { value: 850, script: T.addressToScript('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3') }] };
  const p = T.parse(T.serialize(rel, true).toString('hex'));
  eq(p.inputs[0].txid, 'cd'.repeat(32), 'the release spends the lock');
  eq(p.inputs[0].witness[1].toString('hex'), '09'.repeat(32), 'the secret is the second witness item');
  eq(T.sha256(p.inputs[0].witness[1]).toString('hex'), H, 'and it hashes to H');
  check(p.inputs[0].witness[2].equals(script), 'the third item is the hand-over script');
  eq(p.outputs.length, 2, 'two outputs: the recipient and the reserve back');
}
console.log((bad ? 'FAIL' : 'PASS') + ' · btc-tx.test.js · ' + (n - bad) + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
