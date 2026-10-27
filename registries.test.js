// 0.118.0 (S63, Phase C — docs/design/routes/phase-c-r1.md §4.4; DP 21:41 "Go"): the plural registry list. The LIJOX
// registry has two doors (the box's direct door and the worker on Cloudflare), kept level by a mirror; this box enrolls
// at every registry it is given. A source test (the list is read at load; the posts run inside the boot); the live
// behaviour — both doors registered, the old one given the first door alone — is proved by build_01180.py's stand-in
// boot with two stand-in registries. The list parser is run here on its own, lifted from the source.
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/lij-adapter.js', 'utf8');
let passed = 0, failed = 0; const t = (n, ok) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n); } };
const slice = (start, end) => { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i); return j < 0 ? src.slice(i) : src.slice(i, j); };

// the list, read once at load
const def = slice('const REGISTRIES_FROM_ENV = (() => {', 'const CONFIG = {');
t('REGISTRIES_FROM_ENV reads LIJOX_REGISTRIES, else LIJOX_REGISTRY, before CONFIG', def.length > 0 && /process\.env\.LIJOX_REGISTRIES \|\| process\.env\.LIJOX_REGISTRY/.test(def));
const parse = (raw) => { const out = []; for (const s of String(raw).split(',')) { const u = s.trim().replace(/\/+$/, ''); if (u && !out.includes(u)) out.push(u); } return out; };
t('the parser in the source is the one tested here (trim, trailing slashes, repeats)', /const u = s\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\); if \(u && !out\.includes\(u\)\) out\.push\(u\);/.test(def));
t('a one-address LIJOX_REGISTRY is a one-entry list', JSON.stringify(parse('https://lij-worker.dp-a95.workers.dev')) === '["https://lij-worker.dp-a95.workers.dev"]');
t('two doors, a space, a trailing slash and a repeat are cleaned', JSON.stringify(parse('https://registry.lightninginajar.xyz/, https://lij-worker.dp-a95.workers.dev,https://registry.lightninginajar.xyz')) === '["https://registry.lightninginajar.xyz","https://lij-worker.dp-a95.workers.dev"]');
t('empty = registry-free (an empty list)', parse('').length === 0 && parse(' , ').length === 0);
t('CONFIG.registries is the list and CONFIG.registry its first (the one read)', /registries: REGISTRIES_FROM_ENV,/.test(src) && /registry: REGISTRIES_FROM_ENV\[0\] \|\| '',/.test(src));

// the registration: one signed record, every door; an old door the first door alone
const reg = slice('async function registerWithRegistry()', '// ── 0.73.0: console notes');
t('the record is signed once (body.signature) before the loop over the doors', /body\.signature = await signWith\(canonicalRegisterMsg\(body\)\);/.test(reg) && reg.indexOf('body.signature = await signWith(canonicalRegisterMsg(body))') < reg.indexOf('for (const reg of CONFIG.registries)'));
t('every door gets the same signed record', /for \(const reg of CONFIG\.registries\) \{\s*\n\s*let result = await httpsPost\(`\$\{reg\}\/lsps\/register`, body\)/.test(reg));
t('a door that does not know routes gets the first door alone, signed once more, and the v4 record is kept for the others', /if \(!v3\) \{ v3 = Object\.assign\(\{\}, body\); delete v3\.routes; delete v3\.signature; v3\.signature = await signWith\(canonicalRegisterMsg\(v3\)\); \}/.test(reg) && !/delete body\.routes/.test(reg));
t('each door\'s last answer is kept (registryStatus.doors) and the journal names the door', /registryStatus\.doors\[reg\] \|\| \(registryStatus\.doors\[reg\] = \{ last_ok: 0, last_error: '' \}\)/.test(reg) && /'\[Registry\] Registered at ' \+ reg \+ ':'/.test(reg));
t('last_ok is stamped when at least one door took the record; last_error lists the doors that did not', /if \(errors\.length < CONFIG\.registries\.length\) registryStatus\.last_ok = Date\.now\(\);/.test(reg) && /registryStatus\.last_error = errors\.join\(' · '\);/.test(reg));
t('a door that cannot be reached is an error for that door, never a throw that skips the rest', /httpsPost\(`\$\{reg\}\/lsps\/register`, body\)\.catch\(\(e\) => \(\{ ok: false, error: e\.message \}\)\)/.test(reg));
t('the tatara block still goes in before the record is signed (tatara-record r6 holds)', reg.indexOf('body.tatara = tb') < reg.indexOf('canonicalRegisterMsg(body)'));
t('the 6-hour timer and the registry-free refusal read the first entry as before', /if \(CONFIG\.registry && registryStatus\.every_h > 0\) \{/.test(src) && /if \(!CONFIG\.registry\) \{\s*\n\s*console\.log\('\[Registry\] no registry configured/.test(reg));

// the departure, the names, the provider list
const unreg = slice('async function unregisterFromRegistry()', 'async function registerWithRegistry()');
t('--unregister signs once and posts the departure to every door', /for \(const reg of CONFIG\.registries\) \{\s*\n\s*const result = await httpsPost\(`\$\{reg\}\/lsps\/unregister`/.test(unreg) && (unreg.match(/lndPost\('\/v1\/signmessage'/g) || []).length === 1);
const names = slice('async function lnurlpNameAt(kind, name, toPubkey) {', 'async function lnurlpNameSweep()');
t('a name op goes to every door: taken if any says so, ok if any took it, else unavailable', /for \(const reg of CONFIG\.registries\) \{\s*\n\s*const r = await httpsPost\(`\$\{reg\}\/names\/\$\{kind\}`, nbody\)\.catch\(\(\) => null\);\s*\n\s*if \(r && \/taken\/i\.test\(String\(r\.error \|\| ''\)\)\) return 'taken';\s*\n\s*if \(r && r\.ok\) anyOk = true;\s*\n\s*\}\s*\n\s*return anyOk \? 'ok' : 'unavailable';/.test(names));
t('the provider list is read from the first door that answers', /listProviders: async \(\) => \{ for \(const reg of CONFIG\.registries\) \{ const r = await httpsGetJson\(reg \+ '\/lsps'\); if \(r && r\.json && Array\.isArray\(r\.json\.lsps\)\) return r\.json\.lsps; \} return \[\]; \}/.test(src));

// the console
t('the Settings row names LIJOX_REGISTRIES and lists every door', /row\('Registry', 'registries', 'LIJOX_REGISTRIES', CONFIG\.registries\.join\(', '\) \|\| '\(none — registry-free\)'/.test(src));
t('the snapshot carries urls and doors beside url', /registry: \{ url: CONFIG\.registry \|\| '', urls: CONFIG\.registries, doors: registryStatus\.doors,/.test(src));
t('no other site posts to CONFIG.registry alone', !/\$\{CONFIG\.registry\}\//.test(src) && !/CONFIG\.registry \+ '\//.test(src));

console.log((failed ? 'FAIL' : 'PASS') + ' · registries · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
