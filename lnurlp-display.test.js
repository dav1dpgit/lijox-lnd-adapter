// 0.119.1 (S65, DP 2026-10-28 "This bump is fine for Register" — engine v359's "lnurl-display"): a Register mode's shop
// name reaches every sender's screen through the pay terms' text/plain, filed by the name's owner under the node key's
// proof over "display:<name>:<sha256 hex of the text>". The functions are lifted from the source; the vector was
// computed in plain Python (sha256 of "Kura Coffee" and of the empty string). Run: node lnurlp-display.test.js
'use strict';
const fs = require('fs'); const crypto = require('crypto');
const src = fs.readFileSync(__dirname + '/lij-adapter.js', 'utf8');
let passed = 0, failed = 0; const t = (n, ok) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n); } };
const lift = (name, extra) => { const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')); if (!m) return null; return new Function('crypto', (extra || '') + m[0] + '; return ' + name + ';')(crypto); };
const clean = lift('lnurlpDisplayClean'); const clean40 = lift('lnurlpDisplayClean40', src.match(/function lnurlpDisplayClean\([^)]*\) \{[\s\S]*?\n\}/)[0]); const rid = lift('lnurlpDisplayRecordId'); const meta = lift('lnurlpMetadata');
t('the four functions are in the source', !!clean && !!clean40 && !!rid && !!meta);
t('the record rule — the Python vector', rid('Kura', 'Kura Coffee') === 'display:kura:281ff768640f3af3602e942b17c54eaa6aea88fba84fdba75f22a450d2b5c10a');
t('an empty text hashes the empty string (the clear)', rid('kura', '') === 'display:kura:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
t('the clean form: NFC, no controls / zero-width / bidi / BOM, trimmed, 40 code points', clean(' Kura​ Coffee\u0007 ') === 'Kura Coffee' && clean40('x'.repeat(50)).length === 40 && clean40('\u{1F37A}'.repeat(45)).length === 80 && clean('é') === 'é');
t('the pay terms carry the display name as text/plain when set, the provider line otherwise', JSON.parse(meta('kura', 'lightninginajar.xyz', 'Kura Coffee'))[0][1] === 'Kura Coffee' && JSON.parse(meta('kura', 'lightninginajar.xyz'))[0][1] === 'Pay kura — Lightning in a Jar' && JSON.parse(meta('kura', 'lightninginajar.xyz', '  '))[0][1] === 'Pay kura — Lightning in a Jar');
t('the identifier line is unchanged', JSON.parse(meta('kura', 'lightninginajar.xyz', 'Kura Coffee'))[1][1] === 'kura@lightninginajar.xyz');
// the route, in the source: the order of the checks and the record on the registry entry
const route = src.match(/if \(method === 'POST' && path === '\/lnurl\/display'\) \{[\s\S]*?return jsonResponse\(res, \{ ok: true, name: dspName, display: dspText \|\| null \}\);\n  \}/);
t('the route exists and refuses a text not in the clean form before the proof', !!route && route[0].indexOf("lnurlpDisplayClean40(dspText) !== dspText") < route[0].indexOf("lnurlpAuthCheck(dsp, 'lnurl-display'"));
t('the proof is over the record rule, checked before the registry entry is read', !!route && /lnurlpAuthCheck\(dsp, 'lnurl-display', dspPk, lnurlpDisplayRecordId\(dspName, dspText\)\)/.test(route[0]) && route[0].indexOf('lnurlpAuthCheck(') < route[0].indexOf('const dspRec = lnurlpRegistry[dspName];'));
t('another key\'s name is refused (403), a name not held here 404, and the record lives on the entry (persisted; dropped with the name)', !!route && /if \(!dspRec\) return jsonResponse\(res, \{ ok: false, error: 'not found' \}, 404\);/.test(route[0]) && /pubkey mismatch' \}, 403\)/.test(route[0]) && /if \(dspText\) dspRec\.display = dspText; else delete dspRec\.display;\n\s*lnurlpPersist\(\);/.test(route[0]));
t('both metadata sites pass the entry\'s display', src.split('lnurlpMetadata(name, lnurlpAddrHost(req, rec), rec.display)').length === 3);
console.log((failed ? 'FAIL' : 'PASS') + ' · lnurlp-display · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
