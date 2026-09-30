// 0.86.0 (S50, NWC) — schnorr.js against BIP-340's test-vectors.csv (docs/bip340-test-vectors.csv, verbatim
// from bitcoin/bips): every signing row must reproduce the signature byte for byte; every verification
// row must answer exactly TRUE/FALSE as the BIP says.
//   node schnorr.test.js
const fs = require('fs'); const path = require('path');
const S = require(path.join(__dirname, 'schnorr.js'));
let pass = 0, fail = 0; const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };

const rows = fs.readFileSync(path.join(__dirname, 'docs', 'bip340-test-vectors.csv'), 'utf8').trim().split('\n').slice(1);
t('19 vector rows', rows.length === 19, String(rows.length));
for (const line of rows) {
  const [index, sk, pk, aux, msg, sig, result, ...comment] = line.split(',');
  const want = result.trim() === 'TRUE';
  if (sk) {
    let got = null; try { got = S.sign(sk, msg, aux).toString('hex').toUpperCase(); } catch (e) { got = 'ERR ' + e.message; }
    t(`row ${index}: sign reproduces the vector`, got === sig.toUpperCase(), got);
    t(`row ${index}: pubkey matches`, S.pubkey(sk).toString('hex').toUpperCase() === pk.toUpperCase());
  }
  const v = S.verify(sig, msg, pk);
  t(`row ${index}: verify → ${want} ${comment.join(',').slice(0, 60)}`, v === want, String(v));
}
// a tampered message fails; wrong lengths fail without throwing
const r0 = rows[0].split(',');
t('a flipped message bit fails', S.verify(r0[5], '01' + r0[4].slice(2), r0[2]) === false);
t('short inputs answer false, not throw', S.verify('00', '00', '00') === false);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
