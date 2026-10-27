// 0.115.0 (S63, Kimi round 2 F22 — DP "500 live entries per name"): the Lightning-address register adds hashes up to a
// per-name cap of LIVE free entries and says so; and F14 (DP "Yes"): GET /lsps2/pending needs `client`. The register
// loop runs inside the HTTP handler, so this reads the source (as decide.test.js does). Run: node lnurlp-cap.test.js
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/lij-adapter.js', 'utf8');
let passed = 0, failed = 0; const t = (n, ok) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n); } };
t('the cap is a box setting, 500 by default', /const LNURLP_MAX_LIVE_PER_NAME = parseInt\(process\.env\.LNURLP_MAX_LIVE_PER_NAME \|\| '500', 10\) \|\| 500;/.test(src));
const loop = src.match(/let added = 0, capped = false;\n\s*let liveNow = lnurlpLiveFree\(rec\)\.length;[\s\S]*?rec\.entries\.push\(entry\);/);
t('the register loop counts the LIVE free entries and breaks at the cap BEFORE the push', !!loop && /if \(liveNow \+ added >= LNURLP_MAX_LIVE_PER_NAME\) \{ capped = true; break; \}/.test(loop[0]) && loop[0].indexOf('capped = true; break;') < loop[0].indexOf('rec.entries.push(entry)'));
t('the dedup (seen) still runs before the cap check — a repeat never counts against it', !!loop && loop[0].indexOf('if (seen.has(hh)) continue;') < loop[0].indexOf('capped = true; break;'));
t('the answer says capped and names the cap', /if \(capped\) \{ ans\.capped = true; ans\.cap = LNURLP_MAX_LIVE_PER_NAME; \}/.test(src) && /return jsonResponse\(res, ans\);/.test(src));
t('the log line says AT THE CAP', /AT THE CAP ' \+ LNURLP_MAX_LIVE_PER_NAME/.test(src));
// F14
const pend = src.match(/if \(path === '\/lsps2\/pending' && method === 'GET'\) \{[\s\S]*?const byHash = \{\};/);
t('GET /lsps2/pending without client answers 400 before any listing', !!pend && /if \(!clientQ\) return jsonResponse\(res, \{ ok: false, error: 'client required[^\n]*?' \}, 400\);/.test(pend[0]));
console.log((failed ? 'FAIL' : 'PASS') + ' · lnurlp-cap · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
